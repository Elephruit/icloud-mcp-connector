# Source-only iMessage preview

`lib/scoped-imessage-payload.js` is a pure payload foundation, with no Messages
access, configuration loader, native runner, approval armer or installed MCP
tool. It does not prove native service/account routing or delivery support.

Input is exactly `{serviceId, recipient, body}`. The service selector is bounded
and control-free; the recipient is one explicit bare email or E.164 handle.
These checks establish syntax only. A future adapter must enforce separately
approved exact private service and recipient scopes before any native access;
it must not infer contacts, groups or a default service.

The adapter preserves the exact input text and adds a newline followed by the
exact final line `sent by AI Assistant`. It computes a domain-separated SHA-256
digest over the service, recipient and complete final body, then freezes the
preview and payload. Caller-supplied copies of the footer are rejected rather
than stripped or duplicated. Changing any approved field or the footer fails
preview validation. The final body, including the footer, has a 32 KiB UTF-8
bound; malformed Unicode, unsupported controls, attachments, unknown fields
and caller consent flags are rejected.

Mail previews retain their own exact body and do not acquire this footer.
Synthetic checks need no app or permission:

```sh
node --test test/scoped-imessage-payload.test.mjs
```

Actual app grants, scoped setup, durable one-attempt approvals and an exact real
send payload are later decisions. No text is sent by this foundation.
