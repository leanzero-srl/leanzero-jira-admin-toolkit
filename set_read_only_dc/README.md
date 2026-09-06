# set_read_only_dc

Freeze a **Jira Data Center** instance by putting every project on one read-only permission scheme —
and put them all back afterwards.

## Why it exists

The single most damaging thing that can happen during a DC-to-Cloud cutover is a user editing an
issue on DC after the export snapshot was taken. That edit is invisible: the Cloud copy is simply
stale, and nobody finds out until someone notices a missing comment months later.

The fix is to freeze DC for the cutover window. This script does that in one pass and, critically,
**records the before state of every project** so the freeze can be lifted exactly.

Its Cloud counterpart is [`set_read_only_cloud`](../set_read_only_cloud), which can also read the
backup file this script produces and restore the original schemes on the *Cloud* side after
migration — matching by scheme **name**, because the ids change across instances.

## Modes

| Mode | What it does |
|---|---|
| `set` | Assign one permission scheme id to every (or filtered) project, saving each project's current scheme to a JSON backup first. |
| `revert` | Read that backup and put every project back on its original scheme. |

## Endpoints used

```
GET  /rest/api/2/project?expand=permissions        list projects
GET  /rest/api/2/project/{key}/permissionscheme    read the assigned scheme
PUT  /rest/api/2/project/{key}/permissionscheme    assign a scheme  (body: {id})
```

## Auth

Pick one style; each can come from a flag or the environment.

| Flag | Env | Auth |
|---|---|---|
| `--pat <token>` | `JIRA_DC_PAT` | Bearer, Personal Access Token (preferred on modern DC) |
| `--basic-auth <base64>` | `JIRA_DC_BASIC_AUTH` | Basic, pre-encoded `user:password` |
| `--user` / `--password` | `JIRA_DC_USER` / `JIRA_DC_PASSWORD` | Basic, plain credentials |

## Run

```bash
npm install

# 1. Create the read-only scheme in the DC admin UI first and note its numeric id.

# 2. Preview. Nothing is written; the backup is still produced so you can read it.
node set_permission_scheme_dc.js set --scheme-id 10500 --dry-run

# 3. Freeze. KEEP the backup path it prints.
node set_permission_scheme_dc.js set --scheme-id 10500
#    -> dc_lockdown_<timestamp>.json

# 4. Thaw, whenever you need DC writable again.
node set_permission_scheme_dc.js revert --backup dc_lockdown_<timestamp>.json
```

## The backup file

Deliberately portable: for every project it stores the previous scheme **id and name**. The id is what
`revert` uses on DC. The name is what `set_read_only_cloud --mode revert-from-dc-backup` uses on
Cloud, where the ids no longer mean anything. Do not hand-edit it.
