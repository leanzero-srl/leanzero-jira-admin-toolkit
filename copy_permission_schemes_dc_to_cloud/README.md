# copy-permission-schemes-dc-to-cloud

Recreates **Jira Data Center permission schemes on Jira Cloud as literal copies**,
translating every grant's holder to the target instance. It does **not** assign any
scheme to a project — creation only.

## Why it exists

JCMA only migrates permission schemes that are **assigned to a project**. Inactive
(unassigned) schemes are silently left behind. This rebuilds the missing ones on
Cloud so they're available to attach later.

## Run

```bash
# .env already points DC=jira-dc.example.com -> Cloud=your-site.atlassian.net
node copy_permission_schemes.js              # DRY-RUN: resolve + report, no writes
node copy_permission_schemes.js --apply      # actually create the schemes
```

Options:
- `--apply` actually create schemes + grants (default is dry-run).
- `--only <substr>` only schemes whose name contains `<substr>` (case-insensitive).
- `--include-existing` also process schemes already on Cloud by name (will collide
  on Cloud's unique-name constraint — for inspection only).
- `--limit <n>` process at most `n` schemes (after filtering).

## What gets translated

| DC holder | → Cloud | matched by |
|---|---|---|
| `group` | `group` (groupId) | **name** (`/group/bulk`) |
| `user` | `user` (accountId) | DC holder **email** → `/user/search` |
| `projectRole` | `projectRole` (role id) | role **name** |
| `groupCustomField` / `userCustomField` | same (fieldId) | field **name** |
| `assignee` / `reporter` / `projectLead` / `anyone` / `applicationRole` / `sd.customer.portal.only` | passed through | type |

## Discriminator (which schemes get created)

A DC scheme is treated as **already migrated** if a Cloud scheme with the same name
(case-insensitive) exists — those are skipped by default, so only the genuinely
missing (inactive) ones are created.

## Safety / lessons baked in

- **Never guesses an ambiguous user.** A grant only resolves on an unambiguous
  exact-email match, preferring active Atlassian accounts (avoids the "two accounts,
  one dead" trap). Anything unresolved/ambiguous is **flagged and the grant is
  skipped** — the scheme is still created with the grants that did resolve.
- **Per-grant creation** (create empty scheme → add each grant) so one bad holder
  (e.g. an app-specific permission key that doesn't exist on Cloud) can't sink a
  whole scheme. Failures are reported per grant.
- Default mode is **dry-run**; `--apply` is required to write.
- Optional sibling override files (both optional):
  - `user_overrides.json`  — `{ "<dc-username-or-email>": "<cloud-accountId>" }`
  - `group_overrides.json` — `{ "<dc-group-name>": "<cloud-group-name-or-groupId>" }`

## Output

- `logs/copy_permission_schemes_<stamp>.log` — full run log.
- `logs/report_<stamp>.json` — machine-readable: per-scheme grant results,
  created Cloud scheme ids, and the list of unresolved holders.

## Env (`.env`)

```
DC_BASE_URL, DC_USERNAME, DC_PASSWORD     # Data Center (Basic auth)
CLOUD_BASE_URL                            # https://site.atlassian.net
CLOUD_API_TOKEN                           # base64("email:api_token")
```
