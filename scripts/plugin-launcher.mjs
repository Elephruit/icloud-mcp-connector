#!/usr/bin/env node
// iCloud MCP Connector, derived from MIT-licensed Apple PIM and its stdio MCP.
// Copyright (c) 2025 Omar Shahine; see ../LICENSE.
import { access, readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_CONFIG_BYTES = 64 * 1024;
const nativeExecutables = ["calendar-cli", "reminder-cli", "contacts-cli", "notes-access-cli"];
const inside = (root, target) => {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};
const exactIDs = (ids) => Array.isArray(ids) && ids.length > 0 && ids.length <= 32 &&
  new Set(ids).size === ids.length && ids.every((id) => typeof id === "string" &&
    id.length > 0 && id.length <= 2048 && id.trim() === id && !/[\u0000-\u001f\u007f*]/u.test(id));

export function validatePluginConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Plugin configuration must be a JSON object; access is denied.");
  }
  for (const name of ["calendars", "reminders", "contacts", "notes"]) {
    const domain = config[name];
    if (domain === undefined) continue; // Missing domains remain disabled downstream.
    if (!domain || typeof domain !== "object" || Array.isArray(domain) ||
        (domain.enabled !== undefined && typeof domain.enabled !== "boolean")) {
      throw new Error(`Invalid ${name} configuration; access is denied.`);
    }
    const flags = name === "notes" ? ["allowWrites"] : ["allow_writes", "allow_deletes"];
    if (flags.some((key) => domain[key] !== undefined && typeof domain[key] !== "boolean")) {
      throw new Error(`Invalid ${name} write/deletion flag; access is denied.`);
    }
    if (domain.enabled === true && (!exactIDs(domain.accounts) ||
        !exactIDs(name === "notes" ? domain.folders : domain.items) ||
        (name !== "notes" && domain.mode !== "allowlist"))) {
      throw new Error(`${name} requires exact resource and account allowlists; access is denied.`);
    }
  }
  if (config.mail?.enabled === true) throw new Error("Mail is outside the scoped local plugin.");
  return config;
}

// Validate the host-owned file before loading the server. No directory/file is
// created, no build/install is run, and no privacy grant or store is queried.
export async function preparePluginLaunch({ env = process.env, root = packageRoot } = {}) {
  const selectedDirectory = env.APPLE_PIM_CONFIG_DIR;
  if (typeof selectedDirectory !== "string" || !isAbsolute(selectedDirectory) ||
      /[\u0000-\u001f\u007f]/u.test(selectedDirectory) || selectedDirectory.includes("${")) {
    throw new Error("Set an absolute private APPLE_PIM_CONFIG_DIR; plugin access is denied.");
  }
  if (env.APPLE_PIM_PROFILE) {
    throw new Error("This local plugin uses base configuration only; remove APPLE_PIM_PROFILE.");
  }
  const resolvedRoot = await realpath(root);
  let configDirectory, configPath;
  try {
    configDirectory = await realpath(selectedDirectory);
    configPath = await realpath(join(configDirectory, "config.json"));
    const directoryInfo = await stat(configDirectory);
    const fileInfo = await stat(configPath);
    if (!directoryInfo.isDirectory() || !fileInfo.isFile() ||
        inside(resolvedRoot, configDirectory) || inside(resolvedRoot, configPath) ||
        !inside(configDirectory, configPath) || fileInfo.size > MAX_CONFIG_BYTES ||
        (directoryInfo.mode & 0o077) !== 0 || (fileInfo.mode & 0o077) !== 0) throw new Error("private file requirements");
  } catch {
    throw new Error("Private configuration is missing, unsafe or unreadable. Keep an owner-only directory/file outside the plugin; access is denied.");
  }
  let config;
  try {
    const raw = await readFile(configPath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_CONFIG_BYTES) throw new Error("oversize");
    config = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Malformed plugin configuration; access is denied.");
    throw new Error("Plugin configuration is unreadable or oversized; access is denied.");
  }
  validatePluginConfig(config);
  const server = join(resolvedRoot, "mcp-server", "dist", "server.js");
  try {
    if (!inside(resolvedRoot, await realpath(server)) || !(await stat(server)).isFile()) throw new Error("server outside package or not a file");
    await access(server, constants.R_OK);
    for (const executable of nativeExecutables) {
      const binary = join(resolvedRoot, "swift", ".build", "release", executable);
      if (!inside(resolvedRoot, await realpath(binary)) || !(await stat(binary)).isFile()) throw new Error("binary outside package or not a file");
      await access(binary, constants.X_OK);
    }
  } catch {
    throw new Error("Reviewed bundled MCP server/native binaries are missing. Build or stage the package before installation; no automatic installation is performed.");
  }
  return { server, configDirectory };
}

export async function startPlugin() {
  if (process.platform !== "darwin") throw new Error("iCloud MCP Connector requires a local Mac.");
  const { server, configDirectory } = await preparePluginLaunch();
  process.env.APPLE_PIM_CONFIG_DIR = configDirectory;
  delete process.env.APPLE_PIM_PROFILE; // Empty host variables must not select a profile.
  await import(pathToFileURL(server).href);
}

// macOS /var and /tmp are symlinks. Compare real paths so a staged package
// launched through either spelling still starts, without changing import use.
if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  startPlugin().catch((error) => {
    console.error(`iCloud MCP Connector: ${error.message}`);
    process.exitCode = 1;
  });
}
