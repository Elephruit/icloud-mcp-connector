import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  CONTACTS_COMPANION_BUNDLE_ID,
  ContactsCompanionError,
  createContactsCompanionRunner,
} from "../lib/contacts-companion.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonFile = (path, value) => writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
const contact = { id: "synthetic-contact", firstName: "Synthetic", nickname: "Fixture", organization: "Example" };
const scope = { enabled: true, mode: "allowlist", items: ["synthetic-container"], accounts: ["synthetic-container"], allow_writes: true, allow_deletes: false };
const createArgs = { action: "create", container: "synthetic-container", firstName: "Synthetic" };
const runFile = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "icloud-mcp-contacts-fixture."));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const serviceRoot = join(home, "Library", "Application Support", "iCloud MCP Connector", "Contacts");
  const app = join(home, "Applications", "iCloud MCP Contacts.app");
  const executable = join(app, "Contents", "MacOS", "contacts-cli");
  const configDirectory = join(root, "private-config");
  const jobs = join(serviceRoot, "jobs");
  await mkdir(serviceRoot, { recursive: true, mode: 0o700 });
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true, mode: 0o700 });
  await mkdir(configDirectory, { mode: 0o700 });
  const binary = Buffer.from("Synthetic executable fixture; never executed.");
  await writeFile(executable, binary, { mode: 0o755 });
  await writeFile(join(app, "Contents", "Info.plist"), "Synthetic plist fixture; inspection is injected.", { mode: 0o644 });
  const bridge = { version: 1, enabled: true, configDirectory, executableSHA256: hash(binary) };
  await jsonFile(join(serviceRoot, "bridge.json"), bridge);
  await jsonFile(join(configDirectory, "config.json"), { contacts: scope });
  const calls = [];
  const inspections = [];
  async function emitReceipt(options, changes = {}) {
    const job = join(jobs, options.requestId);
    const request = JSON.parse(await readFile(join(job, "request.json"), "utf8"));
    if (!changes.skipClaim) await jsonFile(join(job, "claim.json"), { version: 1, requestId: options.requestId, ...changes.claim });
    if ((request.action !== "get" || changes.forceMutation) && !changes.skipMutation) {
      await jsonFile(join(job, "mutation-started.json"), { version: 1, requestId: options.requestId, action: request.action, ...changes.mutation });
    }
    const returnedContact = { ...contact, id: request.parameters.id ?? contact.id,
      ...(request.action === "get" ? { sourceContainerId: "synthetic-container" } : {}) };
    const response = { version: 1, requestId: options.requestId, action: request.action, success: true,
      result: { success: true, contact: returnedContact }, ...changes.response };
    const bytes = Buffer.from(`${JSON.stringify(response)}\n`);
    await writeFile(join(job, "response.json"), changes.responseBytes ?? bytes, { mode: 0o600 });
    if (!changes.skipCompletion) {
      await jsonFile(join(job, "completion.json"), { version: 1, requestId: options.requestId, action: request.action, responseSHA256: hash(changes.responseBytes ?? bytes), ...changes.completion });
    }
    return request;
  }
  const options = {
    env: { APPLE_PIM_CONFIG_DIR: configDirectory },
    homeDir: home,
    timeoutMs: 1000,
    inspectApp: async (paths) => { inspections.push(paths); return {
      bundleId: CONTACTS_COMPANION_BUNDLE_ID, executableName: "contacts-cli", packageType: "APPL", signatureValid: true,
    }; },
    launch: async (launchOptions) => { calls.push(launchOptions); await emitReceipt(launchOptions); },
  };
  return { root, home, serviceRoot, app, executable, configDirectory, jobs, bridge, calls, inspections, options, emitReceipt,
    run: (args, overrides = {}) => createContactsCompanionRunner({ ...options, ...overrides })(args) };
}

test("typed get/create/update retain correlated private journals and launch the fixed app once", async (t) => {
  const f = await fixture(t);
  for (const args of [{ action: "get", id: "synthetic-contact" }, createArgs, { action: "update", id: "synthetic-contact", nickname: "" }]) {
    const result = await f.run(args);
    assert.deepEqual(result, { success: true, contact: { ...contact,
      ...(args.action === "get" ? { sourceContainerId: "synthetic-container" } : {}) } });
    const call = f.calls.at(-1);
    assert.equal(call.appPath, f.inspections.at(-1).appPath);
    assert.match(call.requestId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(Object.keys(call).sort(), ["appPath", "requestId", "signal", "timeoutMs"]);
    const job = join(f.jobs, call.requestId);
    const request = JSON.parse(await readFile(join(job, "request.json"), "utf8"));
    const { action, ...parameters } = args;
    assert.deepEqual(request, { version: 1, requestId: call.requestId, action, parameters });
    assert.equal((await lstat(job)).mode & 0o777, 0o700);
    for (const filename of ["request.json", "claim.json", "response.json", "completion.json"]) {
      assert.equal((await lstat(join(job, filename))).mode & 0o777, 0o600);
    }
    if (action !== "get") assert.equal((await lstat(join(job, "mutation-started.json"))).mode & 0o777, 0o600);
  }
  assert.equal(f.calls.length, 3);
});

test("unknown actions, argument fields, types and unsupported cross-action fields deny before launching", async (t) => {
  const f = await fixture(t);
  const rejected = [null, [], { action: "delete", id: "synthetic-contact" }, { action: "search", query: "Synthetic" },
    ...["argv", "configDir", "profile", "path", "allow_writes", "email", "notes", "phone"].map((key) => ({ ...createArgs, [key]: "unsafe" })),
    { action: "get", id: "synthetic-contact", firstName: "Synthetic" }, { ...createArgs, id: "synthetic-contact" },
    { ...createArgs, firstName: null }, { ...createArgs, firstName: "" }, { ...createArgs, container: "" },
    { action: "update", id: "synthetic-contact" }, { action: "update", id: "synthetic-contact", nickname: "Fixture", container: "synthetic-container" },
    { action: "get", id: "synthetic-contact", dryRun: true }, { ...createArgs, dryRun: "true" },
    { ...createArgs, fields: "id" }, { ...createArgs, fields: ["__proto__"] }, { ...createArgs, fields: [1] }];
  for (const args of rejected) await assert.rejects(f.run(args), ContactsCompanionError);
  assert.equal(f.calls.length, 0);
  assert.equal(f.inspections.length, 0);
  await assert.rejects(readdir(f.jobs), { code: "ENOENT" });
});

test("IDs use a control-free UTF16 bound and text uses a UTF8 byte bound without NUL", async (t) => {
  const f = await fixture(t);
  for (const id of ["a\n", "a\x7f", "a\u0085", "a\u202e", " ", "x".repeat(2049), "😀".repeat(1025)]) {
    await assert.rejects(f.run({ action: "get", id }));
  }
  for (const firstName of ["a\0", "x".repeat(4097), "😀".repeat(1025)]) await assert.rejects(f.run({ ...createArgs, firstName }));
  await f.run({ ...createArgs, firstName: "😀".repeat(1024) });
  await f.run({ action: "get", id: "😀".repeat(1024) });
  assert.equal(f.calls.length, 2);
});

test("dryRun validates selected scope and typed arguments without bridge, inspection, or job creation", async (t) => {
  const f = await fixture(t);
  await rm(f.serviceRoot, { recursive: true });
  const preview = await f.run({ ...createArgs, dryRun: true, fields: ["id"] });
  assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.parameters, { container: "synthetic-container", firstName: "Synthetic" });
  assert.equal(f.calls.length, 0);
  assert.equal(f.inspections.length, 0);
  await assert.rejects(f.run({ ...createArgs, dryRun: true, argv: [] }));
  await jsonFile(join(f.configDirectory, "config.json"), { contacts: { ...scope, allow_writes: false } });
  await assert.rejects(f.run({ ...createArgs, dryRun: true }), /allow_writes/);
});

test("disabled, broad, incomplete or read-only scopes and unallowed destinations deny independently", async (t) => {
  const f = await fixture(t);
  for (const change of [{ enabled: false }, { mode: "all" }, { items: [] }, { accounts: [] }, { allow_writes: false }]) {
    await jsonFile(join(f.configDirectory, "config.json"), { contacts: { ...scope, ...change } });
    await assert.rejects(f.run(createArgs));
  }
  await jsonFile(join(f.configDirectory, "config.json"), { contacts: scope });
  await assert.rejects(f.run({ ...createArgs, container: "synthetic-other-container" }));
  await assert.rejects(f.run({ action: "get", id: "synthetic-contact" }, { env: { APPLE_PIM_CONFIG_DIR: f.configDirectory, APPLE_PIM_PROFILE: "alternate" } }));
  await assert.rejects(f.run(createArgs, { env: {} }));
  assert.equal(f.calls.length, 0);
});

test("a read-only exact scope allows get and fields preserves its contact wrapper and ID", async (t) => {
  const f = await fixture(t);
  await jsonFile(join(f.configDirectory, "config.json"), { contacts: { ...scope, allow_writes: false } });
  assert.deepEqual(await f.run({ action: "get", id: "synthetic-contact", fields: ["nickname"] }),
    { success: true, contact: { id: "synthetic-contact", nickname: "Fixture" } });
  const request = JSON.parse(await readFile(join(f.jobs, f.calls[0].requestId, "request.json"), "utf8"));
  assert.deepEqual(request.parameters, { id: "synthetic-contact" });
});

test("successful receipts require a bounded contact ID, exact get/update match, and allowed get container", async (t) => {
  const f = await fixture(t);
  for (const [args, returned] of [
    [{ action: "get", id: "synthetic-contact" }, { ...contact, id: "synthetic-other", sourceContainerId: "synthetic-container" }],
    [{ action: "update", id: "synthetic-contact", nickname: "Fixture" }, { ...contact, id: "synthetic-other" }],
    [createArgs, { ...contact, id: "" }],
    [{ action: "get", id: "synthetic-contact" }, contact],
    [{ action: "get", id: "synthetic-contact" }, { ...contact, sourceContainerId: "synthetic-other-container" }],
  ]) {
    await assert.rejects(f.run(args, { launch: async (options) => {
      f.calls.push(options);
      await f.emitReceipt(options, { response: { result: { success: true, contact: returned } } });
    } }), (error) => error.code === "COMPANION_RESULT_UNKNOWN");
  }
  assert.equal(f.calls.length, 5);
});

test("bridge must be exact, enabled, private, and bound to the selected private configuration", async (t) => {
  const f = await fixture(t);
  const bridgeFile = join(f.serviceRoot, "bridge.json");
  for (const change of [{ enabled: false }, { enabled: "true" }, { version: 2 }, { executableSHA256: "F".repeat(64) },
    { configDirectory: f.home }, { argv: [] }]) {
    await jsonFile(bridgeFile, { ...f.bridge, ...change });
    await assert.rejects(f.run(createArgs));
  }
  await jsonFile(bridgeFile, f.bridge);
  await chmod(bridgeFile, 0o644);
  await assert.rejects(f.run(createArgs));
  assert.equal(f.calls.length, 0);
});

test("private directories, symlinks, and app replacement are denied without launching", async (t) => {
  const f = await fixture(t);
  await chmod(f.configDirectory, 0o755);
  await assert.rejects(f.run(createArgs));
  await chmod(f.configDirectory, 0o700);
  const configFile = join(f.configDirectory, "config.json");
  await rm(configFile);
  const target = join(f.root, "synthetic-config.json");
  await jsonFile(target, { contacts: scope });
  await symlink(target, configFile);
  await assert.rejects(f.run(createArgs));
  await rm(configFile); await jsonFile(configFile, { contacts: scope });
  await mkdir(f.jobs, { mode: 0o755 });
  await assert.rejects(f.run(createArgs));
  await rm(f.jobs, { recursive: true });
  await writeFile(f.executable, "Changed synthetic executable");
  await assert.rejects(f.run(createArgs));
  assert.equal(f.calls.length, 0);
});

test("incorrect bundle identity and invalid code signature deny before job creation", async (t) => {
  const f = await fixture(t);
  const identity = { bundleId: CONTACTS_COMPANION_BUNDLE_ID, executableName: "contacts-cli", packageType: "APPL", signatureValid: true };
  for (const change of [{ bundleId: "synthetic.other.app" }, { signatureValid: false },
    { executableName: "synthetic-other-executable" }, { packageType: "BNDL" }]) {
    await assert.rejects(f.run(createArgs, { inspectApp: async () => ({ ...identity, ...change }) }));
  }
  assert.equal(f.calls.length, 0);
  await assert.rejects(readdir(f.jobs), { code: "ENOENT" });
});

test("FIFO configuration and executable fixtures fail promptly before launching", async (t) => {
  const f = await fixture(t);
  const configFile = join(f.configDirectory, "config.json");
  await rm(configFile);
  await runFile("/usr/bin/mkfifo", ["-m", "600", configFile], { env: { PATH: "/usr/bin:/bin", LANG: "C" } });
  await assert.rejects(f.run(createArgs), ContactsCompanionError);
  await rm(configFile); await jsonFile(configFile, { contacts: scope });
  await rm(f.executable);
  await runFile("/usr/bin/mkfifo", ["-m", "755", f.executable], { env: { PATH: "/usr/bin:/bin", LANG: "C" } });
  await assert.rejects(f.run(createArgs), ContactsCompanionError);
  assert.equal(f.calls.length, 0);
});

test("durable job collisions never overwrite or relaunch an existing request", async (t) => {
  const f = await fixture(t);
  const requestId = "11111111-1111-4111-8111-111111111111";
  await f.run(createArgs, { createRequestId: () => requestId });
  const original = await readFile(join(f.jobs, requestId, "request.json"), "utf8");
  await assert.rejects(f.run({ ...createArgs, firstName: "Different synthetic name" }, { createRequestId: () => requestId }), /exclusive job/);
  assert.equal(await readFile(join(f.jobs, requestId, "request.json"), "utf8"), original);
  assert.equal(f.calls.length, 1);
});

test("missing, mismatched, malformed or tampered receipts produce uncertainty without retry", async (t) => {
  const f = await fixture(t);
  const failures = [
    { skipClaim: true }, { claim: { requestId: "22222222-2222-4222-8222-222222222222" } },
    { skipCompletion: true }, { completion: { version: 2 } }, { completion: { action: "update" } },
    { completion: { responseSHA256: "0".repeat(64) } }, { response: { requestId: "22222222-2222-4222-8222-222222222222" } },
    { response: { success: "true" } }, { response: { result: { success: false, contact } } },
    { response: { argv: [] } }, { responseBytes: Buffer.from("{malformed synthetic JSON") },
    { skipMutation: true }, { mutation: { action: "get" } },
  ];
  for (const changes of failures) {
    const before = f.calls.length;
    await assert.rejects(f.run(createArgs, { launch: async (options) => { f.calls.push(options); await f.emitReceipt(options, changes); } }),
      (error) => error.code === "COMPANION_RESULT_UNKNOWN" && error.mutationMayHaveOccurred === true && /^[0-9a-f-]{36}$/.test(error.requestId));
    assert.equal(f.calls.length, before + 1);
    assert.ok((await readdir(join(f.jobs, f.calls.at(-1).requestId))).includes("request.json"));
  }
});

test("unbounded or unsafe response files and unexpected read mutation markers are unverified", async (t) => {
  const f = await fixture(t);
  for (const change of ["oversized", "permissions", "symlink", "hardlink", "fifo", "unexpected-read-mutation", "invalid-utf8"]) {
    await assert.rejects(f.run({ action: "get", id: "synthetic-contact" }, { launch: async (options) => {
      f.calls.push(options);
      await f.emitReceipt(options, { forceMutation: change === "unexpected-read-mutation" });
      const response = join(f.jobs, options.requestId, "response.json");
      if (change === "oversized") await writeFile(response, "x".repeat(1024 * 1024 + 1));
      if (change === "permissions") await chmod(response, 0o644);
      if (change === "symlink") {
        const target = join(f.root, "synthetic-response.json");
        await writeFile(target, await readFile(response), { mode: 0o600 });
        await rm(response); await symlink(target, response);
      }
      if (change === "hardlink") await link(response, join(f.root, "synthetic-hardlink.json"));
      if (change === "fifo") {
        await rm(response);
        await runFile("/usr/bin/mkfifo", ["-m", "600", response], { env: { PATH: "/usr/bin:/bin", LANG: "C" } });
      }
      if (change === "invalid-utf8") await f.emitReceipt(options, { responseBytes: Buffer.from([0xc3, 0x28]) });
    } }), (error) => error.code === "COMPANION_RESULT_UNKNOWN" && error.mutationMayHaveOccurred === false);
  }
  assert.equal(f.calls.length, 7);
});

test("verified native failure retains mutation uncertainty but never echoes private payload text", async (t) => {
  const f = await fixture(t);
  for (const mutationStarted of [false, true]) {
    await assert.rejects(f.run(createArgs, { launch: async (options) => {
      f.calls.push(options);
      await f.emitReceipt(options, { skipMutation: !mutationStarted, response: { success: false, result: undefined, error: "COMPANION_OPERATION_FAILED", mutationMayHaveOccurred: mutationStarted } });
    } }), (error) => error.code === "COMPANION_OPERATION_FAILED" && error.mutationMayHaveOccurred === mutationStarted);
  }
  await assert.rejects(f.run(createArgs, { launch: async (options) => {
    f.calls.push(options);
    await f.emitReceipt(options, { response: { success: false, result: undefined, error: "Synthetic private payload should not escape" } });
  } }), (error) => !error.message.includes("private payload") && error.code === "COMPANION_RESULT_UNKNOWN");
});

test("known native denial before mutation is verified, while unknown native codes stay unverified", async (t) => {
  const f = await fixture(t);
  for (const [code, expected] of [["COMPANION_SCOPE_DENIED", "COMPANION_SCOPE_DENIED"],
    ["COMPANION_UNKNOWN_CODE", "COMPANION_RESULT_UNKNOWN"]]) {
    await assert.rejects(f.run(createArgs, { launch: async (options) => {
      f.calls.push(options);
      await f.emitReceipt(options, { skipMutation: true,
        response: { success: false, result: undefined, error: code, mutationMayHaveOccurred: false } });
    } }), (error) => error.code === expected && error.mutationMayHaveOccurred === (expected === "COMPANION_RESULT_UNKNOWN"));
  }
});

test("timeout aborts only the injected launcher signal, retains the request, and never retries", async (t) => {
  const f = await fixture(t);
  let aborted = 0;
  await assert.rejects(f.run(createArgs, { timeoutMs: 15, launch: (options) => {
    f.calls.push(options);
    options.signal.addEventListener("abort", () => { aborted++; });
    return new Promise(() => {});
  } }), (error) => error.code === "COMPANION_RESULT_UNKNOWN" && error.mutationMayHaveOccurred === true);
  assert.equal(aborted, 1);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await readdir(join(f.jobs, f.calls[0].requestId)), ["request.json"]);
});

test("a valid completion can prove success even when the open launcher rejects afterward", async (t) => {
  const f = await fixture(t);
  const result = await f.run(createArgs, { launch: async (options) => {
    f.calls.push(options); await f.emitReceipt(options);
    throw new Error("Synthetic launcher error including private text must not escape");
  } });
  assert.deepEqual(result, { success: true, contact });
  assert.equal(f.calls.length, 1);
});
