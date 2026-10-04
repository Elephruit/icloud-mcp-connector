#!/usr/bin/env node
// Data-free staging only: strip copied debug symbols, then sign and verify.
// No build, installation, launch, registration or grant.
// iCloud MCP Connector derives from Apple PIM, Copyright (c) 2025 Omar Shahine.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, parse, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const APP_NAME = "iCloud MCP Contacts.app";
export const BUNDLE_ID = "com.elephruit.icloud-mcp-connector.contacts";
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runFile = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (root, target) => {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};
const publicWritable = (info) => (info.mode & 0o022) !== 0;

export function validateDataFreeExecutable(bytes) {
  // Reviewed release builds must not embed local debug/build/cache paths.
  // Configuration and job files are never inputs to this builder.
  if (/\/Users\/|\/home\/|\/(?:private\/)?var\/folders\/|\/tmp\/|\/private\/tmp\//u.test(bytes.toString("latin1"))) {
    throw new Error("The native executable embeds a private build/cache path; rebuild with debug information disabled and path remapping.");
  }
}

export function parseBuildArguments(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  if (args.length !== 2 || args[0] !== "--output") {
    throw new Error("Use --output with an explicit absolute path to a new iCloud MCP Contacts.app bundle.");
  }
  return { output: args[1] };
}

// Canonical spelling deliberately refuses symlink parents, including macOS's
// /tmp and /var aliases. Resolve a caller-created private staging directory first.
export async function validateOutputPath(output, { root = packageRoot, uid = process.getuid?.() } = {}) {
  if (typeof output !== "string" || !isAbsolute(output) || normalize(output) !== output ||
      /[\u0000-\u001f\u007f]/u.test(output) || basename(output) !== APP_NAME) {
    throw new Error("Output must be a canonical absolute path ending in iCloud MCP Contacts.app.");
  }
  if (output.split(sep).includes("Applications")) {
    throw new Error("Applications paths are installation destinations; this builder only stages a new bundle.");
  }
  if (!Number.isInteger(uid)) throw new Error("An identifiable local file owner is required.");
  const resolvedRoot = await realpath(root);
  const parent = dirname(output);
  const resolvedParent = await realpath(parent).catch(() => {
    throw new Error("Create an owner-only staging parent first; parent directories are not created automatically.");
  });
  if (resolvedParent !== parent) throw new Error("Symlink parents are refused; use the staging parent's canonical real path.");
  if (inside(resolvedRoot, output)) throw new Error("Stage the bundle outside the public source checkout.");
  const anchors = [...new Set(await Promise.all([
    realpath(dirname(resolvedRoot)), realpath(tmpdir()), realpath("/tmp"),
  ]))];
  const anchor = anchors.filter((path) => inside(path, parent)).sort((a, b) => b.length - a.length)[0];
  if (!anchor) throw new Error("Output must be staged in this checkout's workspace parent or a local temporary directory.");
  let current = parse(parent).root;
  for (const part of parent.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Symlink or non-directory parents are refused.");
    // System temporary roots can be sticky/public; descendants must be owned
    // by this user or root and cannot be writable by another user or group.
    if (inside(anchor, current) && current !== anchor &&
        ((info.uid !== uid && info.uid !== 0) || publicWritable(info))) {
      throw new Error("Staging descendants must be owner-controlled and not publicly writable.");
    }
  }
  const parentInfo = await lstat(parent);
  if (parentInfo.uid !== uid || (parentInfo.mode & 0o077) !== 0) {
    throw new Error("The staging parent must be owned by this user and have owner-only permissions (0700).");
  }
  try {
    await lstat(output);
    throw new Error("The output already exists; existing bundles, directories and symlinks are never replaced.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { output, parent, resolvedRoot };
}

async function reviewedFile(path, root, { executable = false } = {}) {
  const resolved = await realpath(path);
  const info = await lstat(resolved);
  if (!inside(root, resolved) || !info.isFile() || publicWritable(info) ||
      (executable && (info.mode & 0o111) === 0)) {
    throw new Error("A reviewed regular source file inside this checkout is required.");
  }
  return { path: resolved, bytes: await readFile(resolved) };
}

async function checkedCommand(command, args) {
  try {
    return await runFile(command, args, {
      encoding: "utf8", timeout: 30000, maxBuffer: 128 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
    });
  } catch {
    // Tool output can contain private staging paths; keep failures data-free.
    throw new Error(`${basename(command)} validation failed; no installation or launch was attempted.`);
  }
}

export async function buildContactsCompanion({ output, root = packageRoot } = {}) {
  if (process.platform !== "darwin") throw new Error("The Contacts companion can only be staged on macOS.");
  const destination = await validateOutputPath(output, { root });
  const [binary, info, license] = await Promise.all([
    reviewedFile(join(destination.resolvedRoot, "swift", ".build", "release", "contacts-cli"), destination.resolvedRoot, { executable: true }),
    reviewedFile(join(destination.resolvedRoot, "companion", "Info.plist"), destination.resolvedRoot),
    reviewedFile(join(destination.resolvedRoot, "LICENSE"), destination.resolvedRoot),
  ]);
  if (!license.bytes.toString("utf8").includes("Copyright (c) 2025 Omar Shahine")) {
    throw new Error("The upstream MIT copyright notice must be preserved.");
  }
  await checkedCommand("/usr/bin/plutil", ["-lint", info.path]);
  const converted = await checkedCommand("/usr/bin/plutil", ["-convert", "json", "-o", "-", info.path]);
  const manifest = JSON.parse(converted.stdout);
  if (manifest.CFBundleIdentifier !== BUNDLE_ID || manifest.CFBundleExecutable !== "contacts-cli" ||
      manifest.CFBundlePackageType !== "APPL" || !manifest.NSContactsUsageDescription ||
      Object.keys(manifest).some((key) => key.startsWith("NS") && key !== "NSContactsUsageDescription")) {
    throw new Error("The reviewed Contacts-only companion identity and privacy description are required.");
  }
  const architecture = (await checkedCommand("/usr/bin/file", ["-b", binary.path])).stdout.trim();
  if (!architecture.startsWith("Mach-O") || !architecture.includes("executable") || !/\b(arm64|x86_64)\b/u.test(architecture)) {
    throw new Error("The staged executable must be a native macOS arm64 or x86_64 Mach-O binary.");
  }
  // Recheck immediately before exclusive creation. A private, owner-controlled
  // parent prevents other users from exchanging path components during staging.
  await validateOutputPath(output, { root });
  await mkdir(output, { mode: 0o700 });
  const contents = join(output, "Contents");
  const executable = join(contents, "MacOS", "contacts-cli");
  const resources = join(contents, "Resources");
  await mkdir(contents, { mode: 0o700 });
  await mkdir(dirname(executable), { mode: 0o700 });
  await mkdir(resources, { mode: 0o700 });
  await copyFile(binary.path, executable, constants.COPYFILE_EXCL);
  await copyFile(info.path, join(contents, "Info.plist"), constants.COPYFILE_EXCL);
  await copyFile(license.path, join(resources, "LICENSE"), constants.COPYFILE_EXCL);
  await chmod(executable, 0o700);
  await chmod(join(contents, "Info.plist"), 0o600);
  await chmod(join(resources, "LICENSE"), 0o600);
  if (hash(await readFile(executable)) !== hash(binary.bytes) ||
      hash(await readFile(join(contents, "Info.plist"))) !== hash(info.bytes) ||
      hash(await readFile(join(resources, "LICENSE"))) !== hash(license.bytes)) {
    throw new Error("Source files changed during staging; the incomplete new bundle was not launched.");
  }
  // Swift's linker debug symbols can retain local AST/build paths despite
  // disabled compiler debug information and prefix maps. Remove only those
  // symbols from the verified copy; never alter the original build executable.
  await checkedCommand("/usr/bin/strip", ["-S", executable]);
  const strippedBytes = await readFile(executable);
  validateDataFreeExecutable(strippedBytes);
  await writeFile(join(resources, "ATTRIBUTION.txt"),
    "iCloud MCP Connector Contacts companion\n" +
    "Derived from Apple PIM: https://github.com/omarshahine/apple-pim\n" +
    "Copyright (c) 2025 Omar Shahine. MIT license included as LICENSE.\n" +
    "Connector: https://github.com/Elephruit/icloud-mcp-connector\n" +
    "This is a staged, ad-hoc-signed native Contacts executable, not an installed service.\n" +
    "Linker debug symbols are stripped from the staged executable to remove local build paths.\n" +
    "It contains no personal configuration, contact data or job paths.\n" +
    "Ad-hoc signatures bind to executable content; later updates may need a new macOS grant.\n",
    { mode: 0o600, flag: "wx" });
  await writeFile(join(resources, "BUILD.json"), JSON.stringify({
    bundleId: BUNDLE_ID, sourceSHA256: hash(binary.bytes), infoSHA256: hash(info.bytes),
    licenseSHA256: hash(license.bytes), strippedSHA256: hash(strippedBytes),
    debugSymbols: "stripped", signing: "ad-hoc", installed: false,
  }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await checkedCommand("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", output]);
  await checkedCommand("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", output]);
  const entitlements = (await checkedCommand("/usr/bin/codesign", ["--display", "--entitlements", "-", "--xml", output])).stdout.trim();
  if (entitlements && (!/<dict\s*\/>|<dict>\s*<\/dict>/u.test(entitlements) || /<key>/u.test(entitlements))) {
    throw new Error("The staged Contacts companion must not carry entitlements.");
  }
  const signature = (await checkedCommand("/usr/bin/codesign", ["--display", "--verbose=4", output])).stderr;
  const identifier = signature.match(/^Identifier=(.+)$/mu)?.[1];
  const codeDirectoryHash = signature.match(/^CDHash=([a-f0-9]+)$/mu)?.[1];
  if (identifier !== BUNDLE_ID || !/^Signature=adhoc$/mu.test(signature) || !codeDirectoryHash) {
    throw new Error("The staged companion's ad-hoc signature identity could not be verified.");
  }
  const signedBytes = await readFile(executable);
  validateDataFreeExecutable(signedBytes);
  return {
    bundleName: APP_NAME, bundleId: identifier, signing: "ad-hoc", codeDirectoryHash,
    sourceSHA256: hash(binary.bytes), strippedSHA256: hash(strippedBytes),
    signedExecutableSHA256: hash(signedBytes), debugSymbols: "stripped",
    architectures: [...new Set(architecture.match(/\b(arm64|x86_64)\b/gu))],
    minimumMacOS: manifest.LSMinimumSystemVersion,
    installed: false, launched: false, requestedPermissions: false,
    updateGrant: "Ad-hoc signed updates may require a new macOS Contacts grant.",
  };
}

export async function main(args = process.argv.slice(2)) {
  const parsed = parseBuildArguments(args);
  if (parsed.help) {
    console.log("Stage only: node scripts/build-contacts-companion.mjs --output /canonical/private/staging/iCloud\\ MCP\\ Contacts.app\n" +
      "Create a private 0700 parent outside the source checkout first. This does not install, launch, register or request Contacts access.");
    return;
  }
  console.log(JSON.stringify(await buildContactsCompanion(parsed), null, 2));
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error.code ? "File preparation failed; check reviewed inputs and the private staging parent. No installation or launch was attempted." : error.message;
    console.error(`Contacts companion staging: ${message}`);
    process.exitCode = 1;
  });
}
