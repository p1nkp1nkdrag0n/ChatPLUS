import { describe, expect, it } from "vitest";
import { redactKnownSecrets } from "./known-secret-redaction.js";

describe("precise configured-credential redaction", () => {
  const key = "TEST_ONLY_KEY_123456789";
  it("redacts supplier plain-text echoes and metadata without treating keys as regex", () => {
    const metacharacters = "test-only.[key]+$";
    expect(redactKnownSecrets(`Bearer ${key}; retry ${key}`, [key])).toBe(
      "Bearer [REDACTED_API_KEY]; retry [REDACTED_API_KEY]",
    );
    expect(
      redactKnownSecrets(`request-${metacharacters}-id`, [metacharacters]),
    ).toBe("request-[REDACTED_API_KEY]-id");
    expect(redactKnownSecrets("request-ordinary-id", [key])).toBe(
      "request-ordinary-id",
    );
  });
  it("preserves JSON validity, usage and unrelated signed recovery URLs", () => {
    const signedUrl =
      "https://images.example.test/result.png?token=opaque-signature&expires=99999999";
    const body = JSON.stringify({
      error: { message: `Invalid credential ${key}` },
      usage: { prompt_tokens: 1250, completion_tokens: 230 },
      data: [{ url: signedUrl }],
    });
    const sanitized = JSON.parse(redactKnownSecrets(body, [key])) as {
      error: { message: string };
      usage: unknown;
      data: unknown;
    };
    expect(sanitized.error.message).toBe(
      "Invalid credential [REDACTED_API_KEY]",
    );
    expect(sanitized.usage).toEqual({
      prompt_tokens: 1250,
      completion_tokens: 230,
    });
    expect(sanitized.data).toEqual([{ url: signedUrl }]);
    expect(body).toContain(key);
  });
  it("matches Unicode-escaped JSON and nested JSON strings containing credentials", () => {
    const escaped = [...key]
      .map(
        (character) =>
          `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
      )
      .join("");
    const body = `{"error":{"message":"${escaped}"},"nested":${JSON.stringify(JSON.stringify({ echo: key }))}}`;
    const output = JSON.parse(redactKnownSecrets(body, [key])) as {
      error: { message: string };
      nested: string;
    };
    expect(output.error.message).toBe("[REDACTED_API_KEY]");
    expect(JSON.parse(output.nested)).toEqual({ echo: "[REDACTED_API_KEY]" });
  });
  it("handles quote and backslash characters without corrupting JSON", () => {
    const unusual = 'test-only-key-"with\\escapes';
    expect(
      JSON.parse(
        redactKnownSecrets(JSON.stringify({ error: unusual }), [unusual]),
      ),
    ).toEqual({ error: "[REDACTED_API_KEY]" });
  });
  it("does not blanket-remove user text, API field names, URLs or signatures", () => {
    const unchanged =
      ' { "api_key": "a-different-value", "message": "Keep this conversation", "url": "https://example.test/image?signature=opaque&key=other" }\n';
    expect(redactKnownSecrets(unchanged, [key])).toBe(unchanged);
    expect(redactKnownSecrets(unchanged, [""])).toBe(unchanged);
    expect(redactKnownSecrets(unchanged, [])).toBe(unchanged);
  });
  it("redacts both historical and current credentials without partial overlap", () => {
    expect(
      redactKnownSecrets(`${key}-long ${key}`, [key, `${key}-long`, key]),
    ).toBe("[REDACTED_API_KEY] [REDACTED_API_KEY]");
  });
  it("fails closed on adversarial nesting instead of recursing without a bound", () => {
    const nested = `${"[".repeat(300)}${JSON.stringify(key)}${"]".repeat(300)}`;
    expect(() => redactKnownSecrets(nested, [key])).toThrow("nesting exceeds");
  });
  it("redacts numeric credentials represented as strings", () => {
    expect(
      JSON.parse(
        redactKnownSecrets('{"echo":"12345678901234567890"}', [
          "12345678901234567890",
        ]),
      ),
    ).toEqual({ echo: "[REDACTED_API_KEY]" });
  });
});
