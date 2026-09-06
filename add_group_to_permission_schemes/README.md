# add_group_to_permission_schemes

Adds one group as a grant holder on **every permission type, in every permission scheme**, on a Jira
Cloud site.

## Why it exists

After a migration the operating account (or the org-admins group) frequently cannot see or touch
projects, because Cloud permission schemes only grant to the holders DC granted to. Fixing that by
hand means opening every scheme and every permission row in the admin UI. On a site with 40 schemes
and 30 permission types each that is well over a thousand clicks, and Cloud has **no bulk endpoint**.

This script iterates instead. For every scheme it reads the existing grants, collects the distinct
set of permission types that already have at least one grant, and ensures the target group is present
in each of them. Permission types with **no** grants at all are left alone — the script widens what
already exists, it does not invent policy.

## Setup

```bash
cd add_group_to_permission_schemes
npm install
cp .env.example .env      # CLOUD_BASE_URL, CLOUD_API_TOKEN = base64("email:api_token")
```

## Run

```bash
# 1. Always preview. Prints scheme by scheme what would be added.
node main/add_to_permission_schemes.js --dry-run

# 2. Try one scheme first and confirm it in the admin UI.
node main/add_to_permission_schemes.js --scheme "Default software scheme"

# 3. Whole site.
node main/add_to_permission_schemes.js --group org-admins
```

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--dry-run` | off | Report only, send no writes. |
| `--group <name>` | `org-admins` | The group to add. |
| `--scheme <name>` | all | Only schemes whose name contains this string (case-insensitive). |
| `--help` | — | Usage. |

Every run appends to `logs/permissions_<epoch>.log`.

## Undo

Grants are added individually, and the log records each one. To revert, remove the group from the
schemes listed in the log — or, if you took a snapshot first with
[`bulk_assign_permission_scheme`](../bulk_assign_permission_scheme) `export`, restore from that.
Take the snapshot **before** you run this.
