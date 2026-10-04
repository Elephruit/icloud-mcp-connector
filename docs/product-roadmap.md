# Staged connector roadmap

The project extends Omar Shahine's MIT-licensed Apple PIM. Preserve its license
and attribution in source and every future package. Private scopes, credentials,
PIM records and acceptance receipts stay outside the public repository.

## 1. Prove the assistant route

Keep the observed connected-Mac/local-task route available. Stage a separate
stdio server exposing only a synthetic fixture, then test the actual installed
host and intended dot. Secure MCP Tunnel is the documented private stdio
candidate; verify target-account access before relying on it. Its pricing is
unconfirmed. A public plugin instead requires stable HTTPS infrastructure and
authentication; tunnel testing alone does not satisfy public distribution.

Connection setup needs explicit approval for the official runtime installation,
tunnel and least-privileged runtime credential, workspace association, developer
app registration, temporary loopback admin listener and outbound request/data
processing. Begin with one foreground process and synthetic calls only. Record
the caller, route, server version and process instance; test stop/restart failure
and reconnection. Do not infer direct dot access from CLI protocol tests.

## 2. Establish a stable Mac companion

The current native Contacts companion is the first narrow app route. Its
builder must reject private build paths, preserve attribution, stage exclusively
outside source and verify the signature. An explicitly selected certificate and
fixed bundle identity support local continuity across content changes while
that certificate remains valid. Ad-hoc signatures do not provide this property.
No Developer ID/notarization or live TCC continuity is claimed by a build test.

Using a signing private key, installation, the companion's own broader Contacts
grant and an exact first-record test are separate setup decisions. After that
route works, add deliberate permission/status and exact-scope setup for the other
domains. Scope selection stays outside Git and ordinary calls never prompt.

## 3. Complete bounded workflows

Mail read pagination discloses inspected coverage; callers must deduplicate IDs
across pages because arrival or mailbox changes can shift them. Thread reads follow bounded RFC links
and disclose incomplete history. Retain native and overall deadlines and
explicit failure diagnostics. Do not claim exhaustive results from a partial
page or historical thread.

The source-only Mail send foundation uses exact immutable previews, separately
owner-armed short-lived approvals, durable payload deduplication, exclusive
outcome receipts and no automatic retry after an uncertain attempt. Native
sending stays blocked until separately approved sender-account ownership and
exact native draft semantics are verified. Mail acceptance is not delivery.

The [source-only iMessage preview](imessage-preview.md) binds an exact
recipient/service and appends the exact final line `sent by AI Assistant`
before computing the payload digest. A native adapter must be separately scoped
and verified. No conversation read, app grant or real text send is
authorized by implementing this contract. Never add that footer to Mail by
inference. Attachments, group inference and deletion remain outside initial
send adapters.

## 4. Verify the installed route

Use synthetic fixtures for protocol, policy, replay, timeouts and recovery.
Actual installed-client and dot calls must establish their own route. After
specific live scope approval, verify one identified artifact and read it back;
keep local saving separate from iCloud synchronization. Test process restart
before updates, Mac sleep/wake only with approval for that interruption, and
confirm grants/scope remain intact. Never rerun consumed sends to test recovery.

## 5. Prepare distribution and reviewed integration

The reviewed `scripts/stage-native-tools.mjs` copies only five fixed tools into
a new private destination outside Git, strips and scans known private paths,
then signs/verifies the copies without changing installed packages. Every
future staged native executable must receive this privacy and signature check
after its final modification.
Packages must contain disabled examples and no real scopes or private receipts.
Use versioned reproducible staging, native policy tests, protocol/bundle tests,
companion staging and exact-commit CI. Keep implementation on a feature branch
until reviewed integration is authorized. Public release, public plugin
submission, tags, paid services, persistent gateway supervision and production
hosting each need their own concrete scope approval.

See [transport](assistant-transport.md), [connection proof](connection-proof.md),
[Contacts companion](contacts-companion.md), [Mail reads](mail-adapter.md) and
[Mail send foundation](mail-send-foundation.md), [iMessage preview](imessage-preview.md).
