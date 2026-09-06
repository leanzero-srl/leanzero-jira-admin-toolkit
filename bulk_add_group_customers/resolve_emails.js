#!/usr/bin/env node
/**
 * Phase 2b — Resolve the emails that Jira's REST API hides.
 *
 * The Jira `group/member` endpoint returns emailAddress=null for accounts whose
 * profile visibility hides it (1106/1117 for the staff group). The Atlassian
 * **org admin** API (Bearer ORG_ADMIN_API_KEY) bypasses that for managed accounts.
 *
 * This script enumerates the whole org directory once
 * (POST /admin/v1/orgs/{orgId}/users/search, expand EMAIL) and builds an
 * accountId -> email map, then writes out/members_resolved.json with every member's
 * best-known email. add_customers.js automatically prefers that file.
 *
 * READ-ONLY: it only lists users. (The shared OrgAdminClient can suspend/delete,
 * but this script never calls those.)
 *
 * Resumable: the directory cursor is checkpointed to out/.dir_cursor.json; pass
 * --resume to continue a previous scan. Short-circuits once every target accountId
 * is resolved.
 *
 * Usage:
 *   node resolve_emails.js [--resume]
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

// Reuse the existing, battle-tested org admin client (no duplication).
const OrgAdminClient = require("../suspend_accounts_by_domain/src/orgAdminClient");

const OUT_DIR = path.resolve(__dirname, "out");
const MEMBERS_FILE = path.join(OUT_DIR, "members.json");
const RESOLVED_FILE = path.join(OUT_DIR, "members_resolved.json");
const CKPT_FILE = path.join(OUT_DIR, ".dir_cursor.json");
const PAGE = 100;

const RESUME = process.argv.includes("--resume");

async function main() {
  const orgId = process.env.ORG_ID;
  const apiKey = process.env.ORG_ADMIN_API_KEY;
  if (!orgId || !apiKey) {
    console.error("Missing ORG_ID / ORG_ADMIN_API_KEY in .env");
    process.exit(1);
  }
  if (!fs.existsSync(MEMBERS_FILE)) {
    console.error(`Missing ${MEMBERS_FILE}. Run \`node collect_members.js\` first.`);
    process.exit(1);
  }

  const members = JSON.parse(fs.readFileSync(MEMBERS_FILE, "utf8"));
  // Only need to resolve members whose Jira email is missing.
  const targets = new Set(
    members
      .filter((m) => !(m.emailAddress && m.emailAddress.trim()) && m.accountId)
      .map((m) => m.accountId),
  );
  console.log(`Members: ${members.length}. Need to resolve emails for ${targets.size} hidden accounts.`);

  const client = new OrgAdminClient({ apiKey, orgId, log: () => {} });
  const orgName = await client.testConnection();
  if (!orgName) {
    console.error("Org admin API connection failed (check ORG_ADMIN_API_KEY / ORG_ID).");
    process.exit(1);
  }
  console.log(`Org admin API connected: ${typeof orgName === "string" ? orgName : orgId}`);

  const apiPath = `/admin/v1/orgs/${encodeURIComponent(orgId)}/users/search`;
  const resolved = new Map(); // accountId -> email

  let cursor = null;
  let scanned = 0;
  let page = 0;
  if (RESUME && fs.existsSync(CKPT_FILE)) {
    const ck = JSON.parse(fs.readFileSync(CKPT_FILE, "utf8"));
    cursor = ck.cursor || null;
    scanned = ck.scanned || 0;
    console.log(`Resuming directory scan at cursor (scanned=${scanned})`);
  }

  while (true) {
    const body = { expand: ["EMAIL", "NAME"], limit: PAGE, ...(cursor ? { cursor } : {}) };
    let res;
    try {
      res = await client.makeRequest("POST", apiPath, body);
    } catch (e) {
      // Patient retry for the directory's intermittent 5xx on deep pages.
      if (e.statusCode === 504 || e.statusCode === 500) {
        console.log(`  page ${page} hit ${e.statusCode}, waiting 8s and retrying...`);
        await new Promise((r) => setTimeout(r, 8000));
        continue;
      }
      throw e;
    }
    const batch = res?.data || [];
    for (const u of batch) {
      scanned++;
      if (u.accountId && u.email && targets.has(u.accountId)) {
        resolved.set(u.accountId, u.email);
      }
    }
    page++;
    cursor = res?.links?.next || null;
    fs.writeFileSync(CKPT_FILE, JSON.stringify({ cursor, scanned }));
    if (page % 10 === 0 || !cursor) {
      console.log(`  scanned ${scanned} org users, resolved ${resolved.size}/${targets.size} targets ...`);
    }
    if (resolved.size >= targets.size) {
      console.log("  all targets resolved — stopping scan early.");
      break;
    }
    if (!cursor) break;
  }

  // Merge resolved emails back onto members.
  let added = 0;
  const out = members.map((m) => {
    const jiraEmail = m.emailAddress && m.emailAddress.trim() ? m.emailAddress : null;
    const orgEmail = resolved.get(m.accountId) || null;
    const email = jiraEmail || orgEmail;
    if (!jiraEmail && orgEmail) added++;
    return { ...m, emailAddress: email, emailSource: jiraEmail ? "jira" : orgEmail ? "org-admin" : null };
  });
  fs.writeFileSync(RESOLVED_FILE, JSON.stringify(out, null, 2));

  const withEmail = out.filter((m) => m.emailAddress).length;
  const stillMissing = out.filter((m) => !m.emailAddress);
  console.log("\n================ RESOLUTION REPORT ================");
  console.log(`Org users scanned:      ${scanned}`);
  console.log(`Emails added via org:   ${added}`);
  console.log(`Total now with email:   ${withEmail}/${out.length}`);
  console.log(`Still missing:          ${stillMissing.length}`);
  if (stillMissing.length) {
    const byType = {};
    for (const m of stillMissing) byType[m.accountType || "unknown"] = (byType[m.accountType || "unknown"] || 0) + 1;
    console.log(`  unresolved by type:   ${Object.entries(byType).map(([t, n]) => `${t}=${n}`).join(", ")}`);
    console.log(`  (likely unmanaged/external accounts not in the org directory)`);
  }
  console.log("===================================================");
  console.log(`Written: out/members_resolved.json  (add_customers.js will prefer this file)`);
  console.log(`Org API requests: ${client.getStats().requestCount} (rate-limit hits: ${client.getStats().rateLimitCount})`);
}

main().catch((e) => {
  console.error("\nFATAL:", e.message);
  process.exit(1);
});
