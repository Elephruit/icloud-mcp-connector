# Assistant transport and connection proof

Reviewed against official OpenAI documentation on 2026-10-03. This is a
configuration and acceptance guide; verify each connection on its actual host.
No MCP registration, tunnel, credential,
network listener, persistent service, or macOS permission grant is created by
this document. Personal-data integration tests need a separately approved scope.

## What this repository provides

`mcp-server/server.js` uses `StdioServerTransport`: its MCP client launches a
local Node process and exchanges messages over its pipes. Shared handlers call
local Swift binaries for EventKit and Contacts. Notes scripting also needs to
run on the Mac. The current server does not provide an HTTP endpoint.

The Mac must be online, and each framework or scripting permission must be
available to the actual process that runs the connector. A cloud Linux copy of
this repository cannot access this Mac's EventKit, Contacts, or Notes. Passing a
stdio test proves only that the local protocol path works.

## Recommended first route: local Codex, then dot delegation

Local Codex supports stdio MCP servers. Its desktop, CLI, and IDE clients share
configuration on the same host. Project configuration is supported in a trusted
project's `.codex/config.toml`; enabling a server and restarting the client are
distinct from cloning this repository. Check the client's `/mcp` view after
setup. Hosted ChatGPT web does not read local Codex configuration, and OpenAI
explicitly cautions that local MCP transports may be unavailable in cloud
execution. [OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp)

After explicit approval to register and launch the server, a private local
configuration could use this shape. Replace placeholders locally, verify the
built binary path, and keep the private PIM configuration outside the checkout:

```toml
[mcp_servers.apple_pim_scoped]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/apple-pim/mcp-server/dist/server.js"]
cwd = "/absolute/path/to/apple-pim"
enabled = false # Set true only during the approved connection test.
enabled_tools = ["calendar", "reminder", "contact"]
default_tools_approval_mode = "prompt"

[mcp_servers.apple_pim_scoped.env]
APPLE_PIM_CONFIG_DIR = "/absolute/path/to/private-pim-config"
APPLE_PIM_PROFILE = "assistant"
```

These domain tools combine read and write actions. All native domain mutations
require host-owned `allow_writes: true` (default false), and deletion separately
requires `allow_deletes`. Retain per-call approval;
client tool toggles cannot enforce individual calendar/list/account or action
boundaries. The connector's fail-closed configuration is the enforcement layer.
Verify that the launch resolves this checkout's reviewed Swift binaries rather
than an older installation. The generated bundle must include the reviewed
changes. Add Notes to the enabled tool list only after its adapter is reviewed.
For Notes, omit `APPLE_PIM_PROFILE` and configure the desired scopes in the base
`config.json`, or use a separate registration without a profile. Notes currently
rejects profiles before it starts any native process.

A dot has a separate cloud computer. OpenAI documents that a connected personal
computer permits the dot to create local Work/Codex tasks and continue local
Codex tasks. Its computer connection is separate from Codex's connection and
Work Sync. Keep the Mac online with the desktop app open; an offline computer
cannot perform these steps. Supported installed plugins are another separate
connection. [Dots computer and app documentation](https://learn.chatgpt.com/docs/dots/computers-and-apps)

The lowest-infrastructure first experiment is therefore a dot-delegated local
Codex task using the scoped local connector. This is an architectural inference,
not proof that the dot's own tool catalog gains the stdio tools. Test from the
actual dot conversation and record which local task executed the call. Do not
describe delegation as a direct cloud MCP connection.

## Direct cloud MCP prototype: Secure MCP Tunnel

OpenAI now documents Secure MCP Tunnel for local/private stdio or HTTP servers.
`tunnel-client` opens outbound HTTPS to OpenAI and forwards MCP requests locally;
no public inbound listener is required. This is a supported candidate for this
stdio server, subject to account access and actual product verification.

It requires a Platform tunnel identifier, runtime API key, and appropriate
organization/workspace associations and tunnel permissions. ChatGPT connection
uses a developer-mode app with **Tunnel** selected. The client must remain
running. The tunnel is for private connections and developer testing; it does
not support public plugin distribution. The fetched documentation does not
establish a price, so do not call this route free.
[Secure MCP Tunnel documentation](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

Before trying it, obtain approval for the runtime client, credential creation or
use, remote tool/data processing, connection registration, and its lifetime.
Begin with a manually started process and synthetic fixtures. Installing a
LaunchAgent or another persistent service is a separate decision. Do not put a
key, tunnel identity, user-specific allowlists, or private profile in Git.

ChatGPT's connection guide explicitly provides a Tunnel option, discovery of the
server's tools, and checks for workspace association and client health. Verify
those checks in the target account before relying on availability.
[ChatGPT connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt#add-the-mcp-server)

Dots can use supported installed account plugins, but that general capability
does not prove this custom tunnel app is available to the target dot. Discover
and invoke a harmless synthetic tool from that actual dot as the acceptance
test. If it is unavailable there, retain the documented local-task route and
report the product/account limitation.

## Alternative: authenticated remote HTTPS adapter

If tunnel support is unavailable, ChatGPT developer mode supports remote MCP
via SSE or streaming HTTP. OAuth is supported, and write actions normally
require confirmation. A remotely reachable adapter/gateway would have to reach
the Mac and preserve its scope and permission checks. A localhost HTTP wrapper
alone does not create cloud reachability.
[ChatGPT developer mode documentation](https://developers.openai.com/api/docs/guides/developer-mode)

Design and approval for deployment, authentication, ingress or a separate
tunnel, and ongoing operation come before this route. No raw stdio-to-public
proxy is part of the current prototype. A hosted API application would also
introduce separate API usage and operational costs; check them before choosing
it. [OpenAI remote MCP guide](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)

## Connection acceptance checks

1. **Local protocol:** MCP initialization and `tools/list` succeed with the
   reviewed build. A synthetic fixture call returns the expected marker. Record
   the transport and build revision; initialization alone is insufficient.
2. **Scope enforcement:** synthetic fixtures verify missing or malformed
   configuration, unapproved calendar/list/account identifiers, and delete
   actions fail closed. A profile error cannot broaden access. Test both the
   tool path and direct CLI path.
3. **Actual assistant path:** the intended local client, delegated local task,
   or cloud dot discovers and calls that fixture tool. Record the caller and
   execution host. A shell-only test is not this check.
4. **Failure behavior:** stopping the approved local process or disconnecting
   the Mac returns an actionable failure. There is no fallback to unscoped
   data, fabricated success, or a different installed binary.
5. **Approved macOS test:** only after approval, identify the exact shared
   calendar, reminder list, contact container, and Notes account/folder in scope.
   Resolve ambiguous names deliberately. Agree on the permitted read range and
   any synthetic write target before requesting permissions or reading data.
6. **Write proof:** only when separately authorized, review a single synthetic
   write payload, execute it in the agreed test scope, and read back its result.
   Deletion stays disabled; any cleanup needing deletion requires authorization.

Until checks 3 and 5 pass for the intended assistant route, report the connector
as a local prototype with connection and personal-data validation pending.
