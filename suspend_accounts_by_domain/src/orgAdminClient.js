const https = require("https");

/**
 * Client for the Atlassian Access REST API (Bearer-auth admin API).
 *
 * This script targets v1 because the staff org (which is the production
 * use case) is still on the legacy user-management experience — v2
 * (`/admin/v2/...`) returns 404 for it. v1 endpoints don't require a
 * directory ID and surface users at /v1/orgs/{orgId}/users.
 *
 * Endpoints used (per the official openapi-org.json shipped with this script):
 *   GET    /admin/v1/orgs/{orgId}                                       — connection test
 *   POST   /admin/v1/orgs/{orgId}/users/search                          — list users matching an email-domain filter
 *   POST   /admin/v1/orgs/{orgId}/directory/users/{accountId}/suspend-access   — suspend (returns 200)
 *   DELETE /admin/v1/orgs/{orgId}/directory/users/{accountId}                  — remove (returns 204, async)
 *
 * The plain GET /admin/v1/orgs/{orgId}/users endpoint only returns "managed
 * accounts" (those whose email domain the org has claimed). Invited but
 * unclaimed users — which is exactly the @legacy-domain.com case in staff —
 * never appear there. The search endpoint covers both, and lets the server
 * filter by domain so we don't have to page tens of thousands of unrelated
 * users.
 */
class OrgAdminClient {
  constructor({ apiKey, orgId, log }) {
    if (!apiKey) throw new Error("OrgAdminClient: apiKey is required");
    if (!orgId) throw new Error("OrgAdminClient: orgId is required");

    this.apiKey = apiKey;
    this.orgId = orgId;
    this.hostname = "api.atlassian.com";
    this.log = log || console.log;

    this.requestCount = 0;
    this.errorCount = 0;
    this.rateLimitCount = 0;
  }

  makeRequest(method, pathOrUrl, body = null, retryState = null) {
    const state = retryState || {
      rateLimitAttempts: 0,
      serverErrorAttempts: 0,
    };
    const maxRateLimitRetries = 3;
    const maxServerRetries = 3;

    // `links.next` from a UserPage is returned as a full URL; accept either.
    let hostname = this.hostname;
    let path = pathOrUrl;
    if (/^https?:\/\//i.test(pathOrUrl)) {
      const u = new URL(pathOrUrl);
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
          Authorization: `Bearer ${this.apiKey}`,
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
        this.makeRequest(method, pathOrUrl, body, newState)
          .then(resolve)
          .catch(reject);

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          this.requestCount++;

          if (res.statusCode === 429) {
            this.rateLimitCount++;
            if (state.rateLimitAttempts >= maxRateLimitRetries) {
              const error = new Error(
                `Org Admin API rate limit exceeded after ${maxRateLimitRetries} attempts: ${method} ${path}`,
              );
              error.statusCode = 429;
              error.isRateLimit = true;
              reject(error);
              return;
            }
            const retryAfter = res.headers["retry-after"];
            const delay = retryAfter
              ? parseInt(retryAfter, 10) * 1000
              : Math.min(5000 * Math.pow(2, state.rateLimitAttempts), 60000);
            console.log(
              `  [Org] Rate limited (429), waiting ${delay / 1000}s (attempt ${state.rateLimitAttempts + 1}/${maxRateLimitRetries})`,
            );
            setTimeout(
              () =>
                retry({
                  ...state,
                  rateLimitAttempts: state.rateLimitAttempts + 1,
                }),
              delay,
            );
            return;
          }

          if (
            res.statusCode >= 500 &&
            res.statusCode < 600 &&
            state.serverErrorAttempts < maxServerRetries
          ) {
            const delay = Math.min(
              1000 * Math.pow(2, state.serverErrorAttempts),
              10000,
            );
            console.log(
              `  [Org] Server error (${res.statusCode}), retrying in ${delay / 1000}s (attempt ${state.serverErrorAttempts + 1}/${maxServerRetries})`,
            );
            setTimeout(
              () =>
                retry({
                  ...state,
                  serverErrorAttempts: state.serverErrorAttempts + 1,
                }),
              delay,
            );
            return;
          }

          if (res.statusCode === 204) {
            resolve(null);
            return;
          }

          if (res.statusCode >= 400) {
            this.errorCount++;
            const error = new Error(
              `Org Admin API ${method} ${path} returned ${res.statusCode}: ${data.substring(0, 500)}`,
            );
            error.statusCode = res.statusCode;
            reject(error);
            return;
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
          console.log(
            `  [Org] Connection error: ${err.message}, retrying in ${delay / 1000}s`,
          );
          setTimeout(
            () =>
              retry({
                ...state,
                serverErrorAttempts: state.serverErrorAttempts + 1,
              }),
            delay,
          );
          return;
        }
        reject(err);
      });

      req.on("timeout", () => {
        req.destroy();
        if (state.serverErrorAttempts < maxServerRetries) {
          const delay = 2000 * (state.serverErrorAttempts + 1);
          console.log(
            `  [Org] Request timeout, retrying in ${delay / 1000}s`,
          );
          setTimeout(
            () =>
              retry({
                ...state,
                serverErrorAttempts: state.serverErrorAttempts + 1,
              }),
            delay,
          );
          return;
        }
        reject(new Error(`Org Admin API request timeout: ${method} ${path}`));
      });

      if (bodyStr) {
        req.write(bodyStr);
      }
      req.end();
    });
  }

  async testConnection() {
    try {
      const res = await this.makeRequest(
        "GET",
        `/admin/v1/orgs/${encodeURIComponent(this.orgId)}`,
      );
      return res?.data?.attributes?.name || true;
    } catch (error) {
      console.error(`  [Org] Connection test failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Async generator over every user matching the given email domain.
   *
   * Uses POST /admin/v1/orgs/{orgId}/users/search with a body filter so the
   * server returns only @<domain> matches (managed *and* invited/unclaimed).
   * Records come back as PublicUser:
   *   { accountId, accountType, accountStatus, name, nickname, email, ... }
   *
   * PublicUser does not expose membership/suspend state. The `isSuspended`
   * request-body filter is the only way to distinguish already-suspended
   * accounts from active/invited ones. Caller controls this via opts.
   *
   * Pagination: response `links.next` is an opaque cursor token. The next
   * request reuses the same filter body with an added `cursor` field.
   *
   *   opts.isSuspended  — true: only suspended; false: only non-suspended;
   *                       undefined: no filter (returns both).
   *   opts.match        — "eq" (default): exact domain match.
   *                       "contains": partial substring match on the domain.
   */
  async *searchUsersByDomain(domain, opts = {}) {
    const path = `/admin/v1/orgs/${encodeURIComponent(this.orgId)}/users/search`;
    const emailDomainsFilter =
      opts.match === "contains" ? { contains: domain } : { eq: [domain] };
    const baseBody = {
      emailDomains: emailDomainsFilter,
      expand: ["EMAIL", "NAME", "EMAIL_VERIFIED"],
      limit: opts.pageSize || 100,
    };
    if (typeof opts.isSuspended === "boolean") {
      baseBody.isSuspended = opts.isSuspended;
    }

    let cursor = null;
    while (true) {
      const body = cursor ? { ...baseBody, cursor } : baseBody;
      const res = await this.makeRequest("POST", path, body);
      const batch = res?.data || [];
      for (const user of batch) {
        yield user;
      }
      cursor = res?.links?.next || null;
      if (!cursor) break;
    }
  }

  async suspendUser(accountId) {
    await this.makeRequest(
      "POST",
      `/admin/v1/orgs/${encodeURIComponent(this.orgId)}` +
        `/directory/users/${encodeURIComponent(accountId)}/suspend-access`,
    );
  }

  async removeUser(accountId) {
    await this.makeRequest(
      "DELETE",
      `/admin/v1/orgs/${encodeURIComponent(this.orgId)}` +
        `/directory/users/${encodeURIComponent(accountId)}`,
    );
  }

  getStats() {
    return {
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      rateLimitCount: this.rateLimitCount,
    };
  }
}

module.exports = OrgAdminClient;
