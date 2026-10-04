import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { assertPrivateMailSendDirectory, readPrivateMailSendJSON, readPrivateMailSendText } from "./scoped-mail-send-config.js";
import { validateMailSendPreview } from "./scoped-mail-send-payload.js";

export const MAIL_SEND_APPROVAL_MAX_BYTES = 128 * 1024;

export function validateMailSendApprovalId(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) throw new Error("Mail send approval ID is invalid");
  return value;
}

async function syncDirectory(path) {
  let directory;
  try { directory = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); await directory.sync(); }
  catch { throw new Error("Mail send private state directory could not be synchronized"); }
  finally { try { await directory?.close(); } catch { throw new Error("Mail send private state directory could not be safely closed"); } }
}

async function privateChildDirectory(path, initialize) {
  try {
    if (initialize) {
      try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700 || await realpath(path) !== path) throw new Error("private child directory required");
  } catch { throw new Error("Mail send state subdirectories must already be current-owner 0700 with no symlinks"); }
}

async function writeExclusivePrivateJSON(path, data, directory, maxBytes = MAIL_SEND_APPROVAL_MAX_BYTES) {
  let file;
  const encoded = JSON.stringify(data) + "\n";
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) throw new Error("Mail send private state exceeds its serialized size bound");
  try {
    file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    await file.writeFile(encoded, "utf8");
    await file.sync();
  } catch { throw new Error("Mail send private state could not be written exclusively; preserve existing state and do not retry automatically"); }
  finally { try { await file?.close(); } catch { throw new Error("Mail send private state could not be safely closed"); } }
  await syncDirectory(directory);
}

function boundedTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("Mail approval timestamp is invalid");
  return Date.parse(value);
}

function validateJournalRecord(record, approvalId, digest, states) {
  if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).some((key) => !["version", "approvalId", "digest", "state", "recordedAt"].includes(key)) || record.version !== 1 || record.approvalId !== approvalId || record.digest !== digest || !states.includes(record.state)) throw new Error("Mail send journal record is invalid");
  boundedTimestamp(record.recordedAt);
  return record;
}

async function optionalPrivateText(path, maxBytes) {
  try { return await readPrivateMailSendText(path, maxBytes); }
  catch (error) { if (error.code === "MAIL_SEND_PRIVATE_FILE_MISSING") return undefined; throw error; }
}

export function validateMailSendApproval(approval, approvalId, requestedPreview, now = new Date()) {
  if (!approval || typeof approval !== "object" || Array.isArray(approval) || Object.keys(approval).some((key) => !["version", "approvalId", "preview", "issuedAt", "expiresAt"].includes(key)) || approval.version !== 1 || approval.approvalId !== validateMailSendApprovalId(approvalId)) throw new Error("Mail send approval file is malformed");
  const preview = validateMailSendPreview(approval.preview), requested = validateMailSendPreview(requestedPreview);
  if (preview.digest !== requested.digest || JSON.stringify(preview.payload) !== JSON.stringify(requested.payload)) throw new Error("Mail send approval does not bind the exact requested payload");
  const issued = boundedTimestamp(approval.issuedAt), expires = boundedTimestamp(approval.expiresAt), clock = now.getTime();
  if (!Number.isFinite(clock) || issued > clock || expires <= clock || expires <= issued || expires - issued > 600000) throw new Error("Mail send approval is expired or outside the ten-minute lifetime");
  return preview;
}

/** initialize is used only by the separate manual armer, never the MCP adapter. */
export async function createMailSendStore({ configDirectory, now = () => new Date(), initialize = false } = {}) {
  const privateRoot = await assertPrivateMailSendDirectory(configDirectory);
  const stateDirectory = join(privateRoot, "mail-send"), approvalsDirectory = join(stateDirectory, "approvals"), journalDirectory = join(stateDirectory, "journal");
  for (const path of [stateDirectory, approvalsDirectory, journalDirectory]) await privateChildDirectory(path, initialize);
  if (initialize) { await syncDirectory(privateRoot); await syncDirectory(stateDirectory); }
  async function verifyDirectories() {
    await assertPrivateMailSendDirectory(privateRoot);
    for (const path of [stateDirectory, approvalsDirectory, journalDirectory]) await privateChildDirectory(path, false);
  }
  async function inspect(approvalId, previewInput) {
    await verifyDirectories(); validateMailSendApprovalId(approvalId);
    const preview = validateMailSendPreview(previewInput);
    const base = { approvalId, digest: preview.digest, deliveryConfirmed: false, retryAllowed: false };
    try {
      const payloadText = await optionalPrivateText(join(journalDirectory, preview.digest + ".payload.json"), 1024);
      const pendingText = await optionalPrivateText(join(journalDirectory, approvalId + ".jsonl"), 1024);
      const outcomeText = await optionalPrivateText(join(journalDirectory, approvalId + ".outcome.json"), 1024);
      if (payloadText === undefined && pendingText === undefined && outcomeText === undefined) return Object.freeze({ ...base, status: "notClaimed", approvalConsumed: false });
      if (payloadText === undefined) throw new Error("missing payload claim");
      const payloadClaim = JSON.parse(payloadText);
      validateMailSendApprovalId(payloadClaim.approvalId);
      validateJournalRecord(payloadClaim, payloadClaim.approvalId, preview.digest, ["pending"]);
      if (payloadClaim.approvalId !== approvalId) return Object.freeze({ ...base, status: "unknown", journalState: "deduplicated", approvalConsumed: true, samePayloadAlreadyConsumed: true });
      if (pendingText === undefined) throw new Error("orphan receipt");
      validateJournalRecord(JSON.parse(pendingText), approvalId, preview.digest, ["pending"]);
      if (outcomeText === undefined) return Object.freeze({ ...base, status: "unknown", journalState: "pending", approvalConsumed: true });
      const outcome = validateJournalRecord(JSON.parse(outcomeText), approvalId, preview.digest, ["submitted", "unknown", "blocked"]);
      return Object.freeze({ ...base, status: outcome.state, journalState: outcome.state, approvalConsumed: true });
    } catch {
      // Corrupt, linked, missing-parent or partially written state is never reusable.
      return Object.freeze({ ...base, status: "unknown", journalState: "unverifiable", approvalConsumed: true });
    }
  }
  return Object.freeze({
    configDirectory: privateRoot,
    inspect,
    async arm(previewInput, { approvalId = randomUUID(), ttlMs = 600000 } = {}) {
      await verifyDirectories();
      validateMailSendApprovalId(approvalId);
      if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 600000) throw new Error("Mail send approval lifetime must be within ten minutes");
      const preview = validateMailSendPreview(previewInput), issuedAt = now();
      if ((await inspect(approvalId, preview)).approvalConsumed) throw Object.assign(new Error("Mail send payload already has a consumed or unverifiable attempt; a separate reviewed reconciliation is required"), { code: "MAIL_SEND_APPROVAL_USED_OR_UNCERTAIN" });
      if (!Number.isFinite(issuedAt.getTime())) throw new Error("Mail send host clock is invalid");
      const approval = { version: 1, approvalId, preview, issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + ttlMs).toISOString() };
      await writeExclusivePrivateJSON(join(approvalsDirectory, approvalId + ".json"), approval, approvalsDirectory);
      return Object.freeze({ approvalId, digest: preview.digest, expiresAt: approval.expiresAt });
    },
    async claim(approvalId, previewInput) {
      await verifyDirectories(); validateMailSendApprovalId(approvalId);
      const preview = validateMailSendPreview(previewInput);
      const previous = await inspect(approvalId, preview);
      if (previous.approvalConsumed) throw Object.assign(new Error("Mail send approval is already consumed or unverifiable; reconcile its status without retrying"), { code: "MAIL_SEND_APPROVAL_USED_OR_UNCERTAIN" });
      const approval = await readPrivateMailSendJSON(join(approvalsDirectory, approvalId + ".json"), MAIL_SEND_APPROVAL_MAX_BYTES);
      validateMailSendApproval(approval, approvalId, preview, now());
      // Durable exclusive tombstone precedes every possible native mutation.
      // Any failure after creation leaves a consumed/pending ID; never retry it.
      try {
        // Payload-level tombstone also prevents a fresh approval UUID from
        // replaying identical content after timeout/restart. No reset/expiry
        // releases it; deliberate repeated sends need a future owner workflow.
        await writeExclusivePrivateJSON(join(journalDirectory, preview.digest + ".payload.json"), { version: 1, approvalId, digest: preview.digest, state: "pending", recordedAt: now().toISOString() }, journalDirectory, 1024);
        await writeExclusivePrivateJSON(join(journalDirectory, approvalId + ".jsonl"), { version: 1, approvalId, digest: preview.digest, state: "pending", recordedAt: now().toISOString() }, journalDirectory, 1024);
      } catch { throw Object.assign(new Error("Mail send approval could not be durably claimed or was already used; do not retry this approval ID"), { code: "MAIL_SEND_APPROVAL_USED_OR_UNCERTAIN" }); }
      return Object.freeze({ approvalId, digest: preview.digest, expiresAt: approval.expiresAt });
    },
    async recordOutcome(claim, state) {
      await verifyDirectories(); validateMailSendApprovalId(claim?.approvalId);
      if (!/^[0-9a-f]{64}$/u.test(claim?.digest) || !["submitted", "unknown", "blocked"].includes(state)) throw new Error("Mail send journal outcome is invalid");
      try {
        const payloadText = await readPrivateMailSendText(join(journalDirectory, claim.digest + ".payload.json"), 1024);
        validateJournalRecord(JSON.parse(payloadText), claim.approvalId, claim.digest, ["pending"]);
        const pendingText = await readPrivateMailSendText(join(journalDirectory, claim.approvalId + ".jsonl"), 1024);
        validateJournalRecord(JSON.parse(pendingText), claim.approvalId, claim.digest, ["pending"]);
        // One immutable, exclusive final receipt; concurrent finalizers cannot
        // append contradictory outcomes or erase the restart-safe tombstone.
        await writeExclusivePrivateJSON(join(journalDirectory, claim.approvalId + ".outcome.json"), { version: 1, approvalId: claim.approvalId, digest: claim.digest, state, recordedAt: now().toISOString() }, journalDirectory, 1024);
      } catch { throw new Error("Mail send journal outcome could not be durably recorded; preserve state and reconcile without retrying"); }
    },
  });
}
