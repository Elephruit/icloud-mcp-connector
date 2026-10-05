# iCloud MCP Connector

A macOS connector for scoped iCloud Calendar (including an approved shared
Family calendar), Reminders, Contacts, Notes, and read-only Mail, designed for
Codex and dots.
Fork of
[Omar Shahine's apple-pim](https://github.com/omarshahine/apple-pim), under the
[MIT license](LICENSE). Copyright (c) 2025 Omar Shahine is preserved unchanged.
The [upstream README](docs/upstream-readme.md) is retained for historical
architecture context; its broad defaults and installation instructions do not
describe this prototype's approved workflow.

Upstream already provided local stdio MCP tools. This fork extends that
foundation with explicit account/resource scopes, write opt-ins, Notes support,
bounded read-only Mail and a local Codex plugin package. Approved tasks on a
connected Mac can invoke the reviewed local stdio package or scoped native CLIs
and return results to a coordinating assistant.
The local connector and scope hardening require no external API key or inference
API calls. Delegation does not add these tools to a cloud dot's direct catalog.

The [installed local health check](docs/local-invocation.md) verifies data-free
stdio discovery, runtime status/schema and bounded process restart. The
[product roadmap](docs/product-roadmap.md) covers remaining installed-domain
acceptance and stable app identity. The separate [Mail send foundation](docs/mail-send-foundation.md)
and [iMessage preview](docs/imessage-preview.md) are source-only; native sending
and installed MCP exposure remain disabled.

## Verified local acceptance

Separately approved checks on one Mac established the following. These results
are distinct from the synthetic regression suite and apply only to the tested
scope and process identity.

| Route or domain | Verified behavior | Remaining limit |
| --- | --- | --- |
| Installed MCP | A script-created local stdio client discovered tools, called runtime status/schema and restarted a fresh process with verified cleanup | Check the intended client's tool catalog and approval filters separately; this does not add direct cloud-dot tools |
| Calendar | Scoped live iCloud reads, including an approved shared Family calendar; one approved event create/update with bounded readback through the native EventKit route | This does not establish all installed MCP write paths or remote iCloud synchronization |
| Mail | Bounded live summary and body reads through the installed MCP package | Read-only; pagination and RFC-linked threads do not establish complete mailbox or conversation coverage |
| Notes | Create, search, read and append in an isolated approved plain-text test folder, with independent readback | General personal Notes access and installed-host acceptance remain separate |
| Reminders | Read, create and update in an isolated synthetic test list, with independent readback | Existing personal-list reads still await explicit local consent |
| Contacts | Synthetic create/get/update under a temporary native app identity | That grant does not transfer to the plugin; permanent companion installation, its own grant and installed acceptance remain pending |

Private scope identifiers, personal content and detailed acceptance receipts stay
outside Git. These checks do not grant general read/write access, prove remote
sync or establish unattended operation. A connected, available Mac and approved
local task remain necessary.

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
- The MCP uses only the selected reviewed package's bundled release binaries. It never falls back to
  an older installation or launches the upstream helper app automatically.
- Notes supports scoped search/get/create/append. Writes require
  `allowWrites: true`; Notes has no deletion action. It rejects profiles for now.
- Mail supports scoped list/search/get/thread reads through an original fixed
  Mail.app JXA adapter. Exact iCloud account and mailbox paths must be enrolled
  privately; Mail must already be running with an existing Automation grant.
  There are no sends, deletions, read-state mutation commands or attachment exports.
  The inherited standalone Mail CLI and OpenClaw adapter remain outside this
  interface. See [Mail scope and limits](docs/mail-adapter.md).

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

Mail uses an exact native iCloud account ID plus a key derived from that account
and an exact ordered mailbox path. Its manual enrollment helper reads metadata
only after separate approval and saves selectors outside Git. Mailbox keys are
connector selectors, not native stable IDs; renaming a mailbox requires renewed
enrollment. List/search pages inspect at most 50 candidates within the first 200
candidates of a maximum 31-day window. Follow the returned `nextOffset`, keep a
total review budget and deduplicate IDs; mailbox changes can repeat or skip
items between pages. Thread reads follow RFC References/In-Reply-To links in approved
mailboxes and disclose incomplete coverage. They do not promise a complete
historical conversation. Mail stays disabled until its private scope is approved.
Source list/search pages can return completed metadata when their cooperative
deadline expires, with explicit partial coverage and validated continuation
positions. Native and operation failures retain fixed, redacted error codes; see
[Mail read contracts](docs/mail-adapter.md#read-contracts-and-limits). An installed
package needs a separately reviewed refresh and live check for these changes.

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

The source includes a portable `icloud-mcp-connector` package with a guarded
stdio launcher, disabled configuration example and Codex compatibility manifest.
See [local plugin setup](docs/local-plugin.md) for the complete reviewed flow:

1. Build the reviewed checkout on the target Mac and stage a self-contained
   package with the bundled MCP server, all five required native executables
   and license/attribution files. Git excludes native build outputs; a
   source-only clone cannot supply them to the plugin cache.
2. After approval for persistent local setup, register the staged marketplace
   and install the plugin with the CLI matching the desktop host:

   ```sh
   /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex plugin marketplace add /absolute/path/to/marketplace-root
   /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex plugin add icloud-mcp-connector@icloud-mcp-connector-local
   ```

3. During approved setup, place the disabled example at
   `${PLUGIN_DATA}/private-config/config.json`, outside Git and the package,
   with directory mode `0700` and file mode `0600`. Enroll only approved exact
   scopes, keep per-call approval enabled and leave `APPLE_PIM_PROFILE` unset.
   macOS grants must belong to the actual invoking process.
4. Run the [installed health check](docs/local-invocation.md), then verify the
   intended client's MCP catalog and harmless runtime call. Domain reads and
   writes require separate approved acceptance; runtime status proves neither.

For a reviewed update, replace the staged marketplace source and use the same
`plugin add` flow, preserve existing settings and verify the selected artifacts.
Do not repair the cached package by hand. Each owner needs their own local setup,
private scopes and permissions; this is not a public-directory release.

The optional [native Contacts companion](docs/contacts-companion.md) provides a
separate app identity for basic get/create/update calls. It needs its own
approved installation, private pinned bridge, grant and exact-record acceptance.
Building it or granting a temporary test app does not complete that setup.

The Mac must be available for delegated local tasks. Installing a local plugin
does not provide direct web/mobile access to its stdio process. The isolated
[synthetic connection probe](docs/connection-proof.md) and optional
[transport routes](docs/assistant-transport.md) remain development references;
the verified local route does not require a tunnel, exposed port or API key.

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

Fork pushes to `main` run **Scoped Connector / Synthetic Mac Connector** for
the scoped Swift tests, release builds, MCP tests and synthetic Node suite.
Inherited upstream-only workflows are skipped in this fork; their skipped
jobs are not validation evidence.

Notes was written independently. The MIT-licensed
[claude-apple-bridges](https://github.com/more-io/claude-apple-bridges) was reviewed
as a reference; none of its code was copied or executed.
