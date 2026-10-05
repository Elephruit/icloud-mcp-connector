import { describe, expect, test, vi } from "vitest";
import { MailReadError } from "../../lib/mail-read-error.js";

const state = vi.hoisted(() => ({ handlers: new Map(), error: null }));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({ Server: class {
  setRequestHandler(schema, handler) { state.handlers.set(schema, handler); }
  async connect() {}
} }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("@modelcontextprotocol/sdk/types.js", () => ({ CallToolRequestSchema: "call", ListToolsRequestSchema: "list" }));
vi.mock("../../lib/cli-runner.js", () => ({ createCLIRunner: () => ({ runCLI: () => { throw new Error("Synthetic test must never invoke a native CLI"); } }) }));
vi.mock("../../lib/notes.js", () => ({ createNotesAdapter: () => ({ runNotes: () => { throw new Error("Synthetic test must never invoke Notes"); } }) }));
vi.mock("../../lib/scoped-mail.js", () => ({ createScopedMailAdapter: () => ({ runMail: () => { throw state.error; } }) }));
vi.mock("../../lib/scoped-dispatcher.js", () => ({ scopedTools: [], scopedToolsForContactsCompanion: () => [], createScopedDispatcher: () => async () => { throw state.error; } }));

vi.stubEnv("APPLE_PIM_CONTACTS_TRANSPORT", "direct");
await import("../server.js");

describe("MCP Mail failure response", () => {
  test.each(["MAIL_NATIVE_TIMEOUT", "MAIL_NATIVE_FAILED", "MAIL_OPERATION_DEADLINE"])("preserves vetted %s through the actual request handler", async (code) => {
    state.error = new MailReadError(code);
    state.error.message = "SYNTHETIC_PRIVATE_DIAGNOSTIC";
    state.error.phase = "SYNTHETIC_PRIVATE_PHASE";
    const result = await state.handlers.get("call")({ params: { name: "mail", arguments: { action: "list" } } });
    const value = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(value.success).toBe(false);
    expect(value.code).toBe(code);
    expect(value.reason).toBe(code === "MAIL_NATIVE_FAILED" ? "native_failure" : "timeout");
    expect(JSON.stringify(value)).not.toContain("SYNTHETIC_PRIVATE");
  });

  test("does not reflect arbitrary error.code or expose Mail codes for another domain", async () => {
    state.error = Object.assign(new Error("Synthetic validation failed"), { code: "SYNTHETIC_PRIVATE_CODE", phase: "SYNTHETIC_PRIVATE_PHASE" });
    let result = await state.handlers.get("call")({ params: { name: "mail", arguments: { action: "list" } } });
    let value = JSON.parse(result.content[0].text);
    expect(value.code).toBeUndefined();
    expect(value.phase).toBeUndefined();
    state.error = new MailReadError("MAIL_NATIVE_TIMEOUT");
    result = await state.handlers.get("call")({ params: { name: "calendar", arguments: { action: "events" } } });
    value = JSON.parse(result.content[0].text);
    expect(value.code).toBeUndefined();
    expect(value.phase).toBeUndefined();
  });
});
