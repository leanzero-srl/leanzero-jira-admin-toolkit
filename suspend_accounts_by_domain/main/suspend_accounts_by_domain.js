#!/usr/bin/env node

/**
 * Disable Atlassian org accounts by email domain.
 *
 * Default behavior: list every active user in the org whose email ends with
 * @legacy-domain.com and POST .../suspend. Reversible (POST .../restore).
 *
 * --mode=remove sends DELETE instead (permanent, async). That mode requires
 * --force-remove outside of --dry-run.
 *
 * Two-phase architecture matches sync_issue_parents:
 *   Phase 1 (Plan):    list users, filter, write plan JSON + CSV
 *   Phase 2 (Execute): apply with concurrent suspend/remove calls, resumable
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const OrgAdminClient = require("../src/orgAdminClient");
const PlanManager = require("../src/planManager");
const AccountProcessor = require("../src/accountProcessor");

const VALID_MODES = new Set(["suspend", "remove"]);

class DisableAccountsRun {
  constructor(options = {}) {
    this.options = {
      mode: options.mode || "suspend",
      domain: options.domain || "legacy-domain.com",
      domainMatch: options.domainMatch || "eq",
      dryRun: options.dryRun || false,
      limit: options.limit || 0,
      planOnly: options.planOnly || false,
      executeOnly: options.executeOnly || false,
      planFile: options.planFile || null,
      concurrency: options.concurrency || 5,
      retryFailed: options.retryFailed || false,
      forceRemove: options.forceRemove || false,
      includeNonAtlassian: options.includeNonAtlassian || false,
      includeAlreadySuspended: options.includeAlreadySuspended || false,
    };

    if (!VALID_MODES.has(this.options.mode)) {
      throw new Error(`Invalid --mode '${this.options.mode}'. Must be 'suspend' or 'remove'.`);
    }

    if (
      this.options.mode === "remove" &&
      !this.options.dryRun &&
      !this.options.forceRemove
    ) {
      throw new Error(
        "Refusing to run --mode=remove without --force-remove. Remove is permanent and asynchronous.\n" +
          "Re-run with --dry-run to preview, or add --force-remove to actually delete accounts.",
      );
    }

    this.validateConfig();

    this.logDir = path.join(__dirname, "../logs");
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    this.logFile = path.join(this.logDir, `disable_${Date.now()}.log`);
    fs.writeFileSync(
      this.logFile,
      `Disable @${this.options.domain} accounts log\nStarted: ${new Date().toISOString()}\n${"=".repeat(80)}\n\n`,
    );

    this.log = this.log.bind(this);

    this.orgClient = new OrgAdminClient({
      apiKey: process.env.ORG_ADMIN_API_KEY,
      orgId: process.env.ORG_ID,
      log: this.log,
    });

    this.planManager = new PlanManager(this.logDir, this.log);

    if (this.options.planFile) {
      this.planManager.setPlanFile(this.options.planFile);
    }

    this.startTime = Date.now();
  }

  validateConfig() {
    const required = ["ORG_ADMIN_API_KEY", "ORG_ID"];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing.join(", ")}\nCheck the .env file (see .env.example).`,
      );
    }
  }

  log(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    console.log(message);
    try {
      fs.appendFileSync(this.logFile, line + "\n");
    } catch {
      // ignore log write failures
    }
  }

  async run() {
    this.log("==========================================");
    this.log(`Disable Atlassian Accounts (@${this.options.domain})`);
    this.log("==========================================");
    this.log(`  Org ID:     ${process.env.ORG_ID}`);
    this.log(`  Mode:       ${this.options.mode}${this.options.mode === "remove" ? "  (PERMANENT)" : "  (reversible)"}`);
    this.log(`  Domain:     ${this.options.domainMatch === "contains" ? `*@*${this.options.domain}*` : `@${this.options.domain}`}`);
    if (this.options.limit > 0) this.log(`  Limit:      ${this.options.limit}`);
    this.log(`  Concurrency: ${this.options.concurrency}`);
    if (this.options.dryRun) this.log("*** DRY RUN MODE - No changes will be made ***");
    if (this.options.planOnly) this.log("  Phase: PLAN ONLY (no execution)");
    else if (this.options.executeOnly) this.log("  Phase: EXECUTE ONLY (loading existing plan)");
    else this.log("  Phase: FULL (plan + execute)");
    if (this.options.retryFailed) this.log("  Retry failed: YES");
    if (this.options.includeNonAtlassian) this.log("  Include non-atlassian types: YES");
    this.log("");

    // Step 1: connectivity (and capture org name for the report)
    this.log("Step 1: Testing org API access...");
    const orgName = await this.orgClient.testConnection();
    if (!orgName) throw new Error("Cannot reach Atlassian Org Admin API. Check ORG_ADMIN_API_KEY and ORG_ID.");
    this.log(`  Org Admin API: OK (org=${orgName})`);

    const processor = new AccountProcessor(this.orgClient, this.planManager, {
      domain: this.options.domain,
      domainMatch: this.options.domainMatch,
      mode: this.options.mode,
      dryRun: this.options.dryRun,
      limit: this.options.limit,
      concurrency: this.options.concurrency,
      retryFailed: this.options.retryFailed,
      includeNonAtlassian: this.options.includeNonAtlassian,
      includeAlreadySuspended: this.options.includeAlreadySuspended,
      log: this.log,
      logDir: this.logDir,
    });

    // Phase 1: Build or Load plan
    if (this.options.executeOnly) {
      this.log("\nStep 2: Loading existing plan...");
      const master = this.planManager.loadMasterIndex(this.options.planFile);
      if (!master) {
        throw new Error(
          "No master index found. Run without --execute-only first to build a plan, or pass --plan-file.",
        );
      }
    } else {
      const runId = String(Date.now());
      this.log("\nStep 2: Building plan...");
      await processor.buildPlan(runId);

      if (this.options.planOnly) {
        this.log("\n*** PLAN ONLY - skipping execution ***");
        this.printFinalReport(processor.getStats());
        return;
      }
    }

    // Phase 2: Execute
    const planFile = this.planManager.masterIndex?.planFile;
    if (!planFile) {
      this.log("\nNo plan file to execute.");
      this.printFinalReport(processor.getStats());
      return;
    }

    const plan = await this.planManager.loadPlan(planFile);
    if (!plan) {
      this.log("\nERROR: Could not load plan.");
      this.printFinalReport(processor.getStats());
      return;
    }

    this.log(`\nStep 3: Executing (${this.planManager.plan.stats.pending} pending)...`);
    await processor.executePlan();

    this.planManager.savePlan();
    this.planManager.saveMasterIndex();

    this.printFinalReport(processor.getStats());
  }

  printFinalReport(processorStats) {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const orgStats = this.orgClient.getStats();
    const planSummary = this.planManager.getPlanSummary();

    this.log("\n" + "=".repeat(60));
    this.log("FINAL REPORT");
    this.log("=".repeat(60));

    if (this.options.dryRun) {
      this.log("*** DRY RUN - No actual changes were made ***\n");
    }

    this.log("Discovery:");
    this.log(`  Accounts scanned:          ${processorStats.accountsScanned}`);
    this.log(`  Domain mismatch (skipped): ${processorStats.domainMismatch}`);
    this.log(`  Email hidden (skipped):    ${processorStats.emailHidden}`);
    this.log(`  Non-atlassian type (skip): ${processorStats.nonAtlassianType}`);
    this.log(`  Already inactive (skip):   ${processorStats.alreadyInactive}`);
    this.log(`  Already closed (skip):     ${processorStats.alreadyClosed}`);
    this.log(`  Planned for ${this.options.mode}:        ${processorStats.planned}`);

    this.log("\nExecution:");
    this.log(`  Processed:                 ${processorStats.processed}`);
    this.log(`  Succeeded:                 ${processorStats.succeeded}`);
    this.log(`  Failed:                    ${processorStats.failed}`);
    this.log(`  Already gone (404):        ${processorStats.alreadyGone404}`);

    if (planSummary) {
      this.log("\nPlan status:");
      this.log(`  Total:        ${planSummary.totalAccounts || planSummary.total || 0}`);
      this.log(`  Completed:    ${planSummary.completed || 0}`);
      this.log(`  Failed:       ${planSummary.failed || 0}`);
      this.log(`  Pending:      ${planSummary.pending || 0}`);
      this.log(`  Skipped:      ${planSummary.skipped || 0}`);
      if (planSummary.masterFile) this.log(`  Master:       ${planSummary.masterFile}`);
      if (planSummary.planFile) this.log(`  Plan file:    ${planSummary.planFile}`);
    }

    if (this.planManager.masterIndex?.accountsCsv) {
      this.log(`  Accounts CSV: ${this.planManager.masterIndex.accountsCsv}`);
    }

    this.log("\nAPI:");
    this.log(
      `  Org Admin requests: ${orgStats.requestCount} ` +
        `(${orgStats.errorCount} errors, ${orgStats.rateLimitCount} rate limits)`,
    );

    this.log(`\nElapsed: ${elapsed}s`);
    this.log(`Log file: ${this.logFile}`);
    this.log("=".repeat(60));
  }

  static showHelp() {
    console.log(`
Disable Atlassian org accounts by email domain (default: @legacy-domain.com)

Usage:
  node suspend_accounts_by_domain.js [options]
  node suspend_accounts_by_domain.js --resume [--plan-file <path>] [options]

Options:
  --mode <suspend|remove>  Action to take. Default: suspend (reversible).
                           remove is a permanent DELETE and is async on Atlassian's side.
  --domain <str>           Exact email domain to target (no leading @). Default: legacy-domain.com
  --domain-contains <str>  Partial email-domain match (substring). e.g. "migration" matches user@migration.atlassian.com
  --dry-run                Preview API calls without sending them.
  --plan-only              Build the plan + CSV and exit.
  --execute-only / --resume  Skip plan build, load existing plan.
  --plan-file <path>       Master index JSON file to resume from.
  --limit <n>              Stop after N pending entries during discovery.
  --concurrency <n>        Parallel API workers in execute phase. Default: 5
  --retry-failed           Reprocess entries with status "failed".
  --force-remove           Required when --mode=remove outside --dry-run.
  --include-non-atlassian  Disable the guardrail that skips customer/app account types.
  --include-already-suspended  In suspend mode, also include accounts already suspended (default: skipped server-side).
  --help                   Show this help.

Environment variables (in .env):
  ORG_ADMIN_API_KEY  Bearer token from admin.atlassian.com -> Settings -> API keys.
  ORG_ID             Org UUID (from the admin URL).

Examples:
  # Discover and preview (no writes)
  node main/suspend_accounts_by_domain.js --plan-only --limit 5

  # Full dry run against the whole org
  node main/suspend_accounts_by_domain.js --dry-run

  # Suspend everyone @legacy-domain.com (default mode)
  node main/suspend_accounts_by_domain.js

  # Resume an interrupted run
  node main/suspend_accounts_by_domain.js --resume

  # Permanently remove (after a suspend run was reviewed)
  node main/suspend_accounts_by_domain.js --mode remove --force-remove
    `);
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help":
        DisableAccountsRun.showHelp();
        process.exit(0);
      case "--mode":
        options.mode = args[++i];
        break;
      case "--domain":
        options.domain = args[++i].replace(/^@/, "");
        options.domainMatch = "eq";
        break;
      case "--domain-contains":
        options.domain = args[++i].replace(/^@/, "");
        options.domainMatch = "contains";
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--limit":
        options.limit = parseInt(args[++i], 10) || 0;
        break;
      case "--plan-only":
        options.planOnly = true;
        break;
      case "--execute-only":
      case "--resume":
        options.executeOnly = true;
        break;
      case "--plan-file":
        options.planFile = args[++i];
        break;
      case "--concurrency":
        options.concurrency = parseInt(args[++i], 10) || 5;
        break;
      case "--retry-failed":
        options.retryFailed = true;
        break;
      case "--force-remove":
        options.forceRemove = true;
        break;
      case "--include-non-atlassian":
        options.includeNonAtlassian = true;
        break;
      case "--include-already-suspended":
        options.includeAlreadySuspended = true;
        break;
      default:
        if (args[i].startsWith("--")) {
          console.warn(`Unknown option: ${args[i]}`);
        }
        break;
    }
  }

  return options;
}

async function main() {
  let run = null;

  const shutdown = () => {
    if (run && run.planManager) {
      console.log("\nShutting down gracefully...");
      if (run.planManager.plan) {
        run.planManager.savePlan();
        console.log(`Plan saved: ${run.planManager.planFilePath}`);
      }
      if (run.planManager.masterIndex) {
        run.planManager.saveMasterIndex();
        console.log(`Master index saved: ${run.planManager.masterIndexPath}`);
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    const options = parseArgs();
    run = new DisableAccountsRun(options);
    await run.run();
    console.log("\nCompleted.");
    process.exit(0);
  } catch (error) {
    console.error(`\nFatal error: ${error.message}`);
    if (error.stack) console.error(error.stack);
    if (run && run.planManager) {
      if (run.planManager.plan) {
        run.planManager.savePlan();
        console.log(`Plan saved: ${run.planManager.planFilePath}`);
      }
      if (run.planManager.masterIndex) {
        run.planManager.saveMasterIndex();
        console.log(`Master index saved: ${run.planManager.masterIndexPath}`);
      }
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = DisableAccountsRun;
