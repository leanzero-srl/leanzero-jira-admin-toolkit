# bulk-assign-permission-scheme

Exports, bulk-assigns, and restores project → permission scheme mappings on **Jira Cloud**.

A Node port of three Groovy Data Center scripts into a single CLI with three modes (`export`, `apply`, `restore`) plus a backup/restore safety model.

---

## 1. Why this exists

The operator needs to:

1. Snapshot every project's current permission scheme before making changes.
2. Bulk-assign all projects (or a filtered subset) to one target permission scheme.
3. Roll back to the snapshot if the bulk change caused problems.

In Jira Data Center this was three Groovy console scripts using `ComponentAccessor.getPermissionSchemeManager()`. That API does not exist in Jira Cloud — Cloud only exposes REST endpoints, and there is **no bulk endpoint**. Every project is mutated individually via `PUT /rest/api/3/project/{keyOrId}/permissionscheme`, so the script has to iterate, rate-limit-retry, and track per-project failures.

The script is the operational equivalent of those three Groovy scripts, plus:

- Auto-backup before any mutation (impossible to skip).
- `--dry-run` + `--confirm` dual gating.
- `--only-key` regex filter so you can test on one project first.
- Scheme resolution by **id first, then name** on restore, so a DC export JSON can be fed back into Cloud as long as the scheme names line up.

---

## 2. References

### 2.1 Origin (Groovy DC scripts)

The `main/` directory in `jira/jira-data/add-to-permission-schemes/` contained three Groovy scripts that this folder ports. In summary:

- **Export**: iterated `projectManager.projects`, called `permissionSchemeManager.getSchemeFor(project)`, returned a JSON with `{exportedAt, jiraBaseUrl, projectPermissionSchemes[]}`. The backup JSON shape in this script **matches that Groovy output verbatim** — the files are interchangeable.
- **Apply (hardcoded id)**: looked up the target via `permissionSchemeManager.getSchemeObject(id)`, then for every project called `permissionSchemeService.assignPermissionSchemeToProject(user, id, projectId)`.
- **Restore**: parsed a JSON mapping, resolved each scheme by id then by name as fallback, called `removeSchemesFromProject(project)` + `addSchemeToProject(project, targetScheme)`. This script preserves the same id → name fallback on restore.

### 2.2 Atlassian REST API (Cloud, v3)

All endpoints were verified against `https://developer.atlassian.com/cloud/jira/platform/rest/v3/` (April 2026). Only five endpoints are used:

| # | Purpose | Method + Path | Notes |
|---|---|---|---|
| 1 | Connection check | `GET /rest/api/3/serverInfo` | |
| 2 | List projects (paginated) | `GET /rest/api/3/project/search?startAt&maxResults&action` | Returns `PageBeanProject` with `isLast`, `values[]`. Pass `action=view` to exclude archived. |
| 3 | List permission schemes | `GET /rest/api/3/permissionscheme` | Returns `{ permissionSchemes: [{id, name, description, self}] }`. |
| 4 | Get project's current scheme | `GET /rest/api/3/project/{keyOrId}/permissionscheme` | Returns `{id, name, description, self}`. |
| 5 | Assign scheme to project | `PUT /rest/api/3/project/{keyOrId}/permissionscheme` | Body: `{ "id": <integer> }`. **Requires _Administer Jira_ global permission.** |

No bulk endpoint exists. One PUT per project.

### 2.3 Sibling reference (for anyone extending this)

`jira/jira-data/add-to-permission-schemes/` is the nearest architectural neighbor in the repo. This folder's `src/cloudJiraClient.js` started as a copy of that one, then gained three methods (`fetchAllProjects`, `getProjectPermissionScheme`, `assignPermissionSchemeToProject`). The auth model (Basic with a pre-base64'd `email:api_token`), env loading (`dotenv` pointed at `../.env`), logging convention (timestamped file in `./logs/`), and retry logic (429 + 5xx with backoff) all follow that sibling exactly.

---

## 3. File map

```
bulk-assign-permission-scheme/
├── main/
│   └── bulk_assign_permission_scheme.js   ← entry point; CLI, modes, reporting
├── src/
│   └── cloudJiraClient.js                  ← HTTP client with retry, auth, and 5 Jira endpoints
├── logs/                                   ← auto-created; run logs + backup JSONs land here
├── package.json                            ← dotenv ^17 is the only dep
├── .env.example                            ← CLOUD_BASE_URL, CLOUD_API_TOKEN
└── README.md                               ← this file
```

**No shared utilities with other folders** — every folder in `jira/jira-data/*` is self-contained. This is a deliberate convention in the repo; don't try to extract a shared lib.

---

## 4. How it works (architecture)

### 4.1 Runtime flow

```
main() in bulk_assign_permission_scheme.js
├── parse CLI args (--mode, --scheme-id, --file, --dry-run, --confirm, --only-key, --include-archived)
├── validate env vars (CLOUD_BASE_URL, CLOUD_API_TOKEN)
├── new CloudJiraClient(baseUrl, apiToken, log)
├── client.testConnection()        ─ GET /rest/api/3/serverInfo
└── branch on --mode:
    ├── runExport(client)
    ├── runApply(client)
    └── runRestore(client)
```

### 4.2 `CloudJiraClient` (`src/cloudJiraClient.js`)

Single class, no external HTTP lib — uses Node's built-in `https`/`http`. Its `makeRequest(method, path, body, retryState)`:

- Adds `Authorization: Basic <CLOUD_API_TOKEN>`, JSON content/accept headers, 30s timeout.
- On **HTTP 429**: reads `retry-after`, else backs off 5s → 10s → 20s, up to 3 attempts.
- On **HTTP 5xx**: exponential backoff up to 10s, up to 3 attempts — **except** when the body contains `"Illegal Entity Scope"` / `"entity scope"`, which are treated as non-retriable validation errors.
- On **connection errors / timeouts**: same 3-attempt retry with linear backoff.
- Tracks `requestCount`, `errorCount`, `rateLimitCount` for the final report.

High-level methods on top of `makeRequest`:

| Method | Endpoint | Notes |
|---|---|---|
| `testConnection()` | GET serverInfo | |
| `fetchAllPermissionSchemes()` | GET `/permissionscheme` | Returns `body.permissionSchemes[]`. |
| `fetchAllProjects({ includeArchived })` | GET `/project/search` | Loops over `startAt` until `isLast === true`. Passes `action=view` to exclude archived by default. |
| `getProjectPermissionScheme(keyOrId)` | GET `/project/{key}/permissionscheme` | Returns `{id, name, ...}`. |
| `assignPermissionSchemeToProject(keyOrId, schemeId)` | PUT `/project/{key}/permissionscheme` | Body `{ id: Number(schemeId) }` — the id is coerced to a JSON number, not a string (the Cloud API rejects strings). |

### 4.3 The three modes (`main/bulk_assign_permission_scheme.js`)

#### `runExport(client)`

1. `fetchAllProjects()` → list.
2. Apply `--only-key` regex (optional).
3. For each project, `getProjectPermissionScheme(project.key)` → build `{projectId, projectKey, projectName, permissionSchemeId, permissionSchemeName}`.
4. `writeBackup(mappings)` → `logs/permission_scheme_backup_<runTs>.json`.

If a single project's GET fails, the mapping is still recorded with `permissionSchemeId: null` and an `error` field — the backup is never partial.

#### `runApply(client)`

1. Validate `--scheme-id` is a positive integer.
2. `fetchAllPermissionSchemes()` → confirm the target id exists. Fail fast with a listing of available schemes if not.
3. `fetchAllProjects()` + `--only-key` filter.
4. `collectCurrentMappings(client, projects)` — same flow as export.
5. `writeBackup(mappings)` — **always**, even when `--dry-run` or `--confirm` is missing. This is the critical safety rail.
6. Iterate mappings:
   - `error` on read → `SKIP`.
   - Already on target → `UNCHANGED`.
   - `--dry-run` or no `--confirm` → `WOULD UPDATE` log line, counted as "would update".
   - Otherwise → `assignPermissionSchemeToProject(key, schemeIdNum)`. On failure, push to `failures[]` and continue.
7. Final report includes backup path, counts, and a retry `curl` command per failed project.

#### `runRestore(client)`

1. Read the backup file. Accepts both shapes (for interoperability with the Groovy DC export):
   - Full object: `{ projectPermissionSchemes: [...] }`
   - Bare array: `[...]`
2. `fetchAllPermissionSchemes()` → build `schemesById` (`Map<number, scheme>`) and `schemesByName` (`Map<string, scheme>`).
3. For each mapping:
   - Apply `--only-key` filter.
   - Resolve target scheme: **id first, name fallback**. Mirrors the Groovy restore.
   - `getProjectPermissionScheme(key)` for current value — skip if already equal.
   - `--dry-run` / no `--confirm` → `WOULD RESTORE` log only.
   - Otherwise → `assignPermissionSchemeToProject(key, target.id)`.

### 4.4 Safety model (invariants)

These are deliberate — do **not** remove them in future edits:

1. **Backup always precedes mutation in `apply` mode.** The `writeBackup()` call happens before any PUT, regardless of `--dry-run` / `--confirm`. Even a failed run leaves an audit artifact.
2. **Two independent gates for mutation**: `--confirm` must be present AND `--dry-run` must be absent. Either one alone turns the run into a preview.
3. **Pre-flight scheme validation.** `apply` fails fast if `--scheme-id` is not a known scheme, printing the full list of valid ids. No partial-run because the first PUT returned 404.
4. **Failure isolation.** A per-project try/catch ensures one 400/500/403 never aborts the full run; failures are collected and re-printed at the end with a ready-to-copy retry `curl`.
5. **Idempotency.** Projects already on the target scheme are never PUT — they're logged `UNCHANGED`. Re-running `apply` after a partial run converges.

---

## 5. Setup

```bash
cd jira/jira-data/bulk-assign-permission-scheme
npm install
cp .env.example .env
# edit .env:
#   CLOUD_BASE_URL=https://your-site.atlassian.net
#   CLOUD_API_TOKEN=<base64 of "email:api_token">
```

Generate `CLOUD_API_TOKEN`:

```bash
printf 'your.email@example.com:your-api-token' | base64
```

The API token user needs **Administer Jira** global permission. The PUT endpoint returns 403 otherwise.

---

## 6. Usage

### Export (always safe)

```bash
node main/bulk_assign_permission_scheme.js --mode export
```

Writes `logs/permission_scheme_backup_<timestamp>.json`.

### Apply — preview on one project

```bash
node main/bulk_assign_permission_scheme.js \
  --mode apply --scheme-id 12503 \
  --only-key '^SAMPLE$' --dry-run
```

### Apply — execute on one project

```bash
node main/bulk_assign_permission_scheme.js \
  --mode apply --scheme-id 12503 \
  --only-key '^SAMPLE$' --confirm
```

### Apply — full instance (only after a scoped test passes)

```bash
node main/bulk_assign_permission_scheme.js \
  --mode apply --scheme-id 12503 --confirm
```

### Restore

```bash
node main/bulk_assign_permission_scheme.js \
  --mode restore \
  --file logs/permission_scheme_backup_1745000000000.json \
  --dry-run

node main/bulk_assign_permission_scheme.js \
  --mode restore \
  --file logs/permission_scheme_backup_1745000000000.json \
  --confirm
```

### CLI flag reference

| Flag | Required in | Default | Meaning |
|---|---|---|---|
| `--mode {export\|apply\|restore}` | always | — | Selects operation. |
| `--scheme-id <int>` | `apply` | — | Target permission scheme id. Must be a positive integer. |
| `--file <path>` | `restore` | — | Backup JSON to restore from. Relative paths are resolved from CWD. |
| `--dry-run` | — | off | No PUT calls; logs `WOULD …`. |
| `--confirm` | `apply`, `restore` mutations | off | Required in addition to `--dry-run` being absent. |
| `--only-key <regex>` | — | off | JS regex; only projects whose `key` matches are processed. |
| `--include-archived` | — | off | Include archived projects (pass `action=` nothing to `/project/search`). |
| `--help` / `-h` | — | — | Print usage. |

---

## 7. Data shape

### Backup JSON (written by `export` and `apply`)

```json
{
  "exportedAt": "2026-04-24T10:30:00.000Z",
  "jiraBaseUrl": "https://your-site.atlassian.net",
  "projectPermissionSchemes": [
    {
      "projectId": 12345,
      "projectKey": "SAMPLE",
      "projectName": "Test Project",
      "permissionSchemeId": 12503,
      "permissionSchemeName": "Acme Standard"
    }
    // If the read failed, the entry is still written with:
    //   permissionSchemeId: null,
    //   permissionSchemeName: null,
    //   error: "<message>"
  ]
}
```

### Log file (per run)

`logs/bulk_assign_<timestamp>.log` — identical lines to stdout, prefixed with ISO timestamp. Always written. The `logs/` dir is auto-created.

---

## 8. Edge cases & known issues

- **Team-managed (next-gen) projects** may reject the PUT with 400/403 ("This action cannot be performed on a team-managed project"). They're logged `FAILED` and the run continues.
- **JSM (Service Management) projects** accept the PUT for most schemes, but if the target scheme lacks required grants for JSM actors the change may break agent workflows. Preview with `--dry-run` and review which JSM projects will move.
- **Archived projects** are excluded by default (via `action=view` on `/project/search`). Pass `--include-archived` to include them.
- **Rate limits**: Cloud enforces per-tenant request caps. The client auto-retries 429s up to 3× with exponential backoff, but for instances with many hundreds of projects expect a few rate-limit waits in the log.
- **Scheme id mismatch DC ↔ Cloud**: ids generally do NOT match between DC and Cloud. If restoring a DC export onto Cloud, rely on the name fallback (include `permissionSchemeName` in the JSON).
- **Auth token format**: `CLOUD_API_TOKEN` must already be base64-encoded (`email:token` → base64). The client does not encode it for you.

---

## 9. For a future AI picking this up

### 9.1 Quick mental model

- One HTTP client class, one CLI entry point, three modes. No framework, no build step.
- Every mutating mode has two gates (`--dry-run` off **and** `--confirm` present).
- Backup-before-mutate is non-negotiable; do not add a mode that skips it.

### 9.2 Where to extend

| If the user wants … | Edit here |
|---|---|
| A new Jira endpoint | Add a method on `CloudJiraClient` in `src/cloudJiraClient.js`. Follow the existing `// VERB /path` comment + thin wrapper pattern. |
| A new CLI flag | `main/bulk_assign_permission_scheme.js`, top of file (the `getArgValue` / `args.includes` block). Add to the help text and to the CLI table in section 6 of this README. |
| A new mode | Add `runXxx(client)` alongside `runExport` / `runApply` / `runRestore`; dispatch from `main()`. Keep the same logging pattern (`log("Step N: …")`) and call `printReport(...)` at the end. |
| A shared report metric | Extend the `stats` object shape consistently across modes and update `printReport` in the main file. |

### 9.3 Things to double-check before changing behavior

1. **Never switch the PUT body** from `{id: Number(...)}` to a string — Cloud responds 400 for string ids.
2. **The `/project/search` pagination** uses `isLast` (boolean), not a `hasMore` flag; if you change the loop termination, re-read the endpoint docs.
3. **`Illegal Entity Scope` / `entity scope`** in a 5xx body means non-retriable — the retry branch explicitly short-circuits. Preserve that if you refactor `makeRequest`.
4. **The backup JSON shape** is load-bearing: the Groovy DC export/restore scripts use the exact same keys (`exportedAt`, `jiraBaseUrl`, `projectPermissionSchemes[].{projectId,projectKey,projectName,permissionSchemeId,permissionSchemeName}`). Don't rename keys or add required ones — old backup files must keep loading.
5. **The order of operations in `runApply`** is: validate target → list projects → filter → read current schemes → **write backup** → iterate PUTs. Do not move the backup after the iteration; a failed run must still leave an artifact.

### 9.4 Verification checklist (before declaring a change "done")

1. `node --check main/bulk_assign_permission_scheme.js src/cloudJiraClient.js` — must pass.
2. `node main/bulk_assign_permission_scheme.js --help` — must not require env vars.
3. `node main/bulk_assign_permission_scheme.js --mode export` (with valid `.env`) — writes `logs/permission_scheme_backup_*.json` whose shape matches section 7 exactly.
4. `--mode apply --scheme-id <known-id> --only-key '^<one-test-key>$' --dry-run` — logs `WOULD UPDATE` for exactly one project, writes a backup, performs zero PUTs.
5. `--mode apply --scheme-id <known-id> --only-key '^<one-test-key>$' --confirm` — performs exactly one PUT, logs `UPDATED`.
6. `--mode restore --file <the backup from step 5> --only-key '^<one-test-key>$' --confirm` — reverts the project.

If step 5 or 6 produces 0 or >1 PUTs, the regex logic has regressed.

### 9.5 Related folders (worth reading for context, not copying)

- `jira/jira-data/add-to-permission-schemes/` — the HTTP client origin; also a good example of iteration over schemes and per-permission grant creation.
- `jira/jira-data/add-to-security-levels/` — near-identical architecture for a different domain (security levels).
- `jira/jira-data/sync_security_levels/` — shows a richer plan-manager pattern for checkpoint/resume. Not needed here because this script is idempotent.
