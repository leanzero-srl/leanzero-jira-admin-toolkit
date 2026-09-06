const https = require("https");
const http = require("http");
const { URL } = require("url");

class CloudJiraClient {
  constructor(baseUrl, apiToken, log) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiToken = apiToken;
    this.log = log;
    this.requestCount = 0;
    this.errorCount = 0;
    this.rateLimitCount = 0;
  }

  makeRequest(method, path, body = null, retryState = null) {
    const state = retryState || {
      rateLimitAttempts: 0,
      serverErrorAttempts: 0,
    };

    return new Promise((resolve, reject) => {
      const fullUrl = `${this.baseUrl}${path}`;
      const parsed = new URL(fullUrl);
      const client = parsed.protocol === "https:" ? https : http;

      const options = {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          Authorization: `Basic ${this.apiToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 30000,
      };

      const req = client.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          this.requestCount++;

          if (res.statusCode === 204) {
            return resolve({ statusCode: 204, body: null });
          }

          if (res.statusCode === 429) {
            this.rateLimitCount++;
            if (state.rateLimitAttempts < 3) {
              const retryAfter = res.headers["retry-after"];
              const delays = [5000, 10000, 20000];
              const delay = retryAfter
                ? parseInt(retryAfter, 10) * 1000
                : delays[state.rateLimitAttempts] || 20000;
              this.log(
                `  Rate limited on ${method} ${path}, retry ${state.rateLimitAttempts + 1}/3 in ${delay / 1000}s`
              );
              state.rateLimitAttempts++;
              return setTimeout(() => {
                this.makeRequest(method, path, body, state)
                  .then(resolve)
                  .catch(reject);
              }, delay);
            }
            this.errorCount++;
            return reject(
              new Error(`Rate limit exceeded after 3 retries: ${method} ${path}`)
            );
          }

          if (res.statusCode >= 500) {
            // Some 500s are actually validation errors that will never succeed
            const nonRetriable =
              data.includes("Illegal Entity Scope") ||
              data.includes("entity scope");
            if (nonRetriable) {
              this.errorCount++;
              return reject(
                new Error(
                  `HTTP ${res.statusCode}: ${method} ${path} - ${data}`
                )
              );
            }
            if (state.serverErrorAttempts < 3) {
              const delay = Math.min(
                1000 * Math.pow(2, state.serverErrorAttempts),
                10000
              );
              this.log(
                `  Server error ${res.statusCode} on ${method} ${path}, retry ${state.serverErrorAttempts + 1}/3 in ${delay / 1000}s`
              );
              state.serverErrorAttempts++;
              return setTimeout(() => {
                this.makeRequest(method, path, body, state)
                  .then(resolve)
                  .catch(reject);
              }, delay);
            }
            this.errorCount++;
            return reject(
              new Error(
                `Server error ${res.statusCode} after 3 retries: ${method} ${path} - ${data}`
              )
            );
          }

          if (res.statusCode >= 400) {
            this.errorCount++;
            return reject(
              new Error(
                `HTTP ${res.statusCode}: ${method} ${path} - ${data}`
              )
            );
          }

          try {
            const parsed = data ? JSON.parse(data) : null;
            resolve({ statusCode: res.statusCode, body: parsed });
          } catch (e) {
            resolve({ statusCode: res.statusCode, body: data });
          }
        });
      });

      req.on("error", (err) => {
        if (state.serverErrorAttempts < 3) {
          const delay = 2000 * (state.serverErrorAttempts + 1);
          this.log(
            `  Connection error on ${method} ${path}: ${err.message}, retry ${state.serverErrorAttempts + 1}/3 in ${delay / 1000}s`
          );
          state.serverErrorAttempts++;
          return setTimeout(() => {
            this.makeRequest(method, path, body, state)
              .then(resolve)
              .catch(reject);
          }, delay);
        }
        this.errorCount++;
        reject(
          new Error(
            `Connection failed after 3 retries: ${method} ${path} - ${err.message}`
          )
        );
      });

      req.on("timeout", () => {
        req.destroy();
        if (state.serverErrorAttempts < 3) {
          const delay = 2000 * (state.serverErrorAttempts + 1);
          this.log(
            `  Timeout on ${method} ${path}, retry ${state.serverErrorAttempts + 1}/3 in ${delay / 1000}s`
          );
          state.serverErrorAttempts++;
          return setTimeout(() => {
            this.makeRequest(method, path, body, state)
              .then(resolve)
              .catch(reject);
          }, delay);
        }
        this.errorCount++;
        reject(
          new Error(`Request timeout after 3 retries: ${method} ${path}`)
        );
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  async testConnection() {
    const res = await this.makeRequest("GET", "/rest/api/3/serverInfo");
    return res.body;
  }

  // GET /rest/api/3/group?groupname=<name>&expand=users
  async findGroup(groupName) {
    const res = await this.makeRequest(
      "GET",
      `/rest/api/3/group?groupname=${encodeURIComponent(groupName)}`
    );
    return res.body;
  }

  // GET /rest/api/3/permissionscheme
  async fetchAllPermissionSchemes() {
    const res = await this.makeRequest("GET", "/rest/api/3/permissionscheme");
    return res.body.permissionSchemes || [];
  }

  // GET /rest/api/3/permissionscheme/{schemeId}/permission?expand=group
  async fetchPermissionGrants(schemeId) {
    const res = await this.makeRequest(
      "GET",
      `/rest/api/3/permissionscheme/${encodeURIComponent(schemeId)}/permission?expand=group`
    );
    return res.body.permissions || [];
  }

  // POST /rest/api/3/permissionscheme/{schemeId}/permission
  // NOTE: "parameter" (group name) and "value" (group ID) are mutually exclusive.
  //       The API recommends "value" (group ID) as group names can change.
  async createPermissionGrant(schemeId, permission, holderType, holderIdentifier, identifierIsGroupId) {
    const holder = { type: holderType };
    if (identifierIsGroupId) {
      holder.value = holderIdentifier;
    } else {
      holder.parameter = holderIdentifier;
    }

    const body = { permission, holder };
    return this.makeRequest(
      "POST",
      `/rest/api/3/permissionscheme/${encodeURIComponent(schemeId)}/permission`,
      body
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

module.exports = CloudJiraClient;
