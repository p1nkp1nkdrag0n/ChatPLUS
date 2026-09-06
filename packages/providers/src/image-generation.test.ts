import { describe, expect, it } from "vitest";
import type { VisualPromptSpec } from "@personasim/contracts";

import { createFixtureImageGenerationProvider } from "./image-generation.js";

const HASH = "a".repeat(64);

const visualSpec: VisualPromptSpec = {
  version: "keepsake_visual_v1",
  kind: "postcard",
  subject: "<海边灯塔>",
  setting: "九十年代末的北方海港",
  mood: "克制而温暖",
  composition: "横向远景",
  materials: ["哑光纸"],
  palette: ["#F3E9D2", "#22354B", "#C56F46"],
  stableCharacterTraits: [],
  forbiddenElements: ["水印"],
  visualProfileHash: HASH,
  semanticSourceHash: HASH,
};

describe("fixture image generation provider", () => {
  it("renders deterministic bytes for the same bounded visual spec", async () => {
    const provider = createFixtureImageGenerationProvider();
    const input = {
      visualSpec,
      width: 800,
      height: 520,
      idempotencyKey: "keepsake:outcome-1:postcard:v1",
    };
    const first = await provider.generate(input);
    const second = await provider.generate(input);
    expect(first).toMatchObject({
      mimeType: "image/svg+xml",
      width: 800,
      height: 520,
    });
    expect(first.bytes).toEqual(second.bytes);
    const svg = new TextDecoder().decode(first.bytes);
    expect(svg).toContain("&lt;海边灯塔&gt;");
    expect(svg).not.toContain("<海边灯塔>");
  });

  it("rejects out-of-policy image dimensions", async () => {
    const provider = createFixtureImageGenerationProvider();
    await expect(
      provider.generate({
        visualSpec,
        width: 12_000,
        height: 520,
        idempotencyKey: "keepsake:outcome-1:postcard:v1",
      }),
    ).rejects.toThrow("Image dimensions");
  });
});
