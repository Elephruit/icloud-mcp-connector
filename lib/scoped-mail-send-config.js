import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { validateMailConfig } from "./scoped-mail-config.js";
import { normalizeMailSendAddress } from "./scoped-mail-send-payload.js";

export function validateMailSendConfig(rootConfig) {
  const mail = validateMailConfig(rootConfig);
  const send = rootConfig.mailSend;
  if (send === undefined) return Object.freeze({ allowSend: false, senders: Object.freeze([]) });
  if (!send || typeof send !== "object" || Array.isArray(send) || Object.keys(send).some((key) => !["allowSend", "senders"].includes(key)) || (send.allowSend !== undefined && typeof send.allowSend !== "boolean")) throw new Error("Mail sending configuration is malformed");
  const senders = send.senders ?? [];
  if (!Array.isArray(senders) || senders.length > 16 || (send.allowSend === true && senders.length === 0)) throw new Error("Mail sending requires explicit bounded sender scopes");
  const verified = senders.map((sender) => {
    if (!sender || typeof sender !== "object" || Array.isArray(sender) || Object.keys(sender).some((key) => !["accountId", "from"].includes(key)) || !mail.accounts.includes(sender.accountId)) throw new Error("Mail sender account is outside the existing native account allowlist");
    const from = normalizeMailSendAddress(sender.from);
    if (from !== sender.from) throw new Error("Configured Mail sender must use its exact canonical address");
    return Object.freeze({ accountId: sender.accountId, from });
  });
  if (new Set(verified.map((sender) => sender.from.toLowerCase())).size !== verified.length) throw new Error("Configured Mail senders must not be ambiguous across accounts");
  return Object.freeze({ allowSend: send.allowSend === true, senders: Object.freeze(verified) });
}

export function assertMailSendSender(payload, sendConfig, { requireEnabled = false } = {}) {
  if (requireEnabled && sendConfig.allowSend !== true) throw new Error("Mail sending is disabled; separate host mailSend.allowSend=true is required");
  if (!sendConfig.senders.some((sender) => sender.accountId === payload.accountId && sender.from === payload.from)) throw new Error("Mail send requires an exact host-approved account/from binding");
}

export async function assertPrivateMailSendDirectory(directory) {
  if (typeof directory !== "string" || !isAbsolute(directory) || /[\u0000-\u001f\u007f]/u.test(directory)) throw new Error("Mail send state requires an explicit private absolute directory");
  try {
    const resolved = await realpath(directory), info = await lstat(resolved), uid = process.getuid?.();
    if (!Number.isInteger(uid) || !info.isDirectory() || info.uid !== uid || (info.mode & 0o777) !== 0o700) throw new Error("private directory required");
    for (let ancestor = resolved; ; ancestor = dirname(ancestor)) {
      let git;
      try { git = await lstat(join(ancestor, ".git")); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (git) throw new Error("state inside Git");
      if (dirname(ancestor) === ancestor) break;
    }
    return resolved;
  } catch { throw new Error("Mail send state requires a current-owner 0700 directory outside Git"); }
}

export async function readPrivateMailSendText(path, maxBytes = 65536) {
  let file;
  try {
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024) throw new Error("invalid file bound");
    // O_NONBLOCK avoids waiting for a FIFO writer before fstat can reject it.
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat(), uid = process.getuid?.();
    if (!Number.isInteger(uid) || !info.isFile() || info.uid !== uid || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > maxBytes) throw new Error("private file required");
    const text = await file.readFile("utf8");
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("file exceeded bound");
    return text;
  } catch (error) { throw Object.assign(new Error("Mail send requires a valid current-owner 0600 regular file with no links"), { code: error.code === "ENOENT" ? "MAIL_SEND_PRIVATE_FILE_MISSING" : "MAIL_SEND_PRIVATE_FILE_INVALID" }); }
  finally {
    try { await file?.close(); }
    catch { throw Object.assign(new Error("Mail send private file could not be safely closed"), { code: "MAIL_SEND_PRIVATE_FILE_INVALID" }); }
  }
}

export async function readPrivateMailSendJSON(path, maxBytes = 65536) {
  const text = await readPrivateMailSendText(path, maxBytes);
  try { return JSON.parse(text); }
  catch { throw Object.assign(new Error("Mail send private JSON is malformed"), { code: "MAIL_SEND_PRIVATE_FILE_INVALID" }); }
}

/** Dedicated loader; does not broaden or change the existing read-only Mail loader. */
export async function loadMailSendContext(env = process.env) {
  if (env.APPLE_PIM_PROFILE) throw new Error("Mail send profiles are unsupported");
  const configDirectory = await assertPrivateMailSendDirectory(env.APPLE_PIM_CONFIG_DIR);
  const config = await readPrivateMailSendJSON(join(configDirectory, "config.json"));
  return Object.freeze({ configDirectory, sendConfig: validateMailSendConfig(config) });
}
