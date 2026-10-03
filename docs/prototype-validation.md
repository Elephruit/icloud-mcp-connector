# Scoped prototype validation

Validated on macOS 27.0 / Apple Silicon. These are source and synthetic
regression results; private live-test identifiers and reports stay outside Git.
These local results were recorded before the first code push. Current remote
checks are available in the fork's [Actions history](https://github.com/Elephruit/icloud-mcp-connector/actions).

| Check | Result |
| --- | --- |
| Calendar, Contacts, Reminders and PIMConfig Swift tests | 269 passed: 192 XCTest and 77 Swift Testing cases |
| Existing MCP unit tests | 100 passed across 10 files |
| Scoped connector, compiled denial, Notes and local plugin tests | 75 passed |
| Swift release and MCP bundle builds | Passed |
| Portable plugin manifests | Official Agent Plugins 1.0 schemas passed |
| Manual native enrollment helper | Typecheck passed; it is never run by regression tests |
| New feature-branch CI workflow | YAML validated locally; remote execution requires a code push |

The compiled denial tests use synthetic configuration and exercise native
Calendar/Contacts/Reminders mutations with writes disabled. They terminate at
the scope/write guard before grants or store queries. Upstream's six helper
process tests are excluded from the MCP unit run because scoped MCP explicitly
disables that route. Model-based evals, Mail and OpenClaw are outside this
validation. No paid model API is required.

Notes regression coverage includes the actual installed scripting dictionary
and data-free Foundation execution. It catches AppleScript's special `result`
variable being overwritten by method returns and the read-only `plaintext`
property colliding with a camel-case variable. Production uses stable payload
and `notePlainText` variables. Exact-ID membership checks inside allowed folders
replace the unsupported `note.container` getter; aligned matching-folder
references prevent cross-folder mistakes. Append rechecks membership and body
stability before its single write.

The local plugin tests cover relocated-package startup with private disabled
synthetic configuration, five-tool discovery, harmless runtime status and denied
data calls. They do not establish host installation, personal-store access,
iCloud synchronization or a direct cloud MCP connection. See
[isolated live acceptance](live-acceptance.md) and
[local plugin setup](local-plugin.md) for the separate approved experiments.
