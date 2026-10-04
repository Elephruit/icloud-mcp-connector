import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { IMESSAGE_AI_FOOTER, IMESSAGE_MAX_BODY_BYTES, canonicalIMessagePayload, createIMessagePreview, validateIMessagePreview, validateIMessageRecipient } from "../lib/scoped-imessage-payload.js";
import { createMailSendPreview } from "../lib/scoped-mail-send-payload.js";

const input = { serviceId: "synthetic-imessage-service", recipient: "recipient@example.net", body: "Synthetic text\nSecond line." };

test("pure iMessage preview appends the exact footer once and freezes the full canonical payload", () => {
  const preview = createIMessagePreview(input);
  assert.deepEqual(preview.payload, { ...input, body: input.body + "\n" + IMESSAGE_AI_FOOTER });
  assert.equal(preview.payload.body.split(IMESSAGE_AI_FOOTER).length - 1, 1);
  assert.ok(preview.payload.body.endsWith("\nsent by AI Assistant"));
  assert.ok(Object.isFrozen(preview) && Object.isFrozen(preview.payload));
  assert.throws(() => { preview.payload.body = "changed"; }, TypeError);
  assert.equal(input.body, "Synthetic text\nSecond line.");
  assert.deepEqual(validateIMessagePreview(preview), preview);
});

test("preview preserves exact recipient/body spelling, whitespace and newlines without inference", () => {
  for (const body of ["  Synthetic text  ", "Synthetic text\n", "Synthetic\r\ntext\t🙂", "Synthetic\u200dtext"]) {
    assert.equal(createIMessagePreview({ ...input, recipient: "Recipient@EXAMPLE.NET", body }).payload.body, body + "\n" + IMESSAGE_AI_FOOTER);
  }
  assert.equal(validateIMessageRecipient("Recipient@EXAMPLE.NET"), "Recipient@EXAMPLE.NET");
  assert.equal(validateIMessageRecipient("+12025550123"), "+12025550123");
});

test("recipient accepts one strict explicit email or E.164 syntax and rejects names/groups/injection", () => {
  for (const recipient of ["Synthetic Name", "Name <recipient@example.net>", "one@example.net,two@example.net", "Group:one@example.net;", ["recipient@example.net"], "+1 (202) 555-0123", "12025550123", "+0123456789", "+1", "+1234567890123456", " recipient@example.net", "recipient@example.net\r\nBcc:other@example.net", "a..b@example.net", ".a@example.net", "a.@example.net", '"a"@example.net', "a@localhost", "a@[127.0.0.1]", "a@-example.net", "a@exämple.net", "a@xn--example", "a@" + "b".repeat(64) + ".net", "a".repeat(65) + "@example.net"]) assert.throws(() => createIMessagePreview({ ...input, recipient }));
  assert.equal(createIMessagePreview({ ...input, recipient: "+12025550123" }).payload.recipient, "+12025550123");
});

test("service identifier is exact, bounded and rejects controls, wildcard and malformed Unicode", () => {
  for (const serviceId of ["", " synthetic-service", "synthetic-service ", "*", "synthetic\nservice", "synthetic\u0085service", "synthetic\u200eservice", "synthetic\u2028service", "\ud800", "\udc00", "x".repeat(2049)]) assert.throws(() => createIMessagePreview({ ...input, serviceId }));
  assert.equal(createIMessagePreview({ ...input, serviceId: "x".repeat(2048) }).payload.serviceId.length, 2048);
  assert.throws(() => createIMessagePreview({ ...input, serviceId: "🙂".repeat(513) }));
});

test("body validates Unicode/plain text and bounds the final UTF-8 body including its footer", () => {
  for (const body of ["", " \t\r\n", "Synthetic\u0000text", "Synthetic\u001btext", "Synthetic\u007ftext", "Synthetic\u0085text", "\ud800", "\udc00", "x\ud800y"]) assert.throws(() => createIMessagePreview({ ...input, body }));
  const maxInputBytes = IMESSAGE_MAX_BODY_BYTES - Buffer.byteLength("\n" + IMESSAGE_AI_FOOTER);
  assert.equal(Buffer.byteLength(createIMessagePreview({ ...input, body: "x".repeat(maxInputBytes) }).payload.body), IMESSAGE_MAX_BODY_BYTES);
  assert.throws(() => createIMessagePreview({ ...input, body: "x".repeat(maxInputBytes + 1) }));
  const emojiBody = "🙂".repeat(Math.floor(maxInputBytes / 4));
  assert.ok(Buffer.byteLength(createIMessagePreview({ ...input, body: emojiBody }).payload.body) <= IMESSAGE_MAX_BODY_BYTES);
  assert.throws(() => createIMessagePreview({ ...input, body: emojiBody + "🙂" }));
});

test("caller footer duplication is rejected without silently changing caller text", () => {
  for (const body of [IMESSAGE_AI_FOOTER, "Synthetic\n" + IMESSAGE_AI_FOOTER, "Synthetic " + IMESSAGE_AI_FOOTER + " inline", "Synthetic\r\n" + IMESSAGE_AI_FOOTER + "\n"]) assert.throws(() => createIMessagePreview({ ...input, body }), /must not already contain/);
});

test("closed input rejects missing fields, attachments, approval flags and code or account overrides", () => {
  for (const extra of [{ attachments: [] }, { approved: true }, { accountId: "other" }, { recipients: [input.recipient] }, { script: "send" }, { configDir: "/synthetic" }, { footer: IMESSAGE_AI_FOOTER }]) assert.throws(() => createIMessagePreview({ ...input, ...extra }));
  for (const missing of Object.keys(input)) { const partial = { ...input }; delete partial[missing]; assert.throws(() => createIMessagePreview(partial)); }
  for (const value of [undefined, null, [], "text"]) assert.throws(() => canonicalIMessagePayload(value));
  const hiddenField = { ...input }; Object.defineProperty(hiddenField, "approved", { value: true }); assert.throws(() => createIMessagePreview(hiddenField));
  assert.throws(() => createIMessagePreview({ ...input, [Symbol("attachment")]: "/synthetic" }));
});

test("digest is deterministic, domain-separated and binds service, exact recipient and complete footered body", () => {
  const preview = createIMessagePreview(input);
  assert.deepEqual(createIMessagePreview({ body: input.body, recipient: input.recipient, serviceId: input.serviceId }), preview);
  assert.equal(preview.digest, createHash("sha256").update("apple-pim-imessage-preview-v1\n" + JSON.stringify(preview.payload)).digest("hex"));
  assert.notEqual(preview.digest, createHash("sha256").update("apple-pim-mail-send-v1\n" + JSON.stringify(preview.payload)).digest("hex"));
  for (const change of [{ serviceId: "other-synthetic-service" }, { recipient: "other@example.net" }, { recipient: "Recipient@example.net" }, { body: "Changed synthetic text" }]) assert.notEqual(createIMessagePreview({ ...input, ...change }).digest, preview.digest);
  for (const payload of [{ ...preview.payload, serviceId: "other-synthetic-service" }, { ...preview.payload, recipient: "other@example.net" }, { ...preview.payload, body: "Changed\n" + IMESSAGE_AI_FOOTER }]) assert.throws(() => validateIMessagePreview({ ...preview, payload }), /digest/);
});

test("preview validation denies changed/missing/duplicated footer and malformed closed preview contracts", () => {
  const preview = createIMessagePreview(input);
  for (const body of [input.body, preview.payload.body + "\n", input.body + "\nsent by another assistant", preview.payload.body + "\n" + IMESSAGE_AI_FOOTER, "\n" + IMESSAGE_AI_FOOTER]) assert.throws(() => validateIMessagePreview({ ...preview, payload: { ...preview.payload, body } }));
  for (const change of [{ version: 2 }, { digest: "0".repeat(64) }, { approved: true }, { payload: { ...preview.payload, attachment: "/synthetic" } }]) assert.throws(() => validateIMessagePreview({ ...preview, ...change }));
  const missingDigest = { ...preview }; delete missingDigest.digest; assert.throws(() => validateIMessagePreview(missingDigest));
});

test("iMessage footer foundation never alters Mail previews or infers an email footer", () => {
  const mailBody = "Synthetic email body";
  const mail = createMailSendPreview({ accountId: "synthetic-mail-account", from: "sender@example.com", to: ["recipient@example.net"], subject: "Synthetic subject", body: mailBody });
  createIMessagePreview(input);
  assert.equal(mail.payload.body, mailBody);
  assert.equal(mail.payload.body.includes(IMESSAGE_AI_FOOTER), false);
});
