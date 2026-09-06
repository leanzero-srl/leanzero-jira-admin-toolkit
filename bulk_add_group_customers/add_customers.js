#!/usr/bin/env node
/**
 * Phase 3 — Add collected members as JSM customers via POST /rest/servicedeskapi/customer.
 *
 * Defaults to DRY-RUN (prints what it would send, POSTs nothing). Pass --send to
 * actually create. Resumable: every outcome is appended to out/progress.jsonl and
 * re-runs skip emails already recorded with a terminal status.
 *
 * Usage:
 *   node add_customers.js                       # dry-run, all active members with an email
 *   node add_customers.js --send                # live run
 *   node add_customers.js --send --limit 1      # create just the first candidate (smoke test)
 *   node add_customers.js --send --email a@b.com [--name "A B"]   # create a single ad-hoc address
 *   node add_customers.js --include-inactive     # also include inactive accounts
 *   node add_customers.js --concurrency 4        # tune parallelism (default 4)
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const JiraClient = require("./src/jiraClient");

const OUT_DIR = path.resolve(__dirname, "out");
const MEMBERS_FILE = path.join(OUT_DIR, "members.json");
const RESOLVED_FILE = path.join(OUT_DIR, "members_resolved.json");
const PROGRESS_FILE = path.join(OUT_DIR, "progress.jsonl");
const SUMMARY_FILE = path.join(OUT_DIR, "summary.json");

const flag = (name) => process.argv.includes(name);
function opt(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SEND = flag("--send");
const INCLUDE_INACTIVE = flag("--include-inactive");
const LIMIT = opt("--limit", null) ? parseInt(opt("--limit"), 10) : null;
const CONCURRENCY = Math.max(1, parseInt(opt("--concurrency", "4"), 10));
const AD_HOC_EMAIL = opt("--email", null);
const AD_HOC_NAME = opt("--name", null);

/** Load the set of emails already attempted with a terminal outcome. */
function loadDoneEmails() {
  const done = new Map(); // email(lowercased) -> last status
  if (!fs.existsSync(PROGRESS_FILE)) return done;
  for (const line of fs.readFileSync(PROGRESS_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.email && ["created", "exists", "invalid"].includes(rec.status)) {
        done.set(rec.email.toLowerCase(), rec.status);
      }
    } catch {
      /* ignore malformed line */
    }
  }
  return done;
}

function appendProgress(rec) {
  fs.appendFileSync(PROGRESS_FILE, JSON.stringify(rec) + "\n");
}

/** Map an HTTP response from createCustomer to a normalized status. */
function classify(res) {
  if (res.status === 201) return { status: "created", detail: res.data && res.data.accountId };
  if (res.status === 409) return { status: "exists", detail: "already a customer/account" };
  if (res.status === 400) {
    // strictConflictStatusCode should route dup -> 409, so a 400 here is a real
    // bad request (e.g. malformed email). Surface the message.
    return { status: "invalid", detail: msgOf(res) };
  }
  if (res.status === 403) return { status: "forbidden", detail: msgOf(res) };
  return { status: "error", detail: `HTTP ${res.status}: ${msgOf(res)}` };
}

function msgOf(res) {
  const d = res.data;
  if (!d) return "";
  if (typeof d === "string") return d.slice(0, 200);
  return (d.errorMessage || d.message || JSON.stringify(d)).slice(0, 200);
}

/** Simple bounded-concurrency runner. */
async function runPool(items, worker, concurrency) {
  let idx = 0;
  const runNext = async () => {
    while (idx < items.length) {
      const myIdx = idx++;
      await worker(items[myIdx], myIdx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runNext));
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

  // Build the candidate list.
  let candidates;
  if (AD_HOC_EMAIL) {
    candidates = [{ emailAddress: AD_HOC_EMAIL, displayName: AD_HOC_NAME || AD_HOC_EMAIL, accountId: "(ad-hoc)", active: true }];
  } else {
    // Prefer the org-admin-resolved file (has emails recovered past Jira privacy).
    const sourceFile = fs.existsSync(RESOLVED_FILE) ? RESOLVED_FILE : MEMBERS_FILE;
    if (!fs.existsSync(sourceFile)) {
      console.error(`Missing ${MEMBERS_FILE}. Run \`node collect_members.js\` first.`);
      process.exit(1);
    }
    console.log(`Source: ${path.basename(sourceFile)}`);
    const members = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
    candidates = members.filter(
      (m) => m.emailAddress && m.emailAddress.trim() && (INCLUDE_INACTIVE || m.active),
    );
  }

  // Skip emails already done (resume).
  const done = loadDoneEmails();
  const pending = candidates.filter((c) => !done.has(c.emailAddress.toLowerCase()));
  const ordered = LIMIT ? pending.slice(0, LIMIT) : pending;

  console.log("=========================================================");
  console.log(`Mode:          ${SEND ? "LIVE (--send)" : "DRY-RUN (no POST)"}`);
  console.log(`Target:        ${baseUrl}`);
  console.log(`Candidates:    ${candidates.length}  (active${INCLUDE_INACTIVE ? "+inactive" : " only"}, with email)`);
  console.log(`Already done:  ${candidates.length - pending.length} (in progress.jsonl)`);
  console.log(`To process:    ${ordered.length}${LIMIT ? ` (capped by --limit ${LIMIT})` : ""}`);
  console.log(`Concurrency:   ${CONCURRENCY}`);
  console.log("=========================================================\n");

  if (ordered.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  if (!SEND) {
    const preview = ordered.slice(0, 10);
    console.log("Would POST /rest/servicedeskapi/customer?strictConflictStatusCode=true with:");
    for (const c of preview) {
      console.log(`  { email: ${JSON.stringify(c.emailAddress)}, displayName: ${JSON.stringify(c.displayName || c.emailAddress)} }`);
    }
    if (ordered.length > preview.length) console.log(`  ... and ${ordered.length - preview.length} more`);
    console.log(`\nDRY-RUN: nothing was sent. Re-run with --send to create these customers.`);
    return;
  }

  const tally = { created: 0, exists: 0, invalid: 0, forbidden: 0, error: 0 };
  let processed = 0;

  await runPool(
    ordered,
    async (c) => {
      const email = c.emailAddress.trim();
      const displayName = c.displayName || email;
      let result;
      try {
        const res = await client.createCustomer(email, displayName);
        result = classify(res);
      } catch (e) {
        result = { status: "error", detail: e.message };
      }
      tally[result.status] = (tally[result.status] || 0) + 1;
      appendProgress({
        email,
        accountId: c.accountId,
        status: result.status,
        detail: result.detail,
        ts: new Date().toISOString(),
      });
      processed++;
      const tag = result.status.toUpperCase().padEnd(9);
      console.log(`[${String(processed).padStart(4)}/${ordered.length}] ${tag} ${email}${result.detail ? `  (${result.detail})` : ""}`);

      // A 403 means the token lacks Jira-admin global permission — abort early,
      // every subsequent call would fail identically.
      if (result.status === "forbidden") {
        throw new Error(`403 Forbidden creating ${email}. Token likely lacks Jira Administrator Global permission. Aborting.`);
      }
    },
    CONCURRENCY,
  );

  const summary = {
    target: baseUrl,
    when: new Date().toISOString(),
    processedThisRun: processed,
    tally,
    apiRequests: client.requestCount,
    rateLimitHits: client.rateLimitCount,
  };
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));

  console.log("\n===================== SUMMARY =====================");
  console.log(`created:   ${tally.created}`);
  console.log(`exists:    ${tally.exists}   (409 — already a customer/account)`);
  console.log(`invalid:   ${tally.invalid}  (400 — bad email/request)`);
  console.log(`forbidden: ${tally.forbidden}`);
  console.log(`error:     ${tally.error}`);
  console.log(`API requests: ${client.requestCount} (rate-limit hits: ${client.rateLimitCount})`);
  console.log(`Progress log: out/progress.jsonl   Summary: out/summary.json`);
  console.log("==================================================");
}

main().catch((e) => {
  console.error("\nFATAL:", e.message);
  process.exit(1);
});
