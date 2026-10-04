#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertMailSendSender, assertPrivateMailSendDirectory, loadMailSendContext, readPrivateMailSendJSON } from "../lib/scoped-mail-send-config.js";
import { validateMailSendPreview } from "../lib/scoped-mail-send-payload.js";
import { createMailSendStore, MAIL_SEND_APPROVAL_MAX_BYTES } from "../lib/scoped-mail-send-store.js";

export function parseArmMailSendCLI(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--preview-file" || typeof argv[1] !== "string" || !isAbsolute(argv[1]) || /[\u0000-\u001f\u007f]/u.test(argv[1])) throw new Error("Manual arming requires exactly --preview-file with an absolute private preview path");
  return { previewPath: argv[1] };
}

/** Manual TTY interaction gate; this module is never imported by MCP dispatch.
 * It assumes the local owner is trusted; a PTY cannot prove human identity.
 */
export async function armMailSendInteractively({ previewPath, env = process.env, input = process.stdin, output = process.stdout } = {}) {
  if (input?.isTTY !== true || output?.isTTY !== true) throw new Error("Mail send approval requires an interactive local owner TTY; MCP arming is unavailable");
  await assertPrivateMailSendDirectory(dirname(previewPath));
  const preview = validateMailSendPreview(await readPrivateMailSendJSON(previewPath, MAIL_SEND_APPROVAL_MAX_BYTES));
  const context = await loadMailSendContext(env);
  assertMailSendSender(preview.payload, context.sendConfig, { requireEnabled: true });
  output.write("Review the exact account, From, To, Cc, Bcc, subject and body below. Native dispatch remains blocked pending account-routing proof.\n");
  output.write(JSON.stringify(preview.payload, null, 2) + "\n");
  output.write("Digest: " + preview.digest + "\n");
  const prompt = createInterface({ input, output, terminal: true });
  let answer;
  try { answer = await prompt.question("Type SEND " + preview.digest + " to arm only this payload for ten minutes: "); }
  finally { prompt.close(); }
  if (answer !== "SEND " + preview.digest) throw new Error("Mail send approval was not armed");
  // Recheck current policy after the owner's exact-payload confirmation.
  const latest = await loadMailSendContext(env);
  if (latest.configDirectory !== context.configDirectory) throw new Error("Mail send state directory changed during confirmation");
  assertMailSendSender(preview.payload, latest.sendConfig, { requireEnabled: true });
  const store = await createMailSendStore({ configDirectory: context.configDirectory, initialize: true });
  return store.arm(preview);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await armMailSendInteractively(parseArmMailSendCLI(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({ success: true, ...result }) + "\n");
  } catch {
    process.stderr.write("Mail send approval was not armed; verify the private preview, host configuration and exact interactive confirmation locally.\n");
    process.exitCode = 1;
  }
}
