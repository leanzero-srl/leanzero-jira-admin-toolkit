#!/usr/bin/env node
/**
 * Add the collected group members to a SERVICE DESK PROJECT's customer list
 * (the .../projects/ITSM/customers page) via the "Add customers" endpoint:
 *   POST /rest/servicedeskapi/servicedesk/{serviceDeskId}/customer  { accountIds: [...] }
 *
 * This adds EXISTING accounts by accountId — no email, no invitation, not the
 * experimental invite endpoint. Success is 204. This is the right endpoint for
 * "make these people customers of ITSM" (vs /rest/servicedeskapi/customer, which
 * only creates instance-level customers and never touches a project).
 *
 * Defaults to DRY-RUN. Pass --send to actually add. Resumable: accountIds that
 * succeed are recorded in out/sd_progress.jsonl and skipped on re-run.
 *
 * Usage:
 *   node add_servicedesk_customers.js                       # dry-run, ITSM (41)
 *   node add_servicedesk_customers.js --send                # live
 *   node add_servicedesk_customers.js --send --limit 1      # add just 1 (smoke test)
 *   node add_servicedesk_customers.js --servicedesk 41      # override service desk id
 *   node add_servicedesk_customers.js --batch-size 50       # accountIds per request (default 50)
 *   node add_servicedesk_customers.js --include-app         # also add app/connect bot accounts
 *   node add_servicedesk_customers.js --include-inactive    # also add inactive accounts
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const JiraClient = require("./src/jiraClient");

const OUT_DIR = path.resolve(__dirname, "out");
const RESOLVED_FILE = path.join(OUT_DIR, "members_resolved.json");
const MEMBERS_FILE = path.join(OUT_DIR, "members.json");
const PROGRESS_FILE = path.join(OUT_DIR, "sd_progress.jsonl");
const SUMMARY_FILE = path.join(OUT_DIR, "sd_summary.json");

const flag = (n) => process.argv.includes(n);
function opt(n, d) {
  const i = process.argv.indexOf(n);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
}

const SEND = flag("--send");
const SERVICE_DESK_ID = opt("--servicedesk", "41"); // ITSM (IT Service Desk)
const BATCH_SIZE = Math.max(1, parseInt(opt("--batch-size", "50"), 10));
const LIMIT = opt("--limit", null) ? parseInt(opt("--limit"), 10) : null;
const INCLUDE_APP = flag("--include-app");
const INCLUDE_INACTIVE = flag("--include-inactive");

function loadDoneIds() {
  const done = new Set();
  if (!fs.existsSync(PROGRESS_FILE)) return done;
  for (const line of fs.readFileSync(PROGRESS_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.accountId && r.status === "added") done.add(r.accountId);
    } catch {
      /* ignore */
    }
  }
  return done;
}

function appendProgress(records) {
  fs.appendFileSync(PROGRESS_FILE, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function msgOf(res) {
  const d = res.data;
  if (!d) return "";
  if (typeof d === "string") return d.slice(0, 200);
  return (d.errorMessage || d.message || JSON.stringify(d)).slice(0, 200);
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function main() {
  const baseUrl = process.env.CLOUD_BASE_URL;
  const apiToken = process.env.CLOUD_API_TOKEN;
  if (!baseUrl || !apiToken) {
    console.error("Missing CLOUD_BASE_URL / CLOUD_API_TOKEN in .env");
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const client = new JiraClient(baseUrl, apiToken);

  const sourceFile = fs.existsSync(RESOLVED_FILE) ? RESOLVED_FILE : MEMBERS_FILE;
  if (!fs.existsSync(sourceFile)) {
    console.error(`Missing members file. Run \`node collect_members.js\` first.`);
    process.exit(1);
  }
  const members = JSON.parse(fs.readFileSync(sourceFile, "utf8"));

  // Filter: real people (atlassian) + active by default. accountId is all we need.
  const candidates = members.filter(
    (m) =>
      m.accountId &&
      (INCLUDE_INACTIVE || m.active) &&
      (INCLUDE_APP || m.accountType === "atlassian"),
  );
  const done = loadDoneIds();
  let pending = candidates.filter((m) => !done.has(m.accountId));
  if (LIMIT) pending = pending.slice(0, LIMIT);

  console.log("=========================================================");
  console.log(`Mode:          ${SEND ? "LIVE (--send)" : "DRY-RUN (no POST)"}`);
  console.log(`Target:        ${baseUrl}`);
  console.log(`Service desk:  ${SERVICE_DESK_ID}  (endpoint: POST /servicedesk/${SERVICE_DESK_ID}/customer)`);
  console.log(`Source:        ${path.basename(sourceFile)}`);
  console.log(`Filter:        accountType=${INCLUDE_APP ? "any" : "atlassian"}, ${INCLUDE_INACTIVE ? "active+inactive" : "active only"}`);
  console.log(`Candidates:    ${candidates.length}`);
  console.log(`Already added: ${candidates.length - candidates.filter((m) => !done.has(m.accountId)).length} (in sd_progress.jsonl)`);
  console.log(`To process:    ${pending.length}${LIMIT ? ` (capped by --limit ${LIMIT})` : ""}`);
  console.log(`Batch size:    ${BATCH_SIZE}`);
  console.log("=========================================================\n");

  if (pending.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  if (!SEND) {
    console.log(`Would POST accountIds in ${chunk(pending, BATCH_SIZE).length} batch(es) to /servicedesk/${SERVICE_DESK_ID}/customer. First few:`);
    for (const m of pending.slice(0, 10)) {
      console.log(`  ${m.accountId}  ${m.displayName || ""}${m.emailAddress ? `  <${m.emailAddress}>` : ""}`);
    }
    if (pending.length > 10) console.log(`  ... and ${pending.length - 10} more`);
    console.log(`\nDRY-RUN: nothing was sent. Re-run with --send.`);
    return;
  }

  const tally = { added: 0, failed: 0 };
  const batches = chunk(pending, BATCH_SIZE);

  // Add one batch; on a batch-level error, retry each id individually so a single
  // bad accountId doesn't take down the whole batch.
  async function addBatch(batchMembers) {
    const ids = batchMembers.map((m) => m.accountId);
    const res = await client.addCustomersToServiceDesk(SERVICE_DESK_ID, ids);
    if (res.status === 204 || res.status === 200) {
      const recs = batchMembers.map((m) => ({ accountId: m.accountId, email: m.emailAddress, status: "added", ts: new Date().toISOString() }));
      appendProgress(recs);
      tally.added += recs.length;
      return { ok: true };
    }
    if (res.status === 403) {
      throw new Error(`403 Forbidden — token lacks Service Desk Admin / Jira Admin permission on SD ${SERVICE_DESK_ID}. Aborting.`);
    }
    return { ok: false, status: res.status, detail: msgOf(res) };
  }

  let bi = 0;
  for (const batch of batches) {
    bi++;
    const result = await addBatch(batch);
    if (result.ok) {
      console.log(`[batch ${bi}/${batches.length}] ADDED ${batch.length}  (total added ${tally.added})`);
      continue;
    }
    // Batch failed — isolate by retrying each id individually.
    console.log(`[batch ${bi}/${batches.length}] batch failed (HTTP ${result.status}: ${result.detail}); retrying ${batch.length} individually...`);
    for (const m of batch) {
      const res = await client.addCustomersToServiceDesk(SERVICE_DESK_ID, [m.accountId]);
      if (res.status === 204 || res.status === 200) {
        appendProgress([{ accountId: m.accountId, email: m.emailAddress, status: "added", ts: new Date().toISOString() }]);
        tally.added++;
      } else {
        appendProgress([{ accountId: m.accountId, email: m.emailAddress, status: "failed", httpStatus: res.status, detail: msgOf(res), ts: new Date().toISOString() }]);
        tally.failed++;
        console.log(`    FAIL ${m.accountId} ${m.emailAddress || ""} -> HTTP ${res.status}: ${msgOf(res)}`);
      }
    }
  }

  const summary = {
    target: baseUrl,
    serviceDeskId: SERVICE_DESK_ID,
    when: new Date().toISOString(),
    tally,
    apiRequests: client.requestCount,
    rateLimitHits: client.rateLimitCount,
  };
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));

  console.log("\n===================== SUMMARY =====================");
  console.log(`added:  ${tally.added}`);
  console.log(`failed: ${tally.failed}`);
  console.log(`API requests: ${client.requestCount} (rate-limit hits: ${client.rateLimitCount})`);
  console.log(`Progress: out/sd_progress.jsonl   Summary: out/sd_summary.json`);
  console.log("==================================================");
}

main().catch((e) => {
  console.error("\nFATAL:", e.message);
  process.exit(1);
});
