import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// These compiled CLI calls all terminate at the configuration/deletion guard,
// before checking grants or requesting records. Notes status is never executed.
const binDir = fileURLToPath(new URL("../swift/.build/release/", import.meta.url));
const domains = [
  ["calendar-cli", "calendars", ["list"]],
  ["reminder-cli", "reminders", ["lists"]],
  ["contacts-cli", "contacts", ["containers"]],
];

function expectDenied(cli, args, configDir, profile) {
  const result = spawnSync(join(binDir, cli), args, {
    env: { PATH: process.env.PATH, LANG: "en_US.UTF-8", APPLE_PIM_CONFIG_DIR: configDir, ...(profile !== undefined ? { APPLE_PIM_PROFILE: profile } : {}) },
    encoding: "utf8", timeout: 5000,
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.equal(result.signal, null);
  assert.match(result.stderr + result.stdout, /access denied|access requires enabled allowlist|disabled|explicit|Malformed config|not found|Invalid profile/i);
}

test("calendar compiled write gate denies every mutation before authorization or data access", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "apple-pim-write-synthetic-"));
  try {
    await writeFile(join(configDir, "config.json"), JSON.stringify({ calendars: {
      enabled: true, mode: "allowlist", items: ["synthetic-calendar"], accounts: ["synthetic-account"],
      allow_deletes: true, allow_writes: false,
    } }));
    for (const args of [
      ["create", "--title", "Synthetic", "--start", "2030-02-04T09:15:00-06:00"],
      ["update", "--id", "synthetic-record", "--title", "Synthetic"],
      ["delete", "--id", "synthetic-record"],
      ["batch-create", "--json", '[{"title":"Synthetic","start":"2030-02-04T09:15:00-06:00"}]'],
    ]) {
      const result = spawnSync(join(binDir, "calendar-cli"), args, {
        env: { PATH: process.env.PATH, LANG: "en_US.UTF-8", APPLE_PIM_CONFIG_DIR: configDir },
        encoding: "utf8", timeout: 5000,
      });
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr + result.stdout, /Calendar writes are disabled/);
    }
  } finally { await rm(configDir, { recursive: true, force: true }); }
});

for (const [cli, domain, message, mutations] of [
  ["contacts-cli", "contacts", /Contacts writes are disabled/, [
    ["create", "--container", "synthetic-container", "--first-name", "Synthetic"],
    ["update", "--id", "synthetic-record", "--nickname", "Synthetic updated"],
    ["delete", "--id", "synthetic-record"],
  ]],
  ["reminder-cli", "reminders", /Reminder writes are disabled/, [
    ["create", "--list", "synthetic-list", "--title", "Synthetic"],
    ["update", "--id", "synthetic-record", "--title", "Synthetic updated"],
    ["complete", "--id", "synthetic-record"],
    ["complete", "--id", "synthetic-record", "--undo"],
    ["delete", "--id", "synthetic-record"],
    ["batch-create", "--json", '[{"title":"Synthetic","list":"synthetic-list"}]'],
    ["batch-complete", "--json", '["synthetic-record"]'],
    ["batch-complete", "--json", '["synthetic-record"]', "--undo"],
    ["batch-delete", "--json", '["synthetic-record"]'],
    ["repair-dates", "--apply"],
    ["repair-dates", "--apply", "--completed"],
  ]],
]) {
  test(`${cli} compiled write gate denies every mutation before authorization or data access`, async () => {
    const configDir = await mkdtemp(join(tmpdir(), "apple-pim-write-synthetic-"));
    try {
      const item = domain === "contacts" ? "synthetic-container" : "synthetic-list";
      const account = domain === "contacts" ? item : "synthetic-account";
      await writeFile(join(configDir, "config.json"), JSON.stringify({ [domain]: {
        enabled: true, mode: "allowlist", items: [item], accounts: [account],
        // Allow deletion so deletion commands must reach the separate write gate.
        allow_deletes: true, allow_writes: false,
      } }));
      for (const args of mutations) {
        const result = spawnSync(join(binDir, cli), args, {
          env: { PATH: process.env.PATH, LANG: "en_US.UTF-8", APPLE_PIM_CONFIG_DIR: configDir },
          encoding: "utf8", timeout: 5000,
        });
        assert.ifError(result.error);
        assert.notEqual(result.status, 0, `${cli} ${args[0]} unexpectedly succeeded`);
        assert.equal(result.signal, null, `${cli} ${args[0]} did not terminate normally`);
        assert.match(result.stderr + result.stdout, message, `${cli} ${args[0]} did not stop at the write gate`);
      }
    } finally { await rm(configDir, { recursive: true, force: true }); }
  });
}

for (const [cli, domain, readArgs] of domains) {
  test(`${cli} compiled guard denies missing, malformed and broad configuration before data access`, async () => {
    const configDir = await mkdtemp(join(tmpdir(), "apple-pim-native-synthetic-"));
    try {
      expectDenied(cli, readArgs, configDir);
      await writeFile(join(configDir, "config.json"), "{");
      expectDenied(cli, readArgs, configDir);
      await writeFile(join(configDir, "config.json"), JSON.stringify({ [domain]: { enabled: true, mode: "all", items: ["synthetic-item"], accounts: ["synthetic-account"] } }));
      expectDenied(cli, readArgs, configDir);
    } finally { await rm(configDir, { recursive: true, force: true }); }
  });

  test(`${cli} compiled deletion guard rejects an ID without fetching it`, async () => {
    const configDir = await mkdtemp(join(tmpdir(), "apple-pim-delete-synthetic-"));
    try {
      const ids = domain === "contacts" ? ["synthetic-container"] : ["synthetic-item"];
      const accounts = domain === "contacts" ? ids : ["synthetic-account"];
      await writeFile(join(configDir, "config.json"), JSON.stringify({ [domain]: { enabled: true, mode: "allowlist", items: ids, accounts } }));
      expectDenied(cli, ["delete", "--id", "synthetic-record"], configDir);
      expectDenied(cli, readArgs, configDir, "missing-profile");
      expectDenied(cli, readArgs, configDir, "../invalid-profile");
    } finally { await rm(configDir, { recursive: true, force: true }); }
  });
}
