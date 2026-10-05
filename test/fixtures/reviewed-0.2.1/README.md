# Reviewed 0.2.1 health-check fixture

These immutable public files come from commit
[`33729a52a963b3ee692bf7661f221804701cf530`](https://github.com/Elephruit/icloud-mcp-connector/commit/33729a52a963b3ee692bf7661f221804701cf530).
They represent the older reviewed package accepted by
`scripts/check-local-connector.mjs`, independently of the current source bundle,
CI dependency resolution or a shallow Git checkout.

Tests copy these bytes into a synthetic temporary package and validate file
metadata and hashes. They never execute the frozen launcher or server. No native
binary, private configuration, personal record or installed-package file is
included. A newer source bundle must remain rejected until it receives a separate
runtime review; this fixture does not update the accepted runtime pins.

The server is stored as deterministic gzip data (`mtime=0`, compression level 9).
Tests bound the compressed read to 256 KiB and decompression to 4 MiB.

| Public source path | Uncompressed bytes | SHA-256 |
| --- | ---: | --- |
| `plugin.json` | 1,619 | `c2f1dd9cde46482b9891e28bee5ff86b80226e52f3c6f3684d881b6ccc36eee2` |
| `scripts/plugin-launcher.mjs` | 10,361 | `ba0277f30e75ccfbb634a46631fa82a311f07b13a2297230ddc40061778d6abb` |
| `mcp-server/dist/server.js` (stored as `server.js.gz`) | 751,956 | `daba5100907dcd44162c513c83c383e8e7d7a80faaa5ff665dd621bb844c0bf7` |
| `lib/scoped-mail-config.js` | 5,110 | `6b5596c782a53d3a4acb4b013412f4f718c6d3367d550bbf489ba18cc3330dde` |
| `LICENSE` | 1,069 | `7e8855c0e6defddc7378a064bd0fd1c4d15deffe55b54dafc9bc25e54c6d24fc` |

`server.js.gz` is 153,464 bytes with SHA-256
`1983adb32a4ca71686ffa507a465ad01ad30c659be3b3157addb578f71a3cf3f`.

The connector derives from [Omar Shahine's Apple PIM](https://github.com/omarshahine/apple-pim).
Its upstream copyright (Copyright (c) 2025 Omar Shahine) and MIT license are
preserved in the accompanying `LICENSE` file. These snapshots are for regression
testing, not an installation package.
