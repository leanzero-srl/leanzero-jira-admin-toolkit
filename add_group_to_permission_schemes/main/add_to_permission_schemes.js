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
const SCHEME_FILTER = getArgValue("--scheme"); // optional: filter by scheme name (case-insensitive)

if (HELP) {
  console.log(`
Usage: node add_to_permission_schemes.js [options]

Adds a group to every permission (actor level) across all permission schemes
in a Jira Cloud instance. For each scheme, it discovers every distinct
permission type that has at least one grant and ensures the group is present.

Options:
  --dry-run          Preview changes without executing
  --group <name>     Group name to add (default: org-admins)
  --scheme <name>    Process only schemes whose name contains this string
                     (case-insensitive)
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
const logFile = path.join(logsDir, `permissions_${Date.now()}.log`);

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
  log("Add Group to Permission Schemes");
  log("==========================================");
  log(`  Cloud:  ${process.env.CLOUD_BASE_URL}`);
  log(`  Group:  ${GROUP_NAME}`);
  if (SCHEME_FILTER) log(`  Scheme: "${SCHEME_FILTER}" (filter)`);
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
    permissionsFound: 0,
    grantsAlreadyExist: 0,
    grantsCreated: 0,
    grantsSkippedScope: 0,
    grantsFailed: 0,
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
  // Step 2: Look up the group to get its ID
  // ------------------------------------------------------------------
  log(`\nStep 2: Looking up group "${GROUP_NAME}"...`);
  let groupId = null;
  try {
    const group = await client.findGroup(GROUP_NAME);
    groupId = group.groupId || null;
    if (groupId) {
      log(`  Found: "${group.name}" (id: ${groupId})`);
    } else {
      log(`  Found group "${group.name}" but no groupId returned, will use name only`);
    }
  } catch (err) {
    log(`  WARNING: Could not look up group: ${err.message}`);
    log("  Will attempt to use group name only (may fail on some instances)");
  }

  // ------------------------------------------------------------------
  // Step 3: Fetch all permission schemes
  // ------------------------------------------------------------------
  log("\nStep 3: Fetching permission schemes...");
  let schemes;
  try {
    schemes = await client.fetchAllPermissionSchemes();
  } catch (err) {
    log(`  FAILED to fetch permission schemes: ${err.message}`);
    process.exit(1);
  }

  stats.schemesFound = schemes.length;
  log(`  Found ${schemes.length} permission scheme(s)`);

  if (SCHEME_FILTER) {
    const filter = SCHEME_FILTER.toLowerCase();
    schemes = schemes.filter((s) => s.name.toLowerCase().includes(filter));
    log(
      `  After filter "${SCHEME_FILTER}": ${schemes.length} scheme(s) match`
    );
  }

  if (schemes.length === 0) {
    log("\nNo permission schemes to process. Exiting.");
    printReport(stats, client, startTime);
    return;
  }

  for (const scheme of schemes) {
    log(`    - "${scheme.name}" (id: ${scheme.id})`);
  }

  // ------------------------------------------------------------------
  // Step 4: Process each scheme
  // ------------------------------------------------------------------
  log("\nStep 4: Processing schemes...");

  for (const scheme of schemes) {
    stats.schemesProcessed++;
    log(`\n  Scheme: "${scheme.name}" (id: ${scheme.id})`);

    // Fetch all grants for this scheme
    let grants;
    try {
      grants = await client.fetchPermissionGrants(scheme.id);
    } catch (err) {
      log(`    FAILED to fetch grants: ${err.message}`);
      continue;
    }

    // Collect distinct permission types in this scheme
    const permissionTypes = new Set();
    for (const grant of grants) {
      permissionTypes.add(grant.permission);
    }

    log(`    ${grants.length} grant(s) across ${permissionTypes.size} permission type(s)`);

    // For each permission type, check if the group already has a grant
    const groupGrantedPermissions = new Set();
    for (const grant of grants) {
      const holder = grant.holder || {};
      if (holder.type === "group") {
        const holderName = (holder.parameter || "").toLowerCase();
        const holderId = holder.value || "";
        if (
          holderName === GROUP_NAME.toLowerCase() ||
          (groupId && holderId === groupId)
        ) {
          groupGrantedPermissions.add(grant.permission);
        }
      }
    }

    stats.permissionsFound += permissionTypes.size;

    // Add the group for each permission type where it's missing
    const sortedPermissions = Array.from(permissionTypes).sort();
    for (const permission of sortedPermissions) {
      if (groupGrantedPermissions.has(permission)) {
        log(`    ${permission} - already has group, skipping`);
        stats.grantsAlreadyExist++;
        continue;
      }

      if (DRY_RUN) {
        log(`    ${permission} - WOULD ADD group "${GROUP_NAME}"`);
        stats.grantsCreated++;
        continue;
      }

      try {
        // parameter and value are mutually exclusive - prefer groupId (value)
        const identifier = groupId || GROUP_NAME;
        const isGroupId = !!groupId;
        await client.createPermissionGrant(
          scheme.id,
          permission,
          "group",
          identifier,
          isGroupId
        );
        log(`    ${permission} - ADDED group "${GROUP_NAME}"`);
        stats.grantsCreated++;
      } catch (err) {
        if (
          err.message.includes("Illegal Entity Scope") ||
          err.message.includes("entity scope")
        ) {
          log(`    ${permission} - skipped (scope mismatch, not applicable to this scheme)`);
          stats.grantsSkippedScope++;
        } else {
          log(`    ${permission} - FAILED: ${err.message}`);
          stats.grantsFailed++;
        }
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

  log("\n  Permission Schemes:");
  log(`    Schemes found:       ${stats.schemesFound}`);
  log(`    Schemes processed:   ${stats.schemesProcessed}`);

  log("\n  Permission Grants:");
  log(`    Permission types:    ${stats.permissionsFound}`);
  log(`    Already has group:   ${stats.grantsAlreadyExist}`);
  log(
    `    ${DRY_RUN ? "Would create" : "Created"} grants: ${stats.grantsCreated}`
  );
  log(`    Skipped (scope):     ${stats.grantsSkippedScope}`);
  log(`    Failed:              ${stats.grantsFailed}`);

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
