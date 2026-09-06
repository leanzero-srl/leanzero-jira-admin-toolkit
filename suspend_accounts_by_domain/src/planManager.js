const fs = require("fs");
const path = require("path");

/**
 * Plan/master-index manager for the account-disable script.
 *
 * Plan entries are keyed by `accountId` and shaped as:
 *   {
 *     email, name, accountStatus, platformRoles,
 *     action: "suspend" | "remove",
 *     status: "pending" | "completed" | "failed" | "skipped",
 *     skipReason: string | null,
 *     error: string | null,
 *     updatedAt: ISO8601
 *   }
 *
 * Mirrors the streaming-write pattern from sync_issue_parents so the file
 * format is interchangeable in spirit (large plans handled without loading
 * the whole object into memory at write time).
 */
class PlanManager {
  constructor(planDir, log) {
    this.planDir = planDir;
    this.log = log || console.log;
    this.plan = null;
    this.planFilePath = null;
    this.masterIndex = null;
    this.masterIndexPath = null;
    this.updatesSinceSave = 0;
    this.autoSaveThreshold = 100;
  }

  setPlanFile(filePath) {
    this.masterIndexPath = filePath;
  }

  // ─────────────────────────────────────────────────
  //  MASTER INDEX
  // ─────────────────────────────────────────────────

  createMasterIndex(runId, extra = {}) {
    if (!fs.existsSync(this.planDir)) {
      fs.mkdirSync(this.planDir, { recursive: true });
    }

    this.masterIndexPath = path.join(this.planDir, `master_${runId}.json`);
    this.masterIndex = {
      version: "1.0",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stats: {
        totalAccounts: 0,
        pending: 0,
        completed: 0,
        failed: 0,
        skipped: 0,
        domainMismatch: 0,
        alreadyInactive: 0,
        protectedAdmin: 0,
      },
      planFile: null,
      accountsCsv: null,
      ...extra,
    };

    this.saveMasterIndex();
    return this.masterIndex;
  }

  saveMasterIndex() {
    if (!this.masterIndex || !this.masterIndexPath) return;
    try {
      this.masterIndex.updatedAt = new Date().toISOString();
      fs.writeFileSync(this.masterIndexPath, JSON.stringify(this.masterIndex, null, 2));
    } catch (error) {
      this.log(`  ERROR saving master index: ${error.message}`);
    }
  }

  loadMasterIndex(filePath) {
    const target = filePath || this.masterIndexPath;
    if (!target) {
      this.log("  No master index specified, searching for latest...");
      const latest = this.findLatestMasterIndex();
      if (!latest) {
        this.log("  No existing master index found.");
        return null;
      }
      this.masterIndexPath = latest;
    } else {
      this.masterIndexPath = target;
    }

    if (!fs.existsSync(this.masterIndexPath)) {
      this.log(`  Master index not found: ${this.masterIndexPath}`);
      return null;
    }

    try {
      const data = fs.readFileSync(this.masterIndexPath, "utf8");
      this.masterIndex = JSON.parse(data);
      this.log(`  Loaded master index from ${this.masterIndexPath}`);
      this.log(`  ${this.masterIndex.stats.totalAccounts} total accounts`);
      return this.masterIndex;
    } catch (error) {
      this.log(`  ERROR loading master index: ${error.message}`);
      return null;
    }
  }

  findLatestMasterIndex() {
    if (!fs.existsSync(this.planDir)) return null;

    const files = fs.readdirSync(this.planDir)
      .filter((f) => f.startsWith("master_") && f.endsWith(".json"))
      .sort()
      .reverse();

    return files.length > 0 ? path.join(this.planDir, files[0]) : null;
  }

  // ─────────────────────────────────────────────────
  //  PLAN FILE
  // ─────────────────────────────────────────────────

  createPlan(runId, accountsMap) {
    if (!fs.existsSync(this.planDir)) {
      fs.mkdirSync(this.planDir, { recursive: true });
    }

    const planFile = path.join(this.planDir, `plan_${runId}.json`);

    this.plan = {
      version: "1.0",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stats: { total: 0, pending: 0, completed: 0, failed: 0, skipped: 0 },
      accounts: accountsMap,
    };

    this.recalculateStats();
    this.planFilePath = planFile;
    this._streamWritePlan(planFile, this.plan);

    if (this.masterIndex) {
      this.masterIndex.planFile = planFile;
      this.masterIndex.stats.totalAccounts = this.plan.stats.total;
      this.masterIndex.stats.pending = this.plan.stats.pending;
      this.masterIndex.stats.skipped = this.plan.stats.skipped;
      this.saveMasterIndex();
    }

    return { planFile, plan: this.plan };
  }

  _streamWritePlan(filePath, plan) {
    let fd = null;
    try {
      fd = fs.openSync(filePath, "w");
      fs.writeSync(fd, "{\n");
      fs.writeSync(fd, `"version":${JSON.stringify(plan.version)},\n`);
      fs.writeSync(fd, `"createdAt":${JSON.stringify(plan.createdAt)},\n`);
      fs.writeSync(fd, `"updatedAt":${JSON.stringify(plan.updatedAt)},\n`);
      fs.writeSync(fd, `"stats":${JSON.stringify(plan.stats)},\n`);
      fs.writeSync(fd, `"accounts":{\n`);

      const keys = Object.keys(plan.accounts);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const comma = i < keys.length - 1 ? ",\n" : "\n";
        fs.writeSync(fd, `${JSON.stringify(key)}:${JSON.stringify(plan.accounts[key])}${comma}`);
      }

      fs.writeSync(fd, "}\n}");
    } catch (error) {
      this.log(`  ERROR saving plan: ${error.message}`);
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
  }

  async loadPlan(filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
      this.log(`  Plan not found: ${filePath}`);
      return null;
    }

    try {
      this.log(`  Loading plan from ${filePath} (streaming)...`);
      const plan = { version: null, createdAt: null, updatedAt: null, stats: null, accounts: {} };

      const readline = require("readline");
      const rl = readline.createInterface({
        input: fs.createReadStream(filePath, { encoding: "utf-8" }),
        crlfDelay: Infinity,
      });

      let inAccounts = false;
      let accountCount = 0;

      // Each non-brace line is of the form `"key":value[,]`. Account-id keys
      // like "557058:abc..." contain literal colons, so we can't just split
      // on the first ":". Wrap the line as a fragment and let JSON.parse do it.
      const parseLine = (line) => {
        const clean = line.endsWith(",") ? line.slice(0, -1) : line;
        const obj = JSON.parse(`{${clean}}`);
        const k = Object.keys(obj)[0];
        return [k, obj[k]];
      };

      for await (const rawLine of rl) {
        const line = rawLine.trim();
        if (!line || line === "{" || line === "}") continue;

        if (line === '"accounts":{') {
          inAccounts = true;
          continue;
        }

        if (!inAccounts) {
          const [k, v] = parseLine(line);
          plan[k] = v;
        } else {
          const [k, v] = parseLine(line);
          plan.accounts[k] = v;
          accountCount++;
          if (accountCount % 5000 === 0) {
            this.log(`  Loaded ${accountCount} accounts...`);
          }
        }
      }

      this.plan = plan;
      this.planFilePath = filePath;
      this.recalculateStats();
      this.log(`  Loaded plan: ${this.formatStats()}`);
      return this.plan;
    } catch (error) {
      this.log(`  ERROR loading plan: ${error.message}`);
      return null;
    }
  }

  savePlan() {
    if (!this.plan || !this.planFilePath) return;

    this.plan.updatedAt = new Date().toISOString();
    this.recalculateStats();
    this._streamWritePlan(this.planFilePath, this.plan);
    this.updatesSinceSave = 0;

    if (this.masterIndex) {
      this.masterIndex.stats.pending = this.plan.stats.pending;
      this.masterIndex.stats.completed = this.plan.stats.completed;
      this.masterIndex.stats.failed = this.plan.stats.failed;
      this.masterIndex.stats.skipped = this.plan.stats.skipped;
      this.saveMasterIndex();
    }
  }

  // ─────────────────────────────────────────────────
  //  STATUS TRACKING
  // ─────────────────────────────────────────────────

  getAccountsToProcess(retryFailed = false) {
    if (!this.plan) return [];
    return Object.entries(this.plan.accounts).filter(
      ([, data]) => data.status === "pending" || (retryFailed && data.status === "failed"),
    );
  }

  updateAccountStatus(accountId, status, error = null) {
    if (!this.plan || !this.plan.accounts[accountId]) return;

    this.plan.accounts[accountId].status = status;
    this.plan.accounts[accountId].error = error;
    this.plan.accounts[accountId].updatedAt = new Date().toISOString();

    this.updatesSinceSave++;
    if (this.updatesSinceSave >= this.autoSaveThreshold) {
      this.savePlan();
    }
  }

  recalculateStats() {
    if (!this.plan) return;

    const stats = { total: 0, pending: 0, completed: 0, failed: 0, skipped: 0 };

    for (const acct of Object.values(this.plan.accounts)) {
      stats.total++;
      if (stats[acct.status] !== undefined) {
        stats[acct.status]++;
      }
    }

    this.plan.stats = stats;
  }

  formatStats() {
    if (!this.plan) return "No plan loaded";
    const s = this.plan.stats;
    return `${s.total} accounts (${s.pending} pending, ${s.completed} completed, ${s.failed} failed, ${s.skipped} skipped)`;
  }

  getPlanSummary() {
    if (this.masterIndex) {
      return {
        ...this.masterIndex.stats,
        masterFile: this.masterIndexPath,
        planFile: this.masterIndex.planFile || null,
      };
    }
    if (this.plan) {
      return {
        ...this.plan.stats,
        planFile: this.planFilePath,
      };
    }
    return null;
  }
}

module.exports = PlanManager;
