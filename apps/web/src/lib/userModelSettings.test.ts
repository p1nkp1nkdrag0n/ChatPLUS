import { describe, expect, it } from "vitest";
import { LlmPurposeSchema, type LlmProbeResult } from "@personasim/contracts";
import { ApiError } from "../api/types";
import {
  allTextBindings,
  modelFundingLabel,
  redactModelProbe,
  safeModelSetupError,
} from "./userModelSettings";
import { newModel } from "./llmSettings";

describe("account model configuration rules", () => {
  it("initializes every text purpose while keeping image selection outside the bulk operation", () => {
    const selection = { providerId: "llmprovider_own", modelId: "text-a" };
    const bindings = allTextBindings(selection);
    expect(Object.keys(bindings)).toEqual(LlmPurposeSchema.options);
    expect(bindings).not.toHaveProperty("imageSelection");
    expect(bindings.chat_turn).toEqual(selection);
    expect(bindings.repair_chat_turn).toEqual(selection);
    expect(bindings.letter_reply).toEqual(selection);
  });
  it("defaults new manual models to exactly 64000 tokens", () => {
    expect(newModel("text-a").capabilities.maxContextTokens).toBe(64_000);
  });
  it("distinguishes unconfigured platform defaults from explicit user-supplied models", () => {
    expect(modelFundingLabel(undefined)).toBe("平台额度");
    expect(modelFundingLabel({ providerId: "hosted", modelId: "public" })).toBe(
      "平台额度",
    );
    expect(
      modelFundingLabel({ providerId: "own", modelId: "text-a" }),
    ).toContain("不扣平台模型积分");
  });
  it("redacts submitted keys from API errors, validation issues and generic errors", () => {
    const secret = "user-key+123";
    const source = new ApiError({
      code: "upstream",
      status: 502,
      message: `error ${secret}`,
      issues: [{ path: secret, message: encodeURIComponent(secret) }],
    });
    const sanitized = safeModelSetupError(source, secret) as ApiError;
    expect(sanitized.status).toBe(502);
    expect(sanitized.message).not.toContain(secret);
    expect(JSON.stringify(sanitized.issues)).not.toContain(secret);
    expect(JSON.stringify(sanitized.issues)).not.toContain(
      encodeURIComponent(secret),
    );
    expect(
      safeModelSetupError(new Error(`failed ${secret}`), secret).message,
    ).not.toContain(secret);
    expect(source.message).toContain(secret);
  });
  it("redacts key echoes from probe replies and errors before rendering them", () => {
    const probe: LlmProbeResult = {
      status: "partial",
      testedAt: "2026-09-15T00:00:00Z",
      modelId: "text-a",
      text: {
        status: "success",
        latencyMs: 2,
        reply: "provider echo key-secret",
      },
      structured: {
        status: "failed",
        latencyMs: 3,
        error: "key-secret denied",
      },
    };
    const safe = redactModelProbe(probe, "key-secret");
    expect(JSON.stringify(safe)).not.toContain("key-secret");
    expect(safe.status).toBe("partial");
    expect(probe.text.reply).toContain("key-secret");
  });
});
