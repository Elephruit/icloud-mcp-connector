# Scoped Notes prototype

This fork adds an original local AppleScript adapter for four actions: `search`,
`get`, `create`, and `append`. It has no delete, move, export, attachment, UI,
account discovery, or folder discovery operation. It does not use the Notes
database. Existing upstream copyright and MIT attribution remain in place.

The adapter is disabled until a local, explicit `APPLE_PIM_CONFIG_DIR/config.json`
contains an enabled Notes section and both exact ID allowlists. Names and system
defaults do not select targets. No configuration is bundled with the repository;
keep personal IDs, note content, and real configuration outside it.

```json
{
  "notes": {
    "enabled": false,
    "accounts": [],
    "folders": [],
    "allowWrites": false
  }
}
```

For an approved test, the owner must first obtain account and folder IDs locally,
select a dedicated synthetic test folder, then populate both allowlists and set
`enabled` to `true`. The production adapter provides no broad discovery call.
The specified folder must appear in the allowed account's direct AppleScript
folder collection; nested folders are not traversed. An unresolved or ambiguous
scope fails closed. Profiles and per-call configuration overrides are unsupported
for Notes and fail before spawning. Configuration is reloaded on every call.

`search` requires a nonempty `query`, returns only ID/title/scope metadata, skips
password-protected notes, and accepts `limit` from 1 to 50 (default 20). Scanning
more than 500 notes fails and asks for a narrower scope. `get` requires a note
`id` and looks it up only inside allowed folders. It returns plaintext up to
32,768 characters with an explicit `truncated` flag; attachment contents and
URLs are omitted. Read responses include `attachmentsOmitted` when appropriate.
Before reading title/body/plaintext or appending, the script resolves the exact
note ID again inside that particular allowed folder and requires one match.
It preserves the matched folder reference across multi-folder lookups. This
avoids relying on the Notes `note.container` getter, which failed in the isolated
local test even though the installed scripting dictionary exposes it.

`create` and `append` require `allowWrites: true` plus an explicit allowed
`accountId` and `folderId`; `create` takes `title` and optional `text`, and
`append` takes `id` and `text`. Caller text is escaped as HTML before writing.
Append refuses locked notes, notes with attachments, and rich markup or
attributes outside the minimal plain text HTML subset. It can fail on a note
that looks plain in the UI. This conservative behavior avoids silently flattening
unsupported content. There is no API-level compare-and-swap: do not append while
someone else is editing the note. Sync changes and timeouts can leave a write's
outcome unknown; verify locally before retrying.

For writes, `dryRun: true` validates local configuration, arguments, and policy
without starting AppleScript. It cannot confirm live account/folder existence,
write permissions, note state, or iCloud synchronization.

The runner uses the absolute system `osascript` executable, a fixed script on
stdin, and an argument array without a shell. It caps execution at 20 seconds and
stdout at 256 KiB. AppleScript diagnostics are not returned verbatim. Returned
IDs are checked against the allowlists again, and unsupported fields are dropped.
Before starting `osascript`, it invokes the checkout's fixed `notes-access-cli
status` permission preflight with a two-second timeout. That CLI calls
`AEDeterminePermissionToAutomateTarget` with `askUserIfNeeded: false`; missing
preflight binaries, an app that is not already running, or an ungranted permission
deny the operation without sending a Notes command. The adapter offers no
permission request command. Build the new Swift target before using Notes.

The separate one-shot `scripts/enroll-notes-test-scope.mjs` helper supports an
explicitly approved bootstrap. It selects one exact account named `iCloud`,
requires a folder title matching `Apple PIM Connector Tests <unique token>`
(a 6–40 character alphanumeric or hyphen token), and creates only that new
top-level test folder when `--create-if-missing` is supplied. Any existing folder
with the requested title causes an abort; the helper never adopts prior contents.
It reads account/folder metadata and never enumerates or reads notes. Notes must
already be running with the approved host's existing Automation grant; the helper
uses the same no-prompt preflight as production.

The enrollment command requires `--mode bootstrap`, `--folder-title`, an absolute
`--bin-dir`, and an absolute `--output` path outside the public checkout. It
validates the output path before starting AppleScript, refuses to overwrite an
existing file, saves only the selected IDs and folder-creation flag in a mode
`0600` file, and omits identifiers from normal output. Startup and permission
approval remain separate from this helper. Use only newly created synthetic note
IDs for the later read/create/append/readback tests; never search prior contents.
Any failure after a creation invocation begins, including failure to save the
private scope file, reports an unknown outcome and forbids automatic retry.
Verify the unique folder label and private output locally before continuing.

Tests use in-memory synthetic fixtures and fake native processes. Two macOS-only
regressions also execute data-free Foundation JSON serialization statements in
AppleScript; those fixtures contain no application, file, shell, or permission
commands. They guard against AppleScript's implicit `result` variable being
overwritten between Foundation method calls. All tests leave Notes and Automation
permissions untouched. Dictionary compile/decompile checks also verify that local
variable names stay distinct from read-only Notes properties such as `plaintext`:

```sh
node --test test/notes-adapter.test.mjs
```

Both fixed AppleScript sources passed offline `osacompile` checks using the
installed system Notes dictionary; compilation executes neither script. The
fixed system app path avoids a LaunchServices bundle-ID lookup failure encountered
while compiling in the restricted environment.

Real AppleScript runtime behavior, existing Notes Automation permission,
account/folder IDs, shared note behavior, and iCloud synchronization remain
unverified until the owner approves a specific live test scope. The permission
preflight is intentionally not run during development. Starting Notes or granting
Automation permission is a separate user action; no privacy settings or
permissions were changed to develop this prototype. A granted preflight must be
validated from the actual host process used for the later local MCP connection.

The Notes adapter shares the repository's local MCP stdio transport. Registering
or testing it locally does not make it reachable by a cloud assistant. The
transport/reachability decision must be made separately before claiming a live
connection.
