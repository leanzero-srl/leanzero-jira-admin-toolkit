#!/usr/bin/env node
/**
 * AUDIT — for every staff group member, determine whether they are already a
 * customer of the JSM site (and/or already a licensed agent) BEFORE adding anyone.
 *
 * "Already a customer" is inferred from membership in the JSM customer-access
 * groups (this is what distinguished the org members JSM hides as already-covered):
 *   - jira-servicemanagement-customers-yoursite  (site default customer group)
 *   - servicedesk_users                        (staff service-desk access group)
 *   - Service Desk Customers
 * "Licensed agent" (internal, NOT a customer) is inferred from:
 *   - jira-servicedesk-users                      (JSM agent product-access group)
 *
 * Method: enumerate each group's membership once (cheap, paginated) and intersect
 * with our collected staff members — far cheaper than 1000+ per-user lookups.
 *
 * READ-ONLY. Writes out/customer_audit.csv and prints a summary.
 *
 * Usage: node audit_customers.js
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const JiraClient = require("./src/jiraClient");

const OUT_DIR = path.resolve(__dirname, "out");
const RESOLVED_FILE = path.join(OUT_DIR, "members_resolved.json");
const MEMBERS_FILE = path.join(OUT_DIR, "members.json");
const AUDIT_CSV = path.join(OUT_DIR, "customer_audit.csv");

const CUSTOMER_GROUPS = [
  "jira-servicemanagement-customers-yoursite",
  "servicedesk_users",
  "Service Desk Customers",
];
const AGENT_GROUP = "jira-servicedesk-users";

function csv(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function resolveGroupId(client, name) {
  const res = await client.request("GET", `/rest/api/3/group/bulk?groupName=${encodeURIComponent(name)}`);
  if (res.status >= 400) return null;
  const v = (res.data && res.data.values) || [];
  return v.length ? v[0].groupId : null;
}

async function enumerateGroupAccountIds(client, groupId, label) {
  const ids = new Set();
  let startAt = 0;
  const maxResults = 50;
  while (true) {
    const params = new URLSearchParams({ groupId, startAt: String(startAt), maxResults: String(maxResults), includeInactiveUsers: "true" });
    const res = await client.request("GET", `/rest/api/3/group/member?${params}`);
    if (res.status >= 400) throw new Error(`group/member ${label} -> ${res.status}`);
    const values = (res.data && res.data.values) || [];
    for (const u of values) if (u.accountId) ids.add(u.accountId);
    if (startAt % 1000 === 0 && startAt > 0) process.stdout.write(`\r  ${label}: ${ids.size} ...`);
    if ((res.data && res.data.isLast) || values.length === 0) break;
    startAt += values.length;
    if (startAt > 500000) break;
  }
  return ids;
}

async function main() {
  const baseUrl = process.env.CLOUD_BASE_URL;
  const apiToken = process.env.CLOUD_API_TOKEN;
  if (!baseUrl || !apiToken) {
    console.error("Missing CLOUD_BASE_URL / CLOUD_API_TOKEN in .env");
    process.exit(1);
  }
  const sourceFile = fs.existsSync(RESOLVED_FILE) ? RESOLVED_FILE : MEMBERS_FILE;
  if (!fs.existsSync(sourceFile)) {
    console.error("Run collect_members.js first.");
    process.exit(1);
  }
  const allMembers = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
  const members = allMembers.filter((m) => m.accountType === "atlassian" && m.accountId);
  console.log(`Auditing ${members.length} atlassian staff members against access groups...\n`);

  const client = new JiraClient(baseUrl, apiToken);

  // Resolve + enumerate each group.
  const custSets = {};
  for (const name of CUSTOMER_GROUPS) {
    const gid = await resolveGroupId(client, name);
    if (!gid) {
      console.log(`  ! group not found: ${name} (skipping)`);
      custSets[name] = new Set();
      continue;
    }
    custSets[name] = await enumerateGroupAccountIds(client, gid, name);
    process.stdout.write(`\r  ${name}: ${custSets[name].size} members\n`);
  }
  const agentGid = await resolveGroupId(client, AGENT_GROUP);
  const agentSet = agentGid ? await enumerateGroupAccountIds(client, agentGid, AGENT_GROUP) : new Set();
  process.stdout.write(`\r  ${AGENT_GROUP} (agents): ${agentSet.size} members\n`);

  // Classify each member.
  const header = ["accountId", "displayName", "email", "active", ...CUSTOMER_GROUPS.map((g) => g.replace(/[^a-z0-9]+/gi, "_")), "is_agent", "already_customer", "needs_adding"];
  const rows = [header.join(",")];
  let alreadyCustomer = 0, isAgent = 0, needsAdding = 0, agentAndNotCustomer = 0;
  const perGroup = Object.fromEntries(CUSTOMER_GROUPS.map((g) => [g, 0]));

  for (const m of members) {
    const inCust = CUSTOMER_GROUPS.map((g) => custSets[g].has(m.accountId));
    inCust.forEach((v, i) => { if (v) perGroup[CUSTOMER_GROUPS[i]]++; });
    const customer = inCust.some(Boolean);
    const agent = agentSet.has(m.accountId);
    const needs = !customer;
    if (customer) alreadyCustomer++;
    if (agent) isAgent++;
    if (needs) needsAdding++;
    if (agent && !customer) agentAndNotCustomer++;
    rows.push([
      m.accountId, m.displayName, m.emailAddress, m.active,
      ...inCust.map((v) => (v ? "yes" : "")),
      agent ? "yes" : "", customer ? "yes" : "", needs ? "yes" : "",
    ].map(csv).join(","));
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(AUDIT_CSV, rows.join("\n") + "\n");

  console.log("\n==================== CUSTOMER AUDIT ====================");
  console.log(`Atlassian group members audited:   ${members.length}`);
  console.log(`Already a customer (any cust group): ${alreadyCustomer}`);
  for (const g of CUSTOMER_GROUPS) console.log(`   in ${g}: ${perGroup[g]}`);
  console.log(`Licensed agents (jira-servicedesk-users): ${isAgent}`);
  console.log(`   ...of which NOT in any customer group: ${agentAndNotCustomer}`);
  console.log(`NOT a customer by any signal (needs adding): ${needsAdding}`);
  console.log("=======================================================");
  console.log(`Written: out/customer_audit.csv`);
  console.log(`API requests: ${client.requestCount} (rate-limit hits: ${client.rateLimitCount})`);
}

main().catch((e) => {
  console.error("\nFATAL:", e.message);
  process.exit(1);
});
