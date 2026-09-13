import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { get } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

describe("desktop backend process", () => {
  const children: ChildProcess[] = [];
  const directories: string[] = [];
  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await new Promise<void>((resolve) =>
          child.once("exit", () => resolve()),
        );
      }
    }
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  async function launch(directory: string) {
    const token = randomBytes(32).toString("hex");
    const dist = join(directory, "web");
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(
      join(dist, "index.html"),
      "<!doctype html><html><body>DEARVALE-DESKTOP</body></html>",
    );
    writeFileSync(join(dist, "assets", "app.js"), "export {};");
    const environment: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (
        /^(path|systemroot|windir|temp|tmp|home|userprofile|appdata|localappdata)$/iu.test(
          key,
        )
      ) {
        environment[key] = value;
      }
    }
    Object.assign(environment, {
      DEARVALE_DATA_DIR: join(directory, "data"),
      DEARVALE_WEB_DIST: dist,
      DEARVALE_DESKTOP_TOKEN: token,
      PERSONASIM_MIGRATIONS_PATH: fileURLToPath(
        new URL("./db/migrations", import.meta.url),
      ),
      LOG_LEVEL: "silent",
      // The bootstrap itself must disable dotenv before loading config.
    });
    const child = fork(
      fileURLToPath(new URL("./desktop-bootstrap.ts", import.meta.url)),
      {
        execArgv: ["--import", "tsx"],
        env: environment,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    children.push(child);
    let output = "";
    child.stderr?.on("data", (data: Buffer) => {
      output += data.toString();
    });
    child.stdout?.resume();
    const exit = new Promise<number | null>((resolve) =>
      child.once("exit", resolve),
    );
    const url = await new Promise<string>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(new Error(`Desktop exited before ready (${code}): ${output}`)),
      );
      child.on("message", (message: unknown) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "ready" &&
          "url" in message &&
          typeof message.url === "string"
        ) {
          resolve(message.url);
        }
      });
    });
    return { child, exit, url, headers: { "x-dearvale-desktop-token": token } };
  }

  it("starts isolated with IPC, protects local content, persists data, and exits with its parent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dearvale-desktop-"));
    directories.push(directory);
    const first = await launch(directory);
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/u);
    const health = await fetch(`${first.url}/api/health`, {
      headers: first.headers,
    });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      profile: "desktop",
      llmProvider: "fixture",
      clockMode: "system",
    });
    for (const path of [
      "/welcome",
      "/assets/app.js",
      "/api/health",
      "/api/agents/unknown/events",
    ]) {
      expect((await fetch(`${first.url}${path}`)).status).toBe(401);
    }
    const page = await fetch(`${first.url}/welcome`, {
      headers: { ...first.headers, accept: "text/html", origin: first.url },
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("DEARVALE-DESKTOP");
    for (const extra of [
      { origin: "https://example.com" },
      { origin: "null" },
      { "sec-fetch-site": "cross-site" },
    ]) {
      expect(
        (
          await fetch(`${first.url}/api/health`, {
            headers: { ...first.headers, ...extra },
          })
        ).status,
        JSON.stringify(extra),
      ).toBe(403);
    }
    const wrongHostStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        get(
          `${first.url}/api/health`,
          {
            headers: { ...first.headers, host: "attacker.example" },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        ).once("error", reject);
      },
    );
    expect(wrongHostStatus).toBe(403);
    expect(
      (
        await fetch(`${first.url}/api/developer/status`, {
          headers: first.headers,
        })
      ).status,
    ).toBe(404);
    expect(existsSync(join(directory, "data", "persona-sim.sqlite"))).toBe(
      true,
    );
    const secret = readFileSync(
      join(directory, "data", "instance-secret"),
      "utf8",
    );
    first.child.send({ type: "shutdown" });
    expect(await first.exit).toBe(0);

    const second = await launch(directory);
    expect(
      readFileSync(join(directory, "data", "instance-secret"), "utf8"),
    ).toBe(secret);
    expect(
      (await fetch(`${second.url}/api/health`, { headers: first.headers }))
        .status,
    ).toBe(401);
    second.child.disconnect();
    expect(await second.exit).toBe(0);
  }, 60_000);
});
