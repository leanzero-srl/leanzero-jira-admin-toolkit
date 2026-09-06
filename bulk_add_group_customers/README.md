# bulk_add_group_customers

Collect every member of a Jira Cloud group and add them as **JSM customers** on
`your-site.atlassian.net` via `POST /rest/servicedeskapi/customer`.

Built for: group **staff** = `00000000-0000-0000-0000-00000000g001` (~1063 members).

## Setup

```bash
cd bulk_add_group_customers
npm install
# .env already holds CLOUD_BASE_URL + CLOUD_API_TOKEN (copied from the other
# sibling scripts; Basic auth, base64("email:apiToken")).
```

## How it works (two phases)

### 1. Collect + feasibility gate
```bash
node collect_members.js          # --group <id> to override
```
Pages `GET /rest/api/3/group/member`, writes `out/members.json` and `out/members.csv`,
and prints a **feasibility report**: total members, how many emails resolved, and a
breakdown by accountType.

> ⚠ **The email count is the go/no-go gate.** Atlassian applies per-user privacy to
> `emailAddress`; hidden ones come back `null` and a normal admin token cannot recover
> them. If a large share are missing, stop — you'd need the org-admin Directory API
> (different credential) instead.

### 2. Add as customers
```bash
node add_customers.js                       # DRY-RUN (default) — prints, sends nothing
node add_customers.js --send --limit 1      # smoke test: create the first candidate only
node add_customers.js --send                # full live run
```

Notable behaviour:
- **Dry-run by default.** Only `--send` actually POSTs.
- **Resumable.** Each outcome is appended to `out/progress.jsonl`; re-runs skip emails
  already recorded as `created`/`exists`/`invalid`. Safe to stop and restart.
- **409 = `exists`** (already a customer/account) — treated as success, not an error.
  Expect many of these, since group members already have accounts.
- **403 aborts** the run — means the token lacks Jira Administrator Global permission.
- Honours `Retry-After` on 429 and backs off on 5xx. Low concurrency (default 4).

### Flags
| flag | meaning |
|---|---|
| `--send` | actually create (otherwise dry-run) |
| `--limit N` | process at most N candidates |
| `--email a@b.com [--name "A B"]` | create a single ad-hoc address (smoke test) |
| `--include-inactive` | also include inactive accounts |
| `--concurrency N` | parallel requests (default 4) |

## Notes
- The endpoint has **no notification flag** (only `strictConflictStatusCode`). On this
  instance the mail server is off, so nothing is sent regardless.
- `.env` and `out/` are gitignored; tokens are never logged.
- There is no clean delete-customer endpoint — created accounts persist (deactivate via
  org admin if needed). This is why dry-run is the default and `--limit 1` runs first.
