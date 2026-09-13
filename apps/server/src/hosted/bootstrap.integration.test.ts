import { spawn, execFile, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { requestHostedStop } from "./runtime-control.js";

const require = createRequire(import.meta.url);
const run = promisify(execFile);

async function unusedPorts(): Promise<[number, number]> {
  const servers: Server[] = [];
  try {
    const ports = await Promise.all(
      [0, 1].map(
        () =>
          new Promise<number>((resolve, reject) => {
            const server = createServer();
            servers.push(server);
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
              const address = server.address();
              if (
                !address ||
                typeof address === "string" ||
                address.port <= 1024
              )
                reject(new Error("No test port available"));
              else resolve(address.port);
            });
          }),
      ),
    );
    return [ports[0]!, ports[1]!];
  } finally {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  // tsx starts one Node child: terminate only the process tree rooted at this
  // test's returned PID, never another running Dearvale instance.
  if (process.platform === "win32") {
    await run("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 5000,
    });
  } else {
    process.kill(-child.pid, "SIGTERM");
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Test server did not exit")),
      5000,
    );
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

describe("hosted CLI bootstrap", () => {
  let child: ChildProcess | undefined;
  let directory: string | undefined;
  afterEach(async () => {
    if (child) await stopChild(child);
    if (directory)
      rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
  });

  it.each(["loopback HTTP", "public HTTPS"] as const)(
    "starts isolated %s surfaces and accepts only a matching local graceful-stop request",
    async (mode) => {
      directory = mkdtempSync(join(tmpdir(), "dearvale-hosted-bootstrap-"));
      const web = join(directory, "web");
      mkdirSync(web);
      writeFileSync(
        join(web, "index.html"),
        "<!doctype html><html><body>HOSTED-CLI-SMOKE</body></html>",
      );
      const [publicPort, adminPort] = await unusedPorts();
      const publicAddress = `http://127.0.0.1:${publicPort}`;
      const publicOrigin =
        mode === "public HTTPS"
          ? "https://friends.example:49371"
          : publicAddress;
      const adminOrigin = `http://127.0.0.1:${adminPort}`;
      const environment: NodeJS.ProcessEnv = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (
          /^(path|systemroot|windir|temp|tmp|home|userprofile|appdata|localappdata)$/iu.test(
            key,
          )
        )
          environment[key] = value;
      }
      Object.assign(environment, {
        DEARVALE_HOSTED_ROOT: join(directory, "server"),
        DEARVALE_WEB_DIST: web,
        DEARVALE_HOSTED_PORT: String(publicPort),
        DEARVALE_ADMIN_PORT: String(adminPort),
        DEARVALE_PUBLIC_ORIGIN: publicOrigin,
        LOG_LEVEL: "silent",
      });
      delete environment.DEARVALE_HOSTED_CONFIG;
      child = spawn(
        process.execPath,
        [
          require.resolve("tsx/cli"),
          fileURLToPath(new URL("./bootstrap.ts", import.meta.url)),
        ],
        {
          cwd: directory,
          env: environment,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const processHandle = child;
      await new Promise<void>((resolve, reject) => {
        let output = "";
        const timeout = setTimeout(
          () => reject(new Error(`Hosted CLI did not become ready: ${output}`)),
          20000,
        );
        const failed = (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        };
        processHandle.once("error", failed);
        processHandle.once("exit", (code) =>
          failed(
            new Error(`Hosted CLI exited before ready (${code}): ${output}`),
          ),
        );
        const consume = (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-8000);
          if (output.includes("Dearvale 服务已启动")) {
            clearTimeout(timeout);
            resolve();
          }
        };
        processHandle.stdout?.on("data", consume);
        processHandle.stderr?.on("data", consume);
      });
      // Emulate a TLS-terminating tunnel without DNS or external network access.
      // Both subprocess listeners stay on newly allocated loopback ports, while
      // the application validates the public Host (including its port).
      const request = (origin: string, path: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        if (!headers.has("host")) headers.set("host", new URL(origin).host);
        const address = origin === publicOrigin ? publicAddress : origin;
        return new Promise<Response>((resolve, reject) => {
          // fetch may discard a caller-supplied Host. A real HTTP request models
          // the reverse proxy's wire headers without relying on that behavior.
          const req = httpRequest(
            `${address}${path}`,
            {
              method: init?.method ?? "GET",
              headers: Object.fromEntries(headers),
              signal: AbortSignal.timeout(3000),
            },
            (response) => {
              const chunks: Buffer[] = [];
              const responseHeaders = new Headers();
              for (
                let index = 0;
                index < response.rawHeaders.length;
                index += 2
              )
                responseHeaders.append(
                  response.rawHeaders[index]!,
                  response.rawHeaders[index + 1]!,
                );
              response.on("data", (chunk: Buffer) => chunks.push(chunk));
              response.on("error", reject);
              response.on("end", () =>
                resolve(
                  new Response(Buffer.concat(chunks).toString("utf8"), {
                    status: response.statusCode ?? 500,
                    headers: responseHeaders,
                  }),
                ),
              );
            },
          );
          req.on("error", reject);
          req.end(init?.body);
        });
      };
      for (const [origin, surface, path] of [
        [publicOrigin, "user", "/"],
        [adminOrigin, "admin", "/admin"],
      ] as const) {
        const health = await request(origin, "/api/health");
        expect(health.status).toBe(200);
        expect(await health.json()).toEqual({
          status: "ok",
          deploymentMode: "hosted",
          surface,
        });
        const page = await request(origin, path);
        expect(page.status).toBe(200);
        expect(await page.text()).toContain("HOSTED-CLI-SMOKE");
      }
      for (const origin of [publicOrigin, adminOrigin]) {
        const wrongHost = await request(origin, "/api/health", {
          headers: { host: "untrusted.example:49371" },
        });
        expect(wrongHost.status).toBe(421);
        expect(await wrongHost.json()).toMatchObject({
          error: { code: "invalid_host" },
        });
      }
      if (mode === "public HTTPS") {
        // An internal HTTP hop must not downgrade public cookies or HSTS, or
        // accidentally allow the loopback origin to perform browser mutations.
        const publicInfo = await request(publicOrigin, "/api/hosted/info");
        expect(publicInfo.status).toBe(200);
        expect(publicInfo.headers.get("strict-transport-security")).toBe(
          "max-age=31536000",
        );
        expect(publicInfo.headers.get("cache-control")).toBe("no-store");
        expect(publicInfo.headers.getSetCookie()).toEqual([
          expect.stringMatching(
            /^dearvale_user_csrf=.*; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=86400$/u,
          ),
        ]);
        const wrongOrigin = await request(
          publicOrigin,
          "/api/hosted/auth/login",
          {
            method: "POST",
            headers: {
              origin: publicAddress,
              "content-type": "application/json",
            },
            body: "{}",
          },
        );
        expect(wrongOrigin.status).toBe(403);
        expect(await wrongOrigin.json()).toMatchObject({
          error: { code: "invalid_origin" },
        });
        const publicOriginWithoutCsrf = await request(
          publicOrigin,
          "/api/hosted/auth/login",
          {
            method: "POST",
            headers: {
              origin: publicOrigin,
              "content-type": "application/json",
            },
            body: "{}",
          },
        );
        expect(publicOriginWithoutCsrf.status).toBe(403);
        expect(await publicOriginWithoutCsrf.json()).toMatchObject({
          error: { code: "csrf_invalid" },
        });
        expect((await request(publicOrigin, "/api/hosted/me")).status).toBe(
          401,
        );
      }
      expect(
        (await request(publicOrigin, "/api/hosted/admin/overview")).status,
      ).toBe(404);
      expect((await request(publicOrigin, "/admin")).status).toBe(404);
      const info = await request(adminOrigin, "/api/hosted/info");
      const body = (await info.json()) as {
        csrfToken: string;
        bootstrapRequired: boolean;
      };
      expect(body.bootstrapRequired).toBe(true);
      const csrfCookie = info.headers
        .getSetCookie()
        .map((value) => value.split(";")[0]!)
        .join("; ");
      const bootstrap = await request(
        adminOrigin,
        "/api/hosted/auth/bootstrap",
        {
          method: "POST",
          headers: {
            origin: adminOrigin,
            "content-type": "application/json",
            cookie: csrfCookie,
            "x-csrf-token": body.csrfToken,
          },
          body: JSON.stringify({
            username: "smoke-admin",
            password: "isolated-test-password",
          }),
        },
      );
      expect(bootstrap.status).toBe(200);
      const sessionCookie = bootstrap.headers
        .getSetCookie()
        .map((value) => value.split(";")[0]!)
        .join("; ");
      const headers = { cookie: `${csrfCookie}; ${sessionCookie}` };
      const overview = await request(
        adminOrigin,
        "/api/hosted/admin/overview",
        {
          headers,
        },
      );
      expect(overview.status).toBe(200);
      expect(await overview.json()).toMatchObject({
        limits: { callsEnabled: false },
        calls: { active: 0, queued: 0, activeImages: 0 },
      });
      const models = await request(adminOrigin, "/api/hosted/admin/models", {
        headers,
      });
      expect(models.status).toBe(200);
      expect(await models.json()).toMatchObject({ models: [] });
      const root = join(directory, "server");
      const controlPath = join(root, "runtime-control.json");
      const stopPath = join(root, "stop-request.json");
      const identity = JSON.parse(readFileSync(controlPath, "utf8")) as {
        pid: number;
        bootId: string;
      };
      expect(identity.pid).toBeGreaterThan(0);
      expect(identity.bootId).toMatch(/^[a-f0-9-]{36}$/u);
      for (const invalidRequest of [
        "{",
        "x".repeat(1025),
        JSON.stringify({ bootId: randomUUID() }),
      ]) {
        writeFileSync(stopPath, invalidRequest);
        await expect(requestHostedStop(root, 1000)).rejects.toThrow();
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect((await request(publicOrigin, "/api/health")).status).toBe(200);
        unlinkSync(stopPath);
      }
      // Verify the separate CLI resolves the same configured root without inheriting it.
      const configPath = join(directory, "stop.env");
      writeFileSync(
        configPath,
        `DEARVALE_HOSTED_ROOT="${root.replaceAll("\\", "/")}"\n`,
      );
      const stopEnvironment: NodeJS.ProcessEnv = {
        ...environment,
        DEARVALE_HOSTED_CONFIG: configPath,
      };
      delete stopEnvironment.DEARVALE_HOSTED_ROOT;
      const result = await run(
        process.execPath,
        [
          require.resolve("tsx/cli"),
          fileURLToPath(
            new URL("../../../../scripts/hosted-stop.ts", import.meta.url),
          ),
        ],
        {
          cwd: directory,
          env: stopEnvironment,
          windowsHide: true,
          timeout: 15000,
        },
      );
      expect(result.stdout).toContain("已安全停止");
      expect(result.stderr).toBe("");
      expect(existsSync(controlPath)).toBe(false);
      expect(existsSync(stopPath)).toBe(false);
      expect(existsSync(join(root, "runtime.lock"))).toBe(false);
      await expect(request(publicOrigin, "/api/health")).rejects.toThrow();
    },
    30000,
  );
});
