import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { deriveMailMailboxId } from "../lib/scoped-mail-config.js";
import { MAIL_ACCOUNT_METADATA_APPLESCRIPT } from "../lib/scoped-mail-metadata-script.js";
import {
  buildMailEnrollmentArguments,
  enrollMailScope,
  MAIL_ENROLLMENT_JXA,
  parseMailEnrollmentCLI,
  runMailEnrollmentScript,
  validateMailEnrollmentResult,
  validatePrivateMailOutputDirectory,
  writePrivateMailScope,
} from "../scripts/enroll-mail-scope.mjs";

const accountId = "SYNTHETIC-ACCOUNT";
const path = ["Agent", "Synthetic Inbox"];
const mailboxArgs = buildMailEnrollmentArguments({ mode: "select-mailboxes", accountId, mailboxPaths: [path] });
const accountArgs = buildMailEnrollmentArguments({ mode: "metadata-account" });
const accountsResult = { success: true, target: "com.apple.mail", mode: "metadata-account", accounts: [{ id: accountId, name: "Synthetic iCloud", provider: "iCloud" }] };
const mailboxesResult = { success: true, target: "com.apple.mail", mode: "select-mailboxes", accountId, mailboxes: [{ accountId, path }] };
const approvedPreflight = async () => ({ success: true, target: "com.apple.mail", running: true, authorized: true, prompted: false, authorization: "authorized" });

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = (source) => { child.source = source; };
  child.kills = [];
  child.kill = (signal) => { child.kills.push(signal); };
  return child;
}

function fakeMail({ accounts, running = true }) {
  const calls = [];
  const accountCollection = () => { throw new Error("Unfiltered account enumeration forbidden"); };
  accountCollection.whose = (predicate) => () => {
    assert.deepEqual(Object.keys(predicate), ["id"]); assert.equal(predicate.id, accountId);
    calls.push("accounts.whose.exactID");
    return accounts.filter((account) => account.selectedNativeID === predicate.id);
  };
  const mail = { running: () => running, accounts: accountCollection };
  for (const forbidden of ["iCloudAccounts", "messages", "inbox", "activate", "launch"]) Object.defineProperty(mail, forbidden, { get() { throw new Error("Forbidden Mail property: " + forbidden); } });
  return { mail, calls };
}

function nativeAccount(id, name, trees = [], provider = "iCloud") {
  const account = { selectedNativeID: id, accountType: () => provider, id: () => id, name: () => name };
  function collection(nodes) {
    const value = () => { throw new Error("Unfiltered mailbox discovery is forbidden"); };
    value.whose = ({ name: selectedName }) => () => nodes.filter((node) => node.name().toLowerCase() === selectedName.toLowerCase());
    return value;
  }
  function mailbox(node) {
    const value = { name: () => node.name, account: () => node.wrongAccount ? { accountType: () => "iCloud", id: () => "OUTSIDE" } : account, mailboxes: collection((node.children ?? []).map(mailbox)) };
    for (const forbidden of ["messages", "unreadCount", "messageCount", "source", "content", "allHeaders"]) Object.defineProperty(value, forbidden, { get() { throw new Error("Forbidden mailbox data: " + forbidden); } });
    return value;
  }
  account.mailboxes = collection(trees.map(mailbox));
  for (const forbidden of ["userName", "emailAddresses", "password", "serverName", "accountDirectory"]) Object.defineProperty(account, forbidden, { get() { throw new Error("Forbidden account data: " + forbidden); } });
  return account;
}

function executeSyntheticJXA(argv, fixture) {
  let requestedApplication;
  const response = runInNewContext(MAIL_ENROLLMENT_JXA + "\nrun(args)", {
    args: argv,
    Application: (target) => { requestedApplication = target; return fixture.mail; },
  }, { timeout: 1000 });
  assert.equal(requestedApplication, "/System/Applications/Mail.app");
  return JSON.parse(response);
}

test("enrollment requires explicit narrow modes and exact account/path selectors", () => {
  assert.throws(() => buildMailEnrollmentArguments());
  assert.throws(() => buildMailEnrollmentArguments({ mode: "discover" }));
  assert.throws(() => buildMailEnrollmentArguments({ mode: "metadata-account", accountId }));
  assert.throws(() => buildMailEnrollmentArguments({ mode: "metadata-account", mailboxPaths: [] }));
  for (const value of [undefined, "", "*", " ACCOUNT ", "a\n", "a\0b"]) assert.throws(() => buildMailEnrollmentArguments({ mode: "select-mailboxes", accountId: value, mailboxPaths: [path] }));
  for (const mailboxPaths of [undefined, [], [[]], [["*"]], [[" padded "]], [["x".repeat(1025)]], [Array(9).fill("Nested")], Array(17).fill(path), [path, path]]) assert.throws(() => buildMailEnrollmentArguments({ mode: "select-mailboxes", accountId, mailboxPaths }));
  assert.deepEqual(mailboxArgs, ["select-mailboxes", accountId, JSON.stringify([path])]);
});

test("CLI rejects unknown/duplicate flags and preserves ordered JSON paths as data", () => {
  const options = parseMailEnrollmentCLI(["--mode", "select-mailboxes", "--account-id", accountId, "--mailbox-path-json", JSON.stringify(path), "--mailbox-path-json", '["INBOX"]', "--bin-dir", "/synthetic/bin", "--output", "/synthetic/private.json"]);
  assert.deepEqual(options.mailboxPaths, [path, ["INBOX"]]);
  for (const args of [["--mode", "metadata-account", "--mode", "metadata-account"], ["--mode", "metadata-account", "--authorize"], ["--mode", "select-mailboxes", "--mailbox-path-json", "SYNTHETIC_PRIVATE_BAD_JSON"]]) assert.throws(() => parseMailEnrollmentCLI(args), (error) => !error.message.includes("SYNTHETIC_PRIVATE_BAD_JSON"));
});

test("fixed typed AppleScript metadata filters iCloud natively; JXA cannot discover accounts", () => {
  assert.match(MAIL_ACCOUNT_METADATA_APPLESCRIPT, /get every account whose account type is iCloud/u);
  assert.match(MAIL_ACCOUNT_METADATA_APPLESCRIPT, /account type of cloudAccountRef\) is not iCloud/u);
  assert.ok(MAIL_ACCOUNT_METADATA_APPLESCRIPT.indexOf('set stageLabel to "accountType"') < MAIL_ACCOUNT_METADATA_APPLESCRIPT.indexOf("get id of cloudAccountRef"));
  assert.ok(!/messages|email addresses|password|user name|activate|do shell script/u.test(MAIL_ACCOUNT_METADATA_APPLESCRIPT));
  const fixture = fakeMail({ accounts: [nativeAccount(accountId, "Synthetic iCloud")] });
  assert.throws(() => executeSyntheticJXA(accountArgs, fixture), /typed AppleScript/);
  assert.deepEqual(fixture.calls, []);
});

test("fixed JXA resolves exact paths level by level without recursive or global fallback", () => {
  const account = nativeAccount(accountId, "Synthetic iCloud", [{ name: "Agent", children: [{ name: "Synthetic Inbox" }] }, { name: "Synthetic Inbox" }]);
  const fixture = fakeMail({ accounts: [account, nativeAccount("OUTSIDE", "Outside")] });
  assert.deepEqual(executeSyntheticJXA(mailboxArgs, fixture), mailboxesResult);
  assert.deepEqual(fixture.calls, ["accounts.whose.exactID"]);
  assert.throws(() => executeSyntheticJXA(buildMailEnrollmentArguments({ mode: "select-mailboxes", accountId, mailboxPaths: [["Missing", "Synthetic Inbox"]] }), fixture), /missing or ambiguous/);
});

test("fixed JXA refuses missing, duplicate, case-mismatched and cross-account mailbox matches", () => {
  for (const trees of [[{ name: "Agent", children: [{ name: "synthetic inbox" }] }], [{ name: "Agent", children: [{ name: "Synthetic Inbox" }, { name: "Synthetic Inbox" }] }], [{ name: "Agent", children: [{ name: "Synthetic Inbox", wrongAccount: true }] }]]) {
    assert.throws(() => executeSyntheticJXA(mailboxArgs, fakeMail({ accounts: [nativeAccount(accountId, "Synthetic iCloud", trees)] })), /missing or ambiguous|mismatch/);
  }
  assert.throws(() => executeSyntheticJXA(mailboxArgs, fakeMail({ accounts: [] })), /missing or ambiguous/);
  assert.throws(() => executeSyntheticJXA(mailboxArgs, fakeMail({ accounts: [nativeAccount(accountId, "First"), nativeAccount(accountId, "Second")] })), /missing or ambiguous/);
});

test("fixed JXA checks running status before any metadata query", () => {
  const fixture = fakeMail({ accounts: [], running: false });
  assert.throws(() => executeSyntheticJXA(mailboxArgs, fixture), /already be running/);
  assert.deepEqual(fixture.calls, []);
});

test("response validation projects metadata and derives the shared mailbox key", () => {
  assert.deepEqual(validateMailEnrollmentResult({ ...accountsResult, secrets: "DO_NOT_RETURN", accounts: [{ ...accountsResult.accounts[0], email: "synthetic@example.com" }] }, accountArgs), { mode: "metadata-account", accounts: accountsResult.accounts });
  const metadata = validateMailEnrollmentResult(mailboxesResult, mailboxArgs);
  assert.deepEqual(metadata.mailboxes, [{ id: deriveMailMailboxId(accountId, path), accountId, path }]);
  assert.notEqual(deriveMailMailboxId(accountId, ["Agent/Synthetic Inbox"]), metadata.mailboxes[0].id);
  for (const patch of [{ success: false }, { target: "com.apple.Notes" }, { accountId: "OUTSIDE" }, { mailboxes: [] }, { mailboxes: [{ accountId, path: ["Elsewhere"] }] }]) assert.throws(() => validateMailEnrollmentResult({ ...mailboxesResult, ...patch }, mailboxArgs));
  for (const accounts of [[{ id: accountId, name: "Synthetic", provider: "Other" }], [accountsResult.accounts[0], accountsResult.accounts[0]]]) assert.throws(() => validateMailEnrollmentResult({ ...accountsResult, accounts }, accountArgs));
});

test("runner validates argv/platform before preflight and refuses denied preflight before JXA", async () => {
  let called = false;
  const dependencies = { platform: "darwin", preflightImpl: async () => { called = true; }, spawnImpl: () => { throw new Error("Unexpected launch"); } };
  for (const args of [[], ["metadata-account", accountId, "[]"], ["select-mailboxes", accountId, "SYNTHETIC_PRIVATE_JSON"]]) await assert.rejects(runMailEnrollmentScript(args, dependencies), (error) => !error.message.includes("SYNTHETIC_PRIVATE_JSON"));
  assert.equal(called, false);
  await assert.rejects(runMailEnrollmentScript(accountArgs, { ...dependencies, platform: "linux" }), /macOS/);
  let spawned = false;
  await assert.rejects(runMailEnrollmentScript(accountArgs, { platform: "darwin", preflightImpl: async () => { throw new Error("Not granted"); }, spawnImpl: () => { spawned = true; } }), /Not granted/);
  assert.equal(spawned, false);
});

test("runner sends a fixed source via stdin and selectors via argv with no shell", async () => {
  const child = fakeChild();
  let invocation;
  const promise = runMailEnrollmentScript(mailboxArgs, { platform: "darwin", preflightImpl: approvedPreflight, spawnImpl: (...args) => { invocation = args; return child; } });
  await Promise.resolve();
  assert.deepEqual(invocation, ["/usr/bin/osascript", ["-l", "JavaScript", "-", ...mailboxArgs], { shell: false, stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", HOME: userInfo().homedir } }]);
  assert.equal(child.source, MAIL_ENROLLMENT_JXA);
  child.stdout.emit("data", JSON.stringify(mailboxesResult));
  child.emit("close", 0);
  assert.equal((await promise).mailboxes[0].id, deriveMailMailboxId(accountId, path));
});

test("metadata runner selects only the fixed typed AppleScript with zero caller argv", async () => {
  const child = fakeChild(); let captured;
  const promise = runMailEnrollmentScript(accountArgs, { platform: "darwin", preflightImpl: approvedPreflight, spawnImpl: (...args) => { captured = args; return child; } });
  await Promise.resolve();
  assert.equal(captured[0], "/usr/bin/osascript"); assert.deepEqual(captured[1], ["-"]);
  assert.equal(child.source, MAIL_ACCOUNT_METADATA_APPLESCRIPT);
  child.stdout.emit("data", JSON.stringify(accountsResult)); child.emit("close", 0);
  assert.deepEqual((await promise).accounts, accountsResult.accounts);
});

test("selected account provider denial precedes IDs/names/mailboxes", () => {
  const account = nativeAccount(accountId, "Forbidden", [], "imap");
  for (const field of ["id", "name", "mailboxes"]) Object.defineProperty(account, field, { get() { throw new Error("UNAPPROVED_PROVIDER_FIELD"); } });
  assert.throws(() => executeSyntheticJXA(mailboxArgs, fakeMail({ accounts: [account] })), /provider is not iCloud/);
});

test("runner bounds stdout/stderr and timeout without exposing diagnostics", async () => {
  for (const stream of ["stdout", "stderr"]) {
    const child = fakeChild();
    const promise = runMailEnrollmentScript(accountArgs, { platform: "darwin", preflightImpl: approvedPreflight, spawnImpl: () => child });
    await Promise.resolve();
    child[stream].emit("data", "SYNTHETIC_PRIVATE_DIAGNOSTIC".repeat(8193));
    await assert.rejects(promise, (error) => /size limit/.test(error.message) && !error.message.includes("SYNTHETIC_PRIVATE"));
    assert.deepEqual(child.kills, ["SIGTERM"]);
    child.emit("close", 1);
  }
  const child = fakeChild();
  const promise = runMailEnrollmentScript(accountArgs, { platform: "darwin", preflightImpl: approvedPreflight, spawnImpl: () => child, timeoutMs: 5 });
  await assert.rejects(promise, /timed out/);
  assert.deepEqual(child.kills, ["SIGTERM"]);
  child.emit("close", 1);
});

test("runner redacts native failed/invalid response and synchronous process failures", async () => {
  for (const [output, code] of [["SYNTHETIC_PRIVATE_NATIVE", 1], ["SYNTHETIC_PRIVATE_INVALID_JSON", 0], [JSON.stringify({ ...accountsResult, target: "OUTSIDE" }), 0]]) {
    const child = fakeChild();
    const promise = runMailEnrollmentScript(accountArgs, { platform: "darwin", preflightImpl: approvedPreflight, spawnImpl: () => child });
    await Promise.resolve();
    child.stderr.emit("data", "SYNTHETIC_PRIVATE_STDERR");
    child.stdout.emit("data", output);
    child.emit("close", code);
    await assert.rejects(promise, (error) => !error.message.includes("SYNTHETIC_PRIVATE"));
  }
  await assert.rejects(runMailEnrollmentScript(accountArgs, { platform: "darwin", preflightImpl: approvedPreflight, spawnImpl: () => { throw new Error("SYNTHETIC_PRIVATE_SPAWN"); } }), (error) => !error.message.includes("SYNTHETIC_PRIVATE"));
});

test("private scope is a fresh owner-only file with no raw response fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mail-enrollment-synthetic-"));
  try {
    const output = join(directory, "scope.json");
    await writePrivateMailScope(output, { ...mailboxesResult, secret: "DO_NOT_SAVE" }, mailboxArgs);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    const saved = JSON.parse(await readFile(output, "utf8"));
    assert.equal(saved.mailboxes[0].id, deriveMailMailboxId(accountId, path));
    assert.equal(saved.secret, undefined);
    const original = await readFile(output, "utf8");
    await assert.rejects(writePrivateMailScope(output, mailboxesResult, mailboxArgs));
    assert.equal(await readFile(output, "utf8"), original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("private output directory requires current OS owner and 0700 permissions", () => {
  const fixture = { uid: 1234, mode: 0o40700, isDirectory: () => true };
  assert.doesNotThrow(() => validatePrivateMailOutputDirectory(fixture, 1234));
  for (const info of [{ ...fixture, uid: 9999 }, { ...fixture, mode: 0o40755 }, { ...fixture, mode: 0o40770 }, { ...fixture, mode: 0o40500 }, { ...fixture, isDirectory: () => false }]) assert.throws(() => validatePrivateMailOutputDirectory(info, 1234));
  assert.throws(() => validatePrivateMailOutputDirectory(fixture, null));
});

test("shared/public parent directory refuses enrollment before metadata lookup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mail-enrollment-synthetic-"));
  try {
    await chmod(directory, 0o755);
    let queried = false;
    const options = { mode: "metadata-account", binDir: "/synthetic/bin", outputPath: join(directory, "scope.json") };
    await assert.rejects(enrollMailScope(options, { resolveAccessCli: async () => "/synthetic/bin/mail-access-cli", runScript: async () => { queried = true; return accountsResult; } }));
    assert.equal(queried, false);
    await assert.rejects(writePrivateMailScope(options.outputPath, accountsResult, accountArgs));
    await chmod(directory, 0o700);
    await writePrivateMailScope(options.outputPath, accountsResult, accountArgs);
    assert.equal((await stat(options.outputPath)).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("private output rejects checkout paths, other Git worktrees and symlink/overwrite targets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mail-enrollment-synthetic-"));
  try {
    const checkout = fileURLToPath(new URL("..", import.meta.url));
    const repo = join(directory, "other-repo");
    await mkdir(repo, { mode: 0o700 });
    await writeFile(join(repo, ".git"), "gitdir: synthetic\n");
    const existing = join(directory, "existing.json");
    await writeFile(existing, "SYNTHETIC_EXISTING");
    const symlinkFile = join(directory, "scope-link.json");
    await symlink(existing, symlinkFile);
    const symlinkDir = join(directory, "checkout-link");
    await symlink(checkout, symlinkDir);
    for (const output of [join(checkout, "SYNTHETIC-DO-NOT-CREATE.json"), join(repo, "scope.json"), symlinkFile, join(symlinkDir, "SYNTHETIC-DO-NOT-CREATE.json"), "relative.json"]) await assert.rejects(writePrivateMailScope(output, mailboxesResult, mailboxArgs));
    assert.equal(await readFile(existing, "utf8"), "SYNTHETIC_EXISTING");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("top-level enrollment validates paths first, redacts failures and returns counts without IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mail-enrollment-synthetic-"));
  try {
    let queries = 0, saved;
    const options = { mode: "select-mailboxes", accountId, mailboxPaths: [path], binDir: "/synthetic/bin", outputPath: join(directory, "scope.json") };
    const dependencies = { resolveAccessCli: async () => "/synthetic/bin/mail-access-cli", runScript: async () => { queries += 1; return mailboxesResult; }, writePrivate: async (_path, metadata) => { saved = metadata; } };
    const receipt = await enrollMailScope(options, dependencies);
    assert.deepEqual(receipt, { success: true, mode: "select-mailboxes", privateScopeWritten: true, count: 1 });
    assert.ok(!JSON.stringify(receipt).includes(accountId));
    assert.equal(saved.mailboxes[0].id, deriveMailMailboxId(accountId, path));
    await assert.rejects(enrollMailScope({ ...options, outputPath: join(directory, "missing-SYNTHETIC_PRIVATE", "scope.json") }, dependencies), (error) => !error.message.includes("SYNTHETIC_PRIVATE"));
    assert.equal(queries, 1);
    await assert.rejects(enrollMailScope(options, { ...dependencies, writePrivate: async () => { throw new Error("SYNTHETIC_PRIVATE_WRITE"); } }), (error) => !error.message.includes("SYNTHETIC_PRIVATE"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("production enrollment cannot select an arbitrary helper binary directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mail-enrollment-synthetic-"));
  try {
    let queried = false;
    await assert.rejects(enrollMailScope({ mode: "metadata-account", binDir: directory, outputPath: join(directory, "scope.json") }, { runScript: async () => { queried = true; return accountsResult; } }));
    assert.equal(queried, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
