import { EventEmitter } from "node:events";
import {
  createServer,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadImageAsset,
  type ImageDownloadNetwork,
} from "./safe-image-download.js";

const publicProvider = "https://images.example.test/v1";
const content = Buffer.from([137, 80, 78, 71]);
function networkResponse(statusCode = 200, body = content) {
  const resolve = vi
    .fn<NonNullable<ImageDownloadNetwork["resolve"]>>()
    .mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  const request = vi.fn<NonNullable<ImageDownloadNetwork["request"]>>(
    (_url, _options, listener) => {
      const response = new PassThrough();
      const incoming = Object.assign(response, {
        statusCode,
        headers: { "content-type": "image/png" },
      }) as unknown as IncomingMessage;
      const outgoing = new EventEmitter() as ClientRequest;
      outgoing.end = vi.fn(() => {
        queueMicrotask(() => {
          listener(incoming);
          response.end(body);
        });
        return outgoing;
      });
      outgoing.destroy = vi.fn(() => {
        response.destroy();
        return outgoing;
      });
      return outgoing;
    },
  );
  return { resolve, request };
}
const options = (
  network: ImageDownloadNetwork,
  providerBaseUrl = publicProvider,
  signal = new AbortController().signal,
) => ({
  providerBaseUrl,
  signal,
  maxBytes: 1024,
  network,
});

afterEach(() => vi.restoreAllMocks());
describe("safe image URL download", () => {
  it.each([
    "127.0.0.1",
    "127.1",
    "2130706433",
    "0x7f000001",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.0.1",
    "169.254.169.254",
    "100.100.100.200",
    "0.0.0.0",
    "[::1]",
    "[::]",
    "[fc00::1]",
    "[fe80::1]",
    "[::ffff:127.0.0.1]",
    "[64:ff9b::7f00:1]",
    "[2002:7f00:1::]",
    "[2001:db8::1]",
    "224.0.0.1",
  ])(
    "rejects restricted literal destination %s before DNS or sockets",
    async (host) => {
      const network = networkResponse();
      await expect(
        downloadImageAsset(`http://${host}/image.png`, options(network)),
      ).rejects.toMatchObject({ code: "image_asset_address_blocked" });
      expect(network.resolve).not.toHaveBeenCalled();
      expect(network.request).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ address: "10.0.0.1", family: 4 }],
    [{ address: "::1", family: 6 }],
    [
      { address: "8.8.8.8", family: 4 },
      { address: "192.168.1.1", family: 4 },
    ],
    [
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "fd00::1", family: 6 },
    ],
  ])(
    "rejects any DNS answer set containing a restricted address",
    async (...addresses) => {
      const network = networkResponse();
      network.resolve.mockResolvedValue(addresses);
      await expect(
        downloadImageAsset(
          "https://assets.example.test/image.png",
          options(network),
        ),
      ).rejects.toMatchObject({ code: "image_asset_address_blocked" });
      expect(network.request).not.toHaveBeenCalled();
    },
  );

  it("does not grant a private-address exception to a public provider hostname", async () => {
    const network = networkResponse();
    network.resolve.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(
      downloadImageAsset(
        "https://images.example.test/image.png",
        options(network),
      ),
    ).rejects.toMatchObject({ code: "image_asset_address_blocked" });
    expect(network.request).not.toHaveBeenCalled();
  });

  it.each([
    "http://127.0.0.1:9000",
    "http://[::1]:9000",
    "http://192.168.1.2:9000",
  ])(
    "allows the same explicitly configured local origin %s",
    async (origin) => {
      const network = networkResponse();
      expect(
        await downloadImageAsset(
          `${origin}/badge.png`,
          options(network, `${origin}/v1`),
        ),
      ).toEqual({ bytes: content, contentType: "image/png" });
      await expect(
        downloadImageAsset(
          `${origin.replace(":9000", ":9001")}/badge.png`,
          options(network, `${origin}/v1`),
        ),
      ).rejects.toMatchObject({ code: "image_asset_address_blocked" });
      expect(network.request).toHaveBeenCalledOnce();
    },
  );

  it("allows localhost only at the configured origin and still resolves and pins it", async () => {
    const network = networkResponse();
    network.resolve.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await downloadImageAsset(
      "http://localhost:9000/image.png",
      options(network, "http://localhost:9000/v1"),
    );
    expect(network.resolve).toHaveBeenCalledWith("localhost");
    await expect(
      downloadImageAsset("http://localhost:9000/image.png", options(network)),
    ).rejects.toMatchObject({ code: "image_asset_address_blocked" });
  });

  it.each([
    { address: "8.8.8.8", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
  ])(
    "downloads public $address and pins every socket lookup without a second DNS query",
    async (pinned) => {
      const network = networkResponse();
      network.resolve
        .mockResolvedValueOnce([pinned])
        .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
      const result = await downloadImageAsset(
        "https://assets.example.test/image.png?token=asset-signature",
        options(network),
      );
      expect(result).toEqual({ bytes: content, contentType: "image/png" });
      const [url, requestOptions] = network.request.mock.calls[0]!;
      expect(url.hostname).toBe("assets.example.test");
      expect(requestOptions).toMatchObject({
        method: "GET",
        agent: false,
        family: pinned.family,
      });
      expect(requestOptions).not.toHaveProperty("headers");
      expect(requestOptions).not.toHaveProperty("rejectUnauthorized");
      const single = vi.fn();
      const all = vi.fn();
      requestOptions.lookup!(
        "assets.example.test",
        { family: pinned.family },
        single,
      );
      requestOptions.lookup!("assets.example.test", { all: true }, all);
      expect(single).toHaveBeenCalledWith(null, pinned.address, pinned.family);
      expect(all).toHaveBeenCalledWith(null, [pinned]);
      expect(network.resolve).toHaveBeenCalledOnce();
    },
  );

  it("rejects redirects without requesting the next target and bounds download bytes", async () => {
    const redirected = networkResponse(302);
    await expect(
      downloadImageAsset(
        "https://assets.example.test/image.png",
        options(redirected),
      ),
    ).rejects.toMatchObject({ code: "image_asset_unavailable" });
    expect(redirected.request).toHaveBeenCalledOnce();
    const oversized = networkResponse(200, Buffer.alloc(1025));
    await expect(
      downloadImageAsset(
        "https://assets.example.test/image.png",
        options(oversized),
      ),
    ).rejects.toMatchObject({ code: "image_response_too_large" });
  });

  it("aborts while resolving without opening a socket", async () => {
    const network = networkResponse();
    network.resolve.mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();
    const result = downloadImageAsset(
      "https://assets.example.test/image.png",
      options(network, publicProvider, controller.signal),
    );
    controller.abort(new Error("cancelled"));
    await expect(result).rejects.toThrow("cancelled");
    expect(network.request).not.toHaveBeenCalled();
  });

  it("uses a real native socket without credentials and handles interrupted or timed-out downloads", async () => {
    const seenHeaders: IncomingMessage["headers"][] = [];
    const server = createServer((request, response) => {
      seenHeaders.push(request.headers);
      if (request.url === "/slow") return;
      if (request.url === "/slow-body" || request.url === "/interrupted") {
        response.writeHead(200, {
          "content-type": "image/webp",
          "content-length": 100,
        });
        response.flushHeaders();
        response.write(content);
        if (request.url === "/interrupted")
          setImmediate(() => response.destroy());
        return;
      }
      response.writeHead(200, { "content-type": "image/webp" }).end(content);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test address");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      expect(
        await downloadImageAsset(`${origin}/image.png`, {
          providerBaseUrl: `${origin}/v1`,
          signal: new AbortController().signal,
          maxBytes: 1024,
        }),
      ).toEqual({ bytes: content, contentType: "image/webp" });
      expect(seenHeaders[0]).not.toHaveProperty("authorization");
      expect(seenHeaders[0]).not.toHaveProperty("x-goog-api-key");
      for (const path of ["/slow", "/slow-body"]) {
        await expect(
          downloadImageAsset(`${origin}${path}`, {
            providerBaseUrl: `${origin}/v1`,
            signal: AbortSignal.timeout(20),
            maxBytes: 1024,
          }),
        ).rejects.toMatchObject({ name: "AbortError" });
      }
      await expect(
        downloadImageAsset(`${origin}/interrupted`, {
          providerBaseUrl: `${origin}/v1`,
          signal: AbortSignal.timeout(1000),
          maxBytes: 1024,
        }),
      ).rejects.toMatchObject({ code: "ECONNRESET" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
