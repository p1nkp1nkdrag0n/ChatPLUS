import { createHash } from "node:crypto";

const INSTANCE_FINGERPRINT_DOMAIN =
  "chatplus-correspondence-instance-fingerprint-v1\0";
const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

/**
 * Decodes the configured instance secret without accepting Base64 aliases.
 * Canonical encoding keeps the secret/fingerprint relationship portable.
 */
export function parseCorrespondenceInstanceSecret(
  value: string | undefined,
): Buffer | undefined {
  if (value === undefined) return undefined;
  try {
    const decoded = decodeCanonicalBase64(value);
    return decoded.length >= 32 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Produces the same irreversible, domain-separated fingerprint used at
 * application startup. The returned digest is safe for backup manifests; the
 * secret itself must be backed up separately by the instance owner.
 */
export function deriveCorrespondenceInstanceSecretFingerprint(
  value: string,
): string {
  const secret = parseCorrespondenceInstanceSecret(value);
  if (secret === undefined) {
    throw new TypeError(
      "INSTANCE_SECRET must be canonical Base64 encoding at least 32 bytes",
    );
  }
  return createHash("sha256")
    .update(INSTANCE_FINGERPRINT_DOMAIN, "utf8")
    .update(secret)
    .digest("hex");
}

function decodeCanonicalBase64(value: string): Buffer {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !CANONICAL_BASE64_PATTERN.test(value)
  ) {
    throw new TypeError("Invalid canonical Base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new TypeError("Invalid canonical Base64");
  }
  return decoded;
}
