import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

function exactText(value, label, maxLength = 2048) {
  if (typeof value !== "string" || !value || value.length > maxLength || value.trim() !== value || /[\u0000-\u001f\u007f*]/u.test(value)) throw new Error(`Mail ${label} must be exact nonempty text without wildcards/control characters`);
  return value;
}

/** Mail has no native mailbox ID. This host key binds exact account + path. */
export function deriveMailMailboxId(accountId, path) {
  exactText(accountId, "account ID");
  if (!Array.isArray(path) || path.length < 1 || path.length > 8) throw new Error("Mail mailbox path requires 1 to 8 exact hierarchy segments");
  path.forEach((segment) => exactText(segment, "mailbox path segment", 1024));
  return "mailbox:sha256:" + createHash("sha256").update(JSON.stringify([accountId, path])).digest("hex");
}

export function validateMailConfig(config) {
  const mail = config?.mail;
  if (!mail || typeof mail !== "object" || Array.isArray(mail) || mail.enabled !== true) throw new Error("Mail is disabled; explicit mail.enabled=true and account/mailbox scopes are required");
  if (Object.keys(mail).some((key) => !["enabled", "accounts", "mailboxes", "allowWrites"].includes(key))) throw new Error("Mail configuration has unsupported fields");
  if (mail.allowWrites !== undefined && mail.allowWrites !== false) throw new Error("Scoped Mail is read-only; allowWrites must be false");
  if (!Array.isArray(mail.accounts) || mail.accounts.length < 1 || mail.accounts.length > 8) throw new Error("Mail requires 1 to 8 explicit native account IDs");
  mail.accounts.forEach((accountId) => exactText(accountId, "account ID"));
  if (new Set(mail.accounts).size !== mail.accounts.length) throw new Error("Mail account IDs must be unique");
  if (!Array.isArray(mail.mailboxes) || mail.mailboxes.length < 1 || mail.mailboxes.length > 16) throw new Error("Mail requires 1 to 16 explicit account/path mailbox records");
  const mailboxes = mail.mailboxes.map((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).some((key) => !["id", "accountId", "path"].includes(key))) throw new Error("Mail mailbox record must contain only id, accountId, and path");
    if (!mail.accounts.includes(record.accountId)) throw new Error("Mail mailbox account is outside the explicit account allowlist");
    if (record.id !== deriveMailMailboxId(record.accountId, record.path)) throw new Error("Mail mailbox key does not match its exact account/path");
    return Object.freeze({ id: record.id, accountId: record.accountId, path: Object.freeze([...record.path]) });
  });
  if (new Set(mailboxes.map((record) => record.id)).size !== mailboxes.length) throw new Error("Mail mailbox keys must be unique");
  return Object.freeze({ enabled: true, allowWrites: false, accounts: Object.freeze([...mail.accounts]), mailboxes: Object.freeze(mailboxes) });
}

export async function loadMailConfig(env = process.env, {
  readFileImpl = readFile, lstatImpl = lstat, realpathImpl = realpath,
  getUid = () => process.getuid?.(),
} = {}) {
  if (env.APPLE_PIM_PROFILE) throw new Error("Mail profiles are unsupported; no fallback is permitted");
  const directory = env.APPLE_PIM_CONFIG_DIR;
  if (typeof directory !== "string" || !isAbsolute(directory) || /[\u0000-\u001f\u007f]/u.test(directory)) throw new Error("Mail requires an explicit absolute private APPLE_PIM_CONFIG_DIR");
  let raw;
  try {
    const privateDirectory = await realpathImpl(directory);
    const directoryInfo = await lstatImpl(privateDirectory);
    const configPath = join(privateDirectory, "config.json");
    const fileInfo = await lstatImpl(configPath);
    const uid = getUid();
    if (!Number.isInteger(uid) || !directoryInfo.isDirectory() || !fileInfo.isFile() || fileInfo.nlink !== 1 || directoryInfo.uid !== uid || fileInfo.uid !== uid || (directoryInfo.mode & 0o077) !== 0 || (fileInfo.mode & 0o077) !== 0 || fileInfo.size > 65536) throw new Error("private config permissions");
    // Reject configuration stored inside any Git checkout, including worktrees.
    let ancestor = privateDirectory;
    for (;;) {
      let gitEntry;
      try { gitEntry = await lstatImpl(join(ancestor, ".git")); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (gitEntry) throw new Error("config inside Git");
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    raw = await readFileImpl(configPath, "utf8");
  } catch {
    throw new Error("Mail config must be an owner-only file in an owner-only private directory outside Git; access remains disabled");
  }
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 65536) throw new Error("Mail configuration exceeds its size limit");
  let config;
  try { config = JSON.parse(raw); } catch { throw new Error("Mail configuration is malformed; access remains disabled"); }
  return validateMailConfig(config);
}
