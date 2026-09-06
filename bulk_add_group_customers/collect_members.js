#!/usr/bin/env node
/**
 * Phase 1+2 — Collect members of the "staff" group and report how many
 * email addresses we can actually resolve.
 *
 * Writes:
 *   out/members.json  — full member records
 *   out/members.csv   — accountId,accountType,active,displayName,emailAddress
 *
 * The printed feasibility report is the GO/NO-GO gate: if emailAddress is null
 * for a large share of members, Atlassian privacy is hiding them and a normal
 * admin token can't recover them (you'd need the org-admin Directory API). Do
 * NOT proceed to add_customers.js until the resolution rate is acceptable.
 *
 * Usage:
 *   node collect_members.js [--group <groupId>]
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const JiraClient = require("./src/jiraClient");

const DEFAULT_GROUP_ID = "00000000-0000-0000-0000-00000000g001"; // staff

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function csvField(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const baseUrl = process.env.CLOUD_BASE_URL;
  const apiToken = process.env.CLOUD_API_TOKEN;
  if (!baseUrl || !apiToken) {
    console.error("Missing CLOUD_BASE_URL / CLOUD_API_TOKEN in .env");
    process.exit(1);
  }
  const groupId = arg("--group", DEFAULT_GROUP_ID);
  const outDir = path.resolve(__dirname, "out");
  fs.mkdirSync(outDir, { recursive: true });

  const client = new JiraClient(baseUrl, apiToken);

  // Auth sanity check.
  const me = await client.whoami();
  if (me.status >= 400) {
    console.error(`Auth check failed (${me.status}). Check CLOUD_API_TOKEN. Body: ${JSON.stringify(me.data).slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`Authenticated as: ${me.data.displayName} <${me.data.emailAddress || "email hidden"}> on ${baseUrl}`);
  console.log(`Fetching members of group ${groupId} ...`);

  const members = await client.getGroupMembers(groupId, {
    includeInactive: true,
    onPage: (count, total) =>
      process.stdout.write(`\r  fetched ${count}${total ? `/${total}` : ""} members ...`),
  });
  process.stdout.write("\n");

  // Write outputs.
  fs.writeFileSync(path.join(outDir, "members.json"), JSON.stringify(members, null, 2));
  const header = "accountId,accountType,active,displayName,emailAddress";
  const rows = members.map((m) =>
    [m.accountId, m.accountType, m.active, m.displayName, m.emailAddress]
      .map(csvField)
      .join(","),
  );
  fs.writeFileSync(path.join(outDir, "members.csv"), [header, ...rows].join("\n") + "\n");

  // Feasibility report.
  const total = members.length;
  const withEmail = members.filter((m) => m.emailAddress && m.emailAddress.trim()).length;
  const withoutEmail = total - withEmail;
  const activeWithEmail = members.filter(
    (m) => m.active && m.emailAddress && m.emailAddress.trim(),
  ).length;

  const byType = {};
  for (const m of members) {
    const t = m.accountType || "unknown";
    byType[t] = byType[t] || { total: 0, withEmail: 0 };
    byType[t].total++;
    if (m.emailAddress && m.emailAddress.trim()) byType[t].withEmail++;
  }

  console.log("\n================ FEASIBILITY REPORT ================");
  console.log(`Group:                 ${groupId}`);
  console.log(`Total members:         ${total}`);
  console.log(`With email resolved:   ${withEmail}  (${total ? ((withEmail / total) * 100).toFixed(1) : 0}%)`);
  console.log(`Email hidden/null:     ${withoutEmail}`);
  console.log(`Active AND has email:  ${activeWithEmail}  <- candidates for add_customers.js`);
  console.log("By accountType:");
  for (const [t, s] of Object.entries(byType)) {
    console.log(`  ${t.padEnd(12)} total ${String(s.total).padStart(5)}   withEmail ${String(s.withEmail).padStart(5)}`);
  }
  console.log("====================================================");
  console.log(`\nWritten: out/members.json, out/members.csv`);
  if (withoutEmail > 0) {
    console.log(
      `\n⚠  ${withoutEmail} member(s) have no resolvable email (Atlassian privacy). ` +
        `These cannot be added by email with the current token. Review before proceeding.`,
    );
  }
  console.log(`API requests: ${client.requestCount} (rate-limit hits: ${client.rateLimitCount})`);
}

main().catch((e) => {
  console.error("\nFATAL:", e.message);
  process.exit(1);
});
