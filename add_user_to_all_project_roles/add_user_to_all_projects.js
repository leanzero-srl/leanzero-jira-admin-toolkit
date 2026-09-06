#!/usr/bin/env node

/**
 * Add User to All Project Roles
 *
 * This script adds a specific user to all roles across all projects in Jira Cloud.
 *
 * Usage:
 *   node add_user_to_all_project_roles.js \
 *     --url https://your-instance.atlassian.net \
 *     --email your.email@company.com \
 *     --token your-api-token \
 *     --user 712020:user-account-id
 *
 * Requirements:
 *   npm install commander
 *
 * Based on official Atlassian Jira Cloud REST API documentation:
 * - GET /rest/api/3/project/search (Get projects paginated)
 * - GET /rest/api/3/project/{projectIdOrKey}/role (Get project roles for project)
 * - POST /rest/api/3/project/{projectIdOrKey}/role/{id} (Add actors to project role)
 */

const https = require("https");
const { program } = require("commander");

// Helper function to sleep
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Helper function to make HTTPS requests with exponential backoff
async function makeRequest(
  baseUrl,
  apiToken,
  method,
  path,
  body = null,
  retryCount = 0,
  maxRetries = 5,
) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: baseUrl,
      port: 443,
      path: path,
      method: method,
      headers: {
        Authorization: `Basic ${apiToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    };

    const req = https.request(options, async (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", async () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = data ? JSON.parse(data) : {};
            resolve({ statusCode: res.statusCode, data: parsed });
          } catch (e) {
            resolve({ statusCode: res.statusCode, data: {} });
          }
        } else if (res.statusCode === 429 && retryCount < maxRetries) {
          // Rate limited - implement exponential backoff
          const backoffTime = Math.min(1000 * Math.pow(2, retryCount), 32000);
          console.log(
            `   ⏳ Rate limited, retrying in ${backoffTime / 1000}s (attempt ${retryCount + 1}/${maxRetries})...`,
          );
          await sleep(backoffTime);

          try {
            const result = await makeRequest(
              baseUrl,
              apiToken,
              method,
              path,
              body,
              retryCount + 1,
              maxRetries,
            );
            resolve(result);
          } catch (retryError) {
            reject(retryError);
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on("error", (error) => {
      reject(error);
    });

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
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

// Get all roles for a specific project
async function getProjectRoles(baseUrl, apiToken, projectKeyOrId) {
  try {
    const response = await makeRequest(
      baseUrl,
      apiToken,
      "GET",
      `/rest/api/3/project/${projectKeyOrId}/role`,
    );
    return response.data;
  } catch (error) {
    console.error(
      `   ❌ Error fetching roles for project ${projectKeyOrId}: ${error.message}`,
    );
    return {};
  }
}

// Add user to a specific role in a project
async function addUserToProjectRole(
  baseUrl,
  apiToken,
  projectKeyOrId,
  roleId,
  userAccountId,
) {
  try {
    const body = {
      user: [userAccountId],
    };

    const response = await makeRequest(
      baseUrl,
      apiToken,
      "POST",
      `/rest/api/3/project/${projectKeyOrId}/role/${roleId}`,
      body,
    );
    return { success: true, data: response.data };
  } catch (error) {
    // Check if user is already in the role (this is not an error)
    if (error.message.includes("400") || error.message.includes("already")) {
      return { success: true, alreadyExists: true };
    }
    return { success: false, error: error.message };
  }
}

// Extract role ID from role URL
function extractRoleId(roleUrl) {
  const match = roleUrl.match(/\/role\/(\d+)$/);
  return match ? match[1] : null;
}

// Resolve the authenticated user's own accountId
async function getSelfAccountId(baseUrl, apiToken) {
  const response = await makeRequest(
    baseUrl,
    apiToken,
    "GET",
    "/rest/api/3/myself",
  );
  return {
    accountId: response.data.accountId,
    emailAddress: response.data.emailAddress,
    displayName: response.data.displayName,
  };
}

// Main execution
async function main(baseUrl, userAccountId, email, apiToken, options = {}) {
  console.log("🚀 ADD USER TO ALL PROJECT ROLES");
  console.log("=====================================");
  console.log(`👤 User Account ID: ${userAccountId}`);
  console.log(`🌐 Jira Instance: ${baseUrl}`);
  console.log("");

  const stats = {
    totalProjects: 0,
    processedProjects: 0,
    totalRoles: 0,
    successfulAdds: 0,
    alreadyExists: 0,
    failures: 0,
    errors: [],
  };

  try {
    // Step 1: Get all projects
    const projects = await getAllProjects(baseUrl, apiToken);
    stats.totalProjects = projects.length;

    if (projects.length === 0) {
      console.log("⚠️  No projects found.");
      return;
    }

    // Filter projects if projectKey or projectPattern is specified
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

    console.log("");
    console.log("🔧 Processing projects and roles...");
    console.log("");

    // Step 2: For each project, get roles and add user
    for (const project of projectsToProcess) {
      console.log(`📦 Project: ${project.key} (${project.name})`);

      // Get roles for this project
      const roles = await getProjectRoles(baseUrl, apiToken, project.key);
      const roleEntries = Object.entries(roles);

      if (roleEntries.length === 0) {
        console.log(`   ⚠️  No roles found for this project`);
        stats.processedProjects++;
        continue;
      }

      console.log(`   📋 Found ${roleEntries.length} roles`);

      // Add user to each role
      for (const [roleName, roleUrl] of roleEntries) {
        const roleId = extractRoleId(roleUrl);

        if (!roleId) {
          console.log(`   ⚠️  Could not extract role ID from ${roleName}`);
          continue;
        }

        stats.totalRoles++;

        const result = await addUserToProjectRole(
          baseUrl,
          apiToken,
          project.key,
          roleId,
          userAccountId,
        );

        if (result.success) {
          if (result.alreadyExists) {
            console.log(`   ✓ ${roleName} (already exists)`);
            stats.alreadyExists++;
          } else {
            console.log(`   ✅ ${roleName} (added)`);
            stats.successfulAdds++;
          }
        } else {
          console.log(`   ❌ ${roleName} (failed: ${result.error})`);
          stats.failures++;
          stats.errors.push({
            project: project.key,
            role: roleName,
            error: result.error,
          });
        }
      }

      stats.processedProjects++;
      console.log("");
    }

    // Step 3: Print summary
    console.log("");
    console.log("📊 SUMMARY");
    console.log("=====================================");
    console.log(`Total Projects: ${stats.totalProjects}`);
    console.log(`Processed Projects: ${stats.processedProjects}`);
    console.log(`Total Roles Processed: ${stats.totalRoles}`);
    console.log(`Successfully Added: ${stats.successfulAdds}`);
    console.log(`Already Exists: ${stats.alreadyExists}`);
    console.log(`Failures: ${stats.failures}`);
    console.log("");

    if (stats.errors.length > 0) {
      console.log("❌ ERRORS:");
      for (const error of stats.errors.slice(0, 10)) {
        console.log(`   ${error.project} / ${error.role}: ${error.error}`);
      }
      if (stats.errors.length > 10) {
        console.log(`   ... and ${stats.errors.length - 10} more errors`);
      }
    }

    console.log("");
    console.log("✅ Script completed successfully!");
  } catch (error) {
    console.error("");
    console.error("❌ FATAL ERROR:");
    console.error(error);
    process.exit(1);
  }
}

// Command line interface
program
  .name("add-user-to-all-projects")
  .description(
    "Add a specific user to all roles across all projects in Jira Cloud",
  )
  .requiredOption(
    "--url <url>",
    "Jira instance URL (e.g., https://your-instance.atlassian.net)",
  )
  .option("--email <email>", "Email address for authentication (required unless --token-base64 is used)")
  .option("--token <token>", "API token for authentication (required unless --token-base64 is used)")
  .option(
    "--token-base64 <encoded>",
    "Pre-encoded base64 of 'email:apiToken'. Overrides --email/--token.",
  )
  .option(
    "--user <accountId>",
    "User Account ID to add (format: 712020:xxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx). Optional when --self is set.",
  )
  .option(
    "--self",
    "Add the authenticated user (resolved via /rest/api/3/myself) instead of --user",
    false,
  )
  .option(
    "--project-key <key>",
    "Process only a specific project by key (e.g., PROJ)",
  )
  .option(
    "--project-pattern <pattern>",
    "Process only projects matching regex pattern (e.g., ^TEST)",
  )
  .option("--dry-run", "Show what would be done without making changes", false)
  .addHelpText(
    "after",
    `
Examples:
  Add user to all projects:
    $ node add_user_to_all_projects.js \\
      --url https://your-instance.atlassian.net \\
      --email user@company.com \\
      --token your-api-token \\
      --user 712020:00000000-0000-0000-0000-000000000000

  Add user to a specific project:
    $ node add_user_to_all_projects.js \\
      --url https://your-instance.atlassian.net \\
      --email user@company.com \\
      --token your-api-token \\
      --user 712020:00000000-0000-0000-0000-000000000000 \\
      --project-key DEMO

  Add user to projects matching a pattern:
    $ node add_user_to_all_projects.js \\
      --url https://your-instance.atlassian.net \\
      --email user@company.com \\
      --token your-api-token \\
      --user 712020:00000000-0000-0000-0000-000000000000 \\
      --project-pattern "^TEST"

User Account IDs:
  You can find user account IDs in Jira by:
  1. Going to Jira Settings > System > User Management
  2. Clicking on a user
  3. Looking at the URL - the ID is in the format: 712020:xxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

Generate API token from: https://id.atlassian.com/manage-profile/security/api-tokens
    `,
  );

program.parse();

const options = program.opts();

// Validate and prepare inputs
const baseUrl = options.url.replace(/^https?:\/\//, "").replace(/\/$/, "");

let apiToken;
if (options.tokenBase64) {
  apiToken = options.tokenBase64;
} else if (options.email && options.token) {
  apiToken = Buffer.from(`${options.email}:${options.token}`).toString("base64");
} else {
  console.error("❌ Must provide either --token-base64 OR both --email and --token");
  process.exit(1);
}

(async () => {
  let userAccountId = options.user;

  if (options.self) {
    try {
      const self = await getSelfAccountId(baseUrl, apiToken);
      userAccountId = self.accountId;
      console.log(
        `🔑 Resolved self via /myself: ${self.displayName} <${self.emailAddress}> → ${self.accountId}`,
      );
    } catch (err) {
      console.error(`❌ Failed to resolve self via /myself: ${err.message}`);
      process.exit(1);
    }
  }

  if (!userAccountId) {
    console.error("❌ Must provide --user <accountId> or --self");
    process.exit(1);
  }

  // Only validate format for user-supplied accountIds; trust /myself response
  if (!options.self && !userAccountId.match(/^(712020:[a-f0-9-]{36}|[a-f0-9]{24})$/)) {
    console.error(
      "❌ Invalid user account ID format. Expected '712020:<uuid>' or 24-char hex.",
    );
    process.exit(1);
  }

  try {
    await main(baseUrl, userAccountId, options.email, apiToken, {
      projectKey: options.projectKey,
      projectPattern: options.projectPattern,
      dryRun: options.dryRun,
    });
  } catch (error) {
    console.error("Unhandled error:", error);
    process.exit(1);
  }
})();
