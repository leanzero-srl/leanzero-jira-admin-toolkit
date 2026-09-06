#!/usr/bin/env node

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudJiraClient = require("../src/cloudJiraClient");

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const HELP = args.includes("--help") || args.includes("-h");
const DRY_RUN = args.includes("--dry-run");
const CONFIRM = args.includes("--confirm");
const INCLUDE_ARCHIVED = args.includes("--include-archived");

function getArgValue(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const MODE = getArgValue("--mode");
const SCHEME_ID_RAW = getArgValue("--scheme-id");
const RESTORE_FILE = getArgValue("--file");
const ONLY_KEY_RAW = getArgValue("--only-key");

if (HELP || !MODE) {
  console.log(`
Usage: node bulk_assign_permission_scheme.js --mode <mode> [options]

Exports, bulk-assigns, or restores project->permission-scheme mappings in
Jira Cloud.

Modes:
  --mode export
      Dump every project's current permission scheme assignment to a JSON
      backup in ./logs/permission_scheme_backup_<ts>.json

  --mode apply --scheme-id <id> [--confirm]
      Assign ALL projects to a single permission scheme (by numeric id).
      Runs an export first automatically so you always have a backup.
      Requires --confirm to actually mutate; without --confirm it behaves
      like a dry run.

  --mode restore --file <backup.json> [--confirm]
      Restore each project to the scheme listed in the backup file.
      Accepts either the full { projectPermissionSchemes: [...] } shape
      or a bare [...] array. Falls back from scheme id to scheme name
      when the id is not found on the current instance.

Shared options:
  --dry-run           Log what would change without calling PUT
  --confirm           Required flag for apply/restore to mutate data
  --only-key <regex>  Process only projects whose key matches this regex
                      (e.g. '^SAMPLE$' or '^(FOO|BAR)')
  --include-archived  Include archived projects (default: excluded)
  --help              Show this help

Environment variables (via .env, same folder as package.json):
  CLOUD_BASE_URL      Jira Cloud base URL (https://site.atlassian.net)
  CLOUD_API_TOKEN     Base64-encoded email:api_token

Examples:
  node main/bulk_assign_permission_scheme.js --mode export
  node main/bulk_assign_permission_scheme.js --mode apply --scheme-id 12503 --only-key '^SAMPLE$' --dry-run
  node main/bulk_assign_permission_scheme.js --mode apply --scheme-id 12503 --confirm
  node main/bulk_assign_permission_scheme.js --mode restore --file logs/permission_scheme_backup_1745000000000.json --confirm
`);
  process.exit(MODE ? 0 : 1);
}

if (!["export", "apply", "restore"].includes(MODE)) {
  console.error(`ERROR: unknown --mode "${MODE}". Valid: export, apply, restore.`);
  process.exit(1);
}

let onlyKeyRegex = null;
if (ONLY_KEY_RAW) {
  try {
    onlyKeyRegex = new RegExp(ONLY_KEY_RAW);
  } catch (e) {
    console.error(`ERROR: invalid --only-key regex: ${e.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
const logsDir = path.resolve(__dirname, "../logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
const runTs = Date.now();
const logFile = path.join(logsDir, `bulk_assign_${runTs}.log`);

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
// Helpers
// ---------------------------------------------------------------------------
function matchesOnlyKey(project) {
  if (!onlyKeyRegex) return true;
  return onlyKeyRegex.test(project.key || "");
}

// Collects the current mapping: [{projectId, projectKey, projectName,
// permissionSchemeId, permissionSchemeName}]. Projects whose scheme
// lookup fails are included with null scheme fields plus an `error`.
async function collectCurrentMappings(client, projects) {
  const mappings = [];
  let i = 0;
  for (const project of projects) {
    i++;
    try {
      const scheme = await client.getProjectPermissionScheme(project.key);
      mappings.push({
        projectId: project.id != null ? Number(project.id) : null,
        projectKey: project.key,
        projectName: project.name,
        permissionSchemeId: scheme && scheme.id != null ? Number(scheme.id) : null,
        permissionSchemeName: scheme ? scheme.name : null,
      });
    } catch (err) {
      log(`  [${i}/${projects.length}] ${project.key}: FAILED to fetch current scheme - ${err.message}`);
      mappings.push({
        projectId: project.id != null ? Number(project.id) : null,
        projectKey: project.key,
        projectName: project.name,
        permissionSchemeId: null,
        permissionSchemeName: null,
        error: err.message,
      });
    }
    if (i % 25 === 0) log(`  ...collected ${i}/${projects.length} project scheme assignments`);
  }
  return mappings;
}

function writeBackup(mappings) {
  const payload = {
    exportedAt: new Date().toISOString(),
    jiraBaseUrl: process.env.CLOUD_BASE_URL,
    projectPermissionSchemes: mappings,
  };
  const backupPath = path.join(logsDir, `permission_scheme_backup_${runTs}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(payload, null, 2));
  return backupPath;
}

function readBackup(file) {
  const abs = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  if (!fs.existsSync(abs)) {
    throw new Error(`Backup file not found: ${abs}`);
  }
  const parsed = JSON.parse(fs.readFileSync(abs, "utf8"));
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.projectPermissionSchemes)) {
    return parsed.projectPermissionSchemes;
  }
  throw new Error(
    "Backup JSON must be either an array or an object with 'projectPermissionSchemes' array"
  );
}

function printReport(title, stats, client, startTime, extraLines = []) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const apiStats = client.getStats();
  log("\n============================================================");
  log(title);
  log("============================================================");
  if (DRY_RUN) log("\n  *** DRY RUN - No changes were made ***");
  if (!DRY_RUN && (MODE === "apply" || MODE === "restore") && !CONFIRM) {
    log("\n  *** --confirm not passed - No changes were made ***");
  }
  for (const line of extraLines) log(line);
  log("\n  Projects:");
  log(`    Total considered:    ${stats.total}`);
  log(`    Filtered out:        ${stats.filtered}`);
  log(`    Unchanged:           ${stats.unchanged}`);
  log(`    ${DRY_RUN || !CONFIRM ? "Would update" : "Updated"}:        ${stats.updated}`);
  log(`    Skipped (no scheme): ${stats.skippedNoScheme}`);
  log(`    Failed:              ${stats.failed}`);
  log("\n  API Statistics:");
  log(
    `    Requests: ${apiStats.requestCount} (${apiStats.errorCount} errors, ${apiStats.rateLimitCount} rate limits)`
  );
  log(`\n  Total elapsed time: ${elapsed}s`);
  log(`  Log file: ${logFile}`);
  log("============================================================\n");
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function runExport(client) {
  const startTime = Date.now();
  log("==========================================");
  log("Export: project -> permission scheme");
  log("==========================================");
  log(`  Cloud:  ${process.env.CLOUD_BASE_URL}`);
  if (onlyKeyRegex) log(`  Filter: only keys matching /${ONLY_KEY_RAW}/`);
  log(`  Archived projects: ${INCLUDE_ARCHIVED ? "included" : "excluded"}`);
  log("");

  log("Step 1: Fetching all projects...");
  const allProjects = await client.fetchAllProjects({
    includeArchived: INCLUDE_ARCHIVED,
  });
  log(`  Found ${allProjects.length} project(s)`);

  const projects = allProjects.filter(matchesOnlyKey);
  if (onlyKeyRegex) log(`  After --only-key filter: ${projects.length} project(s)`);

  log("\nStep 2: Fetching current permission scheme for each project...");
  const mappings = await collectCurrentMappings(client, projects);

  log("\nStep 3: Writing backup...");
  const backupPath = writeBackup(mappings);
  log(`  Backup written: ${backupPath}`);

  const stats = {
    total: projects.length,
    filtered: allProjects.length - projects.length,
    unchanged: 0,
    updated: 0,
    skippedNoScheme: mappings.filter((m) => !m.permissionSchemeId).length,
    failed: mappings.filter((m) => m.error).length,
  };
  printReport("EXPORT REPORT", stats, client, startTime, [
    `\n  Backup file: ${backupPath}`,
  ]);
  return backupPath;
}

async function runApply(client) {
  const startTime = Date.now();
  log("==========================================");
  log("Apply: assign ALL projects to one scheme");
  log("==========================================");
  log(`  Cloud:      ${process.env.CLOUD_BASE_URL}`);
  log(`  Target id:  ${SCHEME_ID_RAW}`);
  if (onlyKeyRegex) log(`  Filter:     only keys matching /${ONLY_KEY_RAW}/`);
  log(`  Archived:   ${INCLUDE_ARCHIVED ? "included" : "excluded"}`);
  if (DRY_RUN) log("  *** DRY RUN MODE ***");
  if (!DRY_RUN && !CONFIRM) log("  *** --confirm NOT passed - will not mutate ***");
  log("");

  if (!SCHEME_ID_RAW) {
    log("ERROR: --scheme-id is required for --mode apply");
    process.exit(1);
  }
  const schemeIdNum = Number(SCHEME_ID_RAW);
  if (!Number.isInteger(schemeIdNum) || schemeIdNum <= 0) {
    log(`ERROR: --scheme-id must be a positive integer, got "${SCHEME_ID_RAW}"`);
    process.exit(1);
  }

  log("Step 1: Validating target permission scheme...");
  const schemes = await client.fetchAllPermissionSchemes();
  const target = schemes.find((s) => Number(s.id) === schemeIdNum);
  if (!target) {
    log(`  ERROR: permission scheme id=${schemeIdNum} not found on this instance.`);
    log(`  Available schemes:`);
    for (const s of schemes) log(`    - ${s.id}: ${s.name}`);
    process.exit(1);
  }
  log(`  Target: "${target.name}" (id: ${target.id})`);

  log("\nStep 2: Fetching all projects...");
  const allProjects = await client.fetchAllProjects({
    includeArchived: INCLUDE_ARCHIVED,
  });
  log(`  Found ${allProjects.length} project(s)`);
  const projects = allProjects.filter(matchesOnlyKey);
  if (onlyKeyRegex) log(`  After --only-key filter: ${projects.length} project(s)`);

  log("\nStep 3: Collecting current mappings and writing backup...");
  const mappings = await collectCurrentMappings(client, projects);
  const backupPath = writeBackup(mappings);
  log(`  Backup written: ${backupPath}`);

  log("\nStep 4: Applying target scheme to each project...");
  const stats = {
    total: projects.length,
    filtered: allProjects.length - projects.length,
    unchanged: 0,
    updated: 0,
    skippedNoScheme: 0,
    failed: 0,
  };
  const failures = [];

  for (let i = 0; i < mappings.length; i++) {
    const m = mappings[i];
    const prefix = `  [${i + 1}/${mappings.length}] ${m.projectKey}`;

    if (m.error) {
      log(`${prefix}: SKIP (could not read current scheme: ${m.error})`);
      stats.skippedNoScheme++;
      continue;
    }

    if (Number(m.permissionSchemeId) === schemeIdNum) {
      log(`${prefix}: UNCHANGED (already on "${target.name}")`);
      stats.unchanged++;
      continue;
    }

    if (DRY_RUN || !CONFIRM) {
      log(`${prefix}: WOULD UPDATE from "${m.permissionSchemeName}" (id=${m.permissionSchemeId}) -> "${target.name}" (id=${target.id})`);
      stats.updated++;
      continue;
    }

    try {
      await client.assignPermissionSchemeToProject(m.projectKey, schemeIdNum);
      log(`${prefix}: UPDATED "${m.permissionSchemeName}" -> "${target.name}"`);
      stats.updated++;
    } catch (err) {
      log(`${prefix}: FAILED - ${err.message}`);
      stats.failed++;
      failures.push({ project: m.projectKey, error: err.message });
    }
  }

  const extra = [`\n  Backup file: ${backupPath}`];
  if (failures.length) {
    extra.push("\n  Failed projects (retry individually if needed):");
    for (const f of failures) {
      extra.push(
        `    ${f.project}: ${f.error}`
      );
      extra.push(
        `      curl -X PUT -H 'Authorization: Basic <TOKEN>' -H 'Content-Type: application/json' ` +
        `-d '{"id":${schemeIdNum}}' '${process.env.CLOUD_BASE_URL}/rest/api/3/project/${f.project}/permissionscheme'`
      );
    }
  }
  printReport("APPLY REPORT", stats, client, startTime, extra);
}

async function runRestore(client) {
  const startTime = Date.now();
  log("==========================================");
  log("Restore: project -> permission scheme");
  log("==========================================");
  log(`  Cloud:   ${process.env.CLOUD_BASE_URL}`);
  log(`  Source:  ${RESTORE_FILE}`);
  if (onlyKeyRegex) log(`  Filter:  only keys matching /${ONLY_KEY_RAW}/`);
  if (DRY_RUN) log("  *** DRY RUN MODE ***");
  if (!DRY_RUN && !CONFIRM) log("  *** --confirm NOT passed - will not mutate ***");
  log("");

  if (!RESTORE_FILE) {
    log("ERROR: --file <path> is required for --mode restore");
    process.exit(1);
  }

  log("Step 1: Reading backup file...");
  let backupMappings;
  try {
    backupMappings = readBackup(RESTORE_FILE);
  } catch (err) {
    log(`  ERROR: ${err.message}`);
    process.exit(1);
  }
  log(`  Parsed ${backupMappings.length} mapping(s) from backup`);

  log("\nStep 2: Fetching current permission schemes for lookup...");
  const schemes = await client.fetchAllPermissionSchemes();
  const schemesById = new Map(schemes.map((s) => [Number(s.id), s]));
  const schemesByName = new Map(schemes.map((s) => [s.name, s]));
  log(`  ${schemes.length} scheme(s) available on this instance`);

  log("\nStep 3: Restoring each project...");
  const stats = {
    total: 0,
    filtered: 0,
    unchanged: 0,
    updated: 0,
    skippedNoScheme: 0,
    failed: 0,
  };
  const failures = [];

  for (let i = 0; i < backupMappings.length; i++) {
    const m = backupMappings[i];
    const projectKey = m.projectKey || m.key;
    if (!projectKey) {
      log(`  SKIP[#${i}]: mapping has no projectKey`);
      stats.skippedNoScheme++;
      continue;
    }

    if (onlyKeyRegex && !onlyKeyRegex.test(projectKey)) {
      stats.filtered++;
      continue;
    }
    stats.total++;

    const prefix = `  [${i + 1}/${backupMappings.length}] ${projectKey}`;

    // Resolve target scheme: by id first, then by name (mirrors Groovy restore)
    let target = null;
    if (m.permissionSchemeId != null) {
      target = schemesById.get(Number(m.permissionSchemeId)) || null;
    }
    if (!target && m.permissionSchemeName) {
      target = schemesByName.get(m.permissionSchemeName) || null;
    }
    if (!target) {
      log(
        `${prefix}: SKIP - scheme id=${m.permissionSchemeId} name="${m.permissionSchemeName}" not found on this instance`
      );
      stats.skippedNoScheme++;
      continue;
    }

    // Read current and compare to avoid needless PUTs
    let current;
    try {
      current = await client.getProjectPermissionScheme(projectKey);
    } catch (err) {
      log(`${prefix}: FAILED to read current scheme - ${err.message}`);
      stats.failed++;
      failures.push({ project: projectKey, error: err.message });
      continue;
    }

    if (current && Number(current.id) === Number(target.id)) {
      log(`${prefix}: UNCHANGED (already on "${target.name}")`);
      stats.unchanged++;
      continue;
    }

    if (DRY_RUN || !CONFIRM) {
      log(
        `${prefix}: WOULD RESTORE from "${current ? current.name : "unknown"}" (id=${current ? current.id : "?"}) -> "${target.name}" (id=${target.id})`
      );
      stats.updated++;
      continue;
    }

    try {
      await client.assignPermissionSchemeToProject(projectKey, target.id);
      log(`${prefix}: RESTORED "${current ? current.name : "?"}" -> "${target.name}"`);
      stats.updated++;
    } catch (err) {
      log(`${prefix}: FAILED - ${err.message}`);
      stats.failed++;
      failures.push({ project: projectKey, error: err.message });
    }
  }

  const extra = [];
  if (failures.length) {
    extra.push("\n  Failed projects:");
    for (const f of failures) extra.push(`    ${f.project}: ${f.error}`);
  }
  printReport("RESTORE REPORT", stats, client, startTime, extra);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const client = new CloudJiraClient(
    process.env.CLOUD_BASE_URL,
    process.env.CLOUD_API_TOKEN,
    log
  );

  log("Testing connection...");
  try {
    const info = await client.testConnection();
    log(`  Cloud Jira: OK (${info.serverTitle || info.baseUrl || "connected"})`);
  } catch (err) {
    log(`  Cloud Jira: FAILED - ${err.message}`);
    process.exit(1);
  }

  if (MODE === "export") return runExport(client);
  if (MODE === "apply") return runApply(client);
  if (MODE === "restore") return runRestore(client);
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

main().catch((err) => {
  log(`\nFATAL ERROR: ${err.message}`);
  if (err.stack) log(err.stack);
  process.exit(1);
});
