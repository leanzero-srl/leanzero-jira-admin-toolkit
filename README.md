# LeanZero Jira Admin Toolkit

Thirteen Node.js tools for the **administrative work around a Jira Cloud migration** — permissions,
security levels, project roles, read-only lockdown, and org-level identity clean-up.

Apache-2.0. Public REST plus the Atlassian admin and Teams APIs.

---

## The problem this exists for

Jira Cloud has **no bulk endpoints** for most administration. Assigning a permission scheme to 300
projects is 300 individual `PUT`s. Adding a group to every permission in every scheme is over a
thousand calls. The admin UI offers no multi-select for any of it.

So the work either does not get done, or it gets done by hand over three days with mistakes in it.
These tools do it in one pass, with a dry run, a snapshot, and a documented way back.

---

## What is in the box

### Migration windows — freeze and thaw

| Tool | What it does |
|---|---|
| [`set_read_only_dc`](./set_read_only_dc) | Puts every Data Center project on one read-only permission scheme for the cutover window, saving each project's previous scheme **id and name** to a portable backup. Reverts from that backup. |
| [`set_read_only_cloud`](./set_read_only_cloud) | The Cloud counterpart. Four modes: **set** a scheme site-wide, **revert** from a snapshot, **lockdown** (create a brand-new read-only scheme and assign it in one shot), and **revert-from-dc-backup** — which reads the DC backup above and restores each project's original scheme on Cloud by matching scheme *name*, because the ids changed. Plus `backfill-missing-schemes`, which recreates on Cloud the DC schemes that have no Cloud equivalent. |

### Permissions and access

| Tool | What it does |
|---|---|
| [`bulk_assign_permission_scheme`](./bulk_assign_permission_scheme) | `export` / `apply` / `restore`. Snapshot every project's current permission scheme, bulk-assign a target scheme, roll back to the snapshot. The Cloud replacement for three Data Center Groovy console scripts. |
| [`copy_permission_schemes_dc_to_cloud`](./copy_permission_schemes_dc_to_cloud) | Recreates DC permission schemes on Cloud as literal copies, translating every grant holder. Exists because migration assistants only carry schemes that are **assigned to a project** — unassigned ones are silently left behind. Creation only; assigns nothing. |
| [`add_group_to_permission_schemes`](./add_group_to_permission_schemes) | Adds one group to every permission type that already has a grant, in every permission scheme. |
| [`add_group_to_security_levels`](./add_group_to_security_levels) | Adds one group to every issue security level in every security scheme — the fix for "the audit says there are 40,000 issues and I can only see 31,000". |
| [`add_user_to_all_project_roles`](./add_user_to_all_project_roles) | Adds a user to all roles across all (or filtered) projects. For onboarding an admin, a service account or a migration bot. |

### Identity and org clean-up

| Tool | What it does |
|---|---|
| [`suspend_accounts_by_domain`](./suspend_accounts_by_domain) | Suspends (or removes) Atlassian org accounts filtered by email domain, via the org admin API. Suspension is reversible and frees the licence while keeping the data. |
| [`bulk_add_group_customers`](./bulk_add_group_customers) | Collects every member of a Jira Cloud group and adds them as **JSM customers**, with an audit phase that checks existing access groups in bulk instead of doing a per-user lookup for a thousand people. |
| [`remove_solo_member_teams`](./remove_solo_member_teams) | Finds every Atlassian Team whose single sole member is one given person and deletes them — the debris a departing admin or a migration leaves behind. Every team is re-checked at delete time, so a stale plan can never delete the wrong thing. |
| [`diagnose_user_picker`](./diagnose_user_picker) | **Read-only.** Works out why migrated users are invisible in the user picker despite being licensed and referenceable by `accountId`. Cross-tabulates findability against every org directory attribute so the discriminator falls out of the data. |

### Inspection and housekeeping

| Tool | What it does |
|---|---|
| [`fetch_screen_fields`](./fetch_screen_fields) | Dumps every tab of a screen and every field on each tab. The answer to "why is this field blank after we wrote to it" is usually here. |
| [`delete_stale_projects`](./delete_stale_projects) | Deletes projects not updated in N months. Validates the target URL looks like a sandbox and requires interactive confirmation. **Sandbox hygiene only.** |

---

## Start here

```bash
git clone https://github.com/leanzero-srl/leanzero-jira-admin-toolkit.git
cd leanzero-jira-admin-toolkit/bulk_assign_permission_scheme
npm install
cp .env.example .env       # CLOUD_BASE_URL, CLOUD_API_TOKEN = base64("email:api_token")

# Snapshot BEFORE anything else in this repo touches the site.
node main/bulk_assign_permission_scheme.js export
```

That export is your undo for most of what follows. Take it first.

---

## How every tool in this repo behaves

**Plan then apply.** The default of every tool is read-only. Writing needs an explicit `--apply` or
the absence of `--dry-run`, and the plan is a file you can read.

**Snapshot before mutate.** Anything that changes an assignment writes the previous state to a JSON
backup first, and every such tool has a revert mode that consumes it. The backup stores both the
**id** and the **name** of what it replaced, so it stays useful across an instance boundary where ids
change and names survive.

**Re-checked at write time.** Destructive operations re-verify their precondition immediately before
acting. If a team gained a member since the plan was built, it is skipped.

**Rate-limit aware.** Exponential backoff on 429 and 5xx throughout, with per-item failure tracking
so one bad project does not abort a run of three hundred.

---

## The rule that matters

**On a production system you do not own, ask before you change configuration.** Every tool here is
built to make the asking easy — run the plan, read the numbers, put the exact scope in front of the
system owner, then apply. Reversibility is not authorisation; a perfectly reversible change nobody
sanctioned is still a change nobody sanctioned.

And **prove the negative before you act on it.** A count of zero, an empty list, a 404 — none of those
licence a write until you have proved your credentials can see the thing at all, on that same object.
A positive control on a *different* project proves nothing, because filters are per-object.

---

## Licence

Apache-2.0. See [LICENSE](./LICENSE).

Built by [LeanZero](https://leanzero.net) during real Atlassian Cloud migrations.
