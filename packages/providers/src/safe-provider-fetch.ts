import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Readable, Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { isPublicAddress } from "./safe-image-download.js";

export class ProviderFetchError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProviderFetchError";
  }
}

/** Test seams cannot bypass URL/address validation or the pinned socket lookup. */
export interface ProviderFetchNetwork {
  resolve?: (hostname: string) => Promise<LookupAddress[]>;
  request?: (
    url: URL,
    options: RequestOptions,
    listener: (response: IncomingMessage) => void,
  ) => ClientRequest;
}

/** Validate a saved provider base URL. DNS is checked again for every request. */
export function validatePublicProviderUrl(raw: string): URL {
  const url = validateRequestUrl(raw);
  if (url.href.includes("?"))
    throw new ProviderFetchError("provider_url_invalid");
  return url;
}

function validateRequestUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderFetchError("provider_url_invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.href.includes("#")
  )
    throw new ProviderFetchError("provider_url_invalid");
  const hostname = unbracket(url.hostname);
  const name = hostname.toLowerCase().replace(/\.$/u, "");
  if (
    name === "localhost" ||
    name.endsWith(".localhost") ||
    name.endsWith(".local") ||
    (isIP(hostname) !== 0 && !isProviderAddressAllowed(hostname))
  )
    throw new ProviderFetchError("provider_address_blocked");
  return url;
}

const forbiddenHeaders = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "expect",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-authenticate",
]);

/**
 * Buffered GET/POST transport for user-owned provider JSON APIs. Every request
 * uses HTTPS, validates every DNS answer, pins its socket, and rejects redirects
 * before credentials could be sent to another destination. The byte budget
 * applies to request bodies and both compressed and decompressed responses.
 */
export function createSafeProviderFetch(
  options: {
    network?: ProviderFetchNetwork;
    maxBytes?: number;
    timeoutMs?: number;
  } = {},
): typeof fetch {
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647
  )
    throw new RangeError("Invalid provider transport limits");

  return async (input, init) => {
    // Validate before constructing Request: Request discards URL fragments.
    const url = validateRequestUrl(
      input instanceof Request ? input.url : String(input),
    );
    const request = new Request(input, init);
    if (!["GET", "POST"].includes(request.method))
      throw new ProviderFetchError("provider_method_unsupported");
    for (const name of request.headers.keys()) {
      if (forbiddenHeaders.has(name) || name.startsWith("proxy-"))
        throw new ProviderFetchError("provider_request_headers_invalid");
    }
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(request.signal.reason);
    request.signal.addEventListener("abort", forwardAbort, { once: true });
    if (request.signal.aborted) forwardAbort();
    const timeout = setTimeout(
      () => controller.abort(new ProviderFetchError("provider_fetch_timeout")),
      timeoutMs,
    );
    timeout.unref();
    const signal = controller.signal;
    try {
      signal.throwIfAborted();
      const body = await readRequestBody(request, signal, maxBytes);
      const hostname = unbracket(url.hostname);
      const family = isIP(hostname);
      const addresses = family
        ? [{ address: hostname, family }]
        : await abortable(
            (
              options.network?.resolve ??
              ((host) => dnsLookup(host, { all: true, verbatim: true }))
            )(hostname),
            signal,
          );
      if (
        !addresses.length ||
        addresses.some(
          (item) =>
            isIP(item.address) !== item.family ||
            ![4, 6].includes(item.family) ||
            !isProviderAddressAllowed(item.address),
        )
      )
        throw new ProviderFetchError("provider_address_blocked");
      signal.throwIfAborted();
      const pinned = addresses[0]!;
      const headers = Object.fromEntries(request.headers.entries());
      // Ask for identity to reduce CPU work; decode providers that ignore it.
      headers["accept-encoding"] = "identity";
      if (body) headers["content-length"] = String(body.byteLength);
      return await sendRequest({
        url,
        method: request.method,
        headers,
        body,
        signal,
        pinned,
        maxBytes,
        request: options.network?.request ?? httpsRequest,
      });
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", forwardAbort);
    }
  };
}

async function readRequestBody(
  request: Request,
  signal: AbortSignal,
  maxBytes: number,
): Promise<Buffer | undefined> {
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) return Buffer.concat(chunks, length);
      length += value.byteLength;
      if (length > maxBytes)
        throw new ProviderFetchError("provider_request_too_large");
      chunks.push(value);
    }
  } finally {
    // Do not wait on a caller-owned stream's potentially stalled cancel hook.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function sendRequest(options: {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: Buffer | undefined;
  signal: AbortSignal;
  pinned: LookupAddress;
  maxBytes: number;
  request: NonNullable<ProviderFetchNetwork["request"]>;
}): Promise<Response> {
  return new Promise((resolve, reject) => {
    let req: ClientRequest | undefined;
    let incoming: IncomingMessage | undefined;
    let decoded: Readable | undefined;
    let settled = false;
    const finish = (error?: unknown, response?: Response) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener("abort", abort);
      if (error !== undefined) {
        reject(
          error instanceof Error
            ? error
            : new ProviderFetchError("provider_request_failed"),
        );
        decoded?.destroy();
        incoming?.destroy();
        req?.destroy();
      } else if (response) resolve(response);
    };
    const abort = () => finish(abortReason(options.signal));
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) {
      abort();
      return;
    }
    try {
      req = options.request(
        options.url,
        {
          method: options.method,
          headers: options.headers,
          agent: false,
          family: options.pinned.family,
          signal: options.signal,
          // Preserve URL Host and certificate/SNI checks; no second DNS lookup.
          lookup: (_host, lookupOptions, callback) => {
            if (lookupOptions.all) callback(null, [{ ...options.pinned }]);
            else callback(null, options.pinned.address, options.pinned.family);
          },
        },
        (response) => {
          incoming = response;
          response.once("error", finish);
          if (settled) {
            response.destroy();
            return;
          }
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            finish(new ProviderFetchError("provider_redirect_blocked"));
            return;
          }
          if (status < 200 || status > 599) {
            finish(new ProviderFetchError("provider_response_invalid"));
            return;
          }
          const encoding = response.headers["content-encoding"]?.toLowerCase();
          let decompressor: Transform | undefined;
          if (encoding === "gzip") decompressor = createGunzip();
          else if (encoding === "deflate") decompressor = createInflate();
          else if (encoding === "br") decompressor = createBrotliDecompress();
          else if (encoding && encoding !== "identity") {
            finish(new ProviderFetchError("provider_encoding_unsupported"));
            return;
          }
          decoded = decompressor ?? response;
          decoded.once("error", finish);
          const declaredLength = Number(response.headers["content-length"]);
          if (declaredLength > options.maxBytes) {
            finish(new ProviderFetchError("provider_response_too_large"));
            return;
          }
          let wireLength = 0;
          response.on("data", (chunk: Buffer) => {
            wireLength += chunk.byteLength;
            if (wireLength > options.maxBytes)
              finish(new ProviderFetchError("provider_response_too_large"));
          });
          response.once("aborted", () =>
            finish(new ProviderFetchError("provider_response_interrupted")),
          );
          const chunks: Buffer[] = [];
          let length = 0;
          decoded.on("data", (chunk: Buffer) => {
            if (settled) return;
            length += chunk.byteLength;
            if (length > options.maxBytes) {
              finish(new ProviderFetchError("provider_response_too_large"));
              return;
            }
            chunks.push(chunk);
          });
          decoded.once("end", () => {
            if (settled) return;
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (
                value === undefined ||
                name === "content-encoding" ||
                name === "content-length"
              )
                continue;
              for (const item of Array.isArray(value) ? value : [value])
                headers.append(name, item);
            }
            try {
              finish(
                undefined,
                new Response(
                  status === 204 || status === 205
                    ? null
                    : new Uint8Array(Buffer.concat(chunks, length)),
                  { status, headers },
                ),
              );
            } catch (error) {
              finish(error);
            }
          });
          if (decompressor) response.pipe(decompressor);
        },
      );
      req.once("error", finish);
      req.end(options.body);
    } catch (error) {
      finish(error);
    }
  });
}

function unbracket(hostname: string): string {
  return hostname.replace(/^\[|\]$/gu, "");
}

function isProviderAddressAllowed(address: string): boolean {
  // Azure's virtual platform IP is publicly numbered but reaches the VM's
  // host control plane, rather than an ordinary public provider endpoint.
  return address !== "168.63.129.16" && isPublicAddress(address);
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException("Aborted", "AbortError");
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
