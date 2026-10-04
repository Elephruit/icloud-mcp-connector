import { assertMailSendSender, loadMailSendContext } from "./scoped-mail-send-config.js";
import { createMailSendPreview } from "./scoped-mail-send-payload.js";
import { createMailSendStore, validateMailSendApprovalId } from "./scoped-mail-send-store.js";

export const MAIL_SEND_NATIVE_BLOCKER = "Mail native account binding is unverified: outgoing messages expose a sender string but no native account selector. Dispatch is blocked before draft creation.";

// A separate approved metadata-only proof must establish unique ownership of
// the configured From address across native account IDs before any dispatch.
// No such metadata lookup is performed by preview/send or silently authorized.
// A future native runner must also reject auto-Cc/Bcc-self preferences, disable
// signatures, verify exact recipients/body and absence of attachments, and
// treat every failure after draft creation as unknown without automatic cleanup.

export const mailSendTool = {
  name: "mail-send",
  description: "Source-only Mail send foundation. Preview exact account/from/To/Cc/Bcc/subject/plaintext body for manual approval; status reads only local exact-payload journal evidence. Native sending is blocked pending account-routing proof. No attachments or inferred footer. Approval cannot be armed through MCP; consumed payloads have no automatic retry/reset.",
  inputSchema: {
    type: "object", additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["preview", "send", "status", "schema"] },
      accountId: { type: "string" }, from: { type: "string" },
      to: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
      cc: { type: "array", items: { type: "string" }, maxItems: 20 }, bcc: { type: "array", items: { type: "string" }, maxItems: 20 },
      subject: { type: "string", minLength: 1, maxLength: 240 }, body: { type: "string", minLength: 1, maxLength: 32768 },
      digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
      approvalId: { type: "string", description: "Separate owner-armed short-lived approval UUID; supplying this is not approval itself." },
    }, required: ["action"],
  },
};

function requestPreview(args) {
  if (!args || typeof args !== "object" || Array.isArray(args) || !["preview", "send", "status"].includes(args.action)) throw new Error("Mail send action is unsupported");
  const fields = ["action", "accountId", "from", "to", "cc", "bcc", "subject", "body", ...(args.action !== "preview" ? ["digest", "approvalId"] : [])];
  if (Object.keys(args).some((key) => !fields.includes(key))) throw new Error("Mail send rejects unrecognized parameters and model-provided consent");
  const { action, digest, approvalId, ...payload } = args;
  const preview = createMailSendPreview(payload);
  if (action !== "preview" && digest !== preview.digest) throw new Error("Mail send/status requires the exact preview digest");
  return preview;
}

/** runSend is a host-only synthetic/future verified native seam, never an MCP arg. */
export function createScopedMailSendAdapter({ env = process.env, loadContext = () => loadMailSendContext(env), storeFactory = createMailSendStore, runSend, now = () => new Date(), operationTimeoutMs = 30000 } = {}) {
  if (!Number.isInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > 30000) throw new Error("Mail send operation timeout must be 1 to 30000 milliseconds");
  return Object.freeze({
    async runMailSend(args) {
      if (args?.action === "schema") {
        if (Array.isArray(args) || Object.keys(args).length !== 1) throw new Error("Mail send schema accepts only action");
        return { success: true, tool: mailSendTool, nativeDispatchAvailable: false };
      }
      const preview = requestPreview(args), context = await loadContext();
      assertMailSendSender(preview.payload, context.sendConfig, { requireEnabled: args.action === "send" });
      if (args.action === "preview") return { success: true, preview, approvalRequired: true, nativeDispatchAvailable: false };
      validateMailSendApprovalId(args.approvalId);
      if (args.action === "status") {
        const store = await storeFactory({ configDirectory: context.configDirectory, now });
        return { success: true, ...(await store.inspect(args.approvalId, preview)) };
      }
      if (typeof runSend !== "function") throw Object.assign(new Error(MAIL_SEND_NATIVE_BLOCKER), { code: "MAIL_SEND_ACCOUNT_BINDING_UNVERIFIED" });
      const store = await storeFactory({ configDirectory: context.configDirectory, now });
      const claim = await store.claim(args.approvalId, preview);
      const assertApprovalCurrent = () => {
        const clock = now().getTime(), expires = Date.parse(claim.expiresAt);
        if (!Number.isFinite(clock) || !Number.isFinite(expires) || clock >= expires) throw new Error("Mail send approval expired before the native attempt");
      };
      // Re-read policy after consuming approval and before the native attempt.
      try {
        const latest = await loadContext();
        if (latest.configDirectory !== context.configDirectory) throw new Error("Mail send state root changed");
        assertMailSendSender(preview.payload, latest.sendConfig, { requireEnabled: true });
        assertApprovalCurrent();
      } catch {
        try { await store.recordOutcome(claim, "blocked"); } catch { /* pending still blocks reuse */ }
        throw Object.assign(new Error("Mail sending policy or approval lifetime changed after claim; this approval is consumed and no native send was attempted"), { code: "MAIL_SEND_SCOPE_CHANGED" });
      }
      const controller = new AbortController(); let timer, nativeAttempted = false;
      try {
        const response = await Promise.race([
          Promise.resolve().then(() => {
            assertApprovalCurrent();
            nativeAttempted = true;
            return runSend(preview.payload, { signal: controller.signal, approvalId: claim.approvalId, digest: claim.digest, expiresAt: claim.expiresAt });
          }),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Mail send native attempt timed out")); }, operationTimeoutMs); }),
        ]);
        if (response?.acceptedByMail !== true) throw new Error("Mail did not report local acceptance");
        await store.recordOutcome(claim, "submitted");
        return { success: true, status: "submitted", deliveryConfirmed: false, approvalId: claim.approvalId, digest: claim.digest };
      } catch {
        try { await store.recordOutcome(claim, nativeAttempted ? "unknown" : "blocked"); } catch { /* durable pending still blocks reuse */ }
        if (!nativeAttempted) throw Object.assign(new Error("Mail send approval expired before dispatch; this approval is consumed and no native send was attempted"), { code: "MAIL_SEND_SCOPE_CHANGED" });
        throw Object.assign(new Error("Mail send outcome is unknown; this approval is consumed. Reconcile locally and do not retry automatically."), { code: "MAIL_SEND_OUTCOME_UNKNOWN", approvalId: claim.approvalId, digest: claim.digest });
      } finally { clearTimeout(timer); }
    },
  });
}
