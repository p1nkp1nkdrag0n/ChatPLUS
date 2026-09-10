import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export class ImageDownloadError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ImageDownloadError";
  }
}

/** Low-level test seams still pass through address validation and pinned lookup.
 * A general fetch override cannot guarantee which address its connection uses. */
export interface ImageDownloadNetwork {
  resolve?: (hostname: string) => Promise<LookupAddress[]>;
  request?: (
    url: URL,
    options: RequestOptions,
    listener: (response: IncomingMessage) => void,
  ) => ClientRequest;
}

export async function downloadImageAsset(
  rawUrl: string,
  options: {
    providerBaseUrl: string;
    signal: AbortSignal;
    maxBytes: number;
    network?: ImageDownloadNetwork;
  },
): Promise<{ bytes: Uint8Array; contentType: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ImageDownloadError("image_invalid_url");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new ImageDownloadError("image_invalid_url");
  options.signal.throwIfAborted();
  const hostname = unbracket(url.hostname);
  const providerUrl = new URL(options.providerBaseUrl);
  // Only an explicitly local configured origin gets an exception. A public
  // hostname resolving to private addresses must not acquire this permission.
  const localOriginAllowed =
    url.origin === providerUrl.origin &&
    explicitlyLocalHost(unbracket(providerUrl.hostname));
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await abortable(
        (
          options.network?.resolve ??
          ((host) => dnsLookup(host, { all: true, verbatim: true }))
        )(hostname),
        options.signal,
      );
  if (
    !addresses.length ||
    addresses.some(
      (item) =>
        isIP(item.address) !== item.family ||
        ![4, 6].includes(item.family) ||
        !(
          isPublicAddress(item.address) ||
          (localOriginAllowed && isLocalAddress(item.address))
        ),
    )
  )
    throw new ImageDownloadError("image_asset_address_blocked");
  const pinned = addresses[0]!;
  options.signal.throwIfAborted();
  const request =
    options.network?.request ??
    (url.protocol === "https:" ? httpsRequest : httpRequest);
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        agent: false,
        family: pinned.family,
        signal: options.signal,
        // Keep the URL hostname (Host header and HTTPS certificate/SNI) while
        // ensuring the socket cannot perform a second, attacker-controlled lookup.
        lookup: (_host, lookupOptions, callback) => {
          if (lookupOptions.all) callback(null, [{ ...pinned }]);
          else callback(null, pinned.address, pinned.family);
        },
      },
      (response) => {
        response.once("error", reject);
        if (
          (response.statusCode ?? 0) < 200 ||
          (response.statusCode ?? 0) >= 300
        ) {
          response.destroy();
          reject(new ImageDownloadError("image_asset_unavailable"));
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.byteLength;
          if (length > options.maxBytes) {
            response.destroy();
            req.destroy();
            reject(new ImageDownloadError("image_response_too_large"));
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () =>
          resolve({
            bytes: Buffer.concat(chunks, length),
            contentType: response.headers["content-type"] ?? "",
          }),
        );
      },
    );
    req.once("error", reject);
    req.end();
  });
}

function unbracket(host: string): string {
  return host.replace(/^\[|\]$/gu, "");
}
function explicitlyLocalHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/u, "");
  return (
    name === "localhost" || name.endsWith(".localhost") || isLocalAddress(host)
  );
}

function ipv4(address: string): bigint {
  return address
    .split(".")
    .reduce((value, part) => (value << 8n) + BigInt(part), 0n);
}
function ipv6(address: string): bigint {
  const normalized = address.replace(/(?:\d+\.){3}\d+$/u, (v4) => {
    const number = ipv4(v4);
    return `${(number >> 16n).toString(16)}:${(number & 0xffffn).toString(16)}`;
  });
  const [left = "", right] = normalized.split("::");
  const first = left ? left.split(":") : [];
  const last = right ? right.split(":") : [];
  const groups =
    right === undefined
      ? first
      : [
          ...first,
          ...Array<string>(8 - first.length - last.length).fill("0"),
          ...last,
        ];
  return groups.reduce(
    (value, part) => (value << 16n) + BigInt(`0x${part}`),
    0n,
  );
}
function inNetwork(
  address: bigint,
  network: bigint,
  prefix: number,
  bits: number,
): boolean {
  const shift = BigInt(bits - prefix);
  return address >> shift === network >> shift;
}
function v4In(address: string, network: string, prefix: number): boolean {
  return inNetwork(ipv4(address), ipv4(network), prefix, 32);
}
function v6In(address: string, network: string, prefix: number): boolean {
  return inNetwork(ipv6(address), ipv6(network), prefix, 128);
}
function isLocalAddress(address: string): boolean {
  if (isIP(address) === 4)
    return [
      ["10.0.0.0", 8],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.168.0.0", 16],
    ].some(([network, prefix]) =>
      v4In(address, network as string, prefix as number),
    );
  if (isIP(address) !== 6) return false;
  return (
    ipv6(address) === 1n ||
    v6In(address, "fc00::", 7) ||
    v6In(address, "fe80::", 10)
  );
}
function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4)
    return ![
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.88.99.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ].some(([network, prefix]) =>
      v4In(address, network as string, prefix as number),
    );
  if (isIP(address) !== 6) return false;
  // Global unicast only. Exclude special protocol assignments, documentation
  // and IPv4 transition mechanisms (which can embed a restricted IPv4 target).
  return (
    v6In(address, "2000::", 3) &&
    ![
      ["2001::", 23],
      ["2001:db8::", 32],
      ["2002::", 16],
      ["3fff::", 20],
    ].some(([network, prefix]) =>
      v6In(address, network as string, prefix as number),
    )
  );
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      const reason: unknown = signal.reason;
      reject(
        reason instanceof Error
          ? reason
          : new DOMException("Aborted", "AbortError"),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
