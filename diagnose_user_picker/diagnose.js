#!/usr/bin/env node
/**
 * READ-ONLY diagnosis: why are some user-picker (Reporting Manager, cf 10216) accounts
 * not findable in the Jira user picker on your-site.atlassian.net?
 *
 * For a cohort of accountIds that appear as Reporting Manager values across ITSM:
 *   - findableByName : does GET /user/search?query=<displayName> return this id?
 *   - findableByPicker: does GET /user/picker?query=<displayName> return this id?
 *   - org directory attributes: claimStatus, platformRoles, email domain, product count
 * Then cross-tabulate findable vs each attribute to isolate the discriminator.
 *
 * Creds: Jira basic token from sync_same_instance_fields/.env,
 *        org bearer key from suspend_accounts_by_domain/.env.
 */
const https = require("https");
const fs = require("fs");
const path = require("path");

function loadEnv(p) {
  const out = {};
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const ROOT = path.resolve(__dirname, "..");
const jiraEnv = loadEnv(path.join(ROOT, "sync_same_instance_fields/.env"));
const orgEnv = loadEnv(path.join(ROOT, "suspend_accounts_by_domain/.env"));
const BASE = jiraEnv.CLOUD_BASE_URL.replace(/^https?:\/\//, "");
const JIRA_AUTH = "Basic " + jiraEnv.CLOUD_API_TOKEN;
const ORG = orgEnv.ORG_ID;
const ORG_AUTH = "Bearer " + orgEnv.ORG_ADMIN_API_KEY;
const DIR = "00000007-0000-4000-8000-000000000007";

function req(host, p, headers) {
  return new Promise((resolve, reject) => {
    const r = https.request(
      { host, path: p, method: "GET", headers: { Accept: "application/json", ...headers } },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          let j = null;
          try { j = JSON.parse(b); } catch {}
          resolve({ status: res.statusCode, json: j, raw: b });
        });
      }
    );
    r.on("error", reject);
    r.end();
  });
}
const jira = (p) => req(BASE, p, { Authorization: JIRA_AUTH });
const org = (p) => req("api.atlassian.com", p, { Authorization: ORG_AUTH });
const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function collectManagers(maxIssues) {
  const seen = new Map(); // accountId -> displayName
  let startAt = 0;
  const pageSize = 100;
  while (startAt < maxIssues) {
    const jql = enc('project = ITSM AND cf[10216] is not EMPTY ORDER BY created DESC');
    const r = await jira(`/rest/api/3/search/jql?jql=${jql}&maxResults=${pageSize}&fields=customfield_10216&nextPageToken=`);
    // fall back to classic search if new endpoint not available
    let issues, isLast = true, nextToken = null;
    if (r.status === 200 && r.json && r.json.issues) {
      issues = r.json.issues;
      nextToken = r.json.nextPageToken;
      isLast = r.json.isLast !== false && !nextToken;
    } else {
      const r2 = await jira(`/rest/api/3/search?jql=${enc('project = ITSM AND cf[10216] is not EMPTY ORDER BY created DESC')}&startAt=${startAt}&maxResults=${pageSize}&fields=customfield_10216`);
      if (r2.status !== 200 || !r2.json || !r2.json.issues) { console.error("search failed", r2.status, r2.raw.slice(0,200)); break; }
      issues = r2.json.issues;
      isLast = startAt + issues.length >= (r2.json.total || 0);
    }
    for (const is of issues) {
      const v = is.fields && is.fields.customfield_10216;
      if (v && v.accountId) seen.set(v.accountId, v.displayName || "");
    }
    startAt += issues.length;
    if (!issues.length || isLast) break;
  }
  return seen;
}

async function classify(accountId, displayName) {
  // findable by name query
  const q = enc(displayName || "");
  const s = await jira(`/rest/api/3/user/search?query=${q}&maxResults=100`);
  const inSearch = Array.isArray(s.json) && s.json.some((u) => u.accountId === accountId);
  const p = await jira(`/rest/api/3/user/picker?query=${q}&maxResults=100`);
  const inPicker = p.json && Array.isArray(p.json.users) && p.json.users.some((u) => u.accountId === accountId);
  // org directory record
  let claim = "?", roles = "?", domain = "?", prods = "?";
  const d2 = await org(`/admin/v2/orgs/${ORG}/directories/${DIR}/users/${accountId}`);
  if (d2.status === 200 && d2.json && d2.json.data) {
    const dd = d2.json.data;
    claim = dd.claimStatus;
    roles = (dd.platformRoles || []).join("|") || "(none)";
    domain = (dd.email || "").split("@")[1] || "?";
  }
  const la = await org(`/admin/v1/orgs/${ORG}/directory/users/${accountId}/last-active-dates`);
  if (la.status === 200 && la.json && la.json.data) {
    prods = (la.json.data.product_access || []).length;
  }
  const prefix = accountId.includes(":") ? accountId.split(":")[0] + ":" : "hex";
  return { accountId, displayName, inSearch, inPicker, claim, roles, domain, prods, prefix };
}

(async () => {
  const MAX = parseInt(process.argv[2] || "400", 10);
  console.log(`Collecting Reporting Manager (cf10216) values from up to ${MAX} ITSM issues...`);
  const mgrs = await collectManagers(MAX);
  console.log(`Distinct Reporting Manager accounts: ${mgrs.size}\n`);
  const rows = [];
  let i = 0;
  for (const [id, name] of mgrs) {
    i++;
    try {
      const row = await classify(id, name);
      rows.push(row);
      const flag = row.inSearch ? "FIND" : "MISS";
      console.log(`${String(i).padStart(3)}/${mgrs.size} [${flag}] ${String(name).padEnd(26)} claim=${String(row.claim).padEnd(9)} roles=${String(row.roles).padEnd(28)} prods=${String(row.prods).padEnd(2)} dom=${row.domain} id=${row.prefix}`);
    } catch (e) {
      console.log(`${i} ERROR ${name}: ${e.message}`);
    }
    await sleep(120);
  }

  // cross-tab
  const findable = rows.filter((r) => r.inSearch);
  const missing = rows.filter((r) => !r.inSearch);
  console.log("\n" + "=".repeat(70));
  console.log(`TOTAL ${rows.length}  |  findable-by-name ${findable.length}  |  MISSING ${missing.length}`);
  const tab = (label, fn) => {
    const agg = {};
    for (const r of rows) {
      const k = fn(r);
      agg[k] = agg[k] || { find: 0, miss: 0 };
      r.inSearch ? agg[k].find++ : agg[k].miss++;
    }
    console.log(`\n-- by ${label} --`);
    for (const k of Object.keys(agg).sort()) console.log(`   ${String(k).padEnd(34)} findable=${agg[k].find}  MISSING=${agg[k].miss}`);
  };
  tab("claimStatus", (r) => r.claim);
  tab("platformRoles", (r) => r.roles);
  tab("accountId format", (r) => r.prefix);
  tab("hasProductAccess", (r) => (Number(r.prods) > 0 ? "yes(>0)" : "no(0)"));
  tab("email domain", (r) => r.domain);

  fs.writeFileSync(path.join(__dirname, "cohort.json"), JSON.stringify(rows, null, 2));
  console.log("\nWrote cohort.json");
})();
