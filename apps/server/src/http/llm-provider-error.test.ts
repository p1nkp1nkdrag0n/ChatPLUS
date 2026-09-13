import { LlmProviderError, StructuredOutputError } from "@personasim/providers";
import { describe, expect, it } from "vitest";

import { publicLlmProviderError } from "./llm-provider-error.js";

const PRIVATE = "synthetic-private-api-key-and-provider-response";

describe("public model error mapping", () => {
  it.each([
    ["OUTPUT_TRUNCATED", 502, "llm_output_truncated"],
    ["TIMEOUT", 504, "llm_timeout"],
    ["NETWORK_ERROR", 502, "llm_network_error"],
    ["CANCELLED", 409, "llm_cancelled"],
    ["INVALID_CONFIGURATION", 422, "llm_invalid_configuration"],
    ["EMPTY_RESPONSE", 502, "llm_empty_response"],
    ["EMPTY_FINAL_AFTER_REASONING", 502, "llm_empty_final_after_reasoning"],
    ["INVALID_RESPONSE_ENVELOPE", 502, "llm_invalid_response"],
    ["INVALID_STRUCTURED_OUTPUT", 502, "llm_invalid_structured_output"],
    ["UNSUPPORTED_RESPONSE_SCHEMA", 422, "llm_unsupported_response_schema"],
    ["MISSING_RESPONSE_SCHEMA", 502, "llm_missing_response_schema"],
    ["MODEL_REFUSAL", 422, "llm_model_refusal"],
    ["CONTENT_FILTERED", 422, "llm_content_filtered"],
    ["INCOMPLETE_RESPONSE", 502, "llm_incomplete_response"],
    ["MODEL_LIST_TOO_LARGE", 502, "llm_model_list_too_large"],
  ])(
    "gives actionable guidance for %s without exposing provider text",
    (code, statusCode, publicCode) => {
      const error = new LlmProviderError(PRIVATE, String(code), 200, {
        cause: new Error(PRIVATE),
      });
      const mapped = publicLlmProviderError(error);
      expect(mapped).toMatchObject({ statusCode, code: publicCode });
      expect(mapped?.message).toMatch(/[\u4e00-\u9fff]/u);
      expect(JSON.stringify(mapped)).not.toContain(PRIVATE);
    },
  );

  it.each([
    [400, 422, "llm_invalid_configuration"],
    [401, 502, "llm_authentication_failed"],
    [403, 502, "llm_access_denied"],
    [404, 502, "llm_endpoint_not_found"],
    [405, 502, "llm_endpoint_not_supported"],
    [408, 504, "llm_timeout"],
    [413, 422, "llm_request_too_large"],
    [422, 422, "llm_invalid_configuration"],
    [429, 429, "llm_rate_limited"],
    [500, 502, "llm_service_unavailable"],
    [503, 502, "llm_service_unavailable"],
  ])(
    "normalizes both provider adapters' HTTP %i failures",
    (upstreamStatus, statusCode, code) => {
      const legacy = publicLlmProviderError(
        new LlmProviderError(PRIVATE, "HTTP_ERROR", Number(upstreamStatus)),
      );
      const managed = publicLlmProviderError(
        new LlmProviderError(
          PRIVATE,
          `HTTP_${upstreamStatus}`,
          Number(upstreamStatus),
        ),
      );
      expect(legacy).toEqual(managed);
      expect(legacy).toMatchObject({ statusCode, code });
      expect(JSON.stringify(legacy)).not.toContain(PRIVATE);
    },
  );

  it("does not expose raw validation issues or unknown provider codes", () => {
    const schema = publicLlmProviderError(
      new StructuredOutputError(PRIVATE, [PRIVATE], {
        cause: new Error(PRIVATE),
      }),
    );
    expect(schema?.code).toBe("llm_invalid_structured_output");
    expect(JSON.stringify(schema)).not.toContain(PRIVATE);
    for (const code of [PRIVATE, "__proto__", "constructor", "HTTP_777"]) {
      const unknown = publicLlmProviderError(
        new LlmProviderError(PRIVATE, code),
      );
      expect(unknown?.code).toBe("llm_provider_error");
      expect(JSON.stringify(unknown)).not.toContain(PRIVATE);
    }
    expect(publicLlmProviderError(new Error(PRIVATE))).toBeUndefined();
    expect(
      publicLlmProviderError({ code: "OUTPUT_TRUNCATED", message: PRIVATE }),
    ).toBeUndefined();
  });
});
