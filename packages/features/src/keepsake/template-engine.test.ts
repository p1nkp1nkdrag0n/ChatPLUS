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
});
