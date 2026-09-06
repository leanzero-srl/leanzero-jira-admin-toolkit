const https = require("https");

/**
 * Client for the Atlassian Teams Public REST API (v1) + a couple of Jira Cloud
 * user-lookup endpoints on the site.
 *
 * Teams API base host: api.atlassian.com
 *   GET    /public/teams/v1/org/{orgId}/teams?size=&cursor=        — list teams (paginated)
 *   POST   /public/teams/v1/org/{orgId}/teams/{teamId}/members     — fetch members (paginated)
 *   DELETE /public/teams/v1/org/{orgId}/teams/{teamId}             — delete a team (204)
 *
 * Auth: Basic, base64("<email>:<apiToken>"). Per Atlassian docs, "Forge and
 * OAuth2 apps cannot access this REST resource" — a plain user API token is the
 * supported credential, and the user must be able to manage teams in the org.
 *
 * Site (Jira Cloud) endpoints, used only to put human-readable names against the
 * accountIds the Teams API returns:
 *   GET /rest/api/3/user/search?query=   — resolve target display name -> accountIds
 *   GET /rest/api/3/user?accountId=       — resolve a single member -> name/email
 */
class TeamsClient {
  constructor({ email, apiToken, orgId, siteBaseUrl, log }) {
    if (!email) throw new Error("TeamsClient: email is required");
    if (!apiToken) throw new Error("TeamsClient: apiToken is required");
    if (!orgId) throw new Error("TeamsClient: orgId is required");

    this.orgId = orgId;
    this.siteBaseUrl = (siteBaseUrl || "").replace(/\/+$/, "");
    this.teamsHost = "api.atlassian.com";
    this.authHeader =
      "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
    this.log = log || console.log;

    this.requestCount = 0;
    this.errorCount = 0;
    this.rateLimitCount = 0;
  }

  _request(method, urlOrPath, body = null, retryState = null) {
    const state = retryState || { rateLimitAttempts: 0, serverErrorAttempts: 0 };
    const maxRateLimitRetries = 4;
    const maxServerRetries = 4;

    let hostname = this.teamsHost;
    let path = urlOrPath;
    if (/^https?:\/\//i.test(urlOrPath)) {
      const u = new URL(urlOrPath);
      hostname = u.hostname;
      path = `${u.pathname}${u.search || ""}`;
    }

    return new Promise((resolve, reject) => {
      const options = {
        hostname,
        port: 443,
        path,
        method,
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        timeout: 30000,
      };

      let bodyStr = null;
      if (body) {
        bodyStr = JSON.stringify(body);
        options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
      }

      const retry = (newState) =>
        this._request(method, urlOrPath, body, newState).then(resolve).catch(reject);

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          this.requestCount++;

          if (res.statusCode === 429) {
            this.rateLimitCount++;
            if (state.rateLimitAttempts >= maxRateLimitRetries) {
              const e = new Error(
                `Teams API rate limit after ${maxRateLimitRetries} attempts: ${method} ${path}`,
              );
              e.statusCode = 429;
              return reject(e);
            }
            const retryAfter = res.headers["retry-after"];
            const delay = retryAfter
              ? parseInt(retryAfter, 10) * 1000
              : Math.min(5000 * Math.pow(2, state.rateLimitAttempts), 60000);
            this.log(
              `  [api] Rate limited (429), waiting ${delay / 1000}s (attempt ${state.rateLimitAttempts + 1}/${maxRateLimitRetries})`,
            );
            return setTimeout(
              () => retry({ ...state, rateLimitAttempts: state.rateLimitAttempts + 1 }),
              delay,
            );
          }

          if (
            res.statusCode >= 500 &&
            res.statusCode < 600 &&
            state.serverErrorAttempts < maxServerRetries
          ) {
            const delay = Math.min(1000 * Math.pow(2, state.serverErrorAttempts), 15000);
            this.log(
              `  [api] Server error (${res.statusCode}), retrying in ${delay / 1000}s (attempt ${state.serverErrorAttempts + 1}/${maxServerRetries})`,
            );
            return setTimeout(
              () => retry({ ...state, serverErrorAttempts: state.serverErrorAttempts + 1 }),
              delay,
            );
          }

          if (res.statusCode === 204) return resolve(null);

          if (res.statusCode >= 400) {
            this.errorCount++;
            const e = new Error(
              `${method} ${path} -> ${res.statusCode}: ${data.substring(0, 500)}`,
            );
            e.statusCode = res.statusCode;
            return reject(e);
          }

          try {
            resolve(data ? JSON.parse(data) : null);
          } catch {
            resolve(data);
          }
        });
      });

      req.on("error", (err) => {
        this.errorCount++;
        if (state.serverErrorAttempts < maxServerRetries) {
          const delay = 2000 * (state.serverErrorAttempts + 1);
          this.log(`  [api] Connection error: ${err.message}, retrying in ${delay / 1000}s`);
          return setTimeout(
            () => retry({ ...state, serverErrorAttempts: state.serverErrorAttempts + 1 }),
            delay,
          );
        }
        reject(err);
      });

      req.on("timeout", () => {
        req.destroy();
        if (state.serverErrorAttempts < maxServerRetries) {
          const delay = 2000 * (state.serverErrorAttempts + 1);
          this.log(`  [api] Timeout, retrying in ${delay / 1000}s`);
          return setTimeout(
            () => retry({ ...state, serverErrorAttempts: state.serverErrorAttempts + 1 }),
            delay,
          );
        }
        reject(new Error(`Request timeout: ${method} ${path}`));
      });

      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  async testConnection() {
    // One small page of teams is enough to prove auth + org access.
    const res = await this._request(
      "GET",
      `/public/teams/v1/org/${encodeURIComponent(this.orgId)}/teams?size=1`,
    );
    return Array.isArray(res?.entities);
  }

  /** Async generator over every team in the org. */
  async *listTeams({ pageSize = 100 } = {}) {
    let cursor = null;
    while (true) {
      const qs = new URLSearchParams({ size: String(pageSize) });
      if (cursor) qs.set("cursor", cursor);
      const res = await this._request(
        "GET",
        `/public/teams/v1/org/${encodeURIComponent(this.orgId)}/teams?${qs.toString()}`,
      );
      const entities = res?.entities || [];
      for (const t of entities) yield t;
      cursor = res?.cursor || null;
      // Atlassian keeps returning the same cursor on the last page; stop when a
      // page is empty or the cursor stops advancing.
      if (!cursor || entities.length === 0) break;
      if (entities.length < pageSize) break;
    }
  }

  /**
   * Determine a team's membership cheaply. We only need to know whether there is
   * exactly one member (and who), so we fetch at most 2.
   * Returns { count: 0 | 1 | 2 (meaning "2+"), soleAccountId: string|null }.
   */
  async getMembershipSummary(teamId) {
    const res = await this._request(
      "POST",
      `/public/teams/v1/org/${encodeURIComponent(this.orgId)}/teams/${encodeURIComponent(teamId)}/members`,
      { first: 2 },
    );
    const results = res?.results || [];
    const hasNext = !!res?.pageInfo?.hasNextPage;
    if (results.length === 0) return { count: 0, soleAccountId: null };
    if (results.length === 1 && !hasNext)
      return { count: 1, soleAccountId: results[0].accountId };
    return { count: 2, soleAccountId: null }; // 2 means "two or more"
  }

  async deleteTeam(teamId) {
    try {
      await this._request(
        "DELETE",
        `/public/teams/v1/org/${encodeURIComponent(this.orgId)}/teams/${encodeURIComponent(teamId)}`,
      );
      return { ok: true, alreadyGone: false };
    } catch (err) {
      if (err.statusCode === 404) return { ok: true, alreadyGone: true };
      throw err;
    }
  }

  // ---- Jira Cloud site user lookups (for human-readable identity) ----

  async searchSiteUsers(query, maxResults = 50) {
    if (!this.siteBaseUrl) return [];
    const qs = new URLSearchParams({ query, maxResults: String(maxResults) });
    const res = await this._request(
      "GET",
      `${this.siteBaseUrl}/rest/api/3/user/search?${qs.toString()}`,
    );
    return Array.isArray(res) ? res : [];
  }

  async getSiteUser(accountId) {
    if (!this.siteBaseUrl) return null;
    try {
      return await this._request(
        "GET",
        `${this.siteBaseUrl}/rest/api/3/user?accountId=${encodeURIComponent(accountId)}`,
      );
    } catch (err) {
      if (err.statusCode === 404) return null;
      throw err;
    }
  }

  getStats() {
    return {
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      rateLimitCount: this.rateLimitCount,
    };
  }
}

module.exports = TeamsClient;
