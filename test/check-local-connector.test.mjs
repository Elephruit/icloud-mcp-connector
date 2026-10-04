import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { checkLocalConnector, createHealthSession, HEALTH_TOOLS, parseHealthArguments, safeHealthStatus, validateHealthPaths } from "../scripts/check-local-connector.mjs";

const options = { packageRoot: "/synthetic/package", configDirectory: "/synthetic/private", restart: false };
const status = { connector: "icloud-mcp-connector", transport: "stdio", contactsTransport: "direct", deletionDefault: "disabled", cloudConnection: "not established by this local server", privateExtra: "SYNTHETIC_PRIVATE" };
const schema = { tool: "apple-pim", inputSchema: { additionalProperties: false, properties: { action: { enum: ["status", "schema"] } } } };
const response = (object) => ({ content: [{ type: "text", text: "Synthetic preamble\n\n" + JSON.stringify(object) }] });
const checkout = fileURLToPath(new URL("../", import.meta.url));
const pinnedArtifacts = ["scripts/plugin-launcher.mjs", "mcp-server/dist/server.js", "lib/scoped-mail-config.js"];
const runGit = promisify(execFile);

async function committedReviewedBundle() {
  try {
    // CI rebuilds with unlocked dependencies before these tests. Its new bundle
    // may differ from the reviewed installed artifact, so read the tracked blob.
    const { stdout } = await runGit("git", ["--no-pager", "show", "HEAD:mcp-server/dist/server.js"], {
      cwd: checkout, encoding: "buffer", maxBuffer: 4 * 1024 * 1024, timeout: 5000,
      env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1" },
    });
    if (!Buffer.isBuffer(stdout) || stdout.length < 1 || stdout.length > 4 * 1024 * 1024) throw new Error();
    return stdout;
  } catch { throw new Error("Reviewed package fixture requires the committed bundle in a local Git checkout."); }
}

async function reviewedPackageFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "icloud-health-synthetic-")));
  try {
    const packageRoot = join(root, "package"), configDirectory = join(root, "private");
    await mkdir(packageRoot, { mode: 0o700 }); await mkdir(configDirectory, { mode: 0o700 });
    for (const path of ["plugin.json", ...pinnedArtifacts]) {
      const target = join(packageRoot, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      if (path === "mcp-server/dist/server.js") await writeFile(target, await committedReviewedBundle(), { mode: 0o600 });
      else await copyFile(join(checkout, path), target);
      await chmod(target, 0o600);
    }
    const configPath = join(configDirectory, "config.json");
    await writeFile(configPath, "{}", { mode: 0o600 });
    return { root, packageRoot, configDirectory, configPath };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

async function rejectsBeforeLaunch(selected) {
  let launches = 0;
  await assert.rejects(checkLocalConnector(selected, {
    createSession: () => { launches++; return fakeSession(); },
  }));
  assert.equal(launches, 0);
}

function fakeSession({ pid = 12345, connect, listing, tool, close } = {}) {
  const calls = []; let closed = false;
  return {
    calls, transport: { pid }, failure: new Promise(() => {}), get closed() { return closed; },
    client: {
      connect: async () => { calls.push("initialize"); if (connect) await connect(); },
      listTools: async () => { calls.push("tools/list"); return listing ?? { tools: HEALTH_TOOLS.map((name) => ({ name })) }; },
      callTool: async (request) => { calls.push(request); return tool ? tool(request) : response(request.arguments.action === "status" ? status : schema); },
    },
    close: async () => { calls.push("close"); if (close) await close(); closed = true; },
  };
}
const paths = async () => ({ ...options, packageVersion: "0.2.1" });

test("CLI requires two explicit absolute locations and no data/setup/consent flags", () => {
  assert.deepEqual(parseHealthArguments(["--package-root", options.packageRoot, "--config-dir", options.configDirectory, "--restart"]), { ...options, restart: true });
  for (const argv of [[], ["--package-root", "relative", "--config-dir", "/synthetic"], ["--package-root", "/synthetic", "--config-dir", "/synthetic", "--authorize"], ["--package-root", "/synthetic", "--config-dir", "/synthetic", "--data"]]) assert.throws(() => parseHealthArguments(argv));
});

test("health check calls only discovery and runtime status/schema, closes both owned sessions and redacts extras", async () => {
  const sessions = [fakeSession({ pid: 12345 }), fakeSession({ pid: 12346 })]; let index = 0;
  const result = await checkLocalConnector({ ...options, restart: true }, { validatePaths: paths, createSession: () => sessions[index++] });
  assert.equal(result.restartVerified, true); assert.equal(result.personalDataRead, false); assert.equal(result.directDotConnection, false);
  assert.equal(JSON.stringify(result).includes("SYNTHETIC_PRIVATE"), false);
  for (const session of sessions) assert.deepEqual(session.calls, ["initialize", "tools/list", { name: "apple-pim", arguments: { action: "status" } }, { name: "apple-pim", arguments: { action: "schema" } }, "close"]);
  assert.deepEqual(result.sessions, [{ pid: 12345, closed: true }, { pid: 12346, closed: true }]);
});

test("unexpected or paginated catalogs fail before tool calls and still close", async () => {
  for (const listing of [{ tools: HEALTH_TOOLS.map((name) => ({ name })), nextCursor: "SYNTHETIC_PRIVATE" }, { tools: [{ name: "SYNTHETIC_PRIVATE" }] }]) {
    const session = fakeSession({ listing });
    await assert.rejects(checkLocalConnector(options, { validatePaths: paths, createSession: () => session }), (error) => !error.message.includes("SYNTHETIC_PRIVATE"));
    assert.deepEqual(session.calls, ["initialize", "tools/list", "close"]); assert.equal(session.closed, true);
  }
});

test("server errors/status values are not copied into errors or output", async () => {
  assert.throws(() => safeHealthStatus(response({ ...status, contactsTransport: "SYNTHETIC_PRIVATE" })));
  const session = fakeSession({ tool: () => { throw new Error("/synthetic/private/SYNTHETIC_PRIVATE"); } });
  await assert.rejects(checkLocalConnector(options, { validatePaths: paths, createSession: () => session }), (error) => !error.message.includes("SYNTHETIC_PRIVATE") && !error.message.includes("/synthetic/"));
  assert.equal(session.closed, true);
});

test("a hanging initialization times out, never dispatches a tool and awaits cleanup", async () => {
  const session = fakeSession({ connect: () => new Promise(() => {}) });
  await assert.rejects(checkLocalConnector(options, { validatePaths: paths, createSession: () => session, phaseMs: 10, totalMs: 100, cleanupMs: 10 }));
  assert.deepEqual(session.calls, ["initialize", "close"]); assert.equal(session.closed, true);
});

test("current reviewed package passes private metadata and all artifact hash checks", async () => {
  const fixture = await reviewedPackageFixture();
  try {
    assert.deepEqual(await validateHealthPaths(fixture), {
      packageRoot: fixture.packageRoot, configDirectory: fixture.configDirectory, packageVersion: "0.2.1",
    });
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("altering each reviewed artifact rejects the otherwise valid package before a session is created", async () => {
  const fixture = await reviewedPackageFixture();
  try {
    await validateHealthPaths(fixture);
    for (const path of pinnedArtifacts) {
      const target = join(fixture.packageRoot, path), original = await readFile(target), changed = Buffer.from(original);
      changed[0] ^= 1;
      try {
        await writeFile(target, changed);
        await rejectsBeforeLaunch(fixture);
      } finally { await writeFile(target, original); }
      await validateHealthPaths(fixture);
    }
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("private config metadata rejects world-readable files, linked files and Git placement before any package execution", async () => {
  const fixture = await reviewedPackageFixture();
  try {
    await validateHealthPaths(fixture);
    await chmod(fixture.configPath, 0o644);
    await rejectsBeforeLaunch(fixture);
    await chmod(fixture.configPath, 0o600); await validateHealthPaths(fixture);
    const linked = join(fixture.configDirectory, "linked.json");
    await link(fixture.configPath, linked);
    await rejectsBeforeLaunch(fixture);
    await rm(linked); await validateHealthPaths(fixture);
    const gitMarker = join(fixture.root, ".git");
    await writeFile(gitMarker, "synthetic\n");
    await rejectsBeforeLaunch(fixture);
    await rm(gitMarker); await validateHealthPaths(fixture);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("real SDK initialization failure shares cleanup and observes the synthetic child exit", { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "icloud-health-child-synthetic-")); let session;
  try {
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "scripts", "plugin-launcher.mjs"), 'process.stderr.write("SYNTHETIC_PRIVATE_DIAGNOSTIC\\n"); process.stdout.write("invalid-json\\n"); setInterval(() => {}, 1000);\n');
    await assert.rejects(checkLocalConnector(options, {
      validatePaths: async () => ({ packageRoot: root, configDirectory: "/synthetic-not-read", packageVersion: "0.2.1" }),
      createSession: async (selected) => { session = await createHealthSession(selected); return session; },
      phaseMs: 1000, totalMs: 8000, cleanupMs: 5000,
    }), (error) => !error.message.includes("SYNTHETIC_PRIVATE") && !error.message.includes(root));
    assert.equal(session.closed, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
