import test from "node:test";
import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { preparePluginLaunch, validatePluginConfig } from "../scripts/plugin-launcher.mjs";

const checkout = fileURLToPath(new URL("..", import.meta.url));
const loadJSON = async (path) => JSON.parse(await readFile(join(checkout, path), "utf8"));
const executables = ["calendar-cli", "reminder-cli", "contacts-cli", "notes-access-cli", "mail-access-cli"];
const validScope = () => ({ enabled: true, mode: "allowlist", items: ["synthetic-resource"], accounts: ["synthetic-account"], allow_writes: false, allow_deletes: false });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "icloud-mcp-connector-plugin-synthetic-"));
  const packageRoot = join(root, "icloud-mcp-connector");
  const configDirectory = join(root, "host-data", "private-config");
  await mkdir(join(packageRoot, "mcp-server", "dist"), { recursive: true });
  await mkdir(join(packageRoot, "swift", ".build", "release"), { recursive: true });
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await chmod(configDirectory, 0o700);
  const configPath = join(configDirectory, "config.json");
  await writeFile(configPath, "{}", { mode: 0o600 });
  await writeFile(join(packageRoot, "mcp-server", "dist", "server.js"), "// Synthetic nonexecuted fixture\n");
  for (const name of executables) {
    await writeFile(join(packageRoot, "swift", ".build", "release", name), "synthetic nonexecuted fixture", { mode: 0o700 });
  }
  return { root, packageRoot, configDirectory, configPath, env: { APPLE_PIM_CONFIG_DIR: configDirectory } };
}

test("portable manifest and Codex overlay share scoped identity and preserve upstream version", async () => {
  const [manifest, overlay, upstream] = await Promise.all([
    loadJSON("plugin.json"), loadJSON(".codex-plugin/plugin.json"), loadJSON(".claude-plugin/plugin.json"),
  ]);
  assert.equal(manifest.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(manifest.name, "icloud-mcp-connector");
  assert.equal(manifest.version, "0.2.0");
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.repository, "https://github.com/Elephruit/icloud-mcp-connector");
  assert.match(manifest.description, /apple-pim and its existing stdio MCP/);
  assert.match(manifest.description, /dots (?:remains )?in development/);
  assert.ok(manifest.extensions["com.openai"].interface.shortDescription.length <= 30);
  for (const key of ["name", "version", "description", "author", "homepage", "repository", "license", "keywords"]) {
    assert.deepEqual(overlay[key], manifest[key]);
  }
  assert.deepEqual(overlay.interface, manifest.extensions["com.openai"].interface);
  assert.equal(overlay.mcpServers, "./mcp.json");
  for (const key of ["skills", "mcpServers", "apps", "interface"]) assert.equal(manifest[key], undefined);
  assert.equal(manifest.extensions["com.openai"].apps, undefined);
  assert.equal(manifest.extensions["com.openai"].hooks, undefined);
  assert.equal(upstream.name, "apple-pim");
  assert.equal(upstream.version, "3.18.0");
  assert.match(await readFile(join(checkout, "LICENSE"), "utf8"), /Copyright \(c\) 2025 Omar Shahine/);
});

test("portable MCP declares one local launcher and private host data without registration", async () => {
  const mcp = await loadJSON("mcp.json");
  assert.deepEqual(Object.keys(mcp).sort(), ["$schema", "mcpServers"]);
  assert.equal(mcp.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
  assert.deepEqual(Object.keys(mcp.mcpServers), ["icloud-mcp-connector"]);
  assert.deepEqual(mcp.mcpServers["icloud-mcp-connector"], {
    type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/scripts/plugin-launcher.mjs"],
    cwd: "${PLUGIN_ROOT}", env: { APPLE_PIM_CONFIG_DIR: "${PLUGIN_DATA}/private-config" },
  });
  const catalog = await loadJSON("examples/local-plugin-marketplace.example.json");
  assert.equal(catalog.name, "icloud-mcp-connector-local");
  assert.equal(catalog.plugins[0].name, "icloud-mcp-connector");
  assert.equal(catalog.plugins[0].source.path, "./plugins/icloud-mcp-connector");
  assert.equal(catalog.plugins[0].policy.installation, "AVAILABLE");
  assert.match(await readFile(join(checkout, "skills/icloud-mcp-connector/SKILL.md"), "utf8"), /^---\nname: icloud-mcp-connector\n/);
});

test("shipped configuration denies every connection, write and delete", async () => {
  const config = await loadJSON("examples/scoped-config.example.json");
  validatePluginConfig(config);
  for (const [name, scope] of Object.entries(config)) {
    assert.equal(scope.enabled, false);
    assert.deepEqual(scope.accounts, []);
    assert.deepEqual(name === "notes" ? scope.folders : name === "mail" ? scope.mailboxes : scope.items, []);
    assert.equal(["notes", "mail"].includes(name) ? scope.allowWrites : scope.allow_writes, false);
    if (!["notes", "mail"].includes(name)) assert.equal(scope.allow_deletes, false);
  }
});

test("launcher rejects broad scopes, wildcard/duplicate IDs and nonboolean flags", () => {
  assert.throws(() => validatePluginConfig(null), /JSON object/);
  for (const name of ["calendars", "reminders", "contacts"]) {
    assert.throws(() => validatePluginConfig({ [name]: { ...validScope(), mode: "all" } }), /exact resource/);
    for (const ids of [[], ["*"], ["synthetic", "synthetic"], [" synthetic"], ["synthetic\n"], Array(33).fill("synthetic")]) {
      assert.throws(() => validatePluginConfig({ [name]: { ...validScope(), items: ids } }), /exact resource/);
    }
    for (const flag of ["allow_writes", "allow_deletes"]) {
      assert.throws(() => validatePluginConfig({ [name]: { ...validScope(), [flag]: "true" } }), /flag/);
    }
  }
  assert.throws(() => validatePluginConfig({ notes: { enabled: true, accounts: ["synthetic"], folders: [] } }), /exact resource/);
  assert.throws(() => validatePluginConfig({ notes: { enabled: false, allowWrites: "true" } }), /flag/);
  assert.throws(() => validatePluginConfig({ mail: { enabled: true } }), /explicit native account/);
  assert.throws(() => validatePluginConfig({ mail: { enabled: false, allowWrites: true } }), /read-only Mail/);
  validatePluginConfig({ contacts: validScope() });
  for (const transport of ["direct", "companion"]) {
    validatePluginConfig({ contacts: { ...validScope(), transport } });
  }
  for (const transport of ["auto", "helper", "", true, null]) {
    assert.throws(() => validatePluginConfig({ contacts: { ...validScope(), transport } }), /Contacts transport/);
  }
});

test("launcher rejects implicit, relative and unexpanded config and selected profiles", async () => {
  for (const dir of [undefined, "./private-config", "${PLUGIN_DATA}/private-config", "/synthetic\npath"]) {
    await assert.rejects(preparePluginLaunch({ env: { APPLE_PIM_CONFIG_DIR: dir } }), /absolute private/);
  }
  await assert.rejects(preparePluginLaunch({ env: { APPLE_PIM_CONFIG_DIR: "/synthetic", APPLE_PIM_PROFILE: "assistant" } }), /base configuration only/);
});

test("launcher allows an owner-only external disabled config without creating anything", async () => {
  const f = await fixture();
  try {
    const result = await preparePluginLaunch({ env: f.env, root: f.packageRoot });
    assert.equal(result.configDirectory, await realpath(f.configDirectory));
    assert.equal(result.contactsTransport, "direct");
    assert.equal(result.server, await realpath(join(f.packageRoot, "mcp-server", "dist", "server.js")));
    assert.equal(await readFile(f.configPath, "utf8"), "{}");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("only host-owned private configuration selects the companion plugin transport", async () => {
  const f = await fixture();
  try {
    const env = { ...f.env, APPLE_PIM_CONTACTS_TRANSPORT: "companion" };
    assert.equal((await preparePluginLaunch({ env, root: f.packageRoot })).contactsTransport, "direct");
    await writeFile(f.configPath, JSON.stringify({ contacts: { enabled: false, transport: "companion" } }));
    assert.equal((await preparePluginLaunch({ env: f.env, root: f.packageRoot })).contactsTransport, "companion");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("launcher rejects missing/malformed/oversized or group-readable private config", async () => {
  const f = await fixture();
  try {
    await writeFile(f.configPath, "{broken");
    await assert.rejects(preparePluginLaunch({ env: f.env, root: f.packageRoot }), /Malformed/);
    await writeFile(f.configPath, " ".repeat(65537));
    await assert.rejects(preparePluginLaunch({ env: f.env, root: f.packageRoot }), /unsafe/);
    await writeFile(f.configPath, "{}");
    await chmod(f.configPath, 0o640);
    await assert.rejects(preparePluginLaunch({ env: f.env, root: f.packageRoot }), /owner-only/);
    await chmod(f.configPath, 0o600);
    await chmod(f.configDirectory, 0o750);
    await assert.rejects(preparePluginLaunch({ env: f.env, root: f.packageRoot }), /owner-only/);
    await chmod(f.configDirectory, 0o700);
    await rm(f.configPath);
    await assert.rejects(preparePluginLaunch({ env: f.env, root: f.packageRoot }), /missing/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("launcher refuses private config inside the package or a config symlink outside its directory", async () => {
  const f = await fixture();
  try {
    const internal = join(f.packageRoot, "private-config");
    await mkdir(internal, { mode: 0o700 });
    await writeFile(join(internal, "config.json"), "{}", { mode: 0o600 });
    await assert.rejects(preparePluginLaunch({ env: { APPLE_PIM_CONFIG_DIR: internal }, root: f.packageRoot }), /outside the plugin/);
    await rm(f.configPath);
    await symlink(join(internal, "config.json"), f.configPath);
    await assert.rejects(preparePluginLaunch({ env: f.env, root: f.packageRoot }), /unsafe/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("launcher refuses missing binaries and installed-binary fallback symlinks", async () => {
  const f = await fixture();
  try {
    const binary = join(f.packageRoot, "swift", ".build", "release", "contacts-cli");
    await rm(binary);
    await assert.rejects(preparePluginLaunch({ env: f.env, root: f.packageRoot }), /no automatic installation/);
    const external = join(f.root, "external-cli");
    await writeFile(external, "synthetic nonexecuted fixture", { mode: 0o700 });
    await symlink(external, binary);
    await assert.rejects(preparePluginLaunch({ env: f.env, root: f.packageRoot }), /missing/);
    await rm(binary);
    await mkdir(binary);
    await assert.rejects(preparePluginLaunch({ env: f.env, root: f.packageRoot }), /missing/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("relocated built local package starts, discovers tools and denies personal data with disabled config", { skip: process.platform !== "darwin", timeout: 15000 }, async () => {
  const f = await fixture();
  let client;
  try {
    await mkdir(join(f.packageRoot, "scripts"), { recursive: true });
    await mkdir(join(f.packageRoot, "lib"), { recursive: true });
    for (const path of ["plugin.json", "mcp.json", "scripts/plugin-launcher.mjs", "lib/scoped-mail-config.js", "mcp-server/dist/server.js"]) {
      await copyFile(join(checkout, path), join(f.packageRoot, path));
    }
    for (const name of executables) {
      await copyFile(join(checkout, "swift", ".build", "release", name), join(f.packageRoot, "swift", ".build", "release", name));
    }
    await writeFile(f.configPath, JSON.stringify(await loadJSON("examples/scoped-config.example.json")));
    const mcp = await loadJSON("mcp.json");
    const declared = mcp.mcpServers["icloud-mcp-connector"];
    const expand = (value) => value.replaceAll("${PLUGIN_ROOT}", f.packageRoot).replaceAll("${PLUGIN_DATA}", join(f.root, "host-data"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: declared.args.map(expand),
      cwd: expand(declared.cwd),
      env: { APPLE_PIM_CONFIG_DIR: expand(declared.env.APPLE_PIM_CONFIG_DIR), PLUGIN_ROOT: f.packageRoot, PLUGIN_DATA: join(f.root, "host-data") },
      stderr: "pipe",
    });
    client = new Client({ name: "synthetic-plugin-validation", version: "1.0.0" });
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map((entry) => entry.name).sort(), ["apple-pim", "calendar", "contact", "mail", "notes", "reminder"]);
    const status = await client.callTool({ name: "apple-pim", arguments: { action: "status" } });
    assert.notEqual(status.isError, true);
    assert.match(status.content[0].text, /icloud-mcp-connector/);
    assert.match(status.content[0].text, /not established/);
    for (const [name, args] of [
      ["calendar", { action: "list" }], ["reminder", { action: "lists" }],
      ["contact", { action: "containers" }], ["notes", { action: "search", query: "synthetic" }],
      ["contact", { action: "create", givenName: "Synthetic", container: "synthetic" }],
      ["mail", { action: "list", accountId: "synthetic", mailboxId: "synthetic" }],
      ["notes", { action: "create", accountId: "synthetic", folderId: "synthetic", title: "Synthetic", text: "Synthetic" }],
    ]) {
      const denied = await client.callTool({ name, arguments: args });
      assert.equal(denied.isError, true);
      assert.match(denied.content[0].text, /access is denied|Mail is disabled/);
    }
    const override = await client.callTool({ name: "calendar", arguments: { action: "list", configDir: "/synthetic" } });
    assert.equal(override.isError, true);
    assert.match(override.content[0].text, /overrides are disabled/);
  } finally {
    if (client) await client.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
