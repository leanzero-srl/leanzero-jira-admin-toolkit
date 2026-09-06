const https = require("https");
const { URL } = require("url");

/**
 * Minimal Jira Cloud REST client (Basic auth, native https) for the target site.
 *
 * Mirrors the retry/backoff behaviour of clone_workflow_rules/src/jiraCloudClient.js
 * (429 with Retry-After, 5xx exponential backoff, connection/timeout retry) but
 * exposes raw responses: request() RESOLVES `{ status, headers, data }` for every
 * completed HTTP response — including 4xx — and only rejects on exhausted retries
 * or hard network errors. This is intentional: POST /customer returns 409 when the
 * email already exists, which callers must treat as success, not an exception.
 */
class JiraClient {
  constructor(baseUrl, apiToken) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.hostname = new URL(this.baseUrl).hostname;
    this.apiToken = apiToken; // already base64(email:token)
    this.requestCount = 0;
    this.rateLimitCount = 0;
  }

  request(method, path, body = null, retryState = null) {
    const state = retryState || { rateLimitAttempts: 0, serverErrorAttempts: 0 };
    const maxRateLimitRetries = 5;
    const maxServerRetries = 4;

    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.hostname,
        port: 443,
        path,
        method,
        headers: {
          Authorization: `Basic ${this.apiToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        timeout: 30000,
      };

      const bodyStr = body ? JSON.stringify(body) : null;
      if (bodyStr) options.headers["Content-Length"] = Buffer.byteLength(bodyStr);

      const retry = (newState) =>
        this.request(method, path, body, newState).then(resolve).catch(reject);

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          this.requestCount++;

          // 429 — rate limited: honour Retry-After, exponential fallback.
          if (res.statusCode === 429) {
            this.rateLimitCount++;
            if (state.rateLimitAttempts >= maxRateLimitRetries) {
              const e = new Error(`Rate limited after ${maxRateLimitRetries} retries: ${method} ${path}`);
              e.statusCode = 429;
              return reject(e);
            }
            const retryAfter = res.headers["retry-after"];
            const delay = retryAfter
              ? parseInt(retryAfter, 10) * 1000
              : Math.min(5000 * 2 ** state.rateLimitAttempts, 60000);
            console.log(`  [rate-limit] 429, waiting ${delay / 1000}s (attempt ${state.rateLimitAttempts + 1}/${maxRateLimitRetries})`);
            return setTimeout(() => retry({ ...state, rateLimitAttempts: state.rateLimitAttempts + 1 }), delay);
          }

          // 5xx — transient server error: exponential backoff.
          if (res.statusCode >= 500 && res.statusCode < 600 && state.serverErrorAttempts < maxServerRetries) {
            const delay = Math.min(1000 * 2 ** state.serverErrorAttempts, 15000);
            console.log(`  [server] ${res.statusCode}, retrying in ${delay / 1000}s (attempt ${state.serverErrorAttempts + 1}/${maxServerRetries})`);
            return setTimeout(() => retry({ ...state, serverErrorAttempts: state.serverErrorAttempts + 1 }), delay);
          }

          // Everything else (2xx/3xx/4xx) — resolve with parsed body. No throw.
          let parsed = null;
          if (data) {
            try {
              parsed = JSON.parse(data);
            } catch {
              parsed = data;
            }
          }
          resolve({ status: res.statusCode, headers: res.headers, data: parsed });
        });
      });

      req.on("error", (err) => {
        if (state.serverErrorAttempts < maxServerRetries) {
          const delay = 2000 * (state.serverErrorAttempts + 1);
          console.log(`  [conn] ${err.message}, retrying in ${delay / 1000}s`);
          return setTimeout(() => retry({ ...state, serverErrorAttempts: state.serverErrorAttempts + 1 }), delay);
        }
        reject(err);
      });

      req.on("timeout", () => {
        req.destroy();
        if (state.serverErrorAttempts < maxServerRetries) {
          const delay = 2000 * (state.serverErrorAttempts + 1);
          console.log(`  [timeout] retrying in ${delay / 1000}s`);
          return setTimeout(() => retry({ ...state, serverErrorAttempts: state.serverErrorAttempts + 1 }), delay);
        }
        reject(new Error(`Request timeout: ${method} ${path}`));
      });

      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  /** Sanity check that auth works and reports the calling user. */
  async whoami() {
    const res = await this.request("GET", "/rest/api/3/myself");
    return res;
  }

  /**
   * Page through every member of a group by groupId.
   * GET /rest/api/3/group/member — maxResults capped at 50 by the API.
   * Returns the full array of member objects (accountId, accountType,
   * displayName, active, emailAddress[, ...]).
   */
  async getGroupMembers(groupId, { includeInactive = true, onPage = null } = {}) {
    const members = [];
    let startAt = 0;
    const maxResults = 50;
    while (true) {
      const params = new URLSearchParams({
        groupId,
        startAt: String(startAt),
        maxResults: String(maxResults),
        includeInactiveUsers: String(includeInactive),
      });
      const res = await this.request("GET", `/rest/api/3/group/member?${params}`);
      if (res.status >= 400) {
        throw new Error(`group/member returned ${res.status}: ${JSON.stringify(res.data).slice(0, 400)}`);
      }
      const values = (res.data && res.data.values) || [];
      members.push(...values);
      if (onPage) onPage(members.length, res.data && res.data.total);
      const isLast = res.data && res.data.isLast;
      if (isLast || values.length === 0) break;
      startAt += values.length;
      if (startAt > 200000) break; // hard safety stop
    }
    return members;
  }

  /**
   * POST /rest/servicedeskapi/servicedesk/{serviceDeskId}/customer — add existing
   * accounts to a service desk's customer list (the project Customers page).
   * Body: { accountIds: [...] }. No email/invite is sent. Success = 204.
   * Returns the raw { status, data }.
   */
  async addCustomersToServiceDesk(serviceDeskId, accountIds) {
    return this.request(
      "POST",
      `/rest/servicedeskapi/servicedesk/${encodeURIComponent(serviceDeskId)}/customer`,
      { accountIds },
    );
  }

  /**
   * POST /rest/servicedeskapi/customer — create a JSM customer.
   * strictConflictStatusCode=true makes an existing-email collision return a
   * clean 409 (rather than a 400) so the caller can classify it as "exists".
   * Returns the raw { status, data } — caller classifies 201 vs 409 vs error.
   */
  async createCustomer(email, displayName) {
    const body = { email };
    if (displayName) body.displayName = displayName;
    return this.request(
      "POST",
      "/rest/servicedeskapi/customer?strictConflictStatusCode=true",
      body,
    );
  }
}

module.exports = JiraClient;
