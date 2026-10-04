#!/usr/bin/env node
import { lstat, open, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveMailMailboxId } from "../lib/scoped-mail-config.js";
import { checkMailAccess } from "../lib/scoped-mail.js";
import { MAIL_ACCOUNT_METADATA_APPLESCRIPT } from "../lib/scoped-mail-metadata-script.js";
import { spawnProcess } from "../lib/safe-shell.js";

const MAX_ACCOUNTS = 32;
const MAX_MAILBOXES = 16;
const MAX_DEPTH = 8;
const CHECKOUT = fileURLToPath(new URL("..", import.meta.url));

function exactText(value, label, maxLength = 2048) {
  if (typeof value !== "string" || !value || value.length > maxLength || value.trim() !== value || /[\u0000-\u001f\u007f*]/u.test(value)) {
    throw new Error(`Mail enrollment ${label} must be exact nonempty text without wildcards or control characters`);
  }
  return value;
}

function validatePaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_MAILBOXES) throw new Error("Mail enrollment requires 1-16 explicit mailbox paths");
  const validated = paths.map((path) => {
    if (!Array.isArray(path) || path.length === 0 || path.length > MAX_DEPTH) throw new Error("Mail mailbox paths require 1-8 ordered exact components");
    return path.map((component) => exactText(component, "mailbox path component", 1024));
  });
  if (new Set(validated.map((path) => JSON.stringify(path))).size !== validated.length) throw new Error("Mail enrollment cannot contain duplicate mailbox paths");
  return validated;
}

/** Enrollment is a separate approved metadata operation, never an MCP fallback. */
export function buildMailEnrollmentArguments({ mode, accountId, mailboxPaths } = {}) {
  if (mode === "metadata-account") {
    if (accountId !== undefined || mailboxPaths !== undefined) throw new Error("Account metadata enrollment does not accept mailbox selectors");
    return [mode, "", "[]"];
  }
  if (mode !== "select-mailboxes") throw new Error("Explicit --mode metadata-account or --mode select-mailboxes is required");
  const id = exactText(accountId, "native account ID");
  const paths = validatePaths(mailboxPaths);
  // Shared config contract must accept every selector before native metadata access.
  paths.forEach((path) => deriveMailMailboxId(id, path));
  return [mode, id, JSON.stringify(paths)];
}

// Original fixed JXA. Inputs are argv, never interpolated executable code.
// No message, count, credential, address, body, header, or filesystem Mail access.
export const MAIL_ENROLLMENT_JXA = String.raw`function run(argv) {
  function exactText(value, maxLength) {
    if (typeof value !== 'string' || !value || value.length > (maxLength || 2048) || value.trim() !== value || /[\u0000-\u001f\u007f*]/.test(value)) throw new Error('Invalid exact selector');
    return value;
  }
  if (!Array.isArray(argv) || argv.length !== 3) throw new Error('Explicit enrollment mode is required');
  const mode = argv[0];
  const accountId = argv[1];
  const paths = JSON.parse(argv[2]);
  if (mode !== 'select-mailboxes') throw new Error('Account metadata requires the fixed typed AppleScript route');
  if (mode === 'select-mailboxes') {
    exactText(accountId);
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > 16) throw new Error('Explicit mailbox paths are required');
    const seen = Object.create(null);
    for (let p = 0; p < paths.length; p++) {
      if (!Array.isArray(paths[p]) || paths[p].length < 1 || paths[p].length > 8) throw new Error('Invalid path depth');
      for (let n = 0; n < paths[p].length; n++) exactText(paths[p][n], 1024);
      const key = JSON.stringify(paths[p]);
      if (seen[key]) throw new Error('Duplicate path');
      seen[key] = true;
    }
  }
  const Mail = Application('/System/Applications/Mail.app');
  if (!Mail.running()) throw new Error('Mail must already be running');
  const accountCandidates = Mail.accounts.whose({ id: accountId })();
  const exactAccounts = [];
  for (let i = 0; i < accountCandidates.length; i++) {
    if (accountCandidates[i].accountType() !== 'iCloud') throw new Error('Exact account provider is not iCloud');
    if (accountCandidates[i].id() === accountId) exactAccounts.push(accountCandidates[i]);
  }
  if (exactAccounts.length !== 1) throw new Error('Exact iCloud account is missing or ambiguous');
  const targetAccount = exactAccounts[0];
  const mailboxes = [];
  for (let p = 0; p < paths.length; p++) {
    let parent = targetAccount;
    for (let n = 0; n < paths[p].length; n++) {
      const candidates = parent.mailboxes.whose({ name: paths[p][n] })();
      const exactMatches = [];
      for (let i = 0; i < candidates.length; i++) {
        if (candidates[i].name() === paths[p][n]) exactMatches.push(candidates[i]);
      }
      if (exactMatches.length !== 1) throw new Error('Exact mailbox path is missing or ambiguous');
      parent = exactMatches[0];
      const mailboxAccount = parent.account();
      if (mailboxAccount.accountType() !== 'iCloud') throw new Error('Mailbox provider mismatch');
      if (mailboxAccount.id() !== accountId) throw new Error('Mailbox account mismatch');
    }
    if (targetAccount.id() !== accountId || parent.name() !== paths[p][paths[p].length - 1]) throw new Error('Mailbox selector changed');
    mailboxes.push({ accountId: accountId, path: paths[p] });
  }
  return JSON.stringify({ success: true, target: 'com.apple.mail', mode: mode, accountId: accountId, mailboxes: mailboxes });
}
`;

export function validateMailEnrollmentResult(result, argv) {
  if (!result || typeof result !== "object" || Array.isArray(result) || result.success !== true || result.target !== "com.apple.mail" || result.mode !== argv[0]) throw new Error("Mail enrollment returned an invalid response");
  if (argv[0] === "metadata-account") {
    if (!Array.isArray(result.accounts) || result.accounts.length > MAX_ACCOUNTS) throw new Error("Mail enrollment returned invalid account metadata");
    const accounts = result.accounts.map((account) => {
      if (!account || account.provider !== "iCloud") throw new Error("Mail enrollment returned an unsupported provider");
      return { id: exactText(account.id, "native account ID"), name: exactText(account.name, "account name"), provider: "iCloud" };
    });
    if (new Set(accounts.map((account) => account.id)).size !== accounts.length) throw new Error("Mail enrollment returned duplicate account IDs");
    return { mode: argv[0], accounts };
  }
  if (argv[0] !== "select-mailboxes" || result.accountId !== argv[1]) throw new Error("Mail enrollment returned an account outside the selected scope");
  const expected = validatePaths(JSON.parse(argv[2]));
  if (!Array.isArray(result.mailboxes) || result.mailboxes.length !== expected.length) throw new Error("Mail enrollment returned an incomplete mailbox selection");
  const mailboxes = result.mailboxes.map((mailbox, index) => {
    if (!mailbox || mailbox.accountId !== argv[1] || JSON.stringify(mailbox.path) !== JSON.stringify(expected[index])) throw new Error("Mail enrollment returned a mailbox outside the exact selected path");
    return { id: deriveMailMailboxId(argv[1], expected[index]), accountId: argv[1], path: expected[index] };
  });
  return { mode: argv[0], accountId: argv[1], mailboxes };
}

/** Preflight cannot prompt or launch Mail. Native stdout/stderr never escape errors. */
export async function runMailEnrollmentScript(argv, {
  accessCliPath,
  preflightImpl = checkMailAccess,
  spawnImpl = spawnProcess,
  platform = process.platform,
  timeoutMs = 20000,
} = {}) {
  if (platform !== "darwin") throw new Error("Mail enrollment requires macOS");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error("Mail enrollment timeout is invalid");
  // Revalidate public runner arguments before the first native process.
  let canonical;
  try {
    canonical = argv?.[0] === "metadata-account"
      ? buildMailEnrollmentArguments({ mode: argv[0] })
      : buildMailEnrollmentArguments({ mode: argv?.[0], accountId: argv?.[1], mailboxPaths: JSON.parse(argv?.[2] ?? "null") });
  } catch { throw new Error("Mail enrollment arguments are invalid"); }
  if (!Array.isArray(argv) || JSON.stringify(argv) !== JSON.stringify(canonical)) throw new Error("Mail enrollment arguments are invalid");
  let nativeHome;
  try { nativeHome = userInfo().homedir; } catch { throw new Error("Mail enrollment could not resolve the local user identity"); }
  if (typeof nativeHome !== "string" || !isAbsolute(nativeHome) || /[\u0000-\u001f\u007f]/u.test(nativeHome)) throw new Error("Mail enrollment could not resolve the local user home directory");
  // No inherited credentials, dynamic-loader variables, proxy settings or private config.
  const nativeEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", HOME: nativeHome };
  await preflightImpl({ accessCliPath, spawnImpl, platform });
  // JXA cannot reliably coerce Mail's TypeOfAccount enum in a whose predicate.
  // Account discovery uses the reviewed typed iCloud-only AppleScript request.
  const nativeArgs = argv[0] === "metadata-account" ? ["-"] : ["-l", "JavaScript", "-", ...argv];
  const nativeSource = argv[0] === "metadata-account" ? MAIL_ACCOUNT_METADATA_APPLESCRIPT : MAIL_ENROLLMENT_JXA;
  return await new Promise((resolvePromise, reject) => {
    let child;
    try { child = spawnImpl("/usr/bin/osascript", nativeArgs, { shell: false, stdio: ["pipe", "pipe", "pipe"], env: nativeEnv }); }
    catch { reject(new Error("Could not launch Mail metadata enrollment")); return; }
    let output = "", outputBytes = 0, stderrBytes = 0, settled = false, killTimer;
    const fail = (message, kill = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (kill) {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
        killTimer.unref?.();
      }
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail("Mail metadata enrollment timed out", true), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes > 128 * 1024) { fail("Mail enrollment response exceeded its size limit", true); return; }
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (settled) return;
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > 8192) fail("Mail enrollment diagnostics exceeded their size limit", true);
    });
    child.on("error", () => fail("Could not launch Mail metadata enrollment"));
    child.stdin.on("error", () => fail("Could not send the fixed Mail enrollment script", true));
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (settled) return;
      if (code !== 0) { fail("Mail enrollment failed; verify the exact approved metadata scope locally"); return; }
      try {
        const metadata = validateMailEnrollmentResult(JSON.parse(output), argv);
        settled = true;
        resolvePromise(metadata);
      } catch { fail("Mail enrollment returned an invalid response"); }
    });
    try { child.stdin.end(nativeSource); }
    catch { fail("Could not send the fixed Mail enrollment script", true); }
  });
}

function within(root, path) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

/** Pure ownership/permission check; the OS identity never comes from environment. */
export function validatePrivateMailOutputDirectory(info, expectedUid = process.getuid?.()) {
  if (!Number.isInteger(expectedUid) || !info?.isDirectory?.() || info.uid !== expectedUid || (info.mode & 0o077) !== 0 || (info.mode & 0o700) !== 0o700) {
    throw new Error("Mail enrollment output requires a current-owner private directory with 0700 permissions");
  }
}

async function privateOutputPath(outputPath) {
  if (typeof outputPath !== "string" || !isAbsolute(outputPath) || /[\u0000-\u001f\u007f]/u.test(outputPath)) throw new Error("An explicit absolute private output path is required");
  const parent = await realpath(dirname(outputPath));
  validatePrivateMailOutputDirectory(await lstat(parent));
  if (within(await realpath(CHECKOUT), parent)) throw new Error("Mail enrollment metadata must be saved outside the public checkout");
  // Also reject another Git worktree, including a .git pointer file.
  for (let directory = parent; ; directory = dirname(directory)) {
    try { await lstat(join(directory, ".git")); throw new Error("Mail enrollment metadata must be saved outside Git"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (dirname(directory) === directory) break;
  }
  const privatePath = join(parent, basename(outputPath));
  try { await lstat(privatePath); throw new Error("Mail enrollment requires a new private output file and cannot overwrite an existing path"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return privatePath;
}

async function checkoutAccessCli(binDir) {
  if (typeof binDir !== "string" || !isAbsolute(binDir)) throw new Error("An explicit absolute checkout release binary directory is required");
  let expected, requested;
  try { expected = await realpath(join(CHECKOUT, "swift", ".build", "release")); requested = await realpath(binDir); }
  catch { throw new Error("Build the checkout mail-access-cli release helper before enrollment"); }
  if (requested !== expected || !within(await realpath(CHECKOUT), requested)) throw new Error("Mail enrollment requires this checkout's fixed release binary directory");
  let cliPath, cliStat;
  try { cliPath = await realpath(join(expected, "mail-access-cli")); cliStat = await lstat(cliPath); }
  catch { throw new Error("Build the checkout mail-access-cli release helper before enrollment"); }
  if (!within(expected, cliPath) || !cliStat.isFile() || !(cliStat.mode & 0o111)) throw new Error("Mail enrollment requires this checkout's built release helper");
  return cliPath;
}

export async function writePrivateMailScope(outputPath, metadata, argv) {
  try {
    const privatePath = await privateOutputPath(outputPath);
    const safeMetadata = validateMailEnrollmentResult({ success: true, target: "com.apple.mail", ...metadata }, argv);
    const file = await open(privatePath, "wx", 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(JSON.stringify(safeMetadata, null, 2) + "\n", "utf8");
    } finally { await file.close(); }
  } catch { throw new Error("Mail enrollment private output failed; use a new private path outside Git and verify locally"); }
}

/** All identifiers and metadata stay in the private file; stdout is a receipt only. */
export async function enrollMailScope(options, { runScript, writePrivate = writePrivateMailScope, resolveAccessCli = checkoutAccessCli } = {}) {
  try {
    const argv = buildMailEnrollmentArguments(options);
    await privateOutputPath(options.outputPath);
    const accessCliPath = await resolveAccessCli(options.binDir);
    const metadata = await (runScript ?? ((args) => runMailEnrollmentScript(args, { accessCliPath })))(argv);
    const safeMetadata = validateMailEnrollmentResult({ success: true, target: "com.apple.mail", ...metadata }, argv);
    await writePrivate(options.outputPath, safeMetadata, argv);
    return { success: true, mode: argv[0], privateScopeWritten: true, count: safeMetadata.accounts?.length ?? safeMetadata.mailboxes.length };
  } catch { throw new Error("Mail enrollment did not finish; verify the approved exact metadata scope, checkout release helper, and new private output path locally"); }
}

export function parseMailEnrollmentCLI(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--mailbox-path-json") {
      if (index + 1 >= argv.length) throw new Error("Each --mailbox-path-json requires one JSON array of exact ordered names");
      let path;
      try { path = JSON.parse(argv[++index]); } catch { throw new Error("Mailbox path must be a JSON array of exact ordered names"); }
      (options.mailboxPaths ??= []).push(path);
      continue;
    }
    const key = { "--mode": "mode", "--bin-dir": "binDir", "--output": "outputPath", "--account-id": "accountId" }[argument];
    if (!key || options[key] !== undefined || index + 1 >= argv.length) throw new Error("Use an explicit enrollment mode, --bin-dir <checkout release directory>, --output <new private file>, and exact account/path selectors for select-mailboxes");
    options[key] = argv[++index];
  }
  buildMailEnrollmentArguments(options);
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await enrollMailScope(parseMailEnrollmentCLI(process.argv.slice(2)))) + "\n"); }
  catch {
    // Error strings from native APIs and private filesystem paths may include identifiers.
    process.stderr.write("Mail enrollment did not finish; check the approved exact metadata scope and new private output path locally. No messages were queried.\n");
    process.exitCode = 1;
  }
}
