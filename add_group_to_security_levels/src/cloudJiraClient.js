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

          // 204 No Content - success with no body
          if (res.statusCode === 204) {
            return resolve({ statusCode: 204, body: null });
          }

          // Rate limited
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

          // Server errors - retry
          if (res.statusCode >= 500) {
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

          // Client errors
          if (res.statusCode >= 400) {
            this.errorCount++;
            return reject(
              new Error(
                `HTTP ${res.statusCode}: ${method} ${path} - ${data}`
              )
            );
          }

          // Success with body
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

  // GET /rest/api/3/issuesecurityschemes
  async fetchAllSecuritySchemes() {
    const res = await this.makeRequest(
      "GET",
      "/rest/api/3/issuesecurityschemes"
    );
    return res.body.issueSecuritySchemes || [];
  }

  // GET /rest/api/3/issuesecurityschemes/level (paginated)
  async fetchSecurityLevels(schemeIds) {
    const levels = [];
    const schemeIdParams = schemeIds
      .map((id) => `schemeId=${encodeURIComponent(id)}`)
      .join("&");
    let startAt = 0;
    const maxResults = 50;

    while (true) {
      const res = await this.makeRequest(
        "GET",
        `/rest/api/3/issuesecurityschemes/level?${schemeIdParams}&startAt=${startAt}&maxResults=${maxResults}`
      );
      const page = res.body;
      const values = page.values || [];
      levels.push(...values);

      if (startAt + values.length >= (page.total || values.length)) break;
      if (values.length === 0) break;
      startAt += values.length;
    }

    return levels;
  }

  // GET /rest/api/3/issuesecurityschemes/level/member (paginated)
  async fetchSecurityLevelMembers(levelIds, schemeIds) {
    const members = [];
    let startAt = 0;
    const maxResults = 50;

    const levelIdParams = levelIds
      .map((id) => `levelId=${encodeURIComponent(id)}`)
      .join("&");
    const schemeIdParams = schemeIds
      .map((id) => `schemeId=${encodeURIComponent(id)}`)
      .join("&");

    while (true) {
      const res = await this.makeRequest(
        "GET",
        `/rest/api/3/issuesecurityschemes/level/member?${levelIdParams}&${schemeIdParams}&startAt=${startAt}&maxResults=${maxResults}&expand=group`
      );
      const page = res.body;
      const values = page.values || [];
      members.push(...values);

      if (startAt + values.length >= (page.total || values.length)) break;
      if (values.length === 0) break;
      startAt += values.length;
    }

    return members;
  }

  // PUT /rest/api/3/issuesecurityschemes/{schemeId}/level/{levelId}/member
  async addMemberToSecurityLevel(schemeId, levelId, memberType, parameter) {
    const body = {
      members: [
        {
          type: memberType,
          parameter: parameter,
        },
      ],
    };
    return this.makeRequest(
      "PUT",
      `/rest/api/3/issuesecurityschemes/${encodeURIComponent(schemeId)}/level/${encodeURIComponent(levelId)}/member`,
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
