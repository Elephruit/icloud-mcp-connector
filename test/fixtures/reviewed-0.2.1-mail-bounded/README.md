# Reviewed bounded Mail 0.2.1 health-check fixture

The immutable public server bundle comes from commit
[`d02c04edd532f2b36e5758daac6bad69f9f7e31a`](https://github.com/Elephruit/icloud-mcp-connector/commit/d02c04edd532f2b36e5758daac6bad69f9f7e31a).
It represents the separately reviewed bounded Mail generation accepted by
`scripts/check-local-connector.mjs`. Its bytes are fixed independently of the
current source build, dependency resolution or Git history available in CI.

Tests reuse `plugin.json`, `scripts/plugin-launcher.mjs` and
`lib/scoped-mail-config.js` from the adjacent `reviewed-0.2.1` fixture. Those
public artifacts are unchanged between the two reviewed commits. A package
must match one complete reviewed hash tuple; the version alone grants nothing.

Tests copy these bytes into a synthetic temporary package and inspect metadata
and hashes. They never execute the frozen launcher or server. The fixture has
no native executables, private configuration, personal records or installed
package files. It is not an installation package and does not establish an
installed refresh or live Mail success.

`server.js.gz` uses deterministic gzip (`mtime=0`, compression level 9). Tests
bound its compressed read to 256 KiB and decompression to 4 MiB.

| Public source path | Uncompressed bytes | SHA-256 |
| --- | ---: | --- |
| `mcp-server/dist/server.js` (stored as `server.js.gz`) | 756,124 | `28bb7db962a4d1255c4841dad7cf3353ab30aba19acc51d5a1047948e70badc5` |
| `LICENSE` | 1,069 | `7e8855c0e6defddc7378a064bd0fd1c4d15deffe55b54dafc9bc25e54c6d24fc` |

`server.js.gz` is 154,473 bytes with SHA-256
`c221e0b0bef7a3caa8cd47b019d7fff77c739675224ea9c0585cfad4adcbe285`.

The connector derives from [Omar Shahine's Apple PIM](https://github.com/omarshahine/apple-pim).
Its upstream copyright (Copyright (c) 2025 Omar Shahine) and MIT license are
preserved in the accompanying `LICENSE` file.
