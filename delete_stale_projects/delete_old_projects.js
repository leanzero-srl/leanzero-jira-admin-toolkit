#!/usr/bin/env node

/**
 * Delete Old Jira Projects Script
 *
 * This script deletes projects from Jira that haven't been updated in the specified number of months.
 * Designed for sandbox environments with safety checks and interactive confirmations.
 *
 * Usage:
 *   # Basic usage with 6 months threshold
 *   node delete_old_projects.js \
 *     --url https://your-sandbox.atlassian.net \
 *     --email user@company.com \
 *     --token api-token
 *
 *   # Custom month threshold and dry-run mode
 *   node delete_old_projects.js \
 *     --url https://your-sandbox.atlassian.net \
 *     --email user@company.com \
 *     --token api-token \
 *     --months 3
 *     --dry-run
 *
 *   # Force deletion without confirmation (not recommended)
 *   node delete_old_projects.js \
 *     --url https://your-sandbox.atlassian.net \
 *     --email user@company.com \
 *     --token api-token \
 *     --months 6
 *     --force
 *
 * Requirements:
 *   npm install commander
 */

const https = require("https");
const { program } = require("commander");

/**
 * Jira Project Deleter Class
 * Handles deletion of old projects from Jira instances.
 */
class JiraProjectDeleter {
  constructor(options) {
    this.baseUrl = options.url;
    this.email = options.email;
    this.token = options.token;
    this.months = options.months || 6;
    this.dryRun = options.dryRun || false;
    this.force = options.force || false;

    // Validate URL contains "sandbox" (case-insensitive)
    if (!this.baseUrl.toLowerCase().includes('sandbox')) {
      console.warn('⚠️  Warning: URL does not contain "sandbox".');
      if (!this.force) {
        console.warn('   This script should only be run in sandbox environments.');
      }
    }

    this.projects = [];
    this.projectsToDelete = [];
    this.startTime = Date.now();

    // Stats tracking
    this.totalProjects = 0;
    this.foundOldProjects = 0;
    this.deletedProjects = 0;
    this.failedDeletions = 0;
  }

  /**
   * Calculate the cutoff date for "old" projects
   */
  getCutoffDate() {
    const now = new Date();
    const cutoff = new Date(now);

    // Subtract X months
    cutoff.setMonth(cutoff.getMonth() - this.months);

    return cutoff.getTime();
  }

  /**
   * Make API call to Jira REST API
   */
  async makeApiCall(path, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
      const hostname = new URL(this.baseUrl).hostname;
      const options = {
        hostname,
        port: 443,
        path,
        method,
        headers: {
          'Authorization': `Basic ${Buffer.from(`${this.email}:${this.token}`).toString('base64')}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      };

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (error) {
              reject(new Error(`Failed to parse JSON response: ${data}`));
            }
          } else {
            reject(new Error(`API request failed with status ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', error => reject(error));

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }

  /**
   * Get all projects from Jira with pagination
   */
  async getAllProjects() {
    const maxResults = 50;
    let startAt = 0;
    let projects = [];

    console.log('🔍 Fetching all projects from Jira...');

    while (true) {
      try {
        const response = await this.makeApiCall(
          `/rest/api/3/project/search?startAt=${startAt}&maxResults=${maxResults}`
        );

        projects.push(...response.values);
        this.totalProjects = response.total;

        if (startAt + maxResults >= response.total) {
          break;
        }

        startAt += maxResults;
      } catch (error) {
        throw new Error(`Failed to fetch projects: ${error.message}`);
      }
    }

    this.projects = projects;
    console.log(`✅ Found ${this.totalProjects} total projects`);
  }

  /**
   * Filter old projects based on last update time
   */
  filterOldProjects() {
    const cutoffDate = this.getCutoffDate();

    console.log(`\n📅 Checking projects not updated since ${this.months} months ago...`);
    console.log(`   Cutoff date: ${new Date(cutoffDate).toLocaleDateString()}`);

    this.projectsToDelete = this.projects.filter(project => {
      if (!project.insight || !project.insight.lastIssueUpdateTime) {
        return false;
      }

      const lastUpdate = new Date(project.insight.lastIssueUpdateTime).getTime();
      return lastUpdate < cutoffDate;
    });

    this.foundOldProjects = this.projectsToDelete.length;

    if (this.foundOldProjects > 0) {
      console.log(`\n🚨 Found ${this.foundOldProjects} projects that haven't been updated in ${this.months} months:`);

      this.projectsToDelete.forEach((project, index) => {
        const lastUpdate = new Date(project.insight.lastIssueUpdateTime);
        console.log(`   ${index + 1}. ${project.key} - ${project.name}`);
        console.log(`      Last update: ${lastUpdate.toLocaleDateString()}`);
      });
    } else {
      console.log('\n✅ No old projects found that meet the criteria.');
    }
  }

  /**
   * Get user confirmation for deletion
   */
  async getConfirmation() {
    if (this.dryRun) {
      console.log('\n🔒 DRY RUN MODE: No projects will actually be deleted.');
      return false;
    }

    if (this.force) {
      console.log('\n⚠️  FORCE MODE: Skipping confirmation prompts.');
      return true;
    }

    if (this.foundOldProjects === 0) {
      console.log('\n✅ No projects to delete.');
      return false;
    }

    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise(resolve => {
      rl.question(
        `\n⚠️  Are you sure you want to delete ${this.foundOldProjects} projects? (yes/no): `,
        answer => {
          rl.close();
          resolve(answer.toLowerCase() === 'yes');
        }
      );
    });
  }

  /**
   * Delete a single project
   */
  async deleteProject(project) {
    try {
      if (this.dryRun) {
        console.log(`\n🔒 [DRY RUN] Would delete project: ${project.key} - ${project.name}`);
        return true;
      }

      console.log(`\n🗑️  Deleting project: ${project.key} - ${project.name}`);

      await this.makeApiCall(`/rest/api/3/project/${project.id}`, 'DELETE');

      console.log(`   ✅ Successfully deleted ${project.key}`);
      this.deletedProjects++;
      return true;
    } catch (error) {
      console.error(`\n❌ Failed to delete ${project.key}: ${error.message}`);
      this.failedDeletions++;
      return false;
    }
  }

  /**
   * Delete all old projects
   */
  async deleteAllOldProjects() {
    if (this.projectsToDelete.length === 0) return;

    console.log('\n🚀 Starting project deletion process...');

    for (const project of this.projectsToDelete) {
      await this.deleteProject(project);

      // Small delay between deletions to avoid overwhelming the API
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  /**
   * Print final summary
   */
  printFinalSummary() {
    const totalTime = (Date.now() - this.startTime) / 1000;

    console.log('\n' + '='.repeat(50));
    console.log('📊 FINAL SUMMARY');
    console.log('='.repeat(50));

    if (this.dryRun) {
      console.log('\n🔒 DRY RUN MODE - No actual changes were made');
    }

    console.log(`\n📈 Statistics:`);
    console.log(`   Total projects found: ${this.totalProjects}`);
    console.log(`   Projects checked for deletion: ${this.foundOldProjects}`);
    console.log(`   Successfully deleted: ${this.deletedProjects}`);
    console.log(`   Failed deletions: ${this.failedDeletions}`);

    if (this.foundOldProjects > 0) {
      const successRate = this.deletedProjects / this.foundOldProjects * 100;
      console.log(`   Success rate: ${successRate.toFixed(1)}%`);
    }

    console.log(`\n⏱️  Execution time: ${totalTime.toFixed(2)} seconds`);

    if (this.failedDeletions > 0) {
      console.log('\n⚠️  Some deletions failed. Check the errors above for details.');
    } else if (this.deletedProjects > 0) {
      console.log('\n✅ All requested projects were successfully deleted.');
    } else if (this.foundOldProjects === 0) {
      console.log('\n✅ No projects required deletion.');
    } else if (this.dryRun) {
      console.log('\n✅ Dry run completed successfully.');
    }

    console.log('='.repeat(50));
  }

  /**
   * Main execution method
   */
  async run() {
    try {
      console.log('🚀 Starting Jira Project Deletion Script');

      // Validate required parameters
      if (!this.baseUrl || !this.email || !this.token) {
        throw new Error('Missing required parameters: --url, --email, and --token are required');
      }

      // Step 1: Get all projects
      await this.getAllProjects();

      // Step 2: Filter old projects
      this.filterOldProjects();

      // Step 3: Get user confirmation
      const shouldProceed = await this.getConfirmation();

      if (!shouldProceed) {
        console.log('\n❌ Operation cancelled by user.');
        return;
      }

      // Step 4: Delete projects
      await this.deleteAllOldProjects();

      // Step 5: Print summary
      this.printFinalSummary();

    } catch (error) {
      console.error('\n❌ Script failed with error:');
      console.error(`   ${error.message}`);

      if (error.response) {
        console.error('\nAPI Response:', error.response.data);
      }

      process.exit(1);
    }
  }
}

// Command line argument setup
program
  .name('delete-old-projects')
  .description('Delete old Jira projects that haven\'t been updated in specified months')
  .version('1.0.0');

program
  .requiredOption('--url <url>', 'Jira instance URL')
  .requiredOption('--email <email>', 'Email address for authentication')
  .requiredOption('--token <token>', 'API token for authentication')
  .option('--months <number>', 'Number of months to consider projects as old', parseInt)
  .option('--dry-run', 'Perform a dry run without actually deleting projects')
  .option('--force', 'Skip interactive confirmation prompts');

// Parse arguments
program.parse();

try {
  const options = program.opts();

  // Validate months parameter
  if (options.months && (isNaN(options.months) || options.months < 1)) {
    console.error('❌ --months must be a positive number');
    process.exit(1);
  }

  // Create and run the deleter
  const deleter = new JiraProjectDeleter(options);
  await deleter.run();

} catch (error) {
  console.error('❌ Failed to initialize script:', error.message);
  process.exit(1);
}
