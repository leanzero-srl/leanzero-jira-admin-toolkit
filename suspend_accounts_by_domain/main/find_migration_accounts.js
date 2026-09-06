#!/usr/bin/env node

/**
 * READ-ONLY discovery: find every org account whose EMAIL (or display name)
 * contains "_migration", anywhere in any domain, and flag it.
 *
 * Why a filterless full scan: the server-side `*.contains` substring filters do
 * an unindexed scan and 504 on a directory this size. So we page the plain user
 * listing and match client-side. NO suspend/remove calls are made — output is a
 * live list + CSV for review before any action.
 *
 * Resilience (this org's listing 504s on deep pagination):
 *   - small page size (default 500) keeps each request under the gateway timeout
 *   - each page has its own retry/backoff on top of OrgAdminClient's
 *   - flagged rows are appended to the CSV as they're found (never lost)
 *   - the pagination cursor is checkpointed every page; --resume continues from it
 *
 * Usage:
 *   node main/find_migration_accounts.js [--needle=_migration] [--page=500] [--resume]
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const OrgAdminClient = require("../src/orgAdminClient");

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const NEEDLE = arg("needle", "_migration");
const PAGE = parseInt(arg("page", "500"), 10) || 500;
const RESUME = process.argv.includes("--resume");

const logDir = path.join(__dirname, "../logs");
const csvPath = path.join(logDir, "migration_flagged.csv");
const ckptPath = path.join(logDir, "migration_flagged.checkpoint.json");
const CSV_HEADER = "accountId,email,name,accountType,accountStatus,suspended,matchedOn\n";

const esc = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function fetchPage(client, apiPath, cursor) {
  const body = {
    expand: ["EMAIL", "NAME", "EMAIL_VERIFIED"],
    limit: PAGE,
    ...(cursor ? { cursor } : {}),
  };
  // OrgAdminClient already retries 504 3x; wrap with a few more patient attempts
  // because deep pages on this directory intermittently exhaust those.
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await client.makeRequest("POST", apiPath, body);
    } catch (e) {
      lastErr = e;
      if (e.statusCode !== 504 && e.statusCode !== 500) throw e;
      const wait = Math.min(5000 * (attempt + 1), 30000);
      console.log(`  page retry ${attempt + 1}/5 after ${e.statusCode}, waiting ${wait / 1000}s...`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function main() {
  const orgId = process.env.ORG_ID;
  const apiKey = process.env.ORG_ADMIN_API_KEY;
  if (!orgId || !apiKey) {
    console.error("Missing ORG_ID or ORG_ADMIN_API_KEY in .env");
    process.exit(1);
  }
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  const client = new OrgAdminClient({ apiKey, orgId, log: console.log });
  const apiPath = `/admin/v1/orgs/${encodeURIComponent(orgId)}/users/search`;
  const needleLc = NEEDLE.toLowerCase();

  console.log("==================================================");
  console.log(`Flagging accounts whose email/name contains "${NEEDLE}"  (READ-ONLY)`);
  console.log("==================================================");
  console.log(`  Org ID: ${orgId}   page size: ${PAGE}   resume: ${RESUME}`);
  console.log("");

  const orgName = await client.testConnection();
  if (!orgName) {
    console.error("Cannot reach Atlassian Org Admin API. Check ORG_ADMIN_API_KEY / ORG_ID.");
    process.exit(1);
  }
  console.log(`Org Admin API: OK (org=${orgName})\n`);

  // Resume state
  let cursor = null;
  let scanned = 0;
  let flagged = 0;
  const seen = new Set();
  if (RESUME && fs.existsSync(ckptPath)) {
    const ck = JSON.parse(fs.readFileSync(ckptPath, "utf8"));
    cursor = ck.cursor || null;
    scanned = ck.scanned || 0;
    flagged = ck.flagged || 0;
    if (Array.isArray(ck.seen)) ck.seen.forEach((id) => seen.add(id));
    console.log(`Resuming: scanned=${scanned} flagged=${flagged} cursor=${cursor ? "set" : "none"}\n`);
  }
  if (!RESUME || !fs.existsSync(csvPath)) {
    fs.writeFileSync(csvPath, CSV_HEADER);
  }

  console.log("Listing all org users, matching client-side...");
  let page = 0;
  while (true) {
    const res = await fetchPage(client, apiPath, cursor);
    const batch = res?.data || [];
    page++;
    for (const u of batch) {
      scanned++;
      const email = (u.email || "").toLowerCase();
      const name = (u.name || "").toLowerCase();
      const inEmail = email.includes(needleLc);
      const inName = name.includes(needleLc);
      if ((!inEmail && !inName) || seen.has(u.accountId)) continue;
      seen.add(u.accountId);
      flagged++;
      const matchedOn = [inEmail && "email", inName && "name"].filter(Boolean).join("+");
      const row = [
        u.accountId,
        u.email || "(hidden)",
        u.name || "",
        u.accountType,
        u.accountStatus,
        u.isSuspended === true ? "yes" : "",
        matchedOn,
      ];
      fs.appendFileSync(csvPath, row.map(esc).join(",") + "\n");
      console.log(`  FLAG  ${String(u.email || "(hidden)").padEnd(44)} ${String(u.name || "").padEnd(26)} ${u.accountStatus}${u.isSuspended ? " [SUSPENDED]" : ""}`);
    }

    cursor = res?.links?.next || null;
    fs.writeFileSync(ckptPath, JSON.stringify({ cursor, scanned, flagged, seen: [...seen] }));
    if (page % 10 === 0) console.log(`  ...scanned ${scanned}, flagged ${flagged}`);
    if (!cursor) break;
  }

  console.log("\n" + "=".repeat(90));
  console.log(`DONE. Scanned ${scanned} accounts, flagged ${flagged} containing "${NEEDLE}".`);
  console.log(`CSV: ${csvPath}`);
  const stats = client.getStats();
  console.log(`API requests: ${stats.requestCount} (${stats.errorCount} errors, ${stats.rateLimitCount} rate limits)`);
  console.log("No accounts were modified (read-only). Review the CSV before suspending.");
  // success -> drop the checkpoint so a future run starts clean
  try { fs.unlinkSync(ckptPath); } catch {}
}

main().catch((e) => {
  console.error(`\nFatal: ${e.message}`);
  console.error("Progress is checkpointed — re-run with --resume to continue from the last page.");
  process.exit(1);
});
