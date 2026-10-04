import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_NAME, BUNDLE_ID, buildContactsCompanion, parseBuildArguments, validateDataFreeExecutable, validateOutputPath } from "../scripts/build-contacts-companion.mjs";

async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), "icloud-contacts-build-synthetic-"));
  const base = await realpath(temporary);
  const root = join(base, "source");
  const staging = join(base, "staging");
  await mkdir(root, { mode: 0o700 });
  await mkdir(staging, { mode: 0o700 });
  return { base, root, staging, output: join(staging, APP_NAME) };
}

test("companion builder has no implicit destination or installation mode", () => {
  assert.deepEqual(parseBuildArguments(["--help"]), { help: true });
  assert.deepEqual(parseBuildArguments(["--output", "/synthetic/iCloud MCP Contacts.app"]), { output: "/synthetic/iCloud MCP Contacts.app" });
  assert.deepEqual(parseBuildArguments(["--output", "/synthetic/iCloud MCP Contacts.app", "--signing-identity", "a".repeat(40)]),
    { output: "/synthetic/iCloud MCP Contacts.app", signingIdentity: "A".repeat(40) });
  for (const args of [[], ["--output"], ["--install"], ["--output", "synthetic", "--force"], ["--sign", "identity"]]) {
    assert.throws(() => parseBuildArguments(args), /explicit absolute path/);
  }
  assert.throws(() => parseBuildArguments(["--output", "/synthetic/iCloud MCP Contacts.app", "--signing-identity", "-"]), /exact 40-digit/);
});

const certificate = "A".repeat(40);

async function syntheticBuilder({ identityAvailable = true, failRequirementVerification = false,
  displayedRequirement, adHocFallback = false, privatePathAfterSigning = false } = {}) {
  const f = await fixture();
  await mkdir(join(f.root, "swift", ".build", "release"), { mode: 0o700, recursive: true });
  await mkdir(join(f.root, "companion"), { mode: 0o700 });
  await writeFile(join(f.root, "swift", ".build", "release", "contacts-cli"), "synthetic executable\n", { mode: 0o700 });
  await writeFile(join(f.root, "companion", "Info.plist"), "synthetic plist\n", { mode: 0o600 });
  await writeFile(join(f.root, "LICENSE"), "Copyright (c) 2025 Omar Shahine\nSynthetic MIT fixture\n", { mode: 0o600 });
  const calls = [];
  let signedWithCertificate = false;
  const commandImpl = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === "/usr/bin/plutil") return { stdout: args.includes("json") ? JSON.stringify({
      CFBundleIdentifier: BUNDLE_ID, CFBundleExecutable: "contacts-cli", CFBundlePackageType: "APPL",
      NSContactsUsageDescription: "Synthetic scope only", LSMinimumSystemVersion: "13.0",
    }) : "", stderr: "" };
    if (command === "/usr/bin/file") return { stdout: "Mach-O 64-bit executable arm64\n", stderr: "" };
    if (command === "/usr/bin/security") return { stdout: identityAvailable ? `  1) ${certificate} "Synthetic Local Certificate"\n` : "0 valid identities found\n", stderr: "" };
    if (command === "/usr/bin/strip") return { stdout: "", stderr: "" };
    assert.equal(command, "/usr/bin/codesign", "No installer, launcher, build, credential or permission command is allowed");
    if (args.includes("--sign")) {
      signedWithCertificate = args[args.indexOf("--sign") + 1] === certificate;
      if (privatePathAfterSigning) await writeFile(join(f.output, "Contents", "MacOS", "contacts-cli"), "/Users/synthetic/private-build-path");
      return { stdout: "", stderr: "" };
    }
    if (args.includes("--verify")) {
      if (failRequirementVerification && args.includes("-R")) throw new Error("Synthetic certificate requirement verification failed");
      return { stdout: "", stderr: "" };
    }
    if (args.includes("--entitlements")) return { stdout: "", stderr: "" };
    if (args.includes("--requirements")) return { stdout: displayedRequirement ?? `designated => identifier "${BUNDLE_ID}" and certificate leaf = H"${certificate}"\n`, stderr: "" };
    assert.ok(args.includes("--display"));
    return { stdout: "", stderr: `Identifier=${BUNDLE_ID}\nCDHash=${"b".repeat(40)}\n${signedWithCertificate && !adHocFallback ? "Authority=Synthetic Local Certificate" : "Signature=adhoc"}\n` };
  };
  return { ...f, calls, commandImpl };
}

test("data-free fake staging defaults to ad-hoc without inspecting Keychain or claiming continuity", async () => {
  const f = await syntheticBuilder();
  try {
    const result = await buildContactsCompanion({ ...f, platform: "darwin" });
    assert.equal(result.signing, "ad-hoc");
    assert.equal(result.permissionAcceptance, "not-tested");
    assert.equal(result.notarized, false);
    assert.equal(result.installed || result.launched || result.requestedPermissions, false);
    assert.equal(f.calls.some(({ command }) => command === "/usr/bin/security"), false);
    assert.equal(f.calls.some(({ args }) => args.includes("-R")), false);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("data-free fake certificate staging verifies actual certificate requirement and preserves private receipts", async () => {
  const f = await syntheticBuilder();
  try {
    const result = await buildContactsCompanion({ ...f, signingIdentity: certificate, platform: "darwin" });
    assert.equal(result.signing, "certificate-pinned");
    assert.equal(result.certificateSHA1, certificate);
    assert.equal(result.installed || result.launched || result.requestedPermissions || result.notarized, false);
    const verification = f.calls.find(({ args }) => args.includes("-R"));
    assert.ok(verification);
    assert.equal(verification.args[verification.args.indexOf("-R") + 1], `=${result.designatedRequirement}`);
    const receiptPath = join(f.output, "Contents", "Resources", "BUILD.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(receipt.signing, "certificate-pinned");
    assert.equal(receipt.designatedRequirement, result.designatedRequirement);
    assert.equal((await lstat(receiptPath)).mode & 0o777, 0o600);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("unavailable selected certificate fails before bundle creation without an ad-hoc fallback", async () => {
  const f = await syntheticBuilder({ identityAvailable: false });
  try {
    await assert.rejects(buildContactsCompanion({ ...f, signingIdentity: certificate, platform: "darwin" }), /unavailable.*No ad-hoc fallback/);
    await assert.rejects(lstat(f.output), { code: "ENOENT" });
    assert.equal(f.calls.some(({ args }) => args.includes("--sign")), false);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("fake signing fails closed on chain-verification failure, downgrade, broad requirement or leaked path", async () => {
  for (const options of [{ failRequirementVerification: true }, { adHocFallback: true },
    { displayedRequirement: `designated => identifier "${BUNDLE_ID}"` }, { privatePathAfterSigning: true }]) {
    const f = await syntheticBuilder(options);
    try {
      await assert.rejects(buildContactsCompanion({ ...f, signingIdentity: certificate, platform: "darwin" }));
      assert.equal(f.calls.some(({ command }) => ["/usr/bin/open", "/usr/bin/osascript", "/usr/bin/xcrun", "/usr/bin/swift"].includes(command)), false);
    } finally { await rm(f.base, { recursive: true, force: true }); }
  }
});

test("private build/cache paths cannot be copied into a staged executable", () => {
  validateDataFreeExecutable(Buffer.from("synthetic executable ContactsCLI/ContactsCLI.swift"));
  for (const path of ["/Users/synthetic/source.swift", "/home/synthetic/source.swift", "/private/var/folders/synthetic/cache", "/var/folders/synthetic/cache", "/tmp/synthetic/cache", "/private/tmp/synthetic/cache"]) {
    assert.throws(() => validateDataFreeExecutable(Buffer.from(`synthetic\u0000${path}\u0000`)), /private build\/cache path/);
  }
});

test("new bundle requires a canonical owner-only staging parent outside source", async () => {
  const f = await fixture();
  try {
    assert.equal((await validateOutputPath(f.output, { root: f.root })).output, f.output);
    await assert.rejects(validateOutputPath(join(f.root, APP_NAME), { root: f.root }), /outside the public source/);
    await assert.rejects(validateOutputPath(join(f.staging, "Other.app"), { root: f.root }), /canonical absolute/);
    await assert.rejects(validateOutputPath("./iCloud MCP Contacts.app", { root: f.root }), /canonical absolute/);
    await assert.rejects(validateOutputPath(`${f.staging}/../staging/${APP_NAME}`, { root: f.root }), /canonical absolute/);
    await assert.rejects(validateOutputPath(`${f.staging}\n/${APP_NAME}`, { root: f.root }), /canonical absolute/);
    await assert.rejects(validateOutputPath(join(f.base, "missing", APP_NAME), { root: f.root }), /parent first/);
    await chmod(f.staging, 0o750);
    await assert.rejects(validateOutputPath(f.output, { root: f.root }), /owner-only/);
    await chmod(f.staging, 0o700);
    await assert.rejects(validateOutputPath(f.output, { root: f.root, uid: process.getuid() + 1 }), /owner-controlled|owner-only/);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("existing bundles, files, dangling symlinks and symlink parents are refused", async () => {
  const f = await fixture();
  try {
    await mkdir(f.output);
    await assert.rejects(validateOutputPath(f.output, { root: f.root }), /already exists/);
    await rm(f.output, { recursive: true });
    await writeFile(f.output, "synthetic");
    await assert.rejects(validateOutputPath(f.output, { root: f.root }), /already exists/);
    await rm(f.output);
    await symlink(join(f.base, "nonexistent"), f.output);
    await assert.rejects(validateOutputPath(f.output, { root: f.root }), /already exists/);
    await rm(f.output);
    const alias = join(f.base, "alias");
    await symlink(f.staging, alias);
    await assert.rejects(validateOutputPath(join(alias, APP_NAME), { root: f.root }), /Symlink parents/);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("installation destinations and publicly writable staging ancestors are refused", async () => {
  const f = await fixture();
  try {
    await assert.rejects(validateOutputPath(join(f.base, "Applications", APP_NAME), { root: f.root }), /installation destinations/);
    await assert.rejects(validateOutputPath(join("/System/Library", APP_NAME), { root: f.root }), /workspace parent|Symlink parents/);
    await chmod(f.staging, 0o777);
    await assert.rejects(validateOutputPath(f.output, { root: f.root }), /not publicly writable/);
    await chmod(f.staging, 0o700);
    const shared = join(f.base, "shared");
    const privateChild = join(shared, "private");
    await mkdir(shared, { mode: 0o700 });
    await chmod(shared, 0o777);
    await mkdir(privateChild, { mode: 0o700 });
    await assert.rejects(validateOutputPath(join(privateChild, APP_NAME), { root: f.root }), /not publicly writable/);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("a private staging child cannot authorize a shared-writable anchor or higher ancestor", async () => {
  const f = await fixture();
  try {
    await chmod(f.base, 0o777);
    await assert.rejects(validateOutputPath(f.output, { root: f.root }), /ancestors.*not publicly writable/);
    // Sticky on an arbitrary workspace anchor is not a verified system-temp exception.
    await chmod(f.base, 0o1777);
    await assert.rejects(validateOutputPath(f.output, { root: f.root }), /ancestors.*not publicly writable/);
    await chmod(f.base, 0o700);
    const parent = join(f.base, "shared-ancestor");
    const source = join(parent, "workspace", "source");
    const staging = join(parent, "workspace", "staging");
    await mkdir(source, { mode: 0o700, recursive: true });
    await mkdir(staging, { mode: 0o700 });
    await chmod(parent, 0o777);
    await assert.rejects(validateOutputPath(join(staging, APP_NAME), { root: source }), /ancestors.*not publicly writable/);
  } finally { await chmod(f.base, 0o700); await rm(f.base, { recursive: true, force: true }); }
});
