#!/usr/bin/env node
// Stage fixed reviewed native copies only. Never build, install, launch, grant,
// inspect personal stores, use a certificate, or change source executables.
// Derived from Apple PIM, Copyright (c) 2025 Omar Shahine; MIT LICENSE retained.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, parse, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { validateDataFreeExecutable } from "./build-contacts-companion.mjs";

export const NATIVE_TOOLS = Object.freeze([
  "calendar-cli", "reminder-cli", "contacts-cli", "mail-access-cli", "notes-access-cli",
]);
export const NATIVE_STAGE_DIRECTORY = "native-tools";
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runFile = promisify(execFile);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (root, path) => {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
};
const sharedWritable = (info) => (info.mode & 0o022) !== 0;

export function parseNativeStageArguments(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  if (args.length !== 2 || args[0] !== "--output") {
    throw new Error("Use --output with an explicit canonical private path to a new native-tools directory; no build, install or certificate-signing modes exist.");
  }
  return { output: args[1] };
}

async function controlledAncestors(path, { uid, temporaryRoots }) {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("Symlink and non-directory path components are refused.");
    }
    const stickyTemporaryRoot = temporaryRoots.includes(current) && info.uid === 0 && (info.mode & 0o1000) !== 0;
    if ((info.uid !== uid && info.uid !== 0) || (sharedWritable(info) && !stickyTemporaryRoot)) {
      throw new Error("Every staging/source ancestor must be owner-controlled and not publicly writable; only canonical root-owned sticky temporary roots are excepted.");
    }
  }
}

async function rejectGitDestinationAncestors(path) {
  for (let current = path; ; current = dirname(current)) {
    try {
      await lstat(join(current, ".git"));
      throw new Error("Stage native tools outside every Git repository or worktree.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (current === parse(current).root) return;
  }
}

export async function validateNativeStageOutput(output, { root = packageRoot, uid = process.getuid?.() } = {}) {
  if (typeof output !== "string" || !isAbsolute(output) || normalize(output) !== output ||
      /[\u0000-\u001f\u007f]/u.test(output) || basename(output) !== NATIVE_STAGE_DIRECTORY) {
    throw new Error("Output must be a canonical absolute path ending in a new native-tools directory.");
  }
  const excluded = new Set(["Applications", ".codex", ".claude", ".config", ".local", ".git", ".build", "node_modules", "cache", "Caches", "plugins"]);
  if (output.split(sep).some((part) => excluded.has(part))) {
    throw new Error("Installation, source/build and plugin/cache destinations are refused; staging only uses a new private folder.");
  }
  if (!Number.isInteger(uid)) throw new Error("An identifiable local owner is required.");
  const resolvedRoot = await realpath(root);
  const parent = dirname(output);
  const resolvedParent = await realpath(parent).catch(() => {
    throw new Error("Create a private staging parent first; parents are never created implicitly.");
  });
  if (resolvedParent !== parent) throw new Error("Use the parent's canonical path; symlink parents are refused.");
  if (inside(resolvedRoot, output)) throw new Error("Stage native tools outside the public source checkout.");
  const temporaryRoots = [...new Set(await Promise.all([realpath(tmpdir()), realpath("/tmp")]))];
  const anchors = [...new Set([await realpath(dirname(resolvedRoot)), ...temporaryRoots])];
  if (!anchors.some((anchor) => inside(anchor, parent))) {
    throw new Error("Stage only in this workspace's parent or a local temporary directory.");
  }
  await controlledAncestors(parent, { uid, temporaryRoots });
  await rejectGitDestinationAncestors(parent);
  await controlledAncestors(resolvedRoot, { uid, temporaryRoots });
  const info = await lstat(parent);
  if (info.uid !== uid || (info.mode & 0o077) !== 0) {
    throw new Error("The staging parent must be owned by this user and private (0700).");
  }
  try {
    await lstat(output);
    throw new Error("Output already exists; files, directories and symlinks are never overwritten.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { output, resolvedRoot, uid, temporaryRoots };
}

async function reviewedSourceFile(path, destination, { executable = false } = {}) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
      (info.uid !== destination.uid && info.uid !== 0) || sharedWritable(info) ||
      (executable && (info.mode & 0o111) === 0)) {
    throw new Error("Reviewed inputs must be controlled regular files, never symlinks or hard links.");
  }
  const resolved = await realpath(path);
  if (resolved !== path || !inside(destination.resolvedRoot, resolved)) {
    throw new Error("Reviewed inputs must remain inside the canonical source checkout.");
  }
  await controlledAncestors(dirname(path), destination);
  return { path, bytes: await readFile(path) };
}

async function checkedNativeCommand(command, args) {
  try {
    return await runFile(command, args, {
      encoding: "utf8", timeout: 30000, maxBuffer: 128 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
    });
  } catch {
    throw new Error(`${basename(command)} staging validation failed; no executable launch, installation or permission request was attempted.`);
  }
}

export async function stageNativeTools({ output, root = packageRoot, platform = process.platform,
  commandImpl = checkedNativeCommand } = {}) {
  if (platform !== "darwin") throw new Error("Native staging requires macOS.");
  const destination = await validateNativeStageOutput(output, { root });
  // SwiftPM's release-directory alias is canonicalized once. Individual source
  // executable symlinks and out-of-checkout targets remain forbidden.
  const releaseDirectory = await realpath(join(destination.resolvedRoot, "swift", ".build", "release"));
  if (!inside(destination.resolvedRoot, releaseDirectory)) throw new Error("Release tools must belong to this checkout.");
  const tools = await Promise.all(NATIVE_TOOLS.map(async (name) => ({ name,
    ...await reviewedSourceFile(join(releaseDirectory, name), destination, { executable: true }),
  })));
  const license = await reviewedSourceFile(join(destination.resolvedRoot, "LICENSE"), destination);
  if (!license.bytes.toString("utf8").includes("Copyright (c) 2025 Omar Shahine")) {
    throw new Error("The upstream MIT copyright and license must be preserved.");
  }
  for (const tool of tools) {
    const architecture = (await commandImpl("/usr/bin/file", ["-b", tool.path])).stdout.trim();
    if (!architecture.startsWith("Mach-O") || !architecture.includes("executable") || !/\b(arm64|x86_64)\b/u.test(architecture)) {
      throw new Error(`The reviewed ${tool.name} input must be a native macOS executable.`);
    }
    tool.architectures = [...new Set(architecture.match(/\b(arm64|x86_64)\b/gu))];
  }
  await validateNativeStageOutput(output, { root });
  await mkdir(output, { mode: 0o700 });
  const artifacts = {};
  for (const tool of tools) {
    const staged = join(output, tool.name);
    await copyFile(tool.path, staged, constants.COPYFILE_EXCL);
    await chmod(staged, 0o700);
    if (sha256(await readFile(staged)) !== sha256(tool.bytes)) {
      throw new Error("A reviewed input changed while copying; the incomplete private stage was not installed or launched.");
    }
    await commandImpl("/usr/bin/strip", ["-S", staged]);
    const stripped = await readFile(staged);
    validateDataFreeExecutable(stripped);
    const identifier = `com.elephruit.icloud-mcp-connector.${tool.name}`;
    await commandImpl("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", "--identifier", identifier, staged]);
    await commandImpl("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", staged]);
    const entitlements = (await commandImpl("/usr/bin/codesign", ["--display", "--entitlements", "-", "--xml", staged])).stdout.trim();
    if (entitlements && (!/<dict\s*\/>|<dict>\s*<\/dict>/u.test(entitlements) || /<key>/u.test(entitlements))) {
      throw new Error("Staged native tools must not carry entitlements.");
    }
    const description = (await commandImpl("/usr/bin/codesign", ["--display", "--verbose=4", staged])).stderr;
    const codeDirectoryHash = description.match(/^CDHash=([a-f0-9]{40})$/mu)?.[1];
    if (!/^Signature=adhoc$/mu.test(description) || description.match(/^Identifier=(.+)$/mu)?.[1] !== identifier || !codeDirectoryHash) {
      throw new Error("The fixed ad-hoc native identity could not be verified.");
    }
    const signed = await readFile(staged);
    validateDataFreeExecutable(signed);
    artifacts[tool.name] = {
      sourceSHA256: sha256(tool.bytes), strippedSHA256: sha256(stripped), signedSHA256: sha256(signed),
      codeDirectoryHash, architectures: tool.architectures,
    };
  }
  await copyFile(license.path, join(output, "LICENSE"), constants.COPYFILE_EXCL);
  await chmod(join(output, "LICENSE"), 0o600);
  if (sha256(await readFile(join(output, "LICENSE"))) !== sha256(license.bytes)) {
    throw new Error("The upstream license changed during staging.");
  }
  await writeFile(join(output, "ATTRIBUTION.txt"),
    "iCloud MCP Connector native tools\n" +
    "Derived from Apple PIM: https://github.com/omarshahine/apple-pim\n" +
    "Copyright (c) 2025 Omar Shahine. MIT LICENSE included.\n" +
    "Connector: https://github.com/Elephruit/icloud-mcp-connector\n" +
    "Only the fixed reviewed release executables and MIT attribution are inputs; no private configuration, PIM records or job files are packaged.\n" +
    "Debug symbols are stripped from copies, then known private build/cache path patterns are rejected before and after signing. This is not a general personal-data detector.\n" +
    "Ad-hoc signatures bind to executable content; they do not promise grant continuity across updates.\n" +
    "Staging does not install, launch tools, request grants, notarize, or establish an assistant connection.\n",
    { mode: 0o600, flag: "wx" });
  const receipt = {
    version: 1, artifacts, licenseSHA256: sha256(license.bytes), signing: "ad-hoc", debugSymbols: "stripped",
    privacyScan: "known-private-build-cache-paths", installed: false, launched: false,
    requestedPermissions: false, notarized: false, grantContinuity: "not-guaranteed",
  };
  await writeFile(join(output, "BUILD.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return receipt;
}

export async function main(args = process.argv.slice(2)) {
  const parsed = parseNativeStageArguments(args);
  if (parsed.help) {
    console.log("Stage only: node scripts/stage-native-tools.mjs --output /canonical/private/staging/native-tools\n" +
      "Use a new output and an existing private 0700 parent outside source, install and cache trees.\n" +
      "Copies five fixed release tools, strips debug symbols and ad-hoc signs/verifies copies. No build, certificate use, installation, launch or grants.");
    return;
  }
  console.log(JSON.stringify(await stageNativeTools(parsed), null, 2));
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error.code ? "Native staging preparation failed; inspect reviewed inputs and the private staging parent. Nothing was installed or launched." : error.message;
    console.error(`Native tools staging: ${message}`);
    process.exitCode = 1;
  });
}
