import { isAbsolute, join } from "node:path";
import { loadMailConfig, validateMailConfig } from "./scoped-mail-config.js";
import { selectMailThread } from "./scoped-mail-headers.js";
import { SCOPED_MAIL_JXA } from "./scoped-mail-script.js";
import { spawnProcess } from "./safe-shell.js";
import { userInfo } from "node:os";
import { performance } from "node:perf_hooks";
import { MailReadError } from "./mail-read-error.js";

export const mailTool = {
  name: "mail",
  description: "Read-only scoped local iCloud Mail. Actions list/search/get/thread. Exact native account ID and host-derived mailbox path key required. No send, mark-read, delete, attachments, or discovery. Thread uses bounded RFC header relationships, never guarantees complete historical conversations.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "search", "get", "thread", "schema"] },
      accountId: { type: "string", description: "Exact allowed native Mail account ID." },
      mailboxId: { type: "string", description: "Enrolled SHA256 account/path key; Mail exposes no native mailbox ID." },
      id: { type: "string", pattern: "^[1-9][0-9]*$", description: "Local numeric message ID for get/thread; never used outside the selected mailbox." },
      query: { type: "string", minLength: 1, maxLength: 2048, description: "Search subject/sender metadata only." },
      since: { type: "string", format: "date-time", description: "UTC lower date bound; defaults to seven days ago, maximum 31 days." },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "List/search candidate cap, default 20; a cooperative page deadline may return fewer with explicit partial coverage. Thread body limit with at most 200 header candidates." },
      offset: { type: "integer", minimum: 0, maximum: 199, description: "List/search index in the scoped date-filtered collection, default 0. offset+limit must not exceed 200; native ordering and page stability are unspecified." },
    },
    required: ["action"], additionalProperties: false,
  },
};

export function mailChildEnvironment() {
  const environment = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" };
  const home = userInfo().homedir;
  if (typeof home === "string" && isAbsolute(home)) environment.HOME = home;
  return environment;
}

function processJSON(command, argv, { spawnImpl, input, timeoutMs, outputLimit, phase = "NATIVE", signal }) {
  return new Promise((resolve, reject) => {
    const failure = (reason) => new MailReadError(`MAIL_${phase}_${reason}`);
    if (signal?.aborted) { reject(failure("ABORTED")); return; }
    let child;
    try { child = spawnImpl(command, argv, { shell: false, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], env: mailChildEnvironment() }); }
    catch { reject(failure("UNAVAILABLE")); return; }
    let output = "", size = 0, stderrSize = 0, settled = false, killTimer;
    const fail = (reason, kill = false) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (kill) { child.kill("SIGTERM"); killTimer = setTimeout(() => child.kill("SIGKILL"), 1000); killTimer.unref?.(); }
      reject(failure(reason));
    };
    const abort = () => fail("ABORTED", true);
    const timer = setTimeout(() => fail("TIMEOUT", true), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      size += Buffer.byteLength(chunk, "utf8");
      if (size > outputLimit) { fail("LIMIT", true); return; }
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (settled) return;
      stderrSize += Buffer.byteLength(chunk);
      if (stderrSize > 16384) fail("LIMIT", true);
    }); // Never expose diagnostics containing mail data.
    child.on("error", () => fail("UNAVAILABLE"));
    if (input !== undefined) child.stdin.on("error", () => fail("INPUT_FAILED", true));
    child.on("close", (code) => {
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", abort);
      if (settled) return;
      if (code !== 0) { fail("FAILED"); return; }
      try { const value = JSON.parse(output); settled = true; resolve(value); }
      catch { fail("INVALID_RESPONSE"); }
    });
    if (input !== undefined) {
      try { child.stdin.end(input); }
      catch { fail("INPUT_FAILED", true); }
    }
  });
}

export async function checkMailAccess({ accessCliPath, spawnImpl = spawnProcess, platform = process.platform, timeoutMs = 2000, signal } = {}) {
  if (platform !== "darwin") throw new Error("Scoped Mail requires macOS");
  if (typeof accessCliPath !== "string" || !isAbsolute(accessCliPath)) throw new Error("Mail permission preflight requires the fixed checkout mail-access-cli path");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error("Mail preflight timeout is invalid");
  const status = await processJSON(accessCliPath, ["status"], { spawnImpl, timeoutMs, signal, outputLimit: 4096, phase: "PREFLIGHT" });
  if (!status || status.success !== true || status.target !== "com.apple.mail" || status.running !== true || status.authorized !== true || status.prompted !== false || status.authorization !== "authorized") throw new MailReadError("MAIL_PREFLIGHT_DENIED");
  return status;
}

export async function runScopedMailScript(payload, { accessCliPath, preflightImpl = checkMailAccess, spawnImpl = spawnProcess, platform = process.platform, timeoutMs = 20000, signal } = {}) {
  if (platform !== "darwin") throw new Error("Scoped Mail requires macOS");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error("Mail timeout is invalid");
  const started = performance.now();
  await preflightImpl({ accessCliPath, spawnImpl, platform, signal, timeoutMs: Math.min(2000, timeoutMs) });
  const remaining = Math.floor(timeoutMs - (performance.now() - started));
  if (remaining < 1) throw new MailReadError("MAIL_OPERATION_DEADLINE");
  if (signal?.aborted) throw new MailReadError("MAIL_NATIVE_ABORTED");
  // Cooperative stops reserve time to serialize completed metadata before the
  // hard subprocess deadline. A single stalled AppleEvent still hits that cap.
  const nativePayload = ["list", "search"].includes(payload.op)
    ? { ...payload, pageBudgetMs: Math.min(8000, Math.max(1, remaining - 2000)) }
    : payload;
  return processJSON("/usr/bin/osascript", ["-l", "JavaScript", "-", JSON.stringify(nativePayload)], { spawnImpl, input: SCOPED_MAIL_JXA, timeoutMs: remaining, signal, outputLimit: 1024 * 1024 });
}

export function buildMailInvocation(args, config, now = new Date()) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Mail arguments must be an object");
  const fields = {
    list: ["action", "accountId", "mailboxId", "since", "limit", "offset"],
    search: ["action", "accountId", "mailboxId", "since", "limit", "query", "offset"],
    get: ["action", "accountId", "mailboxId", "since", "id"],
    thread: ["action", "accountId", "mailboxId", "since", "limit", "id"],
  }[args.action];
  if (!fields || Object.keys(args).some((key) => !fields.includes(key))) throw new Error("Mail action/parameters are unsupported; this interface is strictly read-only and host-scoped");
  if (!config.accounts.includes(args.accountId)) throw new Error("Mail requires an exact allowed accountId");
  const record = config.mailboxes.find((entry) => entry.id === args.mailboxId && entry.accountId === args.accountId);
  if (!record) throw new Error("Mail requires an exact allowed mailboxId bound to the requested account");
  const untilEpoch = now.getTime();
  if (!Number.isFinite(untilEpoch)) throw new Error("Mail host clock is invalid");
  let sinceEpoch = untilEpoch - 7 * 86400000;
  if (args.since !== undefined) {
    if (typeof args.since !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(args.since)) throw new Error("Mail since must be a valid UTC ISO timestamp");
    sinceEpoch = Date.parse(args.since);
    if (!Number.isFinite(sinceEpoch) || new Date(sinceEpoch).toISOString().replace(/\.000Z$/u, "Z") !== args.since.replace(/\.000Z$/u, "Z")) throw new Error("Mail since timestamp is invalid");
  }
  if (sinceEpoch < untilEpoch - 31 * 86400000 || sinceEpoch > untilEpoch) throw new Error("Mail date window must be within the last 31 days");
  const limit = args.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Mail limit must be an integer from 1 to 50");
  const offset = ["list", "search"].includes(args.action) ? args.offset ?? 0 : undefined;
  if (offset !== undefined && (!Number.isInteger(offset) || offset < 0 || offset > 199 || offset + limit > 200)) throw new Error("Mail offset requires 0 to 199 with offset+limit at most 200");
  if (args.action === "search" && (typeof args.query !== "string" || !args.query.trim() || args.query.length > 2048 || /[\u0000]/u.test(args.query))) throw new Error("Mail query must be nonempty bounded text");
  if (["get", "thread"].includes(args.action) && (typeof args.id !== "string" || !/^[1-9]\d*$/u.test(args.id) || !Number.isSafeInteger(Number(args.id)))) throw new Error("Mail id must be an exact positive local numeric message ID string");
  return { op: args.action === "thread" ? "snapshot" : args.action, accountId: args.accountId, mailboxId: args.mailboxId, ...(args.id ? { id: args.id } : {}), ...(args.query ? { query: args.query } : {}), ...(offset !== undefined ? { offset } : {}), limit, sinceEpoch, untilEpoch, since: new Date(sinceEpoch).toISOString(), until: now.toISOString(), mailboxes: config.mailboxes.filter((entry) => entry.accountId === args.accountId).map((entry) => ({ id: entry.id, accountId: entry.accountId, path: [...entry.path] })) };
}

function safeMessage(message, invocation, { body = false, snapshot = false, anyAllowedMailbox = false } = {}) {
  const record = invocation.mailboxes.find((entry) => entry.id === message?.mailboxId && entry.accountId === message?.accountId);
  const received = Date.parse(message?.dateReceived);
  if (!record || message.accountId !== invocation.accountId || (!anyAllowedMailbox && message.mailboxId !== invocation.mailboxId) || typeof message.id !== "string" || !/^[1-9]\d*$/u.test(message.id) || !Number.isSafeInteger(Number(message.id)) || typeof message.messageId !== "string" || message.messageId.length > 998 || /[<>\s]/u.test(message.messageId) || typeof message.subject !== "string" || message.subject.length > 4096 || typeof message.sender !== "string" || message.sender.length > 4096 || !Number.isFinite(received) || received < invocation.sinceEpoch || received > invocation.untilEpoch || typeof message.isRead !== "boolean" || typeof message.metadataTruncated !== "boolean") throw new Error("Mail response is invalid, out of scope, or outside the bounded date window");
  const output = { id: message.id, messageId: message.messageId, accountId: message.accountId, mailboxId: message.mailboxId, subject: message.subject, sender: message.sender, dateReceived: message.dateReceived, isRead: message.isRead, metadataTruncated: message.metadataTruncated };
  if (body) {
    if (typeof message.content !== "string" || message.content.length > 16384 || typeof message.contentTruncated !== "boolean" || message.attachmentsOmitted !== true) throw new Error("Mail content response is invalid or exceeds its limit");
    output.content = message.content; output.contentTruncated = message.contentTruncated; output.attachmentsOmitted = true;
  }
  if (snapshot) {
    const headers = message.threadHeaders;
    if (!headers || typeof headers.messageId !== "string" || headers.messageId.length > 998 || typeof headers.malformed !== "boolean" || typeof headers.truncated !== "boolean" || ![headers.references, headers.inReplyTo].every((ids) => Array.isArray(ids) && ids.length <= 64 && ids.every((id) => typeof id === "string" && id && id.length <= 998 && !/[<>\s]/u.test(id)))) throw new Error("Mail thread header response is invalid");
    if (!headers.malformed && !headers.truncated && headers.messageId !== output.messageId) throw new Error("Mail RFC message identity disagrees with its headers");
    output.threadHeaders = { messageId: headers.messageId, references: [...headers.references], inReplyTo: [...headers.inReplyTo], malformed: headers.malformed, truncated: headers.truncated };
    output.key = output.mailboxId + "/" + output.id;
  }
  return output;
}

function safeCoverage(coverage, invocation) {
  if (!coverage || coverage.since !== invocation.since || coverage.until !== invocation.until || !Number.isInteger(coverage.inspected) || coverage.inspected < 0 || coverage.inspected > 200 || !Number.isSafeInteger(coverage.eligibleCount) || coverage.eligibleCount < 0 || typeof coverage.scanTruncated !== "boolean" || typeof coverage.resultLimited !== "boolean" || coverage.historicalConversationComplete !== false) throw new Error("Mail coverage response is invalid");
  const output = { since: invocation.since, until: invocation.until, inspected: coverage.inspected, eligibleCount: coverage.eligibleCount, scanTruncated: coverage.scanTruncated, resultLimited: coverage.resultLimited, ordering: "newest among inspected candidates", historicalConversationComplete: false };
  if (["list", "search"].includes(invocation.op)) {
    if (!Number.isInteger(coverage.positionsConsumed) || coverage.positionsConsumed < 0 || coverage.positionsConsumed > invocation.limit || coverage.inspected > coverage.positionsConsumed || coverage.eligibleCount > coverage.inspected || coverage.offset !== invocation.offset || typeof coverage.pageEndReached !== "boolean" || ![null, "time_budget"].includes(coverage.stopReason) || (coverage.stopReason === "time_budget" && (coverage.pageEndReached || !coverage.scanTruncated))) throw new Error("Mail pagination coverage is invalid");
    const nextPosition = invocation.offset + coverage.positionsConsumed;
    const expectedNextOffset = !coverage.pageEndReached && coverage.positionsConsumed > 0 && nextPosition < 200 ? nextPosition : null;
    if (coverage.nextOffset !== expectedNextOffset) throw new Error("Mail pagination cannot invent progress beyond completed positions");
    if (coverage.scanTruncated !== (coverage.stopReason === "time_budget" || invocation.offset > 0 || !coverage.pageEndReached)) throw new Error("Mail pagination coverage contradicts its partial scan");
    output.offset = coverage.offset; output.nextOffset = coverage.nextOffset; output.pageEndReached = coverage.pageEndReached; output.positionsConsumed = coverage.positionsConsumed;
    output.stopReason = coverage.stopReason;
    output.ordering = "received date within bounded native-index page; mailbox order is unspecified";
  }
  return output;
}

export function createScopedMailAdapter({ binDir, env = process.env, loadConfig = () => loadMailConfig(env), runScript, now = () => new Date(), monotonicNow = () => performance.now(), operationTimeoutMs = 45000 } = {}) {
  if (!Number.isInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > 45000) throw new Error("Mail overall operation timeout must be 1 to 45000 milliseconds");
  const nativeRunner = runScript ?? ((payload, options) => runScopedMailScript(payload, { ...options, accessCliPath: typeof binDir === "string" ? join(binDir, "mail-access-cli") : undefined }));
  return {
    async runMail(args) {
      const deadline = monotonicNow() + operationTimeoutMs;
      const deadlineError = () => new MailReadError("MAIL_OPERATION_DEADLINE");
      const withinDeadline = (task) => {
        const remaining = Math.floor(deadline - monotonicNow());
        if (remaining < 1) return Promise.reject(deadlineError());
        const controller = new AbortController();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { controller.abort(); reject(deadlineError()); }, remaining);
          Promise.resolve().then(() => task({ remaining, signal: controller.signal })).then((value) => {
            if (deadline - monotonicNow() < 1) { controller.abort(); reject(deadlineError()); }
            else resolve(value);
          }, reject).finally(() => clearTimeout(timer));
        });
      };
      const callNative = (payload) => withinDeadline(({ remaining, signal }) => nativeRunner(payload, { timeoutMs: Math.min(20000, remaining), signal }));
      const config = validateMailConfig({ mail: await withinDeadline(() => loadConfig()) });
      const invocation = buildMailInvocation(args, config, now());
      const result = await callNative(invocation);
      if (!result || result.success !== true) throw new Error("Mail command did not report success");
      if (args.action === "get") {
        const message = safeMessage(result.message, invocation, { body: true });
        if (message.id !== args.id) throw new Error("Mail message ID does not match the scoped request");
        return { success: true, message };
      }
      const coverage = safeCoverage(result.coverage, invocation);
      if (!Array.isArray(result.messages) || result.messages.length > (args.action === "thread" ? 200 : invocation.limit)) throw new Error("Mail response exceeds its bounded result count");
      if (args.action !== "thread" && result.messages.length > coverage.eligibleCount) throw new Error("Mail pagination returned more messages than its inspected eligible count");
      const snapshot = args.action === "thread";
      const messages = result.messages.map((message) => safeMessage(message, invocation, { snapshot, anyAllowedMailbox: snapshot }));
      if (new Set(messages.map((message) => message.mailboxId + "/" + message.id)).size !== messages.length) throw new Error("Mail returned duplicate local scoped message IDs");
      if (!snapshot) return { success: true, messages, coverage };
      const selected = selectMailThread(messages, args.mailboxId + "/" + args.id).sort((a, b) => Date.parse(a.dateReceived) - Date.parse(b.dateReceived));
      let selectedBodies = selected;
      if (selected.length > invocation.limit) {
        const seed = selected.find((message) => message.mailboxId === args.mailboxId && message.id === args.id);
        selectedBodies = [...selected.filter((message) => message !== seed).slice(0, invocation.limit - 1), seed].sort((a, b) => Date.parse(a.dateReceived) - Date.parse(b.dateReceived));
      }
      const threadMessages = [];
      for (const candidate of selectedBodies) {
        const readInvocation = { ...invocation, op: "get", mailboxId: candidate.mailboxId, id: candidate.id, expectedRFC: candidate.messageId };
        const readResult = await callNative(readInvocation);
        if (!readResult || readResult.success !== true) throw new Error("Mail thread body read did not report success");
        const message = safeMessage(readResult.message, readInvocation, { body: true });
        if (message.id !== candidate.id || message.messageId !== candidate.messageId) throw new Error("Mail thread message identity changed before content read");
        threadMessages.push(message);
      }
      return { success: true, messages: threadMessages, coverage: { ...coverage, ordering: "oldest first among selected related messages", resultLimited: selected.length > invocation.limit, threadMethod: "RFC References/In-Reply-To graph within allowed mailboxes and date window", headerRelationshipsIncomplete: messages.some((message) => message.threadHeaders.malformed || message.threadHeaders.truncated), completeHistoricalConversation: false, bodyTruncated: threadMessages.some((message) => message.contentTruncated) } };
    },
  };
}
