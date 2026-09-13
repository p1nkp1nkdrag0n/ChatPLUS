import { expect, it } from "vitest";
import { isSameServer, normalizeServerOrigin } from "./address.js";
it("accepts HTTPS origins and rejects credentials, cleartext and paths", () => {
  expect(normalizeServerOrigin(" https://EXAMPLE.com:443/ ")).toBe("https://example.com");
  for (const value of ["http://127.0.0.1", "https://a:b@example.com", "https://example.com/chat", "https://example.com/?key=x", "file:///secret", "javascript:alert(1)"])
    expect(() => normalizeServerOrigin(value)).toThrow();
});
it("restricts navigation and blob downloads to the configured server", () => {
  expect(isSameServer("https://example.com", "https://example.com/chat")).toBe(true);
  expect(isSameServer("https://example.com", "blob:https://example.com/a")).toBe(true);
  expect(isSameServer("https://example.com", "wss://example.com/events")).toBe(true);
  expect(isSameServer("https://example.com", "https://example.com.evil.test/chat")).toBe(false);
  expect(isSameServer("https://example.com", "https://other.test")).toBe(false);
});
