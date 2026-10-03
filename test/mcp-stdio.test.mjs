import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

test("built stdio protocol discovers safe tools, returns status, and rejects unsafe calls without personal access", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "apple-pim-stdio-synthetic-"));
  await writeFile(join(configDir, "config.json"), JSON.stringify({
    calendars: { enabled: true, mode: "allowlist", items: ["synthetic-calendar"], accounts: ["synthetic-account"] },
    notes: { enabled: false },
  }));
  const client = new Client({ name: "synthetic-test-client", version: "1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../mcp-server/dist/server.js", import.meta.url))],
    env: { APPLE_PIM_CONFIG_DIR: configDir },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ["apple-pim", "calendar", "contact", "notes", "reminder"]);
    const status = await client.callTool({ name: "apple-pim", arguments: { action: "status" } });
    assert.notEqual(status.isError, true);
    assert.match(status.content[0].text, /icloud-mcp-connector/);
    assert.match(status.content[0].text, /not established/);
    for (const [name, args, expected] of [
      ["calendar", { action: "delete", id: "synthetic-event" }, /Deletion is disabled/],
      ["reminder", { action: "items" }, /access is denied/],
      ["notes", { action: "search", query: "synthetic" }, /access is denied/],
      ["apple-pim", { action: "authorize" }, /Unsupported/],
      ["mail", { action: "messages" }, /Unsupported/],
    ]) {
      const denied = await client.callTool({ name, arguments: args });
      assert.equal(denied.isError, true);
      assert.match(denied.content[0].text, expected);
    }
  } finally {
    await client.close();
    await rm(configDir, { recursive: true, force: true });
  }
});
