#!/usr/bin/env node
/**
 * Copy permission schemes from Jira Data Center -> Jira Cloud as LITERAL copies.
 *
 * Why this exists: JCMA only migrates permission schemes that are ASSIGNED to a
 * project. Inactive (unassigned) schemes are silently left behind. This script
 * recreates the missing schemes on Cloud, translating every grant's holder
 * (user / group / projectRole / customField) to the target instance. It does
 * NOT assign any scheme to a project — creation only.
 *
 * Discriminator: a DC scheme is considered "already migrated" if a Cloud scheme
 * with the same name (case-insensitive) already exists. Those are skipped by
 * default (so we only create the genuinely-missing ones). Use --include-existing
 * to override (will fail on Cloud's unique-name constraint — for inspection only).
 *
 * Holder translation:
 *   group           DC group name  -> Cloud groupId      (resolved via /group/bulk; by NAME)
 *   user            DC username    -> Cloud accountId     (resolved via holder email -> /user/search)
 *   projectRole     DC role name   -> Cloud role id       (matched by NAME)
 *   groupCustomField/userCustomField  DC fieldId -> Cloud fieldId (matched by NAME, built lazily)
 *   assignee/reporter/projectLead/anyone/applicationRole  passed through (type-only / value)
 *
 * SAFETY: never guesses an ambiguous user. Anything unresolved is FLAGGED and the
 * grant is SKIPPED (the scheme is still created with the grants that did resolve).
 * Default mode is DRY-RUN (resolve + report, no writes); pass --apply to create.
 *
 * Optional overrides (sibling JSON files, all keys optional):
 *   user_overrides.json   { "<dc-username-or-email>": "<cloud-accountId>", ... }
 *   group_overrides.json  { "<dc-group-name>": "<cloud-group-name-or-groupId>", ... }
 *
 * Env (.env or shell): DC_BASE_URL, DC_USERNAME, DC_PASSWORD, CLOUD_BASE_URL, CLOUD_API_TOKEN
 *
 * CLI:
 *   --apply                actually create schemes+grants (default: dry-run)
 *   --only <substr>        only schemes whose name contains <substr> (case-insensitive)
 *   --include-existing     also process schemes already present on Cloud by name
 *   --limit <n>            process at most n schemes (after filtering)
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { URL } = require("url");

// ── env (manual parse so it runs with zero npm install) ─────────────────────────
function loadEnv() {
  const p = path.resolve(__dirname, ".env");
  if (fs.existsSync(p)) {
    for (const raw of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i === -1) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (!(k in process.env)) process.env[k] = v;
    }
  }
}
loadEnv();
const E = process.env;

// ── CLI ─────────────────────────────────────────────────────────────────────────
const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes("--apply");
const INCLUDE_EXISTING = ARGS.includes("--include-existing");
const argVal = (flag) => {
  const i = ARGS.indexOf(flag);
  return i !== -1 && i + 1 < ARGS.length ? ARGS[i + 1] : null;
};
const ONLY = (argVal("--only") || "").toLowerCase();
const LIMIT = argVal("--limit") ? parseInt(argVal("--limit"), 10) : null;

// ── logging ──────────────────────────────────────────────────────────────────────
const logsDir = path.resolve(__dirname, "logs");
fs.mkdirSync(logsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const logFile = path.join(logsDir, `copy_permission_schemes_${stamp}.log`);
function log(msg) {
  console.log(msg);
  try { fs.appendFileSync(logFile, msg + "\n"); } catch (_) {}
}

// ── HTTP ───────────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function request(method, urlStr, authHeader, body, retry = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "http:" ? http : https;
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Atlassian-Token": "no-check",
      },
      timeout: 30000,
    };
    const req = lib.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", async () => {
        if (res.statusCode === 204) return resolve({ status: 204, body: null });
        const retryable = res.statusCode === 429 || (res.statusCode >= 500 && res.statusCode < 600);
        if (retryable && retry < 4) {
          const ra = parseInt(res.headers["retry-after"] || "0", 10);
          const delay = ra > 0 ? ra * 1000 : Math.min(1000 * 2 ** retry, 20000);
          await sleep(delay);
          return request(method, urlStr, authHeader, body, retry + 1).then(resolve, reject);
        }
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (_) { parsed = data; }
        if (res.statusCode >= 400) {
          return reject(Object.assign(new Error(`HTTP ${res.statusCode} ${method} ${u.pathname}: ${String(data).slice(0, 300)}`), { status: res.statusCode, body: parsed }));
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", async (err) => {
      if (retry < 4) { await sleep(2000 * (retry + 1)); return request(method, urlStr, authHeader, body, retry + 1).then(resolve, reject); }
      reject(err);
    });
    req.on("timeout", () => { req.destroy(); reject(new Error(`timeout ${method} ${urlStr}`)); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const DC_BASE = (E.DC_BASE_URL || "").replace(/\/+$/, "");
const CLOUD_BASE = (E.CLOUD_BASE_URL || "").replace(/\/+$/, "");
const DC_AUTH = "Basic " + Buffer.from(`${E.DC_USERNAME}:${E.DC_PASSWORD}`).toString("base64");
const CLOUD_AUTH = "Basic " + E.CLOUD_API_TOKEN;

const dcGet = (p) => request("GET", DC_BASE + p, DC_AUTH).then((r) => r.body);
const cloudGet = (p) => request("GET", CLOUD_BASE + p, CLOUD_AUTH).then((r) => r.body);
const cloudPost = (p, b) => request("POST", CLOUD_BASE + p, CLOUD_AUTH, b);

// ── overrides ────────────────────────────────────────────────────────────────────
function loadJson(name) {
  const p = path.resolve(__dirname, name);
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {}; }
  catch (e) { log(`  WARN: could not parse ${name}: ${e.message}`); return {}; }
}
const USER_OVERRIDES = loadJson("user_overrides.json");   // dc username|email -> cloud accountId
const GROUP_OVERRIDES = loadJson("group_overrides.json"); // dc group name -> cloud group name|groupId

const norm = (s) => String(s == null ? "" : s).trim().toLowerCase();

// ── caches / lookups ─────────────────────────────────────────────────────────────
const userCache = new Map();   // dc username -> {accountId} | {unresolved, reason, candidates}
const groupCache = new Map();  // dc group name -> {groupId, name} | {unresolved, reason}
let cloudRolesByName = null;   // Map(normName -> roleId)
let dcFieldById = null;        // Map(dc fieldId -> dc field name)  (lazy)
let cloudFieldByName = null;   // Map(normName -> cloud fieldId)    (lazy)

async function getCloudRoles() {
  if (cloudRolesByName) return cloudRolesByName;
  const roles = await cloudGet("/rest/api/3/role");
  cloudRolesByName = new Map();
  for (const r of roles || []) cloudRolesByName.set(norm(r.name), String(r.id));
  return cloudRolesByName;
}

async function getExistingCloudSchemeNames() {
  const body = await cloudGet("/rest/api/3/permissionscheme");
  const set = new Set();
  for (const s of (body.permissionSchemes || [])) set.add(norm(s.name));
  return set;
}

async function getDcSchemes() {
  // expand holder details so we get user emails + role names + group names inline
  const body = await dcGet("/rest/api/2/permissionscheme?expand=permissions,user,group,projectRole,field");
  return body.permissionSchemes || [];
}

// dc username -> dc email (fallback when holder.user is not expanded / lacks email)
async function dcUserEmail(username) {
  try {
    const u = await dcGet(`/rest/api/2/user?username=${encodeURIComponent(username)}`);
    return { email: u.emailAddress || null, displayName: u.displayName || null };
  } catch (_) { return { email: null, displayName: null }; }
}

// resolve a cloud accountId from a DC user holder (prefer email, never guess ambiguous)
async function resolveCloudUser(holder) {
  const username = (holder.user && (holder.user.name || holder.user.key)) || holder.parameter || "";
  if (userCache.has(username)) return userCache.get(username);

  // 1) explicit override (by username or by email)
  const ov = USER_OVERRIDES[username] || USER_OVERRIDES[norm(username)] ||
    (holder.user && holder.user.emailAddress && (USER_OVERRIDES[holder.user.emailAddress] || USER_OVERRIDES[norm(holder.user.emailAddress)]));
  if (ov) { const r = { accountId: ov, via: "override" }; userCache.set(username, r); return r; }

  // 2) gather email + display name (from expansion or a direct DC lookup)
  let email = holder.user && holder.user.emailAddress;
  let displayName = holder.user && holder.user.displayName;
  if (!email) { const d = await dcUserEmail(username); email = d.email; displayName = displayName || d.displayName; }

  const decide = (candidates, via) => {
    const r = candidates.length === 1
      ? { accountId: candidates[0].accountId, via, displayName: candidates[0].displayName }
      : { unresolved: true, reason: candidates.length === 0 ? `no Cloud account for ${via}` : `ambiguous: ${candidates.length} Cloud accounts`, candidates: candidates.map((c) => ({ accountId: c.accountId, displayName: c.displayName, email: c.emailAddress, active: c.active })) };
    return r;
  };

  let result = null;
  if (email) {
    const found = await cloudGet(`/rest/api/3/user/search?query=${encodeURIComponent(email)}&maxResults=50`);
    const exact = (found || []).filter((u) => norm(u.emailAddress) === norm(email));
    // prefer active atlassian accounts to dodge the "two accounts, one dead" trap
    const preferred = exact.filter((u) => u.active && u.accountType === "atlassian");
    result = decide(preferred.length ? preferred : exact, `email ${email}`);
  }
  // 3) last resort: unique active display-name match (only if email gave us nothing)
  if ((!result || result.unresolved) && displayName) {
    const found = await cloudGet(`/rest/api/3/user/search?query=${encodeURIComponent(displayName)}&maxResults=50`);
    const exact = (found || []).filter((u) => norm(u.displayName) === norm(displayName) && u.active && u.accountType === "atlassian");
    if (exact.length === 1) result = { accountId: exact[0].accountId, via: `displayName ${displayName}`, displayName: exact[0].displayName };
    else if (!result) result = { unresolved: true, reason: `no email; displayName "${displayName}" ${exact.length === 0 ? "not found" : "ambiguous"}` };
  }
  if (!result) result = { unresolved: true, reason: `no email and no displayName for "${username}"` };
  userCache.set(username, result);
  return result;
}

async function resolveCloudGroup(holder) {
  const dcName = (holder.group && holder.group.name) || holder.parameter || "";
  if (groupCache.has(dcName)) return groupCache.get(dcName);
  let target = GROUP_OVERRIDES[dcName] || GROUP_OVERRIDES[norm(dcName)] || dcName;
  // override may already be a groupId (uuid-ish) -> accept directly
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(target)) { const r = { groupId: target, name: dcName, via: "override(groupId)" }; groupCache.set(dcName, r); return r; }
  let result;
  try {
    const body = await cloudGet(`/rest/api/3/group/bulk?groupName=${encodeURIComponent(target)}&maxResults=50`);
    const matches = (body.values || []).filter((g) => norm(g.name) === norm(target));
    if (matches.length === 1) result = { groupId: matches[0].groupId, name: matches[0].name, via: "name" };
    else if (matches.length > 1) result = { unresolved: true, reason: `ambiguous: ${matches.length} Cloud groups named "${target}"` };
    else result = { unresolved: true, reason: `no Cloud group named "${target}"` };
  } catch (e) { result = { unresolved: true, reason: `group lookup failed: ${e.message}` }; }
  groupCache.set(dcName, result);
  return result;
}

async function getCloudFieldId(dcFieldId) {
  if (!dcFieldById) {
    dcFieldById = new Map();
    const dcFields = await dcGet("/rest/api/2/field");
    for (const f of dcFields || []) if (f.custom) dcFieldById.set(String(f.id), f.name);
  }
  if (!cloudFieldByName) {
    cloudFieldByName = new Map();
    let startAt = 0;
    for (;;) {
      const j = await cloudGet(`/rest/api/3/field/search?type=custom&startAt=${startAt}&maxResults=100`);
      for (const f of j.values || []) if (!cloudFieldByName.has(norm(f.name))) cloudFieldByName.set(norm(f.name), f.id);
      if (j.isLast || !(j.values || []).length) break;
      startAt += j.values.length;
    }
  }
  const dcName = dcFieldById.get(String(dcFieldId));
  if (!dcName) return { unresolved: true, reason: `DC field ${dcFieldId} not found` };
  const cid = cloudFieldByName.get(norm(dcName));
  return cid ? { fieldId: cid, name: dcName } : { unresolved: true, reason: `no Cloud field named "${dcName}"` };
}

// translate one DC permission grant -> Cloud {permission, holder} or {skip,reason}
async function translateGrant(grant) {
  const permission = grant.permission;
  const h = grant.holder || {};
  const type = norm(h.type);
  switch (type) {
    case "group": {
      const g = await resolveCloudGroup(h);
      if (g.unresolved) return { skip: true, permission, holderDesc: `group:${(h.group && h.group.name) || h.parameter}`, reason: g.reason };
      return { permission, holder: { type: "group", value: g.groupId }, holderDesc: `group:${g.name}` };
    }
    case "user": {
      const u = await resolveCloudUser(h);
      const uname = (h.user && (h.user.name || h.user.displayName)) || h.parameter;
      if (u.unresolved) return { skip: true, permission, holderDesc: `user:${uname}`, reason: u.reason, candidates: u.candidates };
      return { permission, holder: { type: "user", value: u.accountId }, holderDesc: `user:${uname} -> ${u.accountId}` };
    }
    case "projectrole": {
      const roleName = (h.projectRole && h.projectRole.name) || null;
      const roles = await getCloudRoles();
      const cloudId = roleName ? roles.get(norm(roleName)) : null;
      if (!cloudId) return { skip: true, permission, holderDesc: `projectRole:${roleName || h.parameter}`, reason: roleName ? `no Cloud role named "${roleName}"` : "DC role name missing (no expansion)" };
      return { permission, holder: { type: "projectRole", value: cloudId }, holderDesc: `projectRole:${roleName}` };
    }
    case "groupcustomfield":
    case "usercustomfield": {
      const f = await getCloudFieldId(h.parameter);
      if (f.unresolved) return { skip: true, permission, holderDesc: `${type}:${h.parameter}`, reason: f.reason };
      return { permission, holder: { type: h.type, value: f.fieldId }, holderDesc: `${type}:${f.name}` };
    }
    case "lead":
    case "projectlead":
      return { permission, holder: { type: "projectLead" }, holderDesc: "projectLead" };
    case "assignee":
    case "reporter":
    case "anyone":
      return { permission, holder: { type: h.type }, holderDesc: type };
    case "applicationrole":
      return { permission, holder: h.parameter ? { type: "applicationRole", value: h.parameter } : { type: "applicationRole" }, holderDesc: `applicationRole:${h.parameter || "any"}` };
    default:
      // pass the type through; let Cloud accept/reject, but warn
      return { permission, holder: h.parameter ? { type: h.type, value: h.parameter } : { type: h.type }, holderDesc: `${type}:${h.parameter || ""}`, warnUnknownType: true };
  }
}

// ── main ─────────────────────────────────────────────────────────────────────────
(async () => {
  for (const k of ["DC_BASE_URL", "DC_USERNAME", "DC_PASSWORD", "CLOUD_BASE_URL", "CLOUD_API_TOKEN"])
    if (!E[k]) { log(`ERROR: missing env ${k}`); process.exit(1); }

  log("====================================================================");
  log("Copy permission schemes: DC -> Cloud (literal copy, NOT assigned)");
  log("====================================================================");
  log(`  Source DC:   ${DC_BASE}`);
  log(`  Target Cloud:${CLOUD_BASE}`);
  log(`  Mode:        ${APPLY ? "*** APPLY (will create schemes) ***" : "DRY-RUN (no writes)"}`);
  if (ONLY) log(`  Filter:      name contains "${ONLY}"`);
  if (LIMIT) log(`  Limit:       ${LIMIT}`);
  log("");

  // connectivity
  try { const si = await dcGet("/rest/api/2/serverInfo"); log(`  DC OK:    ${si.serverTitle || si.baseUrl} (${si.version || "?"})`); }
  catch (e) { log(`  DC FAILED: ${e.message}`); process.exit(1); }
  try { const me = await cloudGet("/rest/api/3/myself"); log(`  Cloud OK: ${me.displayName} <${me.emailAddress || "?"}>`); }
  catch (e) { log(`  Cloud FAILED: ${e.message}`); process.exit(1); }
  log("");

  const existingNames = await getExistingCloudSchemeNames();
  log(`  Cloud already has ${existingNames.size} permission scheme(s).`);

  let schemes = await getDcSchemes();
  log(`  DC has ${schemes.length} permission scheme(s) total.\n`);

  // pick the ones to create
  let candidates = schemes.filter((s) => INCLUDE_EXISTING || !existingNames.has(norm(s.name)));
  const skippedExisting = schemes.filter((s) => !INCLUDE_EXISTING && existingNames.has(norm(s.name)));
  if (ONLY) candidates = candidates.filter((s) => norm(s.name).includes(ONLY));
  if (LIMIT) candidates = candidates.slice(0, LIMIT);

  log(`  Already on Cloud (skipped): ${skippedExisting.length}`);
  for (const s of skippedExisting) log(`      = ${s.name}`);
  log(`\n  To create: ${candidates.length}`);
  for (const s of candidates) log(`      + ${s.name}  (${(s.permissions || []).length} grant(s))`);
  log("");

  const report = { metadata: { timestamp: new Date().toISOString(), dc: DC_BASE, cloud: CLOUD_BASE, mode: APPLY ? "apply" : "dry-run" }, schemes: [], unresolved: [] };
  let created = 0, failed = 0, grantsAdded = 0, grantsSkipped = 0, grantsWouldAdd = 0;

  for (const scheme of candidates) {
    log(`\n────────────────────────────────────────────────────────────────`);
    log(`Scheme: "${scheme.name}"  (DC id ${scheme.id})`);
    const grants = scheme.permissions || [];

    // translate all grants first (so dry-run shows the full picture)
    const translated = [];
    for (const g of grants) {
      const t = await translateGrant(g);
      translated.push(t);
      if (t.skip) {
        grantsSkipped++;
        log(`   ⚠ SKIP ${t.permission} <- ${t.holderDesc}  (${t.reason})`);
        report.unresolved.push({ scheme: scheme.name, permission: t.permission, holder: t.holderDesc, reason: t.reason, candidates: t.candidates });
      } else {
        log(`   ✓ ${t.permission} <- ${t.holderDesc}${t.warnUnknownType ? "  [unknown holder type — passthrough]" : ""}`);
      }
    }
    const good = translated.filter((t) => !t.skip);
    grantsWouldAdd += good.length;

    const schemeReport = { dcId: scheme.id, name: scheme.name, description: scheme.description || null, grantsTotal: grants.length, grantsTranslated: good.length, grantsSkipped: grants.length - good.length, cloudId: null, status: null, grantResults: [] };

    if (!APPLY) {
      schemeReport.status = "dry-run";
      report.schemes.push(schemeReport);
      continue;
    }

    // create the empty scheme, then add grants one-by-one
    let cloudScheme;
    try {
      const body = { name: scheme.name };
      if (scheme.description) body.description = scheme.description;
      const res = await cloudPost("/rest/api/3/permissionscheme", body);
      cloudScheme = res.body;
      schemeReport.cloudId = cloudScheme.id;
      log(`   → created Cloud scheme id ${cloudScheme.id}`);
    } catch (e) {
      failed++;
      schemeReport.status = "create-failed";
      schemeReport.error = e.message;
      log(`   ✗ create FAILED: ${e.message}`);
      report.schemes.push(schemeReport);
      continue;
    }

    let okGrants = 0, failGrants = 0;
    for (const t of good) {
      try {
        await cloudPost(`/rest/api/3/permissionscheme/${cloudScheme.id}/permission`, { permission: t.permission, holder: t.holder });
        okGrants++; grantsAdded++;
        schemeReport.grantResults.push({ permission: t.permission, holder: t.holderDesc, status: "ok" });
      } catch (e) {
        failGrants++;
        schemeReport.grantResults.push({ permission: t.permission, holder: t.holderDesc, status: "failed", error: e.message });
        log(`   ✗ grant FAILED ${t.permission} <- ${t.holderDesc}: ${e.message.slice(0, 160)}`);
      }
    }
    schemeReport.status = "created";
    created++;
    log(`   ✓ scheme done: ${okGrants} grant(s) added, ${failGrants} failed, ${schemeReport.grantsSkipped} unresolved-skipped`);
    report.schemes.push(schemeReport);
  }

  // write report
  const reportFile = path.join(logsDir, `report_${stamp}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

  log(`\n====================================================================`);
  log(`SUMMARY (${APPLY ? "APPLY" : "DRY-RUN"})`);
  log(`====================================================================`);
  log(`  Schemes to create:        ${candidates.length}`);
  if (APPLY) {
    log(`  Schemes created:          ${created}`);
    log(`  Schemes failed:           ${failed}`);
    log(`  Grants added:             ${grantsAdded}`);
  } else {
    log(`  Grants that would add:    ${grantsWouldAdd}`);
  }
  log(`  Grants unresolved/skipped:${grantsSkipped}`);
  // distinct unresolved holders, grouped by reason kind
  const unresUsers = report.unresolved.filter((u) => u.holder.startsWith("user:"));
  const unresGroups = report.unresolved.filter((u) => u.holder.startsWith("group:"));
  const unresRoles = report.unresolved.filter((u) => u.holder.startsWith("projectRole:"));
  if (report.unresolved.length) {
    log(`\n  Unresolved holders need attention:`);
    log(`    users:  ${new Set(unresUsers.map((u) => u.holder)).size} distinct`);
    log(`    groups: ${new Set(unresGroups.map((u) => u.holder)).size} distinct`);
    log(`    roles:  ${new Set(unresRoles.map((u) => u.holder)).size} distinct`);
    log(`    -> add fixes to user_overrides.json / group_overrides.json and re-run.`);
  }
  log(`\n  Report: ${reportFile}`);
  log(`  Log:    ${logFile}`);
  if (!APPLY) log(`\n  This was a DRY-RUN. Re-run with --apply to create the schemes.`);
})().catch((e) => { log(`\nFATAL: ${e.stack || e.message}`); process.exit(1); });
