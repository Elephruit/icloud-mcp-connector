#!/usr/bin/env node
// Standalone synthetic connection proof. Deliberately imports no PIM code,
// configuration, filesystem, credentials, native commands or network transport.
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

export const PROOF_VERSION = "1.0.0";
export const FIXTURE_MARKER = "icloud-mcp-connector-synthetic-connection-proof-v1";
export const FIXTURE_TOOL = "connector-fixture";
const processInstance = randomUUID();
const invalidNonceCharacter = /[^A-Za-z0-9_-]/u;

export function validateFixtureArguments(args) {
  if (!args || typeof args !== "object" || Array.isArray(args) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(args)) ||
      Reflect.ownKeys(args).length !== 1 || !Object.hasOwn(args, "nonce") ||
      typeof args.nonce !== "string" || args.nonce.length < 1 || args.nonce.length > 64 ||
      invalidNonceCharacter.test(args.nonce)) {
    throw new McpError(ErrorCode.InvalidParams,
      "Provide only nonce: 1–64 ASCII letters, digits, underscores or hyphens. Use synthetic values only.");
  }
  return args.nonce;
}

export function createConnectionProofServer() {
  const server = new Server({
    name: "icloud-mcp-connector-connection-proof", version: PROOF_VERSION,
  }, {
    capabilities: { tools: {} },
    instructions: "Synthetic connection proof only. Call connector-fixture with a fresh synthetic nonce. " +
      "Use synthetic nonces only; do not send personal information, passwords, credentials or private configuration. " +
      "This server cannot read or write PIM data, request permissions or prove iCloud synchronization. " +
      "Record the actual calling assistant, transport and execution route separately.",
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: FIXTURE_TOOL,
      description: "Prove this synthetic MCP process is reachable by echoing a fresh synthetic nonce. " +
        "Use no passwords or personal data. Does not establish PIM access or direct dot integration.",
      inputSchema: {
        type: "object", additionalProperties: false,
        properties: { nonce: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$(?![\\s\\S])" } },
        required: ["nonce"],
      },
      outputSchema: {
        type: "object", additionalProperties: false,
        properties: {
          nonce: { type: "string" },
          fixtureMarker: { type: "string", const: FIXTURE_MARKER },
          version: { type: "string", const: PROOF_VERSION },
          processInstance: { type: "string", format: "uuid" },
        },
        required: ["nonce", "fixtureMarker", "version", "processInstance"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== FIXTURE_TOOL) {
      throw new McpError(ErrorCode.InvalidParams, "Unknown tool; only connector-fixture is available.");
    }
    const nonce = validateFixtureArguments(request.params.arguments);
    const result = { nonce, fixtureMarker: FIXTURE_MARKER, version: PROOF_VERSION, processInstance };
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  });
  return server;
}

export async function startConnectionProofServer() {
  await createConnectionProofServer().connect(new StdioServerTransport());
}

// Match entrypoint basenames lexically to tolerate macOS's /tmp and /var aliases
// without opening filesystem paths. Imports from a differently named module do
// not start the transport. The source and relocated bundle share this name.
if (process.argv[1]?.replaceAll("\\", "/").split("/").at(-1) === new URL(import.meta.url).pathname.split("/").at(-1)) {
  startConnectionProofServer().catch(() => {
    console.error("Synthetic connection-proof MCP initialization failed.");
    process.exitCode = 1;
  });
}
