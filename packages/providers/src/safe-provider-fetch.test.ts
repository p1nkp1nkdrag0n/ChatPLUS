import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSafeProviderFetch,
  validatePublicProviderUrl,
  type ProviderFetchNetwork,
} from "./safe-provider-fetch.js";

const endpoint = "https://provider.example.test/v1/chat/completions";

function networkResponse(
  config: {
    status?: number;
    headers?: IncomingMessage["headers"];
    body?: Buffer;
    stall?: boolean;
  } = {},
) {
  const resolve = vi
    .fn<NonNullable<ProviderFetchNetwork["resolve"]>>()
    .mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  const responses: PassThrough[] = [];
  const requests: {
    end: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }[] = [];
  const request = vi.fn<NonNullable<ProviderFetchNetwork["request"]>>(
    (_url, _options, listener) => {
      const response = new PassThrough();
      responses.push(response);
      const incoming = Object.assign(response, {
        statusCode: config.status ?? 200,
        headers: config.headers ?? { "content-type": "application/json" },
      }) as unknown as IncomingMessage;
      const outgoing = new EventEmitter() as ClientRequest;
      const end = vi.fn(() => {
        queueMicrotask(() => {
          listener(incoming);
          if (config.stall) response.write("{");
          else response.end(config.body ?? Buffer.from('{"ok":true}'));
        });
        return outgoing;
      });
      const destroy = vi.fn(() => {
        response.destroy();
        return outgoing;
      });
      outgoing.end = end;
      outgoing.destroy = destroy;
      requests.push({ end, destroy });
      return outgoing;
    },
  );
  return { resolve, request, requests, responses };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("safe provider URL validation", () => {
  it.each([
    "http://provider.example.test/v1",
    "file:///etc/passwd",
    "https://user:password@provider.example.test/v1",
    "https://provider.example.test/v1#fragment",
    "https://provider.example.test/v1#",
    "https://provider.example.test/v1?api-key=secret",
    "https://provider.example.test/v1?",
    "invalid-url",
  ])("rejects unsafe base URL %s", (url) => {
    expect(() => validatePublicProviderUrl(url)).toThrow(
      "provider_url_invalid",
    );
  });

  it.each([
    "localhost",
    "foo.localhost.",
    "server.local",
    "127.0.0.1",
    "127.1",
    "2130706433",
    "0x7f000001",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.0.1",
    "169.254.169.254",
    "168.63.129.16",
    "100.100.100.200",
    "0.0.0.0",
    "[::1]",
    "[::]",
    "[fc00::1]",
    "[fe80::1]",
    "[::ffff:127.0.0.1]",
    "[::ffff:8.8.8.8]",
    "[64:ff9b::7f00:1]",
    "[2002:7f00:1::]",
    "[2001:db8::1]",
    "224.0.0.1",
    "255.255.255.255",
  ])(
    "rejects restricted literal/hostname %s before DNS or sockets",
    async (host) => {
      const network = networkResponse();
      const url = `https://${host}/v1`;
      expect(() => validatePublicProviderUrl(url)).toThrow(
        "provider_address_blocked",
      );
      await expect(
        createSafeProviderFetch({ network })(url),
      ).rejects.toMatchObject({
        code: "provider_address_blocked",
      });
      expect(network.resolve).not.toHaveBeenCalled();
      expect(network.request).not.toHaveBeenCalled();
    },
  );

  it("accepts public HTTPS custom paths/ports without changing them", () => {
    const url = "https://provider.example.test:8443/custom/v1/";
    expect(validatePublicProviderUrl(url).href).toBe(url);
  });
});

describe("safe provider fetch", () => {
  it.each([
    [],
    [{ address: "10.0.0.1", family: 4 }],
    [{ address: "::1", family: 6 }],
    [{ address: "168.63.129.16", family: 4 }],
    [{ address: "not-an-ip", family: 4 }],
    [{ address: "8.8.8.8", family: 6 }],
    [{ address: "8.8.8.8", family: 0 }],
    [
      { address: "8.8.8.8", family: 4 },
      { address: "192.168.1.1", family: 4 },
    ],
    [
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "fd00::1", family: 6 },
    ],
  ])(
    "rejects invalid or mixed public/private DNS answers",
    async (...addresses) => {
      const network = networkResponse();
      network.resolve.mockResolvedValue(addresses);
      await expect(
        createSafeProviderFetch({ network })(endpoint),
      ).rejects.toMatchObject({
        code: "provider_address_blocked",
      });
      expect(network.request).not.toHaveBeenCalled();
    },
  );

  it.each([
    { address: "8.8.8.8", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
  ])(
    "pins public $address for socket lookup with original Host and TLS checks",
    async (pinned) => {
      const network = networkResponse();
      network.resolve
        .mockResolvedValueOnce([pinned])
        .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
      const url = `${endpoint}?page=next`;
      const response = await createSafeProviderFetch({ network })(url, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-secret",
          "Content-Type": "application/json",
        },
        body: '{"model":"test-model"}',
      });
      expect(await response.json()).toEqual({ ok: true });
      const [target, options] = network.request.mock.calls[0]!;
      expect(target.href).toBe(url);
      expect(options).toMatchObject({
        method: "POST",
        agent: false,
        family: pinned.family,
        headers: {
          authorization: "Bearer test-secret",
          "content-type": "application/json",
          "accept-encoding": "identity",
          "content-length": "22",
        },
      });
      expect(options).not.toHaveProperty("rejectUnauthorized");
      expect(options).not.toHaveProperty("servername");
      expect(options.headers).not.toHaveProperty("host");
      const single = vi.fn();
      const all = vi.fn();
      options.lookup!(target.hostname, { family: pinned.family }, single);
      options.lookup!(target.hostname, { all: true }, all);
      expect(single).toHaveBeenCalledWith(null, pinned.address, pinned.family);
      expect(all).toHaveBeenCalledWith(null, [pinned]);
      expect(network.resolve).toHaveBeenCalledOnce();
      expect(network.requests[0]!.end).toHaveBeenCalledWith(
        Buffer.from('{"model":"test-model"}'),
      );
    },
  );

  it("checks DNS again on every request and preserves error JSON for adapters", async () => {
    const network = networkResponse({
      status: 401,
      body: Buffer.from('{"error":"invalid-key"}'),
    });
    const safeFetch = createSafeProviderFetch({ network });
    const response = await safeFetch(new Request(endpoint));
    expect(response.ok).toBe(false);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid-key" });
    network.resolve.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(safeFetch(endpoint)).rejects.toThrow(
      "provider_address_blocked",
    );
    expect(network.request).toHaveBeenCalledOnce();
  });

  it.each([301, 302, 303, 307, 308])(
    "rejects %s redirects without forwarding credentials",
    async (status) => {
      const network = networkResponse({
        status,
        headers: { location: "https://127.0.0.1/private" },
      });
      await expect(
        createSafeProviderFetch({ network })(endpoint, {
          redirect: "follow",
          headers: { Authorization: "Bearer test-secret" },
        }),
      ).rejects.toThrow("provider_redirect_blocked");
      expect(network.request).toHaveBeenCalledOnce();
      expect(network.requests[0]!.destroy).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "Host",
    "Content-Length",
    "Transfer-Encoding",
    "Proxy-Authorization",
    "Connection",
    "Upgrade",
  ])("blocks caller-supplied %s", async (name) => {
    const network = networkResponse();
    await expect(
      createSafeProviderFetch({ network })(endpoint, {
        headers: { [name]: "unsafe" },
      }),
    ).rejects.toThrow("provider_request_headers_invalid");
    expect(network.request).not.toHaveBeenCalled();
    expect(network.resolve).not.toHaveBeenCalled();
  });

  it("rejects non GET/POST methods and oversized request bodies before connecting", async () => {
    const network = networkResponse();
    const safeFetch = createSafeProviderFetch({ network, maxBytes: 8 });
    await expect(safeFetch(endpoint, { method: "DELETE" })).rejects.toThrow(
      "provider_method_unsupported",
    );
    await expect(
      safeFetch(endpoint, { method: "POST", body: "123456789" }),
    ).rejects.toThrow("provider_request_too_large");
    expect(network.request).not.toHaveBeenCalled();
  });

  it.each([
    { body: Buffer.alloc(1025) },
    { headers: { "content-length": "1025" }, body: Buffer.from("small") },
    {
      headers: { "content-encoding": "gzip" },
      body: gzipSync(Buffer.alloc(1025)),
    },
  ])("bounds declared, wire, and decoded response bytes", async (config) => {
    const network = networkResponse(config);
    await expect(
      createSafeProviderFetch({ network, maxBytes: 1024 })(endpoint),
    ).rejects.toThrow("provider_response_too_large");
    expect(network.requests[0]!.destroy).toHaveBeenCalledOnce();
  });

  it.each([
    ["gzip", gzipSync(Buffer.from('{"ok":true}'))],
    ["deflate", deflateSync(Buffer.from('{"ok":true}'))],
    ["br", brotliCompressSync(Buffer.from('{"ok":true}'))],
  ] as const)(
    "decodes %s when a provider ignores accept-encoding",
    async (encoding, body) => {
      const network = networkResponse({
        headers: {
          "content-encoding": encoding,
          "content-length": String(body.byteLength),
        },
        body,
      });
      const response = await createSafeProviderFetch({ network })(endpoint);
      expect(await response.json()).toEqual({ ok: true });
      expect(response.headers.has("content-encoding")).toBe(false);
      expect(response.headers.has("content-length")).toBe(false);
    },
  );

  it("handles empty successful responses and rejects unknown encodings", async () => {
    const empty = await createSafeProviderFetch({
      network: networkResponse({ status: 204, body: Buffer.alloc(0) }),
    })(endpoint);
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");
    await expect(
      createSafeProviderFetch({
        network: networkResponse({
          headers: { "content-encoding": "mystery" },
        }),
      })(endpoint),
    ).rejects.toThrow("provider_encoding_unsupported");
  });

  it("aborts a stalled DNS lookup without opening a socket", async () => {
    const network = networkResponse();
    network.resolve.mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();
    const response = createSafeProviderFetch({ network })(endpoint, {
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort(new Error("cancelled"));
    await expect(response).rejects.toThrow("cancelled");
    expect(network.request).not.toHaveBeenCalled();
  });

  it("rejects an already-cancelled request before DNS", async () => {
    const network = networkResponse();
    await expect(
      createSafeProviderFetch({ network })(endpoint, {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(network.resolve).not.toHaveBeenCalled();
  });

  it("aborts and closes a stalled response body", async () => {
    const network = networkResponse({ stall: true });
    const controller = new AbortController();
    const result = createSafeProviderFetch({ network })(endpoint, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(network.requests).toHaveLength(1));
    controller.abort(new Error("cancelled-body"));
    await expect(result).rejects.toThrow("cancelled-body");
    expect(network.requests[0]!.destroy).toHaveBeenCalledOnce();
    expect(network.responses[0]!.destroyed).toBe(true);
  });

  it("enforces its own timeout across DNS and a stalled response", async () => {
    vi.useFakeTimers();
    const network = networkResponse();
    network.resolve.mockImplementation(() => new Promise(() => undefined));
    const dns = createSafeProviderFetch({ network, timeoutMs: 20 })(endpoint);
    const dnsAssertion = expect(dns).rejects.toThrow("provider_fetch_timeout");
    await vi.advanceTimersByTimeAsync(20);
    await dnsAssertion;
    expect(network.request).not.toHaveBeenCalled();

    const stalled = networkResponse({ stall: true });
    const body = createSafeProviderFetch({ network: stalled, timeoutMs: 20 })(
      endpoint,
    );
    const bodyAssertion = expect(body).rejects.toThrow(
      "provider_fetch_timeout",
    );
    await vi.advanceTimersByTimeAsync(20);
    await bodyAssertion;
    expect(stalled.requests[0]!.destroy).toHaveBeenCalledOnce();
  });

  it("rejects a prematurely interrupted response", async () => {
    const network = networkResponse({ stall: true });
    const result = createSafeProviderFetch({ network })(endpoint);
    await vi.waitFor(() => expect(network.responses).toHaveLength(1));
    network.responses[0]!.emit("aborted");
    await expect(result).rejects.toThrow("provider_response_interrupted");
    expect(network.requests[0]!.destroy).toHaveBeenCalledOnce();
  });
});
