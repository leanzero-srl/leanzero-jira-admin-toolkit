# Quick Start Guide

## 🚀 5-Minute Getting Started

### Installation
```bash
cd jira/jira-data/set-read-only-cloud
npm install
```

### Basic Usage

#### SET Mode (Apply Permission Scheme)
```bash
# 1. Always start with dry run
./set_permission_scheme.js set \
  --url https://your-instance.atlassian.net \
  --email your.email@company.com \
  --token your-api-token \
  --scheme-id 10000 \
  --dry-run

# 2. If everything looks good, run for real
./set_permission_scheme.js set \
  --url https://your-instance.atlassian.net \
  --email your.email@company.com \
  --token your-api-token \
  --scheme-id 10000
```

#### REVERT Mode (Undo Changes)
```bash
# Revert to previous permission schemes
./set_permission_scheme.js revert \
  --url https://your-instance.atlassian.net \
  --email your.email@company.com \
  --token your-api-token \
  --input-file permission_scheme_changes.json
```

---

## 📋 Command Cheat Sheet

### SET Mode Flags
| Flag | Description | Example |
|------|-------------|---------|
| `--url` | Jira instance URL | `--url https://company.atlassian.net` |
| `--email` | Your email | `--email admin@company.com` |
| `--token` | API token | `--token abc123...` |
| `--scheme-id` | Target scheme ID | `--scheme-id 10000` |
| `--dry-run` | Test without changes | `--dry-run` |
| `--project-key` | Single project | `--project-key DEMO` |
| `--project-pattern` | Regex pattern | `--project-pattern "^TEST"` |
| `--exclude-pattern` | Exclude pattern | `--exclude-pattern "^DEMO"` |
| `--output-file` | Custom output file | `--output-file results.json` |

### REVERT Mode Flags
| Flag | Description | Example |
|------|-------------|---------|
| `--url` | Jira instance URL | `--url https://company.atlassian.net` |
| `--email` | Your email | `--email admin@company.com` |
| `--token` | API token | `--token abc123...` |
| `--input-file` | Changes file to revert | `--input-file changes.json` |
| `--dry-run` | Test without changes | `--dry-run` |
| `--output-file` | Custom output file | `--output-file revert.json` |

---

## 🎯 Common Scenarios

### Scenario 1: Apply to All Projects
```bash
./set_permission_scheme.js set \
  --url https://company.atlassian.net \
  --email admin@company.com \
  --token abc123 \
  --scheme-id 10000
```

### Scenario 2: Apply to Specific Projects
```bash
# Single project
./set_permission_scheme.js set \
  --url https://company.atlassian.net \
  --email admin@company.com \
  --token abc123 \
  --scheme-id 10000 \
  --project-key DEMO

# Projects starting with "TEST"
./set_permission_scheme.js set \
  --url https://company.atlassian.net \
  --email admin@company.com \
  --token abc123 \
  --scheme-id 10000 \
  --project-pattern "^TEST"
```

### Scenario 3: Exclude Projects
```bash
# Apply to all except DEMO projects
./set_permission_scheme.js set \
  --url https://company.atlassian.net \
  --email admin@company.com \
  --token abc123 \
  --scheme-id 10000 \
  --exclude-pattern "^DEMO"
```

### Scenario 4: Safe Deployment
```bash
# Step 1: Dry run
./set_permission_scheme.js set \
  --url https://company.atlassian.net \
  --email admin@company.com \
  --token abc123 \
  --scheme-id 10000 \
  --dry-run

# Step 2: Apply changes
./set_permission_scheme.js set \
  --url https://company.atlassian.net \
  --email admin@company.com \
  --token abc123 \
  --scheme-id 10000 \
  --output-file backup.json

# Step 3: If needed, revert
./set_permission_scheme.js revert \
  --url https://company.atlassian.net \
  --email admin@company.com \
  --token abc123 \
  --input-file backup.json
```

---

## 🔍 Finding Permission Scheme IDs

### Method 1: Via UI
1. Go to: **Jira Settings** → **Issues** → **Permission Schemes**
2. Click on a scheme
3. Look at URL: `.../EditPermissions!default.jspa?schemeId=10000`
4. The ID is: `10000`

### Method 2: Via API
```bash
curl -u email@example.com:api-token \
  https://your-instance.atlassian.net/rest/api/3/permissionscheme | jq
```

---

## ⚠️ Important Notes

### Before You Run
- ✅ Always use `--dry-run` first
- ✅ Keep the output JSON file safe (needed for revert)
- ✅ Verify you have **Administer Jira** permission
- ✅ Test on a single project before bulk operations

### After You Run
- ✅ Review the output for errors
- ✅ Check the JSON file for details
- ✅ Verify changes in Jira UI
- ✅ Keep backup files for at least 30 days

### If Something Goes Wrong
- ✅ Don't panic - you can revert
- ✅ Use the JSON output file with `revert` mode
- ✅ Check error messages in console output
- ✅ Review the troubleshooting section in README.md

---

## 🔑 Getting API Token

1. Go to: https://id.atlassian.com/manage-profile/security/api-tokens
2. Click **Create API token**
3. Give it a name (e.g., "Permission Scheme Script")
4. Copy the token (you won't see it again!)
5. Store it securely

---

## 📊 Understanding Output

### Console Output Symbols
- 🚀 Script started
- 📂 Fetching data
- 📦 Processing project
- ✅ Success
- ❌ Error
- ⚠️ Warning
- ℹ️ Info
- 🔍 Dry run action
- ↩️ Reverting
- 💾 File saved
- 📊 Summary

### Status Indicators
- `✅ Changed to:` - Successfully updated
- `ℹ️ Already using target` - No change needed
- `❌ Failed` - Error occurred
- `🔍 Would change to:` - Dry run mode

---

## 🆘 Quick Troubleshooting

### Error: "Invalid permission scheme ID format"
**Solution:** Use numeric ID only, e.g., `--scheme-id 10000`

### Error: "HTTP 403"
**Solution:** Check you have **Administer Jira** permission

### Error: "Project not found"
**Solution:** Verify project key is correct (case-sensitive)

### Error: "Invalid input file format"
**Solution:** Ensure you're using a JSON file from SET mode

### Script is slow
**Solution:** This is normal for large instances. The script handles rate limiting automatically.

---

## 💡 Pro Tips

1. **Use descriptive output files:**
   ```bash
   --output-file migration_readonly_$(date +%Y%m%d).json
   ```

2. **Test patterns first:**
   ```bash
   # Test with dry run + single project
   --project-key TEST1 --dry-run
   # Then test pattern
   --project-pattern "^TEST" --dry-run
   ```

3. **Save logs for large operations:**
   ```bash
   ./set_permission_scheme.js set ... 2>&1 | tee migration.log
   ```

4. **Use environment variables for credentials:**
   ```bash
   export JIRA_URL="https://company.atlassian.net"
   export JIRA_EMAIL="admin@company.com"
   export JIRA_TOKEN="your-token"
   ```

---

## 📚 Further Reading

- **Full documentation:** See [README.md](README.md)
- **Examples:** See [EXAMPLES.md](EXAMPLES.md)
- **API docs:** [Jira Cloud REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/)

---

## ✨ Quick Reference

```bash
# Show all commands
./set_permission_scheme.js --help

# SET mode help
./set_permission_scheme.js set --help

# REVERT mode help
./set_permission_scheme.js revert --help

# Minimal SET command
./set_permission_scheme.js set --url URL --email EMAIL --token TOKEN --scheme-id ID

# Minimal REVERT command
./set_permission_scheme.js revert --url URL --email EMAIL --token TOKEN --input-file FILE
```
