import { describe, expect, it } from "vitest";
import {
  APP_URL,
  isAppUrl,
  isExternalUrl,
  readReadyUrl,
  serverEnvironment,
} from "./runtime";

describe("desktop process and navigation boundary", () => {
  it("only trusts the stable app origin and HTTP(S) external links", () => {
    expect(isAppUrl(APP_URL)).toBe(true);
    expect(isAppUrl("dearvale://app/characters/one/chat")).toBe(true);
    for (const url of [
      "dearvale://app.evil/welcome",
      "dearvale://user@app/welcome",
      "https://app/welcome",
      "file:///C:/Windows/test",
      "javascript:alert(1)",
      "invalid",
    ])
      expect(isAppUrl(url)).toBe(false);
    expect(isExternalUrl("https://example.com")).toBe(true);
    for (const url of [
      "file:///secret",
      "javascript:alert(1)",
      "dearvale://app/welcome",
      "https://user:password@example.com",
    ])
      expect(isExternalUrl(url)).toBe(false);
  });

  it("never carries developer model secrets or Node injection flags into the local service", () => {
    const environment = serverEnvironment(
      {
        Path: "system-path",
        SystemRoot: "windows",
        LLM_API_KEY: "secret",
        DATABASE_PATH: "live.sqlite",
        NODE_OPTIONS: "--require malicious.cjs",
        NODE_ENV: "test",
        PERSONASIM_PROFILE: "test",
        DEARVALE_WEB_DIST: "wrong",
      },
      "C:/runtime",
      "C:/data",
      "session-token",
    );
    expect(environment).toMatchObject({
      Path: "system-path",
      SystemRoot: "windows",
      NODE_ENV: "production",
      PERSONASIM_LOAD_ENV: "false",
      DEARVALE_DATA_DIR: "C:/data",
      DEARVALE_DESKTOP_TOKEN: "session-token",
    });
    for (const key of [
      "LLM_API_KEY",
      "DATABASE_PATH",
      "NODE_OPTIONS",
      "PERSONASIM_PROFILE",
    ])
      expect(environment).not.toHaveProperty(key);
    expect(environment["DEARVALE_WEB_DIST"]).toMatch(/runtime[/\\]web$/);
  });

  it("accepts readiness only for the loopback server origin", () => {
    expect(readReadyUrl({ type: "ready", url: "http://127.0.0.1:34567" })).toBe(
      "http://127.0.0.1:34567",
    );
    for (const url of [
      "https://example.com:443",
      "http://localhost:3001",
      "http://127.0.0.1:3001/api",
      "http://user@127.0.0.1:3001",
      "http://127.0.0.1:3001/?token=secret",
      "http://127.0.0.1",
    ])
      expect(readReadyUrl({ type: "ready", url })).toBeUndefined();
    expect(readReadyUrl(null)).toBeUndefined();
    expect(
      readReadyUrl({ type: "error", url: "http://127.0.0.1:3001" }),
    ).toBeUndefined();
  });
});
