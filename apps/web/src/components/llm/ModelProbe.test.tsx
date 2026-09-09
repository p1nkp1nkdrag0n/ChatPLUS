import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LlmProbeResult } from "@personasim/contracts";
import { ModelProbeResult } from "./ModelProbe";

describe("model probe status presentation", () => {
  const partial: LlmProbeResult = {
    modelId: "model-a",
    testedAt: "2026-09-09T10:00:00Z",
    status: "partial",
    text: { status: "success", latencyMs: 90, reply: "你好。" },
    structured: {
      status: "failed",
      latencyMs: 120,
      error: "模型返回了无效 JSON",
    },
  };
  it("keeps a structured failure visibly distinct from complete success", () => {
    const html = renderToStaticMarkup(<ModelProbeResult result={partial} />);
    expect(html).toContain("model-probe__result--partial");
    expect(html).toContain("模型能回复，但结构化测试未通过");
    expect(html).toContain("模型返回了无效 JSON");
    expect(html).toContain("实际回复：“你好。”");
    expect(html).toContain('role="status"');
  });
  it("marks an unexecuted second stage clearly after empty-content failure", () => {
    const html = renderToStaticMarkup(
      <ModelProbeResult
        result={{
          ...partial,
          status: "failed",
          text: {
            status: "failed",
            latencyMs: 12,
            error: "模型没有返回可见正文",
          },
          structured: { status: "skipped", latencyMs: 0 },
        }}
      />,
    );
    expect(html).toContain("测试失败");
    expect(html).toContain("结构化输出：未执行");
    expect(html).not.toContain("实际回复");
  });
});
