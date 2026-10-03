import { tools } from "./schemas.js";
import { withAgentDX } from "./agent-dx.js";
import { handleCalendar } from "./handlers/calendar.js";
import { handleReminder } from "./handlers/reminder.js";
import { handleContact } from "./handlers/contact.js";
import { loadConnectorConfig, requireConnectorScope } from "./connector-policy.js";

const notesTool = {
  name: "notes",
  description: "Read or write plain text in explicitly allowed Notes account/folder IDs. Actions: search, get, create, append, schema. Writes require host allowWrites=true; no deletion or rich-content append.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["search", "get", "create", "append", "schema"] },
      accountId: { type: "string", description: "Exact allowed Notes account ID; required for writes." },
      folderId: { type: "string", description: "Exact allowed Notes folder ID; required for writes." },
      id: { type: "string", description: "Note ID for get/append; looked up only inside allowed folders." },
      query: { type: "string", description: "Nonempty plain-text search query." },
      title: { type: "string", description: "New note title for create." },
      text: { type: "string", description: "Plain text to create or append; never executed as script/HTML." },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum search results, default 20." },
      dryRun: { type: "boolean", description: "Validate write scope and return a preview without opening Notes." },
    },
    required: ["action"],
    additionalProperties: false,
  },
};

export const scopedTools = [...tools.filter((tool) => tool.name !== "mail").map((tool) => {
  if (tool.name !== "apple-pim") {
    const { configDir, profile, ...properties } = tool.inputSchema.properties;
    return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
  }
  return {
    ...tool,
    description: "Scoped connector runtime status (no personal data or permission requests).",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["status", "schema"] } }, required: ["action"], additionalProperties: false },
  };
}), notesTool];

export function createScopedDispatcher({ runCLI, runNotes, loadConfig = loadConnectorConfig }) {
  const handlers = {
    calendar: withAgentDX("calendar", handleCalendar),
    reminder: withAgentDX("reminder", handleReminder),
    contact: withAgentDX("contact", handleContact),
  };
  return async (name, args = {}) => {
    const tool = scopedTools.find((entry) => entry.name === name);
    if (!tool || !tool.inputSchema.properties.action.enum.includes(args.action)) {
      throw new Error(`Unsupported scoped connector tool/action: ${name}/${args.action}`);
    }
    if (args.configDir !== undefined || args.profile !== undefined) {
      throw new Error("Per-call configuration overrides are disabled.");
    }
    if (args.action === "schema") return { tool: name, inputSchema: tool.inputSchema, description: tool.description };
    if (name === "apple-pim") {
      return { connector: "icloud-mcp-connector", transport: "stdio", personalDataAccess: "requires explicit host configuration and existing macOS grants", deletionDefault: "disabled", cloudConnection: "not established by this local server" };
    }
    requireConnectorScope(name, args, loadConfig());
    if (name === "notes") {
      if (!runNotes) throw new Error("Notes adapter is unavailable.");
      return runNotes(args);
    }
    return handlers[name](args, runCLI);
  };
}
