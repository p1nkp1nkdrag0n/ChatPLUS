import {
  createServer,
  request as requestHttp,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import type { NetworkInterfaceInfo } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  chooseMobileHost,
  createMobileGateway,
} from "../../../scripts/mobile-gateway.js";

const password = "test-session-password-not-for-deployment";
const authorization = `Basic ${Buffer.from(`mobile:${password}`).toString("base64")}`;
const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No port");
  return address.port;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("mobile LAN gateway", () => {
  it("requires authentication, rejects cross-site access, and keeps credentials outside the backend", async () => {
    const requests: {
      headers: IncomingHttpHeaders;
      body: string;
      url: string;
    }[] = [];
    const backendPort = await listen(
      createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          requests.push({
            headers: request.headers,
            body,
            url: request.url ?? "",
          });
          response.writeHead(201, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ saved: true }));
        });
      }),
    );
    const port = await listen(
      createMobileGateway({ host: "127.0.0.1", backendPort, password }),
    );
    const origin = `http://127.0.0.1:${port}`;
    for (const auth of [
      undefined,
      "Basic invalid",
      `${authorization}invalid`,
    ]) {
      const response = await fetch(`${origin}/api/health`, {
        headers: auth === undefined ? {} : { authorization: auth },
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toContain(
        'Basic realm="Dearvale"',
      );
      await response.text();
    }
    for (const headers of [
      { origin: "http://malicious.example" },
      { host: `malicious.example:${port}` },
      { "sec-fetch-site": "cross-site" },
    ]) {
      // Fetch can normalize forbidden browser headers such as Host. Use the
      // real HTTP transport so this probe tests the gateway's exact boundary.
      const status = await new Promise<number | undefined>(
        (resolve, reject) => {
          const request = requestHttp(
            `${origin}/api/settings`,
            {
              method: "POST",
              headers: { authorization, ...headers },
            },
            (response) => {
              response.resume();
              response.on("end", () => resolve(response.statusCode));
            },
          );
          request.on("error", reject);
          request.end("must-not-reach-server");
        },
      );
      expect(status).toBe(403);
    }
    expect(requests).toHaveLength(0);
    const response = await fetch(`${origin}/api/messages?thread=one`, {
      method: "POST",
      headers: {
        authorization,
        origin,
        cookie: "secret=session",
        "x-forwarded-for": "1.2.3.4",
        "content-type": "application/json",
      },
      body: '{"message":"你好"}',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ saved: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "/api/messages?thread=one",
      body: '{"message":"你好"}',
    });
    expect(requests[0]?.headers.authorization).toBeUndefined();
    expect(requests[0]?.headers.cookie).toBeUndefined();
    expect(requests[0]?.headers["x-forwarded-for"]).toBeUndefined();
    expect(requests[0]?.headers.host).toBe(`127.0.0.1:${backendPort}`);
  });

  it("streams SSE immediately and releases the upstream when the phone disconnects", async () => {
    let upstreamClosed = false;
    let endUpstream: (() => void) | undefined;
    const backendPort = await listen(
      createServer((request, response) => {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        response.write('data: {"message":"first"}\n\n');
        endUpstream = () => response.end();
        request.on("close", () => {
          upstreamClosed = true;
        });
      }),
    );
    const port = await listen(
      createMobileGateway({ host: "127.0.0.1", backendPort, password }),
    );
    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${port}/api/agents/one/events`,
      {
        headers: { authorization },
        signal: controller.signal,
      },
    );
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain('"first"');
    expect(upstreamClosed).toBe(false);
    controller.abort();
    await expect.poll(() => upstreamClosed).toBe(true);
    endUpstream?.();
  });

  it("returns a non-sensitive error when the backend is unavailable", async () => {
    const backend = createServer();
    const backendPort = await listen(backend);
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    const port = await listen(
      createMobileGateway({ host: "127.0.0.1", backendPort, password }),
    );
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { authorization },
    });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(password);
  });

  it("selects assigned private network addresses and refuses public or wildcard binding", () => {
    const entry = (address: string): NetworkInterfaceInfo => ({
      address,
      netmask: "255.255.255.0",
      family: "IPv4",
      mac: "00:00:00:00:00:00",
      internal: false,
      cidr: `${address}/24`,
    });
    const interfaces = {
      "vEthernet (WSL)": [entry("172.21.16.1")],
      "Wi-Fi": [entry("192.168.1.18")],
      Public: [entry("203.0.113.2")],
    };
    expect(chooseMobileHost(undefined, interfaces)).toBe("192.168.1.18");
    expect(chooseMobileHost("172.21.16.1", interfaces)).toBe("172.21.16.1");
    for (const host of ["0.0.0.0", "203.0.113.2", "192.168.1.99"]) {
      expect(() => chooseMobileHost(host, interfaces)).toThrow();
    }
    expect(() => chooseMobileHost(undefined, {})).toThrow();
    expect(() =>
      createMobileGateway({ host: "0.0.0.0", backendPort: 3001, password }),
    ).toThrow();
  });
});
