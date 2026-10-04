import { createHash } from "node:crypto";

const PAYLOAD_FIELDS = ["accountId", "from", "to", "cc", "bcc", "subject", "body"];

function assertWellFormedUnicode(value) {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("Mail send text contains malformed Unicode");
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error("Mail send text contains malformed Unicode");
  }
}

/** Deliberately conservative ASCII addr-spec; display names/groups are unsupported. */
export function normalizeMailSendAddress(value) {
  if (typeof value !== "string" || value.length < 3 || value.length > 254 || value.trim() !== value || /[\s\u0000-\u001f\u007f]/u.test(value)) throw new Error("Mail send addresses must be bare bounded ASCII addr-specs without whitespace or control characters");
  const pieces = value.split("@");
  if (pieces.length !== 2 || pieces[0].length > 64 || !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/u.test(pieces[0])) throw new Error("Mail send address local part is unsupported");
  const domain = pieces[1].toLowerCase();
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) || !/^[a-z]{2,63}$/u.test(labels.at(-1))) throw new Error("Mail send address domain is unsupported");
  return pieces[0] + "@" + domain;
}

function exactAccountId(value) {
  if (typeof value !== "string" || !value || value.length > 2048 || value.trim() !== value || /[\u0000-\u001f\u007f*]/u.test(value)) throw new Error("Mail send requires an exact bounded native account ID");
  assertWellFormedUnicode(value);
  return value;
}

export function canonicalMailSendPayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((field) => !PAYLOAD_FIELDS.includes(field))) throw new Error("Mail send payload has unsupported fields");
  const accountId = exactAccountId(input.accountId), from = normalizeMailSendAddress(input.from);
  const groups = {};
  for (const bucket of ["to", "cc", "bcc"]) {
    const values = input[bucket] ?? [];
    if (!Array.isArray(values) || values.length > 20) throw new Error("Mail send recipient buckets require bounded arrays");
    groups[bucket] = Object.freeze(values.map(normalizeMailSendAddress));
  }
  const recipients = [...groups.to, ...groups.cc, ...groups.bcc];
  if (groups.to.length === 0 || recipients.length > 20) throw new Error("Mail send requires at least one To recipient and at most 20 total recipients");
  if (new Set(recipients.map((address) => address.toLowerCase())).size !== recipients.length) throw new Error("Mail send recipients must be unique across To/Cc/Bcc");
  if (typeof input.subject !== "string" || !input.subject.trim() || input.subject.length > 240 || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(input.subject)) throw new Error("Mail send subject requires bounded single-line text without control characters");
  if (typeof input.body !== "string" || !input.body.trim() || Buffer.byteLength(input.body, "utf8") > 32768 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.body)) throw new Error("Mail send body requires bounded plain text without unsupported control characters");
  assertWellFormedUnicode(input.subject); assertWellFormedUnicode(input.body);
  // Preserve exact body, subject, bucket order and local-part spelling in approval.
  return Object.freeze({ accountId, from, to: groups.to, cc: groups.cc, bcc: groups.bcc, subject: input.subject, body: input.body });
}

export function createMailSendPreview(input) {
  const payload = canonicalMailSendPayload(input);
  const digest = createHash("sha256").update("apple-pim-mail-send-v1\n" + JSON.stringify(payload)).digest("hex");
  return Object.freeze({ version: 1, digest, payload });
}

export function validateMailSendPreview(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((field) => !["version", "digest", "payload"].includes(field)) || input.version !== 1) throw new Error("Mail send preview format is unsupported");
  const preview = createMailSendPreview(input.payload);
  if (input.digest !== preview.digest) throw new Error("Mail send preview digest does not match its immutable payload");
  return preview;
}
