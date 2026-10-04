import test from "node:test";
import assert from "node:assert/strict";
import { CONTACTS_BUNDLE_ID, companionSigningPlan, normalizeSigningIdentity, signingIdentityAvailable, validateSignatureDescription } from "../scripts/lib/companion-signing.mjs";

const fingerprint = "1234567890ABCDEF".repeat(2) + "12345678";
const output = "/synthetic/iCloud MCP Contacts.app";
const signature = (certificate = true) => `Identifier=${CONTACTS_BUNDLE_ID}\nCDHash=${"a".repeat(40)}\n${certificate ? "Authority=Synthetic Local Certificate" : "Signature=adhoc"}\n`;

test("certificate selection accepts only an explicit fingerprint, never a name or pseudo-identity", () => {
  assert.equal(normalizeSigningIdentity(undefined), undefined);
  assert.equal(normalizeSigningIdentity(fingerprint.toLowerCase()), fingerprint);
  for (const value of [null, 42, "", "-", "Apple Development: Synthetic", "a".repeat(39), "a".repeat(41),
    ` ${fingerprint}`, `${fingerprint}\n`, `${fingerprint};command`]) {
    assert.throws(() => normalizeSigningIdentity(value), /exact 40-digit/);
  }
});

test("identity availability uses only exact valid-identity metadata rows", () => {
  const metadata = `  1) ${fingerprint.toLowerCase()} "Synthetic Local Certificate"\n     1 valid identities found\n`;
  assert.equal(signingIdentityAvailable(metadata, fingerprint), true);
  for (const value of [null, "0 valid identities found", `unavailable ${fingerprint}`,
    `  1) ${"b".repeat(40)} "Different synthetic identity"`]) {
    assert.equal(signingIdentityAvailable(value, fingerprint), false);
  }
});

test("default plan remains honestly ad-hoc and never searches for or uses a certificate", () => {
  const plan = companionSigningPlan(output);
  assert.equal(plan.signing, "ad-hoc");
  assert.equal(plan.certificateSHA1, undefined);
  assert.equal(plan.designatedRequirement, undefined);
  assert.deepEqual(plan.signArguments, ["--force", "--sign", "-", "--timestamp=none", output]);
  assert.match(plan.updateGrant, /may require a new/);
});

test("certificate plan fixes bundle and leaf identity independently of executable contents", () => {
  const plan = companionSigningPlan(output, fingerprint);
  assert.equal(plan.signing, "certificate-pinned");
  assert.equal(plan.certificateSHA1, fingerprint);
  assert.match(plan.designatedRequirement, /identifier "com\.elephruit\.icloud-mcp-connector\.contacts" and certificate leaf = H"[A-F0-9]{40}"/);
  assert.equal(plan.designatedRequirement.includes("cdhash"), false);
  assert.equal(companionSigningPlan("/different/new/build.app", fingerprint).designatedRequirement, plan.designatedRequirement);
  assert.equal(plan.signArguments[plan.signArguments.indexOf("--requirements") + 1], `=designated => ${plan.designatedRequirement}`);
  assert.deepEqual(plan.verifyArguments, ["--verify", "--strict", "--verbose=2", "-R", `=${plan.designatedRequirement}`, output]);
  assert.match(plan.updateGrant, /Certificate replacement or expiry requires review/);
  assert.match(plan.updateGrant, /still needs live acceptance/);
});

test("signature diagnostics reject mode downgrade, wrong bundle identity and missing hashes", () => {
  const adhoc = companionSigningPlan(output);
  const certificate = companionSigningPlan(output, fingerprint);
  assert.equal(validateSignatureDescription(signature(false), "", adhoc).identifier, CONTACTS_BUNDLE_ID);
  assert.throws(() => validateSignatureDescription(signature(), "", adhoc), /explicitly selected ad-hoc/);
  assert.throws(() => validateSignatureDescription(signature(false), certificate.designatedRequirement, certificate), /no ad-hoc fallback/);
  assert.throws(() => validateSignatureDescription(signature().replace(CONTACTS_BUNDLE_ID, "com.example.other"), certificate.designatedRequirement, certificate), /fixed bundle identity/);
  assert.throws(() => validateSignatureDescription(signature().replace(/^CDHash=.+\n/mu, ""), certificate.designatedRequirement, certificate), /fixed bundle identity/);
});

test("displayed designated requirement must exactly match fixed identifier and chosen certificate", () => {
  const plan = companionSigningPlan(output, fingerprint);
  for (const text of [plan.designatedRequirement, `# designated => ${plan.designatedRequirement}\n`,
    plan.designatedRequirement.replace("leaf", "0").replace(fingerprint, fingerprint.toLowerCase())]) {
    assert.equal(validateSignatureDescription(signature(), text, plan).codeDirectoryHash, "a".repeat(40));
  }
  for (const text of ["", `cdhash H"${"a".repeat(40)}"`, plan.designatedRequirement.replace(fingerprint, "b".repeat(40)),
    `${plan.designatedRequirement} or true`, `${plan.designatedRequirement}\nhost => true`,
    plan.designatedRequirement.replace(CONTACTS_BUNDLE_ID, "com.example.other")]) {
    assert.throws(() => validateSignatureDescription(signature(), text, plan), /exact certificate requirement/);
  }
});
