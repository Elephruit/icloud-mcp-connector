import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { requireConnectorScope } from "./connector-policy.js";
import { buildDryRunResponse } from "./dry-run.js";
import { applyFieldSelection } from "./fields.js";

export const CONTACTS_COMPANION_BUNDLE_ID = "com.elephruit.icloud-mcp-connector.contacts";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ACTIONS = new Set(["get", "create", "update"]);
const NATIVE_ERROR_CODES = new Set([
  "COMPANION_INVALID_INVOCATION", "COMPANION_UNSAFE_PATH", "COMPANION_INVALID_SETTINGS",
  "COMPANION_EXECUTABLE_MISMATCH", "COMPANION_INVALID_CONFIGURATION", "COMPANION_INVALID_REQUEST",
  "COMPANION_ALREADY_CLAIMED", "COMPANION_SCOPE_DENIED", "COMPANION_AUTHORIZATION_REQUIRED",
  "COMPANION_BUSY", "COMPANION_OPERATION_FAILED", "COMPANION_INVALID_RESULT", "COMPANION_JOB_IO",
  "COMPANION_AUTHORIZATION_FAILED",
]);
const TEXT_FIELDS = ["firstName", "lastName", "nickname", "organization"];
const PARAMETER_FIELDS = ["id", "container", ...TEXT_FIELDS];
const ARGUMENT_FIELDS = new Set(["action", ...PARAMETER_FIELDS, "dryRun", "fields"]);
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const executeFile = promisify(execFile);
const SYSTEM_ENV = Object.freeze({ PATH: "/usr/bin:/bin", LANG: "C" });
const ownUID = () => process.geteuid();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

export class ContactsCompanionError extends Error {
  constructor(code, message, { requestId, mutationMayHaveOccurred = false } = {}) {
    super(message);
    this.name = "ContactsCompanionError";
    this.code = code;
    this.mutationMayHaveOccurred = mutationMayHaveOccurred;
    if (requestId) this.requestId = requestId;
  }
}

function denied(message = "Contacts companion configuration or files failed validation; access is denied.") {
  return new ContactsCompanionError("COMPANION_DENIED", message);
}

function exactKeys(object, required, optional = []) {
  return isObject(object) && required.every((key) => Object.hasOwn(object, key)) &&
    Object.keys(object).every((key) => required.includes(key) || optional.includes(key));
}

function validID(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 2048 &&
    value.trim().length > 0 && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function validateArguments(args) {
  if (!isObject(args) || Object.getOwnPropertySymbols(args).length ||
      Object.keys(args).some((key) => !ARGUMENT_FIELDS.has(key)) || !ACTIONS.has(args.action)) {
    throw denied("Contacts companion accepts only typed get, create, and update arguments.");
  }
  for (const key of ["id", "container"]) {
    if (Object.hasOwn(args, key) && !validID(args[key])) throw denied("Contact identifiers must be bounded strings without control characters.");
  }
  for (const key of TEXT_FIELDS) {
    if (Object.hasOwn(args, key) && (typeof args[key] !== "string" || args[key].includes("\0") ||
        Buffer.byteLength(args[key], "utf8") > 4096)) {
      throw denied("Contact text fields must be bounded strings without NUL characters.");
    }
  }
  if (Object.hasOwn(args, "dryRun") && typeof args.dryRun !== "boolean") throw denied("dryRun must be a boolean.");
  if (Object.hasOwn(args, "fields") && (!Array.isArray(args.fields) || args.fields.length > 64 ||
      args.fields.some((field) => typeof field !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field) ||
        ["__proto__", "constructor", "prototype"].includes(field)))) {
    throw denied("fields must contain bounded field names.");
  }
  const supplied = PARAMETER_FIELDS.filter((key) => Object.hasOwn(args, key));
  if (args.action === "get" && (!validID(args.id) || supplied.some((key) => key !== "id") || args.dryRun === true)) {
    throw denied("Contact get requires only an ID; dryRun cannot read a contact.");
  }
  if (args.action === "create" && (!validID(args.container) || Object.hasOwn(args, "id") ||
      !(args.firstName?.trim() || args.lastName?.trim()))) {
    throw denied("Contact create requires an explicit container and a first or last name.");
  }
  if (args.action === "update" && (!validID(args.id) || Object.hasOwn(args, "container") ||
      !TEXT_FIELDS.some((key) => Object.hasOwn(args, key)))) {
    throw denied("Contact update requires an ID and at least one supported text field; container changes are disabled.");
  }
  return Object.fromEntries(supplied.map((key) => [key, args[key]]));
}

async function ensureDirectory(path, privateMode = false) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== ownUID() ||
      (privateMode ? (stat.mode & 0o777) !== 0o700 : (stat.mode & 0o022) !== 0)) throw denied();
}

async function ensureChain(home, path) {
  const suffix = relative(home, path);
  if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw denied();
  let current = home;
  for (const component of suffix.split(sep)) {
    current = join(current, component);
    await ensureDirectory(current);
  }
}

async function privateBytes(path, limit) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== ownUID() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 ||
        stat.size < 1 || stat.size > limit) throw denied();
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead < 1 || bytesRead > limit) throw denied();
    return bytes.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

function decodeJSON(bytes) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function privateJSON(path, limit = MAX_REQUEST_BYTES) {
  return decodeJSON(await privateBytes(path, limit));
}

async function syncDirectory(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_DIRECTORY);
  try {
    const stat = await file.stat();
    if (!stat.isDirectory() || stat.uid !== ownUID() || (stat.mode & 0o777) !== 0o700) throw denied();
    await file.sync();
  } finally { await file.close(); }
}

async function writeRequest(path, request) {
  const bytes = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
  if (bytes.length > MAX_REQUEST_BYTES) throw denied("Contacts companion request is too large.");
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function inspectInstalledApp({ appPath, infoPlistPath }) {
  const { stdout } = await executeFile("/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleIdentifier", "-c", "Print :CFBundleExecutable", "-c", "Print :CFBundlePackageType", infoPlistPath],
    { timeout: 5000, maxBuffer: 4096, env: SYSTEM_ENV });
  const [bundleId, executableName, packageType, ...extra] = stdout.trim().split(/\r?\n/);
  if (bundleId !== CONTACTS_COMPANION_BUNDLE_ID || executableName !== "contacts-cli" || packageType !== "APPL" || extra.length) throw denied();
  await executeFile("/usr/bin/codesign", ["--verify", "--strict", appPath], { timeout: 5000, maxBuffer: 4096, env: SYSTEM_ENV });
  return { bundleId, executableName, packageType, signatureValid: true };
}

async function launchInstalledApp({ appPath, requestId, signal, timeoutMs }) {
  await executeFile("/usr/bin/open", ["-n", "-W", appPath, "--args", "--run-job", requestId],
    { signal, timeout: timeoutMs, maxBuffer: 4096, killSignal: "SIGTERM", env: SYSTEM_ENV });
}

async function inspectExecutable(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== ownUID() || stat.nlink !== 1 || (stat.mode & 0o022) ||
        !(stat.mode & 0o100) || stat.size < 1 || stat.size > 128 * 1024 * 1024) throw denied();
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > 128 * 1024 * 1024) throw denied();
      hash.update(chunk);
    }
    return hash.digest("hex");
  } finally {
    await file.close();
  }
}

function matches(object, request, optional = []) {
  return exactKeys(object, ["version", "requestId", "action", ...optional]) &&
    object.version === 1 && object.requestId === request.requestId && object.action === request.action;
}

async function readReceipt(jobPath, request, scope) {
  await ensureDirectory(jobPath, true);
  const claim = await privateJSON(join(jobPath, "claim.json"));
  if (!exactKeys(claim, ["version", "requestId"]) || claim.version !== 1 || claim.requestId !== request.requestId) throw denied();
  const completion = await privateJSON(join(jobPath, "completion.json"));
  if (!matches(completion, request, ["responseSHA256"]) || typeof completion.responseSHA256 !== "string" ||
      !SHA256.test(completion.responseSHA256)) throw denied();
  const responseBytes = await privateBytes(join(jobPath, "response.json"), MAX_RESPONSE_BYTES);
  if (digest(responseBytes) !== completion.responseSHA256) throw denied();
  const response = decodeJSON(responseBytes);
  if (!exactKeys(response, ["version", "requestId", "action", "success"], ["result", "error", "mutationMayHaveOccurred"]) ||
      response.version !== 1 || response.requestId !== request.requestId || response.action !== request.action ||
      typeof response.success !== "boolean" || (Object.hasOwn(response, "mutationMayHaveOccurred") &&
        typeof response.mutationMayHaveOccurred !== "boolean")) throw denied();
  let mutationStarted = false;
  try {
    const started = await privateJSON(join(jobPath, "mutation-started.json"));
    if (!matches(started, request)) throw denied();
    mutationStarted = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (request.action === "get" && (mutationStarted || response.mutationMayHaveOccurred === true)) throw denied();
  if (response.success) {
    if (Object.hasOwn(response, "error") || !isObject(response.result) || response.result.success !== true ||
        !isObject(response.result.contact) || !validID(response.result.contact.id) ||
        (request.action !== "create" && response.result.contact.id !== request.parameters.id) ||
        (request.action !== "get" && !mutationStarted)) throw denied();
    const container = response.result.contact.sourceContainerId;
    if ((request.action === "get" || container !== undefined) &&
        (!validID(container) || !scope.items.includes(container) || !scope.accounts.includes(container))) throw denied();
    return response.result;
  }
  if (Object.hasOwn(response, "result") || !NATIVE_ERROR_CODES.has(response.error) ||
      response.mutationMayHaveOccurred !== mutationStarted) throw denied();
  throw new ContactsCompanionError(response.error, "Contacts companion rejected the operation; the private job journal was retained.",
    { requestId: request.requestId, mutationMayHaveOccurred: mutationStarted });
}

/** Host-selected, fixed native app route. Injected launch/inspection/home seams are for synthetic tests only. */
export function createContactsCompanionRunner({
  env = process.env,
  homeDir = userInfo().homedir,
  launch = launchInstalledApp,
  inspectApp = inspectInstalledApp,
  timeoutMs = 45000,
  createRequestId = randomUUID,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw denied("Invalid Contacts companion timeout.");
  return async (args) => {
    const parameters = validateArguments(args);
    let configDirectory;
    let config;
    try {
      if (!isAbsolute(env.APPLE_PIM_CONFIG_DIR ?? "") || env.APPLE_PIM_PROFILE !== undefined) throw denied();
      configDirectory = await realpath(env.APPLE_PIM_CONFIG_DIR);
      await ensureDirectory(env.APPLE_PIM_CONFIG_DIR, true);
      config = await privateJSON(join(configDirectory, "config.json"));
    } catch {
      throw denied("Missing or unsafe selected Contacts configuration; access is denied.");
    }
    requireConnectorScope("contact", args, config);
    if (args.action === "create" && (!config.contacts.items.includes(args.container) || !config.contacts.accounts.includes(args.container))) {
      throw denied("Contact destination must be in both configured container allowlists.");
    }
    if (args.dryRun === true) return buildDryRunResponse("contact", args);

    let appPath;
    let jobsPath;
    try {
      if (!isAbsolute(homeDir)) throw denied();
      const home = await realpath(homeDir);
      const serviceRoot = join(home, "Library", "Application Support", "iCloud MCP Connector", "Contacts");
      await ensureChain(home, serviceRoot);
      await ensureDirectory(serviceRoot, true);
      const bridge = await privateJSON(join(serviceRoot, "bridge.json"));
      if (!exactKeys(bridge, ["version", "enabled", "configDirectory", "executableSHA256"]) || bridge.version !== 1 ||
          bridge.enabled !== true || typeof bridge.configDirectory !== "string" || !isAbsolute(bridge.configDirectory) ||
          typeof bridge.executableSHA256 !== "string" || !SHA256.test(bridge.executableSHA256) ||
          await realpath(bridge.configDirectory) !== configDirectory) throw denied();
      await ensureDirectory(bridge.configDirectory, true);
      appPath = join(home, "Applications", "iCloud MCP Contacts.app");
      await ensureChain(home, join(appPath, "Contents", "MacOS"));
      const executablePath = join(appPath, "Contents", "MacOS", "contacts-cli");
      const infoPlistPath = join(appPath, "Contents", "Info.plist");
      const infoStat = await lstat(infoPlistPath);
      if (!infoStat.isFile() || infoStat.isSymbolicLink() || infoStat.uid !== ownUID() || (infoStat.mode & 0o022)) throw denied();
      const identity = await inspectApp({ appPath, infoPlistPath, executablePath });
      if (identity?.bundleId !== CONTACTS_COMPANION_BUNDLE_ID || identity.executableName !== "contacts-cli" ||
          identity.packageType !== "APPL" || identity.signatureValid !== true ||
          await inspectExecutable(executablePath) !== bridge.executableSHA256) throw denied();
      jobsPath = join(serviceRoot, "jobs");
      try { await mkdir(jobsPath, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
      await ensureDirectory(jobsPath, true);
    } catch {
      throw denied("Contacts companion is not installed, approved, or valid for the selected configuration; access is denied.");
    }

    const requestId = createRequestId();
    if (typeof requestId !== "string" || !UUID.test(requestId)) throw denied("Invalid Contacts companion job identifier.");
    const request = { version: 1, requestId, action: args.action, parameters };
    const jobPath = join(jobsPath, requestId);
    try {
      await mkdir(jobPath, { mode: 0o700 }); // Exclusive UUID directory; collisions are never retried.
      await ensureDirectory(jobPath, true);
      await writeRequest(join(jobPath, "request.json"), request);
      await syncDirectory(jobPath);
      await syncDirectory(jobsPath);
    } catch {
      throw denied("Contacts companion could not create a private exclusive job; it was not launched.");
    }
    const controller = new AbortController();
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => launch({ appPath, requestId, signal: controller.signal, timeoutMs })),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, timeoutMs); }),
      ]);
    } catch {
      // A failed/timed-out open process cannot prove whether the app saved a mutation.
      // A correlated completed receipt may still establish the result; never relaunch.
    } finally {
      clearTimeout(timer);
    }
    let result;
    try {
      result = await readReceipt(jobPath, request, config.contacts);
    } catch (error) {
      if (error instanceof ContactsCompanionError && NATIVE_ERROR_CODES.has(error.code)) throw error;
      throw new ContactsCompanionError("COMPANION_RESULT_UNKNOWN", "Contacts companion result is unverified; do not retry automatically. Check the private job journal first.",
        { requestId, mutationMayHaveOccurred: args.action !== "get" });
    }
    if (args.fields?.length) {
      return { ...applyFieldSelection(result, args.fields), contact: applyFieldSelection(result.contact, args.fields) };
    }
    return result;
  };
}
