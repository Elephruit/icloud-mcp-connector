# Synthetic assistant connection proof

`mcp-server/connection-proof-server.js` is an isolated stdio MCP fixture, bundled
as `mcp-server/dist/connection-proof-server.js`. It is separate from the PIM
server: no private configuration, Calendar/Contacts/Notes/Mail imports, native
commands, credentials or network listeners. Its only tool is `connector-fixture`.

Pass a synthetic ASCII nonce of 1–64 letters, digits, underscores or hyphens.
The result identifies the fixture, echoes that nonce and reports the server
version and process instance. A nonce is correlation data, not a credential;
do not use a personal identifier or secret. Unknown tools/fields and invalid
nonces fail. No personal domain can be enabled through the fixture.

## Local checks

Build using the already reviewed dependency workflow, then run:

```sh
npm run --prefix mcp-server build
node --test test/connection-proof.test.mjs
```

Source and relocated-bundle tests verify initialization, tool discovery, valid
fixture calls, denial cases and a new process instance after restart. They do
not prove actual client, tunnel or cloud-dot availability.

## Approved connection experiment

1. Verify the official client installation instructions and target personal
   Platform organization/workspace. Do not create a key or tunnel implicitly.
2. After setup approval, privately stage the reviewed fixture bundle, license,
   generated `connection-proof-NOTICES.txt`
   and a `package.json` containing `"type": "module"` so the relocated `.js`
   entrypoint works independently of the source package.
   Bind the tunnel's sole `main` stdio command to the absolute Node path and that
   bundle. Never use the PIM server, inherited helper, automatic `npx` download
   or arbitrary HTTP callout target for this experiment.
3. Supply the approved runtime credential privately. Keep it out of source,
   command-line arguments, transcripts and logs. Use Read + Use permissions for
   the runtime; no admin key in the running client.
4. Start one foreground client with health/admin bound to `127.0.0.1:0`. Disable
   optional Cloudflare/Harpoon routes. No autostart or public inbound listener.
5. Create the approved private developer-mode Tunnel app, discover the fixture
   tool and invoke it from the actual intended assistant/dot with a new synthetic
   nonce. Record the route and returned instance; a delegated task is a local
   route, not evidence of the dot's direct MCP catalog.
6. Stop the client and verify explicit unavailability. Restart one client,
   reinitialize and verify a changed fixture process instance. Keep evidence
   private. Report unavailable account/product capability without broadening the
   connection or buying a service.

An actual result cannot be manufactured by a shell-only test or prose answer.
Remote personal-data processing, persistent supervision and any live PIM scope
are later, separately approved steps. See [transport](assistant-transport.md).

## Runtime installation checkpoint

The official Homebrew package was installed and its version/help verified on
2026-10-04: `0.0.14+0f870e50a973fa820d4c409000059e181e8d242b`.
This records the tested formula version, not a recommendation to pin future
installs. Its help confirms stdio, file-referenced runtime credentials and
loopback-only ephemeral health/admin binding. Installation did not start a
tunnel, create a credential, register an app or enable PIM access. Those remain
separate approved setup actions. Keep runtime keys out of chat and tool argument
values; the owner enters them locally through a secure private handoff.
