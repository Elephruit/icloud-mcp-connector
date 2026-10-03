import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_SCOPE_ITEMS = 32;

function exactIds(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCOPE_ITEMS) {
    throw new Error(`Notes ${field} must be a nonempty explicit ID allowlist (maximum ${MAX_SCOPE_ITEMS})`);
  }
  if (value.some((id) => typeof id !== "string" || id.length === 0 || id.length > 2048 || id.trim() !== id || /[\u0000-\u001f\u007f*]/u.test(id))) {
    throw new Error(`Notes ${field} must contain exact nonempty IDs, without wildcards or control characters`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`Notes ${field} cannot contain duplicate IDs`);
  }
  return Object.freeze([...value]);
}

/** No implicit home directory, broad defaults, names, or profile fallback. */
export function validateNotesConfig(config) {
  const notes = config?.notes;
  if (!notes || typeof notes !== "object" || Array.isArray(notes) || notes.enabled !== true) {
    throw new Error("Notes is disabled; an explicit notes.enabled=true configuration is required");
  }
  if (notes.allowWrites !== undefined && typeof notes.allowWrites !== "boolean") {
    throw new Error("Notes allowWrites must be a boolean");
  }
  return Object.freeze({
    enabled: true,
    accounts: exactIds(notes.accounts, "accounts"),
    folders: exactIds(notes.folders, "folders"),
    allowWrites: notes.allowWrites === true,
  });
}

export async function loadNotesConfig(env = process.env, readFileImpl = readFile) {
  if (env.APPLE_PIM_PROFILE) {
    throw new Error("Notes profiles are not supported; remove APPLE_PIM_PROFILE for Notes operations");
  }
  const directory = env.APPLE_PIM_CONFIG_DIR;
  if (typeof directory !== "string" || !isAbsolute(directory) || /[\u0000-\u001f\u007f]/u.test(directory)) {
    throw new Error("Notes requires an explicit absolute APPLE_PIM_CONFIG_DIR");
  }
  let raw;
  try {
    raw = await readFileImpl(join(directory, "config.json"), "utf8");
  } catch {
    throw new Error("Notes configuration is missing or unreadable; access remains disabled");
  }
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_CONFIG_BYTES) {
    throw new Error("Notes configuration is invalid or exceeds the size limit");
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error("Notes configuration is malformed; access remains disabled");
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Notes configuration must be a JSON object");
  }
  return validateNotesConfig(config);
}
