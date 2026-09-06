#!/usr/bin/env node

/**
 * Set or Revert Permission Schemes for Jira Cloud Projects
 *
 * MODE 1 - SET: Assigns a specific permission scheme to all projects
 * MODE 2 - REVERT: Reverts permission schemes from a previously saved JSON file
 *
 * Usage (SET mode):
 *   node set_permission_scheme.js set \
 *     --url https://your-instance.atlassian.net \
 *     --email your.email@company.com \
 *     --token your-api-token \
 *     --scheme-id 10000
 *
 * Usage (REVERT mode):
 *   node set_permission_scheme.js revert \
 *     --url https://your-instance.atlassian.net \
 *     --email your.email@company.com \
 *     --token your-api-token \
 *     --input-file permission_scheme_changes.json
 *
 * Requirements:
 *   npm install commander
 *
 * Based on official Atlassian Jira Cloud REST API documentation:
 * - GET /rest/api/3/project/search (Get projects paginated)
 * - GET /rest/api/3/project/{projectKeyOrId}/permissionscheme (Get assigned permission scheme)
 * - PUT /rest/api/3/project/{projectKeyOrId}/permissionscheme (Assign permission scheme)
 */

const https = require("https");
const http = require("http");
const { URL } = require("url");
const { program } = require("commander");
const fs = require("fs");
const path = require("path");

// Helper function to sleep
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Low-level request helper. Used directly by the `backfill-missing-schemes` mode
// because it needs to talk to BOTH a Cloud tenant (https + Basic) AND a DC instance
// (http or https, Basic or Bearer) within the same run.
//
// `fullBaseUrl` must include the protocol, e.g. "https://x.atlassian.net" or
// "http://jira-test.example.com". `authHeader` is the verbatim Authorization
// header value (e.g. "Basic xxx" or "Bearer yyy").
async function makeRawRequest(
  fullBaseUrl,
  authHeader,
  method,
  pathAndQuery,
  body = null,
  retryCount = 0,
  maxRetries = 5,
) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(pathAndQuery, fullBaseUrl);
    } catch (e) {
      reject(new Error(`Invalid URL: ${fullBaseUrl} + ${pathAndQuery}: ${e.message}`));
      return;
    }
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;
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
      res.on("data", (chunk) => (data += chunk));
      res.on("end", async () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve({
              statusCode: res.statusCode,
              data: data ? JSON.parse(data) : {},
            });
          } catch (e) {
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
              : Math.min(1000 * Math.pow(2, retryCount), 32000);
          console.log(
            `   ⏳ HTTP ${res.statusCode} — retrying in ${backoff / 1000}s ` +
              `(attempt ${retryCount + 1}/${maxRetries})`,
          );
          await sleep(backoff);
          try {
            const result = await makeRawRequest(
              fullBaseUrl,
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

// Thin wrapper kept for backwards compatibility with the existing Cloud-only
// callers in this file. They pass `baseUrl` as a bare hostname (no scheme) and
// `apiToken` as a pre-base64-encoded "email:token" string.
async function makeRequest(
  baseUrl,
  apiToken,
  method,
  path,
  body = null,
  retryCount = 0,
  maxRetries = 5,
) {
  // Tolerate callers that pass either a bare hostname or a full URL.
  const fullBase = /^https?:\/\//.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
  return makeRawRequest(
    fullBase,
    `Basic ${apiToken}`,
    method,
    path,
    body,
    retryCount,
    maxRetries,
  );
}

// Get all projects (paginated)
async function getAllProjects(baseUrl, apiToken) {
  console.log("📂 Fetching all projects...");

  const allProjects = [];
  let startAt = 0;
  const maxResults = 50; // Jira's default max
  let isLast = false;

  while (!isLast) {
    try {
      const response = await makeRequest(
        baseUrl,
        apiToken,
        "GET",
        `/rest/api/3/project/search?startAt=${startAt}&maxResults=${maxResults}`,
      );
      const { values, isLast: lastPage } = response.data;

      if (values && values.length > 0) {
        allProjects.push(...values);
        console.log(`   📊 Fetched ${allProjects.length} projects so far...`);
      }

      isLast = lastPage || !values || values.length === 0;
      startAt += maxResults;
    } catch (error) {
      console.error(`❌ Error fetching projects: ${error.message}`);
      throw error;
    }
  }

  console.log(`✅ Total projects found: ${allProjects.length}`);
  return allProjects;
}

// Get permission scheme for a specific project
async function getProjectPermissionScheme(baseUrl, apiToken, projectKeyOrId) {
  try {
    const response = await makeRequest(
      baseUrl,
      apiToken,
      "GET",
      `/rest/api/3/project/${projectKeyOrId}/permissionscheme`,
    );
    return { success: true, data: response.data };
  } catch (error) {
    // Some projects might not have a permission scheme or we might not have access
    if (error.message.includes("404")) {
      return { success: true, data: null, notFound: true };
    }
    return { success: false, error: error.message };
  }
}

// Set permission scheme for a specific project
async function setProjectPermissionScheme(
  baseUrl,
  apiToken,
  projectKeyOrId,
  schemeId,
) {
  try {
    const body = {
      id: parseInt(schemeId, 10),
    };

    const response = await makeRequest(
      baseUrl,
      apiToken,
      "PUT",
      `/rest/api/3/project/${projectKeyOrId}/permissionscheme`,
      body,
    );
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Create a brand-new read-only permission scheme on Cloud
// Returns { id, name, ... } from POST /rest/api/3/permissionscheme
async function createReadOnlyScheme(baseUrl, apiToken, options) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = options.schemeName || `Read-Only Lockdown ${ts}`;
  const description =
    options.schemeDescription ||
    `Auto-created by set_permission_scheme.js (lockdown) on ${new Date().toISOString()}. Restore by running 'revert' against the output JSON.`;

  // Build the holders that should retain BROWSE-level visibility during lockdown.
  // At least ONE holder is required — without it nobody can see anything (including admins via project perms).
  const browseHolders = [];
  if (options.browseGroups && options.browseGroups.length > 0) {
    for (const g of options.browseGroups) {
      browseHolders.push({ type: "group", parameter: g });
    }
  }
  if (options.browseAccountIds && options.browseAccountIds.length > 0) {
    for (const a of options.browseAccountIds) {
      browseHolders.push({ type: "user", parameter: a });
    }
  }
  if (options.browseAppRoles && options.browseAppRoles.length > 0) {
    for (const r of options.browseAppRoles) {
      browseHolders.push({ type: "applicationRole", parameter: r });
    }
  }
  if (browseHolders.length === 0) {
    // Sensible default: any licensed Jira Software user keeps read access
    browseHolders.push({
      type: "applicationRole",
      parameter: "jira-software-users",
    });
  }

  // Read-only permission set. BROWSE_PROJECTS is the gate — without it, no other read perm matters.
  // Other perms widen what an authenticated user can SEE (workflow viz, dev tools, aggregated data).
  // No write/transition/comment/attachment perms are granted.
  const readOnlyPerms = [
    "BROWSE_PROJECTS",
    "VIEW_READONLY_WORKFLOW",
    "VIEW_DEV_TOOLS",
    "VIEW_AGGREGATED_DATA",
  ];

  const permissions = [];
  for (const permission of readOnlyPerms) {
    for (const holder of browseHolders) {
      permissions.push({ holder, permission });
    }
  }

  // Admin escape-hatch — keep an admin group able to ADMINISTER_PROJECTS so the lockdown is recoverable
  // from the UI without having to wait for the revert script to run.
  if (options.adminGroups && options.adminGroups.length > 0) {
    for (const g of options.adminGroups) {
      permissions.push({
        holder: { type: "group", parameter: g },
        permission: "ADMINISTER_PROJECTS",
      });
    }
  }

  const body = { name, description, permissions };
  const response = await makeRequest(
    baseUrl,
    apiToken,
    "POST",
    "/rest/api/3/permissionscheme",
    body,
  );
  return response.data;
}

// Format permission scheme info for display
function formatSchemeInfo(scheme) {
  if (!scheme) {
    return "None";
  }
  return `${scheme.name} (ID: ${scheme.id})`;
}

// SET MODE: Main execution for setting permission schemes
async function setMode(baseUrl, targetSchemeId, email, apiToken, options = {}) {
  console.log("🚀 SET PERMISSION SCHEME FOR PROJECTS");
  console.log("=====================================");
  console.log(`🔐 Target Permission Scheme ID: ${targetSchemeId}`);
  console.log(`🌐 Jira Instance: ${baseUrl}`);
  if (options.dryRun) {
    console.log("🔍 DRY RUN MODE - No changes will be made");
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

  try {
    // Step 1: Get all projects
    const projects = await getAllProjects(baseUrl, apiToken);
    stats.totalProjects = projects.length;

    if (projects.length === 0) {
      console.log("⚠️  No projects found.");
      return;
    }

    // Filter projects based on options
    let projectsToProcess = projects;

    if (options.projectKey) {
      projectsToProcess = projects.filter(
        (p) => p.key === options.projectKey.toUpperCase(),
      );
      if (projectsToProcess.length === 0) {
        console.error(`❌ Project with key '${options.projectKey}' not found`);
        process.exit(1);
      }
      console.log(`🎯 Processing single project: ${options.projectKey}`);
    } else if (options.projectPattern) {
      const pattern = new RegExp(options.projectPattern, "i");
      projectsToProcess = projects.filter((p) => pattern.test(p.key));
      if (projectsToProcess.length === 0) {
        console.error(
          `❌ No projects match pattern '${options.projectPattern}'`,
        );
        process.exit(1);
      }
      console.log(
        `🎯 Processing ${projectsToProcess.length} projects matching pattern: ${options.projectPattern}`,
      );
    }

    // Apply exclude pattern if specified
    if (options.excludePattern) {
      const excludePattern = new RegExp(options.excludePattern, "i");
      const beforeCount = projectsToProcess.length;
      projectsToProcess = projectsToProcess.filter(
        (p) => !excludePattern.test(p.key),
      );
      const excludedCount = beforeCount - projectsToProcess.length;
      if (excludedCount > 0) {
        console.log(
          `🚫 Excluded ${excludedCount} projects matching exclude pattern: ${options.excludePattern}`,
        );
      }
    }

    console.log("");
    console.log("🔧 Processing projects...");
    console.log("");

    // Step 2: For each project, get current permission scheme and set new one
    for (const project of projectsToProcess) {
      console.log(`📦 Project: ${project.key} (${project.name})`);

      // Get current permission scheme
      const currentSchemeResult = await getProjectPermissionScheme(
        baseUrl,
        apiToken,
        project.key,
      );

      if (!currentSchemeResult.success) {
        console.log(
          `   ❌ Failed to get current permission scheme: ${currentSchemeResult.error}`,
        );
        stats.failures++;
        stats.errors.push({
          project: project.key,
          operation: "get_scheme",
          error: currentSchemeResult.error,
        });
        stats.processedProjects++;
        continue;
      }

      const currentScheme = currentSchemeResult.data;
      const currentSchemeId = currentScheme?.id;

      // Check if already using target scheme
      if (currentSchemeId === parseInt(targetSchemeId, 10)) {
        console.log(
          `   ℹ️  Already using target permission scheme: ${formatSchemeInfo(currentScheme)}`,
        );
        stats.unchanged++;
        stats.processedProjects++;

        changes.push({
          project: project.key,
          projectName: project.name,
          before: currentScheme,
          after: currentScheme,
          status: "unchanged",
          message: "Already using target permission scheme",
        });

        console.log("");
        continue;
      }

      console.log(`   📋 Current: ${formatSchemeInfo(currentScheme)}`);

      // Set new permission scheme (unless dry run)
      if (options.dryRun) {
        console.log(
          `   🔍 Would change to: Permission Scheme ID ${targetSchemeId}`,
        );
        stats.skipped++;
        stats.processedProjects++;

        changes.push({
          project: project.key,
          projectName: project.name,
          before: currentScheme,
          after: { id: parseInt(targetSchemeId, 10) },
          status: "dry_run",
          message: "Dry run - no changes made",
        });
      } else {
        const setResult = await setProjectPermissionScheme(
          baseUrl,
          apiToken,
          project.key,
          targetSchemeId,
        );

        if (setResult.success) {
          console.log(`   ✅ Changed to: ${formatSchemeInfo(setResult.data)}`);
          stats.successful++;

          changes.push({
            project: project.key,
            projectName: project.name,
            before: currentScheme,
            after: setResult.data,
            status: "success",
            message: "Permission scheme updated successfully",
          });
        } else {
          console.log(
            `   ❌ Failed to set permission scheme: ${setResult.error}`,
          );
          stats.failures++;
          stats.errors.push({
            project: project.key,
            operation: "set_scheme",
            error: setResult.error,
          });

          changes.push({
            project: project.key,
            projectName: project.name,
            before: currentScheme,
            after: null,
            status: "failed",
            message: setResult.error,
          });
        }
      }

      stats.processedProjects++;
      console.log("");
    }

    // Step 3: Save results to file
    if (options.outputFile) {
      const outputPath = path.resolve(options.outputFile);
      const output = {
        metadata: {
          timestamp: new Date().toISOString(),
          mode: options.metadataMode || "set",
          jiraInstance: baseUrl,
          targetSchemeId: parseInt(targetSchemeId, 10),
          dryRun: options.dryRun || false,
          projectFilter: options.projectKey || options.projectPattern || "all",
          excludePattern: options.excludePattern || null,
          ...(options.extraMetadata || {}),
        },
        summary: stats,
        changes: changes,
      };

      fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf8");
      console.log(`💾 Results saved to: ${outputPath}`);
      console.log("");
    }

    // Step 4: Print summary
    printSummary(stats, changes, options.dryRun);

    console.log("");
    console.log("✅ Script completed successfully!");
  } catch (error) {
    console.error("");
    console.error("❌ FATAL ERROR:");
    console.error(error);
    process.exit(1);
  }
}

// REVERT MODE: Main execution for reverting permission schemes
async function revertMode(baseUrl, email, apiToken, options = {}) {
  console.log("🔄 REVERT PERMISSION SCHEMES FROM JSON");
  console.log("=====================================");
  console.log(`📁 Input File: ${options.inputFile}`);
  console.log(`🌐 Jira Instance: ${baseUrl}`);
  if (options.dryRun) {
    console.log("🔍 DRY RUN MODE - No changes will be made");
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

  try {
    // Step 1: Read and parse the input JSON file
    const inputPath = path.resolve(options.inputFile);
    if (!fs.existsSync(inputPath)) {
      console.error(`❌ Input file not found: ${inputPath}`);
      process.exit(1);
    }

    console.log("📖 Reading input file...");
    const inputData = JSON.parse(fs.readFileSync(inputPath, "utf8"));

    if (!inputData.changes || !Array.isArray(inputData.changes)) {
      console.error(
        "❌ Invalid input file format. Expected 'changes' array in JSON.",
      );
      process.exit(1);
    }

    // Filter changes to only include those that were actually changed
    const projectsToRevert = inputData.changes.filter(
      (change) =>
        change.status === "success" &&
        change.before &&
        change.before.id !== change.after?.id,
    );

    if (projectsToRevert.length === 0) {
      console.log(
        "⚠️  No projects to revert. The input file contains no successful changes.",
      );
      return;
    }

    console.log(
      `✅ Found ${projectsToRevert.length} projects to revert (out of ${inputData.changes.length} total changes)`,
    );
    console.log("");

    // Display original operation info
    if (inputData.metadata) {
      console.log("📋 Original Operation Info:");
      console.log(`   Timestamp: ${inputData.metadata.timestamp}`);
      console.log(`   Mode: ${inputData.metadata.mode || "set"}`);
      console.log(`   Target Scheme ID: ${inputData.metadata.targetSchemeId}`);
      console.log("");
    }

    stats.totalProjects = projectsToRevert.length;

    console.log("🔧 Reverting projects...");
    console.log("");

    // Step 2: For each project, revert to the original permission scheme
    for (const changeRecord of projectsToRevert) {
      const projectKey = changeRecord.project;
      const targetScheme = changeRecord.before; // Revert to "before" state

      console.log(`📦 Project: ${projectKey} (${changeRecord.projectName})`);

      if (!targetScheme || !targetScheme.id) {
        console.log(`   ⚠️  Skipping - no valid 'before' scheme to revert to`);
        stats.skipped++;
        stats.processedProjects++;

        changes.push({
          project: projectKey,
          projectName: changeRecord.projectName,
          before: changeRecord.after,
          after: null,
          status: "skipped",
          message: "No valid 'before' scheme to revert to",
        });

        console.log("");
        continue;
      }

      // Get current permission scheme to verify
      const currentSchemeResult = await getProjectPermissionScheme(
        baseUrl,
        apiToken,
        projectKey,
      );

      if (!currentSchemeResult.success) {
        console.log(
          `   ❌ Failed to get current permission scheme: ${currentSchemeResult.error}`,
        );
        stats.failures++;
        stats.errors.push({
          project: projectKey,
          operation: "get_scheme",
          error: currentSchemeResult.error,
        });
        stats.processedProjects++;
        continue;
      }

      const currentScheme = currentSchemeResult.data;

      console.log(`   📋 Current: ${formatSchemeInfo(currentScheme)}`);
      console.log(`   ↩️  Reverting to: ${formatSchemeInfo(targetScheme)}`);

      // Check if already at target scheme
      if (currentScheme?.id === targetScheme.id) {
        console.log(`   ℹ️  Already at target scheme, no change needed`);
        stats.unchanged++;
        stats.processedProjects++;

        changes.push({
          project: projectKey,
          projectName: changeRecord.projectName,
          before: currentScheme,
          after: currentScheme,
          status: "unchanged",
          message: "Already at target scheme",
        });

        console.log("");
        continue;
      }

      // Revert the permission scheme (unless dry run)
      if (options.dryRun) {
        console.log(`   🔍 Would revert to: ${formatSchemeInfo(targetScheme)}`);
        stats.skipped++;
        stats.processedProjects++;

        changes.push({
          project: projectKey,
          projectName: changeRecord.projectName,
          before: currentScheme,
          after: targetScheme,
          status: "dry_run",
          message: "Dry run - no changes made",
        });
      } else {
        const setResult = await setProjectPermissionScheme(
          baseUrl,
          apiToken,
          projectKey,
          targetScheme.id,
        );

        if (setResult.success) {
          console.log(`   ✅ Reverted to: ${formatSchemeInfo(setResult.data)}`);
          stats.successful++;

          changes.push({
            project: projectKey,
            projectName: changeRecord.projectName,
            before: currentScheme,
            after: setResult.data,
            status: "success",
            message: "Permission scheme reverted successfully",
          });
        } else {
          console.log(
            `   ❌ Failed to revert permission scheme: ${setResult.error}`,
          );
          stats.failures++;
          stats.errors.push({
            project: projectKey,
            operation: "revert_scheme",
            error: setResult.error,
          });

          changes.push({
            project: projectKey,
            projectName: changeRecord.projectName,
            before: currentScheme,
            after: null,
            status: "failed",
            message: setResult.error,
          });
        }
      }

      stats.processedProjects++;
      console.log("");
    }

    // Step 3: Save results to file
    if (options.outputFile) {
      const outputPath = path.resolve(options.outputFile);
      const output = {
        metadata: {
          timestamp: new Date().toISOString(),
          mode: "revert",
          jiraInstance: baseUrl,
          inputFile: options.inputFile,
          dryRun: options.dryRun || false,
          originalOperation: inputData.metadata || null,
        },
        summary: stats,
        changes: changes,
      };

      fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf8");
      console.log(`💾 Results saved to: ${outputPath}`);
      console.log("");
    }

    // Step 4: Print summary
    printSummary(stats, changes, options.dryRun, true);

    console.log("");
    console.log("✅ Revert completed successfully!");
  } catch (error) {
    console.error("");
    console.error("❌ FATAL ERROR:");
    console.error(error);
    process.exit(1);
  }
}

// LOCKDOWN MODE: Create a read-only permission scheme, then assign it to all (or filtered) projects.
// Output JSON is fully revert-compatible — feed it back into `revert` mode to roll back.
async function lockdownMode(baseUrl, email, apiToken, options = {}) {
  console.log("🔒 LOCKDOWN — create read-only scheme + assign to projects");
  console.log("=====================================");
  console.log(`🌐 Jira Instance: ${baseUrl}`);
  if (options.dryRun) {
    console.log("🔍 DRY RUN MODE — no scheme will be created, no projects modified");
  }
  console.log("");

  let createdScheme = null;
  let targetSchemeId;

  if (options.dryRun) {
    // We can't materialize the scheme without mutating; preview the payload instead.
    console.log("🔧 (dry-run) Would create read-only permission scheme with:");
    console.log(`   name: ${options.schemeName || "Read-Only Lockdown <ts>"}`);
    console.log(
      `   browse holders: ${
        [
          ...(options.browseGroups || []).map((g) => `group:${g}`),
          ...(options.browseAccountIds || []).map((a) => `user:${a}`),
          ...(options.browseAppRoles || []).map((r) => `appRole:${r}`),
        ].join(", ") || "appRole:jira-software-users (default)"
      }`,
    );
    if (options.adminGroups && options.adminGroups.length > 0) {
      console.log(
        `   admin escape-hatch: ${options.adminGroups
          .map((g) => `group:${g}`)
          .join(", ")} → ADMINISTER_PROJECTS`,
      );
    }
    console.log("");
    // Use placeholder ID 0 so setMode's dry-run path can render expected diffs.
    targetSchemeId = "0";
  } else {
    console.log("🔧 Creating read-only permission scheme on Cloud...");
    try {
      createdScheme = await createReadOnlyScheme(baseUrl, apiToken, options);
      console.log(
        `✅ Created scheme: ${createdScheme.name} (ID: ${createdScheme.id})`,
      );
      console.log(
        `   self: ${createdScheme.self || `${baseUrl}/rest/api/3/permissionscheme/${createdScheme.id}`}`,
      );
      console.log("");
      targetSchemeId = String(createdScheme.id);
    } catch (err) {
      console.error("❌ Failed to create read-only permission scheme:");
      console.error(`   ${err.message}`);
      process.exit(1);
    }
  }

  // Delegate to setMode — same per-project loop, same revert-compatible output shape.
  // Tagged metadata so the JSON makes the lockdown origin obvious.
  await setMode(baseUrl, targetSchemeId, email, apiToken, {
    projectKey: options.projectKey,
    projectPattern: options.projectPattern,
    excludePattern: options.excludePattern,
    dryRun: options.dryRun,
    outputFile: options.outputFile,
    metadataMode: "lockdown",
    extraMetadata: {
      createdScheme: createdScheme
        ? {
            id: createdScheme.id,
            name: createdScheme.name,
            description: createdScheme.description,
            self: createdScheme.self,
          }
        : null,
      lockdownConfig: {
        browseGroups: options.browseGroups || [],
        browseAccountIds: options.browseAccountIds || [],
        browseAppRoles: options.browseAppRoles || [],
        adminGroups: options.adminGroups || [],
        schemeName: options.schemeName || null,
      },
    },
  });

  if (createdScheme) {
    console.log("");
    console.log("🔑 Lockdown scheme reference (keep this for the audit trail):");
    console.log(`   ID:   ${createdScheme.id}`);
    console.log(`   Name: ${createdScheme.name}`);
    console.log("");
    console.log(
      `↩️  To restore: node ${path.basename(__filename)} revert --url ${baseUrl} --email <...> --token <...> --input-file ${options.outputFile}`,
    );
  }
}

// Print summary statistics and changes
function printSummary(stats, changes, isDryRun, isRevert = false) {
  console.log("📊 SUMMARY");
  console.log("=====================================");
  console.log(`Total Projects: ${stats.totalProjects}`);
  console.log(`Processed Projects: ${stats.processedProjects}`);
  console.log(`Already at Target: ${stats.unchanged}`);
  console.log(
    `Successfully ${isRevert ? "Reverted" : "Updated"}: ${stats.successful}`,
  );
  if (isDryRun) {
    console.log(
      `Would ${isRevert ? "Revert" : "Update"} (Dry Run): ${stats.skipped}`,
    );
  }
  console.log(`Failures: ${stats.failures}`);
  console.log("");

  if (stats.errors.length > 0) {
    console.log("❌ ERRORS:");
    for (const error of stats.errors.slice(0, 10)) {
      console.log(`   ${error.project} (${error.operation}): ${error.error}`);
    }
    if (stats.errors.length > 10) {
      console.log(`   ... and ${stats.errors.length - 10} more errors`);
    }
    console.log("");
  }

  // Print before/after table for changed projects
  const changedProjects = changes.filter(
    (c) => c.status === "success" || c.status === "dry_run",
  );
  if (changedProjects.length > 0) {
    console.log(`📋 PERMISSION SCHEME ${isRevert ? "REVERTS" : "CHANGES"}:`);
    console.log("=====================================");
    for (const change of changedProjects) {
      console.log(`\n${change.project} (${change.projectName})`);
      console.log(`  Before: ${formatSchemeInfo(change.before)}`);
      console.log(`  After:  ${formatSchemeInfo(change.after)}`);
      if (change.status === "dry_run") {
        console.log(`  Status: DRY RUN - No changes made`);
      }
    }
    console.log("");
  }
}

// ── Auth resolver (used by the revert-from-dc-backup command) ──────────────────
// Accepts either --basic-auth <pre-base64-encoded "email:token"> OR --email + --token.
// Returns the value to put after "Basic ".
function resolveCloudBasicAuth(options) {
  const preEncoded = (
    options.basicAuth ||
    process.env.JIRA_CLOUD_BASIC_AUTH ||
    ""
  ).trim();
  if (preEncoded) return preEncoded;

  if (!options.email || !options.token) {
    console.error(
      "❌ Missing auth. Provide either --basic-auth <pre-base64-encoded 'email:token'> " +
        "(or env JIRA_CLOUD_BASIC_AUTH), or both --email <email> and --token <token>.",
    );
    process.exit(1);
  }
  return Buffer.from(`${options.email}:${options.token}`).toString("base64");
}

// Fetch every Cloud permission scheme (all at once — endpoint isn't paginated).
async function getAllCloudPermissionSchemes(baseUrl, apiToken) {
  const res = await makeRequest(
    baseUrl,
    apiToken,
    "GET",
    "/rest/api/3/permissionscheme",
  );
  // Cloud returns { permissionSchemes: [...] }
  return res.data?.permissionSchemes || [];
}

// REVERT-FROM-DC-BACKUP MODE
// Reads a backup JSON produced by the DC tool (set-read-only-dc/set_permission_scheme_dc.js
// `set` command) and re-applies each project's ORIGINAL scheme on Cloud by matching the
// scheme NAME (since IDs don't survive migration).
async function revertFromDcBackupMode(baseUrl, apiToken, options = {}) {
  console.log("🔄 REVERT FROM DC BACKUP — apply original schemes by NAME");
  console.log("=====================================");
  console.log(`🌐 Jira Cloud: ${baseUrl}`);
  console.log(`📁 DC backup file: ${options.inputFile}`);
  if (options.dryRun) console.log("🔍 DRY RUN — no projects will be changed");
  console.log("");

  const inputPath = path.resolve(options.inputFile);
  if (!fs.existsSync(inputPath)) {
    console.error(`❌ Input file not found: ${inputPath}`);
    process.exit(1);
  }
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  if (!Array.isArray(input.changes)) {
    console.error("❌ Invalid backup: missing 'changes' array.");
    process.exit(1);
  }

  // Only consider projects whose DC `set` actually moved them off something — those are
  // the ones we need to put back on Cloud. Their `before.name` is the scheme to match.
  const candidates = input.changes.filter(
    (c) =>
      c.status === "success" &&
      c.before &&
      c.before.name &&
      c.before.id !== c.after?.id,
  );

  if (candidates.length === 0) {
    console.log("⚠️  No revertable entries in the backup. Nothing to do.");
    return;
  }

  console.log(
    `✅ ${candidates.length} project(s) to revert (out of ${input.changes.length} total in backup)`,
  );
  if (input.metadata) {
    console.log(`   Backup created at:  ${input.metadata.timestamp}`);
    console.log(`   Source DC instance: ${input.metadata.jiraInstance}`);
  }
  console.log("");

  // Step 1: build a NAME -> Cloud-scheme-id map
  console.log("📚 Fetching Cloud permission schemes for name lookup...");
  let cloudSchemes;
  try {
    cloudSchemes = await getAllCloudPermissionSchemes(baseUrl, apiToken);
  } catch (e) {
    console.error(`❌ Failed to list Cloud permission schemes: ${e.message}`);
    process.exit(1);
  }
  console.log(`✅ Found ${cloudSchemes.length} permission scheme(s) on Cloud`);

  // Build a case-insensitive name -> [matches] map so we can detect ambiguity.
  const byName = new Map();
  for (const s of cloudSchemes) {
    const k = (s.name || "").toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(s);
  }

  function lookupSchemeByName(name) {
    const matches = byName.get((name || "").toLowerCase()) || [];
    if (matches.length === 0) return { match: null, ambiguous: false };
    if (matches.length === 1) return { match: matches[0], ambiguous: false };
    // Prefer exact case match first, then fall back to first.
    const exact = matches.find((m) => m.name === name);
    return { match: exact || matches[0], ambiguous: true, count: matches.length };
  }

  // Step 2: for each candidate, look up the scheme by name and assign.
  const stats = {
    totalProjects: candidates.length,
    processedProjects: 0,
    unchanged: 0,
    successful: 0,
    failures: 0,
    skipped: 0,
    notFoundProject: 0,
    unmappedScheme: 0,
    ambiguous: 0,
    errors: [],
  };
  const changes = [];
  const unmappedNames = new Set();

  console.log("");
  console.log("🔧 Re-applying original schemes...");
  console.log("");

  for (const rec of candidates) {
    const projectKey = rec.project;
    const targetName = rec.before.name;
    console.log(`📦 ${projectKey} (${rec.projectName || ""})`);
    console.log(`   ↩️  Target scheme name: "${targetName}"`);

    const { match, ambiguous, count } = lookupSchemeByName(targetName);
    if (!match) {
      console.log(
        `   ⚠️  [UNMAPPED] No Cloud scheme named "${targetName}". Skipping.`,
      );
      unmappedNames.add(targetName);
      stats.unmappedScheme++;
      stats.processedProjects++;
      changes.push({
        project: projectKey,
        projectName: rec.projectName,
        before: null,
        after: null,
        targetName,
        status: "unmapped_scheme",
        message: `No Cloud scheme found with name "${targetName}"`,
      });
      console.log("");
      continue;
    }
    if (ambiguous) {
      console.log(
        `   ⚠️  Ambiguous: ${count} Cloud schemes match "${targetName}". Using ID ${match.id}.`,
      );
      stats.ambiguous++;
    }

    // Look up current Cloud scheme for diff/skip-if-same.
    const currentRes = await getProjectPermissionScheme(
      baseUrl,
      apiToken,
      projectKey,
    );
    if (!currentRes.success) {
      // Project might not exist on Cloud (e.g. excluded from migration).
      const isNotFound = /HTTP 404/.test(currentRes.error || "");
      console.log(
        `   ${isNotFound ? "⚠️  [NOT FOUND]" : "❌ get_scheme failed:"} ${currentRes.error}`,
      );
      if (isNotFound) {
        stats.notFoundProject++;
        changes.push({
          project: projectKey,
          projectName: rec.projectName,
          before: null,
          after: null,
          targetName,
          status: "project_not_found",
          message: currentRes.error,
        });
      } else {
        stats.failures++;
        stats.errors.push({
          project: projectKey,
          operation: "get_scheme",
          error: currentRes.error,
        });
      }
      stats.processedProjects++;
      console.log("");
      continue;
    }
    const before = currentRes.data;

    console.log(`   📋 Current: ${formatSchemeInfo(before)}`);
    console.log(`   🎯 Will set to: ${formatSchemeInfo(match)}`);

    if (before?.id === match.id) {
      console.log(`   ℹ️  Already on target scheme — no change needed`);
      stats.unchanged++;
      stats.processedProjects++;
      changes.push({
        project: projectKey,
        projectName: rec.projectName,
        before,
        after: before,
        targetName,
        status: "unchanged",
        message: "Already on target scheme",
      });
      console.log("");
      continue;
    }

    if (options.dryRun) {
      console.log(`   🔍 Would set to: ${formatSchemeInfo(match)}`);
      stats.skipped++;
      stats.processedProjects++;
      changes.push({
        project: projectKey,
        projectName: rec.projectName,
        before,
        after: { id: match.id, name: match.name },
        targetName,
        status: "dry_run",
        message: "Dry run",
      });
      console.log("");
      continue;
    }

    const setRes = await setProjectPermissionScheme(
      baseUrl,
      apiToken,
      projectKey,
      match.id,
    );
    if (setRes.success) {
      console.log(`   ✅ Set to: ${formatSchemeInfo(setRes.data || match)}`);
      stats.successful++;
      changes.push({
        project: projectKey,
        projectName: rec.projectName,
        before,
        after: setRes.data || { id: match.id, name: match.name },
        targetName,
        status: "success",
        message: "Permission scheme restored from DC backup",
      });
    } else {
      console.log(`   ❌ set_scheme failed: ${setRes.error}`);
      stats.failures++;
      stats.errors.push({
        project: projectKey,
        operation: "set_scheme",
        error: setRes.error,
      });
      changes.push({
        project: projectKey,
        projectName: rec.projectName,
        before,
        after: null,
        targetName,
        status: "failed",
        message: setRes.error,
      });
    }
    stats.processedProjects++;
    console.log("");
  }

  // Save output JSON
  if (options.outputFile) {
    const outputPath = path.resolve(options.outputFile);
    fs.writeFileSync(
      outputPath,
      JSON.stringify(
        {
          metadata: {
            timestamp: new Date().toISOString(),
            mode: "revert-from-dc-backup",
            cloudInstance: baseUrl,
            inputFile: options.inputFile,
            dryRun: !!options.dryRun,
            dcBackupMetadata: input.metadata || null,
          },
          summary: {
            ...stats,
            unmappedSchemeNames: Array.from(unmappedNames),
          },
          changes,
        },
        null,
        2,
      ),
      "utf8",
    );
    console.log(`💾 Results saved to: ${outputPath}\n`);
  }

  // Summary
  console.log("📊 SUMMARY");
  console.log("=====================================");
  console.log(`Total candidates:        ${stats.totalProjects}`);
  console.log(`Already on target:       ${stats.unchanged}`);
  console.log(`Successfully restored:   ${stats.successful}`);
  if (options.dryRun) console.log(`Would restore (dry):     ${stats.skipped}`);
  console.log(`Project not found:       ${stats.notFoundProject}`);
  console.log(`Scheme name unmapped:    ${stats.unmappedScheme}`);
  console.log(`Ambiguous name matches:  ${stats.ambiguous}`);
  console.log(`Failures:                ${stats.failures}`);
  console.log("");

  if (unmappedNames.size > 0) {
    console.log("⚠️  Unmapped scheme names (no Cloud scheme with this name):");
    for (const n of unmappedNames) console.log(`   - "${n}"`);
    console.log(
      "   For these projects you'll need to either rename the Cloud scheme to match,",
    );
    console.log("   or assign the desired scheme manually.");
    console.log("");
  }

  console.log("✅ Revert-from-DC-backup completed.");
}

// ── BACKFILL-MISSING-SCHEMES ───────────────────────────────────────────────────
// Reach into a DC instance, fetch the *exact* definition of any permission
// scheme that's missing on Cloud (the `unmappedScheme` set surfaced by
// revert-from-dc-backup), translate the holders, and POST them onto Cloud.
//
// Decisions (locked in plan):
//   - DC -> Cloud only.
//   - User holders: deterministic via --user-map CSV (no /user/search fallback).
//     Unknown usernames are dropped and recorded.
//   - Group holders: always enriched with Cloud groupId via /rest/api/3/group/bulk.
//   - Dry-run by default. Live writes require --execute.
//   - No auto-chain into revert-from-dc-backup.
// ───────────────────────────────────────────────────────────────────────────────

// Resolve the DC Authorization header from the same flag/env conventions used
// by the DC script (`set-read-only-dc/set_permission_scheme_dc.js:47-71`).
// Precedence: --dc-pat > --dc-basic-auth > --dc-user/--dc-password.
function resolveDcAuthHeader(options) {
  const pat = (options.dcPat || process.env.JIRA_DC_PAT || "").trim();
  if (pat) return `Bearer ${pat}`;

  const preEncoded = (
    options.dcBasicAuth ||
    process.env.JIRA_DC_BASIC_AUTH ||
    ""
  ).trim();
  if (preEncoded) return `Basic ${preEncoded}`;

  const user = options.dcUser || process.env.JIRA_DC_USER;
  const password = options.dcPassword || process.env.JIRA_DC_PASSWORD;
  if (user && password) {
    return "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
  }

  console.error(
    "❌ No DC auth provided. Pass one of:\n" +
      "   --dc-pat <PAT>                 (or env JIRA_DC_PAT)\n" +
      "   --dc-basic-auth <base64>       (or env JIRA_DC_BASIC_AUTH)\n" +
      "   --dc-user <u> --dc-password <p>   (or env JIRA_DC_USER / JIRA_DC_PASSWORD)",
  );
  process.exit(1);
}

// Normalise a URL string into a "https://host" or "http://host" base with no trailing slash.
function normaliseFullBaseUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  let u = rawUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(u)) u = `https://${u}`;
  return u;
}

// Fetch a single DC permission scheme with the full grants array attached.
// Cloud (v3) and DC (v2) both honour `?expand=permissions,user,group,projectRole,field,all`.
async function fetchDcSchemeFull(dcFullBase, dcAuth, schemeId) {
  const res = await makeRawRequest(
    dcFullBase,
    dcAuth,
    "GET",
    `/rest/api/2/permissionscheme/${parseInt(schemeId, 10)}` +
      `?expand=permissions,user,group,projectRole,field,all`,
  );
  return res.data;
}

// Build a name -> id map for project roles on either platform.
// Cloud: GET /rest/api/3/role  -> [{id, name, ...}]
// DC:    GET /rest/api/2/role  -> [{id, name, ...}]
async function fetchProjectRolesMap(fullBaseUrl, authHeader, apiVersion) {
  const res = await makeRawRequest(
    fullBaseUrl,
    authHeader,
    "GET",
    `/rest/api/${apiVersion}/role`,
  );
  const list = Array.isArray(res.data) ? res.data : [];
  const byName = new Map();
  const byId = new Map();
  for (const r of list) {
    if (r && r.name) byName.set(r.name.toLowerCase(), r);
    if (r && (r.id || r.id === 0)) byId.set(String(r.id), r);
  }
  return { byName, byId, raw: list };
}

// Build a name -> id map for fields (custom fields included) on either platform.
// Cloud: GET /rest/api/3/field  -> [{id, name, custom, ...}]
// DC:    GET /rest/api/2/field  -> [{id, name, custom, ...}]
async function fetchFieldsMap(fullBaseUrl, authHeader, apiVersion) {
  const res = await makeRawRequest(
    fullBaseUrl,
    authHeader,
    "GET",
    `/rest/api/${apiVersion}/field`,
  );
  const list = Array.isArray(res.data) ? res.data : [];
  const byName = new Map();
  const byId = new Map();
  for (const f of list) {
    if (f && f.name) byName.set(f.name.toLowerCase(), f);
    if (f && f.id) byId.set(String(f.id), f);
  }
  return { byName, byId, raw: list };
}

// Cache-on-first-use lookup for Cloud groupId by name.
// Cloud: GET /rest/api/3/group/bulk?groupName=<name>  -> { values: [{groupId, name}], ... }
// We do one request per unique group name (cached) — group/bulk does support multiple
// `groupName` params, but iterating is simpler and the unique-group-count for these
// schemes is small (<100 in practice).
function makeCloudGroupIdResolver(cloudFullBase, cloudAuth) {
  const cache = new Map(); // lowercase name -> groupId | null

  return async function resolveCloudGroupId(groupName) {
    if (!groupName) return null;
    const k = groupName.toLowerCase();
    if (cache.has(k)) return cache.get(k);
    try {
      const res = await makeRawRequest(
        cloudFullBase,
        cloudAuth,
        "GET",
        `/rest/api/3/group/bulk?groupName=${encodeURIComponent(groupName)}`,
      );
      const values = res.data?.values || [];
      // Prefer exact (case-sensitive) match; fall back to first.
      const exact = values.find((v) => v.name === groupName);
      const chosen = exact || values[0];
      const id = chosen ? chosen.groupId : null;
      cache.set(k, id);
      return id;
    } catch (e) {
      // 404 / unknown group -> drop from grants.
      cache.set(k, null);
      return null;
    }
  };
}

// Parse the user-map CSV. Format:
//   dc_username,cloud_account_id
//   alice,5b10ac8d82e05b22cc7d4ef5
//   bob.jones,712020:abc-123
// Quoted fields and CR line endings are tolerated. Comments (lines starting with `#`)
// and blank lines are ignored. Header line is auto-detected (column names matching
// /dc.*user/ or /account/i).
function parseUserMapCsv(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const map = new Map(); // dc_username (lowercase) -> cloud_account_id
  const lines = text.split(/\r?\n/);
  let headerSkipped = false;
  for (let raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // Naive CSV split — supports unquoted and double-quoted values, no embedded commas inside unquoted.
    const cols = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }
      if (ch === "," && !inQuotes) {
        cols.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    cols.push(cur);
    if (cols.length < 2) continue;
    const a = cols[0].trim();
    const b = cols[1].trim();
    if (!a || !b) continue;
    if (!headerSkipped && /user|name/i.test(a) && /account|id/i.test(b)) {
      headerSkipped = true;
      continue;
    }
    headerSkipped = true;
    map.set(a.toLowerCase(), b);
  }
  return map;
}

// Translate a single DC `permissions[]` entry into a Cloud `permissions[]` entry,
// returning either { ok: true, grant } OR { ok: false, drop: { reason, original } }.
//
// Pure function — no side-effect networking. The caller pre-resolves group IDs etc.
// and threads them in via `ctx`.
//
// Holder contract (per the v3 docs at
// https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-permission-schemes/):
//   group:                parameter = group name, value = groupId
//   user:                 parameter = accountId,  value = accountId
//   projectRole:          parameter = role id (str), value = role id (str)
//   applicationRole:      parameter = app role key (e.g. jira-software-users)
//   anyone/assignee/reporter/projectLead/sd.customer.portal.only: no parameter
//   groupCustomField/userCustomField: parameter = custom field id
// Canonical built-in Cloud permission keys (Jira Cloud v3, May 2026).
// Source: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-permission-schemes/
// Anything NOT in this set will be dropped at translation time with a clear
// audit-log reason — common DC-only keys that don't exist on Cloud include
// PROJECT_LOG_WORK_FOR_OTHERS, PROJECT_VIEW_ALL_WORKLOGS, VERSION_MANAGER, etc.
const CLOUD_SUPPORTED_PERMISSIONS = new Set([
  // Administration
  "ADMINISTER_PROJECTS", "EDIT_WORKFLOW", "EDIT_ISSUE_LAYOUT",
  // Project
  "BROWSE_PROJECTS", "MANAGE_SPRINTS_PERMISSION", "SERVICEDESK_AGENT",
  "VIEW_DEV_TOOLS", "VIEW_READONLY_WORKFLOW", "VIEW_AGGREGATED_DATA",
  // Issue
  "ASSIGNABLE_USER", "ASSIGN_ISSUES", "CLOSE_ISSUES", "CREATE_ISSUES",
  "DELETE_ISSUES", "EDIT_ISSUES", "LINK_ISSUES", "MODIFY_REPORTER",
  "MOVE_ISSUES", "RESOLVE_ISSUES", "SCHEDULE_ISSUES",
  "SET_ISSUE_SECURITY", "TRANSITION_ISSUES",
  // Voters/watchers
  "MANAGE_WATCHERS", "VIEW_VOTERS_AND_WATCHERS",
  // Comments
  "ADD_COMMENTS", "DELETE_ALL_COMMENTS", "DELETE_OWN_COMMENTS",
  "EDIT_ALL_COMMENTS", "EDIT_OWN_COMMENTS",
  // Attachments
  "CREATE_ATTACHMENTS", "DELETE_ALL_ATTACHMENTS", "DELETE_OWN_ATTACHMENTS",
  // Time tracking
  "DELETE_ALL_WORKLOGS", "DELETE_OWN_WORKLOGS",
  "EDIT_ALL_WORKLOGS", "EDIT_OWN_WORKLOGS", "WORK_ON_ISSUES",
  // Service Management bypass perm (granted to portal customers)
  "SERVICE_PROJECT_AGENT",
]);

function translateGrantToCloud(grant, ctx) {
  const holder = grant.holder || {};
  const type = holder.type;
  const param = holder.parameter;
  const permission = grant.permission;
  if (!type || !permission) {
    return { ok: false, drop: { reason: "missing type or permission", original: grant } };
  }
  if (!CLOUD_SUPPORTED_PERMISSIONS.has(permission)) {
    return {
      ok: false,
      drop: {
        reason: `permission "${permission}" not supported on Cloud (DC-only)`,
        original: grant,
      },
    };
  }

  const baseGrant = (newHolder) => ({
    holder: newHolder,
    permission,
  });

  switch (type) {
    case "anyone":
    case "assignee":
    case "reporter":
    case "projectLead":
    case "sd.customer.portal.only":
      return { ok: true, grant: baseGrant({ type }) };

    case "applicationRole": {
      // Pass through — same canonical keys (jira-software-users, etc.).
      if (!param) {
        return { ok: false, drop: { reason: "applicationRole has no parameter", original: grant } };
      }
      return { ok: true, grant: baseGrant({ type, parameter: param }) };
    }

    case "group": {
      if (!param) {
        return { ok: false, drop: { reason: "group has no parameter", original: grant } };
      }
      // We resolve the Cloud groupId for the audit/cache only — Cloud's POST
      // rejects holders that include BOTH `parameter` and `value` ("mutually
      // exclusive"). The proven-working format is `parameter`-only with the
      // group NAME (matches the existing createReadOnlyScheme() in this file).
      const groupId = ctx.cloudGroupIds.get(param.toLowerCase());
      if (!groupId) {
        return {
          ok: false,
          drop: { reason: `group "${param}" not found on Cloud`, original: grant },
        };
      }
      return { ok: true, grant: baseGrant({ type, parameter: param }) };
    }

    case "user": {
      if (!param) {
        return { ok: false, drop: { reason: "user has no parameter (username)", original: grant } };
      }
      const accountId = ctx.userMap.get(param.toLowerCase());
      if (!accountId) {
        return {
          ok: false,
          drop: { reason: `user "${param}" not in --user-map`, original: grant },
        };
      }
      // Cloud expects accountId in `parameter` for type:user. Sending `value`
      // alone yields "null is not a valid account ID".
      return { ok: true, grant: baseGrant({ type, parameter: accountId }) };
    }

    case "projectRole": {
      if (param === undefined || param === null || param === "") {
        return { ok: false, drop: { reason: "projectRole has no parameter", original: grant } };
      }
      const dcRole = ctx.dcRoles.byId.get(String(param));
      if (!dcRole) {
        return {
          ok: false,
          drop: { reason: `projectRole id "${param}" not found on DC`, original: grant },
        };
      }
      const cloudRole = ctx.cloudRoles.byName.get((dcRole.name || "").toLowerCase());
      if (!cloudRole) {
        return {
          ok: false,
          drop: {
            reason: `projectRole "${dcRole.name}" not found on Cloud`,
            original: grant,
          },
        };
      }
      return {
        ok: true,
        grant: baseGrant({ type, parameter: String(cloudRole.id) }),
      };
    }

    case "groupCustomField":
    case "userCustomField": {
      if (!param) {
        return { ok: false, drop: { reason: `${type} has no parameter`, original: grant } };
      }
      const dcField = ctx.dcFields.byId.get(String(param));
      if (!dcField) {
        return {
          ok: false,
          drop: { reason: `${type} id "${param}" not found on DC`, original: grant },
        };
      }
      const cloudField = ctx.cloudFields.byName.get((dcField.name || "").toLowerCase());
      if (!cloudField) {
        return {
          ok: false,
          drop: {
            reason: `${type} "${dcField.name}" not found on Cloud`,
            original: grant,
          },
        };
      }
      return {
        ok: true,
        grant: baseGrant({ type, parameter: String(cloudField.id) }),
      };
    }

    default:
      return { ok: false, drop: { reason: `unknown holder type "${type}"`, original: grant } };
  }
}

// Deduplicate translated grants by stable (type|parameter|value|permission) key.
function dedupeGrants(grants) {
  const seen = new Map();
  for (const g of grants) {
    const h = g.holder || {};
    const k = [h.type, h.parameter || "", h.value || "", g.permission].join("|");
    if (!seen.has(k)) seen.set(k, g);
  }
  return Array.from(seen.values());
}

// MAIN: backfill missing schemes from DC into Cloud.
async function backfillMissingSchemesMode(options) {
  const cloudFullBase = normaliseFullBaseUrl(options.cloudUrl);
  const dcFullBase = normaliseFullBaseUrl(options.dcUrl);
  const cloudAuthHeader = `Basic ${resolveCloudBasicAuth({
    basicAuth: options.basicAuth,
    email: options.email,
    token: options.token,
  })}`;
  const dcAuthHeader = resolveDcAuthHeader(options);
  const isExecute = !!options.execute;

  console.log("🛠️  BACKFILL MISSING SCHEMES — DC → Cloud");
  console.log("=====================================");
  console.log(`☁️  Cloud:        ${cloudFullBase}`);
  console.log(`🏢 Datacenter:   ${dcFullBase}`);
  console.log(`📁 DC backup:    ${options.inputFile}`);
  if (options.userMap) console.log(`👤 user-map:     ${options.userMap}`);
  if (options.only) console.log(`🎯 --only:       "${options.only}"`);
  if (options.namePrefix) console.log(`🏷️  name-prefix: "${options.namePrefix}"`);
  console.log(
    isExecute
      ? "⚡ EXECUTE MODE — schemes WILL be created on Cloud."
      : "🔍 DRY RUN — no Cloud writes will happen. Pass --execute to commit.",
  );
  console.log("");

  // ── 1. Read the DC backup JSON the operator provided. ────────────────────────
  const inputPath = path.resolve(options.inputFile);
  if (!fs.existsSync(inputPath)) {
    console.error(`❌ Input file not found: ${inputPath}`);
    process.exit(1);
  }
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  if (!Array.isArray(input.changes)) {
    console.error("❌ Invalid backup: missing 'changes' array.");
    process.exit(1);
  }

  // ── 2. Identify the unique (name, dcId) pairs that look "interesting". ───────
  // Same shape revertFromDcBackupMode uses — projects whose DC `set` actually
  // moved them off something. The `before.id` is the DC scheme id we'll fetch.
  const candidatesByName = new Map(); // lowercase name -> { name, dcId, projects[] }
  for (const c of input.changes) {
    if (
      c.status !== "success" ||
      !c.before ||
      !c.before.name ||
      c.before.id === c.after?.id
    ) {
      continue;
    }
    const k = c.before.name.toLowerCase();
    if (!candidatesByName.has(k)) {
      candidatesByName.set(k, {
        name: c.before.name,
        dcId: c.before.id,
        projects: [],
      });
    }
    candidatesByName.get(k).projects.push(c.project);
  }
  if (candidatesByName.size === 0) {
    console.log("⚠️  No revertable entries in the backup. Nothing to backfill.");
    return;
  }
  console.log(`✅ ${candidatesByName.size} distinct DC scheme name(s) referenced by the backup.`);

  // ── 3. Build the Cloud name -> scheme map (for idempotency / unmapped detection). ───
  console.log("📚 Listing Cloud permission schemes for name lookup...");
  const cloudSchemes = await getAllCloudPermissionSchemes(
    cloudFullBase.replace(/^https?:\/\//, ""),
    cloudAuthHeader.replace(/^Basic\s+/, ""),
  );
  console.log(`✅ Found ${cloudSchemes.length} Cloud permission scheme(s)`);
  const cloudByName = new Map();
  for (const s of cloudSchemes) {
    if (s.name) cloudByName.set(s.name.toLowerCase(), s);
  }

  // ── 4. Filter to only the unmapped names — the ones we actually need to backfill. ───
  const onlyFilter = options.only ? options.only.toLowerCase() : null;
  const targets = [];
  for (const [k, info] of candidatesByName) {
    if (onlyFilter && k !== onlyFilter) continue;
    if (cloudByName.has(k)) continue; // Already exists on Cloud — skip (idempotent).
    targets.push(info);
  }
  if (targets.length === 0) {
    console.log("✅ No missing schemes to backfill — every DC scheme name already exists on Cloud.");
    return;
  }
  console.log(`🎯 ${targets.length} scheme name(s) missing on Cloud — will fetch from DC.`);
  console.log("");

  // ── 5. Build the cross-platform mapping infrastructure once, up-front. ───────
  console.log("🗺️  Building cross-platform maps (roles, fields, groups, users)...");
  const [dcRoles, cloudRoles, dcFields, cloudFields] = await Promise.all([
    fetchProjectRolesMap(dcFullBase, dcAuthHeader, 2),
    fetchProjectRolesMap(cloudFullBase, cloudAuthHeader, 3),
    fetchFieldsMap(dcFullBase, dcAuthHeader, 2),
    fetchFieldsMap(cloudFullBase, cloudAuthHeader, 3),
  ]);
  console.log(
    `   roles:  DC ${dcRoles.raw.length} / Cloud ${cloudRoles.raw.length}`,
  );
  console.log(
    `   fields: DC ${dcFields.raw.length} / Cloud ${cloudFields.raw.length}`,
  );

  let userMap = new Map();
  if (options.userMap) {
    const userMapPath = path.resolve(options.userMap);
    if (!fs.existsSync(userMapPath)) {
      console.error(`❌ --user-map file not found: ${userMapPath}`);
      process.exit(1);
    }
    userMap = parseUserMapCsv(userMapPath);
    console.log(`   users: ${userMap.size} entries from ${options.userMap}`);
  } else {
    console.log("   users: (no --user-map — every 'user' grant will be dropped)");
  }

  const resolveCloudGroupId = makeCloudGroupIdResolver(
    cloudFullBase,
    cloudAuthHeader,
  );

  // ── 6. For each target: fetch DC scheme, translate, optionally POST. ─────────
  const results = [];
  let createdCount = 0;
  let dryPlannedCount = 0;
  let failedCount = 0;
  let alreadyExistsCount = 0; // (race-condition guard — should be 0 normally)

  for (const target of targets) {
    console.log(`\n📦 "${target.name}" (DC id: ${target.dcId})`);
    console.log(`   Used by ${target.projects.length} project(s) in the backup.`);

    let dcScheme;
    try {
      dcScheme = await fetchDcSchemeFull(dcFullBase, dcAuthHeader, target.dcId);
    } catch (err) {
      console.log(`   ❌ Failed to fetch DC scheme: ${err.message}`);
      failedCount++;
      results.push({
        sourceName: target.name,
        sourceDcId: target.dcId,
        affectedProjects: target.projects,
        status: "fetch_failed",
        error: err.message,
      });
      continue;
    }
    const dcGrants = Array.isArray(dcScheme.permissions) ? dcScheme.permissions : [];
    console.log(`   📥 DC has ${dcGrants.length} grant(s) on this scheme.`);

    // Pre-resolve every Cloud groupId for the unique groups in this scheme.
    const uniqueGroupNames = new Set();
    for (const g of dcGrants) {
      if (g?.holder?.type === "group" && g.holder.parameter) {
        uniqueGroupNames.add(g.holder.parameter);
      }
    }
    const cloudGroupIds = new Map();
    for (const name of uniqueGroupNames) {
      const id = await resolveCloudGroupId(name);
      cloudGroupIds.set(name.toLowerCase(), id);
    }

    // Translate grants.
    const ctx = { dcRoles, cloudRoles, dcFields, cloudFields, userMap, cloudGroupIds };
    const translatedGrants = [];
    const droppedGrants = [];
    for (const g of dcGrants) {
      const out = translateGrantToCloud(g, ctx);
      if (out.ok) translatedGrants.push(out.grant);
      else droppedGrants.push(out.drop);
    }
    const finalGrants = dedupeGrants(translatedGrants);
    console.log(
      `   🔁 Translated: kept ${finalGrants.length}, dropped ${droppedGrants.length}` +
        (translatedGrants.length !== finalGrants.length
          ? ` (${translatedGrants.length - finalGrants.length} duplicates collapsed)`
          : ""),
    );
    if (droppedGrants.length > 0) {
      const sample = droppedGrants.slice(0, 5);
      for (const d of sample) console.log(`     • DROP — ${d.reason}`);
      if (droppedGrants.length > sample.length) {
        console.log(`     • ...and ${droppedGrants.length - sample.length} more`);
      }
    }

    const cloudSchemeBody = {
      name: (options.namePrefix || "") + target.name,
      description:
        (dcScheme.description ? `${dcScheme.description} ` : "") +
        `[Backfilled from DC scheme id ${target.dcId} on ${new Date().toISOString()}]`,
      permissions: finalGrants,
    };

    if (!isExecute) {
      console.log(`   📝 (dry-run) Would POST /rest/api/3/permissionscheme on Cloud:`);
      console.log(`        name:        "${cloudSchemeBody.name}"`);
      console.log(`        description: "${cloudSchemeBody.description}"`);
      console.log(`        permissions: ${cloudSchemeBody.permissions.length} grants`);
      dryPlannedCount++;
      results.push({
        sourceName: target.name,
        sourceDcId: target.dcId,
        affectedProjects: target.projects,
        status: "planned",
        plannedBody: cloudSchemeBody,
        droppedGrants,
      });
      continue;
    }

    // Live POST.
    try {
      const res = await makeRawRequest(
        cloudFullBase,
        cloudAuthHeader,
        "POST",
        `/rest/api/3/permissionscheme`,
        cloudSchemeBody,
      );
      const created = res.data || {};
      console.log(
        `   ✅ Created Cloud scheme: ${created.name} (ID: ${created.id})`,
      );
      createdCount++;
      results.push({
        sourceName: target.name,
        sourceDcId: target.dcId,
        affectedProjects: target.projects,
        status: "created",
        cloudSchemeId: created.id,
        cloudSchemeName: created.name,
        permissionsCreated: cloudSchemeBody.permissions.length,
        droppedGrants,
      });
    } catch (err) {
      // 409 from Cloud means the name is already taken — treat as "already exists".
      if (/HTTP\s+409/.test(err.message)) {
        console.log(`   ⚠️  Cloud rejected as duplicate name — counting as already_exists.`);
        alreadyExistsCount++;
        results.push({
          sourceName: target.name,
          sourceDcId: target.dcId,
          affectedProjects: target.projects,
          status: "already_exists",
          error: err.message,
          droppedGrants,
        });
        continue;
      }
      console.log(`   ❌ Cloud POST failed: ${err.message}`);
      failedCount++;
      results.push({
        sourceName: target.name,
        sourceDcId: target.dcId,
        affectedProjects: target.projects,
        status: "post_failed",
        error: err.message,
        plannedBody: cloudSchemeBody,
        droppedGrants,
      });
    }
  }

  // ── 7. Write the audit JSON. ────────────────────────────────────────────────
  const outputPath = path.resolve(
    options.outputFile ||
      `backfill_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`,
  );
  const payload = {
    metadata: {
      timestamp: new Date().toISOString(),
      mode: "backfill-missing-schemes",
      cloudInstance: cloudFullBase,
      dcInstance: dcFullBase,
      inputFile: options.inputFile,
      execute: isExecute,
      onlyFilter: options.only || null,
      namePrefix: options.namePrefix || null,
      userMapFile: options.userMap || null,
      userMapEntries: userMap.size,
    },
    summary: {
      candidatesInBackup: candidatesByName.size,
      missingOnCloud: targets.length,
      created: createdCount,
      planned: dryPlannedCount,
      alreadyExists: alreadyExistsCount,
      failed: failedCount,
    },
    results,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`\n💾 Audit written to: ${outputPath}`);

  // ── 8. Final stdout summary. ────────────────────────────────────────────────
  console.log("");
  console.log("📊 SUMMARY");
  console.log("=====================================");
  console.log(`Distinct names in backup:  ${candidatesByName.size}`);
  console.log(`Missing on Cloud:          ${targets.length}`);
  if (isExecute) {
    console.log(`Created on Cloud:          ${createdCount}`);
    console.log(`Already existed (race):    ${alreadyExistsCount}`);
  } else {
    console.log(`Planned (dry-run):         ${dryPlannedCount}`);
  }
  console.log(`Failed:                    ${failedCount}`);
  console.log("");
  if (!isExecute) {
    console.log(
      "🔁 Re-run with --execute once you've reviewed the planned bodies and droppedGrants in the audit file.",
    );
  } else {
    console.log(
      "🔁 Now re-run `revert-from-dc-backup` to apply the original schemes to projects.",
    );
  }
}

// Command line interface
program
  .name("set-permission-scheme")
  .description("Set or revert permission schemes for projects in Jira Cloud")
  .version("1.0.0");

// SET command
program
  .command("set")
  .description(
    "Set a specific permission scheme for all (or filtered) projects",
  )
  .requiredOption(
    "--url <url>",
    "Jira instance URL (e.g., https://your-instance.atlassian.net)",
  )
  .requiredOption("--email <email>", "Email address for authentication")
  .requiredOption("--token <token>", "API token for authentication")
  .requiredOption(
    "--scheme-id <id>",
    "Permission Scheme ID to assign to projects",
  )
  .option(
    "--project-key <key>",
    "Process only a specific project by key (e.g., PROJ)",
  )
  .option(
    "--project-pattern <pattern>",
    "Process only projects matching regex pattern (e.g., ^TEST)",
  )
  .option(
    "--exclude-pattern <pattern>",
    "Exclude projects matching regex pattern (e.g., ^DEMO)",
  )
  .option("--dry-run", "Show what would be done without making changes", false)
  .option(
    "--output-file <file>",
    "Save results to JSON file",
    "permission_scheme_changes.json",
  )
  .action((options) => {
    const baseUrl = options.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const apiToken = Buffer.from(`${options.email}:${options.token}`).toString(
      "base64",
    );

    // Validate scheme ID is a number
    if (!options.schemeId.match(/^\d+$/)) {
      console.error(
        "❌ Invalid permission scheme ID format. Expected a numeric ID (e.g., 10000)",
      );
      process.exit(1);
    }

    setMode(baseUrl, options.schemeId, options.email, apiToken, {
      projectKey: options.projectKey,
      projectPattern: options.projectPattern,
      excludePattern: options.excludePattern,
      dryRun: options.dryRun,
      outputFile: options.outputFile,
    }).catch((error) => {
      console.error("Unhandled error:", error);
      process.exit(1);
    });
  });

// LOCKDOWN command — one-shot: create read-only scheme + apply to all projects
program
  .command("lockdown")
  .description(
    "Create a read-only permission scheme AND assign it to all (or filtered) projects in one shot. " +
      "Output JSON is revert-compatible — feed it into the 'revert' command to roll back.",
  )
  .requiredOption(
    "--url <url>",
    "Jira instance URL (e.g., https://your-instance.atlassian.net)",
  )
  .requiredOption("--email <email>", "Email address for authentication")
  .requiredOption("--token <token>", "API token for authentication")
  .option(
    "--scheme-name <name>",
    "Name for the new read-only permission scheme (default: 'Read-Only Lockdown <ts>')",
  )
  .option(
    "--scheme-description <desc>",
    "Description for the new permission scheme",
  )
  .option(
    "--browse-group <group...>",
    "Group(s) granted BROWSE_PROJECTS during lockdown. Can be repeated. " +
      "Default if no holders given: applicationRole jira-software-users",
  )
  .option(
    "--browse-account-id <accountId...>",
    "Specific user accountId(s) granted BROWSE_PROJECTS during lockdown. Can be repeated.",
  )
  .option(
    "--browse-app-role <role...>",
    "Application role(s) granted BROWSE_PROJECTS (e.g., jira-software-users, jira-servicedesk-users). Can be repeated.",
  )
  .option(
    "--admin-group <group...>",
    "Group(s) granted ADMINISTER_PROJECTS as an escape-hatch (recommended: include 'site-admins' or your admin group). Can be repeated.",
  )
  .option(
    "--project-key <key>",
    "Process only a specific project by key (e.g., PROJ)",
  )
  .option(
    "--project-pattern <pattern>",
    "Process only projects matching regex pattern (e.g., ^TEST)",
  )
  .option(
    "--exclude-pattern <pattern>",
    "Exclude projects matching regex pattern (e.g., ^DEMO)",
  )
  .option("--dry-run", "Show what would be done without making changes", false)
  .option(
    "--output-file <file>",
    "Save results to JSON file (also serves as the input for 'revert')",
    `lockdown_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`,
  )
  .action((options) => {
    const baseUrl = options.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const apiToken = Buffer.from(`${options.email}:${options.token}`).toString(
      "base64",
    );

    lockdownMode(baseUrl, options.email, apiToken, {
      schemeName: options.schemeName,
      schemeDescription: options.schemeDescription,
      browseGroups: options.browseGroup || [],
      browseAccountIds: options.browseAccountId || [],
      browseAppRoles: options.browseAppRole || [],
      adminGroups: options.adminGroup || [],
      projectKey: options.projectKey,
      projectPattern: options.projectPattern,
      excludePattern: options.excludePattern,
      dryRun: options.dryRun,
      outputFile: options.outputFile,
    }).catch((error) => {
      console.error("Unhandled error:", error);
      process.exit(1);
    });
  });

// REVERT command
program
  .command("revert")
  .description("Revert permission schemes from a previously saved JSON file")
  .requiredOption(
    "--url <url>",
    "Jira instance URL (e.g., https://your-instance.atlassian.net)",
  )
  .requiredOption("--email <email>", "Email address for authentication")
  .requiredOption("--token <token>", "API token for authentication")
  .requiredOption(
    "--input-file <file>",
    "JSON file with previous changes to revert",
  )
  .option("--dry-run", "Show what would be done without making changes", false)
  .option(
    "--output-file <file>",
    "Save revert results to JSON file",
    "permission_scheme_revert.json",
  )
  .action((options) => {
    const baseUrl = options.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const apiToken = Buffer.from(`${options.email}:${options.token}`).toString(
      "base64",
    );

    revertMode(baseUrl, options.email, apiToken, {
      inputFile: options.inputFile,
      dryRun: options.dryRun,
      outputFile: options.outputFile,
    }).catch((error) => {
      console.error("Unhandled error:", error);
      process.exit(1);
    });
  });

// REVERT-FROM-DC-BACKUP command
// Restores Cloud projects to the schemes recorded in a DC backup JSON, matching by scheme NAME.
program
  .command("revert-from-dc-backup")
  .description(
    "Restore Cloud projects to their original (DC) permission schemes by NAME. " +
      "Use this AFTER a Cloud migration when scheme IDs have changed. " +
      "Input is the JSON written by the DC tool's `set` command.",
  )
  .requiredOption(
    "--url <url>",
    "Jira Cloud URL (e.g., https://your-instance.atlassian.net)",
  )
  .option(
    "--email <email>",
    "Atlassian account email (omit if using --basic-auth)",
  )
  .option(
    "--token <token>",
    "Cloud API token (omit if using --basic-auth)",
  )
  .option(
    "--basic-auth <encoded>",
    "Pre-base64-encoded 'email:token' (or env JIRA_CLOUD_BASIC_AUTH). " +
      "Takes precedence over --email/--token.",
  )
  .requiredOption(
    "--input-file <file>",
    "DC backup JSON written by `set_permission_scheme_dc.js set`",
  )
  .option("--dry-run", "Show what would be done without making changes", false)
  .option(
    "--output-file <file>",
    "Save results to JSON file",
    `cloud_revert_from_dc_${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19)}.json`,
  )
  .action((options) => {
    const baseUrl = options.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const apiToken = resolveCloudBasicAuth(options);

    revertFromDcBackupMode(baseUrl, apiToken, {
      inputFile: options.inputFile,
      dryRun: options.dryRun,
      outputFile: options.outputFile,
    }).catch((error) => {
      console.error("Unhandled error:", error);
      process.exit(1);
    });
  });

// BACKFILL-MISSING-SCHEMES command
// Fetches the EXACT definition of any DC permission scheme that's missing on Cloud,
// translates user/group/role/field holders, and POSTs them onto Cloud. Dry-run by default.
program
  .command("backfill-missing-schemes")
  .description(
    "Reach into a DC instance, fetch the exact definition of any permission scheme " +
      "that's missing on Cloud (the unmapped names surfaced by `revert-from-dc-backup`), " +
      "translate the holders, and create them on Cloud. Dry-run by default — pass --execute to commit.",
  )
  .requiredOption(
    "--cloud-url <url>",
    "Jira Cloud URL (e.g., https://your-instance.atlassian.net)",
  )
  .requiredOption(
    "--dc-url <url>",
    "Jira Datacenter URL (e.g., https://jira.your-company.com)",
  )
  .requiredOption(
    "--input-file <file>",
    "DC backup JSON written by `set_permission_scheme_dc.js set` " +
      "(same file you'd pass to `revert-from-dc-backup`)",
  )
  // Cloud auth (mirrors revert-from-dc-backup)
  .option("--email <email>", "Atlassian account email (omit if using --basic-auth)")
  .option("--token <token>", "Cloud API token (omit if using --basic-auth)")
  .option(
    "--basic-auth <encoded>",
    "Pre-base64-encoded Cloud 'email:token' (or env JIRA_CLOUD_BASIC_AUTH). " +
      "Takes precedence over --email/--token.",
  )
  // DC auth (mirrors set_permission_scheme_dc.js conventions)
  .option(
    "--dc-pat <token>",
    "DC Personal Access Token (or env JIRA_DC_PAT). Highest precedence DC auth.",
  )
  .option(
    "--dc-basic-auth <encoded>",
    "Pre-base64-encoded DC 'user:password' (or env JIRA_DC_BASIC_AUTH).",
  )
  .option("--dc-user <user>", "DC username (or env JIRA_DC_USER)")
  .option("--dc-password <password>", "DC password (or env JIRA_DC_PASSWORD)")
  // Translation knobs
  .option(
    "--user-map <file>",
    "CSV mapping DC usernames -> Cloud accountIds. Columns: dc_username,cloud_account_id. " +
      "REQUIRED if any DC scheme has user holders — without it, every user grant is dropped.",
  )
  .option(
    "--name-prefix <prefix>",
    "Optional prefix prepended to every created scheme name (e.g., 'MIG: ').",
    "",
  )
  .option(
    "--only <name>",
    "Process only the single DC scheme name given (case-insensitive). " +
      "Useful for debugging or recovering a single scheme.",
  )
  .option(
    "--execute",
    "Commit the changes by POSTing to Cloud. Without this flag the run is dry-run.",
    false,
  )
  .option(
    "--output-file <file>",
    "Audit JSON output path",
    `backfill_${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19)}.json`,
  )
  .action((options) => {
    backfillMissingSchemesMode({
      cloudUrl: options.cloudUrl,
      dcUrl: options.dcUrl,
      inputFile: options.inputFile,
      email: options.email,
      token: options.token,
      basicAuth: options.basicAuth,
      dcPat: options.dcPat,
      dcBasicAuth: options.dcBasicAuth,
      dcUser: options.dcUser,
      dcPassword: options.dcPassword,
      userMap: options.userMap,
      namePrefix: options.namePrefix,
      only: options.only,
      execute: options.execute,
      outputFile: options.outputFile,
    }).catch((error) => {
      console.error("Unhandled error:", error);
      process.exit(1);
    });
  });

// Show help if no command is provided
if (process.argv.length <= 2) {
  program.outputHelp();
  console.log("");
  console.log("Examples:");
  console.log("");
  console.log(
    "  LOCKDOWN mode - Create read-only scheme AND assign to all projects in one shot:",
  );
  console.log("    $ node set_permission_scheme.js lockdown \\");
  console.log("      --url https://your-instance.atlassian.net \\");
  console.log("      --email user@company.com \\");
  console.log("      --token your-api-token \\");
  console.log("      --browse-group jira-users \\");
  console.log("      --admin-group site-admins \\");
  console.log("      --output-file lockdown_2026-05-07.json");
  console.log("");
  console.log("  SET mode - Apply existing permission scheme to all projects:");
  console.log("    $ node set_permission_scheme.js set \\");
  console.log("      --url https://your-instance.atlassian.net \\");
  console.log("      --email user@company.com \\");
  console.log("      --token your-api-token \\");
  console.log("      --scheme-id 10000");
  console.log("");
  console.log(
    "  REVERT mode - Restore previous permission schemes (works for both lockdown and set output):",
  );
  console.log("    $ node set_permission_scheme.js revert \\");
  console.log("      --url https://your-instance.atlassian.net \\");
  console.log("      --email user@company.com \\");
  console.log("      --token your-api-token \\");
  console.log("      --input-file lockdown_2026-05-07.json");
  console.log("");
  console.log(
    "  BACKFILL-MISSING-SCHEMES mode - Fetch DC schemes missing on Cloud and create them:",
  );
  console.log("    $ node set_permission_scheme.js backfill-missing-schemes \\");
  console.log("      --cloud-url https://your-instance.atlassian.net \\");
  console.log("      --dc-url   https://jira.your-company.com \\");
  console.log("      --basic-auth <cloud-base64> \\");
  console.log("      --dc-pat <dc-personal-access-token> \\");
  console.log("      --input-file ../set-read-only-dc/dc_lockdown_<ts>.json \\");
  console.log("      --user-map cloud_user_map.csv");
  console.log("      # add --execute once the dry-run audit looks right");
  console.log("");
  console.log("Use --help with a command for more details:");
  console.log("  $ node set_permission_scheme.js lockdown --help");
  console.log("  $ node set_permission_scheme.js set --help");
  console.log("  $ node set_permission_scheme.js revert --help");
  console.log("  $ node set_permission_scheme.js revert-from-dc-backup --help");
  console.log("  $ node set_permission_scheme.js backfill-missing-schemes --help");
  console.log("");
  process.exit(0);
}

program.parse();
