import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../mcp-server/node_modules/esbuild/lib/main.js";
import { buildRoot, bundleOptions, collectProofNotices, formatProofNotices } from "../mcp-server/build.mjs";

test("generated notices cover every package contributing code to the actual proof bundle", async () => {
  const result = await build({ ...bundleOptions, entryPoints: ["connection-proof-server.js"], metafile: true, write: false });
  const output = result.metafile.outputs["dist/connection-proof-server.js"];
  const emittedDependencies = new Map();
  for (const [input, contribution] of Object.entries(output.inputs)) {
    if (contribution.bytesInOutput <= 0 || !input.includes("node_modules/")) continue;
    // Independently locate installed metadata by walking to its package identity.
    let directory = resolve(buildRoot, input.substring(0, input.lastIndexOf("/")));
    while (directory !== buildRoot) {
      let pkg;
      try { pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (pkg?.name && pkg?.version) {
        emittedDependencies.set(`${pkg.name}@${pkg.version}`, directory);
        break;
      }
      directory = resolve(directory, "..");
    }
  }
  assert.ok(emittedDependencies.size > 0);
  const records = await collectProofNotices(result.metafile);
  assert.deepEqual(records.map((record) => record.id).sort(), [...emittedDependencies.keys()].sort());
  const committed = await readFile(join(buildRoot, "dist", "connection-proof-NOTICES.txt"), "utf8");
  assert.equal(committed, formatProofNotices(records));
  for (const { id, license, texts } of records) {
    assert.ok(committed.includes(`${id} (${license})`));
    for (const { text } of texts) assert.ok(committed.includes(text.trimEnd()));
  }
  const built = result.outputFiles.find((file) => file.path.endsWith("/connection-proof-server.js"));
  assert.deepEqual(await readFile(join(buildRoot, "dist", "connection-proof-server.js")), Buffer.from(built.contents));
});

async function syntheticDependency() {
  const root = await mkdtemp(join(tmpdir(), "icloud-proof-license-synthetic-"));
  const directory = join(root, "node_modules", "synthetic-dependency");
  await mkdir(directory, { recursive: true });
  const pkg = { name: "synthetic-dependency", version: "1.0.0", license: "MIT" };
  await writeFile(join(directory, "package.json"), JSON.stringify(pkg));
  const license = await readFile(join(buildRoot, "node_modules", "@modelcontextprotocol", "sdk", "LICENSE"), "utf8");
  await writeFile(join(directory, "LICENSE"), license);
  const metafile = { outputs: { "dist/connection-proof-server.js": { inputs: {
    "connection-proof-server.js": { bytesInOutput: 10 },
    "node_modules/synthetic-dependency/index.js": { bytesInOutput: 10 },
  } } } };
  return { root, directory, pkg, metafile };
}

test("license generation fails closed for missing files or ambiguous declarations", async () => {
  const f = await syntheticDependency();
  try {
    await rm(join(f.directory, "LICENSE"));
    await assert.rejects(collectProofNotices(f.metafile, { root: f.root }), /Missing or ambiguous.*file/);
    await writeFile(join(f.directory, "LICENSE"), "synthetic incomplete license");
    await assert.rejects(collectProofNotices(f.metafile, { root: f.root }), /does not match/);
    for (const license of [undefined, { type: "MIT" }, "MIT OR ISC", "unreviewed-license"]) {
      await writeFile(join(f.directory, "package.json"), JSON.stringify({ ...f.pkg, license }));
      await assert.rejects(collectProofNotices(f.metafile, { root: f.root }), /Missing, ambiguous or unreviewed/);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("additional copyright notices are retained and conflicting license files are refused", async () => {
  const f = await syntheticDependency();
  try {
    const notice = "Copyright (c) 2026 Synthetic packaging fixture\nAdditional synthetic notice.\n";
    await writeFile(join(f.directory, "NOTICE"), notice);
    const records = await collectProofNotices(f.metafile, { root: f.root });
    assert.equal(records.length, 1);
    assert.ok(formatProofNotices(records).includes(notice.trimEnd()));
    await writeFile(join(f.directory, "LICENSE.other"), "synthetic alternate license");
    await assert.rejects(collectProofNotices(f.metafile, { root: f.root }), /Missing or ambiguous.*file/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
