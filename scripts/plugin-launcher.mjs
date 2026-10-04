#!/usr/bin/env node
// iCloud MCP Connector, derived from MIT-licensed Apple PIM and its stdio MCP.
// Copyright (c) 2025 Omar Shahine; see ../LICENSE.
import { access, lstat, open, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateMailConfig } from "../lib/scoped-mail-config.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_CONFIG_BYTES = 64 * 1024;
const nativeExecutables = ["calendar-cli", "reminder-cli", "contacts-cli", "notes-access-cli", "mail-access-cli"];
const inside = (root, target) => {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};
const exactIDs = (ids) => Array.isArray(ids) && ids.length > 0 && ids.length <= 32 &&
  new Set(ids).size === ids.length && ids.every((id) => typeof id === "string" &&
    id.length > 0 && id.length <= 2048 && id.trim() === id && !/[\u0000-\u001f\u007f*]/u.test(id));

const sameEntry = (left, right) => left.dev === right.dev && left.ino === right.ino;
const unchangedFile = (left, right) => sameEntry(left, right) && left.size === right.size &&
  left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
const privateDirectory = (info, uid) => info.isDirectory() && info.uid === uid &&
  (info.mode & 0o7777n) === 0o700n;
const privateFile = (info, uid) => info.isFile() && info.uid === uid && info.nlink === 1n &&
  (info.mode & 0o7777n) === 0o600n && info.size >= 1n && info.size <= BigInt(MAX_CONFIG_BYTES);

async function readPrivateConfig(selectedDirectory, resolvedRoot, { openImpl, getUid }) {
  const owner = getUid();
  if (!Number.isInteger(owner) || owner < 0) throw new Error("private owner unavailable");
  const uid = BigInt(owner);
  // Strip trailing separators so lstat/O_NOFOLLOW cannot follow a directory
  // symlink via the trailing slash. System parent aliases such as /tmp remain
  // supported after canonicalization.
  let selectedPath = selectedDirectory;
  while (selectedPath.length > 1 && selectedPath.endsWith(sep)) selectedPath = selectedPath.slice(0, -1);
  const selectedInfo = await lstat(selectedPath, { bigint: true });
  if (!privateDirectory(selectedInfo, uid)) throw new Error("private directory requirements");
  const configDirectory = await realpath(selectedPath);
  const directoryInfo = await lstat(configDirectory, { bigint: true });
  const configPath = join(configDirectory, "config.json");
  const fileInfo = await lstat(configPath, { bigint: true });
  if (!privateDirectory(directoryInfo, uid) || !sameEntry(selectedInfo, directoryInfo) ||
      inside(resolvedRoot, configDirectory) || !privateFile(fileInfo, uid)) {
    throw new Error("private file requirements");
  }

  let directory, file;
  try {
    directory = await openImpl(configDirectory,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_DIRECTORY);
    const openedDirectory = await directory.stat({ bigint: true });
    if (!privateDirectory(openedDirectory, uid) || !sameEntry(directoryInfo, openedDirectory)) {
      throw new Error("private directory changed");
    }
    // O_NONBLOCK prevents a substituted FIFO from hanging open; O_NOFOLLOW
    // rejects a substituted symlink. fstat checks the opened object itself.
    file = await openImpl(configPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const openedFile = await file.stat({ bigint: true });
    if (!privateFile(openedFile, uid) || !unchangedFile(fileInfo, openedFile)) {
      throw new Error("private file changed");
    }
    const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const finalFile = await file.stat({ bigint: true });
    const currentFile = await lstat(configPath, { bigint: true });
    const currentDirectory = await lstat(configDirectory, { bigint: true });
    const currentSelected = await lstat(selectedPath, { bigint: true });
    const finalDirectory = await directory.stat({ bigint: true });
    if (length < 1 || length > MAX_CONFIG_BYTES || !privateFile(finalFile, uid) ||
        !privateFile(currentFile, uid) || !unchangedFile(openedFile, finalFile) ||
        !unchangedFile(openedFile, currentFile) || !privateDirectory(currentDirectory, uid) ||
        !privateDirectory(currentSelected, uid) || !privateDirectory(finalDirectory, uid) ||
        !sameEntry(directoryInfo, currentDirectory) || !sameEntry(directoryInfo, currentSelected) ||
        !sameEntry(directoryInfo, finalDirectory) || await realpath(selectedPath) !== configDirectory) {
      throw new Error("private configuration changed or oversized");
    }
    return { configDirectory, raw: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)) };
  } finally {
    try { if (file) await file.close(); } finally { if (directory) await directory.close(); }
  }
}

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
    if (name === "contacts" && domain.transport !== undefined && !["direct", "companion"].includes(domain.transport)) {
      throw new Error("Invalid Contacts transport; access is denied.");
    }
    if (domain.enabled === true && (!exactIDs(domain.accounts) ||
        !exactIDs(name === "notes" ? domain.folders : domain.items) ||
        (name !== "notes" && domain.mode !== "allowlist"))) {
      throw new Error(`${name} requires exact resource and account allowlists; access is denied.`);
    }
  }
  if (config.mail !== undefined) {
    const mail = config.mail;
    if (!mail || typeof mail !== "object" || Array.isArray(mail) || typeof mail.enabled !== "boolean" ||
        (mail.allowWrites !== undefined && mail.allowWrites !== false)) throw new Error("Invalid read-only Mail configuration.");
    if (mail.enabled) validateMailConfig(config);
  }
  return config;
}

// Validate the host-owned file before loading the server. No directory/file is
// created, no build/install is run, and no privacy grant or store is queried.
export async function preparePluginLaunch({ env = process.env, root = packageRoot,
  openImpl = open, getUid = () => process.geteuid?.() } = {}) {
  const selectedDirectory = env.APPLE_PIM_CONFIG_DIR;
  if (typeof selectedDirectory !== "string" || !isAbsolute(selectedDirectory) ||
      /[\u0000-\u001f\u007f]/u.test(selectedDirectory) || selectedDirectory.includes("${") ||
      selectedDirectory.split(sep).some((part) => part === "." || part === "..")) {
    throw new Error("Set an absolute private APPLE_PIM_CONFIG_DIR; plugin access is denied.");
  }
  if (env.APPLE_PIM_PROFILE) {
    throw new Error("This local plugin uses base configuration only; remove APPLE_PIM_PROFILE.");
  }
  const resolvedRoot = await realpath(root);
  let configDirectory, raw;
  try {
    ({ configDirectory, raw } = await readPrivateConfig(selectedDirectory, resolvedRoot, { openImpl, getUid }));
  } catch {
    throw new Error("Private configuration is missing, unsafe or unreadable. Keep an owner-only 0700 directory and single-link 0600 file owned by the current user outside the plugin, without directory/config symlinks; access is denied.");
  }
  let config;
  try {
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
  return { server, configDirectory, contactsTransport: config.contacts?.transport ?? "direct" };
}

export async function startPlugin() {
  if (process.platform !== "darwin") throw new Error("iCloud MCP Connector requires a local Mac.");
  const { server, configDirectory, contactsTransport } = await preparePluginLaunch();
  process.env.APPLE_PIM_CONFIG_DIR = configDirectory;
  delete process.env.APPLE_PIM_PROFILE; // Empty host variables must not select a profile.
  process.env.APPLE_PIM_CONTACTS_TRANSPORT = contactsTransport;
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
