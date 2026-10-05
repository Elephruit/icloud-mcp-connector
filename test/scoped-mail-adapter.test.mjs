import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, chmod, rm, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { buildMailInvocation, checkMailAccess, createScopedMailAdapter, mailChildEnvironment, mailTool, runScopedMailScript } from "../lib/scoped-mail.js";
import { deriveMailMailboxId, loadMailConfig, validateMailConfig } from "../lib/scoped-mail-config.js";
import { parseMailThreadHeaders } from "../lib/scoped-mail-headers.js";
import { SCOPED_MAIL_JXA } from "../lib/scoped-mail-script.js";
import { MailReadError, mailReadErrorDetails } from "../lib/mail-read-error.js";

const now = new Date("2026-10-04T12:00:00Z");
const accountId = "account-test";
const inbox = { accountId, path: ["INBOX"] };
inbox.id = deriveMailMailboxId(inbox.accountId, inbox.path);
const sent = { accountId, path: ["Sent"] };
sent.id = deriveMailMailboxId(sent.accountId, sent.path);
const mail = { enabled: true, accounts: [accountId], mailboxes: [inbox, sent], allowWrites: false };
const listArgs = { action: "list", accountId, mailboxId: inbox.id };
const getArgs = { action: "get", accountId, mailboxId: inbox.id, id: "1" };

function collection(items, { beforeMaterialize = () => {}, onIndex = () => {} } = {}) {
  const getter = () => items;
  getter.whose = (predicate) => {
    const matches = () => items.filter((item) => Object.entries(predicate).every(([field, expected]) => {
    const actual = field === "name" && item.nativeName !== undefined ? item.nativeName : item[field]();
    if (field === "dateReceived") return actual.getTime() >= expected[">="].getTime();
    // Native name comparisons can be insensitive; the fixed script rechecks.
    return typeof actual === "string" && typeof expected === "string" ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
    }));
    const query = () => { beforeMaterialize(predicate); return matches(); };
    query.at = (index) => {
      onIndex(index); const item = matches()[index];
      return item ? { ...item, exists: () => true } : { exists: () => false, id: () => { throw new Error("NONEXISTENT_ID_READ"); } };
    };
    return query;
  };
  return getter;
}

function message(id, rfcId, options = {}) {
  const state = { bodiesRead: 0, protectedReads: 0, isRead: false };
  const protect = (value) => { state.protectedReads++; if (options.denyProtectedRead) throw new Error("OUT_OF_WINDOW_PROTECTED_READ"); return value; };
  const properties = {
    id: () => id, messageId: () => protect(rfcId),
    dateReceived: () => new Date(options.date ?? "2026-10-03T12:00:00Z"),
    subject: () => protect(options.subject ?? "Synthetic topic"),
    sender: () => protect("Synthetic Sender <sender@example.com>"),
    readStatus: () => { const result = protect(state.isRead); options.onMetadata?.(); return result; },
    allHeaders: () => protect(options.headers ?? `Message-ID: <${rfcId}>\r\n${options.reference ? "References: <" + options.reference + ">\r\nIn-Reply-To: <" + options.reference + ">\r\n" : ""}`),
    content: () => { state.bodiesRead += 1; if (options.changeReadStatus) state.isRead = true; return protect(options.body ?? "Synthetic body " + id); },
  };
  return { native: Object.freeze(properties), state };
}

function nativeFixture({ rows, inboxName = "INBOX", duplicateInbox = false, icloud = true, wrongMailboxOwner, getMailboxOwner, pageClock, configuration = mail } = {}) {
  let activeOp; const indexedPositions = [];
  const seed = message(1, "root@example.com"), reply = message(2, "reply@example.com", { reference: "root@example.com", date: "2026-10-04T10:00:00Z" }), unrelated = message(3, "unrelated@example.com");
  const inboxRows = rows ?? [seed, unrelated];
  const wrongOwner = wrongMailboxOwner && {
    accountType: () => wrongMailboxOwner.provider,
    id: () => { if (wrongMailboxOwner.provider !== "iCloud") throw new Error("UNAPPROVED_OWNER_ID"); return wrongMailboxOwner.id; },
  };
  const mailbox = (name, data) => Object.freeze({
    nativeName: name,
    account: () => getMailboxOwner?.(account) ?? wrongOwner ?? account,
    name: () => { if (wrongOwner) throw new Error("UNAPPROVED_MAILBOX_NAME"); return name; },
    get messages() {
      if (wrongOwner) throw new Error("UNAPPROVED_MAILBOX_MESSAGES");
      return collection(data.map((entry) => entry.native), { beforeMaterialize: (predicate) => { if (predicate.dateReceived && activeOp !== "snapshot") throw new Error("FULL_DATE_FILTER_MATERIALIZATION_FORBIDDEN"); }, onIndex: (index) => indexedPositions.push(index) });
    },
    get mailboxes() { if (wrongOwner) throw new Error("UNAPPROVED_MAILBOX_CHILDREN"); return collection([]); },
  });
  const inboxBox = mailbox(inboxName, inboxRows), sentBox = mailbox("Sent", [reply]);
  const boxes = duplicateInbox ? [inboxBox, inboxBox, sentBox] : [inboxBox, sentBox];
  const account = Object.freeze({
    id: () => { if (!icloud) throw new Error("UNAPPROVED_PROVIDER_ID"); return accountId; },
    accountType: () => icloud ? "iCloud" : "imap",
    get mailboxes() { if (!icloud) throw new Error("UNAPPROVED_PROVIDER_MAILBOXES"); return collection(boxes); },
  });
  const accountCollection = () => { throw new Error("Unfiltered accounts enumeration is forbidden"); };
  accountCollection.whose = (predicate) => {
    assert.deepEqual(Object.keys(predicate), ["id"]); assert.equal(predicate.id, accountId);
    return () => predicate.id === accountId ? [account] : [];
  };
  const nativeMail = Object.freeze({ running: () => true, accounts: accountCollection });
  class PageDate extends Date {
    static now() { return pageClock(); }
    static [Symbol.hasInstance](instance) { return instance instanceof Date; }
  }
  const scriptContext = { Application: (path) => { assert.equal(path, "/System/Applications/Mail.app"); return nativeMail; }, Date: pageClock ? PageDate : Date, Set, JSON };
  const calls = [];
  const runScript = async (payload) => {
    activeOp = payload.op;
    calls.push(payload);
    const output = runInNewContext(SCOPED_MAIL_JXA + "\nrun(nativeArgv)", { ...scriptContext, nativeArgv: [JSON.stringify(payload)] }, { timeout: 2000 });
    return JSON.parse(output);
  };
  const adapter = createScopedMailAdapter({ now: () => now, loadConfig: async () => configuration, runScript });
  return { ...adapter, runScript, calls, seed, reply, unrelated, inboxRows, indexedPositions };
}

test("derived mailbox keys bind native account and exact ordered hierarchy, not names alone", () => {
  assert.equal(inbox.id, deriveMailMailboxId(accountId, ["INBOX"]));
  assert.notEqual(inbox.id, deriveMailMailboxId("account-other", ["INBOX"]));
  assert.notEqual(inbox.id, deriveMailMailboxId(accountId, ["inbox"]));
  assert.notEqual(deriveMailMailboxId(accountId, ["A", "B"]), deriveMailMailboxId(accountId, ["A/B"]));
  for (const config of [{}, { mail: { ...mail, enabled: false } }, { mail: { ...mail, accounts: [] } }, { mail: { ...mail, allowWrites: true } }, { mail: { ...mail, mode: "all" } }, { mail: { ...mail, mailboxes: [{ ...inbox, id: "wrong" }] } }, { mail: { ...mail, mailboxes: [{ ...inbox, accountId: "foreign" }] } }, { mail: { ...mail, mailboxes: [inbox, inbox] } }]) assert.throws(() => validateMailConfig(config));
  assert.ok(Object.isFrozen(validateMailConfig({ mail }).mailboxes[0].path));
});

test("disabled and invalid scope configuration denies before native execution", async () => {
  for (const config of [{ ...mail, enabled: false }, { ...mail, mailboxes: [] }, { ...mail, allowWrites: true }]) {
    const fixture = nativeFixture({ configuration: config });
    await assert.rejects(fixture.runMail(listArgs));
    assert.equal(fixture.calls.length, 0);
  }
});

test("closed read-only parameters reject mutations, path/engine/config overrides and mismatched account keys", async () => {
  for (const args of [{ ...listArgs, action: "send" }, { ...listArgs, action: "delete" }, { ...getArgs, readStatus: true }, { ...listArgs, profile: "other" }, { ...listArgs, configDir: "/other" }, { ...listArgs, engine: "sqlite" }, { ...listArgs, path: ["Other"] }, { ...listArgs, source: true }, { ...getArgs, limit: 10 }, { ...listArgs, accountId: "foreign" }, { ...listArgs, mailboxId: sent.id, accountId: "foreign" }]) {
    const fixture = nativeFixture();
    await assert.rejects(fixture.runMail(args));
    assert.equal(fixture.calls.length, 0);
  }
  assert.equal(mailTool.inputSchema.additionalProperties, false);
});

test("date window, query, IDs and limits remain bounded and validated before execution", async () => {
  const config = validateMailConfig({ mail });
  const payload = buildMailInvocation(listArgs, config, now);
  assert.equal(payload.since, "2026-09-27T12:00:00.000Z");
  for (const args of [{ ...listArgs, since: "2026-08-01T12:00:00Z" }, { ...listArgs, since: "2026-10-05T12:00:00Z" }, { ...listArgs, since: "2026-02-30T12:00:00Z" }, { ...listArgs, limit: 51 }, { ...listArgs, limit: 0 }, { ...getArgs, id: "01" }, { ...getArgs, id: "1; script" }, { ...getArgs, id: "9007199254740992" }, { ...listArgs, action: "search", query: " " }, { ...listArgs, action: "search", query: "x".repeat(2049) }]) assert.throws(() => buildMailInvocation(args, config, now));
});

test("native scope resolution uses exact account ID and iCloud provider before exact path; no broad fallback", async () => {
  for (const options of [{ icloud: false }, { inboxName: "inbox" }, { duplicateInbox: true }]) await assert.rejects(nativeFixture(options).runMail(listArgs), /missing or ambiguous|provider is not iCloud/);
  const fixture = nativeFixture();
  const listed = await fixture.runMail(listArgs);
  assert.equal(listed.messages.length, 2);
  assert.ok(listed.messages.every((entry) => entry.mailboxId === inbox.id && entry.accountId === accountId));
  assert.equal(fixture.seed.state.bodiesRead + fixture.unrelated.state.bodiesRead + fixture.reply.state.bodiesRead, 0);
});

test("each mailbox owner is verified before name, children or message getters", async () => {
  for (const wrongMailboxOwner of [{ provider: "iCloud", id: "foreign-account" }, { provider: "imap", id: "foreign-account" }]) {
    const fixture = nativeFixture({ wrongMailboxOwner });
    for (const args of [listArgs, getArgs, { ...getArgs, action: "thread" }]) await assert.rejects(fixture.runMail(args), /mailbox provider is not iCloud|mailbox owner does not match/);
    assert.equal(fixture.seed.state.protectedReads + fixture.reply.state.protectedReads + fixture.unrelated.state.protectedReads, 0);
    assert.equal(fixture.seed.state.bodiesRead + fixture.reply.state.bodiesRead + fixture.unrelated.state.bodiesRead, 0);
  }
});

test("subject/sender search keeps code-like queries as data and never reads bodies", async () => {
  const query = '"; do shell script "synthetic"';
  const row = message(1, "root@example.com", { subject: query });
  const fixture = nativeFixture({ rows: [row] });
  const result = await fixture.runMail({ ...listArgs, action: "search", query });
  assert.equal(result.messages.length, 1);
  assert.equal(row.state.bodiesRead, 0);
  assert.equal(fixture.calls[0].query, query);
  assert.ok(!SCOPED_MAIL_JXA.includes(query));
});

test("get reads only selected numeric scoped ID, omits source/attachments, and preserves unread status", async () => {
  const fixture = nativeFixture();
  const result = await fixture.runMail(getArgs);
  assert.equal(result.message.content, "Synthetic body 1");
  assert.equal(result.message.isRead, false);
  assert.equal(result.message.attachmentsOmitted, true);
  assert.equal(result.message.source, undefined);
  assert.equal(fixture.seed.state.bodiesRead, 1);
  assert.equal(fixture.reply.state.bodiesRead, 0);
  await assert.rejects(fixture.runMail({ ...getArgs, id: "2" }), /outside the allowed mailbox/);
});

test("duplicate local message IDs, old messages and read-status side effects fail safely", async () => {
  const duplicate = message(1, "other@example.com");
  await assert.rejects(nativeFixture({ rows: [message(1, "root@example.com"), duplicate] }).runMail(getArgs), /ambiguous/);
  const old = message(1, "old@example.com", { date: "2026-08-01T12:00:00Z" });
  await assert.rejects(nativeFixture({ rows: [old] }).runMail(getArgs), /date window/);
  assert.equal(old.state.bodiesRead, 0);
  const changes = message(1, "root@example.com", { changeReadStatus: true });
  await assert.rejects(nativeFixture({ rows: [changes] }).runMail(getArgs), /changed read status/);
  assert.equal(changes.state.bodiesRead, 1); // No restoring/flag-setting operation.
});

test("body clipping is explicit, list inspection follows limit and thread headers stay capped at 200", async () => {
  const large = message(1, "root@example.com", { body: "x".repeat(20000) });
  const read = await nativeFixture({ rows: [large] }).runMail(getArgs);
  assert.equal(read.message.content.length, 16384);
  assert.equal(read.message.contentTruncated, true);
  const rows = Array.from({ length: 205 }, (_, index) => message(index + 1, `synthetic-${index}@example.com`));
  const fixture = nativeFixture({ rows });
  const result = await fixture.runMail(listArgs);
  assert.equal(result.messages.length, 20);
  assert.equal(result.coverage.inspected, 20);
  assert.equal(result.coverage.scanTruncated, true);
  assert.equal(rows.reduce((total, row) => total + row.state.bodiesRead, 0), 0);
  assert.equal(rows.slice(20).reduce((total, row) => total + row.state.protectedReads, 0), 0);
  const headers = await fixture.runScript(buildMailInvocation({ ...getArgs, action: "thread", limit: 1 }, validateMailConfig({ mail }), now));
  assert.equal(headers.coverage.inspected, 200); assert.equal(headers.coverage.scanTruncated, true);
});

test("small list/search metadata budgets avoid extra candidate getters and report partial scans", async () => {
  for (const action of ["list", "search"]) {
    const rows = Array.from({ length: 12 }, (_, index) => message(index + 1, `budget-${index}@example.com`));
    const fixture = nativeFixture({ rows });
    const result = await fixture.runMail({ ...listArgs, action, limit: 5, ...(action === "search" ? { query: "nonmatching synthetic query" } : {}) });
    assert.equal(result.coverage.inspected, 5); assert.equal(result.coverage.scanTruncated, true);
    assert.equal(result.messages.length, action === "list" ? 5 : 0);
    assert.equal(rows.slice(5).reduce((sum, row) => sum + row.state.protectedReads + row.state.bodiesRead, 0), 0);
    assert.equal(rows.reduce((sum, row) => sum + row.state.bodiesRead, 0), 0);
  }
  const exact = await nativeFixture({ rows: Array.from({ length: 5 }, (_, index) => message(index + 1, `exact-${index}@example.com`)) }).runMail({ ...listArgs, limit: 5 });
  assert.equal(exact.coverage.scanTruncated, true); // No extra end probe beyond budget.
});

test("lazy date-filtered pagination stays within page/index budget and never materializes references", async () => {
  const rows = Array.from({ length: 12 }, (_, index) => message(index + 1, `page-${index}@example.com`));
  const fixture = nativeFixture({ rows });
  const second = await fixture.runMail({ ...listArgs, offset: 5, limit: 5 });
  assert.deepEqual(fixture.indexedPositions, [5, 6, 7, 8, 9]);
  assert.equal(second.coverage.offset, 5); assert.equal(second.coverage.nextOffset, 10); assert.equal(second.coverage.pageEndReached, false);
  assert.ok(second.messages.every((item) => Number(item.id) >= 6 && Number(item.id) <= 10));
  assert.equal(rows.slice(0, 5).concat(rows.slice(10)).reduce((sum, row) => sum + row.state.protectedReads, 0), 0);
  const end = await fixture.runMail({ ...listArgs, offset: 10, limit: 5 });
  assert.equal(end.coverage.inspected, 2); assert.equal(end.coverage.pageEndReached, true); assert.equal(end.coverage.nextOffset, null); assert.equal(end.coverage.scanTruncated, true);
  const tiny = await nativeFixture({ rows: [message(1, "tiny@example.com")] }).runMail({ ...listArgs, limit: 5 });
  assert.equal(tiny.coverage.pageEndReached, true); assert.equal(tiny.coverage.scanTruncated, false);
});

test("pagination bounds and action-specific offset validation deny before native dispatch", async () => {
  for (const args of [{ ...listArgs, offset: -1 }, { ...listArgs, offset: 200 }, { ...listArgs, offset: 1.5 }, { ...listArgs, offset: "1" }, { ...listArgs, offset: 199, limit: 2 }, { ...getArgs, offset: 0 }, { ...getArgs, action: "thread", offset: 0 }]) {
    const fixture = nativeFixture(); await assert.rejects(fixture.runMail(args)); assert.equal(fixture.calls.length, 0);
  }
  const last = await nativeFixture({ rows: [] }).runMail({ ...listArgs, offset: 199, limit: 1 });
  assert.equal(last.coverage.nextOffset, null); assert.equal(last.coverage.pageEndReached, true);
});

test("cooperative page deadline returns only completed metadata and the next consumed position", async () => {
  let elapsed = 0;
  const rows = Array.from({ length: 5 }, (_, index) => message(index + 1, `deadline-${index}@example.com`, { onMetadata: () => { elapsed += 5000; } }));
  const fixture = nativeFixture({ rows, pageClock: () => elapsed });
  const result = await fixture.runMail({ ...listArgs, limit: 5 });
  assert.deepEqual(result.messages.map((row) => row.id), ["1", "2"]);
  assert.deepEqual(fixture.indexedPositions, [0, 1]);
  assert.equal(result.coverage.stopReason, "time_budget");
  assert.equal(result.coverage.scanTruncated, true);
  assert.equal(result.coverage.pageEndReached, false);
  assert.equal(result.coverage.positionsConsumed, 2);
  assert.equal(result.coverage.nextOffset, 2);
  assert.equal(rows.slice(2).reduce((sum, row) => sum + row.state.protectedReads, 0), 0);
  assert.equal(rows.reduce((sum, row) => sum + row.state.bodiesRead, 0), 0);
});

test("deadline search consumes nonmatching and out-of-window positions without skipping unread candidates", async () => {
  let elapsed = 0;
  const future = message(1, "future-budget@example.com", { date: "2026-10-04T12:00:00.001Z", denyProtectedRead: true });
  const nonmatch = message(2, "nonmatch-budget@example.com", { onMetadata: () => { elapsed = 8000; } });
  const remaining = message(3, "remaining-budget@example.com");
  const fixture = nativeFixture({ rows: [future, nonmatch, remaining], pageClock: () => elapsed });
  const result = await fixture.runMail({ ...listArgs, action: "search", query: "absent", limit: 5 });
  assert.equal(result.messages.length, 0);
  assert.equal(result.coverage.inspected, 2);
  assert.equal(result.coverage.eligibleCount, 1);
  assert.equal(result.coverage.positionsConsumed, 2);
  assert.equal(result.coverage.nextOffset, 2);
  assert.equal(result.coverage.stopReason, "time_budget");
  assert.equal(future.state.protectedReads + remaining.state.protectedReads, 0);
});

test("zero-progress deadline explicitly stops without claiming end or inventing a next page", async () => {
  let clockCalls = 0;
  const fixture = nativeFixture({ pageClock: () => clockCalls++ === 0 ? 0 : 8000 });
  const result = await fixture.runMail({ ...listArgs, offset: 1 });
  assert.equal(result.messages.length, 0);
  assert.equal(result.coverage.stopReason, "time_budget");
  assert.equal(result.coverage.positionsConsumed, 0);
  assert.equal(result.coverage.inspected, 0);
  assert.equal(result.coverage.nextOffset, null);
  assert.equal(result.coverage.pageEndReached, false);
  assert.equal(result.coverage.scanTruncated, true);
  assert.deepEqual(fixture.indexedPositions, []);
});

test("scope changes and opaque candidate failures reject after a prefix rather than return a partial success", async () => {
  let changed = false;
  const first = message(1, "before-change@example.com", { onMetadata: () => { changed = true; } });
  const second = message(2, "after-change@example.com");
  const fixture = nativeFixture({ rows: [first, second], pageClock: () => 0, getMailboxOwner: (allowed) => changed ? { accountType: () => "iCloud", id: () => "foreign-account" } : allowed });
  await assert.rejects(fixture.runMail(listArgs), /owner does not match/);
  assert.ok(first.state.protectedReads > 0);
  assert.equal(second.state.protectedReads, 0);
  const opaque = nativeFixture({ rows: [message(1, "completed@example.com"), message(2, "unavailable@example.com", { denyProtectedRead: true })], pageClock: () => 0 });
  await assert.rejects(opaque.runMail(listArgs), /OUT_OF_WINDOW_PROTECTED_READ/);
});

test("pagination validation rejects forged partial stops, consumed positions and next offsets", async () => {
  const baseline = await nativeFixture().runMail(listArgs);
  for (const patch of [
    { positionsConsumed: -1 }, { positionsConsumed: 21 }, { positionsConsumed: 0 },
    { nextOffset: 3 }, { stopReason: "SYNTHETIC_PRIVATE_DIAGNOSTIC" },
    { pageEndReached: false, scanTruncated: false, nextOffset: 2 },
    { stopReason: "time_budget", pageEndReached: true },
    { stopReason: "time_budget", scanTruncated: false },
    { stopReason: "time_budget", positionsConsumed: 0, inspected: 0, eligibleCount: 0, pageEndReached: false, scanTruncated: true, nextOffset: 1 },
  ]) {
    const adapter = createScopedMailAdapter({ now: () => now, loadConfig: async () => mail, runScript: async () => ({ ...baseline, coverage: { ...baseline.coverage, ...patch } }) });
    await assert.rejects(adapter.runMail(listArgs), /pagination/);
  }
  const laterPage = createScopedMailAdapter({ now: () => now, loadConfig: async () => mail, runScript: async () => ({ ...baseline, coverage: { ...baseline.coverage, offset: 1, pageEndReached: true, scanTruncated: false, nextOffset: null } }) });
  await assert.rejects(laterPage.runMail({ ...listArgs, offset: 1 }), /contradicts its partial scan/);
});

test("scan skips future messages and new arrivals before protected getters; get and seed stay strict", async () => {
  for (const date of ["2026-10-05T12:00:00Z", "2026-10-04T12:00:00.001Z"]) {
    const current = message(1, "root@example.com");
    const future = message(4, "future@example.com", { date, denyProtectedRead: true });
    const fixture = nativeFixture({ rows: [current, future] });
    for (const action of ["list", "search", "thread"]) {
      const args = action === "thread" ? { ...getArgs, action } : { ...listArgs, action, ...(action === "search" ? { query: "Synthetic" } : {}) };
      const result = await fixture.runMail(args);
      assert.ok(result.messages.every((entry) => entry.id !== "4"));
      assert.equal(future.state.protectedReads, 0);
      assert.equal(future.state.bodiesRead, 0);
    }
    for (const action of ["get", "thread"]) await assert.rejects(fixture.runMail({ ...getArgs, action, id: "4" }), /bounded date window/);
    assert.equal(future.state.protectedReads, 0);
  }
});

test("thread reads header-linked messages across allowed mailboxes without subject heuristics", async () => {
  const fixture = nativeFixture();
  const result = await fixture.runMail({ ...getArgs, action: "thread" });
  assert.deepEqual(result.messages.map((entry) => entry.id), ["1", "2"]);
  assert.equal(fixture.seed.state.bodiesRead, 1);
  assert.equal(fixture.reply.state.bodiesRead, 1);
  assert.equal(fixture.unrelated.state.bodiesRead, 0);
  assert.equal(result.coverage.completeHistoricalConversation, false);
  assert.equal(result.coverage.historicalConversationComplete, false);
  assert.match(result.coverage.threadMethod, /RFC References/);
  assert.equal(result.messages[0].threadHeaders, undefined);
  assert.equal(fixture.calls.length, 3);
  assert.equal(fixture.calls[2].expectedRFC, "reply@example.com");
});

test("limited thread bodies always include the requested seed and mark result coverage partial", async () => {
  const fixture = nativeFixture();
  const result = await fixture.runMail({ action: "thread", accountId, mailboxId: sent.id, id: "2", limit: 1 });
  assert.deepEqual(result.messages.map((entry) => entry.id), ["2"]);
  assert.equal(result.coverage.resultLimited, true);
  assert.equal(result.coverage.completeHistoricalConversation, false);
  assert.equal(fixture.seed.state.bodiesRead, 0);
  assert.equal(fixture.reply.state.bodiesRead, 1);
});

test("thread operation shares one overall deadline and passes decreasing native budgets", async () => {
  const fixture = nativeFixture();
  let elapsed = 0;
  const budgets = [];
  const adapter = createScopedMailAdapter({ now: () => now, loadConfig: async () => mail, monotonicNow: () => elapsed, runScript: async (payload, options) => {
    budgets.push(options.timeoutMs);
    const result = await fixture.runScript(payload);
    elapsed += payload.op === "snapshot" ? 40000 : 6000;
    return result;
  } });
  await assert.rejects(adapter.runMail({ ...getArgs, action: "thread" }), (error) => error.code === "MAIL_OPERATION_DEADLINE");
  assert.deepEqual(budgets, [20000, 5000]);
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.reply.state.bodiesRead, 0);
  assert.throws(() => createScopedMailAdapter({ operationTimeoutMs: 45001 }), /overall operation/);
});

test("overall deadline aborts a stalled native read and never returns a complete result", async () => {
  let nativeSignal;
  const adapter = createScopedMailAdapter({ now: () => now, loadConfig: async () => mail, operationTimeoutMs: 10, runScript: async (_payload, options) => {
    nativeSignal = options.signal;
    return new Promise(() => {});
  } });
  await assert.rejects(adapter.runMail(getArgs), (error) => error.code === "MAIL_OPERATION_DEADLINE");
  assert.equal(nativeSignal.aborted, true);
});

test("overall deadline bounds stalled configuration and never dispatches even if it later resolves", async () => {
  let finishConfig, nativeCalls = 0;
  const config = new Promise((resolve) => { finishConfig = resolve; });
  const adapter = createScopedMailAdapter({ now: () => now, operationTimeoutMs: 10, loadConfig: () => config, runScript: async () => { nativeCalls++; } });
  await assert.rejects(adapter.runMail(getArgs), (error) => error.code === "MAIL_OPERATION_DEADLINE");
  finishConfig(mail);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nativeCalls, 0);
});

test("ambiguous RFC identities prevent guessed thread body reads", async () => {
  const fixture = nativeFixture({ rows: [message(1, "root@example.com"), message(3, "root@example.com")] });
  await assert.rejects(fixture.runMail({ ...getArgs, action: "thread" }), /duplicate RFC/);
  assert.equal(fixture.inboxRows.reduce((total, row) => total + row.state.bodiesRead, 0), 0);
  assert.equal(fixture.reply.state.bodiesRead, 0);
});

test("RFC parser bounds and unfolds headers while rejecting duplicates and malformed relationships", () => {
  assert.deepEqual(parseMailThreadHeaders("Message-ID: <synthetic@example.com>\r\nReferences: <one@example.com>\r\n <two@example.com>\r\nIn-Reply-To: <two@example.com>"), { messageId: "synthetic@example.com", references: ["one@example.com", "two@example.com"], inReplyTo: ["two@example.com"], malformed: false, truncated: false });
  for (const headers of ["Message-ID: <a@example.com>\nMessage-ID: <b@example.com>", "Message-ID: <a@example.com>\nReferences: guessed-subject", "Message-ID: <a@example.com>\nReferences: <b@example.com> <b@example.com>"]) assert.equal(parseMailThreadHeaders(headers).malformed, true);
  assert.equal(parseMailThreadHeaders("x".repeat(8193)).truncated, true);
});

test("response validation drops unsupported fields and rejects foreign scope/identity", async () => {
  const fixture = nativeFixture();
  const result = await fixture.runMail(getArgs);
  for (const patch of [{ accountId: "foreign" }, { mailboxId: sent.id }, { id: "2" }, { content: "x".repeat(16385) }]) {
    const adapter = createScopedMailAdapter({ loadConfig: async () => mail, now: () => now, runScript: async () => ({ success: true, message: { ...result.message, ...patch } }) });
    await assert.rejects(adapter.runMail(getArgs));
  }
  const extra = createScopedMailAdapter({ loadConfig: async () => mail, now: () => now, runScript: async () => ({ success: true, message: { ...result.message, source: "SYNTHETIC_PRIVATE_SOURCE", attachments: ["ignored"] } }) });
  assert.equal((await extra.runMail(getArgs)).message.source, undefined);
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter(); child.stdin = new EventEmitter(); child.stdin.end = (text) => { child.input = text; };
  child.kills = []; child.kill = (signal) => { child.kills.push(signal); };
  return child;
}
const authorized = { success: true, target: "com.apple.mail", running: true, authorized: true, prompted: false, authorization: "authorized" };

test("Mail permission preflight strictly requires already-running unprompted exact Mail grant", async () => {
  for (const patch of [{}, { running: false }, { authorized: false }, { prompted: true }, { target: "com.apple.Notes" }]) {
    const child = fakeChild();
    const promise = checkMailAccess({ platform: "darwin", accessCliPath: "/synthetic/bin/mail-access-cli", spawnImpl: (command, args, options) => { assert.equal(command, "/synthetic/bin/mail-access-cli"); assert.deepEqual(args, ["status"]); assert.equal(options.shell, false); return child; } });
    child.stdout.emit("data", JSON.stringify({ ...authorized, ...patch })); child.emit("close", 0);
    if (Object.keys(patch).length) await assert.rejects(promise, /already be running/); else assert.equal((await promise).authorized, true);
  }
});

test("fixed JXA runs only after permission preflight, with JSON argv/no shell and bounded redacted failures", async () => {
  const child = fakeChild(); let captured;
  const payload = buildMailInvocation(listArgs, validateMailConfig({ mail }), now);
  const promise = runScopedMailScript(payload, { platform: "darwin", preflightImpl: async () => authorized, spawnImpl: (...args) => { captured = args; return child; } });
  await Promise.resolve();
  assert.equal(captured[0], "/usr/bin/osascript"); assert.deepEqual(captured[1].slice(0, 3), ["-l", "JavaScript", "-"]);
  assert.deepEqual(JSON.parse(captured[1][3]), { ...payload, pageBudgetMs: 8000 }); assert.equal(captured[2].shell, false); assert.equal(child.input, SCOPED_MAIL_JXA);
  assert.deepEqual(Object.keys(captured[2].env).sort(), ["HOME", "LANG", "PATH"]);
  assert.equal(captured[2].env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  child.stderr.emit("data", "SYNTHETIC_PRIVATE_DIAGNOSTIC"); child.emit("close", 1);
  await assert.rejects(promise, (error) => error instanceof MailReadError && error.code === "MAIL_NATIVE_FAILED" && !JSON.stringify(mailReadErrorDetails(error)).includes("SYNTHETIC_PRIVATE_DIAGNOSTIC"));
  let spawned = false;
  await assert.rejects(runScopedMailScript(payload, { platform: "darwin", preflightImpl: async () => { throw new Error("not granted"); }, spawnImpl: () => { spawned = true; } }), /not granted/);
  assert.equal(spawned, false);
  const oversized = fakeChild();
  const huge = runScopedMailScript(payload, { platform: "darwin", preflightImpl: async () => authorized, spawnImpl: () => oversized });
  await Promise.resolve(); oversized.stdout.emit("data", "x".repeat(1024 * 1024 + 1));
  await assert.rejects(huge, /output exceeded/); assert.deepEqual(oversized.kills, ["SIGTERM"]); oversized.emit("close", null);
  const noisy = fakeChild();
  const diagnostics = runScopedMailScript(payload, { platform: "darwin", preflightImpl: async () => authorized, spawnImpl: () => noisy });
  await Promise.resolve(); noisy.stderr.emit("data", "x".repeat(16385));
  await assert.rejects(diagnostics, (error) => error.code === "MAIL_NATIVE_LIMIT"); assert.deepEqual(noisy.kills, ["SIGTERM"]); noisy.emit("close", null);
});

test("native timeout and abort produce typed redacted failures and terminate only the owned child", async () => {
  const payload = buildMailInvocation(listArgs, validateMailConfig({ mail }), now);
  const stalled = fakeChild();
  const timeout = runScopedMailScript(payload, { platform: "darwin", timeoutMs: 20, preflightImpl: async () => authorized, spawnImpl: () => stalled });
  await assert.rejects(timeout, (error) => error.code === "MAIL_NATIVE_TIMEOUT" && mailReadErrorDetails(error).reason === "timeout");
  assert.deepEqual(stalled.kills, ["SIGTERM"]);
  stalled.stdout.emit("data", JSON.stringify({ success: true, messages: [] }));
  stalled.emit("close", 0); // Late success cannot replace the failed result.
  const child = fakeChild(), controller = new AbortController();
  const aborted = runScopedMailScript(payload, { platform: "darwin", preflightImpl: async () => authorized, spawnImpl: () => child, signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(aborted, (error) => error.code === "MAIL_NATIVE_ABORTED");
  assert.deepEqual(child.kills, ["SIGTERM"]); child.emit("close", null);
  let launched = false;
  await assert.rejects(runScopedMailScript(payload, { platform: "darwin", preflightImpl: async () => authorized, spawnImpl: () => { launched = true; }, signal: controller.signal }), (error) => error.code === "MAIL_NATIVE_ABORTED");
  assert.equal(launched, false);
});

test("invalid native JSON and preflight failures expose fixed codes without raw output", async () => {
  const child = fakeChild();
  const promise = runScopedMailScript(buildMailInvocation(listArgs, validateMailConfig({ mail }), now), { platform: "darwin", preflightImpl: async () => authorized, spawnImpl: () => child });
  await Promise.resolve(); child.stdout.emit("data", "SYNTHETIC_PRIVATE_INVALID_JSON"); child.emit("close", 0);
  await assert.rejects(promise, (error) => error.code === "MAIL_NATIVE_INVALID_RESPONSE" && !error.message.includes("SYNTHETIC_PRIVATE"));
  const preflight = fakeChild();
  const denied = checkMailAccess({ platform: "darwin", accessCliPath: "/synthetic/bin/mail-access-cli", spawnImpl: () => preflight });
  preflight.stderr.emit("data", "SYNTHETIC_PRIVATE_PREFLIGHT"); preflight.emit("close", 1);
  await assert.rejects(denied, (error) => error.code === "MAIL_PREFLIGHT_FAILED" && !error.message.includes("SYNTHETIC_PRIVATE"));
  const expired = fakeChild();
  const timed = checkMailAccess({ platform: "darwin", accessCliPath: "/synthetic/bin/mail-access-cli", timeoutMs: 10, spawnImpl: () => expired });
  await assert.rejects(timed, (error) => error.code === "MAIL_PREFLIGHT_TIMEOUT");
  assert.deepEqual(expired.kills, ["SIGTERM"]); expired.emit("close", null);
});

test("Mail error serialization ignores arbitrary codes and preserves only fixed failure facts", () => {
  assert.equal(mailReadErrorDetails(Object.assign(new Error("synthetic"), { code: "MAIL_NATIVE_TIMEOUT" })), null);
  for (const code of ["toString", "constructor", "SYNTHETIC_PRIVATE_CODE"]) assert.throws(() => new MailReadError(code), /Unsupported/);
  const error = new MailReadError("MAIL_NATIVE_TIMEOUT");
  error.message = "SYNTHETIC_PRIVATE_DIAGNOSTIC";
  error.phase = "SYNTHETIC_PRIVATE_PHASE";
  assert.equal(JSON.stringify(mailReadErrorDetails(error)).includes("SYNTHETIC_PRIVATE"), false);
});

test("child environment contains only fixed runtime keys and OS-derived HOME", () => {
  const env = mailChildEnvironment();
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "PATH"]);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.DYLD_INSERT_LIBRARIES, undefined);
  assert.equal(env.APPLE_PIM_CONFIG_DIR, undefined);
  assert.equal(env.LANG, "en_US.UTF-8");
});

test("synchronous launch and script-input failures redact private diagnostics", async () => {
  const payload = buildMailInvocation(listArgs, validateMailConfig({ mail }), now);
  await assert.rejects(runScopedMailScript(payload, { platform: "darwin", preflightImpl: async () => authorized, spawnImpl: () => { throw new Error("SYNTHETIC_PRIVATE_LAUNCH"); } }), (error) => /executable unavailable/.test(error.message) && !error.message.includes("SYNTHETIC_PRIVATE_LAUNCH"));
  const child = fakeChild();
  child.stdin.end = () => { throw new Error("SYNTHETIC_PRIVATE_INPUT"); };
  await assert.rejects(runScopedMailScript(payload, { platform: "darwin", preflightImpl: async () => authorized, spawnImpl: () => child }), (error) => /script input failed/.test(error.message) && !error.message.includes("SYNTHETIC_PRIVATE_INPUT"));
  assert.deepEqual(child.kills, ["SIGTERM"]);
  child.emit("close", null);
});

test("private Mail config requires owner-only storage outside Git and rejects malformed/default/profile fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apple-pim-mail-synthetic-"));
  const configPath = join(directory, "config.json"), env = { APPLE_PIM_CONFIG_DIR: directory };
  try {
    await chmod(directory, 0o700); await writeFile(configPath, JSON.stringify({ mail }), { mode: 0o600 });
    assert.equal((await loadMailConfig(env)).mailboxes[0].id, inbox.id);
    await assert.rejects(loadMailConfig({}), /explicit absolute/);
    await assert.rejects(loadMailConfig({ ...env, APPLE_PIM_PROFILE: "other" }), /profiles/);
    await chmod(configPath, 0o644); await assert.rejects(loadMailConfig(env), /owner-only/);
    await chmod(configPath, 0o600); await writeFile(configPath, "not JSON"); await assert.rejects(loadMailConfig(env), /malformed/);
    await writeFile(configPath, JSON.stringify({ mail })); await link(configPath, join(directory, "hardlink.json")); await assert.rejects(loadMailConfig(env), /owner-only/);
    await rm(join(directory, "hardlink.json")); await writeFile(join(directory, ".git"), "synthetic-worktree-marker"); await assert.rejects(loadMailConfig(env), /outside Git/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
