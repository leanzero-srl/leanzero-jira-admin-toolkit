# suspend_accounts_by_domain

Suspend (or remove) Atlassian org accounts filtered by email domain. Default target: `@legacy-domain.com`. Targets the **Atlassian Access REST API v1** (`https://api.atlassian.com/admin/v1/...`).

> **Why v1 not v2?** The staff org we built this for is on the legacy user-management experience — `/admin/v2/*` returns 404 for it. v1 doesn't require a directory ID and exposes the same suspend/remove capabilities under different paths. See `openapi-org.json` (shipped with the script) for the canonical surface.

> **Discovery uses `POST /v1/orgs/{orgId}/users/search`, not `GET /users`.** The plain `GET /users` endpoint only returns *managed* accounts (those whose email domain the org has claimed). Invited but unclaimed users — which is exactly the @legacy-domain.com case in staff — never appear there. The search endpoint covers both and accepts a server-side `emailDomains` filter, so we don't have to page tens of thousands of unrelated users. Atlassian has marked this endpoint as deprecated after **June 30, 2026**; this is a one-off migration script, so the time-bomb is acceptable.

## One-time setup

1. **Mint an admin API key.** Log into `admin.atlassian.com` as an organization admin → **Settings → API keys** → **Create API key**. The key is shown once — copy it. The key inherits the creator's permissions, so the creator must be an org admin.
2. **Find your org ID** from the admin URL: `https://admin.atlassian.com/o/<ORG_ID>/...`.
3. Copy `.env.example` → `.env` and fill in:
   ```
   ORG_ADMIN_API_KEY=<the token from step 1>
   ORG_ID=<the UUID from step 2>
   ```
4. `npm install`

## Modes

- **`suspend` (default)** — `POST /admin/v1/orgs/{orgId}/directory/users/{accountId}/suspend-access`. Sets `account_status=inactive`, frees the license, keeps the data. Recover with `POST .../restore-access`.
- **`remove`** — `DELETE /admin/v1/orgs/{orgId}/directory/users/{accountId}`. Returns 204 but is **asynchronous and permanent**. Requires `--force-remove` outside of `--dry-run`.

## Usage

```bash
# 1. Preview discovery + CSV report (no API writes)
npm run plan-only -- --limit 5

# 2. Full dry run with no destructive calls
npm run dry-run

# 3. Suspend everyone matching the domain
npm start

# 4. Resume an interrupted run
npm run resume

# 5. Permanently remove (after suspend run was reviewed)
node main/suspend_accounts_by_domain.js --mode remove --force-remove
```

### CLI options

| Flag | Default | Purpose |
|---|---|---|
| `--mode <suspend\|remove>` | `suspend` | Action to apply. |
| `--domain <str>` | `legacy-domain.com` | Email domain (no `@`). |
| `--dry-run` | off | Log what would happen; no API writes. |
| `--plan-only` | off | Build plan + CSV, exit. |
| `--execute-only` / `--resume` | off | Skip discovery; run existing plan. |
| `--plan-file <path>` | latest | Master index JSON to resume from. |
| `--limit <n>` | 0 (all) | Stop after N pending entries in discovery. |
| `--concurrency <n>` | 5 | Parallel suspend/remove calls. |
| `--retry-failed` | off | Reprocess entries with status `failed`. |
| `--force-remove` | off | Required for `--mode=remove` outside `--dry-run`. |
| `--include-non-atlassian` | off | Disable the guardrail that skips `customer` / `app` account types. |

### Safety guardrails

1. `--mode=remove` outside `--dry-run` requires `--force-remove`.
2. Only `account_type === "atlassian"` accounts are processed by default. `customer` (JSM portal users) and `app` (Connect/Forge service accounts) are skipped with `skipReason=non-atlassian-type:<type>`. Override with `--include-non-atlassian`.
3. Accounts with hidden emails (privacy-restricted) are skipped silently — we can't safely match the domain without an email.
4. `account_status="closed"` is terminal; always skipped.
5. `account_status="inactive"` is skipped in `suspend` mode (no-op) but **processed** in `remove` mode, which enables the suspend-then-remove workflow.
6. The domain match is enforced client-side: `email.toLowerCase().endsWith('@<domain>')`. v1 has no server-side domain filter, so the script pages through every managed account in the org.
7. A `404` on the destructive call is treated as success (idempotent on re-run).
8. **No org-admin guardrail** — v1 doesn't expose `platformRoles` on the user list. Review the generated CSV before running without `--dry-run` and confirm no admins are in the target set.

## Outputs

Everything lands in `logs/`:

- `disable_<ts>.log` — full timestamped trace.
- `master_<ts>.json` — run-level index with stats + paths to plan/CSV.
- `plan_<ts>.json` — per-account plan, keyed by `account_id`, statuses `pending|completed|failed|skipped`.
- `accounts_<ts>.csv` — `accountId,email,name,accountType,accountStatus,plannedAction,status,skipReason`. **Review this before re-running without `--dry-run`.**

## Recovery

To restore a mistakenly suspended account:
```bash
curl -X POST \
  -H "Authorization: Bearer $ORG_ADMIN_API_KEY" \
  https://api.atlassian.com/admin/v1/orgs/<orgId>/directory/users/<accountId>/restore-access
```

`remove` is irreversible — the user must be re-invited from scratch.

## Pre-flight checklist before a production run

1. `npm run plan-only -- --limit 5` — confirms auth + lists the first 5 matches. Inspect the CSV; verify every email ends in `@legacy-domain.com` and **no org admins are in the list**.
2. `npm run dry-run -- --limit 5` — confirms the suspend/remove call paths emit `[dry-run] Would suspend …` lines.
3. Pick **one** non-critical legacy-domain account, edit a fresh plan (or use `--limit 1`), run `npm start`, confirm `account_status=inactive` in `admin.atlassian.com`. Restore it via the curl above to verify the recovery path.
4. Full run: `npm start`. Resume after interruption with `npm run resume`.
5. Only after the suspend run is reviewed and accepted, optionally run `--mode remove --force-remove` against the same population. (Inactive accounts are eligible for remove.)
