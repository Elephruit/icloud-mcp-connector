# Initial proposal: Family calendar metadata only

This historical checkpoint records the proposal before live acceptance. Its
not-yet-run statements describe that checkpoint. Current test procedures are in
[live acceptance](live-acceptance.md); private results remain outside Git.

This is a concrete proposal, not authorization. Nothing below has been run
against personal stores. The parent task can request one approval for this
bounded experiment and then delegate its execution to this existing local task.

## Smallest useful live experiment

1. Check the existing Calendar grant without prompting using the checkout's
   `swift/.build/release/calendar-cli auth-status`.
2. Resolve only the calendar named **Family** in the source named **iCloud**
   using the reviewed one-shot `scripts/enroll-family-calendar.swift`. This
   temporarily enumerates calendar/source metadata to compare exact names, but
   returns only one matching calendar/source ID pair. It never queries events.
   Zero matches or duplicate matches stop without returning candidate IDs.
   The source label is an enrollment selector, not proof of account ownership;
   the owner must confirm the selected calendar is the intended shared Family
   calendar before its IDs authorize the connector. If this Mac uses another
   source label, stop and obtain that explicit scope instead of broadening it.
3. Put only that confirmed pair in a temporary private configuration outside
   Git. Enable `calendars` in `allowlist` mode, disable all other domains, and
   keep `allow_writes: false` and `allow_deletes: false`. Do not read or merge
   existing private settings.
4. Start this checkout's bundled MCP server once through a transient local
   stdio client, discover its tools, and call
   `{"name":"calendar","arguments":{"action":"list"}}`. Its native list
   returns allowed calendar metadata only: ID, title, source/source ID, type,
   color, and modification capability. Verify exactly the approved Family pair
   is returned. Close the client/server and remove the temporary configuration.

**Reads:** calendar/source metadata for identity enrollment and the confirmed
Family calendar's metadata. **No event content, event date range, Notes folder,
Reminders list, Contacts container, or Mail is in scope. No records are written
or deleted.** IDs and resulting metadata stay outside the public repository;
the parent receives a minimal success/failure report, not personal identifiers.
Calendar mutations now additionally require host-owned `allow_writes: true`;
the metadata experiment must leave that false. The transient client
must send only `list`, and no reusable registration is enabled.

## Permission and invocation

EventKit calendar reads require **Full Calendar Access** on macOS 14 or newer
(Calendar access on older supported macOS). The OS grant covers calendars broadly;
the connector enforces the narrower exact-ID scope. A calendar-specific macOS
grant is unavailable through this EventKit path.

The enrollment helper defaults to checking the existing grant without prompting.
Only if the approval explicitly includes a Calendar permission request may the
local task invoke `resolve --request-calendar-access`. No Reminders, Contacts,
Notes Automation, Calendar Automation, Accessibility, or Full Disk Access grant
is requested. The actual responsible process/app name in a macOS prompt is still
unverified for this embedded local-task route. If attribution or a usage
description prevents access, stop and report it; do not install the upstream
helper, change settings, or switch to a broader route.

The local task can compile this original helper to a temporary executable with
`swiftc -parse-as-library scripts/enroll-family-calendar.swift -o <temporary-path>`
and invoke it after approval. Typechecking passes; it has not been executed.
For the second read, a one-shot Node client uses the repository's existing
`@modelcontextprotocol/sdk` client and `StdioClientTransport`, as demonstrated in
`test/mcp-stdio.test.mjs`, with the approved private `APPLE_PIM_CONFIG_DIR` and no
profile. Its command launches `mcp-server/dist/server.js` in this checkout.
There is no `.codex` registration, credential, port, tunnel, LaunchAgent, or
persistent connector/service step. An approved macOS Calendar grant can persist
after the transient process stops, until the owner revokes it in macOS settings.

The parent/dot can invoke this through its existing **delegated local task on
the connected Mac** by authorizing this experiment and sending the approved
scope here. That proves the delegated task can make a local MCP call. It does
not add `calendar` to the cloud dot's own tool catalog or establish a direct
cloud MCP connection. Direct cloud connection remains a separate approval and
acceptance test, described in [assistant transport](assistant-transport.md).

## Notes checkpoint

Notes **search, get, create, and append are implemented**, wired into the safe
MCP server, and covered by 23 synthetic tests. Exact account/folder IDs, disabled
defaults, separate write opt-in, bounded fixed AppleScript execution, locked/rich
content restrictions, and the existing-grant preflight are implemented.

No live Notes script or permission probe has run. AppleScript runtime behavior,
actual account/folder resolution, shared-note behavior, responsible-process
Automation attribution, and iCloud synchronization remain unverified. A later
Notes test should use one dedicated top-level folder containing an owner-created
synthetic note, with `allowWrites: false`, and read only that note; it requires
separate approval and existing Automation permission to an already running
Notes app. No Notes folder or permission is included in this first experiment.
