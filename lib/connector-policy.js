import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// Only host-owned configuration can grant access. Tool arguments cannot select
// a different configuration directory or a more permissive profile.
export function loadConnectorConfig(env = process.env, readFile = readFileSync) {
  const dir = env.APPLE_PIM_CONFIG_DIR;
  if (!dir || !isAbsolute(dir)) {
    throw new Error("Set APPLE_PIM_CONFIG_DIR to an absolute private configuration directory; access is denied.");
  }
  let config;
  try {
    config = JSON.parse(readFile(join(dir, "config.json"), "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("invalid object");
    const profile = env.APPLE_PIM_PROFILE;
    if (profile !== undefined) {
      if (!/^[A-Za-z0-9_-]+$/.test(profile)) throw new Error("invalid profile");
      const override = JSON.parse(readFile(join(dir, "profiles", `${profile}.json`), "utf8"));
      if (!override || typeof override !== "object" || Array.isArray(override)) throw new Error("invalid profile object");
      config = { ...config, ...override };
    }
  } catch {
    throw new Error("Missing or malformed connector configuration/profile; access is denied.");
  }
  return config;
}

const nonemptyIDs = (value) => Array.isArray(value) && value.length > 0 &&
  value.every((id) => typeof id === "string" && id.trim().length > 0);

export function requireConnectorScope(name, args, config) {
  if (args.configDir !== undefined || args.profile !== undefined) {
    throw new Error("Per-call configuration overrides are disabled; configure the host environment instead.");
  }
  const key = { calendar: "calendars", reminder: "reminders", contact: "contacts", notes: "notes" }[name];
  if (!key) throw new Error(`Unsupported scoped connector tool: ${name}`);
  const scope = config[key];
  const items = name === "notes" ? scope?.folders : scope?.items;
  if (scope?.enabled !== true || !nonemptyIDs(items) || !nonemptyIDs(scope.accounts) ||
      (name !== "notes" && scope.mode !== "allowlist")) {
    throw new Error(`${key} requires enabled=true and explicit item and account ID allowlists; access is denied.`);
  }
  if ((args.action === "delete" || args.action === "batch_delete") && scope.allow_deletes !== true) {
    throw new Error(`Deletion is disabled for ${key}.`);
  }
  const nativeMutations = {
    calendar: ["create", "update", "delete", "batch_create"],
    reminder: ["create", "update", "complete", "delete", "batch_create", "batch_complete", "batch_delete"],
    contact: ["create", "update", "delete"],
  };
  // Every native write needs a separate host opt-in; Notes keeps its camelCase key.
  if (nativeMutations[name]?.includes(args.action) && scope.allow_writes !== true) {
    const label = { calendar: "Calendar", reminder: "Reminder", contact: "Contact" }[name];
    throw new Error(`${label} writes require allow_writes=true in host configuration.`);
  }
  if (name === "notes" && ["create", "append"].includes(args.action) && scope.allowWrites !== true) {
    throw new Error("Notes writes require allowWrites=true in host configuration.");
  }
}
