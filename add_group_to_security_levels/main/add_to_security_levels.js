#!/usr/bin/env node

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudJiraClient = require("../src/cloudJiraClient");

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const HELP = args.includes("--help");

function getArgValue(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const GROUP_NAME = getArgValue("--group") || "org-admins";
const SCHEME_FILTER = getArgValue("--scheme"); // optional: process only one scheme (name, case-insensitive)

if (HELP) {
  console.log(`
Usage: node add_to_security_levels.js [options]

Adds a group to every issue security level across all security schemes
in a Jira Cloud instance.

Options:
  --dry-run          Preview changes without executing
  --group <name>     Group name to add (default: org-admins)
  --scheme <name>    Process only one security scheme (case-insensitive match)
  --help             Show this help message

Environment variables (via .env):
  CLOUD_BASE_URL     Jira Cloud base URL (https://site.atlassian.net)
  CLOUD_API_TOKEN    Base64-encoded email:api_token
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
const logsDir = path.resolve(__dirname, "../logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
const logFile = path.join(logsDir, `security_${Date.now()}.log`);

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(message);
  try {
    fs.appendFileSync(logFile, line + "\n");
  } catch {
    // Ignore log write failures
  }
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------
const required = ["CLOUD_BASE_URL", "CLOUD_API_TOKEN"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  log(`ERROR: Missing required environment variables: ${missing.join(", ")}`);
  log("Copy .env.example to .env and fill in values.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const startTime = Date.now();

  log("==========================================");
  log("Add Group to Issue Security Levels");
  log("==========================================");
  log(`  Cloud:  ${process.env.CLOUD_BASE_URL}`);
  log(`  Group:  ${GROUP_NAME}`);
  if (SCHEME_FILTER) log(`  Scheme: ${SCHEME_FILTER} (filter)`);
  log("");
  if (DRY_RUN) log("*** DRY RUN MODE - No changes will be made ***\n");

  const client = new CloudJiraClient(
    process.env.CLOUD_BASE_URL,
    process.env.CLOUD_API_TOKEN,
    log
  );

  // Stats
  const stats = {
    schemesFound: 0,
    schemesProcessed: 0,
    levelsFound: 0,
    levelsAlreadyHasGroup: 0,
    levelsUpdated: 0,
    levelsFailed: 0,
  };

  // ------------------------------------------------------------------
  // Step 1: Test connection
  // ------------------------------------------------------------------
  log("Step 1: Testing connection...");
  try {
    const info = await client.testConnection();
    log(`  Cloud Jira: OK (${info.serverTitle || info.baseUrl || "connected"})`);
  } catch (err) {
    log(`  Cloud Jira: FAILED - ${err.message}`);
    log("\nCannot continue without a valid connection. Exiting.");
    process.exit(1);
  }

  // ------------------------------------------------------------------
  // Step 2: Fetch all security schemes
  // ------------------------------------------------------------------
  log("\nStep 2: Fetching issue security schemes...");
  let schemes;
  try {
    schemes = await client.fetchAllSecuritySchemes();
  } catch (err) {
    log(`  FAILED to fetch security schemes: ${err.message}`);
    process.exit(1);
  }

  stats.schemesFound = schemes.length;
  log(`  Found ${schemes.length} security scheme(s)`);

  if (SCHEME_FILTER) {
    const filter = SCHEME_FILTER.toLowerCase();
    schemes = schemes.filter((s) => s.name.toLowerCase().includes(filter));
    log(
      `  After filter "${SCHEME_FILTER}": ${schemes.length} scheme(s) match`
    );
  }

  if (schemes.length === 0) {
    log("\nNo security schemes to process. Exiting.");
    printReport(stats, client, startTime);
    return;
  }

  for (const scheme of schemes) {
    log(`\n  Scheme: "${scheme.name}" (id: ${scheme.id})`);
  }

  // ------------------------------------------------------------------
  // Step 3: Fetch all security levels across schemes
  // ------------------------------------------------------------------
  log("\nStep 3: Fetching security levels...");
  const schemeIds = schemes.map((s) => s.id);
  let levels;
  try {
    levels = await client.fetchSecurityLevels(schemeIds);
  } catch (err) {
    log(`  FAILED to fetch security levels: ${err.message}`);
    process.exit(1);
  }

  stats.levelsFound = levels.length;
  log(`  Found ${levels.length} security level(s) across ${schemes.length} scheme(s)`);

  if (levels.length === 0) {
    log("\nNo security levels to process. Exiting.");
    printReport(stats, client, startTime);
    return;
  }

  // Build a lookup: levelId -> schemeId
  const levelToScheme = new Map();
  for (const level of levels) {
    levelToScheme.set(level.id, level.issueSecuritySchemeId);
  }

  // Build scheme name lookup
  const schemeNameMap = new Map();
  for (const scheme of schemes) {
    schemeNameMap.set(String(scheme.id), scheme.name);
  }

  // ------------------------------------------------------------------
  // Step 4: Check existing members & add group where missing
  // ------------------------------------------------------------------
  log("\nStep 4: Checking existing members and adding group...");

  // Fetch all members for the relevant levels in batches
  // The API supports filtering by levelId and schemeId
  // Process per-scheme to keep requests manageable
  for (const scheme of schemes) {
    stats.schemesProcessed++;
    const schemeLevels = levels.filter(
      (l) => String(l.issueSecuritySchemeId) === String(scheme.id)
    );

    if (schemeLevels.length === 0) {
      log(`\n  Scheme "${scheme.name}": no levels, skipping`);
      continue;
    }

    log(`\n  Scheme "${scheme.name}" - ${schemeLevels.length} level(s):`);

    // Fetch members for all levels in this scheme
    let members;
    try {
      members = await client.fetchSecurityLevelMembers(
        schemeLevels.map((l) => l.id),
        [scheme.id]
      );
    } catch (err) {
      log(`    FAILED to fetch members: ${err.message}`);
      stats.levelsFailed += schemeLevels.length;
      continue;
    }

    // Build a set of level IDs that already have the group
    const levelsWithGroup = new Set();
    for (const member of members) {
      const holder = member.holder || {};
      if (
        holder.type === "group" &&
        holder.parameter &&
        holder.parameter.toLowerCase() === GROUP_NAME.toLowerCase()
      ) {
        levelsWithGroup.add(String(member.issueSecurityLevelId));
      }
    }

    // Process each level
    for (const level of schemeLevels) {
      const levelId = String(level.id);

      if (levelsWithGroup.has(levelId)) {
        log(`    "${level.name}" (id: ${levelId}) - already has group, skipping`);
        stats.levelsAlreadyHasGroup++;
        continue;
      }

      if (DRY_RUN) {
        log(
          `    "${level.name}" (id: ${levelId}) - WOULD ADD group "${GROUP_NAME}"`
        );
        stats.levelsUpdated++;
        continue;
      }

      try {
        await client.addMemberToSecurityLevel(
          scheme.id,
          levelId,
          "group",
          GROUP_NAME
        );
        log(`    "${level.name}" (id: ${levelId}) - ADDED group "${GROUP_NAME}"`);
        stats.levelsUpdated++;
      } catch (err) {
        log(
          `    "${level.name}" (id: ${levelId}) - FAILED: ${err.message}`
        );
        stats.levelsFailed++;
      }
    }
  }

  // ------------------------------------------------------------------
  // Report
  // ------------------------------------------------------------------
  printReport(stats, client, startTime);
}

function printReport(stats, client, startTime) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const apiStats = client.getStats();

  log("\n============================================================");
  log("FINAL REPORT");
  log("============================================================");
  if (DRY_RUN) log("\n  *** DRY RUN - No changes were made ***");
  log(`\n  Group: "${GROUP_NAME}"`);

  log("\n  Security Schemes:");
  log(`    Schemes found:       ${stats.schemesFound}`);
  log(`    Schemes processed:   ${stats.schemesProcessed}`);

  log("\n  Security Levels:");
  log(`    Levels found:        ${stats.levelsFound}`);
  log(`    Already has group:   ${stats.levelsAlreadyHasGroup}`);
  log(
    `    ${DRY_RUN ? "Would add" : "Added"} group:    ${stats.levelsUpdated}`
  );
  log(`    Failed:              ${stats.levelsFailed}`);

  log("\n  API Statistics:");
  log(
    `    Requests: ${apiStats.requestCount} (${apiStats.errorCount} errors, ${apiStats.rateLimitCount} rate limits)`
  );

  log(`\n  Total elapsed time: ${elapsed}s`);
  log(`  Log file: ${logFile}`);
  log("============================================================\n");
}

// ---------------------------------------------------------------------------
// Signal handling
// ---------------------------------------------------------------------------
let shuttingDown = false;
function handleSignal(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`\nReceived ${signal}, shutting down gracefully...`);
  process.exit(0);
}
process.on("SIGINT", handleSignal);
process.on("SIGTERM", handleSignal);

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
main().catch((err) => {
  log(`\nFATAL ERROR: ${err.message}`);
  log(err.stack);
  process.exit(1);
});
