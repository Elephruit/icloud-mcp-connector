import test from "node:test";
import assert from "node:assert/strict";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { NATIVE_TOOLS, parseNativeStageArguments, stageNativeTools, validateNativeStageOutput } from "../scripts/stage-native-tools.mjs";

async function fixture({ dirtyStrip = false, leakedSignedPath = false, certificateDescription = false,
  extraEntitlement = false, verificationFailure = false, architecture = "Mach-O 64-bit executable arm64", changeInput = false } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "icloud-native-stage-synthetic-")));
  const root = join(base, "source");
  const staging = join(base, "staging");
  const release = join(root, "swift", ".build", "release");
  await mkdir(release, { mode: 0o700, recursive: true });
  await mkdir(staging, { mode: 0o700 });
  for (const name of NATIVE_TOOLS) await writeFile(join(release, name), `synthetic native payload ${name}\n/private/tmp/synthetic/compiler-cache\n`, { mode: 0o700 });
  const license = "MIT License\nCopyright (c) 2025 Omar Shahine\nSynthetic attribution fixture\n";
  await writeFile(join(root, "LICENSE"), license, { mode: 0o600 });
  const output = join(staging, "native-tools");
  const calls = [];
  const commandImpl = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === "/usr/bin/file") {
      if (changeInput && basename(args[1]) === NATIVE_TOOLS[0]) await writeFile(args[1], "changed synthetic executable\n");
      return { stdout: architecture, stderr: "" };
    }
    if (command === "/usr/bin/strip") {
      assert.equal(args[0], "-S");
      if (!dirtyStrip) await writeFile(args[1], `sanitized synthetic executable ${basename(args[1])}\n`);
      return { stdout: "", stderr: "" };
    }
    assert.equal(command, "/usr/bin/codesign", "No installer, launcher, build, certificate, credentials or permission commands are permitted");
    const path = args.at(-1);
    const identifier = `com.elephruit.icloud-mcp-connector.${basename(path)}`;
    if (args.includes("--sign")) {
      assert.equal(args[args.indexOf("--sign") + 1], "-", "Only ad-hoc signing is allowed");
      assert.ok(args.includes("--timestamp=none"));
      assert.equal(args[args.indexOf("--identifier") + 1], identifier);
      await writeFile(path, leakedSignedPath ? "/Users/synthetic/leaked-build-path" : `${await readFile(path, "utf8")}synthetic-signature\n`);
      return { stdout: "", stderr: "" };
    }
    if (args.includes("--verify")) {
      assert.ok(args.includes("--strict"));
      if (verificationFailure) throw new Error("Synthetic strict verification failure");
      return { stdout: "", stderr: "" };
    }
    if (args.includes("--entitlements")) return { stdout: extraEntitlement ? "<dict><key>synthetic.entitlement</key><true/></dict>" : "", stderr: "" };
    assert.ok(args.includes("--display"));
    return { stdout: "", stderr: `Identifier=${identifier}\nCDHash=${"a".repeat(40)}\n${certificateDescription ? "Authority=Synthetic Certificate" : "Signature=adhoc"}\n` };
  };
  return { base, root, staging, release, output, calls, commandImpl, license };
}

test("native staging exposes only a fixed five-tool set and explicit new output", () => {
  assert.deepEqual(NATIVE_TOOLS, ["calendar-cli", "reminder-cli", "contacts-cli", "mail-access-cli", "notes-access-cli"]);
  assert.equal(Object.isFrozen(NATIVE_TOOLS), true);
  assert.deepEqual(parseNativeStageArguments(["--help"]), { help: true });
  assert.deepEqual(parseNativeStageArguments(["--output", "/synthetic/native-tools"]), { output: "/synthetic/native-tools" });
  for (const args of [[], ["--output"], ["--install"], ["--build"], ["--launch"],
    ["--output", "/synthetic/native-tools", "--force"], ["--output", "/synthetic/native-tools", "--signing-identity", "a".repeat(40)]]) {
    assert.throws(() => parseNativeStageArguments(args), /explicit canonical private path/);
  }
});

test("fake native staging strips copies before ad-hoc signing, preserves sources and emits only safe receipts", async () => {
  const f = await fixture();
  const initial = Object.fromEntries(await Promise.all(NATIVE_TOOLS.map(async (name) => [name, await readFile(join(f.release, name))])));
  try {
    const receipt = await stageNativeTools({ ...f, platform: "darwin" });
    assert.deepEqual(Object.keys(receipt.artifacts), NATIVE_TOOLS);
    assert.equal(receipt.signing, "ad-hoc");
    assert.equal(receipt.grantContinuity, "not-guaranteed");
    assert.equal(receipt.installed || receipt.launched || receipt.requestedPermissions || receipt.notarized, false);
    for (const name of NATIVE_TOOLS) {
      assert.deepEqual(await readFile(join(f.release, name)), initial[name]);
      assert.equal((await lstat(join(f.output, name))).mode & 0o777, 0o700);
      for (const key of ["sourceSHA256", "strippedSHA256", "signedSHA256"]) assert.match(receipt.artifacts[name][key], /^[0-9a-f]{64}$/u);
      assert.notEqual(receipt.artifacts[name].sourceSHA256, receipt.artifacts[name].strippedSHA256);
      const operations = f.calls.filter(({ args }) => basename(args.at(-1)) === name).map(({ command, args }) =>
        command === "/usr/bin/strip" ? "strip" : args.includes("--sign") ? "sign" : args.includes("--verify") ? "verify" : "inspect");
      assert.ok(operations.indexOf("strip") < operations.indexOf("sign"));
      assert.ok(operations.indexOf("sign") < operations.indexOf("verify"));
    }
    assert.equal((await lstat(f.output)).mode & 0o777, 0o700);
    for (const name of ["LICENSE", "ATTRIBUTION.txt", "BUILD.json"]) assert.equal((await lstat(join(f.output, name))).mode & 0o777, 0o600);
    assert.equal(await readFile(join(f.output, "LICENSE"), "utf8"), f.license);
    assert.deepEqual(JSON.parse(await readFile(join(f.output, "BUILD.json"), "utf8")), receipt);
    assert.equal(JSON.stringify(receipt).includes(f.base), false);
    assert.equal(JSON.stringify(receipt).includes("/Users/"), false);
    assert.equal(f.calls.some(({ command }) => ["/usr/bin/open", "/usr/bin/security", "/usr/bin/osascript", "/usr/bin/swift"].includes(command)), false);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("private path residue blocks signing and a later signed-path leak also fails", async () => {
  for (const options of [{ dirtyStrip: true }, { leakedSignedPath: true }]) {
    const f = await fixture(options);
    try {
      await assert.rejects(stageNativeTools({ ...f, platform: "darwin" }), /private build\/cache path/);
      if (options.dirtyStrip) assert.equal(f.calls.some(({ args }) => args.includes("--sign")), false);
    } finally { await rm(f.base, { recursive: true, force: true }); }
  }
});

test("native staging rejects entitlements, a certificate signature and strict verification failure", async () => {
  for (const options of [{ extraEntitlement: true }, { certificateDescription: true }, { verificationFailure: true }]) {
    const f = await fixture(options);
    try { await assert.rejects(stageNativeTools({ ...f, platform: "darwin" })); }
    finally { await rm(f.base, { recursive: true, force: true }); }
  }
});

test("architecture failures occur before output creation and input changes cannot be silently packaged", async () => {
  const f = await fixture({ architecture: "synthetic shell script" });
  try {
    await assert.rejects(stageNativeTools({ ...f, platform: "darwin" }), /native macOS executable/);
    await assert.rejects(lstat(f.output), { code: "ENOENT" });
    assert.equal(f.calls.some(({ args }) => args.includes("--sign")), false);
  } finally { await rm(f.base, { recursive: true, force: true }); }
  const changed = await fixture({ changeInput: true });
  try {
    await assert.rejects(stageNativeTools({ ...changed, platform: "darwin" }), /changed while copying/);
    assert.equal(changed.calls.some(({ args }) => args.includes("--sign")), false);
  } finally { await rm(changed.base, { recursive: true, force: true }); }
});

test("staging refuses source, install, cache, noncanonical and nonprivate destinations", async () => {
  const f = await fixture();
  try {
    assert.equal((await validateNativeStageOutput(f.output, { root: f.root })).output, f.output);
    await assert.rejects(validateNativeStageOutput(join(f.root, "native-tools"), { root: f.root }), /outside the public source/);
    for (const part of ["Applications", ".codex", ".local", "cache", "Caches", "plugins", ".build"]) {
      await assert.rejects(validateNativeStageOutput(join(f.base, part, "native-tools"), { root: f.root }), /destinations are refused/);
    }
    for (const path of ["native-tools", join(f.staging, "other"), `${f.staging}/../staging/native-tools`, `${f.staging}\n/native-tools`]) {
      await assert.rejects(validateNativeStageOutput(path, { root: f.root }), /canonical absolute/);
    }
    await chmod(f.staging, 0o750);
    await assert.rejects(validateNativeStageOutput(f.output, { root: f.root }), /private \(0700\)/);
    await chmod(f.staging, 0o700);
    await chmod(f.base, 0o777);
    await assert.rejects(validateNativeStageOutput(f.output, { root: f.root }), /ancestor.*not publicly writable/);
    await chmod(f.base, 0o1777);
    await assert.rejects(validateNativeStageOutput(f.output, { root: f.root }), /ancestor.*not publicly writable/);
  } finally { await chmod(f.base, 0o700); await rm(f.base, { recursive: true, force: true }); }
});

test("existing outputs and symlink paths are never overwritten", async () => {
  const f = await fixture();
  try {
    await writeFile(f.output, "existing protected synthetic bytes");
    await assert.rejects(stageNativeTools({ ...f, platform: "darwin" }), /already exists/);
    assert.equal(await readFile(f.output, "utf8"), "existing protected synthetic bytes");
    await rm(f.output);
    await mkdir(f.output);
    await assert.rejects(validateNativeStageOutput(f.output, { root: f.root }), /already exists/);
    await rm(f.output, { recursive: true });
    await symlink(join(f.base, "missing"), f.output);
    await assert.rejects(validateNativeStageOutput(f.output, { root: f.root }), /already exists/);
    await rm(f.output);
    const alias = join(f.base, "alias");
    await symlink(f.staging, alias);
    await assert.rejects(validateNativeStageOutput(join(alias, "native-tools"), { root: f.root }), /symlink parents/);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("staging rejects another repository or worktree in any output ancestor", async () => {
  const f = await fixture();
  const sibling = join(f.base, "other-repository");
  const parent = join(sibling, "staging");
  const marker = join(sibling, ".git");
  try {
    await mkdir(parent, { mode: 0o700, recursive: true });
    await mkdir(marker, { mode: 0o700 });
    await assert.rejects(validateNativeStageOutput(join(parent, "native-tools"), { root: f.root }), /outside every Git repository or worktree/);
    await rm(marker, { recursive: true });
    await writeFile(marker, "gitdir: /synthetic/worktree-metadata\n", { mode: 0o600 });
    await assert.rejects(stageNativeTools({ ...f, output: join(parent, "native-tools"), platform: "darwin" }), /outside every Git repository or worktree/);
    await assert.rejects(lstat(join(parent, "native-tools")), { code: "ENOENT" });
    assert.equal(f.calls.length, 0);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("individual source symlinks and hard links are refused", async () => {
  for (const makeLink of [symlink, link]) {
    const f = await fixture();
    try {
      const source = join(f.release, NATIVE_TOOLS[0]);
      const alias = join(f.release, "synthetic-original");
      await writeFile(alias, "synthetic native bytes", { mode: 0o700 });
      await rm(source);
      await makeLink(alias, source);
      await assert.rejects(stageNativeTools({ ...f, platform: "darwin" }), /never symlinks or hard links/);
      await assert.rejects(lstat(f.output), { code: "ENOENT" });
    } finally { await rm(f.base, { recursive: true, force: true }); }
  }
});

test("native staging never operates on unsupported platforms", async () => {
  await assert.rejects(stageNativeTools({ platform: "linux" }), /requires macOS/);
});
