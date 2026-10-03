# Scoped foundation validation — 2026-10-03

This records the initial source-only checkpoint. Current regression coverage
is recorded in [prototype validation](prototype-validation.md).

## Fork and local state

- Authenticated personal owner: `Elephruit` (GitHub user ID `445492`).
- Public fork (renamed after this checkpoint): [Elephruit/icloud-mcp-connector](https://github.com/Elephruit/icloud-mcp-connector).
- GitHub reports `fork: true`, `private: false`, parent `omarshahine/apple-pim`.
- Current `origin`: `https://github.com/Elephruit/icloud-mcp-connector.git`.
- `upstream`: `https://github.com/omarshahine/apple-pim.git`; local upstream push URL disabled.
- Feature branch: `feature/scoped-icloud-foundation`; implementation is recorded
  in a local checkpoint commit, with no implementation push. Use
  `git log -1 --format='%H %s'` in this checkout for the exact checkpoint ID.
- Fork main, upstream main, and the local starting commit all resolve to
  `4e155fc5a393c11fab8853565211422d02562a0a`.
- No implementation push, public issue, pull request, or upstream modification.
- Upstream MIT `LICENSE` is byte-identical; SHA-256
  `7e8855c0e6defddc7378a064bd0fd1c4d15deffe55b54dafc9bc25e54c6d24fc`.
  Copyright (c) 2025 Omar Shahine and the full notice remain intact.

## Implemented and reviewed

Explicit exact item/source account scope, disabled defaults, fail-closed
configuration/profile loading, deletion opt-in, and no automatic TCC prompts
in ordinary Calendar/Reminders/Contacts commands. Queries and ID lookups are
anchored to allowed stores; Contacts returns raw scoped cards. Calendar's ID
lookup window and recurring-ID ambiguity limits are described in the README.

The safe MCP surface exposes Calendar, Reminders, Contacts, Notes, and runtime
status. It rejects per-call configuration changes, omits Mail and authorization
tools, and uses only this checkout's release binaries without automatic helper
launch. Nested user content receives the inherited untrusted-data markers.

Notes has original scoped search/get/create/append code with a separate write
opt-in, fixed AppleScript source/argv, bounded output/runtime, and a nonprompting
existing-grant preflight. Locked notes and unsupported append content are denied.
No code was copied from claude-apple-bridges.

Independent source review found and closed global EventKit ID fetches,
malformed-base/profile fallback, deletion-key inconsistencies, nested response
marking gaps, and Notes permission preflight/integration mismatches. The final
review reported no outstanding finding in the reviewed scope. This is source
review plus synthetic validation, not proof of live macOS/iCloud behavior.

## Final validation results

| Check | Result |
| --- | --- |
| Scoped native Swift suites | 252 passed: Calendar 55, Reminders 80, Contacts 36, PIMConfig XCTest 6 and Swift Testing 75 |
| Existing MCP mock/unit tests | 99 passed across 10 files |
| New connector tests | 40 passed: Notes 23, policy/arguments/datamarking 10, built stdio protocol 1, compiled CLI denial 6 |
| Swift release build | Passed, including `notes-access-cli`, with debug symbols disabled inside the workspace sandbox |
| MCP bundle rebuild | Passed; final bundle initialization, tool listing, runtime status, and denied calls passed |
| Whitespace and license checks | Passed; upstream license unchanged |

The six native-denial cases exercise 18 compiled calls using temporary
synthetic configuration. They terminate at the scope/profile/deletion guards
before querying records or requesting grants. The Notes permission probe and
AppleScript were not executed. Dependency install scripts were disabled, Swift
dependency resolution used Apple's ArgumentParser, and build caches stayed
in this checkout (the isolated Notes typecheck used a temporary module cache).
Initial test assertion/compile errors and the release debug
symbol sandbox error were resolved; the final checks above have no failures.

The upstream six helper-process tests were deliberately not run: this scoped
MCP disables that helper route. Mail/OpenClaw integration, agent evals, and
paid model-in-the-loop evals were not run. The release build emits inherited
Mail TLS deprecation warnings; Mail is excluded from the safe MCP interface.

The manual one-shot Family metadata enrollment helper added for the next-step
proposal passes Swift typechecking only. It is not an MCP tool and has not been
executed; its explicit Calendar grant option and live metadata path remain
pending approval.

## Pending acceptance and approvals

1. The smallest proposed next test is [Family calendar metadata enrollment and
   scoped listing](live-test-checkpoint.md), with no events or writes. Other
   domains and event/Notes-content tests require their own explicit scope.
2. Approve any needed macOS grants and validate actual responsible-process
   attribution. Notes requires an already running app and existing Automation
   permission; no grant or app launch occurred here.
3. Test native AppleScript syntax/runtime, shared calendar/Notes behavior,
   readback, and iCloud synchronization within that scope. Notes rich-content
   append is conservative and there is no concurrency transaction.
4. Approve and register the actual assistant route, then prove discovery and a
   synthetic call from that client/dot. See [assistant transport](assistant-transport.md).
   Local stdio alone does not establish cloud-dot reachability. The Secure MCP
   Tunnel option needs separate credentials/registration/runtime approval.

No personal data, private configuration, real test items, privacy changes,
persistent agent, exposed port, or generated connector credentials were used.
