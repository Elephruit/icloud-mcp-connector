import { build } from "esbuild";
import { builtinModules } from "module";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const buildRoot = dirname(fileURLToPath(import.meta.url));
export const bundleOptions = {
  absWorkingDir: buildRoot,
  entryPoints: ["server.js", "connection-proof-server.js"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outdir: "dist",
  // Externalize ALL Node built-ins so CJS deps (mailparser, mailsplit)
  // don't hit "Dynamic require of 'stream' is not supported" errors.
  external: builtinModules.flatMap((m) => [m, `node:${m}`]),
  banner: {
    // Provide a real require() for CJS dependencies bundled into ESM.
    // Use a unique identifier so we don't collide with source-level `import { createRequire }` statements
    // (esbuild treats the banner as opaque text and can't dedupe against real imports).
    js: `import { createRequire as __esbuildBannerCreateRequire } from "module"; const require = __esbuildBannerCreateRequire(import.meta.url);`,
  },
};

const licensePhrases = {
  MIT: ["Permission is hereby granted, free of charge", "THE SOFTWARE IS PROVIDED"],
  "BSD-3-Clause": ["Redistribution and use in source and binary forms", "may not be used to endorse or promote", "THIS SOFTWARE IS PROVIDED"],
  ISC: ["Permission to use, copy, modify, and/or distribute", "THE SOFTWARE IS PROVIDED"],
};
const inside = (root, target) => {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

// Derive the package root from each actual emitted dependency input, including
// nested node_modules and scoped names; no maintained dependency list is used.
export async function collectProofNotices(metafile, { root = buildRoot } = {}) {
  const outputs = Object.entries(metafile.outputs).filter(([path]) => path.endsWith("/connection-proof-server.js"));
  if (outputs.length !== 1) throw new Error("Expected exactly one synthetic proof bundle in the build metadata.");
  const packageRoots = new Set();
  for (const [path, contribution] of Object.entries(outputs[0][1].inputs)) {
    if (contribution.bytesInOutput <= 0) continue;
    const parts = path.replaceAll("\\", "/").split("/");
    const index = parts.lastIndexOf("node_modules");
    if (index < 0) continue;
    const length = parts[index + 1]?.startsWith("@") ? index + 3 : index + 2;
    const packageRoot = resolve(root, parts.slice(0, length).join("/"));
    if (!inside(resolve(root, ".."), packageRoot)) throw new Error("Bundled dependency metadata must stay inside the reviewed checkout.");
    packageRoots.add(packageRoot);
  }
  if (packageRoots.size === 0) throw new Error("No bundled dependency inputs were found for the proof server.");
  const records = new Map();
  for (const packageRoot of packageRoots) {
    const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    if (typeof pkg.name !== "string" || typeof pkg.version !== "string" ||
        !/^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/u.test(pkg.name) ||
        !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/u.test(pkg.version)) {
      throw new Error("Bundled dependency package identity is missing or ambiguous.");
    }
    const id = `${pkg.name}@${pkg.version}`;
    if (typeof pkg.license !== "string" || !Object.hasOwn(licensePhrases, pkg.license)) {
      throw new Error(`Missing, ambiguous or unreviewed bundled license: ${id}.`);
    }
    const files = (await readdir(packageRoot)).sort();
    const licenses = files.filter((name) => /^(?:licen[cs]e|copying)(?:[.-].*)?$/iu.test(name));
    if (licenses.length !== 1) throw new Error(`Missing or ambiguous bundled license file: ${id}.`);
    const notices = files.filter((name) => /^notice(?:[.-].*)?$/iu.test(name));
    const texts = [];
    for (const filename of [...licenses, ...notices]) {
      const path = join(packageRoot, filename);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > 256 * 1024) {
        throw new Error(`Invalid bundled license/notice file: ${id}.`);
      }
      texts.push({ filename, text: await readFile(path, "utf8") });
    }
    const normalizedLicense = texts[0].text.replace(/\s+/gu, " ").toLowerCase();
    if (!/copyright/iu.test(normalizedLicense) ||
        licensePhrases[pkg.license].some((phrase) => !normalizedLicense.includes(phrase.toLowerCase()))) {
      throw new Error(`Bundled license text does not match its reviewed declaration: ${id}.`);
    }
    const record = { id, license: pkg.license, texts };
    if (records.has(id) && JSON.stringify(records.get(id)) !== JSON.stringify(record)) {
      throw new Error(`Conflicting bundled license copies: ${id}.`);
    }
    records.set(id, record);
  }
  return [...records.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function formatProofNotices(records) {
  return "Third-party notices for the synthetic connection-proof MCP server\n" +
    "Generated from dependencies contributing code to this bundle's esbuild input graph.\n" +
    "The connector's own MIT license and upstream attribution accompany the package separately.\n\n" +
    records.map(({ id, license, texts }) =>
      `==================== ${id} (${license}) ====================\n` +
      texts.map(({ filename, text }) => `--- ${filename} ---\n${text.trimEnd()}\n`).join("\n")
    ).join("\n");
}

async function main() {
  // Validate license coverage before replacing any distributable artifact.
  // Metafile generation does not change JavaScript bundle bytes or semantics.
  const result = await build({ ...bundleOptions, metafile: true, write: false });
  const records = await collectProofNotices(result.metafile);
  const notices = formatProofNotices(records);
  await mkdir(join(buildRoot, "dist"), { recursive: true });
  for (const file of result.outputFiles) await writeFile(file.path, file.contents);
  await writeFile(join(buildRoot, "dist", "connection-proof-NOTICES.txt"), notices);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
