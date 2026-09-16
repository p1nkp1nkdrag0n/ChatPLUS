import { isIP } from "node:net";

/** Only opt in to forwarding metadata from explicitly configured proxy peers.
 * A loopback socket alone does not prove that a tunnel sanitizes client headers. */
export function parseHostedTrustedProxies(
  value: string | undefined,
): false | string[] {
  if (value === undefined || value.trim() === "") return false;
  const entries = value.split(",").map((entry) => entry.trim());
  for (const entry of entries) {
    const [address, prefix, extra] = entry.split("/");
    const version = isIP(address ?? "");
    if (
      !version ||
      address!.includes("%") ||
      extra !== undefined ||
      (prefix !== undefined &&
        (!/^[1-9]\d*$/u.test(prefix) ||
          Number(prefix) > (version === 4 ? 32 : 128)))
    )
      throw new Error(
        "DEARVALE_HOSTED_TRUSTED_PROXIES must contain only comma-separated IP addresses or CIDR ranges with a nonzero prefix.",
      );
  }
  return [...new Set(entries)];
}
