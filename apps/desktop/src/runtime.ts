import { join } from "node:path";

export const APP_URL = "dearvale://app/welcome";

export function isAppUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "dearvale:" &&
      url.host === "app" &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function isExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

// Avoid importing a developer's project profile, model keys or Node loader flags.
export function serverEnvironment(
  inherited: NodeJS.ProcessEnv,
  runtimeDirectory: string,
  dataDirectory: string,
  token: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const allowed =
    /^(PATH|SystemRoot|WINDIR|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_ALL|HTTP_PROXY|HTTPS_PROXY|NO_PROXY)$/i;
  for (const [name, value] of Object.entries(inherited)) {
    if (allowed.test(name) && value !== undefined) environment[name] = value;
  }
  return {
    ...environment,
    NODE_ENV: "production",
    PERSONASIM_LOAD_ENV: "false",
    DEARVALE_DATA_DIR: dataDirectory,
    DEARVALE_WEB_DIST: join(runtimeDirectory, "web"),
    DEARVALE_DESKTOP_TOKEN: token,
    PERSONASIM_MIGRATIONS_PATH: join(runtimeDirectory, "server", "migrations"),
  };
}

export function readReadyUrl(message: unknown): string | undefined {
  if (
    !message ||
    typeof message !== "object" ||
    !("type" in message) ||
    message.type !== "ready" ||
    !("url" in message) ||
    typeof message.url !== "string"
  )
    return undefined;
  try {
    const url = new URL(message.url);
    if (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    )
      return url.origin;
  } catch {
    /* Ignore malformed IPC messages. */
  }
  return undefined;
}
