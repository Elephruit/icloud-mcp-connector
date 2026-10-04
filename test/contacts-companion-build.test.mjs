import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_NAME, parseBuildArguments, validateDataFreeExecutable, validateOutputPath } from "../scripts/build-contacts-companion.mjs";

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
  for (const args of [[], ["--output"], ["--install"], ["--output", "synthetic", "--force"], ["--sign", "identity"]]) {
    assert.throws(() => parseBuildArguments(args), /explicit absolute path/);
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
