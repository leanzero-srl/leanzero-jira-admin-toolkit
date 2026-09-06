# Usage Examples

This document provides real-world examples of using the Permission Scheme Manager script.

## Table of Contents

1. [Basic Examples](#basic-examples)
2. [Common Workflows](#common-workflows)
3. [Advanced Scenarios](#advanced-scenarios)
4. [Troubleshooting Examples](#troubleshooting-examples)

---

## Basic Examples

### Example 1: Simple SET Operation

Apply permission scheme ID 10000 to all projects:

```bash
./set_permission_scheme.js set \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --scheme-id 10000
```

**Output:**
```
🚀 SET PERMISSION SCHEME FOR PROJECTS
=====================================
🔐 Target Permission Scheme ID: 10000
🌐 Jira Instance: mycompany.atlassian.net

📂 Fetching all projects...
✅ Total projects found: 25

🔧 Processing projects...

📦 Project: DEMO (Demo Project)
   📋 Current: Default Permission Scheme (ID: 10001)
   ✅ Changed to: Read Only Scheme (ID: 10000)

📊 SUMMARY
=====================================
Total Projects: 25
Successfully Updated: 23
Already at Target: 2

💾 Results saved to: permission_scheme_changes.json
```

---

### Example 2: Dry Run Before Making Changes

Always recommended to test first:

```bash
./set_permission_scheme.js set \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --scheme-id 10000 \
  --dry-run
```

**Output:**
```
🚀 SET PERMISSION SCHEME FOR PROJECTS
=====================================
🔐 Target Permission Scheme ID: 10000
🌐 Jira Instance: mycompany.atlassian.net
🔍 DRY RUN MODE - No changes will be made

📦 Project: DEMO (Demo Project)
   📋 Current: Default Permission Scheme (ID: 10001)
   🔍 Would change to: Permission Scheme ID 10000

📊 SUMMARY
=====================================
Would Update (Dry Run): 23
```

---

### Example 3: Revert Changes

Restore previous permission schemes:

```bash
./set_permission_scheme.js revert \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --input-file permission_scheme_changes.json
```

**Output:**
```
🔄 REVERT PERMISSION SCHEMES FROM JSON
=====================================
📁 Input File: permission_scheme_changes.json
🌐 Jira Instance: mycompany.atlassian.net

📖 Reading input file...
✅ Found 23 projects to revert

📦 Project: DEMO (Demo Project)
   📋 Current: Read Only Scheme (ID: 10000)
   ↩️  Reverting to: Default Permission Scheme (ID: 10001)
   ✅ Reverted to: Default Permission Scheme (ID: 10001)

📊 SUMMARY
=====================================
Successfully Reverted: 23
```

---

## Common Workflows

### Workflow 1: Safe Rollout to Production

Step-by-step safe deployment:

```bash
# Step 1: Test on a single project first
./set_permission_scheme.js set \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --scheme-id 10000 \
  --project-key TESTPROJ \
  --output-file test_single.json

# Step 2: Verify manually in Jira UI
# Check that TESTPROJ has the correct permissions

# Step 3: Dry run on all TEST projects
./set_permission_scheme.js set \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --scheme-id 10000 \
  --project-pattern "^TEST" \
  --dry-run

# Step 4: Apply to all TEST projects
./set_permission_scheme.js set \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --scheme-id 10000 \
  --project-pattern "^TEST" \
  --output-file test_projects.json

# Step 5: If successful, apply to production (excluding TEST)
./set_permission_scheme.js set \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --scheme-id 10000 \
  --exclude-pattern "^TEST" \
  --output-file prod_migration.json

# Step 6: If issues arise, rollback production
./set_permission_scheme.js revert \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --input-file prod_migration.json
```

---

### Workflow 2: Maintenance Window Migration

Planned migration with backup:

```bash
# Before maintenance window: Dry run and save plan
./set_permission_scheme.js set \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --scheme-id 10000 \
  --dry-run \
  --output-file migration_plan.json

# Review migration_plan.json
# Communicate to stakeholders

# During maintenance window: Execute
./set_permission_scheme.js set \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --scheme-id 10000 \
  --output-file migration_actual_$(date +%Y%m%d_%H%M%S).json

# Post-maintenance: Keep backup file safe
# If rollback needed:
./set_permission_scheme.js revert \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --input-file migration_actual_20241114_180000.json
```

---

### Workflow 3: Selective Department Migration

Apply to specific departments:

```bash
# Engineering projects (prefix: ENG)
./set_permission_scheme.js set \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --scheme-id 10000 \
  --project-pattern "^ENG" \
  --output-file eng_migration.json

# Department projects (prefix: DEPT)
./set_permission_scheme.js set \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --scheme-id 10000 \
  --project-pattern "^DEPT" \
  --output-file mkt_migration.json

# Team projects (prefix: TEAM)
./set_permission_scheme.js set \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --scheme-id 10000 \
  --project-pattern "^TEAM" \
  --output-file sales_migration.json
```

---

### Workflow 4: Post-Migration Backfill of Missing Schemes (DC → Cloud)

This is the post-migration recovery workflow. After a Cloud migration, `revert-from-dc-backup` reports a non-zero `unmappedScheme` count: those are DC permission schemes (e.g. *"Legacy Games Permissions"*, *"Default software scheme"*) whose names don't exist on the Cloud tenant, so projects that originally used them can't be restored. `backfill-missing-schemes` reaches into the source DC, fetches the **exact** scheme definition (with grants), translates the holders, and creates each missing scheme on Cloud.

**Step 1: Prepare a deterministic user map.**

Cloud identifies users by `accountId`, not by username. Export the username → accountId mapping for any users referenced as direct grant holders on DC schemes. Save as `cloud_user_map.csv`:

```
dc_username,cloud_account_id
alice,5b10ac8d82e05b22cc7d4ef5
bob.jones,712020:0123abcd-4567-890e-fghi-jklm12345678
service-account,5d8e2f1c8a90b50d7a1234ef
```

The mode never auto-searches — usernames missing from this CSV are dropped (and logged in the audit JSON), so you can re-run after expanding the map.

**Step 2: Dry-run to see what would be created.**

```bash
node set_permission_scheme.js backfill-missing-schemes \
  --cloud-url https://your-site.atlassian.net \
  --dc-url   https://jira-dc.example.com \
  --basic-auth "$CLOUD_BASIC_AUTH" \
  --dc-pat    "$DC_PAT" \
  --input-file ../set-read-only-dc/dc_lockdown_20260508-223324.json \
  --user-map cloud_user_map.csv \
  --output-file backfill_dryrun.json
```

The console shows, for each missing scheme: how many DC grants it has, how many translated, how many were dropped (and why), and the planned Cloud POST body. Nothing is sent to Cloud.

**Step 3: Inspect the audit.**

```bash
jq '.summary, [.results[] | {sourceName, status, kept: (.plannedBody.permissions|length), dropped: (.droppedGrants|length)}]' backfill_dryrun.json
```

If the drop list is unacceptable (e.g. a critical group is missing on Cloud), fix the underlying issue — create the group on Cloud, expand `cloud_user_map.csv`, etc. — then re-run the dry-run.

**Step 4: Execute.**

```bash
node set_permission_scheme.js backfill-missing-schemes \
  --cloud-url https://your-site.atlassian.net \
  --dc-url   https://jira-dc.example.com \
  --basic-auth "$CLOUD_BASIC_AUTH" \
  --dc-pat    "$DC_PAT" \
  --input-file ../set-read-only-dc/dc_lockdown_20260508-223324.json \
  --user-map cloud_user_map.csv \
  --output-file backfill_live.json \
  --execute
```

**Step 5: Re-run revert-from-dc-backup.**

The mode does **not** auto-chain. Re-run the project-side restore as a separate step:

```bash
node set_permission_scheme.js revert-from-dc-backup \
  --url https://your-site.atlassian.net \
  --basic-auth "$CLOUD_BASIC_AUTH" \
  --input-file ../set-read-only-dc/dc_lockdown_20260508-223324.json
```

`unmappedScheme` should now be zero.

**Recovering a single scheme.**

If only one scheme is problematic (or you want to test on a single safe scheme first), narrow with `--only`:

```bash
node set_permission_scheme.js backfill-missing-schemes \
  --cloud-url https://your-site.atlassian.net \
  --dc-url   https://jira-dc.example.com \
  --basic-auth "$CLOUD_BASIC_AUTH" \
  --dc-pat    "$DC_PAT" \
  --input-file dc_lockdown_20260508-223324.json \
  --user-map  cloud_user_map.csv \
  --only      "Legacy Games Permissions" \
  --execute
```

---

## Advanced Scenarios

### Scenario 1: Complex Pattern Matching

Use regex patterns for complex filtering:

```bash
# All projects starting with TEST or DEV
./set_permission_scheme.js set \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --scheme-id 10000 \
  --project-pattern "^(TEST|DEV)" \
  --output-file test_dev.json

# All projects with year in name (2023, 2024, etc.)
./set_permission_scheme.js set \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --scheme-id 10000 \
  --project-pattern "20[0-9]{2}" \
  --output-file yearly_projects.json

# Exclude archived and demo projects
./set_permission_scheme.js set \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --scheme-id 10000 \
  --exclude-pattern "^(ARCHIVE|DEMO|OLD)" \
  --output-file active_projects.json
```

---

### Scenario 2: Batch Processing with Multiple Schemes

Different schemes for different project types:

```bash
# Apply read-only scheme to archived projects
./set_permission_scheme.js set \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --scheme-id 10000 \
  --project-pattern "^ARCHIVE" \
  --output-file archive_readonly.json

# Apply restricted scheme to confidential projects
./set_permission_scheme.js set \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --scheme-id 10001 \
  --project-pattern "^CONFIDENTIAL" \
  --output-file confidential_restricted.json

# Apply open scheme to public projects
./set_permission_scheme.js set \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --scheme-id 10002 \
  --project-pattern "^PUBLIC" \
  --output-file public_open.json
```

---

### Scenario 3: Incremental Rollout with Monitoring

Monitor and adjust during rollout:

```bash
# Phase 1: 10 projects
./set_permission_scheme.js set \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --scheme-id 10000 \
  --project-pattern "^(PROJ1|PROJ2|PROJ3|PROJ4|PROJ5|PROJ6|PROJ7|PROJ8|PROJ9|PROJ10)$" \
  --output-file phase1.json

# Wait 24 hours, monitor for issues
# If OK, proceed to Phase 2

# Phase 2: Next 20 projects
./set_permission_scheme.js set \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --scheme-id 10000 \
  --project-pattern "^PROJ(1[1-9]|2[0-9]|30)$" \
  --output-file phase2.json

# Phase 3: Remaining projects
./set_permission_scheme.js set \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --scheme-id 10000 \
  --exclude-pattern "^PROJ([1-9]|[12][0-9]|30)$" \
  --output-file phase3.json
```

---

## Troubleshooting Examples

### Example 1: Handling Rate Limits

If you hit rate limits, the script automatically retries:

```bash
./set_permission_scheme.js set \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --scheme-id 10000
```

**Output with rate limiting:**
```
📦 Project: DEMO (Demo Project)
   ⏳ Rate limited, retrying in 1s (attempt 1/5)...
   ✅ Changed to: Read Only Scheme (ID: 10000)
```

---

### Example 2: Partial Failure Recovery

If some projects fail, review and retry:

```bash
# Initial attempt
./set_permission_scheme.js set \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --scheme-id 10000 \
  --output-file first_attempt.json

# Review first_attempt.json to see failures
# Extract failed project keys

# Retry only failed projects
./set_permission_scheme.js set \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --scheme-id 10000 \
  --project-pattern "^(FAILED1|FAILED2|FAILED3)$" \
  --output-file retry_attempt.json
```

---

### Example 3: Testing Revert Before Production

Test revert on a copy of the data:

```bash
# Create a backup of the changes file
cp permission_scheme_changes.json permission_scheme_changes_backup.json

# Test revert with dry run
./set_permission_scheme.js revert \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --input-file permission_scheme_changes.json \
  --dry-run

# If dry run looks good, execute revert
./set_permission_scheme.js revert \
  --url https://mycompany.atlassian.net \
  --email admin@mycompany.com \
  --token dGVzdDp0ZXN0 \
  --input-file permission_scheme_changes.json \
  --output-file revert_results.json
```

---

## Tips and Best Practices

### 1. Always Use Dry Run First
```bash
# Bad: Directly applying changes
./set_permission_scheme.js set --url ... --scheme-id 10000

# Good: Test first with dry run
./set_permission_scheme.js set --url ... --scheme-id 10000 --dry-run
./set_permission_scheme.js set --url ... --scheme-id 10000
```

### 2. Use Descriptive Output Files
```bash
# Bad: Generic names
--output-file output.json

# Good: Descriptive names with dates
--output-file migration_readonly_20241114.json
--output-file revert_readonly_20241114.json
```

### 3. Keep Backup Files Organized
```bash
mkdir -p backups/$(date +%Y-%m)
./set_permission_scheme.js set \
  --url ... \
  --scheme-id 10000 \
  --output-file backups/$(date +%Y-%m)/changes_$(date +%Y%m%d_%H%M%S).json
```

### 4. Test Pattern Matching
```bash
# Test your pattern with dry run and single project first
./set_permission_scheme.js set \
  --url ... \
  --scheme-id 10000 \
  --project-key TEST1 \
  --dry-run

# Then test the pattern
./set_permission_scheme.js set \
  --url ... \
  --scheme-id 10000 \
  --project-pattern "^TEST" \
  --dry-run
```

### 5. Monitor Long-Running Operations
```bash
# For large instances, pipe output to a log file
./set_permission_scheme.js set \
  --url ... \
  --scheme-id 10000 \
  2>&1 | tee migration_log_$(date +%Y%m%d_%H%M%S).txt
```

---

## Environment Variables

For security, you can use environment variables:

```bash
# Set environment variables
export JIRA_URL="https://mycompany.atlassian.net"
export JIRA_EMAIL="admin@mycompany.com"
export JIRA_TOKEN="your-api-token"

# Use in script
./set_permission_scheme.js set \
  --url "$JIRA_URL" \
  --email "$JIRA_EMAIL" \
  --token "$JIRA_TOKEN" \
  --scheme-id 10000

# Or create a wrapper script
cat > migrate.sh << 'EOF'
#!/bin/bash
source .env
./set_permission_scheme.js set \
  --url "$JIRA_URL" \
  --email "$JIRA_EMAIL" \
  --token "$JIRA_TOKEN" \
  "$@"
EOF
chmod +x migrate.sh

# Use wrapper
./migrate.sh --scheme-id 10000 --dry-run
```

---

## Automation Examples

### Cron Job for Regular Updates

```bash
# Add to crontab: Update archived projects daily at 2 AM
0 2 * * * cd /path/to/script && ./set_permission_scheme.js set --url https://mycompany.atlassian.net --email admin@company.com --token $JIRA_TOKEN --scheme-id 10000 --project-pattern "^ARCHIVE" --output-file /backups/archive_$(date +\%Y\%m\%d).json >> /logs/migration.log 2>&1
```

### CI/CD Integration

```yaml
# Example GitHub Actions workflow
name: Update Jira Permission Schemes
on:
  workflow_dispatch:
    inputs:
      scheme_id:
        description: 'Permission Scheme ID'
        required: true
      dry_run:
        description: 'Dry run mode'
        required: false
        default: 'true'

jobs:
  update-schemes:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '18'
      - run: npm install
      - run: |
          ./set_permission_scheme.js set \
            --url ${{ secrets.JIRA_URL }} \
            --email ${{ secrets.JIRA_EMAIL }} \
            --token ${{ secrets.JIRA_TOKEN }} \
            --scheme-id ${{ github.event.inputs.scheme_id }} \
            ${{ github.event.inputs.dry_run == 'true' && '--dry-run' || '' }}
```
