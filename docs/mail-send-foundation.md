# Source-only Mail send foundation

This foundation is not registered by the installed MCP server. The default
adapter rejects native sending before draft creation because Mail exposes an
outgoing sender string but no native outgoing-account selector. No send, draft,
sender metadata lookup or permission request occurs in synthetic tests.

The separate `mailSend` policy defaults to disabled. Exact allowed account/From
pairs must agree with the privately enrolled Mail accounts; ordinary Mail reads
remain read-only. Payloads include exact From, To/Cc/Bcc, subject and plain body.
Attachments, address/header injection, unknown parameters and model-provided
consent are rejected. Mail has no automatically inferred footer.

`scripts/arm-mail-send.mjs` is an explicit owner workflow outside MCP: it displays
the exact preview and requires typing `SEND` followed by its digest before arming a private,
short-lived approval. The approval is immutable, bound to the full payload and
cannot be armed by a tool argument. Do not run it without actual send approval.

The owner-only private store durably claims an approval and payload before a
future native attempt. Identical payloads remain blocked across approval UUIDs
and process restarts. Exclusive final receipts prevent contradictory outcomes;
partial/corrupt records, timeouts and late completion remain unknown and
consumed. There is no automatic retry, cleanup, reconciliation/reset or claim
that a message was delivered. Status checks require the exact payload/digest
and inspect local evidence only, without accessing Mail.

The future native seam has an abort/deadline and verifies policy again after
claim. This bounds that attempt, not the entire host-filesystem lifecycle.
Synthetic tests cover replay, concurrency, FIFO/path handling, tampering,
timeouts and exact-payload recovery:

```sh
node --test test/scoped-mail-send.test.mjs
```

Before implementing real native dispatch, obtain specific metadata-only approval
for sender addresses and native account ownership, including any collision
check outside the initial account. Prove unique From ownership, disable/reject
implicit signatures and auto-Cc/Bcc-self preferences, verify exact native
recipients/body and absence of attachments, then obtain approval for one real
send payload. A failure after draft creation may have changed Mail and must stay
unknown; it cannot trigger automatic deletion or another send.
