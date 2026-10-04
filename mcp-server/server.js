#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { basename, dirname, join } from "path";
// Bundled: esbuild inlines this at build time, and `scripts/bump-version.sh`
// rewrites package.json then rebuilds dist, so the reported version cannot drift
// from the manifest the way a hardcoded literal did.
import pkg from "./package.json" with { type: "json" };
import { fileURLToPath } from "url";
import {
  markToolResult,
  getDatamarkingPreamble,
} from "../lib/sanitize.js";
import { createCLIRunner } from "../lib/cli-runner.js";
import { createScopedDispatcher, scopedTools, scopedToolsForContactsCompanion } from "../lib/scoped-dispatcher.js";
import { ContactsCompanionError, createContactsCompanionRunner } from "../lib/contacts-companion.js";
import { createNotesAdapter } from "../lib/notes.js";
import { createScopedMailAdapter } from "../lib/scoped-mail.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Never silently select an older ~/.local/bin installation or launch a helper
// with a different permission identity. Only this checkout's reviewed binaries.
const checkoutRoot = basename(__dirname) === "dist" ? join(__dirname, "..", "..") : join(__dirname, "..");
const SWIFT_BIN_DIR = join(checkoutRoot, "swift", ".build", "release");
const cliEnv = {};
for (const key of ["APPLE_PIM_CONFIG_DIR", "APPLE_PIM_PROFILE", "APPLE_PIM_DATE_FORMAT"]) {
  if (process.env[key] !== undefined) cliEnv[key] = process.env[key];
}
const { runCLI } = createCLIRunner(SWIFT_BIN_DIR, cliEnv, { helperExists: () => false });
const { runNotes } = createNotesAdapter({ binDir: SWIFT_BIN_DIR });
const { runMail } = createScopedMailAdapter({ binDir: SWIFT_BIN_DIR });
const contactsTransport = process.env.APPLE_PIM_CONTACTS_TRANSPORT ?? "direct";
if (!["direct", "companion"].includes(contactsTransport)) throw new Error("Invalid host Contacts transport; access is denied.");
const runContact = contactsTransport === "companion" ? createContactsCompanionRunner() : undefined;
const activeTools = runContact ? scopedToolsForContactsCompanion() : scopedTools;
const handleTool = createScopedDispatcher({ runCLI, runNotes, runContact, runMail });

// Create and run server
const server = new Server(
  {
    name: "apple-pim",
    version: pkg.version,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: activeTools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const result = await handleTool(name, args || {});

    // Apply datamarking to untrusted PIM content fields
    const markedResult = markToolResult(result, name);
    const preamble = getDatamarkingPreamble(name);

    return {
      content: [
        {
          type: "text",
          text: `${preamble}\n\n${JSON.stringify(markedResult, null, 2)}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: false,
              error: error.message,
              ...(error instanceof ContactsCompanionError ? {
                code: error.code,
                ...(error.requestId ? { requestId: error.requestId } : {}),
                mutationMayHaveOccurred: error.mutationMayHaveOccurred,
              } : {}),
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
