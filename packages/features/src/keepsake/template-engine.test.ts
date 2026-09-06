import { describe, expect, it } from "vitest";
import type { KeepsakeVisualSpec } from "@personasim/contracts";

import { KeepsakeTemplateEngine } from "./template-engine.js";

const visualSpec: KeepsakeVisualSpec = {
  version: "keepsake_visual_v1",
  templateVersion: "structured-v1",
  theme: "雨后的旧电影院",
  caption: "<九月八日>，散场时雨刚停。",
  palette: ["#F3E9D2", "#22354B", "#C56F46"],
  materials: ["旧纸", "蓝色油墨"],
};

describe("KeepsakeTemplateEngine", () => {
  it.each(["ticket_stub", "recipe_or_note_card", "postcard"] as const)(
    "renders a deterministic, escaped %s template",
    (kind) => {
      const engine = new KeepsakeTemplateEngine();
      const first = engine.render({ kind, title: "雨夜 <电影>", visualSpec });
      const second = engine.render({ kind, title: "雨夜 <电影>", visualSpec });
      expect(first.bytes).toEqual(second.bytes);
      const svg = new TextDecoder().decode(first.bytes);
      expect(svg).toContain("雨夜 &lt;电影&gt;");
      expect(svg).toContain("&lt;九月八日&gt;");
      expect(svg).not.toContain("雨夜 <电影>");
    },
  );

  it.each([
    "ticket_stub",
    "recipe_or_note_card",
    "postcard",
    "polaroid",
    "sketch",
    "pressed_flower",
  ] as const)(
    "keeps long multilingual content inside %s v2 bounds at different output sizes",
    (kind) => {
      const engine = new KeepsakeTemplateEngine();
      const title = "去海边两天，回来汇报 · 便笺卡 <A&B> 🏖️";
      const spec = {
        ...visualSpec,
        templateVersion: `${kind}-v2`,
        caption: "一段公开的来源摘要，包含已经确认的内容。"
          .repeat(25)
          .slice(0, 500),
      };
      for (const size of [64, 900, 4096]) {
        const output = engine.render({
          kind,
          title,
          visualSpec: spec,
          width: size,
          height: size,
        });
        const svg = new TextDecoder().decode(output.bytes);
        expect(output.width).toBe(size);
        expect(svg).toContain(`width="${size}" height="${size}"`);
        expect(svg).toContain("&lt;A&amp;B&gt;");
        expect(svg).not.toContain("<A&B>");
        const boxes = [
          ...svg.matchAll(
            /<g data-text-box="([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)"[^>]*>([\s\S]*?)<\/g>/gu,
          ),
        ];
        expect(boxes.length).toBeGreaterThanOrEqual(2);
        for (const box of boxes) {
          const [, x, y, width, height, body] = box;
          for (const text of body!.matchAll(
            /<text x="([\d.]+)" y="([\d.]+)" font-size="([\d.]+)" textLength="([\d.]+)"/gu,
          )) {
            expect(Number(text[1])).toBe(Number(x));
            expect(Number(text[2]) - Number(text[3])).toBeGreaterThanOrEqual(
              Number(y),
            );
            expect(Number(text[2]) + Number(text[3]) * 0.3).toBeLessThanOrEqual(
              Number(y) + Number(height),
            );
            expect(Number(text[4])).toBeLessThanOrEqual(Number(width));
          }
        }
        expect(
          engine.render({
            kind,
            title,
            visualSpec: spec,
            width: size,
            height: size,
          }).bytes,
        ).toEqual(output.bytes);
      }
    },
  );

  it("keeps frozen legacy output unchanged and renders new note captions in the body", () => {
    const engine = new KeepsakeTemplateEngine();
    const title = "去海边两天，回来汇报 · 便笺卡";
    const legacy = new TextDecoder().decode(
      engine.render({
        kind: "recipe_or_note_card",
        title,
        visualSpec: {
          ...visualSpec,
          templateVersion: "recipe_or_note_card-v1",
        },
      }).bytes,
    );
    expect(legacy).toContain(
      `<text x="190" y="128" fill="#22354B" font-family="serif" font-size="52">${title}</text>`,
    );
    expect(legacy).not.toContain("data-text-box");
    const modern = new TextDecoder().decode(
      engine.render({
        kind: "recipe_or_note_card",
        title,
        visualSpec: {
          ...visualSpec,
          templateVersion: "recipe_or_note_card-v2",
        },
      }).bytes,
    );
    expect(modern).toContain('data-text-box="184 340 638 636"');
    expect(modern).not.toContain('font-size="52"');
  });
});
