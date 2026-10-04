# Local Mac plugin

This source package adds **iCloud MCP Connector** (`icloud-mcp-connector`, version
`0.2.1`) to the scoped fork. It contains portable `plugin.json` / `mcp.json`, a
matching Codex compatibility manifest, a scoped workflow skill and a guarded
Node launcher. The upstream Claude/OpenClaw version `3.18.0` and Omar Shahine's
MIT copyright remain unchanged; these are separate package identities.

Upstream [apple-pim](https://github.com/omarshahine/apple-pim) already supplied
stdio MCP. This fork adds safe account/resource scoping, Notes, read-only Mail and the
Codex plugin package. It aims to support dots through a connected Mac; direct
cloud MCP access remains in development. The renamed project is
[icloud-mcp-connector](https://github.com/Elephruit/icloud-mcp-connector).

The launcher loads the actual bundled `mcp-server/dist/server.js` in the same
process. That server uses this package's `swift/.build/release/` binaries. It
does not install binaries, launch the inherited helper app, start a daemon,
listen on a port, request privacy permissions or create configuration. Missing
builds or private configuration stop startup.

The source package is tested with a temporary stdio client, disabled synthetic
configuration, tool discovery, runtime status and denied calls. Installation
and permissions belong to each owner's host. Verify the installed package and
an actual host invocation separately; source protocol checks do not establish
live access or cloud availability.

## Build and stage before installation

Review the checkout and dependency manifests first. On the target Mac, build
the native tools and the bundled Node server using the repository's documented
build commands. Do not use `setup.sh`: the upstream script can install binaries
and a helper app. The direct launcher instead relies on the actual host's
existing framework grants. A separate app's Contacts grant does not prove that
the direct host process has Contacts access.

An installed local plugin runs from a cached package copy. Source Git does not
contain the ignored Swift build outputs, and installing a source-only checkout
cannot supply them. Stage a self-contained directory named `icloud-mcp-connector`
**before** registering it. Copy only these reviewed files:

- `plugin.json`, `mcp.json`, `.codex-plugin/plugin.json` and `LICENSE`.
- `scripts/plugin-launcher.mjs` and `mcp-server/dist/server.js`.
- `lib/scoped-mail-config.js`, which the launcher validates before startup.
- `skills/icloud-mcp-connector/`.
- The actual executable files `calendar-cli`, `reminder-cli`, `contacts-cli` and
  `notes-access-cli` and `mail-access-cli` into `swift/.build/release/` in the staged package. Copy the
  files themselves rather than the SwiftPM directory symlink.
- `examples/scoped-config.example.json` and the setup, Contacts companion, Notes, Mail and transport docs
  referenced by the skill under `docs/`.

Before copying native executables into a distributable package, use the reviewed
staging helper with a new canonical private parent outside Git:

```sh
node scripts/stage-native-tools.mjs --output '/absolute/private/staging/native-tools'
```

It copies only the five fixed release executables, strips debug symbols from the
copies, rejects known private build/cache paths before and after signing, and
verifies their ad-hoc signatures. Use the resulting copies and retain their
`LICENSE`, `ATTRIBUTION.txt` and `BUILD.json` alongside the staged package.
Source binaries, installed caches and private configuration are not changed.
Known-path scanning is not a general detector of personal content. Ad-hoc
updates can change permission attribution and require separate installed-host
acceptance; staging does not establish grant continuity or notarization.

The optional Contacts companion is a separate native bundle; it is not copied
into the plugin cache or installed by the launcher. Its reviewed build and
explicit private transport selection are described in
[Contacts companion setup](contacts-companion.md).

Keep the same relative paths. Exclude `.git`, dependency directories, Swift
caches, personal/private configuration, logs, test outputs and unrelated
upstream Mail/OpenClaw integration files. Build on the recipient Mac or deliver
reviewed binaries for its architecture and compatible macOS version. An x86
build and an Apple Silicon build are not interchangeable. Do not edit the
host's plugin cache to repair a source package; update the staged source and
use the host's refresh/reinstall flow.

## Private configuration

Portable MCP passes `APPLE_PIM_CONFIG_DIR` as
`${PLUGIN_DATA}/private-config`. `PLUGIN_DATA` is the host's dedicated persistent
plugin data directory. The package has no private scopes or credentials and
does not depend on the desktop app inheriting a shell's custom environment.
[Agent Plugins runtime rules](https://agent-plugins.org/client-implementers/mcp-runtime)

During an approved setup, locate the host-assigned `PLUGIN_DATA` path and copy
`examples/scoped-config.example.json` there as `private-config/config.json`.
Keep the directory owner-only (`0700`) and file owner-only (`0600`), outside the
source/staged package and Git. The launcher checks these properties and rejects
missing, malformed, oversized or broad enabled scopes. It does not create or
repair the file. A manual temporary client may select a different absolute
private directory for synthetic validation.

Every connection and write flag in the example is false, and every ID list is
empty. A data call will be denied. After the user approves a specific account
and calendar/list/container/folder, resolve its exact identifiers through the
approved setup path and enter them only in that private file. Use `enabled:
true` and exact account/resource arrays; native domains also require `mode:
"allowlist"`. Contacts uses the same `CNContainer.identifier` in `items` and
`accounts`. Writes require `allow_writes: true` for native domains or
`allowWrites: true` for Notes. Deletion requires a separate `allow_deletes`
opt-in and approved cleanup; Notes does not implement deletion. Mail is strictly
read-only and requires `allowWrites: false`, exact iCloud account IDs and exact
enrolled mailbox records; see [Mail setup](mail-adapter.md).

This plugin uses base configuration only. Leave `APPLE_PIM_PROFILE` unset. A
nonempty profile makes the launcher fail, preventing an inherited native profile
from silently selecting a different scope while Notes uses the base file.

## Approved installation and first call

The repository includes an **unregistered example** catalog at
`examples/local-plugin-marketplace.example.json`. It points to
`./plugins/icloud-mcp-connector` relative to a future marketplace root. After
approval, put the staged package at that location and place the catalog at the
marketplace root's `.agents/plugins/marketplace.json`. The entry is available
for user installation; it does not install the plugin by default.

The ChatGPT desktop app's bundled CLI was checked on
`0.159.0-alpha.12.1`. A `codex` found on the shell PATH can be a different,
older installation. Use the matching desktop binary for host setup:

```sh
/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex plugin marketplace add /absolute/path/to/marketplace-root
/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex plugin add icloud-mcp-connector@icloud-mcp-connector-local
```

These commands persist the package and can cause an MCP process to start in
future supported local sessions. Review and approve that scope before executing
them. Preserve unrelated user configuration. Initially keep the private example
disabled and restrict the plugin to runtime status/schema with per-call approval:

```toml
[plugins."icloud-mcp-connector@icloud-mcp-connector-local".mcp_servers."icloud-mcp-connector"]
enabled = true
default_tools_approval_mode = "prompt"
enabled_tools = ["apple-pim"]
```

`plugin list --json` verifies installation metadata; `mcp list --json` verifies
the resolved command, package root and `PLUGIN_DATA`. Neither invokes the tool.
Check the actual host's MCP view and call `apple-pim` with `action: "status"`.
The server implements six tools: `apple-pim`, `calendar`, `reminder`, `contact`,
`notes` and `mail`; the initial client policy exposes only `apple-pim`. Enabling domain
tools and adding private scopes require the owner's approved targets. Keep tool
approval at `prompt`, since each domain tool combines reads and writes. Status
does not prove personal-data grants, iCloud sync or direct cloud connectivity.

OpenAI documents portable manifests, compatibility overlays, local marketplaces
and plugin-specific MCP approval settings. Host surfaces may differ. Confirm
actual installed startup and a harmless call before reporting installation as
working. [OpenAI plugin packaging guide](https://developers.openai.com/plugins/build/plugins)

## Permission and live-test flow

Normal scoped MCP calls check existing grants without prompting. If a grant is
missing, stop and explain the exact setup action before requesting approval:

| Connection | Possible macOS prompt | Connector scope and first test |
| --- | --- | --- |
| Calendar | Full Calendar Access for the responsible host process | Exact approved calendar/source; narrow metadata or date range |
| Reminders | Full Reminders Access for the responsible host process | Exact approved list/source; clearly labeled synthetic record |
| Contacts | Contacts Access for the responsible host process | Exact approved container; clearly labeled synthetic contact |
| Notes | Automation control of Notes by the responsible host process | Exact approved account and isolated folder; synthetic plain-text note |
| Mail | Automation control of Mail by the responsible host process | Approved iCloud account metadata, then exact mailbox paths and bounded read-only scope |

macOS grants are broader than the connector allowlists and can persist. The
prompt's app identity depends on the actual responsible host process; report
what the prompt shows rather than assuming it names this package. Notes and Mail must
already be running. Their preflights never grant Automation access. Permission
requests are a separate approved local setup step, not a tool-call recovery.

Contacts acceptance under a temporary app tests that app's process chain only.
It does not transfer permission to a separately launched plugin under
ChatGPT/Codex/Node. For an approved app-identity test, use a native Mach-O main
executable and an explicit Contacts usage description; shell-script main
executables can break macOS privacy attribution. The optional native runtime
companion has its own installation and permission decision; it is not an
automatic recovery step. Its tested basic interface and the remaining
installed-plugin live acceptance are documented in
[Contacts companion setup](contacts-companion.md).
[Apple's native-executable and responsible-code guidance](https://developer.apple.com/forums/thread/678819)

For each live write, preview the payload, check for a duplicate only within the
approved scope, create/update one synthetic artifact and read it back by exact
identity. Leave artifacts clearly labeled unless the user approves their
deletion. After uncertain writes, verify before retrying. Report local readback
and remote synchronization separately. Private scope and readback evidence must
stay outside the public package.

## Sharing and cloud limits

Other Mac users can build and stage this source package, then use their own
private scopes and permission grants. The package requires a running local Mac;
it does not contain user data or require a hosted server for local operation.
Sharing a plugin or installing it on ChatGPT web/mobile does not make the Mac's
stdio process or privacy grants available there. The existing delegated local
task route can invoke this connector on the connected Mac; direct cloud MCP is
separate work. See [transport routes and approvals](assistant-transport.md).

Local installation creates persistent registration only on the approved host. It
does not upload a plugin to an account, deploy a service or submit to the public
directory. A public directory release has separate endpoint/support and review
requirements; the source package supports local authoring and reviewed
distribution.
