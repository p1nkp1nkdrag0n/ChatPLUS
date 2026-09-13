import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as requestHttp,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { isIP } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

const hopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function isPrivateIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [first, second = 0] = address.split(".").map(Number);
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

export function chooseMobileHost(
  requested?: string,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string {
  const candidates = Object.entries(interfaces)
    .flatMap(([name, addresses]) =>
      (addresses ?? [])
        .filter((entry) => !entry.internal && isPrivateIpv4(entry.address))
        .map((entry) => ({ name, address: entry.address })),
    )
    .sort(
      (a, b) =>
        Number(/vethernet|docker|wsl|virtual|vmware|tailscale/iu.test(a.name)) -
        Number(/vethernet|docker|wsl|virtual|vmware|tailscale/iu.test(b.name)),
    );
  if (requested === "127.0.0.1") return requested;
  if (requested !== undefined) {
    if (candidates.some((candidate) => candidate.address === requested)) {
      return requested;
    }
    throw new Error(
      "--host 必须是本机已分配的私有 IPv4 地址，或用于电脑测试的 127.0.0.1。",
    );
  }
  const candidate = candidates[0];
  if (candidate === undefined) {
    throw new Error(
      "未找到局域网 IPv4 地址。请先连接 Wi-Fi / 有线网络，或使用 --host 127.0.0.1 在电脑测试。",
    );
  }
  return candidate.address;
}

function stripHopHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const blocked = new Set(hopHeaders);
  for (const token of headers.connection?.split(",") ?? []) {
    blocked.add(token.trim().toLowerCase());
  }
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !blocked.has(name)),
  );
}

/** An explicitly launched LAN entry point. The application stays on loopback. */
export function createMobileGateway(options: {
  backendPort: number;
  password: string;
  host: string;
}): Server {
  if (options.password.length < 20) {
    throw new TypeError("Mobile gateway requires a random session password.");
  }
  if (!isPrivateIpv4(options.host) && options.host !== "127.0.0.1") {
    throw new TypeError("Mobile gateway must bind a private IPv4 address.");
  }
  const expected = Buffer.from(
    `Basic ${Buffer.from(`mobile:${options.password}`, "utf8").toString("base64")}`,
  );
  const server = createServer((incoming, outgoing) => {
    outgoing.setHeader("Cache-Control", "no-store");
    outgoing.setHeader("X-Content-Type-Options", "nosniff");
    const address = server.address();
    const port =
      typeof address === "object" && address !== null ? address.port : 0;
    const expectedHost = `${options.host}:${port}`;
    const expectedOrigin = `http://${expectedHost}`;
    // Pin Host to the bound interface: this endpoint must not become a target
    // for DNS rebinding or cross-site requests with cached browser credentials.
    if (
      incoming.headers.host !== expectedHost ||
      (incoming.headers.origin !== undefined &&
        incoming.headers.origin !== expectedOrigin) ||
      incoming.headers["sec-fetch-site"] === "cross-site"
    ) {
      outgoing.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      outgoing.end("This mobile connection only accepts same-origin requests.");
      return;
    }
    const authorization = Buffer.from(incoming.headers.authorization ?? "");
    if (
      authorization.length !== expected.length ||
      !timingSafeEqual(authorization, expected)
    ) {
      outgoing.writeHead(401, {
        "WWW-Authenticate": 'Basic realm="Dearvale", charset="UTF-8"',
        "Content-Type": "text/plain; charset=utf-8",
      });
      outgoing.end("请输入本次启动显示的用户名和连接密码。");
      return;
    }
    const path = incoming.url ?? "/";
    if (!path.startsWith("/") || path.startsWith("//")) {
      outgoing.writeHead(400);
      outgoing.end("Invalid request target.");
      return;
    }
    const headers = stripHopHeaders(incoming.headers);
    for (const name of Object.keys(headers)) {
      if (
        name === "authorization" ||
        name === "cookie" ||
        name === "forwarded" ||
        name.startsWith("x-forwarded-")
      ) {
        delete headers[name];
      }
    }
    headers.host = `127.0.0.1:${options.backendPort}`;
    // Native WebView, browser fetch, uploads, and SSE all use the same proxy.
    // Pipe without buffering so generated replies arrive incrementally.
    const upstream = requestHttp({
      hostname: "127.0.0.1",
      port: options.backendPort,
      method: incoming.method,
      path,
      headers,
    });
    upstream.once("response", (response) => {
      const responseHeaders = stripHopHeaders(response.headers);
      delete responseHeaders["set-cookie"];
      // A browser shared with somebody else must re-authenticate after restart.
      responseHeaders["cache-control"] = "no-store";
      responseHeaders["x-content-type-options"] = "nosniff";
      outgoing.writeHead(response.statusCode ?? 502, responseHeaders);
      outgoing.flushHeaders();
      response.once("error", () => outgoing.destroy());
      response.pipe(outgoing);
    });
    upstream.once("error", () => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(502, {
          "Content-Type": "text/plain; charset=utf-8",
        });
        outgoing.end("电脑服务暂时不可用，请检查运行窗口。");
      } else {
        outgoing.destroy();
      }
    });
    incoming.once("aborted", () => upstream.destroy());
    incoming.once("error", () => upstream.destroy());
    outgoing.once("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 120_000;
  // Responses can contain long-lived EventSource streams.
  server.timeout = 0;
  return server;
}
