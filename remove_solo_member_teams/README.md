# remove_solo_member_teams

Find every **Atlassian Team** in an org whose *single sole member* is a given person
(default **Jane Doe**) and delete those teams. Targets the **Teams Public REST API v1**
(`https://api.atlassian.com/public/teams/v1/org/{orgId}/...`).

Two phases, like the rest of our Jira scripts:

- **PLAN** (default / `--plan-only`) — read-only. Lists every team, finds the ones whose
  only member is the target, and writes a reviewable CSV + a plan JSON. Nothing is changed.
- **APPLY** (`--apply`) — deletes the flagged teams. Every team is **re-checked at delete
  time**: if it has since gained members or its sole member changed, it is skipped, so a
  stale plan can never delete the wrong thing.

## How a team is matched

A team is flagged when it has **exactly one member** and that member is the target.

By default the target is matched by **exact display name** (`TARGET_NAME`, case-insensitive).
This intentionally captures **both** "Jane Doe" accounts when a person holds two
(e.g. `jane.doe@example.com` and a second identity) — while never matching "Jane Doerr" or other
near-names. Set `TARGET_ACCOUNT_IDS` to switch to precise accountId-only matching instead.

The Teams members API returns only accountIds, so the script resolves each sole member's
display name/email via the Jira site (`SITE_BASE_URL`) purely to make the CSV human-readable.

## Auth

Basic auth with a **user API token** (`base64("<email>:<token>")`). Per Atlassian, Forge/OAuth2
apps cannot call this resource, so a normal API token is the supported credential. The user must
be able to manage teams in the org (org admin / team admin).

## Setup

```bash
npm install            # installs dotenv
# .env is already filled for staff; edit if needed
```

`.env`:

```
ATLASSIAN_EMAIL=you@example.com
ATLASSIAN_API_TOKEN=<user API token>
ORG_ID=00000000-0000-0000-0000-0000000org1     # staff org
SITE_BASE_URL=https://your-site.atlassian.net
TARGET_NAME=Jane Doe
# TARGET_ACCOUNT_IDS=638a0b39...,712020:b5a8e849-...
```

## Usage

```bash
# 1. PLAN — read-only. Review logs/teams_scan_<ts>.csv afterwards.
npm run plan

# 2. Dry-run the deletions (re-verifies each team, deletes nothing)
npm run dry-run

# 3. APPLY — delete the flagged teams
npm run apply

# 4. Resume an interrupted apply from the latest plan
npm run resume
```

### Flags

| Flag | Purpose |
|---|---|
| `--plan-only` | Discovery + CSV/plan, no writes (default when no flag). |
| `--apply` | Delete the flagged teams. |
| `--dry-run` | With `--apply`: log deletions, call nothing. |
| `--resume` / `--execute-only` | Skip discovery, delete pending matches from the latest plan. |
| `--plan-file <path>` | Plan JSON to resume from (default: latest in `logs/`). |
| `--target-name <str>` | Override `TARGET_NAME`. |
| `--target-account-ids <csv>` | Match these accountIds exactly (disables name match). |
| `--limit <n>` | Only scan the first N teams (testing). |
| `--concurrency <n>` | Parallel member lookups during discovery (default 6). |
| `--site-url <url>` / `--org-id <uuid>` | Override env. |

## Outputs (all in `logs/`)

- `run_<ts>.log` — full timestamped trace.
- `teams_scan_<ts>.csv` — **every** team scanned, with `match`, `plannedAction`, `reason`,
  and the resolved sole-member name/email. **Review this before `--apply`.**
- `plan_<ts>.json` — per-team plan keyed by `teamId`, statuses `pending|deleted|skipped|failed`,
  plus the resolved target accountIds. Resumable.

## Safety notes

1. **PLAN is the default** — you never delete without an explicit `--apply`.
2. Each delete is **re-verified** immediately before it runs (still exactly one member, still the
   target). Changed teams are skipped, not deleted.
3. `404` on delete is treated as success (idempotent re-runs).
4. Deletion is **permanent** — review the CSV first. Recreating a team and its membership is manual.
5. The `externalSource` column flags group-backed teams (`ATLASSIAN_GROUP`) so you can spot them.
