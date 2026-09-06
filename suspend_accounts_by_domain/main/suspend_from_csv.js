#!/usr/bin/env node

/**
 * Suspend org accounts listed in a CSV (by accountId).
 *
 * Reversible: each suspend is POST /admin/v1/orgs/{orgId}/directory/users/{id}/suspend-access
 * (restore with .../restore-access). Reads the flagged-accounts CSV produced by
 * find_migration_accounts.js, so it can suspend a list that spans many domains —
 * something suspend_accounts_by_domain (single-domain) can't do.
 *
 * Resilience:
 *   - concurrency pool (default 5), same as suspend_accounts_by_domain
 *   - every outcome appended to logs/suspend_results.csv as it happens
 *   - resumable: accountIds already marked suspended/already-gone are skipped
 *   - 404 = already-gone (idempotent), counted as success
 *
 * Usage:
 *   node main/suspend_from_csv.js --file=logs/migration_flagged_active_1211.csv --dry-run
 *   node main/suspend_from_csv.js --file=logs/migration_flagged_active_1211.csv
 *   node main/suspend_from_csv.js --file=... --resume
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const OrgAdminClient = require("../src/orgAdminClient");

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const DRY_RUN = process.argv.includes("--dry-run");
const RESUME = process.argv.includes("--resume");
const CONCURRENCY = parseInt(arg("concurrency", "5"), 10) || 5;
const FILE = arg("file", "logs/migration_flagged_active_1211.csv");

const logDir = path.join(__dirname, "../logs");
const resultsPath = path.join(logDir, "suspend_results.csv");
const RESULTS_HEADER = "accountId,email,result,error,at\n";

function parseCsvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i), ch = line[i];
    if (q) {
      if (c === 34) { if (line.charCodeAt(i + 1) === 34) { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else {
      if (c === 34) q = true;
      else if (c === 44) { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

const esc = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function loadDone() {
  const done = new Set();
  if (!fs.existsSync(resultsPath)) return done;
  const lines = fs.readFileSync(resultsPath, "utf8").trim().split("\n").slice(1);
  for (const l of lines) {
    if (!l) continue;
    const f = parseCsvLine(l);
    if (f[2] === "suspended" || f[2] === "already-gone") done.add(f[0]);
  }
  return done;
}

async function main() {
  const orgId = process.env.ORG_ID;
  const apiKey = process.env.ORG_ADMIN_API_KEY;
  if (!orgId || !apiKey) { console.error("Missing ORG_ID / ORG_ADMIN_API_KEY in .env"); process.exit(1); }

  const csvFull = path.isAbsolute(FILE) ? FILE : path.join(__dirname, "..", FILE);
  if (!fs.existsSync(csvFull)) { console.error(`Input CSV not found: ${csvFull}`); process.exit(1); }

  const lines = fs.readFileSync(csvFull, "utf8").trim().split("\n");
  const header = parseCsvLine(lines[0]);
  const idIdx = header.indexOf("accountId");
  const emailIdx = header.indexOf("email");
  const statusIdx = header.indexOf("accountStatus");
  if (idIdx === -1) { console.error("CSV has no accountId column"); process.exit(1); }

  let targets = lines.slice(1).filter(Boolean).map(parseCsvLine).map((f) => ({
    accountId: f[idIdx],
    email: f[emailIdx] || "",
    status: statusIdx === -1 ? "" : f[statusIdx],
  }));

  // Safety: this list is meant to be the active accounts. Refuse to silently
  // suspend rows that aren't 'active' if the column is present.
  const nonActive = targets.filter((t) => t.status && t.status !== "active");
  if (nonActive.length) {
    console.log(`Note: ${nonActive.length} row(s) are not 'active' and will be skipped.`);
    targets = targets.filter((t) => !t.status || t.status === "active");
  }

  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const done = RESUME ? loadDone() : new Set();
  if (!RESUME || !fs.existsSync(resultsPath)) fs.writeFileSync(resultsPath, RESULTS_HEADER);
  const pending = targets.filter((t) => !done.has(t.accountId));

  console.log("==================================================");
  console.log(`SUSPEND from CSV${DRY_RUN ? "  (DRY RUN — no API writes)" : "  *** LIVE ***"}`);
  console.log("==================================================");
  console.log(`  Org ID:       ${orgId}`);
  console.log(`  Input:        ${csvFull}`);
  console.log(`  Targets:      ${targets.length} active`);
  console.log(`  Already done: ${done.size}`);
  console.log(`  To suspend:   ${pending.length}`);
  console.log(`  Concurrency:  ${CONCURRENCY}`);
  console.log("");

  const client = new OrgAdminClient({ apiKey, orgId, log: console.log });
  const orgName = await client.testConnection();
  if (!orgName) { console.error("Cannot reach Org Admin API."); process.exit(1); }
  console.log(`Org Admin API: OK (org=${orgName})\n`);

  const stats = { suspended: 0, alreadyGone: 0, failed: 0, processed: 0 };
  const writeResult = (accountId, email, result, error) => {
    fs.appendFileSync(resultsPath, [accountId, email, result, error || "", new Date().toISOString()].map(esc).join(",") + "\n");
  };

  let idx = 0;
  const worker = async () => {
    while (idx < pending.length) {
      const i = idx++;
      const t = pending[i];
      stats.processed++;
      if (DRY_RUN) {
        console.log(`  [dry-run] would suspend ${t.email} (${t.accountId})`);
        stats.suspended++;
        continue;
      }
      try {
        await client.suspendUser(t.accountId);
        stats.suspended++;
        writeResult(t.accountId, t.email, "suspended", "");
        console.log(`  [${stats.processed}/${pending.length}] suspended ${t.email}`);
      } catch (e) {
        if (e.statusCode === 404) {
          stats.alreadyGone++;
          writeResult(t.accountId, t.email, "already-gone", "404");
          console.log(`  [${stats.processed}/${pending.length}] already-gone (404) ${t.email}`);
        } else {
          stats.failed++;
          writeResult(t.accountId, t.email, "failed", e.message);
          console.log(`  [${stats.processed}/${pending.length}] FAILED ${t.email}: ${e.message}`);
        }
      }
    }
  };

  const workers = [];
  for (let w = 0; w < Math.min(CONCURRENCY, pending.length); w++) workers.push(worker());
  await Promise.all(workers);

  console.log("\n" + "=".repeat(70));
  console.log(DRY_RUN ? "DRY RUN COMPLETE — no accounts changed" : "SUSPEND COMPLETE");
  console.log("=".repeat(70));
  console.log(`  Suspended:    ${stats.suspended}`);
  console.log(`  Already gone: ${stats.alreadyGone}`);
  console.log(`  Failed:       ${stats.failed}`);
  if (!DRY_RUN) console.log(`  Results CSV:  ${resultsPath}`);
  const a = client.getStats();
  console.log(`  API requests: ${a.requestCount} (${a.errorCount} errors, ${a.rateLimitCount} rate limits)`);
  if (stats.failed) console.log(`\n  ${stats.failed} failed — re-run with --resume to retry remaining.`);
}

main().catch((e) => { console.error(`\nFatal: ${e.message}`); process.exit(1); });
