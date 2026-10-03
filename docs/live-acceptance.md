# Isolated live acceptance

Regression tests use synthetic IDs and fake runners. Live acceptance is a
separate, explicitly approved experiment on the owner's Mac. Record actual
IDs, private configuration and results outside Git; publish source and
synthetic test evidence only.

## Permission and scope

Before running anything against stores, approve account/container/list/folder
metadata discovery, the exact synthetic records to create/update, and any new
macOS grants. Contacts access and Automation access to Notes may persist and
are broader than the application's allowlists. Notes must already be running
with existing Automation access for ordinary adapter calls. The plugin never
requests permissions or launches it automatically.

The manual helpers are outside MCP and do not run during startup:

- `scripts/enroll-native-test-scopes.swift` can request Contacts access only
  with its explicit flag, inspect container metadata, create a uniquely named
  unshared test reminder list in one unique iCloud source, or request Notes
  Automation access in its explicitly selected mode.
- `scripts/enroll-notes-test-scope.mjs` creates one new uniquely named top-level
  folder in one unique iCloud Notes account. It requires existing permission and
  writes scope identifiers to a new owner-only private file outside Git.

For each test use a fresh `Apple PIM Connector Tests <unique-token>` label.
Existing matching list/folder labels cause an abort; they are never adopted.
Contacts' `CNContainer` exposes a display name and type, without proof of the
account provider. The owner must confirm the selected iCloud container before
creating a card, even when its name is unique. Contact membership checks inspect
identifiers in that allowed container before loading only the requested card's
details. Do not claim that unrelated identifiers are never inspected.

## Read and write checks

Use a temporary MCP client with this checkout's built server and native tools.
Keep its private configuration owner-only, with only one domain enabled at a
time, exact resource/account identifiers, writes explicitly enabled and deletes
disabled. Do not use a profile, system default or per-call configuration override.

| Domain | Approved synthetic sequence | Independent readback |
| --- | --- | --- |
| Contacts | Create one uniquely labeled card in the owner-confirmed container; update only its nickname | Separate get after each write: same raw ID, expected name/nickname and source container |
| Reminders | Create a fresh unshared test list; confirm it is empty; create one dateless fixture; update its title/notes | Separate get after each write: same ID/list, expected content, incomplete, priority zero, no dates/alarms/recurrence/URL |
| Notes | Create a fresh top-level test folder; create one plain-text fixture; search/read it; append plain text | Separate get after creation and append: same ID/account/folder, original and appended text present, no attachments or truncation |

No existing personal record is read for content or modified. No test records
are deleted or completed; cleanup requires a separate approved action. Contacts
fixtures need no email, phone or notes field. Reminder fixtures have no due date,
alarm, invitee or shared-list placement.

Treat each mutation as single-shot. Write a private execution sentinel before
attempting creation/update/append. A timeout, failed readback or inability to
save returned IDs can mean the write occurred. Keep the private evidence and
reconcile only the approved synthetic item; never retry automatically or create
another label to hide an unknown outcome.

Notes can normalize created HTML. If append rejects the test note, inspect only
that approved synthetic note's markup before deciding whether a safe adaptation
is possible. Do not weaken locked-note, attachment or rich-content restrictions
to make a test pass. The actual MCP process's no-prompt permission preflight
must succeed; another helper's authorization result is insufficient.

## What a pass establishes

Separate native reads prove persisted behavior through the tested Mac process.
They do not prove remote iCloud synchronization, another host's permission,
plugin installation or direct cloud-tool reachability. Validate each separately.
The supported local package and cloud limits are described in
[local plugin setup](local-plugin.md) and [assistant transport](assistant-transport.md).
