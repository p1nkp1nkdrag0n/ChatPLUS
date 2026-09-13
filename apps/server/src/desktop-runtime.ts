import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import type { PersonaSimApp } from "./app.js";

export interface DesktopRuntimeOptions {
  dataDirectory: string;
  webDistPath: string;
  migrationsPath: string;
  sessionToken: string;
}

export function readDesktopRuntimeOptions(
  environment: NodeJS.ProcessEnv = process.env,
): DesktopRuntimeOptions {
  const path = (key: string): string => {
    const value = environment[key];
    if (!value || !isAbsolute(value)) {
      throw new TypeError(`${key} must be an absolute path.`);
    }
    return resolve(value);
  };
  const sessionToken = environment.DEARVALE_DESKTOP_TOKEN;
  if (!sessionToken || !/^[a-f0-9]{64}$/u.test(sessionToken)) {
    throw new TypeError(
      "DEARVALE_DESKTOP_TOKEN must be a 32-byte hexadecimal token.",
    );
  }
  return {
    dataDirectory: path("DEARVALE_DATA_DIR"),
    webDistPath: path("DEARVALE_WEB_DIST"),
    migrationsPath: path("PERSONASIM_MIGRATIONS_PATH"),
    sessionToken,
  };
}

export function readOrCreateDesktopInstanceSecret(
  dataDirectory: string,
): string {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const secretPath = join(dataDirectory, "instance-secret");
  try {
    writeFileSync(secretPath, randomBytes(32).toString("hex"), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "EEXIST"
    )) {
      throw error;
    }
  }
  const stat = lstatSync(secretPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new TypeError("The desktop instance secret must be a regular file.");
  }
  const secret = readFileSync(secretPath, "utf8").trim();
  if (!/^[a-f0-9]{64}$/u.test(secret)) {
    // Never replace damaged key material: that would make existing letters unreadable.
    throw new TypeError("The desktop instance secret is invalid.");
  }
  return secret;
}

export async function startDesktopRuntime(
  options: DesktopRuntimeOptions,
): Promise<{ app: PersonaSimApp; url: string }> {
  // These imports must run after the environment guard, also when bundled.
  process.env.PERSONASIM_LOAD_ENV = "false";
  process.env.PERSONASIM_MIGRATIONS_PATH = options.migrationsPath;
  const { buildApp } = await import("./app.js");
  const { readConfig } = await import("./config.js");
  const config = readConfig({
    nodeEnv: "production",
    profile: "desktop",
    host: "127.0.0.1",
    port: 0,
    webOrigin: "http://127.0.0.1",
    selfHostedReverseProxy: false,
    serveWeb: true,
    webDistPath: options.webDistPath,
    databasePath: join(options.dataDirectory, "persona-sim.sqlite"),
    assetStoragePath: join(options.dataDirectory, "assets"),
    instanceSecret: readOrCreateDesktopInstanceSecret(options.dataDirectory),
    developerRoutes: false,
    clockMode: "system",
  });
  const app = await buildApp({
    config,
    startScheduler: true,
    desktopSessionToken: options.sessionToken,
  });
  try {
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    return { app, url };
  } catch (error) {
    await app.close();
    throw error;
  }
}
