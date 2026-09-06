#!/usr/bin/env node

/**
 * Throwaway helper — drafts a `cloud_user_map.csv` for the
 * `backfill-missing-schemes` mode by reading the unique DC usernames listed
 * in an audit file's `droppedGrants` and querying Cloud `/user/search` for
 * each. The output is for **manual review** — wrong / ambiguous rows must be
 * fixed before the CSV is fed back to the deterministic backfill run.
 *
 * Usage:
 *   node draft_user_map.js \
 *     --cloud-url https://your-instance.atlassian.net \
 *     --basic-auth <pre-base64-encoded "email:token"> \
 *     --audit backfill_dryrun_<ts>.json \
 *     --out draft_user_map.csv
 *
 * Output CSV columns (with header):
 *   dc_username,cloud_account_id,cloud_email,cloud_display_name,cloud_active,match_count,note
 *
 * After reviewing, keep only the first two columns to feed back to
 * `backfill-missing-schemes --user-map`.
 */

const https = require("https");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");
const { program } = require("commander");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function rawGet(fullBaseUrl, authHeader, pathAndQuery, retry = 0) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathAndQuery, fullBaseUrl);
    const opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: "GET",
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
        "X-Atlassian-Token": "no-check",
      },
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", async () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data || "[]")); }
          catch (_) { resolve([]); }
          return;
        }
        if ((res.statusCode === 429 || res.statusCode >= 500) && retry < 5) {
          const ra = parseInt(res.headers["retry-after"] || "0", 10);
          await sleep(ra > 0 ? ra * 1000 : Math.min(1000 * 2 ** retry, 30000));
          try { resolve(await rawGet(fullBaseUrl, authHeader, pathAndQuery, retry + 1)); }
          catch (e) { reject(e); }
          return;
        }
        reject(new Error(`HTTP ${res.statusCode}: ${data}`));
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

program
  .requiredOption("--cloud-url <url>", "Jira Cloud URL")
  .requiredOption("--audit <file>", "Audit JSON written by backfill-missing-schemes")
  .option("--basic-auth <encoded>", "Pre-base64 'email:token' (or env JIRA_CLOUD_BASIC_AUTH)")
  .option("--email <email>", "Atlassian email")
  .option("--token <token>", "Atlassian API token")
  .option("--out <file>", "Output CSV path", "draft_user_map.csv")
  .parse(process.argv);

const opts = program.opts();
const cloudFullBase = /^https?:\/\//.test(opts.cloudUrl) ? opts.cloudUrl : `https://${opts.cloudUrl}`;
let basic = (opts.basicAuth || process.env.JIRA_CLOUD_BASIC_AUTH || "").trim();
if (!basic) {
  if (!opts.email || !opts.token) {
    console.error("❌ Provide --basic-auth or both --email + --token.");
    process.exit(1);
  }
  basic = Buffer.from(`${opts.email}:${opts.token}`).toString("base64");
}
const authHeader = `Basic ${basic}`;

(async () => {
  const audit = JSON.parse(fs.readFileSync(path.resolve(opts.audit), "utf8"));
  const usernames = new Set();
  for (const r of audit.results || []) {
    for (const d of r.droppedGrants || []) {
      const t = d?.original?.holder?.type;
      const p = d?.original?.holder?.parameter;
      if (t === "user" && p) usernames.add(p);
    }
  }
  if (usernames.size === 0) {
    console.log("No dropped 'user' grants in the audit. Nothing to draft.");
    process.exit(0);
  }
  console.log(`Looking up ${usernames.size} unique DC username(s) on Cloud...\n`);

  const rows = [
    "dc_username,cloud_account_id,cloud_email,cloud_display_name,cloud_active,match_count,note",
  ];
  for (const dcUser of usernames) {
    let matches = [];
    let note = "";
    try {
      // Cloud user search — case-insensitive, queries displayName + email.
      // Returns up to 50 by default.
      matches = await rawGet(
        cloudFullBase,
        authHeader,
        `/rest/api/3/user/search?query=${encodeURIComponent(dcUser)}`,
      );
    } catch (e) {
      note = `lookup_error: ${e.message}`;
    }
    if (!Array.isArray(matches)) matches = [];
    // Filter to active atlassian-account users.
    const candidates = matches.filter(
      (m) => (m.accountType || "atlassian") === "atlassian",
    );
    let pick = null;
    if (candidates.length === 0) {
      note = note || "no_match";
    } else if (candidates.length === 1) {
      pick = candidates[0];
    } else {
      // Heuristic: prefer exact email-localpart match, then displayName containing username.
      const lower = dcUser.toLowerCase();
      pick = candidates.find(
        (m) =>
          (m.emailAddress || "").toLowerCase().split("@")[0] === lower ||
          (m.emailAddress || "").toLowerCase() === lower,
      );
      if (!pick) pick = candidates.find(
        (m) => (m.displayName || "").toLowerCase().includes(lower),
      );
      if (!pick) pick = candidates[0];
      note = `ambiguous_${candidates.length}_match — REVIEW`;
    }
    rows.push(
      [
        csvEscape(dcUser),
        csvEscape(pick?.accountId || ""),
        csvEscape(pick?.emailAddress || ""),
        csvEscape(pick?.displayName || ""),
        csvEscape(pick?.active === undefined ? "" : String(pick.active)),
        csvEscape(candidates.length),
        csvEscape(note),
      ].join(","),
    );
    console.log(
      `  ${dcUser.padEnd(40)} -> ${pick ? pick.accountId : "(no match)"}` +
        (note ? `  [${note}]` : ""),
    );
    // Be polite to the Cloud API.
    await sleep(150);
  }

  fs.writeFileSync(path.resolve(opts.out), rows.join("\n") + "\n", "utf8");
  console.log(`\n💾 Draft CSV written to: ${path.resolve(opts.out)}`);
  console.log(
    "👉 REVIEW the CSV. Fix any 'no_match' / 'ambiguous_*' rows. Remove rows " +
      "you don't want to keep. Then strip everything after the second column " +
      "(or pass the file as-is — backfill-missing-schemes only uses the first " +
      "two columns).",
  );
})().catch((e) => {
  console.error("Unhandled error:", e);
  process.exit(1);
});
