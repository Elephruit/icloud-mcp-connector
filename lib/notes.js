import { spawnProcess } from "./safe-shell.js";
import { loadNotesConfig } from "./notes-config.js";
import { NOTES_APPLESCRIPT } from "./notes-script.js";
import { isAbsolute, join } from "node:path";

const MAX_OUTPUT_BYTES = 256 * 1024;
const ACTIONS = new Set(["search", "get", "create", "append"]);

function requiredText(value, label, maxLength = 65536) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || value.includes("\0")) {
    throw new Error(`Notes ${label} must be nonempty text (maximum ${maxLength} characters, no NUL)`);
  }
  return value;
}

export function notesTextToHTML(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;")
    .split(/\r\n|\r|\n/u).map((line) => `<div>${line || "<br>"}</div>`).join("");
}

export function buildNotesInvocation(args, config) {
  if (!args || typeof args !== "object" || Array.isArray(args) || !ACTIONS.has(args.action)) {
    throw new Error("Notes action must be search, get, create, or append; deletion is unavailable");
  }
  if (args.configDir !== undefined || args.profile !== undefined) {
    throw new Error("Notes per-call configDir/profile overrides are not supported");
  }
  if (args.dryRun !== undefined && typeof args.dryRun !== "boolean") throw new Error("Notes dryRun must be a boolean");
  const write = args.action === "create" || args.action === "append";
  if (write && !config.allowWrites) throw new Error("Notes writes are disabled; explicit notes.allowWrites=true is required");
  for (const [field, allowlist] of [["accountId", config.accounts], ["folderId", config.folders]]) {
    if (args[field] !== undefined && !allowlist.includes(args[field])) throw new Error(`Notes ${field} is outside the explicit allowed scope`);
    if (write && args[field] === undefined) throw new Error(`Notes writes require an explicit ${field}`);
  }
  const limit = args.limit === undefined ? 20 : args.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Notes limit must be an integer from 1 to 50");
  let id = "", query = "", title = "", html = "";
  if (args.action === "get" || args.action === "append") id = requiredText(args.id, "id", 2048);
  if (args.action === "search") query = requiredText(args.query, "query", 2048);
  if (args.action === "create") {
    title = requiredText(args.title, "title", 2000);
    const text = args.text === undefined || args.text === "" ? "" : requiredText(args.text, "text");
    html = notesTextToHTML(title + (text ? "\n" + text : ""));
  }
  if (args.action === "append") html = notesTextToHTML(requiredText(args.text, "text"));
  return [args.action, JSON.stringify(config.accounts), JSON.stringify(config.folders), args.accountId ?? "", args.folderId ?? "", id, query, title, html, String(limit)];
}

/** Permission probe never requests authorization, launches Notes, or reads notes. */
export function checkNotesAccess({ accessCliPath, spawnImpl = spawnProcess, platform = process.platform, timeoutMs = 2000 } = {}) {
  if (platform !== "darwin") return Promise.reject(new Error("Notes automation requires macOS"));
  if (typeof accessCliPath !== "string" || !isAbsolute(accessCliPath)) return Promise.reject(new Error("Notes permission preflight is unavailable; build notes-access-cli and bind its fixed path"));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) return Promise.reject(new Error("Notes permission preflight timeout is invalid"));
  return new Promise((resolve, reject) => {
    const child = spawnImpl(accessCliPath, ["status"], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", outputBytes = 0, settled = false;
    let killTimer;
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
    const timer = setTimeout(() => fail("Notes permission preflight timed out; no Notes command was sent", true), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes > 4096) { fail("Notes permission preflight response exceeded the size limit", true); return; }
      output += chunk;
    });
    child.stderr.on("data", () => {});
    child.on("error", () => fail("Notes permission preflight is unavailable; no Notes command was sent"));
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (settled) return;
      let status;
      try { status = JSON.parse(output); } catch { fail("Notes permission preflight returned an invalid response"); return; }
      if (code !== 0 || !status || typeof status !== "object" || status.success !== true || status.target !== "com.apple.Notes" || status.authorized !== true || status.prompted !== false || status.authorization !== "authorized") {
        fail("Notes requires an already running app and an existing Automation grant; no prompt or Notes command was sent");
        return;
      }
      settled = true;
      resolve(status);
    });
  });
}

/** Bound execution; child code is fixed, data is argv, and shell mode is disabled. */
export async function runNotesScript(argv, { accessCliPath, preflightImpl = checkNotesAccess, spawnImpl = spawnProcess, platform = process.platform, timeoutMs = 20000 } = {}) {
  if (platform !== "darwin") return Promise.reject(new Error("Notes automation requires macOS"));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) return Promise.reject(new Error("Notes timeout must be between 1 and 30000 milliseconds"));
  await preflightImpl({ accessCliPath, spawnImpl, platform });
  return new Promise((resolve, reject) => {
    const child = spawnImpl("/usr/bin/osascript", ["-l", "AppleScript", "-", ...argv], {
      shell: false, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let outputBytes = 0;
    let settled = false;
    let killTimer;
    const write = argv[0] === "create" || argv[0] === "append";
    const fail = (message, kill = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (kill) {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
        killTimer.unref?.();
      }
      reject(new Error(message + (write ? "; write outcome may be unknown, verify locally before retrying" : "")));
    };
    const timer = setTimeout(() => fail("Notes command timed out", true), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes > MAX_OUTPUT_BYTES) { fail("Notes output exceeded the size limit", true); return; }
      output += chunk;
    });
    // Drain stderr without returning AppleScript diagnostics that can contain data.
    child.stderr.on("data", () => {});
    child.on("error", () => fail("Could not launch Notes automation"));
    child.stdin.on("error", () => fail("Could not send the fixed Notes script", true));
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (settled) return;
      if (code !== 0) { fail("Notes command failed; verify allowed IDs, note support, and local Automation permission"); return; }
      try {
        const result = JSON.parse(output);
        settled = true;
        resolve(result);
      } catch { fail("Notes command returned an invalid response"); }
    });
    child.stdin.end(NOTES_APPLESCRIPT);
  });
}

function validateNote(note, args, config, includeText) {
  if (!note || typeof note !== "object" || Array.isArray(note) || note.locked !== false ||
      !config.accounts.includes(note.accountId) || !config.folders.includes(note.folderId) ||
      (args.accountId !== undefined && note.accountId !== args.accountId) ||
      (args.folderId !== undefined && note.folderId !== args.folderId) ||
      typeof note.id !== "string" || !note.id || note.id.length > 2048 ||
      typeof note.title !== "string" || note.title.length > 32768 ||
      typeof note.attachmentsOmitted !== "boolean") {
    throw new Error("Notes response is invalid, locked, or outside the allowed scope");
  }
  if ((args.action === "get" || args.action === "append") && note.id !== args.id) throw new Error("Notes response ID does not match the scoped request");
  const safeNote = { id: note.id, title: note.title, accountId: note.accountId, folderId: note.folderId, attachmentsOmitted: note.attachmentsOmitted };
  if (includeText) {
    if (typeof note.text !== "string" || note.text.length > 32768 || typeof note.truncated !== "boolean") throw new Error("Notes text response is invalid or exceeds the size limit");
    safeNote.text = note.text;
    safeNote.truncated = note.truncated;
  }
  return safeNote;
}

/** The config is reloaded before each call. Synthetic tests inject both seams. */
export function createNotesAdapter({ env = process.env, binDir, readFileImpl, runScript } = {}) {
  const nativeRunner = runScript ?? ((argv) => runNotesScript(argv, { accessCliPath: typeof binDir === "string" ? join(binDir, "notes-access-cli") : undefined }));
  return {
    async runNotes(args) {
      const config = await loadNotesConfig(env, readFileImpl);
      const argv = buildNotesInvocation(args, config);
      if (args.dryRun === true && (args.action === "create" || args.action === "append")) {
        return {
          success: true,
          dryRun: true,
          action: args.action,
          accountId: args.accountId,
          folderId: args.folderId,
          ...(args.id ? { id: args.id } : {}),
          description: `Would ${args.action} plain text in the explicitly allowed Notes folder`,
          scopeResolution: "not run; local account/folder existence and note support require an approved live call",
        };
      }
      const result = await nativeRunner(argv);
      if (!result || result.success !== true) throw new Error("Notes command did not report success");
      if (args.action === "search") {
        const limit = args.limit ?? 20;
        if (!Array.isArray(result.notes) || result.notes.length > limit || typeof result.limitReached !== "boolean") throw new Error("Notes search response is invalid or exceeds the requested limit");
        const notes = result.notes.map((note) => validateNote(note, args, config, false));
        if (new Set(notes.map((note) => note.id)).size !== notes.length) throw new Error("Notes search returned ambiguous duplicate IDs");
        return { success: true, notes, limitReached: result.limitReached };
      }
      const note = validateNote(result.note, args, config, args.action === "get");
      if (args.action === "append" && note.attachmentsOmitted) throw new Error("Appending to Notes with attachments is not supported");
      return { success: true, note };
    },
  };
}
