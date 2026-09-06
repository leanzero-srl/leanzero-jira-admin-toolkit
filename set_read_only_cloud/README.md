# Jira Permission Scheme Manager

A robust Node.js script to set and revert permission schemes for Jira Cloud projects.

## Modes

### 🔧 SET Mode
Assigns a specific permission scheme to all (or filtered) projects in Jira Cloud.

### 🔄 REVERT Mode
Reverts permission schemes to their previous state using a saved JSON file.

### 🔒 LOCKDOWN Mode
Creates a brand-new read-only permission scheme on Cloud and assigns it to projects in one shot. Output JSON is revert-compatible.

### 🔁 REVERT-FROM-DC-BACKUP Mode
After a Cloud migration, reads a DC backup JSON and re-applies each project's original scheme on Cloud by matching the **scheme name** (since IDs change across instances).

### 🛠️ BACKFILL-MISSING-SCHEMES Mode
After `revert-from-dc-backup` reports `unmappedScheme` entries, this mode reaches into the source DC over the REST API, fetches the **exact** definition of every missing scheme (with all grants), translates the holders for Cloud (group IDs, accountIds, role IDs, custom-field IDs), and `POST`s the schemes onto Cloud. Dry-run by default — pass `--execute` to commit. Once it finishes, re-run `revert-from-dc-backup` to apply the now-existing schemes to projects.

## Features

- ✅ **Two Operation Modes**: Set new schemes or revert to previous ones
- ✅ **Pagination Support**: Handles large numbers of projects efficiently
- ✅ **Before/After Tracking**: Records current and new permission schemes for each project
- ✅ **Dry Run Mode**: Preview changes without modifying anything
- ✅ **Flexible Filtering**: Process all projects, specific projects, or pattern-matched projects
- ✅ **Exclude Patterns**: Exclude specific projects from processing
- ✅ **Rate Limiting**: Built-in exponential backoff for API rate limits
- ✅ **Error Handling**: Comprehensive error tracking and reporting
- ✅ **JSON Export/Import**: Save detailed results and use them for reverting
- ✅ **Progress Tracking**: Real-time console output with emoji indicators

## Prerequisites

- Node.js (v14 or higher)
- Jira Cloud instance
- Jira API token ([Generate here](https://id.atlassian.com/manage-profile/security/api-tokens))
- **Administer Jira** global permission (required to modify permission schemes)

## Installation

```bash
cd set-read-only-cloud
npm install
```

## Finding Your Permission Scheme ID

There are two ways to find permission scheme IDs:

### Method 1: Via Jira UI
1. Go to **Jira Settings** > **Issues** > **Permission Schemes**
2. Click on the permission scheme you want to use
3. Look at the URL in your browser
4. The ID is the number at the end: `/secure/admin/EditPermissions!default.jspa?schemeId=10000`
5. In this example, the scheme ID is `10000`

### Method 2: Via API
```bash
curl -u email@example.com:your-api-token \
  -X GET \
  -H "Content-Type: application/json" \
  https://your-instance.atlassian.net/rest/api/3/permissionscheme
```

## Usage

### 📋 Quick Start

```bash
# Show help
node set_permission_scheme.js --help

# Show help for SET mode
node set_permission_scheme.js set --help

# Show help for REVERT mode
node set_permission_scheme.js revert --help
```

---

## SET Mode Usage

### Basic Usage

Set permission scheme for all projects:

```bash
node set_permission_scheme.js set \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --scheme-id 10000
```

### Dry Run (Recommended First Step)

Preview what would change without making modifications:

```bash
node set_permission_scheme.js set \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --scheme-id 10000 \
  --dry-run
```

### Filter by Single Project

Process only a specific project:

```bash
node set_permission_scheme.js set \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --scheme-id 10000 \
  --project-key DEMO
```

### Filter by Project Pattern

Process projects matching a regex pattern:

```bash
# All projects starting with "TEST"
node set_permission_scheme.js set \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --scheme-id 10000 \
  --project-pattern "^TEST"
```

### Exclude Projects

Exclude projects matching a pattern:

```bash
# Process all except DEMO projects
node set_permission_scheme.js set \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --scheme-id 10000 \
  --exclude-pattern "^DEMO"
```

### Custom Output File

Save results to a custom JSON file:

```bash
node set_permission_scheme.js set \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --scheme-id 10000 \
  --output-file my_changes_2024.json
```

### SET Mode Options

| Option | Required | Description |
|--------|----------|-------------|
| `--url` | Yes | Jira instance URL (e.g., `https://your-instance.atlassian.net`) |
| `--email` | Yes | Email address for authentication |
| `--token` | Yes | API token for authentication |
| `--scheme-id` | Yes | Permission Scheme ID to assign to projects |
| `--project-key` | No | Process only a specific project by key |
| `--project-pattern` | No | Process only projects matching regex pattern |
| `--exclude-pattern` | No | Exclude projects matching regex pattern |
| `--dry-run` | No | Show what would be done without making changes |
| `--output-file` | No | Save results to JSON file (default: `permission_scheme_changes.json`) |

---

## REVERT Mode Usage

### Basic Usage

Revert all changes from a previous SET operation:

```bash
node set_permission_scheme.js revert \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --input-file permission_scheme_changes.json
```

### Dry Run for Revert

Preview what would be reverted without making modifications:

```bash
node set_permission_scheme.js revert \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --input-file permission_scheme_changes.json \
  --dry-run
```

### Custom Output File for Revert

Save revert results to a custom JSON file:

```bash
node set_permission_scheme.js revert \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --input-file permission_scheme_changes.json \
  --output-file revert_results_2024.json
```

### REVERT Mode Options

| Option | Required | Description |
|--------|----------|-------------|
| `--url` | Yes | Jira instance URL (e.g., `https://your-instance.atlassian.net`) |
| `--email` | Yes | Email address for authentication |
| `--token` | Yes | API token for authentication |
| `--input-file` | Yes | JSON file with previous changes to revert |
| `--dry-run` | No | Show what would be done without making changes |
| `--output-file` | No | Save revert results to JSON file (default: `permission_scheme_revert.json`) |

---

## BACKFILL-MISSING-SCHEMES Mode Usage

### When to use it

After running `revert-from-dc-backup`, your run summary may include a non-zero `unmappedScheme` count and a list of names like *"Legacy Games Permissions"*, *"Permissions scheme for SUPPORT"*, etc. — DC scheme names that have no Cloud equivalent. Without those schemes on Cloud, you can't restore the original project assignments.

This mode fixes that gap deterministically: it fetches each missing DC scheme **with all its grants** via `GET /rest/api/2/permissionscheme/{id}?expand=permissions,user,group,projectRole,field,all`, translates every holder for Cloud, and creates the scheme via `POST /rest/api/3/permissionscheme`.

### Basic usage (dry-run)

```bash
node set_permission_scheme.js backfill-missing-schemes \
  --cloud-url https://your-instance.atlassian.net \
  --dc-url   https://jira.your-company.com \
  --basic-auth <pre-base64-encoded cloud "email:token"> \
  --dc-pat <DC personal access token> \
  --input-file ../set-read-only-dc/dc_lockdown_<timestamp>.json \
  --user-map cloud_user_map.csv
```

This produces an audit JSON describing exactly which schemes would be created and which grants would be dropped (and why). Nothing is sent to Cloud.

### Live execution

After reviewing the dry-run audit, re-run with `--execute`:

```bash
node set_permission_scheme.js backfill-missing-schemes \
  --cloud-url https://your-instance.atlassian.net \
  --dc-url   https://jira.your-company.com \
  --basic-auth <encoded> \
  --dc-pat <pat> \
  --input-file ../set-read-only-dc/dc_lockdown_<timestamp>.json \
  --user-map cloud_user_map.csv \
  --execute
```

After this completes, re-run `revert-from-dc-backup` (separately) — it will now find every scheme by name and finish the job.

### Holder translation

| DC holder type | DC payload | Cloud holder | Translation |
|---|---|---|---|
| `anyone`, `assignee`, `reporter`, `projectLead`, `sd.customer.portal.only` | (no parameter) | (no parameter) | Pass-through |
| `applicationRole` | `parameter: <role-key>` | `parameter: <role-key>` | Pass-through (`jira-software-users`, `jira-servicedesk-users`, ...) |
| `group` | `parameter: <group name>` | `parameter: <group name>` + `value: <Cloud groupId>` | Looks up `groupId` via `GET /rest/api/3/group/bulk?groupName=<name>` (cached). Group missing on Cloud → grant dropped & recorded. |
| `user` | `parameter: <username>` | `parameter: <accountId>` + `value: <accountId>` | **Requires `--user-map` CSV.** Username missing from map → grant dropped & recorded. *No automatic `/user/search` fallback.* |
| `projectRole` | `parameter: <DC role id>` | `parameter: <Cloud role id>` | Maps DC `role.id → role.name → Cloud role.id`. Name not on Cloud → grant dropped & recorded. |
| `groupCustomField`, `userCustomField` | `parameter: <DC custom-field id>` | `parameter: <Cloud custom-field id>` | Maps DC `field.id → field.name → Cloud field.id`. Name not on Cloud → grant dropped & recorded. |

Translated grants are deduplicated before POST. Every dropped grant is recorded in the audit JSON's `results[].droppedGrants` block with a human-readable reason so you can decide whether to add it back manually.

### `--user-map` CSV format

Two-column CSV mapping each DC username to its Cloud `accountId`. The first line may be a header (auto-detected) and is otherwise treated as data. Comments start with `#` and blank lines are skipped.

```
dc_username,cloud_account_id
alice,5b10ac8d82e05b22cc7d4ef5
bob.jones,712020:0123abcd-4567-890e-fghi-jklm12345678
# example.user is a former employee — left out on purpose
```

If a scheme references a username not in the map, the grant is **dropped** and recorded in the audit JSON. The mode never falls back to a user-search lookup.

### Idempotency

If a scheme with the target name already exists on Cloud (e.g. you fixed it manually, or this is a re-run), the mode **skips** it. Cloud also rejects duplicate names with `HTTP 409` — that's caught and recorded as `status: "already_exists"`.

### Authentication

**Cloud** (one of):
- `--basic-auth <base64>` (or env `JIRA_CLOUD_BASIC_AUTH`) — pre-encoded `email:token`
- `--email <email> --token <token>`

**Datacenter** (one of, in precedence order):
- `--dc-pat <PAT>` (or env `JIRA_DC_PAT`)
- `--dc-basic-auth <base64>` (or env `JIRA_DC_BASIC_AUTH`)
- `--dc-user <user> --dc-password <password>` (or env `JIRA_DC_USER` / `JIRA_DC_PASSWORD`)

### BACKFILL-MISSING-SCHEMES Options

| Option | Required | Description |
|---|---|---|
| `--cloud-url` | Yes | Jira Cloud URL (e.g., `https://your-instance.atlassian.net`) |
| `--dc-url` | Yes | Jira DC URL (e.g., `https://jira.your-company.com`) |
| `--input-file` | Yes | DC backup JSON (the file produced by `set_permission_scheme_dc.js set` and consumed by `revert-from-dc-backup`) |
| `--basic-auth` / `--email`+`--token` | One required | Cloud auth |
| `--dc-pat` / `--dc-basic-auth` / `--dc-user`+`--dc-password` | One required | DC auth |
| `--user-map` | Conditional | Required iff any DC scheme has `user` holders. CSV format above. |
| `--name-prefix` | No | Optional prefix for created scheme names (e.g., `"MIG: "`). Default: empty. |
| `--only` | No | Process a single scheme by name (case-insensitive). Useful for debugging. |
| `--execute` | No | Commit the changes. Without it the run is dry-run. |
| `--output-file` | No | Audit JSON path. Default: `backfill_<timestamp>.json`. |

### Audit JSON shape

```json
{
  "metadata": { "timestamp": "...", "mode": "backfill-missing-schemes",
                "cloudInstance": "...", "dcInstance": "...",
                "inputFile": "...", "execute": true,
                "onlyFilter": null, "namePrefix": null,
                "userMapFile": "...", "userMapEntries": 1234 },
  "summary":  { "candidatesInBackup": 144, "missingOnCloud": 18,
                "created": 17, "planned": 0,
                "alreadyExists": 0, "failed": 1 },
  "results":  [
    {
      "sourceName": "Legacy Games Permissions",
      "sourceDcId": 10623,
      "affectedProjects": ["P20", "P07"],
      "status": "created",
      "cloudSchemeId": 11456,
      "cloudSchemeName": "Legacy Games Permissions",
      "permissionsCreated": 27,
      "droppedGrants": [
        { "reason": "user \"former.employee\" not in --user-map",
          "original": { "holder": { "type": "user", "parameter": "former.employee" }, "permission": "BROWSE_PROJECTS" } }
      ]
    }
  ]
}
```

`status` values: `created`, `planned` (dry-run), `already_exists`, `fetch_failed`, `post_failed`.

---

## Output

### Console Output (SET Mode)

```
🚀 SET PERMISSION SCHEME FOR PROJECTS
=====================================
🔐 Target Permission Scheme ID: 10000
🌐 Jira Instance: your-instance.atlassian.net

📂 Fetching all projects...
   📊 Fetched 50 projects so far...
   📊 Fetched 100 projects so far...
✅ Total projects found: 150

🔧 Processing projects...

📦 Project: DEMO (Demo Project)
   📋 Current: Default Permission Scheme (ID: 10001)
   ✅ Changed to: Read Only Scheme (ID: 10000)

📊 SUMMARY
=====================================
Total Projects: 150
Processed Projects: 150
Already at Target: 20
Successfully Updated: 125
Failures: 5

📋 PERMISSION SCHEME CHANGES:
=====================================

DEMO (Demo Project)
  Before: Default Permission Scheme (ID: 10001)
  After:  Read Only Scheme (ID: 10000)
```

### Console Output (REVERT Mode)

```
🔄 REVERT PERMISSION SCHEMES FROM JSON
=====================================
📁 Input File: permission_scheme_changes.json
🌐 Jira Instance: your-instance.atlassian.net

📖 Reading input file...
✅ Found 125 projects to revert (out of 150 total changes)

📋 Original Operation Info:
   Timestamp: 2024-11-14T18:30:00.000Z
   Mode: set
   Target Scheme ID: 10000

🔧 Reverting projects...

📦 Project: DEMO (Demo Project)
   📋 Current: Read Only Scheme (ID: 10000)
   ↩️  Reverting to: Default Permission Scheme (ID: 10001)
   ✅ Reverted to: Default Permission Scheme (ID: 10001)

📊 SUMMARY
=====================================
Total Projects: 125
Processed Projects: 125
Already at Target: 10
Successfully Reverted: 115
Failures: 0

📋 PERMISSION SCHEME REVERTS:
=====================================

DEMO (Demo Project)
  Before: Read Only Scheme (ID: 10000)
  After:  Default Permission Scheme (ID: 10001)
```

### JSON Output (SET Mode)

The SET mode saves detailed results to a JSON file (default: `permission_scheme_changes.json`):

```json
{
  "metadata": {
    "timestamp": "2024-11-14T18:30:00.000Z",
    "mode": "set",
    "jiraInstance": "your-instance.atlassian.net",
    "targetSchemeId": 10000,
    "dryRun": false,
    "projectFilter": "all",
    "excludePattern": null
  },
  "summary": {
    "totalProjects": 150,
    "processedProjects": 150,
    "unchanged": 20,
    "successful": 125,
    "failures": 5,
    "skipped": 0,
    "errors": []
  },
  "changes": [
    {
      "project": "DEMO",
      "projectName": "Demo Project",
      "before": {
        "id": 10001,
        "name": "Default Permission Scheme",
        "description": "Default scheme",
        "self": "https://..."
      },
      "after": {
        "id": 10000,
        "name": "Read Only Scheme",
        "description": "Read only access",
        "self": "https://..."
      },
      "status": "success",
      "message": "Permission scheme updated successfully"
    }
  ]
}
```

### JSON Output (REVERT Mode)

The REVERT mode saves revert results to a JSON file (default: `permission_scheme_revert.json`):

```json
{
  "metadata": {
    "timestamp": "2024-11-14T19:00:00.000Z",
    "mode": "revert",
    "jiraInstance": "your-instance.atlassian.net",
    "inputFile": "permission_scheme_changes.json",
    "dryRun": false,
    "originalOperation": {
      "timestamp": "2024-11-14T18:30:00.000Z",
      "mode": "set",
      "targetSchemeId": 10000
    }
  },
  "summary": {
    "totalProjects": 125,
    "processedProjects": 125,
    "unchanged": 10,
    "successful": 115,
    "failures": 0,
    "skipped": 0,
    "errors": []
  },
  "changes": [
    {
      "project": "DEMO",
      "projectName": "Demo Project",
      "before": {
        "id": 10000,
        "name": "Read Only Scheme"
      },
      "after": {
        "id": 10001,
        "name": "Default Permission Scheme"
      },
      "status": "success",
      "message": "Permission scheme reverted successfully"
    }
  ]
}
```

---

## Common Workflows

### Workflow 1: Safe Permission Scheme Update

```bash
# Step 1: Dry run to see what would change
node set_permission_scheme.js set \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --scheme-id 10000 \
  --dry-run

# Step 2: If everything looks good, run for real
node set_permission_scheme.js set \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --scheme-id 10000 \
  --output-file changes_backup.json

# Step 3: If something goes wrong, revert
node set_permission_scheme.js revert \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --input-file changes_backup.json
```

### Workflow 2: Test on Specific Projects First

```bash
# Step 1: Test on a single project
node set_permission_scheme.js set \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --scheme-id 10000 \
  --project-key TEST \
  --output-file test_change.json

# Step 2: Verify it worked, then apply to all TEST projects
node set_permission_scheme.js set \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --scheme-id 10000 \
  --project-pattern "^TEST" \
  --output-file test_changes.json

# Step 3: If successful, apply to all projects
node set_permission_scheme.js set \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --scheme-id 10000 \
  --output-file all_changes.json
```

### Workflow 3: Migrating to Read-Only with Rollback

```bash
# Step 1: Set all projects to read-only
node set_permission_scheme.js set \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --scheme-id 10000 \
  --output-file readonly_migration.json

# Step 2: Test and verify
# ... business validation ...

# Step 3: If issues found, rollback immediately
node set_permission_scheme.js revert \
  --url https://your-instance.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --input-file readonly_migration.json \
  --output-file readonly_rollback.json
```

---

## Error Handling

The script includes comprehensive error handling:

- **Rate Limiting**: Automatic exponential backoff (up to 5 retries)
- **404 Errors**: Gracefully handles projects without permission schemes
- **Permission Errors**: Reports projects where you don't have admin access
- **Network Errors**: Retries with backoff on transient failures

All errors are:
1. Displayed in the console with clear descriptions
2. Included in the summary statistics
3. Saved to the JSON output file for review

## Permissions Required

To run this script, you need:

- **Administer Jira** global permission, OR
- **Administer Projects** permission for each project you want to modify

The script will skip projects where you don't have sufficient permissions and report them as errors.

## How REVERT Works

The REVERT mode:
1. Reads the JSON file from a previous SET operation
2. Filters to only include projects that were successfully changed
3. For each project, reverts to the "before" permission scheme
4. Skips projects that are already at the target scheme
5. Saves a new JSON file with the revert results

**Important Notes:**
- Only projects with `status: "success"` are reverted
- Projects with `status: "unchanged"` or `status: "dry_run"` are skipped
- The revert operation also supports `--dry-run` mode
- You can chain multiple revert operations if needed

## Troubleshooting

### "Invalid permission scheme ID format"
- Ensure you're using a numeric ID (e.g., `10000`)
- Don't use the scheme name, only the ID

### "HTTP 403" errors
- Verify you have **Administer Jira** global permission
- Or ensure you have **Administer Projects** permission for the target projects

### "HTTP 429" rate limiting
- The script automatically handles rate limiting with exponential backoff
- If you see this frequently, consider processing projects in smaller batches

### Projects not found
- Verify the project key is correct (case-sensitive)
- Check that the projects haven't been archived or deleted
- Ensure you have at least **Browse Projects** permission

### "Invalid input file format" during REVERT
- Ensure you're using a JSON file generated by the SET mode
- Verify the JSON file contains a `changes` array
- Check that the file is not corrupted

## API Documentation

This script uses the following REST API endpoints:

**Jira Cloud (v3):**
- [GET /rest/api/3/project/search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/#api-rest-api-3-project-search-get)
- [GET /rest/api/3/project/{projectKeyOrId}/permissionscheme](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-project-permission-schemes/#api-rest-api-3-project-projectkeyorid-permissionscheme-get)
- [PUT /rest/api/3/project/{projectKeyOrId}/permissionscheme](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-project-permission-schemes/#api-rest-api-3-project-projectkeyorid-permissionscheme-put)
- [GET /rest/api/3/permissionscheme](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-permission-schemes/#api-rest-api-3-permissionscheme-get)
- [POST /rest/api/3/permissionscheme](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-permission-schemes/#api-rest-api-3-permissionscheme-post) — used by `lockdown` and `backfill-missing-schemes`
- [GET /rest/api/3/group/bulk](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-groups/#api-rest-api-3-group-bulk-get) — used by `backfill-missing-schemes` to look up groupIds
- [GET /rest/api/3/role](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-project-roles/#api-rest-api-3-role-get) — used by `backfill-missing-schemes` for role mapping
- [GET /rest/api/3/field](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-fields/#api-rest-api-3-field-get) — used by `backfill-missing-schemes` for custom-field mapping

**Jira Datacenter (v2):**
- [GET /rest/api/2/permissionscheme/{id}?expand=permissions,user,group,projectRole,field,all](https://developer.atlassian.com/server/jira/platform/rest/v11003/api-group-permissionscheme) — used by `backfill-missing-schemes` to fetch the exact source definition
- `GET /rest/api/2/role`, `GET /rest/api/2/field` — for cross-platform role/field mapping

## Security Notes

- Never commit your API token to version control
- Use environment variables for sensitive credentials
- API tokens should be rotated regularly
- The script uses Basic Authentication over HTTPS
- Keep your JSON backup files secure as they contain project information

## License

ISC

## Support

For issues or questions:
1. Check the [Jira Cloud REST API documentation](https://developer.atlassian.com/cloud/jira/platform/rest/v3/)
2. Review the error messages in the console output
3. Check the JSON output file for detailed error information
