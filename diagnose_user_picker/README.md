# diagnose_user_picker

**Read-only.** Works out why some migrated accounts are invisible in the Jira Cloud **user picker**
even though they exist, are licensed, and can be referenced by `accountId`.

## The symptom

After a migration, a user-picker custom field (Reporting Manager, Approver, Requested For…) shows values
that are already stored on the issue, but the same person cannot be *found* when someone opens the
picker and types their name. Everything else about the account looks healthy in the admin console.

The instinct is to blame permissions or licensing. Usually it is neither: the account is missing from
Jira's **user-search index**. `GET /user/{accountId}` returns it; `GET /user/search?query=<name>`
does not. Permissions cannot produce that split — an index gap can.

## What it measures

For a cohort of accountIds (`cohort.json`), for each account:

| Signal | Question |
|---|---|
| `findableByName` | Does `GET /rest/api/3/user/search?query=<displayName>` return this id? |
| `findableByPicker` | Does `GET /rest/api/3/user/picker?query=<displayName>` return this id? |
| org directory attributes | `claimStatus`, `platformRoles`, email domain, product count |

Then it cross-tabulates *findable* against every attribute, so the discriminator falls out of the
data instead of being guessed. If every unfindable account shares one `claimStatus` and every
findable one does not, you have your cause in one table.

## Setup

It reuses credentials already present in sibling scripts rather than asking for a fourth copy:

- Jira Basic token from `../sync_same_instance_fields/.env` (`CLOUD_BASE_URL`, `CLOUD_API_TOKEN`)
- Org bearer key from `../suspend_accounts_by_domain/.env` (`ORG_ADMIN_API_KEY`, `ORG_ID`)

Both must exist before running. Then put the accountIds to test in `cohort.json`:

```json
["712020:00000000-0000-0000-0000-000000000000", "712020:00000006-0000-4000-8000-000000000006"]
```

## Run

```bash
npm install
node diagnose.js
```

It writes nothing to Jira. The output is the cross-tabulation plus a per-account table.

## Reading the result

- **Findable by `accountId` only, in every picker call** — index gap. The usual remedy is to remove
  the account from its licensing group and re-add it, which re-triggers indexing. Verify on one
  account and give it several minutes before concluding it did not work.
- **Split by `claimStatus` or product count** — an identity/licensing problem, not an index problem.
  Fix it in the org admin console.
- **Findable, but the field still looks empty** — the problem is the field context or the screen, not
  the user. Different script.
