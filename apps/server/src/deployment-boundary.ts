import { isIP } from "node:net";

export interface LocalDemoNetworkConfig {
  readonly host: string;
  readonly webOrigin: string;
  readonly nodeEnv?: "development" | "test" | "production";
  readonly selfHostedReverseProxy?: boolean;
}

/**
 * PersonaSim deliberately has no in-process authentication, authorization or
 * tenant boundary. Keep that constraint executable so HOST/WEB_ORIGIN cannot
 * accidentally expose it. The sole non-loopback exception is an explicit
 * production container boundary whose port is reachable only through the
 * authenticated HTTPS reverse proxy documented by the self-hosted profile.
 */
export function assertLocalDemoNetworkBoundary(
  config: LocalDemoNetworkConfig,
): void {
  if (config.selfHostedReverseProxy === true) {
    assertAuthenticatedReverseProxyBoundary(config);
    return;
  }
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

function assertAuthenticatedReverseProxyBoundary(
  config: LocalDemoNetworkConfig,
): void {
  if (config.nodeEnv !== "production") {
    throw new TypeError(
      "SELFHOSTED_REVERSE_PROXY may only be enabled in production.",
    );
  }
  const host = config.host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  if (host !== "0.0.0.0" && host !== "::") {
    throw new TypeError(
      "SELFHOSTED_REVERSE_PROXY requires HOST=0.0.0.0 (or ::) inside the private container network.",
    );
  }
  const origins = config.webOrigin
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  if (
    origins.length === 0 ||
    origins.some((origin) => !isHttpsOrigin(origin))
  ) {
    throw new TypeError(
      "SELFHOSTED_REVERSE_PROXY requires WEB_ORIGIN to contain only HTTPS origins.",
    );
  }
}

function isHttpsOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.hostname.length > 0
    );
  } catch {
    return false;
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
