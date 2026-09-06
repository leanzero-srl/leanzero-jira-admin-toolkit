# Add User to All Project Roles

A Node.js script to add a specific user to all roles across all (or filtered) projects in Jira Cloud.

## Features

- ✅ **Bulk User Assignment**: Add a user to all roles in all projects with one command
- ✅ **Pagination Support**: Handles large numbers of projects efficiently
- ✅ **Flexible Filtering**: Process all projects, specific projects, or pattern-matched projects
- ✅ **Rate Limiting**: Built-in exponential backoff for API rate limits
- ✅ **Error Handling**: Comprehensive error tracking and reporting
- ✅ **Duplicate Detection**: Automatically handles users already in roles
- ✅ **Progress Tracking**: Real-time console output with progress indicators

## Use Cases

- **New Admin Setup**: Quickly grant a new administrator access to all projects
- **Service Account Creation**: Add bot/service accounts to all projects
- **Bulk Permission Updates**: Add a user to specific role types across the instance
- **Team Onboarding**: Grant team members access to multiple projects at once
- **Audit Account Setup**: Add audit/compliance users to all projects

## Prerequisites

- Node.js (v14 or higher)
- Jira Cloud instance
- Jira API token ([Generate here](https://id.atlassian.com/manage-profile/security/api-tokens))
- **Administer Projects** permission (for each project) OR **Administer Jira** global permission

## Installation

```bash
cd jira/jira-data/all-roles-all-projects
npm install
```

## Finding User Account IDs

Jira Cloud uses account IDs in the format: `712020:xxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`

### Method 1: Via Jira UI
1. Go to **Jira Settings** > **System** > **User Management**
2. Click on the user
3. Look at the URL in your browser
4. The account ID is visible in the URL

### Method 2: Via API
```bash
curl -u email@example.com:your-api-token \
  "https://your-instance.atlassian.net/rest/api/3/user/search?query=user.name@company.com" | jq
```

The response will include the `accountId` field.

## Usage

### Basic Usage

Add a user to all roles in all projects:

```bash
node add_user_to_all_projects.js \
  --url https://your-instance.atlassian.net \
  --email admin@company.com \
  --token your-api-token \
  --user 712020:00000000-0000-0000-0000-000000000000
```

### Filter by Single Project

Add user to all roles in a specific project:

```bash
node add_user_to_all_projects.js \
  --url https://your-instance.atlassian.net \
  --email admin@company.com \
  --token your-api-token \
  --user 712020:00000000-0000-0000-0000-000000000000 \
  --project-key DEMO
```

### Filter by Project Pattern

Add user to all roles in projects matching a regex pattern:

```bash
# All projects starting with "PROD"
node add_user_to_all_projects.js \
  --url https://your-instance.atlassian.net \
  --email admin@company.com \
  --token your-api-token \
  --user 712020:00000000-0000-0000-0000-000000000000 \
  --project-pattern "^PROD"

# All projects containing "2024"
node add_user_to_all_projects.js \
  --url https://your-instance.atlassian.net \
  --email admin@company.com \
  --token your-api-token \
  --user 712020:00000000-0000-0000-0000-000000000000 \
  --project-pattern "2024"
```

### Dry Run Mode

Preview what would happen without making changes:

```bash
node add_user_to_all_projects.js \
  --url https://your-instance.atlassian.net \
  --email admin@company.com \
  --token your-api-token \
  --user 712020:00000000-0000-0000-0000-000000000000 \
  --dry-run
```

## Command Line Options

| Option | Required | Description |
|--------|----------|-------------|
| `--url` | Yes | Jira instance URL (e.g., `https://your-instance.atlassian.net`) |
| `--email` | Yes | Email address for authentication |
| `--token` | Yes | API token for authentication (raw token, not base64) |
| `--user` | Yes | User Account ID to add (format: `712020:xxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) |
| `--project-key` | No | Process only a specific project by key (e.g., `DEMO`) |
| `--project-pattern` | No | Process only projects matching regex pattern (e.g., `^PROD`) |
| `--dry-run` | No | Show what would be done without making changes |

## Output

### Console Output

```
🚀 ADD USER TO ALL PROJECT ROLES
=====================================
👤 User Account ID: 712020:00000000-0000-0000-0000-000000000000
🌐 Jira Instance: your-instance.atlassian.net

📂 Fetching all projects...
   📊 Fetched 50 projects so far...
✅ Total projects found: 75

🔧 Processing projects and roles...

📦 Project: DEMO (Demo Project)
   📋 Found 4 roles
   ✅ Administrators (added)
   ✓ Developers (already exists)
   ✅ Users (added)
   ✅ Viewers (added)

📊 SUMMARY
=====================================
Total Projects: 75
Processed Projects: 75
Total Roles Processed: 300
Successfully Added: 225
Already Exists: 75
Failures: 0

✅ Script completed successfully!
```

### Status Indicators

- `✅` - Successfully added to role
- `✓` - User already exists in role (no action needed)
- `❌` - Failed to add to role
- `⚠️` - Warning or skipped

## Common Workflows

### Workflow 1: Add New Admin to All Projects

```bash
# Step 1: Find the user's account ID
curl -u email@example.com:token \
  "https://your-instance.atlassian.net/rest/api/3/user/search?query=newadmin@company.com" | jq

# Step 2: Add user to all projects
node add_user_to_all_projects.js \
  --url https://your-instance.atlassian.net \
  --email admin@company.com \
  --token your-api-token \
  --user 712020:new-admin-account-id
```

### Workflow 2: Add Service Account to Production Projects

```bash
# Add service account to all PROD projects
node add_user_to_all_projects.js \
  --url https://your-instance.atlassian.net \
  --email admin@company.com \
  --token your-api-token \
  --user 712020:service-account-id \
  --project-pattern "^PROD"
```

### Workflow 3: Safe Bulk Assignment

```bash
# Step 1: Test on a single project first
node add_user_to_all_projects.js \
  --url https://your-instance.atlassian.net \
  --email admin@company.com \
  --token your-api-token \
  --user 712020:user-account-id \
  --project-key TEST

# Step 2: Dry run on all projects
node add_user_to_all_projects.js \
  --url https://your-instance.atlassian.net \
  --email admin@company.com \
  --token your-api-token \
  --user 712020:user-account-id \
  --dry-run

# Step 3: Execute for real
node add_user_to_all_projects.js \
  --url https://your-instance.atlassian.net \
  --email admin@company.com \
  --token your-api-token \
  --user 712020:user-account-id
```

## What Roles Does It Add?

The script adds the user to **ALL roles** that exist in each project. Common roles include:

- **Administrators** - Full project admin access
- **Developers** - Development and issue management
- **Users** - Basic project access
- **Viewers** - Read-only access
- **Custom Roles** - Any custom roles you've created

The script automatically detects all roles for each project, so it works with both default and custom role configurations.

## Error Handling

The script includes comprehensive error handling:

- **Rate Limiting**: Automatic exponential backoff (up to 5 retries, max 32s delay)
- **Permission Errors**: Reports projects where you don't have admin access
- **Network Errors**: Retries with backoff on transient failures
- **Duplicate Users**: Gracefully handles users already in roles (reports as "already exists")
- **Invalid Account IDs**: Validates format before proceeding

All errors are:
1. Displayed in the console with clear descriptions
2. Included in the summary statistics
3. Tracked with project and role context

## Permissions Required

To run this script, you need:

- **Administer Jira** global permission (grants access to all projects), OR
- **Administer Projects** permission for each individual project

The script will skip projects where you don't have sufficient permissions and report them in the errors section.

## API Endpoints Used

This script uses the following Jira Cloud REST API endpoints:

- [GET /rest/api/3/project/search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/#api-rest-api-3-project-search-get) - Get all projects (paginated)
- [GET /rest/api/3/project/{projectIdOrKey}/role](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-project-roles/#api-rest-api-3-project-projectidorkey-role-get) - Get project roles
- [POST /rest/api/3/project/{projectIdOrKey}/role/{id}](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-project-role-actors/#api-rest-api-3-project-projectidorkey-role-id-post) - Add user to role

## Troubleshooting

### "Invalid user account ID format"
**Solution:** Ensure you're using the correct format: `712020:xxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`

### "HTTP 403" errors
**Solution:** 
- Verify you have **Administer Jira** global permission, OR
- Ensure you have **Administer Projects** permission for the target projects

### "HTTP 400" - User already in role
**Solution:** This is not an error. The script detects this and reports it as "already exists"

### "HTTP 429" rate limiting
**Solution:** The script automatically handles rate limiting with exponential backoff. If you see this frequently, the script will retry automatically.

### Projects not found
**Solution:**
- Verify the project key is correct (case-sensitive)
- Check that the projects haven't been archived or deleted
- Ensure you have at least **Browse Projects** permission

### User not found
**Solution:**
- Verify the account ID is correct
- Check that the user account is active (not deactivated)
- Ensure the user exists in your Jira instance

## Security Notes

- Never commit your API token to version control
- Use environment variables for sensitive credentials
- API tokens should be rotated regularly
- The script uses Basic Authentication over HTTPS
- Consider using a dedicated service account for automation

## Examples

### Example 1: Add Admin to All Projects
```bash
node add_user_to_all_projects.js \
  --url https://mycompany.atlassian.net \
  --email jira-admin@mycompany.com \
  --token ATBBt7xh9k3mP8qRsT2uV5wX \
  --user 712020:00000000-0000-0000-0000-000000000000
```

### Example 2: Add Bot to Engineering Projects
```bash
node add_user_to_all_projects.js \
  --url https://mycompany.atlassian.net \
  --email jira-admin@mycompany.com \
  --token ATBBt7xh9k3mP8qRsT2uV5wX \
  --user 712020:bot-account-id \
  --project-pattern "^(ENG|DEV|TECH)"
```

### Example 3: Test Before Applying
```bash
# Dry run
node add_user_to_all_projects.js \
  --url https://mycompany.atlassian.net \
  --email jira-admin@mycompany.com \
  --token ATBBt7xh9k3mP8qRsT2uV5wX \
  --user 712020:user-id \
  --dry-run

# Real run
node add_user_to_all_projects.js \
  --url https://mycompany.atlassian.net \
  --email jira-admin@mycompany.com \
  --token ATBBt7xh9k3mP8qRsT2uV5wX \
  --user 712020:user-id
```

## Performance

- The script processes projects sequentially to avoid overwhelming the API
- Automatic rate limiting protection with exponential backoff
- For large instances (500+ projects), expect 5-15 minutes runtime
- Progress is displayed in real-time

## License

ISC

## Support

For issues or questions:
1. Check the [Jira Cloud REST API documentation](https://developer.atlassian.com/cloud/jira/platform/rest/v3/)
2. Review the error messages in the console output
3. Verify your permissions in Jira
