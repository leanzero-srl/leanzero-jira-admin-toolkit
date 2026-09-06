#!/usr/bin/env node

/**
 * Fetch Screen Fields from Jira API
 *
 * This script fetches screen tabs and their associated fields from a Jira instance.
 * It outputs the field names and IDs to a file for each screen ID provided.
 *
 * Usage:
 *   # Fetch fields for a specific screen
 *   node fetch_screen_fields.js \
 *     --url https://your-instance.atlassian.net \
 *     --email user@company.com \
 *     --token api-token \
 *     --screen 12345
 *
 *   # Fetch fields for multiple screens (run sequentially)
 *   node fetch_screen_fields.js --url https://your-instance.atlassian.net --email user@company.com --token api-token --screen 12345
 *   node fetch_screen_fields.js --url https://your-instance.atlassian.net --email user@company.com --token api-token --screen 12346
 *
 * Requirements:
 *   npm install commander
 */

const https = require("https");
const { program } = require("commander");
const fs = require('fs');
const path = require('path');

/**
 * Screen Field Fetcher
 * Handles fetching screen tabs and fields from Jira API.
 */
class ScreenFieldFetcher {
  constructor(options) {
    this.baseUrl = options.url;
    this.email = options.email;
    this.token = options.token;
    this.auth = Buffer.from(`${this.email}:${this.token}`).toString("base64");
    this.screenId = options.screen;
    this.projectKey = options.projectKey;
  }

  /**
   * Make API call to Jira with retry logic
   */
  async makeApiCall(endpoint, method = "GET", body = null, retryCount = 0, maxRetries = 5) {
    return new Promise((resolve, reject) => {
      // Parse the base URL to get hostname
      const hostname = this.baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");

      let pathWithParams = endpoint;

      // Add projectKey if provided
      if (this.projectKey) {
        const separator = endpoint.includes('?') ? '&' : '?';
        pathWithParams += `${separator}projectKey=${this.projectKey}`;
      }

      const options = {
        hostname: hostname,
        port: 443,
        path: pathWithParams,
        method: method,
        headers: {
          Authorization: `Basic ${this.auth}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      };

      const req = https.request(options, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            // Handle 204 No Content
            if (res.statusCode === 204) {
              resolve({ success: true });
              return;
            }

            try {
              const parsed = data ? JSON.parse(data) : {};
              resolve(parsed);
            } catch (e) {
              console.error(`Error parsing API response: ${e.message}`);
              resolve({ success: false, error: e });
            }
          } else if (res.statusCode === 429 && retryCount < maxRetries) {
            // Rate limited - implement exponential backoff
            const backoffTime = Math.min(1000 * Math.pow(2, retryCount), 32000);
            console.log(
              `   ⏳ Rate limited (429), retrying in ${backoffTime / 1000}s (attempt ${retryCount + 1}/${maxRetries})...`,
            );

            setTimeout(() => {
              this.makeApiCall(endpoint, method, body, retryCount + 1, maxRetries)
                .then(resolve)
                .catch(reject);
            }, backoffTime);
          } else {
            console.error(`API Error (${res.statusCode}): ${data}`);
            reject(new Error(`API request failed with status ${res.statusCode}`));
          }
        });
      });

      req.on("error", (error) => {
        console.error(`Request error: ${error.message}`);
        reject(error);
      });

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }

  /**
   * Get all screen tabs
   */
  async getScreenTabs() {
    console.log(`Fetching screen tabs for screen ID: ${this.screenId}`);

    const endpoint = `/rest/api/3/screens/${this.screenId}/tabs`;
    try {
      const response = await this.makeApiCall(endpoint);

      if (!response || !Array.isArray(response)) {
        throw new Error('Invalid response format for screen tabs');
      }

      console.log(`Found ${response.length} screen tab(s)`);
      return response;
    } catch (error) {
      console.error(`Failed to fetch screen tabs: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all fields for a specific screen tab
   */
  async getTabFields(tabId) {
    console.log(`Fetching fields for tab ID: ${tabId}`);

    const endpoint = `/rest/api/3/screens/${this.screenId}/tabs/${tabId}/fields`;
    try {
      const response = await this.makeApiCall(endpoint);

      if (!response || !Array.isArray(response)) {
        throw new Error('Invalid response format for tab fields');
      }

      console.log(`Found ${response.length} field(s) for tab ${tabId}`);
      return response;
    } catch (error) {
      console.error(`Failed to fetch fields for tab ${tabId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Process all tabs and fetch their fields
   */
  async processScreen() {
    try {
      // Get all tabs for the screen
      const tabs = await this.getScreenTabs();

      if (tabs.length === 0) {
        console.log('No tabs found for this screen');
        return;
      }

      // Create output directory if it doesn't exist
      const outputDir = './screen-fields';
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      // Process each tab
      for (const tab of tabs) {
        console.log(`\nProcessing tab: ${tab.name} (ID: ${tab.id})`);

        try {
          const fields = await this.getTabFields(tab.id);

          if (fields.length === 0) {
            console.log(`No fields found for tab: ${tab.name}`);
            continue;
          }

          // Create output file name
          const safeTabName = tab.name.replace(/[^a-zA-Z0-9-_]/g, '_');
          const outputFile = path.join(outputDir, `${this.screenId}_${tab.id}_${safeTabName}_fields.txt`);

          // Write fields to file
          const fieldData = fields.map(field => `${field.name},${field.id}`).join('\n');
          fs.writeFileSync(outputFile, fieldData);

          console.log(`✓ Saved ${fields.length} fields to: ${outputFile}`);

        } catch (error) {
          console.error(`❌ Failed to process tab ${tab.name}: ${error.message}`);
        }
      }

    } catch (error) {
      console.error(`❌ Failed to process screen ${this.screenId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Main execution method
   */
  async run() {
    console.log(`🔍 Fetching screen fields for screen ID: ${this.screenId}`);

    if (this.projectKey) {
      console.log(`📍 Project key: ${this.projectKey}`);
    }

    try {
      await this.processScreen();
      console.log(`\n✓ Screen field fetching completed successfully!`);
    } catch (error) {
      console.error(`\n❌ Screen field fetching failed: ${error.message}`);
      process.exit(1);
    }
  }
}

// Set up command line interface
program
  .name("fetch_screen_fields")
  .description("Fetch screen tabs and fields from Jira API")
  .version("1.0.0");

// Required options
program
  .requiredOption("--url <string>", "Jira instance URL (e.g., https://your-domain.atlassian.net)")
  .requiredOption("--email <string>", "Email address for authentication")
  .requiredOption("--token <string>", "API token for authentication")
  .requiredOption("--screen <number>", "Screen ID to fetch fields from");

// Optional options
program.option(
  "--project-key <string>",
  "Project key (optional, for permission scoping)"
);

// Help text
program.addHelpText(
  "after",
  `

Examples:
  # Basic usage - fetch fields for a screen
  node ${program.name()} \\
    --url https://your-domain.atlassian.net \\
    --email user@company.com \\
    --token your-api-token \\
    --screen 12345

  # With project key (for permission scoping)
  node ${program.name()} \\
    --url https://your-domain.atlassian.net \\
    --email user@company.com \\
    --token your-api-token \\
    --screen 12345 \\
    --project-key PROJ

Note:
  - API token can be generated from: https://id.atlassian.com/manage-profile/security/api-tokens
  - Screen ID can be found in Jira administration under Screens configuration
  - Run this script sequentially for each screen ID you want to fetch fields from
  - Output will be saved in ./screen-fields/ directory with format: {screenId}_{tabId}_{tabName}_fields.txt
  `
);

// Parse command line arguments
program.parse();

const options = program.opts();

// Create and run the fetcher
const fetcher = new ScreenFieldFetcher({
  url: options.url,
  email: options.email,
  token: options.token,
  screen: parseInt(options.screen),
  projectKey: options.projectKey,
});

// Run the fetcher
fetcher.run().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
