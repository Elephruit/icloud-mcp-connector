# Local Mac plugin

This source package adds **iCloud MCP Connector** (`icloud-mcp-connector`, version
`0.1.0`) to the scoped fork. It contains portable `plugin.json` / `mcp.json`, a
matching Codex compatibility manifest, a scoped workflow skill and a guarded
Node launcher. The upstream Claude/OpenClaw version `3.18.0` and Omar Shahine's
MIT copyright remain unchanged; these are separate package identities.

Upstream [apple-pim](https://github.com/omarshahine/apple-pim) already supplied
stdio MCP. This fork adds safe account/resource scoping, Notes tools and the
Codex plugin package. It aims to support dots through a connected Mac; direct
cloud MCP access remains in development. The renamed project is
[icloud-mcp-connector](https://github.com/Elephruit/icloud-mcp-connector).

The launcher loads the actual bundled `mcp-server/dist/server.js` in the same
process. That server uses this package's `swift/.build/release/` binaries. It
does not install binaries, launch the inherited helper app, start a daemon,
listen on a port, request privacy permissions or create configuration. Missing
builds or private configuration stop startup.

The source package has been tested with a temporary stdio client, disabled
synthetic configuration, tool discovery, runtime status and denied calls. It
has **not** been installed or enabled in the host plugin catalog. Those protocol
checks do not prove installation, live access or cloud availability.

## Build and stage before installation

Review the checkout and dependency manifests first. On the target Mac, build
the native tools and the bundled Node server using the repository's documented
build commands. Do not use `setup.sh`: the upstream script can install binaries
and a helper app, which this package does not need.

An installed local plugin runs from a cached package copy. Source Git does not
contain the ignored Swift build outputs, and installing a source-only checkout
cannot supply them. Stage a self-contained directory named `icloud-mcp-connector`
**before** registering it. Copy only these reviewed files:

- `plugin.json`, `mcp.json`, `.codex-plugin/plugin.json` and `LICENSE`.
- `scripts/plugin-launcher.mjs` and `mcp-server/dist/server.js`.
- `skills/icloud-mcp-connector/`.
- The actual executable files `calendar-cli`, `reminder-cli`, `contacts-cli` and
  `notes-access-cli` into `swift/.build/release/` in the staged package. Copy the
  files themselves rather than the SwiftPM directory symlink.
- `examples/scoped-config.example.json` and the setup, Notes and transport docs
  referenced by the skill under `docs/`.

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
opt-in and approved cleanup; Notes does not implement deletion.

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

The installed CLI's read-only help was checked on Codex `0.155.1`. It supports:

```sh
codex plugin marketplace add /absolute/path/to/marketplace-root
codex plugin add icloud-mcp-connector@icloud-mcp-connector-local
```

These are setup instructions, not commands run for this checkpoint. Installation
persists the package and can cause an MCP process to start in future supported
local sessions. Review and approve that scope before executing them. Then check
the host's plugin/MCP view and call `apple-pim` with `action: "status"`. Confirm
the expected five tools: `apple-pim`, `calendar`, `reminder`, `contact`, `notes`.
Keep tool approval set to `prompt`; each domain tool combines reads and writes.
Do not treat successful status as evidence that any personal data is enabled.

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

macOS grants are broader than the connector allowlists and can persist. The
prompt's app identity depends on the actual responsible host process; report
what the prompt shows rather than assuming it names this package. Notes must
already be running. Its preflight never grants Automation access. Permission
requests are a separate approved local setup step, not a tool-call recovery.

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

This checkpoint does not upload a plugin to an account, register persistent
access, deploy a service or submit to the public directory. A public directory
release has separate endpoint/support and review requirements; the source
package is for local authoring and later reviewed distribution.
