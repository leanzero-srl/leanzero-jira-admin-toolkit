#!/usr/bin/env node
"use strict";

/**
 * remove_solo_member_teams
 * -------------------------
 * Find every Atlassian Team in an org whose *single sole member* is a given
 * person (default: "Jane Doe") and delete those teams.
 *
 * Two phases, like the rest of our Jira scripts:
 *   PLAN  (default / --plan-only)  read-only: list teams, find the ones whose
 *                                  only member is the target, write a CSV + plan
 *                                  JSON. Nothing is mutated.
 *   APPLY (--apply)                delete the teams the plan flagged. Each team
 *                                  is re-checked at delete time so a stale plan
 *                                  can never delete a team that has since gained
 *                                  members or changed its sole member.
 *
 * Identity matching: by default a team matches when its sole member's Jira
 * display name equals TARGET_NAME exactly (case-insensitive). This intentionally
 * captures BOTH "Jane Doe" accounts on the site (a person can hold two) while
 * never matching "Jane Doerr" or similar. Supplying explicit
 * TARGET_ACCOUNT_IDS switches to precise accountId-only matching.
 */

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const TeamsClient = require("../src/teamsClient");

const LOG_DIR = path.join(__dirname, "..", "logs");

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {
    apply: false,
    dryRun: false,
    planOnly: false,
    resume: false,
    planFile: null,
    targetName: null,
    targetAccountIds: null,
    limit: 0,
    concurrency: 6,
    siteUrl: null,
    orgId: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--apply": args.apply = true; break;
      case "--dry-run": args.dryRun = true; break;
      case "--plan-only": args.planOnly = true; break;
      case "--resume":
      case "--execute-only": args.resume = true; break;
      case "--plan-file": args.planFile = next(); break;
      case "--target-name": args.targetName = next(); break;
      case "--target-account-ids": args.targetAccountIds = next(); break;
      case "--limit": args.limit = parseInt(next(), 10) || 0; break;
      case "--concurrency": args.concurrency = parseInt(next(), 10) || 6; break;
      case "--site-url": args.siteUrl = next(); break;
      case "--org-id": args.orgId = next(); break;
      case "-h":
      case "--help": printHelp(); process.exit(0);
      default:
        console.error(`Unknown argument: ${a}`);
        printHelp();
        process.exit(1);
    }
  }
  return args;
}

function printHelp() {
  console.log(`
remove_solo_member_teams — delete Atlassian Teams whose sole member is the target

Usage:
  node main/remove_solo_member_teams.js [flags]

Phases:
  (no flag) / --plan-only   PLAN: read-only discovery, writes CSV + plan JSON
  --apply                   APPLY: delete the flagged teams (re-verified per team)
  --apply --dry-run         APPLY dry run: log deletions but call nothing
  --apply --resume          APPLY from an existing plan (skip re-discovery)

Flags:
  --plan-file <path>        plan JSON to resume from (default: latest in logs/)
  --target-name <str>       display name to match (default: env TARGET_NAME)
  --target-account-ids <csv>  match these accountIds exactly (overrides name match)
  --limit <n>               only scan the first N teams (testing)
  --concurrency <n>         parallel member lookups during discovery (default 6)
  --site-url <url>          Jira site base url (default: env SITE_BASE_URL)
  --org-id <uuid>           org id (default: env ORG_ID)
`);
}

// --------------------------------------------------------------------------
// Logging
// --------------------------------------------------------------------------
function makeLogger(ts) {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, `run_${ts}.log`);
  const stream = fs.createWriteStream(file, { flags: "a" });
  const log = (...parts) => {
    const line = parts.join(" ");
    process.stdout.write(line + "\n");
    stream.write(line + "\n");
  };
  return { log, file };
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// --------------------------------------------------------------------------
// Small concurrency pool
// --------------------------------------------------------------------------
async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

// --------------------------------------------------------------------------
// CSV helpers
// --------------------------------------------------------------------------
function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

function writeCsv(filePath, headers, rows) {
  const lines = [headers.map(csvCell).join(",")];
  for (const r of rows) lines.push(headers.map((h) => csvCell(r[h])).join(","));
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
}

// --------------------------------------------------------------------------
// Identity resolution
// --------------------------------------------------------------------------
async function resolveTargets(client, targetName, explicitIdsCsv, log) {
  if (explicitIdsCsv && explicitIdsCsv.trim()) {
    const ids = explicitIdsCsv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    log(`Target mode: explicit accountIds (${ids.length}) — name fallback OFF`);
    return { targetAccountIds: new Set(ids), targetName, nameMatchEnabled: false };
  }

  log(`Target mode: display name === "${targetName}" (case-insensitive)`);
  const matches = await client.searchSiteUsers(targetName, 50);
  const wanted = targetName.trim().toLowerCase();
  const exact = matches.filter(
    (u) => (u.displayName || "").trim().toLowerCase() === wanted,
  );
  const ids = new Set(exact.map((u) => u.accountId));
  if (exact.length === 0) {
    log(`  WARNING: no site user found with display name "${targetName}".`);
    log(`  Name-match will still apply per-team, but pre-seeded id set is empty.`);
  } else {
    log(`  Resolved ${exact.length} account(s) named "${targetName}":`);
    for (const u of exact) {
      log(`    - ${u.accountId}  ${u.displayName}  <${u.emailAddress || "email hidden"}>`);
    }
  }
  // Note any near-misses so the operator can sanity-check the name.
  const near = matches.filter((u) => !ids.has(u.accountId));
  if (near.length) {
    log(`  (Ignored ${near.length} non-exact name match(es), e.g. ${near
      .slice(0, 3)
      .map((u) => `"${u.displayName}"`)
      .join(", ")})`);
  }
  return { targetAccountIds: ids, targetName, nameMatchEnabled: true };
}

// --------------------------------------------------------------------------
// Phase 1: discovery
// --------------------------------------------------------------------------
async function discover(client, targets, opts, log) {
  log("\n=== PLAN: scanning teams ===");
  const teams = [];
  for await (const t of client.listTeams()) {
    teams.push(t);
    if (opts.limit && teams.length >= opts.limit) break;
  }
  log(`Listed ${teams.length} team(s)${opts.limit ? ` (limited to ${opts.limit})` : ""}.`);

  const userCache = new Map();
  const resolveUser = async (accountId) => {
    if (userCache.has(accountId)) return userCache.get(accountId);
    const u = await client.getSiteUser(accountId);
    userCache.set(accountId, u);
    return u;
  };

  let scanned = 0;
  const records = await runPool(
    teams,
    async (t) => {
      const rec = {
        teamId: t.teamId,
        displayName: t.displayName || "",
        teamType: t.teamType || "",
        state: t.state || "",
        externalSource: t.externalReference?.source || "",
        memberCount: "",
        soleMemberAccountId: "",
        soleMemberName: "",
        soleMemberEmail: "",
        match: false,
        plannedAction: "skip",
        reason: "",
        status: "pending",
      };
      try {
        const m = await client.getMembershipSummary(t.teamId);
        if (m.count === 0) {
          rec.memberCount = "0";
          rec.reason = "no-members";
        } else if (m.count === 1) {
          rec.memberCount = "1";
          rec.soleMemberAccountId = m.soleAccountId;
          const u = await resolveUser(m.soleAccountId);
          rec.soleMemberName = u?.displayName || "(unresolved)";
          rec.soleMemberEmail = u?.emailAddress || "";
          const byId = targets.targetAccountIds.has(m.soleAccountId);
          const byName =
            targets.nameMatchEnabled &&
            (u?.displayName || "").trim().toLowerCase() ===
              targets.targetName.trim().toLowerCase();
          if (byId || byName) {
            rec.match = true;
            rec.plannedAction = "delete";
            rec.reason = byId ? "sole-member-accountId-match" : "sole-member-name-match";
          } else {
            rec.reason = "sole-member-not-target";
          }
        } else {
          rec.memberCount = "2+";
          rec.reason = "multiple-members";
        }
      } catch (err) {
        rec.reason = `error:${err.message}`;
        rec.status = "error";
        log(`  ! ${t.displayName} (${t.teamId}): ${err.message}`);
      }
      scanned++;
      if (scanned % 25 === 0) log(`  ...scanned ${scanned}/${teams.length}`);
      return rec;
    },
    opts.concurrency,
  );

  return records;
}

// --------------------------------------------------------------------------
// Phase 2: apply (delete)
// --------------------------------------------------------------------------
async function apply(client, plan, targets, opts, log) {
  const candidates = Object.values(plan.teams).filter(
    (r) => r.plannedAction === "delete" && r.status !== "deleted",
  );
  log(`\n=== APPLY: ${candidates.length} team(s) to delete${opts.dryRun ? " (DRY RUN)" : ""} ===`);

  let deleted = 0,
    skipped = 0,
    failed = 0;

  for (const rec of candidates) {
    // Re-verify the team STILL has exactly one member and it is still the
    // target, right before deleting. Protects against a stale plan.
    let summary;
    try {
      summary = await client.getMembershipSummary(rec.teamId);
    } catch (err) {
      rec.status = "failed";
      rec.reason = `reverify-error:${err.message}`;
      failed++;
      log(`  ! ${rec.displayName} (${rec.teamId}): re-verify failed: ${err.message}`);
      continue;
    }

    if (summary.count !== 1) {
      rec.status = "skipped";
      rec.reason = `changed-since-plan:member-count-now-${summary.count === 2 ? "2+" : summary.count}`;
      skipped++;
      log(`  ~ SKIP ${rec.displayName} (${rec.teamId}): now has ${rec.reason}`);
      continue;
    }

    const soleId = summary.soleAccountId;
    let stillTarget = targets.targetAccountIds.has(soleId);
    if (!stillTarget && targets.nameMatchEnabled) {
      const u = await client.getSiteUser(soleId);
      stillTarget =
        (u?.displayName || "").trim().toLowerCase() ===
        targets.targetName.trim().toLowerCase();
    }
    if (!stillTarget) {
      rec.status = "skipped";
      rec.reason = `changed-since-plan:sole-member-now-${soleId}`;
      skipped++;
      log(`  ~ SKIP ${rec.displayName} (${rec.teamId}): sole member changed`);
      continue;
    }

    if (opts.dryRun) {
      log(`  [dry-run] would delete team "${rec.displayName}" (${rec.teamId}) — sole member ${rec.soleMemberName} <${rec.soleMemberEmail || "hidden"}>`);
      rec.status = "dry-run";
      continue;
    }

    try {
      const res = await client.deleteTeam(rec.teamId);
      rec.status = "deleted";
      rec.reason = res.alreadyGone ? "deleted(404-idempotent)" : "deleted";
      deleted++;
      log(`  ✓ deleted "${rec.displayName}" (${rec.teamId})`);
    } catch (err) {
      rec.status = "failed";
      rec.reason = `delete-error:${err.message}`;
      failed++;
      log(`  ✗ FAILED "${rec.displayName}" (${rec.teamId}): ${err.message}`);
    }
    savePlan(plan); // persist after each delete for resumability
  }

  log(`\nApply summary: deleted=${deleted} skipped=${skipped} failed=${failed} dryRun=${opts.dryRun}`);
  return { deleted, skipped, failed };
}

// --------------------------------------------------------------------------
// Plan persistence
// --------------------------------------------------------------------------
function savePlan(plan) {
  fs.writeFileSync(plan._path, JSON.stringify(plan, null, 2));
}

function loadLatestPlan(explicit) {
  let file = explicit;
  if (!file) {
    const candidates = fs
      .readdirSync(LOG_DIR)
      .filter((f) => f.startsWith("plan_") && f.endsWith(".json"))
      .sort();
    if (!candidates.length) throw new Error("No plan_*.json found in logs/ to resume from.");
    file = path.join(LOG_DIR, candidates[candidates.length - 1]);
  }
  const plan = JSON.parse(fs.readFileSync(file, "utf8"));
  plan._path = file;
  return plan;
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);
  const ts = nowStamp();
  const { log, file: logFile } = makeLogger(ts);

  const email = process.env.ATLASSIAN_EMAIL;
  const apiToken = process.env.ATLASSIAN_API_TOKEN;
  const orgId = args.orgId || process.env.ORG_ID;
  const siteBaseUrl = args.siteUrl || process.env.SITE_BASE_URL;
  const targetName = args.targetName || process.env.TARGET_NAME || "Jane Doe";
  const explicitIds = args.targetAccountIds || process.env.TARGET_ACCOUNT_IDS || "";

  if (!email || !apiToken || !orgId) {
    console.error("Missing ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN / ORG_ID (env or flags).");
    process.exit(1);
  }

  log("==================================================================");
  log(`remove_solo_member_teams   ${new Date().toISOString()}`);
  log(`  org:        ${orgId}`);
  log(`  site:       ${siteBaseUrl || "(none — names will be unresolved)"}`);
  log(`  target:     "${targetName}"${explicitIds ? "  (+explicit accountIds)" : ""}`);
  log(`  phase:      ${args.apply ? (args.dryRun ? "APPLY (dry-run)" : "APPLY") : "PLAN (read-only)"}`);
  log(`  log file:   ${logFile}`);
  log("==================================================================");

  const client = new TeamsClient({ email, apiToken, orgId, siteBaseUrl, log });

  log("Testing connection / auth ...");
  await client.testConnection();
  log("  auth OK.");

  const targets = await resolveTargets(client, targetName, explicitIds, log);

  // --- APPLY from an existing plan (resume) ---
  if (args.apply && args.resume) {
    const plan = loadLatestPlan(args.planFile);
    log(`Resuming from plan: ${plan._path}`);
    // Re-hydrate target set from the plan meta so resume needs no re-search.
    if (plan.meta?.targetAccountIds)
      targets.targetAccountIds = new Set(plan.meta.targetAccountIds);
    if (typeof plan.meta?.nameMatchEnabled === "boolean")
      targets.nameMatchEnabled = plan.meta.nameMatchEnabled;
    await apply(client, plan, targets, args, log);
    savePlan(plan);
    return finish(client, log);
  }

  // --- Fresh discovery (PLAN) ---
  const records = await discover(client, targets, args, log);

  const plan = {
    _path: path.join(LOG_DIR, `plan_${ts}.json`),
    meta: {
      generatedAt: new Date().toISOString(),
      orgId,
      siteBaseUrl,
      targetName,
      nameMatchEnabled: targets.nameMatchEnabled,
      targetAccountIds: Array.from(targets.targetAccountIds),
      totalTeams: records.length,
    },
    teams: {},
  };
  for (const r of records) plan.teams[r.teamId] = r;

  // Write outputs
  const csvPath = path.join(LOG_DIR, `teams_scan_${ts}.csv`);
  const headers = [
    "teamId", "displayName", "teamType", "state", "externalSource",
    "memberCount", "soleMemberAccountId", "soleMemberName", "soleMemberEmail",
    "match", "plannedAction", "reason", "status",
  ];
  writeCsv(csvPath, headers, records);
  savePlan(plan);

  const matched = records.filter((r) => r.match);
  log("\n=== PLAN SUMMARY ===");
  log(`  teams scanned:        ${records.length}`);
  log(`  0 members:            ${records.filter((r) => r.memberCount === "0").length}`);
  log(`  exactly 1 member:     ${records.filter((r) => r.memberCount === "1").length}`);
  log(`  2+ members:           ${records.filter((r) => r.memberCount === "2+").length}`);
  log(`  errors:               ${records.filter((r) => r.status === "error").length}`);
  log(`  >>> MATCH (sole member is "${targetName}"): ${matched.length} team(s) flagged for DELETE`);
  for (const r of matched) {
    log(`        - "${r.displayName}"  (${r.teamId})  sole=${r.soleMemberName} <${r.soleMemberEmail || "hidden"}>  [${r.reason}]`);
  }
  log(`\n  CSV:  ${csvPath}`);
  log(`  plan: ${plan._path}`);

  if (!args.apply) {
    log(`\nPLAN only. Review the CSV, then run with --apply to delete the ${matched.length} flagged team(s).`);
    return finish(client, log);
  }

  // --apply on a fresh plan
  if (matched.length === 0) {
    log("\nNothing to delete.");
    return finish(client, log);
  }
  await apply(client, plan, targets, args, log);
  savePlan(plan);
  return finish(client, log);
}

function finish(client, log) {
  const s = client.getStats();
  log(`\nAPI stats: requests=${s.requestCount} errors=${s.errorCount} rateLimited=${s.rateLimitCount}`);
  log("Done.");
}

main().catch((err) => {
  console.error("\nFATAL:", err.stack || err.message);
  process.exit(1);
});
