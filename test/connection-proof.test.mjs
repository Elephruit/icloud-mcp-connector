import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { ErrorCode } from "../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js";
import { FIXTURE_MARKER, FIXTURE_TOOL, PROOF_VERSION, validateFixtureArguments } from "../mcp-server/connection-proof-server.js";

const source = fileURLToPath(new URL("../mcp-server/connection-proof-server.js", import.meta.url));
const bundle = fileURLToPath(new URL("../mcp-server/dist/connection-proof-server.js", import.meta.url));
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

async function connect(path, options = {}) {
  const client = new Client({ name: "synthetic-connection-proof-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path], env: {}, stderr: "pipe", ...options,
  });
  try { await client.connect(transport); }
  catch (error) { await client.close(); throw error; }
  return client;
}

async function probe(client, nonce) {
  const response = await client.callTool({ name: FIXTURE_TOOL, arguments: { nonce } });
  assert.notEqual(response.isError, true);
  const result = JSON.parse(response.content[0].text);
  assert.deepEqual(response.structuredContent, result);
  assert.deepEqual(Object.keys(result).sort(), ["fixtureMarker", "nonce", "processInstance", "version"]);
  assert.equal(result.nonce, nonce);
  assert.equal(result.fixtureMarker, FIXTURE_MARKER);
  assert.equal(result.version, PROOF_VERSION);
  assert.match(result.processInstance, uuidPattern);
  return result;
}

test("fixture arguments require exactly one bounded ASCII synthetic nonce", () => {
  for (const nonce of ["a", "Probe_01", "a".repeat(64)]) assert.equal(validateFixtureArguments({ nonce }), nonce);
  const invalid = [
    undefined, null, [], {}, { nonce: 1 }, { nonce: true }, { nonce: "" },
    { nonce: "a".repeat(65) }, { nonce: "Probe 01" }, { nonce: "Probe_01\n" },
    { nonce: "Probe_é1" }, { nonce: "Probe_01\u0000" }, { nonce: "../Probe_01" },
    { nonce: "Probe_01", configDir: "synthetic" }, { nonce: "Probe_01", action: "create" },
    Object.assign(Object.create({ nonce: "Probe_01" }), {}),
    { nonce: "Probe_01", [Symbol("unknown")]: true },
  ];
  for (const args of invalid) assert.throws(() => validateFixtureArguments(args), (error) => error.code === ErrorCode.InvalidParams);
});

for (const [label, path] of [["source", source], ["bundle", bundle]]) {
  test(`${label} MCP exposes only the read-only fixture and echoes its nonce`, { timeout: 15000 }, async () => {
    const client = await connect(path);
    try {
      const listing = await client.listTools();
      assert.equal(listing.tools.length, 1);
      const tool = listing.tools[0];
      assert.equal(tool.name, FIXTURE_TOOL);
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.deepEqual(tool.inputSchema.required, ["nonce"]);
      assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      const first = await probe(client, "Synthetic_Probe_01");
      const second = await probe(client, "Synthetic_Probe_02");
      assert.equal(first.processInstance, second.processInstance);
    } finally { await client.close(); }
  });

  test(`${label} MCP rejects unknown tools, extra fields and invalid nonces`, { timeout: 15000 }, async () => {
    const client = await connect(path);
    try {
      for (const request of [
        { name: "calendar", arguments: { nonce: "Synthetic_01" } },
        { name: FIXTURE_TOOL, arguments: {} },
        { name: FIXTURE_TOOL, arguments: { nonce: "Synthetic_01", configDir: "synthetic" } },
        { name: FIXTURE_TOOL, arguments: { nonce: "Synthetic_01", path: "synthetic" } },
        { name: FIXTURE_TOOL, arguments: { nonce: "Synthetic_01\n" } },
        { name: FIXTURE_TOOL, arguments: { nonce: "a".repeat(65) } },
        { name: FIXTURE_TOOL, arguments: { nonce: ["Synthetic_01"] } },
      ]) {
        await assert.rejects(client.callTool(request), (error) => error.code === ErrorCode.InvalidParams);
      }
      await probe(client, "Synthetic_Still_Alive");
    } finally { await client.close(); }
  });
}

test("relocated bundle works without source, dependencies or personal configuration", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "icloud-connection-proof-synthetic-"));
  let client;
  try {
    const relocated = join(root, "connection-proof-server.js");
    await copyFile(bundle, relocated);
    await writeFile(join(root, "package.json"), '{"type":"module"}\n');
    client = await connect(relocated, {
      cwd: root,
      env: { APPLE_PIM_CONFIG_DIR: "synthetic-invalid-path", APPLE_PIM_PROFILE: "synthetic-invalid-profile" },
    });
    await probe(client, "Synthetic_Relocated_01");
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), [FIXTURE_TOOL]);
  } finally {
    if (client) await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("restarting the bundled process changes its instance identity", { timeout: 15000 }, async () => {
  const first = await connect(bundle);
  let firstResult;
  try { firstResult = await probe(first, "Synthetic_Restart_01"); }
  finally { await first.close(); }
  const second = await connect(bundle);
  try {
    const secondResult = await probe(second, "Synthetic_Restart_01");
    assert.notEqual(firstResult.processInstance, secondResult.processInstance);
  } finally { await second.close(); }
});

test("proof source is isolated from PIM/configuration and uses no listeners or native commands", async () => {
  const code = await readFile(source, "utf8");
  const imports = [...code.matchAll(/from\s+"([^"]+)"/gu)].map((match) => match[1]).sort();
  assert.deepEqual(imports, [
    "@modelcontextprotocol/sdk/server/index.js", "@modelcontextprotocol/sdk/server/stdio.js",
    "@modelcontextprotocol/sdk/types.js", "node:crypto",
  ]);
  assert.doesNotMatch(code, /process\.env|node:(?:fs|net|http|https|child_process)|\.listen\(|createCLIRunner|createNotesAdapter/u);
});
