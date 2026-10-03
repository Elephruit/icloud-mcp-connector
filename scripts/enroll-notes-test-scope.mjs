#!/usr/bin/env node
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { checkNotesAccess } from "../lib/notes.js";
import { spawnProcess } from "../lib/safe-shell.js";

export const NOTES_TEST_FOLDER_TITLE_PATTERN = /^Apple PIM Connector Tests [A-Za-z0-9-]{6,40}$/u;

// Bootstrap is a separate, explicitly approved local enrollment operation.
// Only exact iCloud account/folder metadata is read. No note is enumerated,
// created, read, modified, exported, or deleted by this helper.
export const NOTES_TEST_ENROLLMENT_APPLESCRIPT = String.raw`use framework "Foundation"
use scripting additions

on exactText(leftText, rightText)
  return ((current application's NSString's stringWithString:(leftText as text))'s isEqualToString:(rightText as text)) as boolean
end exactText

on jsonText(value)
  set jsonData to current application's NSJSONSerialization's dataWithJSONObject:value options:0 |error|:(missing value)
  if jsonData is missing value then error "Could not encode enrollment response"
  return (current application's NSString's alloc()'s initWithData:jsonData encoding:(current application's NSUTF8StringEncoding)) as text
end jsonText

on run(argv)
  if (count of argv) is not 3 then error "Explicit bootstrap mode and unique folder title are required"
  if not my exactText(item 1 of argv, "bootstrap") then error "Explicit bootstrap mode is required"
  set allowFolderCreation to item 2 of argv
  if allowFolderCreation is not in {"0", "1"} then error "Invalid folder creation choice"
  set folderTitle to item 3 of argv
  set titleString to current application's NSString's stringWithString:folderTitle
  set titlePattern to current application's NSRegularExpression's regularExpressionWithPattern:"^Apple PIM Connector Tests [A-Za-z0-9-]{6,40}$" options:0 |error|:(missing value)
  if (titlePattern's numberOfMatchesInString:titleString options:0 range:{location:0, |length|:titleString's |length|()}) is not 1 then error "A unique approved test folder title is required"
  set createdFolder to false
  with timeout of 15 seconds
    tell application "/System/Applications/Notes.app"
      set accountCandidates to every account whose name is "iCloud"
      set exactAccounts to {}
      repeat with candidateAccount in accountCandidates
        if my exactText(name of candidateAccount, "iCloud") then set end of exactAccounts to candidateAccount
      end repeat
      if (count of exactAccounts) is not 1 then error "The exact iCloud Notes account is missing or ambiguous"
      set targetAccount to item 1 of exactAccounts
      set targetAccountID to id of targetAccount
      if targetAccountID is "" then error "The iCloud Notes account has no ID"
      set folderCandidates to every folder of targetAccount whose name is folderTitle
      -- A collision is never adopted, even if it appears to be a prior test.
      if (count of folderCandidates) is not 0 then error "The unique Notes test folder title already exists; choose a fresh approved label"
      if allowFolderCreation is not "1" then error "Explicit creation approval is required for a new isolated test folder"
      set targetFolder to make new folder at targetAccount with properties {name:folderTitle}
      set createdFolder to true
      if not my exactText(name of targetFolder, folderTitle) then error "The test folder title did not match exactly"
      if not my exactText(id of container of targetFolder, targetAccountID) then error "The test folder is not top-level in the selected account"
      set targetFolderID to id of targetFolder
      if targetFolderID is "" then error "The Notes test folder has no ID"
    end tell
  end timeout
  set responsePayload to current application's NSMutableDictionary's dictionary()
  responsePayload's setObject:true forKey:"success"
  responsePayload's setObject:"com.apple.Notes" forKey:"target"
  responsePayload's setObject:targetAccountID forKey:"accountId"
  responsePayload's setObject:targetFolderID forKey:"folderId"
  responsePayload's setObject:createdFolder forKey:"createdFolder"
  return my jsonText(responsePayload)
end run
`;

export function buildNotesTestEnrollmentArguments({ mode, createIfMissing = false, folderTitle } = {}) {
  if (mode !== "bootstrap") throw new Error("Explicit --mode bootstrap is required for Notes test enrollment");
  if (typeof createIfMissing !== "boolean") throw new Error("createIfMissing must be a boolean");
  if (typeof folderTitle !== "string" || !NOTES_TEST_FOLDER_TITLE_PATTERN.test(folderTitle)) throw new Error("An explicit unique folderTitle matching Apple PIM Connector Tests <6-40 alphanumeric/hyphen characters> is required");
  return ["bootstrap", createIfMissing ? "1" : "0", folderTitle];
}

function validateEnrollmentResult(result) {
  if (!result || result.success !== true || result.target !== "com.apple.Notes" || typeof result.createdFolder !== "boolean") {
    throw new Error("Notes test enrollment returned an invalid response");
  }
  for (const field of ["accountId", "folderId"]) {
    const id = result[field];
    if (typeof id !== "string" || id.length === 0 || id.length > 2048 || id.trim() !== id || /[\u0000-\u001f\u007f*]/u.test(id)) {
      throw new Error("Notes test enrollment returned an invalid ID");
    }
  }
  return { accountId: result.accountId, folderId: result.folderId, createdFolder: result.createdFolder };
}

export async function runNotesTestEnrollmentScript(argv, {
  accessCliPath,
  preflightImpl = checkNotesAccess,
  spawnImpl = spawnProcess,
  platform = process.platform,
  timeoutMs = 20000,
} = {}) {
  if (platform !== "darwin") throw new Error("Notes test enrollment requires macOS");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error("Notes enrollment timeout is invalid");
  await preflightImpl({ accessCliPath, spawnImpl, platform });
  return await new Promise((resolvePromise, reject) => {
    const child = spawnImpl("/usr/bin/osascript", ["-l", "AppleScript", "-", ...argv], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", outputBytes = 0, settled = false, killTimer;
    const fail = (message, kill = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (kill) {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
        killTimer.unref?.();
      }
      reject(new Error(message + (argv[1] === "1" ? "; folder creation outcome may be unknown. Do not retry automatically; verify the approved unique folder label locally first" : "")));
    };
    const timer = setTimeout(() => fail("Notes enrollment timed out", true), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes > 8192) { fail("Notes enrollment response exceeded its size limit", true); return; }
      output += chunk;
    });
    child.stderr.on("data", () => {});
    child.on("error", () => fail("Could not launch Notes test enrollment"));
    child.stdin.on("error", () => fail("Could not send the fixed Notes enrollment script", true));
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (settled) return;
      if (code !== 0) { fail("Notes enrollment failed; verify the unique exact iCloud account and approved test folder locally"); return; }
      try {
        const result = validateEnrollmentResult(JSON.parse(output));
        settled = true;
        resolvePromise(result);
      } catch { fail("Notes enrollment returned an invalid response"); }
    });
    child.stdin.end(NOTES_TEST_ENROLLMENT_APPLESCRIPT);
  });
}

async function privateOutputPath(outputPath) {
  if (typeof outputPath !== "string" || !isAbsolute(outputPath)) throw new Error("An explicit absolute private output path is required");
  const parent = await realpath(dirname(outputPath));
  const checkout = await realpath(fileURLToPath(new URL("..", import.meta.url)));
  const withinCheckout = relative(checkout, parent);
  if (withinCheckout === "" || (withinCheckout !== ".." && !withinCheckout.startsWith(".." + sep) && !isAbsolute(withinCheckout))) throw new Error("Notes enrollment IDs must be saved outside the public checkout");
  const privatePath = join(parent, basename(outputPath));
  try {
    await lstat(privatePath);
    throw new Error("Notes enrollment requires a new private output file and cannot overwrite an existing path");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return privatePath;
}

/** IDs go only to a newly created 0600 local file outside the public checkout. */
export async function writePrivateNotesTestScope(outputPath, scope) {
  const privatePath = await privateOutputPath(outputPath);
  const safeScope = validateEnrollmentResult({ success: true, target: "com.apple.Notes", ...scope });
  const file = await open(privatePath, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(safeScope, null, 2) + "\n", "utf8"); }
  finally { await file.close(); }
}

export async function enrollNotesTestScope(options, { runScript, writePrivate = writePrivateNotesTestScope } = {}) {
  const argv = buildNotesTestEnrollmentArguments(options);
  if (typeof options.binDir !== "string" || !isAbsolute(options.binDir)) throw new Error("An explicit absolute checkout binary directory is required");
  if (typeof options.outputPath !== "string" || !isAbsolute(options.outputPath)) throw new Error("An explicit absolute private output path is required");
  await privateOutputPath(options.outputPath);
  try {
    const scope = validateEnrollmentResult({ success: true, target: "com.apple.Notes", ...(await (runScript ?? ((args) => runNotesTestEnrollmentScript(args, { accessCliPath: join(options.binDir, "notes-access-cli") })))(argv)) });
    await writePrivate(options.outputPath, scope);
    // Deliberately omit identifiers from stdout/normal tool output.
    return { success: true, createdFolder: scope.createdFolder, privateScopeWritten: true };
  } catch (cause) {
    if (argv[1] !== "1") throw cause;
    // This includes a valid creation response followed by an output-file error.
    // Never retry a mutation just because its private scope file was not saved.
    const error = new Error("Notes enrollment did not finish; folder creation outcome may be unknown and private scope output may be incomplete. Do not retry automatically; verify the approved unique folder label and private output locally first", { cause });
    error.code = "NOTES_ENROLLMENT_OUTCOME_UNKNOWN";
    throw error;
  }
}

function parseCLI(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--create-if-missing" && options.createIfMissing === undefined) { options.createIfMissing = true; continue; }
    const key = { "--mode": "mode", "--bin-dir": "binDir", "--output": "outputPath", "--folder-title": "folderTitle" }[argument];
    if (!key || options[key] !== undefined || index + 1 >= argv.length) throw new Error("Use --mode bootstrap --folder-title 'Apple PIM Connector Tests <unique token>' --bin-dir <absolute checkout binary directory> --output <new private file> [--create-if-missing]");
    options[key] = argv[++index];
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await enrollNotesTestScope(parseCLI(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  }
}
