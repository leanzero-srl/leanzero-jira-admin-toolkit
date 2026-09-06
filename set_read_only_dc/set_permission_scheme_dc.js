#!/usr/bin/env node

/**
 * Set / Revert Project Permission Schemes — Jira Data Center
 *
 * Two modes:
 *   set    — apply one permission scheme ID to every (or filtered) project,
 *            saving the BEFORE state of each project to a JSON backup file.
 *   revert — read that backup file and put each project back on its original scheme.
 *
 * The backup JSON is intentionally portable: it stores both the scheme **id**
 * AND its **name** for every project. After a Cloud migration the IDs will
 * change but the names usually carry over, so a separate Cloud-side restore
 * tool can match `before.name` -> Cloud scheme id and re-apply.
 *
 * DC REST endpoints used:
 *   GET  /rest/api/2/project?expand=permissions       (list projects)
 *   GET  /rest/api/2/project/{key}/permissionscheme    (get assigned scheme)
 *   PUT  /rest/api/2/project/{key}/permissionscheme    (assign scheme — body: {id})
 *
 * Auth (pick one):
 *   --user / --password           (Basic, plain creds)
 *   --basic-auth <base64>         (Basic, pre-encoded "user:password")
 *   --pat <token>                 (Bearer, Personal Access Token)
 *
 * All three can also be supplied via env: JIRA_DC_USER, JIRA_DC_PASSWORD,
 * JIRA_DC_BASIC_AUTH, JIRA_DC_PAT.
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");
const { program } = require("commander");

// ── HTTP helper ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build the Authorization header from CLI options + env vars.
 * Precedence: --pat > --basic-auth > --user/--password.
 */
function resolveAuthHeader(options) {
  const pat = (options.pat || process.env.JIRA_DC_PAT || "").trim();
  if (pat) return `Bearer ${pat}`;

  const preEncoded = (
    options.basicAuth ||
    process.env.JIRA_DC_BASIC_AUTH ||
    ""
  ).trim();
  if (preEncoded) return `Basic ${preEncoded}`;

  const user = options.user || process.env.JIRA_DC_USER;
  const password = options.password || process.env.JIRA_DC_PASSWORD;
  if (user && password) {
    return "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
  }

  console.error(
    "❌ No auth provided. Pass one of:\n" +
      "   --pat <PAT>                 (or env JIRA_DC_PAT)\n" +
      "   --basic-auth <base64>       (or env JIRA_DC_BASIC_AUTH)\n" +
      "   --user <u> --password <p>   (or env JIRA_DC_USER / JIRA_DC_PASSWORD)",
  );
  process.exit(1);
}

/**
 * Make a JSON request with retry on 429 / 5xx.
 * Returns { statusCode, data } on success, throws on non-retryable HTTP error.
 */
async function makeRequest(
  baseUrl,
  authHeader,
  method,
  pathAndQuery,
  body = null,
  retryCount = 0,
  maxRetries = 5,
) {
  const url = new URL(pathAndQuery, baseUrl);
  const isHttps = url.protocol === "https:";
  const transport = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Atlassian-Token": "no-check",
      },
    };

    const req = transport.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", async () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve({
              statusCode: res.statusCode,
              data: data ? JSON.parse(data) : {},
            });
          } catch (_) {
            resolve({ statusCode: res.statusCode, data: {} });
          }
          return;
        }

        const retryable =
          res.statusCode === 429 ||
          (res.statusCode >= 500 && res.statusCode < 600);
        if (retryable && retryCount < maxRetries) {
          const retryAfter = parseInt(res.headers["retry-after"] || "0", 10);
          const backoff =
            retryAfter > 0
              ? retryAfter * 1000
              : Math.min(1000 * Math.pow(2, retryCount), 30000);
          console.log(
            `   ⏳ HTTP ${res.statusCode} — retrying in ${backoff / 1000}s ` +
              `(attempt ${retryCount + 1}/${maxRetries})`,
          );
          await sleep(backoff);
          try {
            const result = await makeRequest(
              baseUrl,
              authHeader,
              method,
              pathAndQuery,
              body,
              retryCount + 1,
              maxRetries,
            );
            resolve(result);
          } catch (e) {
            reject(e);
          }
          return;
        }

        reject(new Error(`HTTP ${res.statusCode}: ${data || "(empty body)"}`));
      });
    });

    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Jira DC API wrappers ───────────────────────────────────────────────────────

async function getAllProjects(baseUrl, authHeader) {
  console.log("📂 Fetching all projects (DC /rest/api/2/project)...");
  const res = await makeRequest(
    baseUrl,
    authHeader,
    "GET",
    "/rest/api/2/project",
  );
  // DC returns a flat array (not paginated like Cloud).
  const projects = Array.isArray(res.data) ? res.data : [];
  console.log(`✅ Total projects found: ${projects.length}`);
  return projects;
}

async function getProjectPermissionScheme(baseUrl, authHeader, projectKey) {
  try {
    const res = await makeRequest(
      baseUrl,
      authHeader,
      "GET",
      `/rest/api/2/project/${encodeURIComponent(projectKey)}/permissionscheme`,
    );
    return { success: true, data: res.data };
  } catch (e) {
    if (/HTTP 404/.test(e.message)) {
      return { success: true, data: null, notFound: true };
    }
    return { success: false, error: e.message };
  }
}

async function setProjectPermissionScheme(
  baseUrl,
  authHeader,
  projectKey,
  schemeId,
) {
  try {
    const res = await makeRequest(
      baseUrl,
      authHeader,
      "PUT",
      `/rest/api/2/project/${encodeURIComponent(projectKey)}/permissionscheme`,
      { id: parseInt(schemeId, 10) },
    );
    return { success: true, data: res.data };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function getPermissionScheme(baseUrl, authHeader, schemeId) {
  // Sanity-check that the target scheme exists before we start touching projects.
  const res = await makeRequest(
    baseUrl,
    authHeader,
    "GET",
    `/rest/api/2/permissionscheme/${parseInt(schemeId, 10)}`,
  );
  return res.data;
}

// ── Display / output helpers ───────────────────────────────────────────────────

function fmtScheme(s) {
  if (!s) return "None";
  return `${s.name} (ID: ${s.id})`;
}

function writeOutputFile(outputPath, payload) {
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(
    path.resolve(outputPath),
    JSON.stringify(payload, null, 2),
    "utf8",
  );
}

function printSummary(stats, changes, isDryRun, isRevert = false) {
  console.log("📊 SUMMARY");
  console.log("=====================================");
  console.log(`Total Projects:           ${stats.totalProjects}`);
  console.log(`Processed Projects:       ${stats.processedProjects}`);
  console.log(`Already at Target:        ${stats.unchanged}`);
  console.log(
    `Successfully ${isRevert ? "Reverted" : "Updated"}: ${stats.successful}`,
  );
  if (isDryRun) {
    console.log(
      `Would ${isRevert ? "Revert" : "Update"} (Dry Run): ${stats.skipped}`,
    );
  }
  console.log(`Failures:                 ${stats.failures}`);
  console.log("");

  if (stats.errors.length > 0) {
    console.log("❌ ERRORS:");
    for (const e of stats.errors.slice(0, 10)) {
      console.log(`   ${e.project} (${e.operation}): ${e.error}`);
    }
    if (stats.errors.length > 10) {
      console.log(`   ... and ${stats.errors.length - 10} more`);
    }
    console.log("");
  }

  const changed = changes.filter(
    (c) => c.status === "success" || c.status === "dry_run",
  );
  if (changed.length > 0) {
    console.log(`📋 PERMISSION SCHEME ${isRevert ? "REVERTS" : "CHANGES"}:`);
    console.log("=====================================");
    for (const c of changed) {
      console.log(`\n${c.project} (${c.projectName})`);
      console.log(`  Before: ${fmtScheme(c.before)}`);
      console.log(`  After:  ${fmtScheme(c.after)}`);
      if (c.status === "dry_run") console.log(`  Status: DRY RUN`);
    }
    console.log("");
  }
}

// ── SET mode ───────────────────────────────────────────────────────────────────

async function setMode(baseUrl, authHeader, targetSchemeId, options) {
  console.log("🚀 SET PERMISSION SCHEME (Jira DC)");
  console.log("=====================================");
  console.log(`🌐 Jira DC: ${baseUrl}`);
  console.log(`🔐 Target scheme ID: ${targetSchemeId}`);
  if (options.dryRun) console.log("🔍 DRY RUN — no changes will be made");
  console.log("");

  // Pre-flight: confirm the target scheme exists and capture its name for the metadata.
  let targetScheme;
  try {
    targetScheme = await getPermissionScheme(baseUrl, authHeader, targetSchemeId);
    console.log(`✅ Target scheme exists: ${fmtScheme(targetScheme)}`);
  } catch (e) {
    console.error(
      `❌ Target permission scheme ID ${targetSchemeId} not found or not accessible: ${e.message}`,
    );
    process.exit(1);
  }
  console.log("");

  const stats = {
    totalProjects: 0,
    processedProjects: 0,
    unchanged: 0,
    successful: 0,
    failures: 0,
    skipped: 0,
    errors: [],
  };
  const changes = [];

  const projects = await getAllProjects(baseUrl, authHeader);
  stats.totalProjects = projects.length;

  let toProcess = projects;
  if (options.projectKey) {
    toProcess = projects.filter(
      (p) => p.key === options.projectKey.toUpperCase(),
    );
    if (toProcess.length === 0) {
      console.error(`❌ Project '${options.projectKey}' not found.`);
      process.exit(1);
    }
  } else if (options.projectPattern) {
    const re = new RegExp(options.projectPattern, "i");
    toProcess = projects.filter((p) => re.test(p.key));
    if (toProcess.length === 0) {
      console.error(`❌ No projects match /${options.projectPattern}/i`);
      process.exit(1);
    }
  }
  if (options.excludePattern) {
    const re = new RegExp(options.excludePattern, "i");
    const before = toProcess.length;
    toProcess = toProcess.filter((p) => !re.test(p.key));
    const excluded = before - toProcess.length;
    if (excluded > 0) {
      console.log(
        `🚫 Excluded ${excluded} projects matching /${options.excludePattern}/i`,
      );
    }
  }

  console.log(`🔧 Processing ${toProcess.length} project(s)\n`);

  for (const project of toProcess) {
    console.log(`📦 ${project.key} (${project.name})`);

    const cur = await getProjectPermissionScheme(
      baseUrl,
      authHeader,
      project.key,
    );
    if (!cur.success) {
      console.log(`   ❌ get_scheme failed: ${cur.error}`);
      stats.failures++;
      stats.errors.push({
        project: project.key,
        operation: "get_scheme",
        error: cur.error,
      });
      stats.processedProjects++;
      continue;
    }
    const before = cur.data;

    if (before?.id === parseInt(targetSchemeId, 10)) {
      console.log(`   ℹ️  Already on target scheme: ${fmtScheme(before)}`);
      stats.unchanged++;
      stats.processedProjects++;
      changes.push({
        project: project.key,
        projectName: project.name,
        before,
        after: before,
        status: "unchanged",
        message: "Already on target scheme",
      });
      console.log("");
      continue;
    }

    console.log(`   📋 Current: ${fmtScheme(before)}`);

    if (options.dryRun) {
      console.log(`   🔍 Would set: ${fmtScheme(targetScheme)}`);
      stats.skipped++;
      stats.processedProjects++;
      changes.push({
        project: project.key,
        projectName: project.name,
        before,
        after: { id: targetScheme.id, name: targetScheme.name },
        status: "dry_run",
        message: "Dry run",
      });
      console.log("");
      continue;
    }

    const setRes = await setProjectPermissionScheme(
      baseUrl,
      authHeader,
      project.key,
      targetSchemeId,
    );
    if (setRes.success) {
      console.log(`   ✅ Set to: ${fmtScheme(setRes.data || targetScheme)}`);
      stats.successful++;
      changes.push({
        project: project.key,
        projectName: project.name,
        before,
        after: setRes.data || { id: targetScheme.id, name: targetScheme.name },
        status: "success",
        message: "Permission scheme updated",
      });
    } else {
      console.log(`   ❌ set_scheme failed: ${setRes.error}`);
      stats.failures++;
      stats.errors.push({
        project: project.key,
        operation: "set_scheme",
        error: setRes.error,
      });
      changes.push({
        project: project.key,
        projectName: project.name,
        before,
        after: null,
        status: "failed",
        message: setRes.error,
      });
    }
    stats.processedProjects++;
    console.log("");
  }

  if (options.outputFile) {
    const out = {
      metadata: {
        timestamp: new Date().toISOString(),
        mode: "set",
        platform: "datacenter",
        jiraInstance: baseUrl,
        targetScheme: { id: targetScheme.id, name: targetScheme.name },
        targetSchemeId: parseInt(targetSchemeId, 10),
        dryRun: !!options.dryRun,
        projectFilter: options.projectKey || options.projectPattern || "all",
        excludePattern: options.excludePattern || null,
      },
      summary: stats,
      changes,
    };
    writeOutputFile(options.outputFile, out);
    console.log(`💾 Backup / results saved to: ${path.resolve(options.outputFile)}\n`);
  }

  printSummary(stats, changes, options.dryRun);

  console.log("");
  if (!options.dryRun) {
    console.log("✅ Done.");
    console.log("");
    console.log("↩️  To revert on the SAME DC instance:");
    console.log(
      `   node ${path.basename(__filename)} revert --url ${baseUrl} ` +
        `--input-file ${options.outputFile || "<output-file.json>"} ` +
        `[--user ... --password ... | --pat ... | --basic-auth ...]`,
    );
    console.log("");
    console.log(
      "ℹ️  After Cloud migration: feed the same JSON to the cloud-side restore " +
        "(matches by scheme NAME since IDs differ across instances).",
    );
  }
}

// ── REVERT mode ────────────────────────────────────────────────────────────────

async function revertMode(baseUrl, authHeader, options) {
  console.log("🔄 REVERT PERMISSION SCHEMES (Jira DC)");
  console.log("=====================================");
  console.log(`🌐 Jira DC: ${baseUrl}`);
  console.log(`📁 Input file: ${options.inputFile}`);
  if (options.dryRun) console.log("🔍 DRY RUN — no changes will be made");
  console.log("");

  const inputPath = path.resolve(options.inputFile);
  if (!fs.existsSync(inputPath)) {
    console.error(`❌ Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  if (!Array.isArray(input.changes)) {
    console.error("❌ Invalid input: missing 'changes' array.");
    process.exit(1);
  }

  // Only revert projects whose set actually succeeded AND moved off something.
  const candidates = input.changes.filter(
    (c) =>
      c.status === "success" &&
      c.before &&
      c.before.id != null &&
      c.before.id !== c.after?.id,
  );

  if (candidates.length === 0) {
    console.log("⚠️  Nothing to revert (no successful, distinct changes in input).");
    return;
  }

  console.log(
    `✅ ${candidates.length} project(s) to revert (out of ${input.changes.length} total)`,
  );
  if (input.metadata) {
    console.log(`   Original timestamp: ${input.metadata.timestamp}`);
    console.log(
      `   Original target:    ${fmtScheme(input.metadata.targetScheme || { id: input.metadata.targetSchemeId, name: "?" })}`,
    );
  }
  console.log("");

  const stats = {
    totalProjects: candidates.length,
    processedProjects: 0,
    unchanged: 0,
    successful: 0,
    failures: 0,
    skipped: 0,
    errors: [],
  };
  const changes = [];

  for (const rec of candidates) {
    const projectKey = rec.project;
    const target = rec.before;
    console.log(`📦 ${projectKey} (${rec.projectName})`);

    const cur = await getProjectPermissionScheme(baseUrl, authHeader, projectKey);
    if (!cur.success) {
      console.log(`   ❌ get_scheme failed: ${cur.error}`);
      stats.failures++;
      stats.errors.push({
        project: projectKey,
        operation: "get_scheme",
        error: cur.error,
      });
      stats.processedProjects++;
      continue;
    }
    const before = cur.data;

    console.log(`   📋 Current: ${fmtScheme(before)}`);
    console.log(`   ↩️  Target:  ${fmtScheme(target)}`);

    if (before?.id === target.id) {
      console.log(`   ℹ️  Already on target — no change needed`);
      stats.unchanged++;
      stats.processedProjects++;
      changes.push({
        project: projectKey,
        projectName: rec.projectName,
        before,
        after: before,
        status: "unchanged",
        message: "Already on target",
      });
      console.log("");
      continue;
    }

    if (options.dryRun) {
      console.log(`   🔍 Would revert to: ${fmtScheme(target)}`);
      stats.skipped++;
      stats.processedProjects++;
      changes.push({
        project: projectKey,
        projectName: rec.projectName,
        before,
        after: target,
        status: "dry_run",
        message: "Dry run",
      });
      console.log("");
      continue;
    }

    const setRes = await setProjectPermissionScheme(
      baseUrl,
      authHeader,
      projectKey,
      target.id,
    );
    if (setRes.success) {
      console.log(`   ✅ Reverted to: ${fmtScheme(setRes.data || target)}`);
      stats.successful++;
      changes.push({
        project: projectKey,
        projectName: rec.projectName,
        before,
        after: setRes.data || target,
        status: "success",
        message: "Reverted",
      });
    } else {
      console.log(`   ❌ revert failed: ${setRes.error}`);
      stats.failures++;
      stats.errors.push({
        project: projectKey,
        operation: "revert_scheme",
        error: setRes.error,
      });
      changes.push({
        project: projectKey,
        projectName: rec.projectName,
        before,
        after: null,
        status: "failed",
        message: setRes.error,
      });
    }
    stats.processedProjects++;
    console.log("");
  }

  if (options.outputFile) {
    const out = {
      metadata: {
        timestamp: new Date().toISOString(),
        mode: "revert",
        platform: "datacenter",
        jiraInstance: baseUrl,
        inputFile: options.inputFile,
        dryRun: !!options.dryRun,
        originalOperation: input.metadata || null,
      },
      summary: stats,
      changes,
    };
    writeOutputFile(options.outputFile, out);
    console.log(`💾 Revert log saved to: ${path.resolve(options.outputFile)}\n`);
  }

  printSummary(stats, changes, options.dryRun, true);
  console.log("\n✅ Revert done.");
}

// ── CLI ────────────────────────────────────────────────────────────────────────

program
  .name("set-permission-scheme-dc")
  .description(
    "Apply / revert a Jira Data Center project permission scheme across all (or filtered) projects.",
  )
  .version("1.0.0");

const authOptions = (cmd) =>
  cmd
    .option("--user <user>", "DC username (or env JIRA_DC_USER)")
    .option("--password <password>", "DC password (or env JIRA_DC_PASSWORD)")
    .option(
      "--basic-auth <encoded>",
      "Pre-base64-encoded 'user:password' (or env JIRA_DC_BASIC_AUTH)",
    )
    .option(
      "--pat <token>",
      "Personal Access Token — sent as 'Authorization: Bearer ...' (or env JIRA_DC_PAT). Takes precedence over basic auth.",
    );

// SET
authOptions(
  program
    .command("set")
    .description(
      "Assign a permission scheme ID to all (or filtered) projects, saving a revert-compatible backup JSON.",
    )
    .requiredOption(
      "--url <url>",
      "Jira DC base URL (e.g., https://jira.company.com)",
    )
    .requiredOption("--scheme-id <id>", "Permission scheme ID to assign")
    .option("--project-key <key>", "Process a single project by key")
    .option(
      "--project-pattern <regex>",
      "Process projects matching this regex on key",
    )
    .option(
      "--exclude-pattern <regex>",
      "Exclude projects matching this regex on key",
    )
    .option("--dry-run", "Preview without changing anything", false)
    .option(
      "--output-file <file>",
      "JSON backup output (also the input for revert)",
      `dc_permission_scheme_changes_${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, 19)}.json`,
    ),
).action((options) => {
  if (!/^\d+$/.test(options.schemeId)) {
    console.error(`❌ --scheme-id must be numeric (got "${options.schemeId}")`);
    process.exit(1);
  }
  const baseUrl = options.url.replace(/\/+$/, "");
  const authHeader = resolveAuthHeader(options);
  setMode(baseUrl, authHeader, options.schemeId, options).catch((e) => {
    console.error("Unhandled error:", e);
    process.exit(1);
  });
});

// REVERT
authOptions(
  program
    .command("revert")
    .description(
      "Revert projects to their pre-change permission schemes using a backup JSON written by 'set'.",
    )
    .requiredOption(
      "--url <url>",
      "Jira DC base URL (e.g., https://jira.company.com)",
    )
    .requiredOption("--input-file <file>", "Backup JSON to revert from")
    .option("--dry-run", "Preview without changing anything", false)
    .option(
      "--output-file <file>",
      "Revert log output JSON",
      `dc_permission_scheme_revert_${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, 19)}.json`,
    ),
).action((options) => {
  const baseUrl = options.url.replace(/\/+$/, "");
  const authHeader = resolveAuthHeader(options);
  revertMode(baseUrl, authHeader, options).catch((e) => {
    console.error("Unhandled error:", e);
    process.exit(1);
  });
});

if (process.argv.length <= 2) {
  program.outputHelp();
  console.log("");
  console.log("Examples:");
  console.log("");
  console.log("  SET — apply scheme 10100 to every project (saves backup):");
  console.log("    $ node set_permission_scheme_dc.js set \\");
  console.log("        --url https://jira.company.com \\");
  console.log("        --user admin --password 'hunter2' \\");
  console.log("        --scheme-id 10100");
  console.log("");
  console.log("  SET (dry-run, single project):");
  console.log("    $ node set_permission_scheme_dc.js set \\");
  console.log("        --url https://jira.company.com \\");
  console.log("        --pat MY_PAT \\");
  console.log("        --scheme-id 10100 --project-key PROJ --dry-run");
  console.log("");
  console.log("  REVERT — restore from a backup file:");
  console.log("    $ node set_permission_scheme_dc.js revert \\");
  console.log("        --url https://jira.company.com \\");
  console.log("        --user admin --password 'hunter2' \\");
  console.log("        --input-file dc_permission_scheme_changes_<ts>.json");
  console.log("");
  process.exit(0);
}

program.parse();
