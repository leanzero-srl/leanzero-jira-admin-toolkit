# Jira Project Deletion Script

A Node.js script to delete old projects from Jira that haven't been updated in the specified number of months. Designed specifically for sandbox environments with safety checks and interactive confirmations.

## Features

- 🔍 **Project Discovery**: Lists all projects in your Jira instance with pagination support
- 📅 **Time-based Filtering**: Identifies projects not updated in the specified number of months
- ⚠️ **Safety Checks**: Validates sandbox URLs and requires confirmation before deletion
- 🔒 **Dry Run Mode**: Test your changes without actually deleting anything
- 📊 **Progress Tracking**: Real-time progress reporting and detailed summaries
- 🛡️ **Error Handling**: Robust error handling with retry logic

## Requirements

- Node.js 16.0 or higher
- Jira instance with API access
- API token with appropriate permissions (Administer Projects)

## Installation

1. Install dependencies:
```bash
npm install
```

2. Ensure you have a valid Jira API token with admin permissions.

## Usage

### Basic Usage (6 months threshold)
```bash
node delete_old_projects.js \
  --url https://your-sandbox.atlassian.net \
  --email user@company.com \
  --token your-api-token
```

### Custom Month Threshold
```bash
node delete_old_projects.js \
  --url https://your-sandbox.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --months 3
```

### Dry Run Mode (Recommended First)
```bash
node delete_old_projects.js \
  --url https://your-sandbox.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --months 6 \
  --dry-run
```

### Force Mode (Use with Caution)
```bash
node delete_old_projects.js \
  --url https://your-sandbox.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --months 6 \
  --force
```

## Command Line Options

| Option | Description | Required |
|--------|-------------|----------|
| `--url <url>` | Jira instance URL | Yes |
| `--email <email>` | Email address for authentication | Yes |
| `--token <token>` | API token for authentication | Yes |
| `--months <number>` | Number of months to consider projects as old (default: 6) | No |
| `--dry-run` | Perform a dry run without actually deleting projects | No |
| `--force` | Skip interactive confirmation prompts | No |

## Safety Features

### Sandbox Environment Validation
The script automatically checks if the URL contains "sandbox" (case-insensitive) and warns you if not found:

```
⚠️  Warning: URL does not contain "sandbox".
   This script should only be run in sandbox environments.
```

### Interactive Confirmation
Before any deletion occurs, you'll see a list of projects to be deleted and must confirm:

```
🚨 Found 5 projects that haven't been updated in 6 months:
   1. TEST-001 - Test Project One
      Last update: 2023-01-15
   2. TEST-002 - Test Project Two  
      Last update: 2023-02-20

⚠️  Are you sure you want to delete 5 projects? (yes/no):
```

### Dry Run Protection
By default, the script runs in dry-run mode to prevent accidental deletions:

```
🔒 DRY RUN MODE: No projects will actually be deleted.
```

## Output Examples

### Finding Old Projects
```
🔍 Fetching all projects from Jira...
✅ Found 150 total projects

📅 Checking projects not updated since 6 months ago...
   Cutoff date: January 15, 2023

🚨 Found 5 projects that haven't been updated in 6 months:
   1. TEST-001 - Test Project One
      Last update: January 10, 2023
   2. TEST-002 - Test Project Two  
      Last update: December 5, 2022
```

### Deletion Process
```
🚀 Starting project deletion process...

🗑️  Deleting project: TEST-001 - Test Project One
   ✅ Successfully deleted TEST-001

🗑️  Deleting project: TEST-002 - Test Project Two  
   ✅ Successfully deleted TEST-002
```

### Final Summary
```
==================================================
📊 FINAL SUMMARY
==================================================

📈 Statistics:
   Total projects found: 150
   Projects checked for deletion: 5
   Successfully deleted: 2
   Failed deletions: 0
   
⏱️  Execution time: 45.23 seconds
==================================================
```

## Error Handling

The script includes comprehensive error handling for:

- **Authentication failures**: Invalid API tokens or permissions
- **Network timeouts**: Automatic retries with exponential backoff
- **API errors**: Detailed error messages from Jira responses
- **Invalid parameters**: Input validation with helpful error messages

## API Endpoints Used

- `GET /rest/api/3/project/search` - Retrieve paginated list of projects
- `DELETE /rest/api/3/project/{projectIdOrKey}` - Delete individual projects

## Best Practices

1. **Always test with `--dry-run` first** to see what would be deleted
2. **Run during off-peak hours** to minimize impact on users
3. **Backup important projects** before deletion if possible
4. **Use the `--force` flag only in automated scripts**, never manually
5. **Monitor the script output** for any errors or warnings

## Troubleshooting

### Common Issues

1. **"Missing required parameters"**
   - Ensure you've provided `--url`, `--email`, and `--token`

2. **"API request failed with status 401"**
   - Check your API token permissions and expiration

3. **"URL does not contain 'sandbox'"**
   - Use `--force` flag only in controlled environments

4. **"Failed to parse JSON response"**
   - Check your Jira instance URL is correct and accessible

### Getting Help

If you encounter issues:
1. Check the script output for error messages
2. Verify your Jira API permissions
3. Ensure you're using a supported Node.js version (16+)
4. Run with `--dry-run` to isolate issues

## License

MIT License - See LICENSE file for details.