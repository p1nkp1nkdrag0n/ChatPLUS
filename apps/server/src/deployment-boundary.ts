import { isIP } from "node:net";

export interface LocalDemoNetworkConfig {
  readonly host: string;
  readonly webOrigin: string;
}

/**
 * PersonaSim deliberately has no authentication, authorization or tenant
 * boundary. Keep that product constraint executable so a HOST/WEB_ORIGIN
 * override cannot accidentally turn the local validation Demo into a network
 * service.
 */
export function assertLocalDemoNetworkBoundary(
  config: LocalDemoNetworkConfig,
): void {
  if (!isLoopbackHostname(config.host)) {
    throw new TypeError(
      "HOST must be a loopback address because PersonaSim is an unauthenticated local-only Demo.",
    );
  }

  const origins = config.webOrigin
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  if (
    origins.length === 0 ||
    origins.some((origin) => !isLoopbackOrigin(origin))
  ) {
    throw new TypeError(
      "WEB_ORIGIN must contain only loopback origins because PersonaSim is an unauthenticated local-only Demo.",
    );
  }
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" &&
      parsed.password === "" &&
      isLoopbackHostname(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return normalized.split(".")[0] === "127";
  return ipVersion === 6 && normalized === "::1";
}
