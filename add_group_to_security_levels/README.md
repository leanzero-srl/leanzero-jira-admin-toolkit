# add_group_to_security_levels

Adds one group as a member of **every issue security level, in every issue security scheme**, on a
Jira Cloud site.

## Why it exists

Issue security is the quietest way to lose data visibility after a migration. Issues carry a security
level; if the migrating admin is not a member of that level, the issues simply do not appear — not in
JQL, not in the project, not in an export. Every audit built on "how many issues are there" then
reports a number that is confidently wrong.

Adding org-admins (or a dedicated migration group) to every level makes the whole corpus visible
again so audits and syncs can see what they are supposed to see. Like its sibling
[`add_group_to_permission_schemes`](../add_group_to_permission_schemes), Cloud offers no bulk
endpoint, so the script iterates scheme by scheme and level by level.

> **This widens visibility.** On a production site, security levels usually exist for a reason.
> Ask before running it, scope it with `--scheme`, and remove the group again when the migration
> work is finished.

## Setup

```bash
cd add_group_to_security_levels
npm install
cp .env.example .env      # CLOUD_BASE_URL, CLOUD_API_TOKEN = base64("email:api_token")
```

## Run

```bash
node main/add_to_security_levels.js --dry-run
node main/add_to_security_levels.js --scheme "IT Security Scheme"
node main/add_to_security_levels.js --group org-admins
```

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--dry-run` | off | Report only, send no writes. |
| `--group <name>` | `org-admins` | The group to add. |
| `--scheme <name>` | all | Process only one security scheme (case-insensitive name match). |
| `--help` | — | Usage. |

Every run appends to `logs/security_<epoch>.log`.

## Undo

Remove the group from the levels named in the run log. There is no automatic revert — the log is the
record.
