const fs = require("fs");
const path = require("path");

class AccountProcessor {
  constructor(orgClient, planManager, options) {
    this.orgClient = orgClient;
    this.planManager = planManager;
    this.options = options;
    this.log = options.log;
    this.logDir = options.logDir;

    this.stats = {
      accountsScanned: 0,
      domainMismatch: 0,
      emailHidden: 0,
      nonAtlassianType: 0,
      alreadyInactive: 0,
      alreadyClosed: 0,
      alreadySuspendedSkipped: 0,
      planned: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
      alreadyGone404: 0,
    };
  }

  getStats() {
    return this.stats;
  }

  // ─────────────────────────────────────────────────
  //  PHASE 1 — BUILD PLAN
  // ─────────────────────────────────────────────────

  async buildPlan(runId) {
    const { domain, domainMatch, mode, limit, includeNonAtlassian, includeAlreadySuspended } = this.options;
    const matchMode = domainMatch === "contains" ? "contains" : "eq";

    this.planManager.createMasterIndex(runId, {
      orgId: this.orgClient.orgId,
      domain,
      domainMatch: matchMode,
      mode,
    });

    // For suspend, the server-side `isSuspended:false` filter excludes accounts
    // that are already suspended (the bulk of the @legacy-domain.com population in
    // staff), saving us thousands of no-op calls. Override with --include-already-suspended.
    // For remove, we want everyone so the suspend-then-remove workflow can sweep them up.
    const searchOpts = { match: matchMode };
    if (mode === "suspend" && !includeAlreadySuspended) {
      searchOpts.isSuspended = false;
    }
    // contains-mode queries are slower server-side; smaller pages keep us under the 504 threshold.
    if (matchMode === "contains") {
      searchOpts.pageSize = 25;
    }

    const filterLabel = matchMode === "contains" ? `*@*${domain}*` : `@${domain}`;
    this.log(`  Searching org users for emails matching ${filterLabel}` +
      (searchOpts.isSuspended === false ? " (excluding already-suspended)" : "") + "...");
    const accounts = {};
    let scannedSinceLog = 0;

    for await (const user of this.orgClient.searchUsersByDomain(domain, searchOpts)) {
      this.stats.accountsScanned++;
      scannedSinceLog++;
      if (scannedSinceLog >= 500) {
        this.log(`    scanned ${this.stats.accountsScanned} accounts so far (${this.stats.planned} pending)...`);
        scannedSinceLog = 0;
      }

      // v1 PublicUser: { accountId, accountType, accountStatus, name, email?, ... }
      const accountId = user.accountId;
      const accountType = user.accountType;
      const accountStatus = user.accountStatus;
      const name = user.name || "";
      const email = user.email || "";

      // Email may be absent if the user restricted visibility — without it
      // we can't safely filter by domain, so skip and log it.
      if (!email) {
        this.stats.emailHidden++;
        continue;
      }

      const emailLc = email.toLowerCase();
      const domainLc = domain.toLowerCase();
      const matches =
        matchMode === "contains"
          ? emailLc.includes("@") && emailLc.split("@")[1].includes(domainLc)
          : emailLc.endsWith("@" + domainLc);
      if (!matches) {
        this.stats.domainMismatch++;
        continue;
      }

      // Only act on Atlassian-type accounts by default. App and customer
      // accounts can match the domain but live in a different lifecycle.
      if (!includeNonAtlassian && accountType !== "atlassian") {
        this.stats.nonAtlassianType++;
        accounts[accountId] = {
          email,
          name,
          accountType,
          accountStatus,
          action: mode,
          status: "skipped",
          skipReason: `non-atlassian-type:${accountType}`,
          error: null,
          updatedAt: new Date().toISOString(),
        };
        continue;
      }

      // account_status: "active" | "inactive" | "closed".
      // - "closed" is the terminal state for both suspend and remove: skip always.
      // - "inactive" is the suspended state: skip for suspend, allow for remove
      //   (suspend-then-remove is a real workflow).
      if (accountStatus === "closed") {
        this.stats.alreadyClosed++;
        accounts[accountId] = {
          email,
          name,
          accountType,
          accountStatus,
          action: mode,
          status: "skipped",
          skipReason: "already-closed",
          error: null,
          updatedAt: new Date().toISOString(),
        };
        continue;
      }
      if (mode === "suspend" && accountStatus === "inactive") {
        this.stats.alreadyInactive++;
        accounts[accountId] = {
          email,
          name,
          accountType,
          accountStatus,
          action: mode,
          status: "skipped",
          skipReason: "already-inactive",
          error: null,
          updatedAt: new Date().toISOString(),
        };
        continue;
      }

      accounts[accountId] = {
        email,
        name,
        accountType,
        accountStatus,
        action: mode,
        status: "pending",
        skipReason: null,
        error: null,
        updatedAt: new Date().toISOString(),
      };
      this.stats.planned++;

      if (limit > 0 && this.stats.planned >= limit) {
        this.log(`  Limit reached (${limit} pending entries); stopping discovery.`);
        break;
      }
    }

    this.planManager.createPlan(runId, accounts);

    this.log(
      `  Plan built: ${this.stats.accountsScanned} scanned, ${this.stats.planned} pending. ` +
        `Skipped: ${this.stats.domainMismatch} domain-mismatch, ${this.stats.emailHidden} email-hidden, ` +
        `${this.stats.nonAtlassianType} non-atlassian, ${this.stats.alreadyInactive} already-inactive, ` +
        `${this.stats.alreadyClosed} already-closed.`,
    );

    if (this.planManager.masterIndex) {
      Object.assign(this.planManager.masterIndex.stats, {
        domainMismatch: this.stats.domainMismatch,
        emailHidden: this.stats.emailHidden,
        nonAtlassianType: this.stats.nonAtlassianType,
        alreadyInactive: this.stats.alreadyInactive,
        alreadyClosed: this.stats.alreadyClosed,
      });
      this.planManager.saveMasterIndex();
    }

    this.writeAccountsCsv(runId, accounts);
  }

  writeAccountsCsv(runId, accounts) {
    const csvPath = path.join(this.logDir, `accounts_${runId}.csv`);
    const header = "accountId,email,name,accountType,accountStatus,plannedAction,status,skipReason\n";
    const escape = (v) => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    const lines = [header];
    for (const [accountId, data] of Object.entries(accounts)) {
      lines.push(
        [
          escape(accountId),
          escape(data.email),
          escape(data.name),
          escape(data.accountType),
          escape(data.accountStatus),
          escape(data.action),
          escape(data.status),
          escape(data.skipReason || ""),
        ].join(",") + "\n",
      );
    }

    try {
      fs.writeFileSync(csvPath, lines.join(""));
      this.log(`  Accounts CSV written: ${csvPath}`);
      if (this.planManager.masterIndex) {
        this.planManager.masterIndex.accountsCsv = csvPath;
        this.planManager.saveMasterIndex();
      }
    } catch (err) {
      this.log(`  ERROR writing CSV: ${err.message}`);
    }
  }

  // ─────────────────────────────────────────────────
  //  PHASE 2 — EXECUTE
  // ─────────────────────────────────────────────────

  async executePlan() {
    const { dryRun, concurrency, retryFailed } = this.options;

    const todo = this.planManager.getAccountsToProcess(retryFailed);
    if (todo.length === 0) {
      this.log("  Nothing to do — no pending entries.");
      return;
    }

    this.log(`  ${todo.length} entries to process (concurrency=${concurrency}, dryRun=${dryRun})`);

    const batchSize = Math.max(concurrency * 5, 25);

    for (let i = 0; i < todo.length; i += batchSize) {
      const batch = todo.slice(i, i + batchSize);
      await this._runBatch(batch, dryRun, concurrency);

      if (!dryRun) {
        this.planManager.savePlan();
      }

      this.log(
        `    progress: ${Math.min(i + batchSize, todo.length)}/${todo.length} ` +
          `(succeeded=${this.stats.succeeded}, failed=${this.stats.failed}, ` +
          `already-gone=${this.stats.alreadyGone404})`,
      );
    }
  }

  async _runBatch(entries, dryRun, concurrency) {
    let idx = 0;
    const worker = async () => {
      while (idx < entries.length) {
        const current = idx++;
        const [accountId, data] = entries[current];
        await this._processOne(accountId, data, dryRun);
      }
    };

    const workers = [];
    for (let w = 0; w < Math.min(concurrency, entries.length); w++) {
      workers.push(worker());
    }
    await Promise.all(workers);
  }

  async _processOne(accountId, data, dryRun) {
    const action = data.action;
    const label = `${data.email || "(no-email)"} (${accountId})`;

    if (dryRun) {
      this.log(`  [dry-run] Would ${action} ${label}`);
      this.stats.processed++;
      this.stats.succeeded++;
      return;
    }

    try {
      if (action === "suspend") {
        await this.orgClient.suspendUser(accountId);
      } else if (action === "remove") {
        await this.orgClient.removeUser(accountId);
      } else {
        throw new Error(`Unknown action: ${action}`);
      }
      this.planManager.updateAccountStatus(accountId, "completed", null);
      this.stats.processed++;
      this.stats.succeeded++;
      this.log(`  ${action === "suspend" ? "Suspended" : "Removed"}: ${label}`);
    } catch (err) {
      if (err.statusCode === 404) {
        // ADMIN-404-8: user already not in the directory — idempotent re-run case.
        this.planManager.updateAccountStatus(accountId, "completed", "404 already-gone");
        this.stats.processed++;
        this.stats.alreadyGone404++;
        this.stats.succeeded++;
        this.log(`  Already gone (404): ${label}`);
        return;
      }
      this.planManager.updateAccountStatus(accountId, "failed", err.message);
      this.stats.processed++;
      this.stats.failed++;
      this.log(`  FAILED ${action} ${label}: ${err.message}`);
    }
  }
}

module.exports = AccountProcessor;
