import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { parseHostedTrustedProxies } from "./trusted-proxies.js";

describe("hosted trusted proxy configuration", () => {
  it("defaults to trusting no forwarding headers and accepts explicit IP/CIDR entries", () => {
    expect(parseHostedTrustedProxies(undefined)).toBe(false);
    expect(parseHostedTrustedProxies(" ")).toBe(false);
    expect(
      parseHostedTrustedProxies(
        "127.0.0.1, ::1, 10.5.0.0/24, 2001:db8::/48, 127.0.0.1",
      ),
    ).toEqual(["127.0.0.1", "::1", "10.5.0.0/24", "2001:db8::/48"]);
  });

  it.each([
    "true",
    "false",
    "1",
    "*",
    "loopback",
    "proxy.example",
    "127.0.0.1,",
    "127.0.0.1,,::1",
    "127.0.0.1:3001",
    "[::1]",
    "fe80::1%lo0",
    "127.0.0.1/",
    "127.0.0.1/33",
    "::1/129",
    "0.0.0.0/0",
    "::/0",
    "127.0.0.1/-1",
    "127.0.0.1/1.5",
    "127.0.0.1/24/32",
  ])("rejects unsafe or malformed configuration %s", (value) => {
    expect(() => parseHostedTrustedProxies(value)).toThrow(
      "DEARVALE_HOSTED_TRUSTED_PROXIES",
    );
  });

  it.each([
    {
      config: undefined,
      peer: "127.0.0.1",
      forwarded: "203.0.113.7",
      expected: "127.0.0.1",
    },
    {
      config: "127.0.0.1",
      peer: "127.0.0.1",
      forwarded: "203.0.113.7",
      expected: "203.0.113.7",
    },
    {
      config: "127.0.0.1",
      peer: "127.0.0.2",
      forwarded: "203.0.113.7",
      expected: "127.0.0.2",
    },
    {
      config: "127.0.0.1",
      peer: "::ffff:127.0.0.1",
      forwarded: "203.0.113.7",
      expected: "203.0.113.7",
    },
    {
      config: "10.5.0.0/24",
      peer: "10.5.0.8",
      forwarded: "192.0.2.42, 203.0.113.7",
      expected: "203.0.113.7",
    },
    {
      config: "127.0.0.1,10.5.0.0/24",
      peer: "127.0.0.1",
      forwarded: "192.0.2.42, 203.0.113.7, 10.5.0.8",
      expected: "203.0.113.7",
    },
  ])(
    "resolves the first untrusted peer for $peer with $config",
    async ({ config, peer, forwarded, expected }) => {
      const app = Fastify({ trustProxy: parseHostedTrustedProxies(config) });
      app.get("/", (request) => ({ ip: request.ip }));
      try {
        const response = await app.inject({
          method: "GET",
          url: "/",
          remoteAddress: peer,
          headers: { "x-forwarded-for": forwarded },
        });
        expect(response.json()).toEqual({ ip: expected });
      } finally {
        await app.close();
      }
    },
  );
});
