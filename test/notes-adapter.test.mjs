import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { loadNotesConfig, validateNotesConfig } from "../lib/notes-config.js";
import { buildNotesInvocation, checkNotesAccess, createNotesAdapter, notesTextToHTML, runNotesScript } from "../lib/notes.js";
import { NOTES_APPLESCRIPT } from "../lib/notes-script.js";
import { handleNotes } from "../lib/handlers/notes.js";
import { buildNotesTestEnrollmentArguments, enrollNotesTestScope, NOTES_TEST_ENROLLMENT_APPLESCRIPT, runNotesTestEnrollmentScript, writePrivateNotesTestScope } from "../scripts/enroll-notes-test-scope.mjs";
import { mkdtemp, readFile, stat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnProcess } from "../lib/safe-shell.js";

const env = { APPLE_PIM_CONFIG_DIR: "/synthetic/config" };
const scope = { enabled: true, accounts: ["account-test"], folders: ["folder-test"], allowWrites: false };
const note = { id: "note-test", title: "Synthetic note", accountId: "account-test", folderId: "folder-test", locked: false, attachmentsOmitted: false };
const readArgs = { action: "get", id: "note-test" };
const writeArgs = { action: "create", accountId: "account-test", folderId: "folder-test", title: "Synthetic title", text: "Synthetic text" };
const approvedPreflight = async () => ({ success: true, target: "com.apple.Notes", authorized: true, prompted: false, authorization: "authorized" });
const uniqueFolderTitle = "Apple PIM Connector Tests SYNTHETIC-123";

function fixture(options = {}) {
  const calls = [];
  const config = options.config ?? { notes: scope };
  const adapter = createNotesAdapter({
    env: options.env ?? env,
    readFileImpl: options.readFileImpl ?? (async () => JSON.stringify(config)),
    runScript: async (argv) => {
      calls.push(argv);
      return options.result ?? { success: true, note: { ...note, text: "Synthetic text", truncated: false } };
    },
  });
  return { ...adapter, calls };
}

test("missing explicit config directory, file, or disabled Notes denies before the runner", async () => {
  for (const options of [{ env: {} }, { env: { APPLE_PIM_CONFIG_DIR: "relative/path" } }, { readFileImpl: async () => { throw new Error("missing"); } }, { config: {} }, { config: { notes: { ...scope, enabled: false } } }]) {
    const adapter = fixture(options);
    await assert.rejects(adapter.runNotes(readArgs));
    assert.equal(adapter.calls.length, 0);
  }
});

test("malformed and oversized config fail closed without exposing file contents", async () => {
  for (const raw of ["not JSON", "null", "[]", "x".repeat(65537)]) {
    const adapter = fixture({ readFileImpl: async () => raw });
    await assert.rejects(adapter.runNotes(readArgs), /configuration/i);
    assert.equal(adapter.calls.length, 0);
  }
});

test("both nonempty exact ID allowlists are mandatory and immutable", () => {
  for (const patch of [{ accounts: [] }, { folders: [] }, { accounts: ["*"] }, { folders: [" folder-test "] }, { accounts: ["account-test", "account-test"] }, { folders: ["folder\0test"] }, { allowWrites: "true" }]) {
    assert.throws(() => validateNotesConfig({ notes: { ...scope, ...patch } }));
  }
  const validated = validateNotesConfig({ notes: scope });
  assert.equal(validated.allowWrites, false);
  assert.ok(Object.isFrozen(validated.accounts));
});

test("Notes rejects environment and per-call profile/config overrides", async () => {
  for (const [options, args] of [[{ env: { ...env, APPLE_PIM_PROFILE: "synthetic" } }, readArgs], [{}, { ...readArgs, profile: "synthetic" }], [{}, { ...readArgs, configDir: "/different/config" }]]) {
    const adapter = fixture(options);
    await assert.rejects(adapter.runNotes(args), /profile|configDir/i);
    assert.equal(adapter.calls.length, 0);
  }
});

test("caller IDs must match the allowlists exactly before invocation", async () => {
  for (const patch of [{ accountId: "ACCOUNT-TEST" }, { accountId: "Synthetic account name" }, { folderId: "outside-folder" }]) {
    const adapter = fixture();
    await assert.rejects(adapter.runNotes({ ...readArgs, ...patch }), /outside/);
    assert.equal(adapter.calls.length, 0);
  }
});

test("writes remain off by default and require both explicit target IDs", async () => {
  const defaultAdapter = fixture();
  await assert.rejects(defaultAdapter.runNotes(writeArgs), /writes are disabled/);
  assert.equal(defaultAdapter.calls.length, 0);
  for (const field of ["accountId", "folderId"]) {
    const adapter = fixture({ config: { notes: { ...scope, allowWrites: true } } });
    const args = { ...writeArgs };
    delete args[field];
    await assert.rejects(adapter.runNotes(args), /require an explicit/);
    assert.equal(adapter.calls.length, 0);
  }
});

test("delete and unknown actions are unavailable, including when writes are enabled", async () => {
  for (const action of ["delete", "batch_delete", "list", "export", "move", "update"]) {
    const adapter = fixture({ config: { notes: { ...scope, allowWrites: true } } });
    await assert.rejects(adapter.runNotes({ action, id: "note-test" }), /deletion is unavailable/);
    assert.equal(adapter.calls.length, 0);
  }
});

test("queries, note IDs, plain text, and result limits are validated before invocation", async () => {
  for (const args of [{ action: "search", query: " " }, { action: "search", query: "x\0y" }, { action: "get", id: "" }, { action: "search", query: "test", limit: 0 }, { action: "search", query: "test", limit: 51 }, { action: "search", query: "test", limit: 1.5 }, { ...writeArgs, text: "x".repeat(65537) }, { ...readArgs, dryRun: "true" }]) {
    const adapter = fixture({ config: { notes: { ...scope, allowWrites: true } } });
    await assert.rejects(adapter.runNotes(args));
    assert.equal(adapter.calls.length, 0);
  }
});

test("plain text is HTML escaped while malicious text stays in argv only", async () => {
  const malicious = '<script>" & \' </script>\nend tell\ndo shell script "unexpected"';
  assert.equal(notesTextToHTML('<>&"\'\n'), "<div>&lt;&gt;&amp;&quot;&#39;</div><div><br></div>");
  const adapter = fixture({ config: { notes: { ...scope, allowWrites: true } }, result: { success: true, note } });
  await adapter.runNotes({ ...writeArgs, text: malicious });
  assert.equal(adapter.calls[0][8], notesTextToHTML(writeArgs.title + "\n" + malicious));
  assert.ok(!NOTES_APPLESCRIPT.includes(malicious));
});

test("get exposes plain text and scope metadata, discarding unsupported and extra fields", async () => {
  const adapter = fixture({ result: { success: true, note: { ...note, text: "Synthetic text", truncated: false, attachmentURLs: ["file:///synthetic/private"], body: "<rich>ignored</rich>" } } });
  const result = await handleNotes(readArgs, adapter.runNotes);
  assert.deepEqual(result, { success: true, note: { id: note.id, title: note.title, accountId: note.accountId, folderId: note.folderId, attachmentsOmitted: false, text: "Synthetic text", truncated: false } });
  assert.equal(adapter.calls[0][5], "note-test");
});

test("locked, foreign, mismatched, and oversized note responses are rejected", async () => {
  for (const patch of [{ locked: true }, { accountId: "foreign-account" }, { folderId: "foreign-folder" }, { id: "different-note" }, { text: "x".repeat(32769) }]) {
    const adapter = fixture({ result: { success: true, note: { ...note, text: "Synthetic text", truncated: false, ...patch } } });
    await assert.rejects(adapter.runNotes(readArgs), /locked|scope|ID|size limit/);
  }
});

test("search returns metadata only, allows no matches, and enforces bounds and unambiguous IDs", async () => {
  const empty = fixture({ result: { success: true, notes: [], limitReached: false } });
  assert.deepEqual(await empty.runNotes({ action: "search", query: "synthetic" }), { success: true, notes: [], limitReached: false });
  const metadata = fixture({ result: { success: true, notes: [{ ...note, text: "not emitted" }], limitReached: true } });
  assert.equal((await metadata.runNotes({ action: "search", query: "synthetic", limit: 1 })).notes[0].text, undefined);
  for (const [notes, limit] of [[[note, { ...note, id: "note-other" }], 1], [[note, note], 2], [[{ ...note, locked: true }], 1]]) {
    const adapter = fixture({ result: { success: true, notes, limitReached: false } });
    await assert.rejects(adapter.runNotes({ action: "search", query: "synthetic", limit }));
  }
});

test("explicit narrower scopes are checked on responses as well as requests", async () => {
  const adapter = fixture({ config: { notes: { ...scope, accounts: ["account-test", "account-other"] } }, result: { success: true, note: { ...note, accountId: "account-other", text: "Synthetic text", truncated: false } } });
  await assert.rejects(adapter.runNotes({ ...readArgs, accountId: "account-test" }), /scope/);
});

test("append encodes plain text without reading or writing attachment data", async () => {
  const adapter = fixture({ config: { notes: { ...scope, allowWrites: true } }, result: { success: true, note } });
  await adapter.runNotes({ action: "append", accountId: "account-test", folderId: "folder-test", id: "note-test", text: "<synthetic>" });
  assert.equal(adapter.calls[0][8], "<div>&lt;synthetic&gt;</div>");
  const rejected = fixture({ config: { notes: { ...scope, allowWrites: true } }, result: { success: true, note: { ...note, attachmentsOmitted: true } } });
  await assert.rejects(rejected.runNotes({ action: "append", accountId: "account-test", folderId: "folder-test", id: "note-test", text: "Synthetic text" }), /attachments/);
});

test("dryRun validates config and write scope, then does not start the runner", async () => {
  const adapter = fixture({ config: { notes: { ...scope, allowWrites: true } } });
  const result = await adapter.runNotes({ ...writeArgs, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.match(result.scopeResolution, /not run/);
  assert.equal(adapter.calls.length, 0);
  const disabled = fixture();
  await assert.rejects(disabled.runNotes({ ...writeArgs, dryRun: true }), /writes are disabled/);
  assert.equal(disabled.calls.length, 0);
});

test("config reload denies subsequent calls when a previously enabled scope is revoked", async () => {
  let enabled = true;
  const adapter = fixture({ readFileImpl: async () => JSON.stringify({ notes: { ...scope, enabled } }) });
  await adapter.runNotes(readArgs);
  enabled = false;
  await assert.rejects(adapter.runNotes(readArgs), /disabled/);
  assert.equal(adapter.calls.length, 1);
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = (script) => { child.script = script; };
  child.kills = [];
  child.kill = (signal) => { child.kills.push(signal); };
  return child;
}

test("native runner uses a fixed stdin script, explicit argv, and no shell", async () => {
  const child = fakeChild();
  let invocation;
  const argv = buildNotesInvocation({ action: "search", query: '"; synthetic' }, validateNotesConfig({ notes: scope }));
  const promise = runNotesScript(argv, { platform: "darwin", preflightImpl: approvedPreflight, spawnImpl: (...args) => { invocation = args; return child; } });
  await Promise.resolve();
  assert.equal(invocation[0], "/usr/bin/osascript");
  assert.deepEqual(invocation[1], ["-l", "AppleScript", "-", ...argv]);
  assert.equal(invocation[2].shell, false);
  assert.equal(child.script, NOTES_APPLESCRIPT);
  child.stdout.emit("data", '{"success":true,"notes":[],"limitReached":false}');
  child.emit("close", 0);
  assert.equal((await promise).success, true);
});

test("native runner bounds time/output and does not leak AppleScript stderr", async () => {
  const oversized = fakeChild();
  const tooBig = runNotesScript(["get"], { platform: "darwin", preflightImpl: approvedPreflight, spawnImpl: () => oversized });
  await Promise.resolve();
  oversized.stdout.emit("data", "x".repeat(262145));
  await assert.rejects(tooBig, /size limit/);
  assert.deepEqual(oversized.kills, ["SIGTERM"]);
  oversized.emit("close", null);
  const timed = fakeChild();
  await assert.rejects(runNotesScript(["append"], { platform: "darwin", preflightImpl: approvedPreflight, spawnImpl: () => timed, timeoutMs: 1 }), /timed out.*outcome may be unknown/);
  timed.emit("close", null);
  const failed = fakeChild();
  const failure = runNotesScript(["get"], { platform: "darwin", preflightImpl: approvedPreflight, spawnImpl: () => failed });
  await Promise.resolve();
  failed.stderr.emit("data", "SYNTHETIC_PRIVATE_DIAGNOSTIC");
  failed.emit("close", 1);
  await assert.rejects(failure, (error) => !error.message.includes("SYNTHETIC_PRIVATE_DIAGNOSTIC"));
});

test("native runner refuses unsupported platforms without spawning", async () => {
  let called = false;
  await assert.rejects(runNotesScript(["get"], { platform: "linux", spawnImpl: () => { called = true; } }), /macOS/);
  assert.equal(called, false);
});

test("missing or refused permission preflight prevents the osascript spawn", async () => {
  let spawned = false;
  await assert.rejects(runNotesScript(["get"], { platform: "darwin", spawnImpl: () => { spawned = true; } }), /preflight is unavailable/);
  assert.equal(spawned, false);
  await assert.rejects(runNotesScript(["get"], { platform: "darwin", preflightImpl: async () => { throw new Error("not authorized"); }, spawnImpl: () => { spawned = true; } }), /not authorized/);
  assert.equal(spawned, false);
});

test("permission preflight accepts only explicit already-granted, non-prompted Notes status", async () => {
  const granted = { success: true, target: "com.apple.Notes", authorized: true, prompted: false, authorization: "authorized" };
  for (const patch of [{}, { authorized: false, authorization: "notDetermined" }, { authorization: "notRunning" }, { target: "different.app" }, { prompted: true }]) {
    const child = fakeChild();
    let invocation;
    const promise = checkNotesAccess({ platform: "darwin", accessCliPath: "/synthetic/bin/notes-access-cli", spawnImpl: (...args) => { invocation = args; return child; } });
    assert.deepEqual(invocation[1], ["status"]);
    assert.equal(invocation[2].shell, false);
    child.stdout.emit("data", JSON.stringify({ ...granted, ...patch }));
    child.emit("close", 0);
    if (Object.keys(patch).length === 0) assert.equal((await promise).authorized, true);
    else await assert.rejects(promise, /existing Automation grant/);
  }
});

test("fixed script contains scoped lookup and rich/locked/attachment rejection paths", () => {
  const statements = NOTES_APPLESCRIPT.replace(/^\s*--.*$/gmu, "");
  assert.ok(statements.includes("every note of targetFolder whose id is requestedNote"));
  assert.ok(!statements.includes("every note of application"));
  assert.ok(!statements.includes("default account"));
  assert.ok(statements.includes("password protected of targetNote"));
  assert.ok(statements.includes("count of attachments of targetNote"));
  assert.ok(statements.includes("plainAppendAllowed(oldHTML)"));
  assert.ok(statements.includes("isEqualToString"));
});

test("fresh membership checks query exact IDs inside resolved folders without note.container", () => {
  const statements = NOTES_APPLESCRIPT.replace(/^\s*--.*$/gmu, "");
  const resolver = statements.match(/on resolveScopedNote\(noteID, scopedFolder\)[\s\S]*?end resolveScopedNote/u)?.[0];
  assert.ok(resolver);
  assert.ok(resolver.includes("every note of scopedFolder whose id is noteID"));
  assert.ok(resolver.includes("my exactText(id of candidateNote, noteID)"));
  assert.ok(resolver.includes("(count of exactMatches) is not 1"));
  assert.ok(!/id of container|container of/u.test(statements));
  assert.ok(!/every note of (?:application|me)|note id requestedNote/u.test(statements));
});

test("search and response reads resolve membership before protected content fields", () => {
  const statements = NOTES_APPLESCRIPT.replace(/^\s*--.*$/gmu, "");
  const resultHandler = statements.match(/on resultNote\(theNote, accountID, folderID, scopedFolder, includeText\)[\s\S]*?end resultNote/u)?.[0];
  assert.ok(resultHandler);
  const resultGuard = resultHandler.indexOf("set resolvedNote to my resolveScopedNote");
  assert.ok(resultGuard >= 0 && resultGuard < resultHandler.indexOf("set noteTitle to name of resolvedNote"));
  assert.ok(resultGuard < resultHandler.indexOf("set notePlainText to plaintext of resolvedNote"));
  const searchGuard = statements.indexOf("set scopedSearchNote to my resolveScopedNote(id of theNote, targetFolder)");
  assert.ok(searchGuard >= 0 && searchGuard < statements.indexOf("set searchableText to (name of scopedSearchNote)"));
  assert.ok(statements.includes("scopeFolderIDs, targetFolder, false)"));
});

test("get and append retain each matching folder ref and recheck it before data and mutation", () => {
  const statements = NOTES_APPLESCRIPT.replace(/^\s*--.*$/gmu, "");
  assert.ok(statements.includes("set end of matchFolders to targetFolder"));
  assert.ok(statements.includes("set matchedFolder to item 1 of matchFolders"));
  const firstGuard = statements.indexOf("set targetNote to my resolveScopedNote(requestedNote, matchedFolder)");
  assert.ok(firstGuard >= 0 && firstGuard < statements.indexOf("set oldHTML to body of targetNote"));
  const writeGuard = statements.indexOf("set targetNote to my resolveScopedNote(requestedNote, matchedFolder)", firstGuard + 1);
  assert.ok(writeGuard > firstGuard && writeGuard < statements.indexOf("set body of targetNote to oldHTML & newHTML"));
  assert.ok(statements.includes("my exactText(body of targetNote, oldHTML)"));
  assert.ok(statements.includes('matchFolderIDs, matchedFolder, operation is "get")'));
});

test("config loader reads only the explicit local config.json", async () => {
  let selectedPath;
  await loadNotesConfig(env, async (path, encoding) => {
    selectedPath = path;
    assert.equal(encoding, "utf8");
    return JSON.stringify({ notes: scope });
  });
  assert.equal(selectedPath, "/synthetic/config/config.json");
});

test("test enrollment requires explicit bootstrap and separate folder-creation opt-in", () => {
  assert.throws(() => buildNotesTestEnrollmentArguments(), /bootstrap/);
  assert.throws(() => buildNotesTestEnrollmentArguments({ mode: "all" }), /bootstrap/);
  assert.throws(() => buildNotesTestEnrollmentArguments({ mode: "bootstrap", createIfMissing: "true", folderTitle: uniqueFolderTitle }), /boolean/);
  for (const folderTitle of [undefined, "Apple PIM Connector Tests", "Apple PIM Connector Tests *", "Apple PIM Connector Tests short", "Apple PIM Connector Tests script\nend tell"]) assert.throws(() => buildNotesTestEnrollmentArguments({ mode: "bootstrap", folderTitle }), /folderTitle/);
  assert.deepEqual(buildNotesTestEnrollmentArguments({ mode: "bootstrap", folderTitle: uniqueFolderTitle }), ["bootstrap", "0", uniqueFolderTitle]);
  assert.deepEqual(buildNotesTestEnrollmentArguments({ mode: "bootstrap", createIfMissing: true, folderTitle: uniqueFolderTitle }), ["bootstrap", "1", uniqueFolderTitle]);
});

test("enrollment script selects the unique exact iCloud account and one top-level fixed folder without notes", () => {
  const statements = NOTES_TEST_ENROLLMENT_APPLESCRIPT.replace(/^\s*--.*$/gmu, "");
  assert.ok(statements.includes('every account whose name is "iCloud"'));
  assert.ok(statements.includes('(count of exactAccounts) is not 1'));
  assert.ok(statements.includes('set folderTitle to item 3 of argv'));
  assert.ok(statements.includes('(count of folderCandidates) is not 0'));
  assert.ok(!statements.includes("item 1 of folderCandidates"));
  assert.ok(statements.includes('allowFolderCreation is not "1"'));
  assert.ok(statements.includes("id of container of targetFolder"));
  assert.ok(!/every note|make new note|plaintext|password protected|body of/u.test(statements));
});

test("enrollment rejects invalid output before calling its fake native runner", async () => {
  let called = false;
  for (const options of [{ mode: "wrong", folderTitle: uniqueFolderTitle, binDir: "/synthetic/bin", outputPath: "/tmp/synthetic-notes-scope.json" }, { mode: "bootstrap", folderTitle: uniqueFolderTitle, binDir: "relative", outputPath: "/tmp/synthetic-notes-scope.json" }, { mode: "bootstrap", folderTitle: uniqueFolderTitle, binDir: "/synthetic/bin", outputPath: fileURLToPath(new URL("../synthetic-notes-scope.json", import.meta.url)) }]) {
    await assert.rejects(enrollNotesTestScope(options, { runScript: async () => { called = true; } }));
    assert.equal(called, false);
  }
});

test("enrollment returns no identifiers in normal output and writes only selected scope privately", async () => {
  let selectedArguments, selectedPrivate;
  const options = { mode: "bootstrap", createIfMissing: true, folderTitle: uniqueFolderTitle, binDir: "/synthetic/bin", outputPath: "/tmp/apple-pim-synthetic-enrollment-output-test.json" };
  const result = await enrollNotesTestScope(options, {
    runScript: async (args) => { selectedArguments = args; return { accountId: "account-test", folderId: "folder-test", createdFolder: true }; },
    writePrivate: async (path, scope) => { selectedPrivate = { path, scope }; },
  });
  assert.deepEqual(selectedArguments, ["bootstrap", "1", uniqueFolderTitle]);
  assert.deepEqual(result, { success: true, createdFolder: true, privateScopeWritten: true });
  assert.ok(!JSON.stringify(result).includes("account-test"));
  assert.deepEqual(selectedPrivate, { path: options.outputPath, scope: { accountId: "account-test", folderId: "folder-test", createdFolder: true } });
});

test("private output failure after folder creation reports unknown outcome and prevents automatic retry", async () => {
  const options = { mode: "bootstrap", createIfMissing: true, folderTitle: uniqueFolderTitle, binDir: "/synthetic/bin", outputPath: "/tmp/apple-pim-synthetic-enrollment-output-failure-test.json" };
  let creationCalls = 0, privateWrites = 0;
  await assert.rejects(enrollNotesTestScope(options, {
    runScript: async () => { creationCalls += 1; return { accountId: "account-test", folderId: "folder-test", createdFolder: true }; },
    writePrivate: async () => { privateWrites += 1; throw new Error("SYNTHETIC_PRIVATE_FILE_ERROR"); },
  }), (error) => {
    assert.equal(error.code, "NOTES_ENROLLMENT_OUTCOME_UNKNOWN");
    assert.match(error.message, /folder creation outcome may be unknown/);
    assert.match(error.message, /Do not retry automatically/);
    assert.match(error.message, /private scope output may be incomplete/);
    assert.ok(!error.message.includes("SYNTHETIC_PRIVATE_FILE_ERROR"));
    assert.ok(!error.message.includes("account-test"));
    return true;
  });
  assert.equal(creationCalls, 1);
  assert.equal(privateWrites, 1);
});

test("failed creation response also reports unknown outcome without writing or retrying", async () => {
  let calls = 0, writes = 0;
  await assert.rejects(enrollNotesTestScope({ mode: "bootstrap", createIfMissing: true, folderTitle: uniqueFolderTitle, binDir: "/synthetic/bin", outputPath: "/tmp/apple-pim-synthetic-enrollment-native-failure-test.json" }, {
    runScript: async () => { calls += 1; throw new Error("Synthetic missing response after mutation"); },
    writePrivate: async () => { writes += 1; },
  }), /folder creation outcome may be unknown.*Do not retry automatically/);
  assert.equal(calls, 1);
  assert.equal(writes, 0);
});

test("private enrollment file is exclusive mode 0600 and refuses overwrite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apple-pim-notes-synthetic-"));
  const path = join(directory, "scope.json");
  const scope = { accountId: "account-test", folderId: "folder-test", createdFolder: false };
  try {
    await writePrivateNotesTestScope(path, scope);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), scope);
    await assert.rejects(writePrivateNotesTestScope(path, scope), /cannot overwrite/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("native enrollment uses fixed stdin/argv and no shell only after permission preflight", async () => {
  const child = fakeChild();
  let invocation;
  const promise = runNotesTestEnrollmentScript(["bootstrap", "0", uniqueFolderTitle], { platform: "darwin", preflightImpl: approvedPreflight, spawnImpl: (...args) => { invocation = args; return child; } });
  await Promise.resolve();
  assert.deepEqual(invocation.slice(0, 2), ["/usr/bin/osascript", ["-l", "AppleScript", "-", "bootstrap", "0", uniqueFolderTitle]]);
  assert.equal(invocation[2].shell, false);
  assert.equal(child.script, NOTES_TEST_ENROLLMENT_APPLESCRIPT);
  child.stdout.emit("data", JSON.stringify({ success: true, target: "com.apple.Notes", accountId: "account-test", folderId: "folder-test", createdFolder: false, extra: "ignored" }));
  child.emit("close", 0);
  assert.deepEqual(await promise, { accountId: "account-test", folderId: "folder-test", createdFolder: false });
  let spawned = false;
  await assert.rejects(runNotesTestEnrollmentScript(["bootstrap", "0", uniqueFolderTitle], { platform: "darwin", preflightImpl: async () => { throw new Error("not granted"); }, spawnImpl: () => { spawned = true; } }), /not granted/);
  assert.equal(spawned, false);
});

function runDataFreeFoundationScript(script) {
  // These fixtures execute only Foundation JSON creation: no app, file, shell,
  // or system permission operations are allowed in the extracted statements.
  assert.ok(!/tell application|do shell script|make new|plaintext|body of/u.test(script));
  return new Promise((resolve, reject) => {
    const child = spawnProcess("/usr/bin/osascript", ["-l", "AppleScript", "-"], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Data-free Foundation fixture timed out")); }, 5000);
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) { reject(new Error(stderr || "Foundation fixture failed")); return; }
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
    child.stdin.end(script);
  });
}

test("enrollment response survives successive Foundation setters without the implicit result variable", { skip: process.platform !== "darwin" }, async () => {
  const jsonHelper = NOTES_TEST_ENROLLMENT_APPLESCRIPT.match(/on jsonText\(value\)[\s\S]*?end jsonText/u)?.[0];
  const emitter = NOTES_TEST_ENROLLMENT_APPLESCRIPT.match(/  set responsePayload to current application's NSMutableDictionary's dictionary\(\)[\s\S]*?  return my jsonText\(responsePayload\)/u)?.[0];
  assert.ok(jsonHelper && emitter);
  const fixture = `use framework "Foundation"\n${jsonHelper}\non run\nset targetAccountID to "account-test"\nset targetFolderID to "folder-test"\nset createdFolder to true\n${emitter}\nend run\n`;
  assert.deepEqual(await runDataFreeFoundationScript(fixture), { success: true, target: "com.apple.Notes", accountId: "account-test", folderId: "folder-test", createdFolder: true });
});

test("production note response survives successive Foundation setters with synthetic content", { skip: process.platform !== "darwin" }, async () => {
  const jsonHelper = NOTES_APPLESCRIPT.match(/on jsonText\(value\)[\s\S]*?end jsonText/u)?.[0];
  const initializer = NOTES_APPLESCRIPT.match(/set responsePayload to current application's NSMutableDictionary's dictionary\(\)\n\s*responsePayload's setObject:true forKey:"success"/u)?.[0];
  const emitter = NOTES_APPLESCRIPT.match(/responsePayload's setObject:entry forKey:"note"\n\s*return my jsonText\(responsePayload\)/u)?.[0];
  assert.ok(jsonHelper && initializer && emitter);
  const fixture = `use framework "Foundation"\n${jsonHelper}\non run\nset entry to current application's NSMutableDictionary's dictionary()\nentry's setObject:"note-test" forKey:"id"\n${initializer}\n${emitter}\nend run\n`;
  assert.deepEqual(await runDataFreeFoundationScript(fixture), { success: true, note: { id: "note-test" } });
});

function runOfflineScriptTool(command, args) {
  assert.ok(command === "/usr/bin/osacompile" || command === "/usr/bin/osadecompile");
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Offline AppleScript syntax tool timed out")); }, 5000);
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) { reject(new Error(stderr || "Offline syntax tool failed")); return; }
      resolve(stdout);
    });
  });
}

test("Notes dictionary compilation preserves notePlainText as a local variable rather than readonly plaintext", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "apple-pim-notes-dictionary-synthetic-"));
  const sourcePath = join(directory, "source.applescript"), compiledPath = join(directory, "source.scpt");
  try {
    // Compilation/decompilation never invokes this handler or sends Notes an
    // event. The installed dictionary demonstrates its case-insensitive term.
    const currentAssignment = NOTES_APPLESCRIPT.match(/if includeText then set notePlainText to plaintext of resolvedNote/u)?.[0];
    assert.ok(currentAssignment);
    const script = `on syntheticDictionaryCheck(resolvedNote, includeText)\ntell application "/System/Applications/Notes.app"\n${currentAssignment}\nend tell\nend syntheticDictionaryCheck\n`;
    await writeFile(sourcePath, script, "utf8");
    await runOfflineScriptTool("/usr/bin/osacompile", ["-l", "AppleScript", "-o", compiledPath, sourcePath]);
    const decompiled = await runOfflineScriptTool("/usr/bin/osadecompile", [compiledPath]);
    assert.match(decompiled, /set notePlainText to plaintext of resolvedNote/u);
    assert.ok(!/set plaintext to/iu.test(decompiled));
    // Negative control: only compile, never execute the failing assignment.
    await writeFile(sourcePath, script.replace("set notePlainText to", "set plainText to"), "utf8");
    await runOfflineScriptTool("/usr/bin/osacompile", ["-l", "AppleScript", "-o", compiledPath, sourcePath]);
    const collision = await runOfflineScriptTool("/usr/bin/osadecompile", [compiledPath]);
    assert.match(collision, /set plaintext to plaintext of resolvedNote/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("production assignment names do not collide with single-word Notes dictionary properties", { skip: process.platform !== "darwin" }, async () => {
  const dictionary = await readFile("/System/Applications/Notes.app/Contents/Resources/Notes.sdef", "utf8");
  const propertyNames = new Set([...dictionary.matchAll(/<property name="([A-Za-z]+)"/gu)].map((match) => match[1].toLowerCase()));
  const statements = NOTES_APPLESCRIPT.replace(/^\s*--.*$/gmu, "");
  for (const match of statements.matchAll(/\bset ([A-Za-z][A-Za-z0-9]*) to/gu)) assert.ok(!propertyNames.has(match[1].toLowerCase()), `Assignment ${match[1]} collides with a Notes property`);
});
