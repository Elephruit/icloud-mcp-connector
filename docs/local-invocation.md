# Local installed connector health check

The connected Mac task can launch the reviewed installed stdio package and
return a verified result to its parent conversation. This route needs the Mac
and local task available. It does not require a tunnel, network listener,
runtime key or new permission grant. It is task delegation; it does not add the
connector to a cloud dot's direct tool catalog.

Use the reusable health-only check from the source checkout:

```sh
node scripts/check-local-connector.mjs \
  --package-root '/absolute/installed/icloud-mcp-connector/0.2.1' \
  --config-dir '/absolute/private/config' \
  --restart
```

Both locations must be explicit. The helper validates owner-controlled package
paths and the reviewed 0.2.1 launcher/server/library hashes from
[source commit 33729a5](https://github.com/Elephruit/icloud-mcp-connector/commit/33729a52a963b3ee692bf7661f221804701cf530).
The version alone is insufficient: a same-version package with different
reviewed launcher/server/library bytes also fails verification. Unknown versions or
changed artifacts fail before execution and need a new source review. Config
must be an owner-owned 0700 directory outside Git and outside the package, with
a regular, single-link, owner-owned 0600 `config.json`. The helper inspects only
its metadata; the reviewed launcher loads the host configuration at startup.
No configuration is created or modified, and no profile or per-call override is
selected.

The helper loads the source checkout's installed MCP SDK, starts its own Node
child at the installed launcher, initializes it, lists the six known tools and
calls only `apple-pim` `status` and `schema`. Those runtime actions return before
PIM configuration dispatch or native commands. Output contains only fixed
health facts, known tool names and process IDs. It discards bounded stderr and
withholds raw responses, private paths, configuration and error diagnostics.
Use a supported modern Node runtime and install the reviewed source SDK first;
Node syntax/loader failure before this script runs cannot be caught by it.

Each phase has a ten-second limit. The overall thirty-second budget reserves
cleanup time, including the SDK's EOF/termination sequence. Successful output
requires observed child closure. `--restart` starts a second fresh client only
after the first closes, and requires different child process IDs. It does not
restart ChatGPT, kill unrelated servers, interrupt the Mac or change persistent
plugin settings. A failed cleanup never produces a success result.

This proves the selected installed package's local invocation and process
restart. It does not prove native grants, personal-data access, iCloud sync,
sleep/wake recovery or availability in another assistant's tool catalog.
Actual PIM requests still require their approved exact scope and existing grants.
Keep test logs and actual scope identifiers outside Git.

The existing temporary Contacts acceptance app has a separate app identity and
grant. It can support only its already-approved test route; the installed
plugin does not select it automatically. The permanent Contacts companion needs
its approved installation, private pinned bridge, own permission and exact-record
acceptance described in [Contacts setup](contacts-companion.md).
