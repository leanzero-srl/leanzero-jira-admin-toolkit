# Jira Screen Field Fetcher

This script fetches screen tabs and their associated fields from a Jira instance using the Atlassian REST API v3. It outputs field names and IDs to text files for each screen tab.

## Features

- Fetches all tabs for a given screen ID
- Retrieves all fields for each tab
- Outputs field data to organized text files
- Handles rate limiting with automatic retries
- Supports optional project key for permission scoping

## Requirements

- Node.js 16.0 or higher
- API token with appropriate permissions (Administer Jira global permission or Administer projects project permission)

## Installation

1. Install dependencies:
```bash
npm install commander
```

2. Make the script executable (optional):
```bash
chmod +x fetch_screen_fields.js
```

## Usage

### Basic Usage

Fetch fields for a specific screen:

```bash
node fetch_screen_fields.js \
  --url https://your-domain.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --screen 12345
```

### With Project Key

For permission scoping when you have project-specific permissions:

```bash
node fetch_screen_fields.js \
  --url https://your-domain.atlassian.net \
  --email user@company.com \
  --token your-api-token \
  --screen 12345 \
  --project-key PROJ
```

### Sequential Execution

Run this script sequentially for each screen ID you want to fetch:

```bash
# Screen 1
node fetch_screen_fields.js --url https://your-domain.atlassian.net --email user@company.com --token api-token --screen 12345

# Screen 2
node fetch_screen_fields.js --url https://your-domain.atlassian.net --email user@company.com --token api-token --screen 12346

# Screen 3
node fetch_screen_fields.js --url https://your-domain.atlassian.net --email user@company.com --token api-token --screen 12347
```

## Command Line Options

| Option | Required | Description |
|--------|----------|-------------|
| `--url` | Yes | Jira instance URL (e.g., https://your-domain.atlassian.net) |
| `--email` | Yes | Email address for authentication |
| `--token` | Yes | API token for authentication |
| `--screen` | Yes | Screen ID to fetch fields from |
| `--project-key` | No | Project key for permission scoping |

## Output

The script creates a `./screen-fields/` directory if it doesn't exist and saves field data in text files with the naming convention:

```
{screenId}_{tabId}_{tabName}_fields.txt
```

Each file contains comma-separated values with field name and ID:

```csv
Field Name,Field ID
Summary,summary
Description,description
Custom Field 1,customfield_10001
Custom Field 2,customfield_10002
```

## API Permissions

The script requires the following permissions:

- **Administer Jira global permission**, OR
- **Administer projects project permission** when the project key is specified

The API token must have access to:
- `read:screen-tab:jira` scope (OAuth 2.0)
- `ADMIN` scope (Connect app)

## API Endpoints Used

1. **Get Screen Tabs**
   ```
   GET /rest/api/3/screens/{screenId}/tabs
   ```

2. **Get Tab Fields**
   ```
   GET /rest/api/3/screens/{screenId}/tabs/{tabId}/fields
   ```

## Error Handling

The script includes:
- Rate limiting detection with exponential backoff (up to 32 seconds)
- Automatic retry mechanism (5 attempts maximum)
- Detailed error messages for troubleshooting
- Graceful handling of empty responses

## Troubleshooting

### Common Issues

1. **403 Forbidden Error**
   - Check if your API token has the required permissions
   - Verify you have the correct global or project-level permissions

2. **404 Not Found Error**
   - Verify the screen ID is correct
   - Check if you have access to the screen

3. **429 Too Many Requests**
   - The script automatically handles rate limiting with retries
   - Wait and try again if you're making many consecutive calls

### Finding Required Information

- **Screen ID**: Go to Jira Administration > Screens
- **Project Key**: Found in the project settings URL or administration area
- **API Token**: Generate from https://id.atlassian.com/manage-profile/security/api-tokens

## Example Output Files

After running the script, you'll find files like:

```
screen-fields/
├── 12345_25_Summary_fields.txt
├── 12345_30_Description_fields.txt
└── 12346_25_Summary_fields.txt
```

Each file contains the field names and IDs for that specific tab.

## Support

For issues or feature requests, please check the Atlassian REST API documentation:
- [Jira Cloud REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-screens/)
```
