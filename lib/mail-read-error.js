// Only fixed, reviewed facts reach MCP clients. Native diagnostics can contain
// message text, account selectors or private paths and must stay redacted.
const failures = Object.freeze({
  MAIL_PREFLIGHT_UNAVAILABLE: ["preflight", "unavailable", "Mail permission preflight executable unavailable; no Mail data command was sent"],
  MAIL_PREFLIGHT_DENIED: ["preflight", "unavailable", "Mail must already be running with an existing Automation grant; no prompt or Mail data command was sent"],
  MAIL_PREFLIGHT_FAILED: ["preflight", "native_failure", "Mail permission preflight failed; no Mail data command was sent"],
  MAIL_PREFLIGHT_TIMEOUT: ["preflight", "timeout", "Mail permission preflight timed out; no Mail data command was sent"],
  MAIL_PREFLIGHT_ABORTED: ["preflight", "aborted", "Mail permission preflight aborted; no Mail data command was sent"],
  MAIL_PREFLIGHT_LIMIT: ["preflight", "output_limit", "Mail permission preflight output exceeded its limit; no Mail data command was sent"],
  MAIL_PREFLIGHT_INVALID_RESPONSE: ["preflight", "invalid_response", "Mail permission preflight returned invalid JSON; no Mail data command was sent"],
  MAIL_NATIVE_UNAVAILABLE: ["native", "unavailable", "Scoped read-only Mail executable unavailable; no complete result is available"],
  MAIL_NATIVE_FAILED: ["native", "native_failure", "Scoped read-only Mail command failed; verify enrolled scope and supported message state locally"],
  MAIL_NATIVE_INPUT_FAILED: ["native", "input_failure", "Scoped read-only Mail script input failed; no complete result is available"],
  MAIL_NATIVE_TIMEOUT: ["native", "timeout", "Scoped read-only Mail command timed out; no complete result is available"],
  MAIL_NATIVE_ABORTED: ["native", "aborted", "Scoped read-only Mail operation aborted; no complete result is available"],
  MAIL_NATIVE_LIMIT: ["native", "output_limit", "Scoped read-only Mail output exceeded its limit; no complete result is available"],
  MAIL_NATIVE_INVALID_RESPONSE: ["native", "invalid_response", "Scoped read-only Mail command returned invalid JSON; no complete result is available"],
  MAIL_OPERATION_DEADLINE: ["operation", "timeout", "Mail read operation exceeded its overall deadline; no complete result is available"],
});

export class MailReadError extends Error {
  constructor(code) {
    if (!Object.hasOwn(failures, code)) throw new TypeError("Unsupported Mail read failure code");
    const definition = failures[code];
    super(definition[2]);
    this.name = "MailReadError";
    Object.defineProperty(this, "code", { value: code, enumerable: true });
  }
}

export function mailReadErrorDetails(error) {
  if (!(error instanceof MailReadError)) return null;
  const [phase, reason, message] = failures[error.code];
  return { error: message, code: error.code, phase, reason };
}
