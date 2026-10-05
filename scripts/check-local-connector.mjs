#!/usr/bin/env node
// Health only. No PIM actions, native authorization, setup, or registration.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

export const HEALTH_TOOLS = Object.freeze(["apple-pim", "calendar", "contact", "mail", "notes", "reminder"]);
// Complete reviewed 0.2.1 artifact tuples from 33729a5 and d02c04e.
// Never combine independent per-file allowlists: a package must match one
// reviewed generation in full. Unknown same-version changes require review.
const REVIEWED = Object.freeze([
  Object.freeze({
    "scripts/plugin-launcher.mjs": "ba0277f30e75ccfbb634a46631fa82a311f07b13a2297230ddc40061778d6abb",
    "mcp-server/dist/server.js": "daba5100907dcd44162c513c83c383e8e7d7a80faaa5ff665dd621bb844c0bf7",
    "lib/scoped-mail-config.js": "6b5596c782a53d3a4acb4b013412f4f718c6d3367d550bbf489ba18cc3330dde",
  }),
  Object.freeze({
    "scripts/plugin-launcher.mjs": "ba0277f30e75ccfbb634a46631fa82a311f07b13a2297230ddc40061778d6abb",
    "mcp-server/dist/server.js": "28bb7db962a4d1255c4841dad7cf3353ab30aba19acc51d5a1047948e70badc5",
    "lib/scoped-mail-config.js": "6b5596c782a53d3a4acb4b013412f4f718c6d3367d550bbf489ba18cc3330dde",
  }),
]);
const fail = () => new Error("Local connector health check failed; private diagnostics are withheld. No PIM data or permissions were requested.");
const absolute = (value) => typeof value === "string" && isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value);
const inside = (root, path) => { const suffix = relative(root, path); return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)); };

export function parseHealthArguments(argv) {
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  if (![4, 5].includes(argv.length) || argv[0] !== "--package-root" || argv[2] !== "--config-dir" ||
      (argv.length === 5 && argv[4] !== "--restart") || !absolute(argv[1]) || !absolute(argv[3])) throw fail();
  return { packageRoot: argv[1], configDirectory: argv[3], restart: argv.length === 5 };
}

async function boundedFile(path, limit = 4 * 1024 * 1024) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o022) || info.size < 1 || info.size > limit) throw fail();
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw fail();
    return buffer.subarray(0, bytesRead);
  } finally { await file.close(); }
}

async function controlledDirectories(path) {
  const temporaryRoots = [await realpath("/tmp"), await realpath(tmpdir())];
  for (let current = path; ; current = dirname(current)) {
    const info = await lstat(current);
    const sharedTemporaryRoot = temporaryRoots.includes(current) && info.uid === 0 && (info.mode & 0o1000);
    if (!info.isDirectory() || info.isSymbolicLink() || ![0, process.getuid?.()].includes(info.uid) ||
        ((info.mode & 0o022) && !sharedTemporaryRoot)) throw fail();
    if (dirname(current) === current) break;
  }
}

export async function validateHealthPaths({ packageRoot, configDirectory }) {
  if (!absolute(packageRoot) || !absolute(configDirectory)) throw fail();
  const root = await realpath(packageRoot), config = await realpath(configDirectory), uid = process.getuid?.();
  const rootInfo = await lstat(root), configInfo = await lstat(config);
  if (!Number.isInteger(uid) || !rootInfo.isDirectory() || rootInfo.uid !== uid || (rootInfo.mode & 0o022) ||
      !configInfo.isDirectory() || configInfo.uid !== uid || (configInfo.mode & 0o777) !== 0o700 || inside(root, config)) throw fail();
  await controlledDirectories(root); await controlledDirectories(config);
  for (let ancestor = config; ; ancestor = dirname(ancestor)) {
    try { await lstat(join(ancestor, ".git")); throw fail(); }
    catch (error) { if (error.code !== "ENOENT") throw fail(); }
    if (dirname(ancestor) === ancestor) break;
  }
  // Inspect only config metadata. The reviewed launcher loads its contents.
  const file = await open(join(config, "config.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== uid || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size < 1 || info.size > 65536) throw fail();
  } finally { await file.close(); }
  const manifest = JSON.parse((await boundedFile(join(root, "plugin.json"), 65536)).toString("utf8"));
  if (manifest.name !== "icloud-mcp-connector" || manifest.version !== "0.2.1") throw fail();
  const actual = {};
  for (const path of Object.keys(REVIEWED[0])) {
    const selected = join(root, path);
    if (await realpath(selected) !== selected) throw fail();
    await controlledDirectories(dirname(selected));
    actual[path] = createHash("sha256").update(await boundedFile(selected)).digest("hex");
  }
  if (!REVIEWED.some((generation) => Object.entries(generation).every(([path, expected]) => actual[path] === expected))) throw fail();
  return { packageRoot: root, configDirectory: config, packageVersion: "0.2.1" };
}

export async function createHealthSession(paths) {
  // Load source SDK inside the caught check, so missing dependencies are redacted.
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import("../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js"),
    import("../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js"),
  ]);
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(paths.packageRoot, "scripts/plugin-launcher.mjs")], cwd: paths.packageRoot,
    // SDK overlays six default variables; explicitly replace them all.
    env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin", HOME: userInfo().homedir, LOGNAME: "", SHELL: "", TERM: "", USER: "", LANG: "C", APPLE_PIM_CONFIG_DIR: paths.configDirectory },
    stderr: "pipe", maxBufferSize: 128 * 1024,
  });
  const client = new Client({ name: "icloud-local-health-check", version: "1.0.0" });
  let closed = false, spawned = false, resolveClosed, rejectFailure, bytes = 0, closing;
  const exited = new Promise((resolve) => { resolveClosed = resolve; });
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  void failure.catch(() => {});
  transport.onclose = () => { closed = true; resolveClosed(); };
  const originalStart = transport.start.bind(transport);
  transport.start = async () => {
    const attempt = originalStart();
    spawned ||= Number.isSafeInteger(transport.pid) && transport.pid > 0;
    try { await attempt; }
    finally { spawned ||= Number.isSafeInteger(transport.pid) && transport.pid > 0; }
  };
  const originalClose = transport.close.bind(transport);
  // Client.connect can initiate an unawaited close on failure. Share that work.
  transport.close = () => closing ??= (async () => {
    await originalClose();
    if (!spawned) { closed = true; resolveClosed(); }
    if (!closed) await exited;
  })();
  transport.stderr.on("data", (chunk) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 16384) { rejectFailure(fail()); void transport.close().catch(() => {}); }
  });
  client.onerror = () => {}; // Never emit raw server/transport diagnostics.
  return { client, transport, failure, get closed() { return closed; }, close: () => transport.close() };
}

function toolObject(response) {
  if (response?.isError || !Array.isArray(response?.content) || response.content.length !== 1 || response.content[0].type !== "text") throw fail();
  const text = response.content[0].text;
  if (typeof text !== "string" || text.length > 65536) throw fail();
  const separator = text.indexOf("\n\n");
  return JSON.parse(separator < 0 ? text : text.slice(separator + 2));
}

export function safeHealthStatus(response) {
  const value = toolObject(response);
  if (value?.connector !== "icloud-mcp-connector" || value.transport !== "stdio" ||
      !["direct", "companion"].includes(value.contactsTransport) || value.deletionDefault !== "disabled" ||
      value.cloudConnection !== "not established by this local server") throw fail();
  return { connector: "icloud-mcp-connector", transport: "stdio", contactsTransport: value.contactsTransport, deletionDefault: "disabled" };
}

async function bounded(task, milliseconds, controller) {
  if (milliseconds <= 0) throw fail();
  let timer;
  try { return await Promise.race([Promise.resolve().then(task), new Promise((_, reject) => { timer = setTimeout(() => { controller?.abort(); reject(fail()); }, milliseconds); })]); }
  finally { clearTimeout(timer); }
}

export async function checkLocalConnector(options, {
  validatePaths = validateHealthPaths, createSession = createHealthSession,
  phaseMs = 10000, totalMs = 30000, cleanupMs = 5000, clock = () => performance.now(),
} = {}) {
  if (![phaseMs, totalMs, cleanupMs].every((value) => Number.isInteger(value) && value > 0) || phaseMs > 10000 || totalMs > 30000 || cleanupMs > 5000) throw fail();
  const count = options.restart ? 2 : 1, started = clock(), hardEnd = started + totalMs, workEnd = hardEnd - count * cleanupMs;
  const phase = async (task, session) => {
    const controller = new AbortController(), timeout = Math.min(phaseMs, workEnd - clock());
    return bounded(() => Promise.race([task({ signal: controller.signal, timeout, resetTimeoutOnProgress: false }), ...(session ? [session.failure] : [])]), timeout, controller);
  };
  let active;
  try {
    const paths = await phase(() => validatePaths(options));
    const sessions = []; let runtime;
    for (let index = 0; index < count; index++) {
      active = await phase(() => createSession(paths));
      try {
        await phase((requestOptions) => active.client.connect(active.transport, requestOptions), active);
        const pid = active.transport.pid;
        if (!Number.isSafeInteger(pid) || pid < 1) throw fail();
        const listing = await phase((requestOptions) => active.client.listTools(undefined, requestOptions), active);
        if (listing.nextCursor !== undefined || !Array.isArray(listing.tools) || listing.tools.length !== HEALTH_TOOLS.length ||
            JSON.stringify(listing.tools.map((tool) => tool.name).sort()) !== JSON.stringify(HEALTH_TOOLS)) throw fail();
        runtime = safeHealthStatus(await phase((requestOptions) => active.client.callTool({ name: "apple-pim", arguments: { action: "status" } }, undefined, requestOptions), active));
        const schema = toolObject(await phase((requestOptions) => active.client.callTool({ name: "apple-pim", arguments: { action: "schema" } }, undefined, requestOptions), active));
        if (schema.tool !== "apple-pim" || schema.inputSchema?.additionalProperties !== false ||
            JSON.stringify(schema.inputSchema?.properties?.action?.enum) !== JSON.stringify(["status", "schema"])) throw fail();
        await bounded(() => active.close(), Math.min(cleanupMs, hardEnd - clock()));
        if (!active.closed) throw fail();
        sessions.push({ pid, closed: true }); active = undefined;
      } catch (error) { throw error; }
    }
    if (count === 2 && sessions[0].pid === sessions[1].pid) throw fail();
    return { success: true, route: "script-created local stdio client for reviewed package", packageVersion: paths.packageVersion,
      toolNames: [...HEALTH_TOOLS], runtime, schemaVerified: true, sessions, restartVerified: count === 2,
      personalDataRead: false, permissionRequested: false, directDotConnection: false };
  } catch { throw fail(); }
  finally {
    if (active) { try { await bounded(() => active.close(), Math.min(cleanupMs, hardEnd - clock())); } catch { /* fixed failure only; never claim cleanup */ } }
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseHealthArguments(argv);
    if (options.help) {
      process.stdout.write("Health only: --package-root /absolute/reviewed/installed/package --config-dir /absolute/private/config [--restart]\nCalls tools/list and apple-pim status/schema only. No setup, native permission check, PIM read or direct dot proof.\n");
      return;
    }
    process.stdout.write(JSON.stringify(await checkLocalConnector(options)) + "\n");
  } catch {
    process.stderr.write("Local connector health check failed; private diagnostics withheld. No PIM data or permissions requested.\n");
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
