# Calendar write guard and timezone validation — 2026-10-03

Calendar mutations now require host-owned `allow_writes: true`; missing flags
default false in both native configuration and MCP policy. Deletion still
requires the independent `allow_deletes` gate. Per-call arguments and replacement
profiles cannot retain or grant missing write permission. This was the Calendar
checkpoint; subsequent Reminders/Contacts mutations use the same native write
gate. Notes keeps its separate
`allowWrites` configuration.

Single Calendar creation accepts an explicit IANA `timezone`, validates it
before authorization, and saves it as EventKit timezone metadata. Offset-bearing
start/end timestamps still define the absolute instants. Calendar responses
include the stored timezone identifier. Creation uses an explicit empty alarm
array when none are requested. Save verification accepts the scoped calendar's
exact ID as well as its title and reports `storedCalendarId`.

## Synthetic validation

| Check | Result |
| --- | --- |
| Calendar and PIMConfig Swift suites | 144 passed: Calendar XCTest 61, PIMConfig XCTest 6 and Swift Testing 77 |
| Existing MCP mock/unit tests | 100 passed across 10 files |
| Connector Node tests | 47 passed, including 7 compiled native-denial cases |
| Swift release and MCP bundle builds | Passed |
| Whitespace check | Passed |

The additional compiled Calendar denial case checks create/update/delete/batch
create all fail at the write guard before authorization or store lookup. Its
configuration and arguments contain synthetic identifiers and titles only.
The existing six upstream helper-process tests remain excluded because this
MCP disables that route. The release build retains inherited Mail deprecation
warnings outside the safe MCP interface.

Live personal-data acceptance and payloads belong outside Git under separate
approval. A local EventKit save and bounded readback do not verify remote iCloud
sync. A transient client must check for duplicates before saving, submit at most
once, and reconcile an uncertain result with scoped reads before considering
any future retry. No code push or persistent registration is part of validation.
