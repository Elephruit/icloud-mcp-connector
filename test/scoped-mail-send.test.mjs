import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveMailMailboxId } from "../lib/scoped-mail-config.js";
import { assertMailSendSender, loadMailSendContext, readPrivateMailSendJSON, validateMailSendConfig } from "../lib/scoped-mail-send-config.js";
import { canonicalMailSendPayload, createMailSendPreview, normalizeMailSendAddress, validateMailSendPreview } from "../lib/scoped-mail-send-payload.js";
import { createMailSendStore, validateMailSendApproval } from "../lib/scoped-mail-send-store.js";
import { createScopedMailSendAdapter, mailSendTool } from "../lib/scoped-mail-send.js";
import { armMailSendInteractively, parseArmMailSendCLI } from "../scripts/arm-mail-send.mjs";

const accountId = "synthetic-account", from = "sender@example.com";
const mailbox = { accountId, path: ["INBOX"] }; mailbox.id = deriveMailMailboxId(accountId, mailbox.path);
const rootConfig = { mail: { enabled: true, accounts: [accountId], mailboxes: [mailbox], allowWrites: false }, mailSend: { allowSend: true, senders: [{ accountId, from }] } };
const payload = { accountId, from, to: ["recipient@example.net"], cc: ["copy@example.org"], bcc: ["private-copy@example.org"], subject: "Synthetic subject", body: "Synthetic body\nNo inferred footer." };
const preview = createMailSendPreview(payload), now = new Date("2026-10-04T12:00:00Z");
const approvalId = "00000000-0000-4000-8000-000000000001";
const previewArgs = { action: "preview", ...payload };
const sendArgs = { action: "send", ...payload, digest: preview.digest, approvalId };
const context = { configDirectory: "/synthetic/private", sendConfig: validateMailSendConfig(rootConfig) };

async function fixture(callback) {
  const directory = await mkdtemp(join(tmpdir(), "apple-pim-mail-send-synthetic-"));
  try {
    await chmod(directory, 0o700);
    const store = await createMailSendStore({ configDirectory: directory, now: () => now, initialize: true });
    await store.arm(preview, { approvalId });
    const scopedContext = { ...context, configDirectory: directory };
    await callback({ directory, store, scopedContext });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("strict recipients reject display names, lists, header injection, malformed domains and duplicate buckets", () => {
  assert.equal(normalizeMailSendAddress("Sender@EXAMPLE.COM"), "Sender@example.com");
  for (const address of ["Name <person@example.com>", "a@example.com,b@example.com", "a@example.com\r\nBcc: hidden@example.com", "a@example.com\0", " quoted@example.com", "x@localhost", "x@-example.com", "x@example..com", "x@example.com;", "x@[127.0.0.1]", "ümlaut@example.com", "a..b@example.com", '"quoted"@example.com']) assert.throws(() => normalizeMailSendAddress(address));
  for (const change of [{ to: [] }, { cc: ["RECIPIENT@example.net"] }, { to: Array(21).fill("recipient@example.net") }, { to: "recipient@example.net" }]) assert.throws(() => canonicalMailSendPayload({ ...payload, ...change }));
});

test("payload text stays exact and bounded, rejects malformed Unicode/control headers and attachments", () => {
  assert.equal(canonicalMailSendPayload(payload).body, payload.body);
  assert.equal(canonicalMailSendPayload({ ...payload, body: "Original 📨\r\ntext\t" }).body, "Original 📨\r\ntext\t");
  for (const change of [{ subject: "x\r\nBcc:y" }, { subject: "x".repeat(241) }, { subject: "\ud800" }, { body: "\udc00" }, { body: "x".repeat(32769) }, { body: "x\0y" }, { body: " " }, { attachments: ["file"] }, { approved: true }]) assert.throws(() => canonicalMailSendPayload({ ...payload, ...change }));
});

test("digest binds every exact approved field and recipient bucket/order", () => {
  assert.ok(Object.isFrozen(preview.payload) && Object.isFrozen(preview.payload.to));
  for (const change of [{ accountId: "other-account" }, { from: "different@example.com" }, { to: ["different@example.net"] }, { cc: [] }, { bcc: [] }, { subject: "Changed" }, { body: payload.body + "\nChanged" }]) assert.notEqual(createMailSendPreview({ ...payload, ...change }).digest, preview.digest);
  const reordered = createMailSendPreview({ ...payload, to: ["one@example.net", "two@example.net"] });
  assert.notEqual(createMailSendPreview({ ...payload, to: ["two@example.net", "one@example.net"] }).digest, reordered.digest);
  assert.throws(() => validateMailSendPreview({ ...preview, digest: "0".repeat(64) }));
});

test("Mail allowWrites remains false; sending defaults off and requires separate exact sender policy", () => {
  const disabled = validateMailSendConfig({ mail: rootConfig.mail });
  assert.equal(disabled.allowSend, false);
  assert.throws(() => assertMailSendSender(payload, disabled, { requireEnabled: true }), /disabled/);
  for (const mailSend of [{ allowSend: "true" }, { allowSend: true }, { allowSend: true, senders: [{ accountId: "outside", from }] }, { ...rootConfig.mailSend, allowWrites: true }, { ...rootConfig.mailSend, senders: [{ accountId, from: "sender@EXAMPLE.COM" }] }, { ...rootConfig.mailSend, senders: [{ accountId, from }, { accountId, from }] }]) assert.throws(() => validateMailSendConfig({ ...rootConfig, mailSend }));
  assert.equal(rootConfig.mail.allowWrites, false);
});

test("preview stays pure with no approval storage/native calls or inferred footer", async () => {
  let storeCalls = 0, nativeCalls = 0;
  const adapter = createScopedMailSendAdapter({ loadContext: async () => ({ ...context, sendConfig: { ...context.sendConfig, allowSend: false } }), storeFactory: () => { storeCalls++; }, runSend: () => { nativeCalls++; } });
  const result = await adapter.runMailSend(previewArgs);
  assert.deepEqual(result.preview, preview); assert.equal(result.approvalRequired, true); assert.equal(result.nativeDispatchAvailable, false);
  assert.equal(result.preview.payload.body, payload.body); assert.equal(storeCalls + nativeCalls, 0);
});

test("advertised schema works without configuration, approval store or native dispatch", async () => {
  let calls = 0;
  const adapter = createScopedMailSendAdapter({ loadContext: () => { calls++; }, storeFactory: () => { calls++; }, runSend: () => { calls++; } });
  const result = await adapter.runMailSend({ action: "schema" });
  assert.equal(result.tool, mailSendTool);
  assert.equal(result.nativeDispatchAvailable, false);
  await assert.rejects(adapter.runMailSend({ action: "schema", approved: true }), /only action/);
  assert.equal(calls, 0);
});

test("closed send schema rejects model consent, paths, scripts, arming and digest mismatch before config", async () => {
  let configCalls = 0;
  const adapter = createScopedMailSendAdapter({ loadContext: async () => { configCalls++; return context; } });
  for (const args of [{ ...sendArgs, approved: true }, { ...sendArgs, approvalFile: "/other" }, { ...sendArgs, configDir: "/other" }, { ...sendArgs, script: "send" }, { ...sendArgs, action: "arm" }, { ...sendArgs, digest: "0".repeat(64) }, { ...previewArgs, approvalId }]) await assert.rejects(adapter.runMailSend(args));
  assert.equal(configCalls, 0); assert.equal(mailSendTool.inputSchema.additionalProperties, false); assert.ok(!mailSendTool.inputSchema.properties.approved);
});

test("default native blocker stops before any approval claim or draft creation even when scope allows sends", async () => {
  let storeCalls = 0;
  const adapter = createScopedMailSendAdapter({ loadContext: async () => context, storeFactory: () => { storeCalls++; } });
  await assert.rejects(adapter.runMailSend(sendArgs), (error) => error.code === "MAIL_SEND_ACCOUNT_BINDING_UNVERIFIED");
  assert.equal(storeCalls, 0);
});

test("manual armer rejects automated/non-TTY input and has no consent flag", async () => {
  assert.deepEqual(parseArmMailSendCLI(["--preview-file", "/synthetic/private/preview.json"]), { previewPath: "/synthetic/private/preview.json" });
  for (const args of [[], ["--approved", "true"], ["--preview-file", "relative"], ["--preview-file", "/private/file", "--yes"]]) assert.throws(() => parseArmMailSendCLI(args));
  await assert.rejects(armMailSendInteractively({ previewPath: "/not-read", input: { isTTY: false }, output: { isTTY: true } }), /interactive local owner TTY/);
});

test("approval binds exact payload, opaque nonce and bounded expiry rather than caller approval boolean", () => {
  const approval = { version: 1, approvalId, preview, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600000).toISOString() };
  assert.equal(validateMailSendApproval(approval, approvalId, preview, now).digest, preview.digest);
  for (const change of [{ approved: true }, { approvalId: "wrong" }, { expiresAt: now.toISOString() }, { expiresAt: new Date(now.getTime() + 600001).toISOString() }, { issuedAt: new Date(now.getTime() + 1).toISOString() }]) assert.throws(() => validateMailSendApproval({ ...approval, ...change }, approvalId, preview, now));
  assert.throws(() => validateMailSendApproval(approval, approvalId, createMailSendPreview({ ...payload, body: "Changed" }), now));
});

test("private store durability consumes both approval nonce and payload, with one immutable final receipt", async () => {
  await fixture(async ({ directory, store }) => {
    const approvalPath = join(directory, "mail-send", "approvals", approvalId + ".json");
    assert.equal((await stat(approvalPath)).mode & 0o777, 0o600);
    const claim = await store.claim(approvalId, preview);
    const journalPath = join(directory, "mail-send", "journal", approvalId + ".jsonl");
    assert.equal((await stat(journalPath)).mode & 0o777, 0o600);
    const pending = await readFile(journalPath, "utf8");
    assert.equal(JSON.parse(pending).state, "pending"); assert.ok(!pending.includes(payload.body) && !pending.includes(payload.subject));
    await assert.rejects(store.claim(approvalId, preview), (error) => error.code === "MAIL_SEND_APPROVAL_USED_OR_UNCERTAIN");
    await store.recordOutcome(claim, "submitted");
    assert.equal((await readFile(journalPath, "utf8")).trim().split("\n").length, 1);
    assert.equal(JSON.parse(await readFile(join(directory, "mail-send", "journal", approvalId + ".outcome.json"), "utf8")).state, "submitted");
    const another = "00000000-0000-4000-8000-000000000002";
    await assert.rejects(store.arm(preview, { approvalId: another }), (error) => error.code === "MAIL_SEND_APPROVAL_USED_OR_UNCERTAIN");
  });
});

test("concurrent same-approval claims allow only one attempt", async () => {
  await fixture(async ({ store }) => {
    const outcomes = await Promise.allSettled([store.claim(approvalId, preview), store.claim(approvalId, preview)]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  });
});

test("maximum valid escaped body remains armable and claimable under bounded serialized approval size", async () => {
  await fixture(async ({ directory, store }) => {
    const large = createMailSendPreview({ ...payload, body: '"'.repeat(32768) }), another = "00000000-0000-4000-8000-000000000003";
    await store.arm(large, { approvalId: another });
    const info = await stat(join(directory, "mail-send", "approvals", another + ".json"));
    assert.ok(info.size > 65536 && info.size <= 128 * 1024);
    assert.equal((await store.claim(another, large)).digest, large.digest);
  });
});

test("synthetic send runner observes durable pending claim and exact payload before local acceptance", async () => {
  await fixture(async ({ directory, store, scopedContext }) => {
    let calls = 0;
    const adapter = createScopedMailSendAdapter({ loadContext: async () => scopedContext, storeFactory: async () => store, now: () => now, runSend: async (approvedPayload) => {
      calls++; assert.deepEqual(approvedPayload, preview.payload);
      const journal = await readFile(join(directory, "mail-send", "journal", approvalId + ".jsonl"), "utf8"); assert.equal(JSON.parse(journal).state, "pending");
      return { acceptedByMail: true, privateDiagnostic: "not exposed" };
    } });
    const result = await adapter.runMailSend(sendArgs);
    assert.equal(result.status, "submitted"); assert.equal(result.deliveryConfirmed, false); assert.equal(result.privateDiagnostic, undefined);
    await assert.rejects(adapter.runMailSend(sendArgs)); assert.equal(calls, 1);
  });
});

test("synthetic uncertain outcomes consume approval, redact native errors and never retry", async () => {
  for (const runSend of [async () => { throw new Error("SYNTHETIC_PRIVATE_FAILURE"); }, async () => ({ acceptedByMail: false }), async () => ({})]) {
    await fixture(async ({ store, scopedContext }) => {
      let calls = 0;
      const adapter = createScopedMailSendAdapter({ loadContext: async () => scopedContext, storeFactory: async () => store, now: () => now, runSend: (...args) => { calls++; return runSend(...args); } });
      await assert.rejects(adapter.runMailSend(sendArgs), (error) => error.code === "MAIL_SEND_OUTCOME_UNKNOWN" && !error.message.includes("SYNTHETIC_PRIVATE_FAILURE"));
      await assert.rejects(adapter.runMailSend(sendArgs)); assert.equal(calls, 1);
    });
  }
});

test("synthetic native timeout aborts and leaves a consumed unknown approval", async () => {
  await fixture(async ({ store, scopedContext }) => {
    let signal;
    const adapter = createScopedMailSendAdapter({ now: () => now, loadContext: async () => scopedContext, storeFactory: async () => store, operationTimeoutMs: 5, runSend: async (_payload, options) => { signal = options.signal; return new Promise(() => {}); } });
    await assert.rejects(adapter.runMailSend(sendArgs), (error) => error.code === "MAIL_SEND_OUTCOME_UNKNOWN"); assert.equal(signal.aborted, true);
    await assert.rejects(store.claim(approvalId, preview));
  });
});

test("policy revoked after claim blocks runner and permanently consumes the approval", async () => {
  await fixture(async ({ store, scopedContext }) => {
    let loadCalls = 0, nativeCalls = 0;
    const adapter = createScopedMailSendAdapter({ loadContext: async () => ++loadCalls === 1 ? scopedContext : { ...scopedContext, sendConfig: { ...scopedContext.sendConfig, allowSend: false } }, storeFactory: async () => store, runSend: async () => { nativeCalls++; } });
    await assert.rejects(adapter.runMailSend(sendArgs), (error) => error.code === "MAIL_SEND_SCOPE_CHANGED"); assert.equal(nativeCalls, 0);
    await assert.rejects(store.claim(approvalId, preview));
  });
});

test("approval expiry during policy reload consumes approval and blocks the native attempt", async () => {
  await fixture(async ({ store, scopedContext }) => {
    let loadCalls = 0, nativeCalls = 0, clock = now;
    const adapter = createScopedMailSendAdapter({ now: () => clock, loadContext: async () => { if (++loadCalls === 2) clock = new Date(now.getTime() + 600000); return scopedContext; }, storeFactory: async () => store, runSend: async () => { nativeCalls++; } });
    await assert.rejects(adapter.runMailSend(sendArgs), (error) => error.code === "MAIL_SEND_SCOPE_CHANGED");
    assert.equal(nativeCalls, 0); await assert.rejects(store.claim(approvalId, preview));
  });
});

test("expiry immediately before native invocation records blocked rather than unknown", async () => {
  await fixture(async ({ directory, store, scopedContext }) => {
    let clockChecks = 0, nativeCalls = 0;
    const adapter = createScopedMailSendAdapter({ now: () => ++clockChecks === 1 ? now : new Date(now.getTime() + 600000), loadContext: async () => scopedContext, storeFactory: async () => store, runSend: async () => { nativeCalls++; } });
    await assert.rejects(adapter.runMailSend(sendArgs), (error) => error.code === "MAIL_SEND_SCOPE_CHANGED");
    assert.equal(nativeCalls, 0);
    const outcome = JSON.parse(await readFile(join(directory, "mail-send", "journal", approvalId + ".outcome.json"), "utf8"));
    assert.equal(outcome.state, "blocked");
  });
});

test("receipt write failure after synthetic acceptance returns unknown, never a false delivery claim", async () => {
  let claims = 0;
  const adapter = createScopedMailSendAdapter({ now: () => now, loadContext: async () => context, storeFactory: async () => ({ claim: async () => { claims++; return { approvalId, digest: preview.digest, expiresAt: new Date(now.getTime() + 600000).toISOString() }; }, recordOutcome: async () => { throw new Error("SYNTHETIC_PRIVATE_DISK_FAILURE"); } }), runSend: async () => ({ acceptedByMail: true }) });
  await assert.rejects(adapter.runMailSend(sendArgs), (error) => error.code === "MAIL_SEND_OUTCOME_UNKNOWN" && !error.message.includes("SYNTHETIC_PRIVATE_DISK_FAILURE")); assert.equal(claims, 1);
});

test("private config/approval files deny world access, symlinks/hardlinks and Git placement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apple-pim-mail-send-private-synthetic-"));
  try {
    await chmod(directory, 0o700); const file = join(directory, "config.json");
    await writeFile(file, JSON.stringify(rootConfig), { mode: 0o600 });
    assert.equal((await loadMailSendContext({ APPLE_PIM_CONFIG_DIR: directory })).sendConfig.allowSend, true);
    await assert.rejects(loadMailSendContext({ APPLE_PIM_CONFIG_DIR: directory, APPLE_PIM_PROFILE: "other" }));
    await chmod(file, 0o644); await assert.rejects(readPrivateMailSendJSON(file)); await chmod(file, 0o600);
    await symlink(file, join(directory, "symlink.json")); await assert.rejects(readPrivateMailSendJSON(join(directory, "symlink.json")));
    await link(file, join(directory, "hardlink.json")); await assert.rejects(readPrivateMailSendJSON(file)); await rm(join(directory, "hardlink.json"));
    await writeFile(join(directory, ".git"), "synthetic\n"); await assert.rejects(loadMailSendContext({ APPLE_PIM_CONFIG_DIR: directory }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("FIFO private inputs reject without waiting for a writer and redact the path", { timeout: 1000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "apple-pim-mail-send-fifo-synthetic-"));
  try {
    const path = join(directory, "SYNTHETIC_PRIVATE_FIFO");
    await promisify(execFile)("/usr/bin/mkfifo", ["-m", "600", path], { timeout: 1000 });
    await assert.rejects(readPrivateMailSendJSON(path), (error) => error.code === "MAIL_SEND_PRIVATE_FILE_INVALID" && !error.message.includes(path) && !error.message.includes("SYNTHETIC_PRIVATE_FIFO"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("missing state subdirectories and claim I/O failures never expose private paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apple-pim-mail-send-redaction-synthetic-"));
  try {
    await chmod(directory, 0o700);
    await assert.rejects(createMailSendStore({ configDirectory: directory }), (error) => !error.message.includes(directory) && !error.message.includes("ENOENT"));
    const store = await createMailSendStore({ configDirectory: directory, initialize: true, now: () => now });
    await assert.rejects(store.claim(approvalId, preview), (error) => !error.message.includes(directory));
    await rm(join(directory, "mail-send", "journal"), { recursive: true });
    await assert.rejects(store.inspect(approvalId, preview), (error) => !error.message.includes(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("different approval UUIDs for the same payload still allow only one concurrent claim", async () => {
  await fixture(async ({ store }) => {
    const another = "00000000-0000-4000-8000-000000000004";
    await store.arm(preview, { approvalId: another });
    const results = await Promise.allSettled([store.claim(approvalId, preview), store.claim(another, preview)]);
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(results.filter((item) => item.status === "rejected").length, 1);
    await assert.rejects(store.arm(preview, { approvalId: "00000000-0000-4000-8000-000000000005" }));
  });
});

test("restart recovery preserves pending/submitted/unknown/blocked dedupe with no safe-retry claim", async () => {
  for (const outcome of [undefined, "submitted", "unknown", "blocked"]) {
    await fixture(async ({ directory, store }) => {
      const claim = await store.claim(approvalId, preview);
      if (outcome) await store.recordOutcome(claim, outcome);
      const restarted = await createMailSendStore({ configDirectory: directory, now: () => new Date(now.getTime() + 86400000) });
      const status = await restarted.inspect(approvalId, preview);
      assert.equal(status.status, outcome ?? "unknown"); assert.equal(status.retryAllowed, false); assert.equal(status.deliveryConfirmed, false);
      await assert.rejects(restarted.claim(approvalId, preview));
      await assert.rejects(restarted.arm(preview, { approvalId: "00000000-0000-4000-8000-000000000006" }));
    });
  }
});

test("truncated/corrupt claim or receipt remains consumed across restarts", async () => {
  for (const [suffix, content] of [[".jsonl", ""], [".jsonl", "{"], [".outcome.json", "{"], [".outcome.json", JSON.stringify({ version: 1, approvalId, digest: preview.digest, state: "submitted", recordedAt: now.toISOString(), forged: true })]]) {
    await fixture(async ({ directory, store }) => {
      await store.claim(approvalId, preview);
      await writeFile(join(directory, "mail-send", "journal", approvalId + suffix), content, { mode: 0o600 });
      const restarted = await createMailSendStore({ configDirectory: directory, now: () => now });
      assert.equal((await restarted.inspect(approvalId, preview)).status, "unknown");
      await assert.rejects(restarted.claim(approvalId, preview));
    });
  }
});

test("conflicting concurrent finalizers produce one immutable outcome", async () => {
  await fixture(async ({ store }) => {
    const claim = await store.claim(approvalId, preview);
    const results = await Promise.allSettled([store.recordOutcome(claim, "submitted"), store.recordOutcome(claim, "unknown")]);
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(results.filter((item) => item.status === "rejected").length, 1);
    assert.ok(["submitted", "unknown"].includes((await store.inspect(approvalId, preview)).status));
    await assert.rejects(store.recordOutcome(claim, "blocked"));
  });
});

test("late synthetic native acceptance after timeout cannot promote unknown or permit a duplicate payload", async () => {
  await fixture(async ({ directory, store, scopedContext }) => {
    let finish, attempts = 0;
    const adapter = createScopedMailSendAdapter({ now: () => now, loadContext: async () => scopedContext, storeFactory: async () => store, operationTimeoutMs: 5, runSend: async () => { attempts++; return new Promise((resolve) => { finish = resolve; }); } });
    await assert.rejects(adapter.runMailSend(sendArgs), (error) => error.code === "MAIL_SEND_OUTCOME_UNKNOWN");
    finish({ acceptedByMail: true }); await new Promise((resolve) => setImmediate(resolve));
    const restarted = await createMailSendStore({ configDirectory: directory, now: () => now });
    assert.equal((await restarted.inspect(approvalId, preview)).status, "unknown");
    await assert.rejects(restarted.arm(preview, { approvalId: "00000000-0000-4000-8000-000000000007" }));
    await assert.rejects(adapter.runMailSend(sendArgs)); assert.equal(attempts, 1);
  });
});

test("status recovery is exact-payload local journal only and never calls the native runner", async () => {
  await fixture(async ({ store, scopedContext }) => {
    let attempts = 0;
    const adapter = createScopedMailSendAdapter({ loadContext: async () => scopedContext, storeFactory: async () => store, runSend: async () => { attempts++; } });
    const notClaimed = await adapter.runMailSend({ ...sendArgs, action: "status" });
    assert.equal(notClaimed.status, "notClaimed"); assert.equal(notClaimed.retryAllowed, false);
    const claim = await store.claim(approvalId, preview); await store.recordOutcome(claim, "submitted");
    const status = await adapter.runMailSend({ ...sendArgs, action: "status" });
    assert.equal(status.status, "submitted"); assert.equal(status.deliveryConfirmed, false); assert.equal(attempts, 0);
    await assert.rejects(adapter.runMailSend({ ...sendArgs, action: "status", body: "Changed" }));
  });
});
