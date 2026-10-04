// Pure signing policy for a manually staged Contacts companion. No commands,
// Keychain access, certificate creation, installation, launch or permissions.
export const CONTACTS_BUNDLE_ID = "com.elephruit.icloud-mcp-connector.contacts";

export function normalizeSigningIdentity(identity) {
  if (identity === undefined) return undefined;
  if (typeof identity !== "string" || !/^[a-fA-F0-9]{40}$/u.test(identity)) {
    throw new Error("Signing requires an exact 40-digit certificate SHA-1 fingerprint; names and ad-hoc pseudo-identities are refused.");
  }
  return identity.toUpperCase();
}

export function signingIdentityAvailable(metadata, identity) {
  const expected = normalizeSigningIdentity(identity);
  if (!expected || typeof metadata !== "string") return false;
  return metadata.split(/\r?\n/u).some((line) =>
    line.match(/^\s*\d+\)\s+([a-fA-F0-9]{40})\s+"/u)?.[1]?.toUpperCase() === expected);
}

export function companionSigningPlan(output, identity) {
  const fingerprint = normalizeSigningIdentity(identity);
  if (!fingerprint) return {
    signing: "ad-hoc",
    signArguments: ["--force", "--sign", "-", "--timestamp=none", output],
    verifyArguments: ["--verify", "--strict", "--verbose=2", output],
    updateGrant: "Ad-hoc signed updates may require a new macOS Contacts grant.",
  };
  // Pin the exact chosen certificate independently of executable contents.
  // Certificate replacement deliberately changes identity; this is local build
  // continuity, not a claim of Developer ID distribution or TCC acceptance.
  const requirement = `identifier "${CONTACTS_BUNDLE_ID}" and certificate leaf = H"${fingerprint}"`;
  return {
    signing: "certificate-pinned",
    certificateSHA1: fingerprint,
    designatedRequirement: requirement,
    signArguments: ["--force", "--sign", fingerprint, "--timestamp=none", "--identifier", CONTACTS_BUNDLE_ID,
      "--requirements", `=designated => ${requirement}`, output],
    // This evaluates the real certificate chain. Displayed requirement text
    // alone is controlled by the signer and cannot establish certificate trust.
    verifyArguments: ["--verify", "--strict", "--verbose=2", "-R", `=${requirement}`, output],
    updateGrant: "The same bundle ID and certificate provide a content-independent local identity. Certificate replacement or expiry requires review; macOS grant continuity still needs live acceptance.",
  };
}

export function validateSignatureDescription(signature, requirementText, plan) {
  if (typeof signature !== "string") throw new Error("The staged companion signature could not be inspected.");
  const identifier = signature.match(/^Identifier=(.+)$/mu)?.[1];
  const codeDirectoryHash = signature.match(/^CDHash=([a-f0-9]{40})$/mu)?.[1];
  const adhoc = /^Signature=adhoc$/mu.test(signature);
  if (identifier !== CONTACTS_BUNDLE_ID || !codeDirectoryHash) {
    throw new Error("The staged companion's fixed bundle identity could not be verified.");
  }
  if (plan.signing === "ad-hoc") {
    if (!adhoc) throw new Error("The staged companion was not signed in the explicitly selected ad-hoc mode.");
  } else {
    if (adhoc || !/^Authority=.+$/mu.test(signature)) {
      throw new Error("The staged companion requires the explicitly selected certificate signature; no ad-hoc fallback is allowed.");
    }
    const displayed = typeof requirementText === "string"
      ? requirementText.trim().replace(/^#?\s*designated\s*=>\s*/u, "").replace(/\s+/gu, " ") : "";
    const escapedID = CONTACTS_BUNDLE_ID.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const matched = displayed.match(new RegExp(`^identifier "${escapedID}" and certificate (?:leaf|0) = H"([a-fA-F0-9]{40})"$`, "u"));
    if (!matched || matched[1].toUpperCase() !== plan.certificateSHA1) {
      throw new Error("The staged companion must advertise only the fixed bundle ID and exact certificate requirement.");
    }
  }
  return { identifier, codeDirectoryHash };
}
