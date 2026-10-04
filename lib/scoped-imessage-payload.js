import { createHash } from "node:crypto";

export const IMESSAGE_AI_FOOTER = "sent by AI Assistant";
export const IMESSAGE_MAX_BODY_BYTES = 32768;
const INPUT_FIELDS = ["serviceId", "recipient", "body"];
const FOOTER_SUFFIX = "\n" + IMESSAGE_AI_FOOTER;
const DIGEST_DOMAIN = "apple-pim-imessage-preview-v1\n";

function assertWellFormedUnicode(value) {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("iMessage preview text contains malformed Unicode");
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error("iMessage preview text contains malformed Unicode");
  }
}

function assertClosedObject(input, fields, label) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Reflect.ownKeys(input).some((field) => typeof field !== "string" || !fields.includes(field)) || fields.some((field) => !Object.hasOwn(input, field))) throw new Error("iMessage " + label + " has missing or unsupported fields");
}

function exactServiceId(value) {
  if (typeof value !== "string" || !value || value.trim() !== value || Buffer.byteLength(value, "utf8") > 2048 || /[\p{Cc}\p{Cf}\u2028\u2029*]/u.test(value)) throw new Error("iMessage preview requires an exact bounded control-free service ID");
  assertWellFormedUnicode(value);
  return value;
}

/** Syntax only: no contact lookup, number validation or service/routing proof. */
export function validateIMessageRecipient(value) {
  if (typeof value !== "string" || value.length > 254 || value.trim() !== value || /[\s\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error("iMessage preview requires one explicit bare email or E.164 recipient handle");
  if (/^\+[1-9][0-9]{1,14}$/u.test(value)) return value;
  const pieces = value.split("@");
  if (pieces.length !== 2 || pieces[0].length > 64 || !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/u.test(pieces[0])) throw new Error("iMessage recipient email local part is unsupported");
  const labels = pieces[1].split(".");
  if (labels.length < 2 || labels.some((label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label)) || !/^[A-Za-z]{2,63}$/u.test(labels.at(-1))) throw new Error("iMessage recipient email domain is unsupported");
  // Preserve the exact explicit handle; never infer or normalize an identity.
  return value;
}

/** Input body excludes the footer. Output body includes the exact final line. */
export function canonicalIMessagePayload(input) {
  assertClosedObject(input, INPUT_FIELDS, "payload");
  const serviceId = exactServiceId(input.serviceId), recipient = validateIMessageRecipient(input.recipient);
  if (typeof input.body !== "string" || !input.body.trim() || Buffer.byteLength(input.body, "utf8") > IMESSAGE_MAX_BODY_BYTES - Buffer.byteLength(FOOTER_SUFFIX, "utf8") || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(input.body)) throw new Error("iMessage preview body requires bounded nonblank plain text without unsupported controls");
  assertWellFormedUnicode(input.body);
  // Reject even an inline copy rather than silently stripping or replacing it.
  if (input.body.includes(IMESSAGE_AI_FOOTER)) throw new Error("iMessage preview input must not already contain its required footer");
  const body = input.body + FOOTER_SUFFIX;
  if (Buffer.byteLength(body, "utf8") > IMESSAGE_MAX_BODY_BYTES) throw new Error("iMessage preview final body exceeds its UTF-8 bound including the footer");
  return Object.freeze({ serviceId, recipient, body });
}

/** Pure preview only. This module has no native runner, permission or send API. */
export function createIMessagePreview(input) {
  const payload = canonicalIMessagePayload(input);
  const digest = createHash("sha256").update(DIGEST_DOMAIN + JSON.stringify(payload)).digest("hex");
  return Object.freeze({ version: 1, digest, payload });
}

export function validateIMessagePreview(input) {
  assertClosedObject(input, ["version", "digest", "payload"], "preview");
  if (input.version !== 1) throw new Error("iMessage preview version is unsupported");
  assertClosedObject(input.payload, INPUT_FIELDS, "preview payload");
  if (typeof input.payload.body !== "string" || !input.payload.body.endsWith(FOOTER_SUFFIX)) throw new Error("iMessage preview must include its exact final footer line");
  const preview = createIMessagePreview({ ...input.payload, body: input.payload.body.slice(0, -FOOTER_SUFFIX.length) });
  if (typeof input.digest !== "string" || input.digest !== preview.digest) throw new Error("iMessage preview digest does not match its exact service, recipient and full body");
  return preview;
}
