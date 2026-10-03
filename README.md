# iCloud MCP Connector

A macOS connector for scoped iCloud Calendar (including an approved shared
Family calendar), Reminders, Contacts, and Notes, designed for Codex and dots.
Fork of
[Omar Shahine's apple-pim](https://github.com/omarshahine/apple-pim), under the
[MIT license](LICENSE). Copyright (c) 2025 Omar Shahine is preserved unchanged.
The [upstream README](docs/upstream-readme.md) is retained for historical
architecture context; its broad defaults and installation instructions do not
describe this prototype's approved workflow.

Upstream already provided local stdio MCP tools. This fork extends that
foundation with explicit account/resource scopes, write opt-ins, Notes support
and a Codex plugin package targeted at making these tools useful to dots.
Direct dot connectivity remains in development: a supported, approved Mac-side
execution route is required.

## Current boundaries

- MCP runs over local stdio only. Cloning, building, or passing stdio tests does
  not connect a cloud dot. See [assistant transport](docs/assistant-transport.md).
- Calendar, Reminders, and Contacts are disabled until explicit stable item
  **and** source/account IDs are configured. Missing/malformed configuration,
  missing profiles, broad legacy modes, and incomplete scopes deny access.
- Calendar, Reminders and Contacts writes require host-owned `allow_writes: true`, defaulting to false.
  Deletion is also disabled by default. Explicit `allow_deletes: true` is the
  host-owned opt-in; per-call configuration/profile overrides are rejected.
- Normal native commands check existing macOS authorization without prompting.
  Explicit CLI `authorize` commands exist, but the scoped MCP does not expose
  permission requests or unscoped discovery.
- The MCP uses only this checkout's release binaries. It never falls back to
  an older installation or launches the upstream helper app automatically.
- Notes supports scoped search/get/create/append. Writes require
  `allowWrites: true`; Notes has no deletion action. It rejects profiles for now.
- Mail is excluded from the scoped MCP surface. The inherited standalone Mail
  CLI and OpenClaw adapter are outside this prototype's validated interface.

Native domain scopes enable reads; their mutations additionally require
`allow_writes`. Keep per-call client approval enabled. Notes has a separate
write opt-in. This repository grants no scope or macOS permission. Automated
regression tests use synthetic fixtures; separately approved live acceptance
results and personal content stay outside Git.

## Private configuration

Set `APPLE_PIM_CONFIG_DIR` to an absolute, private directory **outside Git**
containing `config.json`. Direct Swift CLIs also support their inherited private
default config path, with the same disabled defaults; MCP requires the explicit
environment setting. Do not put actual account/resource IDs in this checkout.

Synthetic example (these invented IDs authorize no real resources):

```json
{
  "calendars": {
    "enabled": true,
    "mode": "allowlist",
    "items": ["synthetic-family-calendar-id"],
    "accounts": ["synthetic-icloud-source-id"],
    "allow_writes": false,
    "allow_deletes": false
  },
  "reminders": { "enabled": false },
  "contacts": { "enabled": false },
  "mail": { "enabled": false },
  "notes": {
    "enabled": false,
    "accounts": [],
    "folders": [],
    "allowWrites": false
  },
  "default_calendar": "synthetic-family-calendar-id"
}
```

Calendar/list `items` are exact `calendarIdentifier` values; `accounts` are
exact `EKSource.sourceIdentifier` values. A display name such as "Family" never
grants access. A name selector may resolve **within already authorized IDs**,
and duplicate names are rejected. Creation requires an explicit target or a
configured allowed default ID; it never uses the system default implicitly.

Contacts uses exact `CNContainer.identifier` values in both `items` and
`accounts`. Create requires an explicit `container`. Reads return raw cards
within allowed containers, avoiding unified cross-account data. Native Contacts
save errors are returned without an AppleScript recovery or implicit prompt.
Contact ID lookups first inspect identifier-only membership in allowed containers
and then fetch only the matching raw card's details; linked unified IDs are denied.

Calendar ID lookup uses queries limited to allowed calendars, covering 366 days
before and after now by default. Set `from`/`to` for get/update/delete when
needed (maximum four-year span); narrow that range for ambiguous recurring IDs.
Reminders ID lookup queries only allowed lists. Neither fetches arbitrary IDs
from the entire store before checking permission.

Calendar create accepts an explicit `timezone` IANA identifier in addition to
offset-bearing timestamps. It stores that timezone on the event, rejects invalid
identifiers before access, and adds alarms only when explicitly supplied. A
successful save is local EventKit evidence; it does not confirm remote iCloud
synchronization. After an uncertain write outcome, check the scoped date range
for a duplicate before any retry.

Obtain approval for an exact test scope before resolving actual IDs, reading
personal stores, requesting macOS permissions, or creating test items. The
regression suite uses synthetic fixtures only. Do not run `setup.sh`, install
a LaunchAgent, or enable a tunnel as part of ordinary testing.

The initial live-test proposal was [Family calendar metadata only](docs/live-test-checkpoint.md).
Its manual one-shot enrollment helper is outside MCP and must not be executed
without explicit scope/permission approval. The isolated Contacts, Reminders
and Notes test flow is documented in [live acceptance](docs/live-acceptance.md).

## Local Mac plugin

The source includes a portable `icloud-mcp-connector` plugin package with a guarded
stdio launcher, disabled configuration example and Codex compatibility manifest.
See [local plugin setup](docs/local-plugin.md) for staging reviewed binaries,
private host configuration and the separately approved installation flow.
The package is not installed, and local protocol checks do not establish a
direct ChatGPT cloud connection.

## Local validation

Dependency install scripts should remain disabled during source review:

```sh
npm install --ignore-scripts --no-audit --no-fund
npm install --prefix mcp-server --ignore-scripts --no-audit --no-fund
node --test test/*.test.mjs
npm run --prefix mcp-server test -- --exclude test/cli-runner-helper-proc.test.js
npm run --prefix mcp-server build
```

`test/` checks the scoped policy and Notes through fake runners; the protocol
smoke test uses the built stdio server with synthetic configuration and calls
only runtime status and denied requests. Native Swift tests use parsing,
in-memory objects, and synthetic identifiers; they do not query personal stores.
Build with `swift build -c release` and run the relevant Swift tests in the
approved execution environment. No model-in-the-loop eval or paid API is needed.
See [prototype validation](docs/prototype-validation.md) for the tested suites
and their limits.

Notes was written independently. The MIT-licensed
[claude-apple-bridges](https://github.com/more-io/claude-apple-bridges) was reviewed
as a reference; none of its code was copied or executed.
