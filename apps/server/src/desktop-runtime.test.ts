import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readDesktopRuntimeOptions,
  readOrCreateDesktopInstanceSecret,
} from "./desktop-runtime.js";

describe("desktop instance configuration", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires explicit absolute data and build paths plus a session token", () => {
    const environment = {
      DEARVALE_DATA_DIR: resolve("desktop-data"),
      DEARVALE_WEB_DIST: resolve("desktop-web"),
      PERSONASIM_MIGRATIONS_PATH: resolve("desktop-migrations"),
      DEARVALE_DESKTOP_TOKEN: "a".repeat(64),
    };
    expect(readDesktopRuntimeOptions(environment)).toEqual({
      dataDirectory: environment.DEARVALE_DATA_DIR,
      webDistPath: environment.DEARVALE_WEB_DIST,
      migrationsPath: environment.PERSONASIM_MIGRATIONS_PATH,
      sessionToken: environment.DEARVALE_DESKTOP_TOKEN,
    });
    for (const key of [
      "DEARVALE_DATA_DIR",
      "DEARVALE_WEB_DIST",
      "PERSONASIM_MIGRATIONS_PATH",
    ]) {
      expect(() =>
        readDesktopRuntimeOptions({ ...environment, [key]: "relative/path" }),
      ).toThrow(/absolute path/u);
    }
    expect(() =>
      readDesktopRuntimeOptions({
        ...environment,
        DEARVALE_DESKTOP_TOKEN: "short",
      }),
    ).toThrow(/32-byte/u);
  });

  it("preserves the instance encryption secret and refuses to replace a damaged key", () => {
    const directory = mkdtempSync(join(tmpdir(), "dearvale-secret-"));
    directories.push(directory);
    const first = readOrCreateDesktopInstanceSecret(directory);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(readOrCreateDesktopInstanceSecret(directory)).toBe(first);
    const path = join(directory, "instance-secret");
    writeFileSync(path, "damaged key");
    expect(() => readOrCreateDesktopInstanceSecret(directory)).toThrow(
      /invalid/u,
    );
    expect(readFileSync(path, "utf8")).toBe("damaged key");
  });
});
