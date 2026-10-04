# Optional native Contacts companion

The local plugin can explicitly route a small Contacts interface through a
native macOS app. This gives Contacts calls their own app identity when the
desktop host's child process has no usable grant. A temporary acceptance app's
permission does not transfer to this app or to the installed plugin.

## Identity and build

The companion is **iCloud MCP Contacts.app**, bundle identifier
`com.elephruit.icloud-mcp-connector.contacts`. Its Mach-O main executable is the
reviewed `contacts-cli`; get/create/update run inside that process. There is no
resident service, network listener, credential, shell dispatcher, arbitrary
executable path or general command forwarding.

Review the Swift source, dependencies and builder before executing them. Build
the existing release tools first. Then choose a new owner-only staging directory
outside Git and pass its canonical absolute path:

```sh
node scripts/build-contacts-companion.mjs --output '/absolute/private/staging/iCloud MCP Contacts.app'
```

The builder refuses existing destinations and installation directories. It
copies the native executable, usage-description plist, MIT license and upstream
attribution, strips debug symbols from the copied executable, rejects embedded
private build paths, applies the selected signature and verifies the bundle without
launching it. Keep the emitted executable SHA-256 for the private bridge
configuration. This is a build artifact, not an installation or permission
grant. Ad-hoc updates can change macOS permission attribution; review and test
the new bundle before replacing an approved installation.

Ad-hoc signing is the default for synthetic staging. For separately approved
local signing, append `--signing-identity` and the exact 40-digit SHA-1 fingerprint
of an already available code-signing certificate. Names and ambiguous selection
are refused. The builder requires that exact identity before creating a bundle;
it never creates a certificate or falls back to ad-hoc signing.

Certificate mode pins the designated requirement to the fixed bundle ID and
exact certificate leaf, then evaluates that requirement against the actual
signature with `codesign --verify -R`. This provides a content-independent local
identity for repeat builds with the same valid certificate. Certificate
replacement or expiry requires review; macOS TCC grant continuity remains a
live acceptance test. An Apple Development identity does not establish Developer
ID distribution or notarization. No new Keychain trust or privacy grant is part
of the builder.

## Separately approved host setup

Installation and the app's Contacts grant require explicit approval. The fixed
installation path is `~/Applications/iCloud MCP Contacts.app`. The OS grant is
broader than the connector's container allowlists and may persist.

The private bridge root is
`~/Library/Application Support/iCloud MCP Connector/Contacts`, derived from the
logged-in user's UID rather than an inherited `HOME` override. Its root and
`jobs` directories must be owner-only (`0700`); `bridge.json` and every job file
must be owned by that user, regular, single-link and owner-only (`0600`). Keep
these files outside source packages and Git. Same-user code can still access
owner-only files; this file transport is not a sandbox against other programs
running as that user.

After approval, use `examples/contacts-companion.example.json` as the private
`bridge.json` shape. Replace its path and zero hash with the already reviewed
private PIM configuration directory and the exact signed executable hash; set
`enabled` to true. The app and Node runner independently validate these paths,
file properties, the pinned executable and the PIM scope. The runner also
verifies the bundle signature. The selected private PIM config must match the
plugin's `APPLE_PIM_CONFIG_DIR`; profiles and per-call overrides are refused.

The separate `--authorize` app setup command may request Contacts access only
after an exact enabled Contacts scope exists. It does not enumerate containers
or contact records. Ordinary data calls check an existing grant without
prompting; a denied grant fails the call. Authorization is unavailable through
MCP. Do not launch this setup command as an automatic recovery.

Select the route in the private PIM configuration with
`contacts.transport: "companion"`. The plugin launcher defaults to `"direct"`
when this field is absent and rejects other values. All data/write flags remain
separate. A source-only manual MCP host may explicitly set
`APPLE_PIM_CONTACTS_TRANSPORT=companion`; this does not install or authorize the
app. A companion failure never falls back to the direct CLI or inherited
helper.

## First interface and write safety

The companion advertises `get`, `create`, `update` and `schema`. It accepts only
`id`, `container`, `firstName`, `lastName`, `nickname` and `organization` data
fields. Creation requires an exact allowed container and a nonempty first or
last name. Update requires an exact ID and at least one basic field. Search,
list/discovery, email/phone/notes mutation and deletion are outside this first
interface. Other connector transports retain their existing scoped interfaces.

Write previews validate policy and arguments without launching the app; they
do not prove the grant or saving. Routine calls launch exactly one approved app
instance with a request UUID. The app accepts that UUID rather than caller
paths, commands or configuration. Requests and responses are bounded typed
JSON. The native process exclusively claims each job, records a durable marker
before attempting a mutation, and publishes a correlated response plus its
hash in an atomic completion marker.

A timeout, malformed response or missing completion can mean a write occurred.
The runner retains the private journal, reports uncertainty and never retries.
Reconcile the approved record before another mutation. Jobs contain private
request/readback content; do not copy them into source, logs or a public issue.
Journal cleanup is an explicit local maintenance action.

## Acceptance boundary

Synthetic tests validate routing, strict payloads, file protections, scope
denials, request correlation and uncertain writes without accessing Contacts or
launching an app. Building and signature checks also do not establish live
permission.

After installation, grant and exact-scope approval, the installed plugin must
read the existing approved synthetic card by its saved ID, update one reviewed
basic field and read it again. Keep all other personal scopes disabled, tool
approval enabled and deletion denied. This is the missing production Contacts
acceptance step; temporary-app read/write success is separate evidence. Local
readback does not prove remote iCloud sync, desktop UI discovery or direct
cloud-dot connectivity. See [transport limits](assistant-transport.md).
