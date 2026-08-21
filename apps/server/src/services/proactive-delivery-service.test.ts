import { describe, expect, it } from "vitest";

import { finalizeProactiveContent } from "./proactive-delivery-service.js";
import { buildDueFollowUpContent } from "./proactive-generation-service.js";

describe("due follow-up composition", () => {
  const context =
    "\u3010\u865a\u6784\u63d0\u9192\u590d\u6d4b\u3011\u8bf7\u5728\u660e\u592912:30\u4e3b\u52a8\u95ee\u6211\u201c\u6e05\u5355\u53d1\u51fa\u4e86\u5417\u201d\uff1b\u5982\u679c\u8fd8\u6ca1\u53d1\uff0c\u63d0\u9192\u6211\u5148\u53d1\u6700\u5c0f\u53ef\u7528\u7248\u672c\u3002";
  const dueContent =
    "\u6e05\u5355\u53d1\u51fa\u4e86\u5417\uff1f\u5982\u679c\u8fd8\u6ca1\u53d1\uff0c\u5148\u53d1\u6700\u5c0f\u53ef\u7528\u7248\u672c\u3002";

  it("builds a grounded message that executes the due question now", () => {
    expect(buildDueFollowUpContent(context)).toBe(dueContent);
  });

  it("builds a direct care follow-up with assistant-side pronouns", () => {
    expect(
      buildDueFollowUpContent(
        "\u4eca\u592915:10\u8bf7\u95ee\u6211\u201c\u8fd4\u5de5\u540e\u7f13\u8fc7\u6765\u4e86\u5417\u201d\uff1b\u5982\u679c\u6211\u4ecd\u7136\u6cae\u4e27\uff0c\u5148\u95ee\u6211\u201c\u9700\u8981\u6682\u505c\u5341\u5206\u949f\u5417\u201d\u3002",
      ),
    ).toBe(
      "\u8fd4\u5de5\u540e\u7f13\u8fc7\u6765\u4e86\u5417\uff1f\u5982\u679c\u4f60\u4ecd\u7136\u6cae\u4e27\uff0c\u9700\u8981\u6682\u505c\u5341\u5206\u949f\u5417\uff1f",
    );
  });

  it("replaces a deferred promise with the server-owned due message", () => {
    expect(
      finalizeProactiveContent(
        "follow_up",
        dueContent,
        "\u597d\u7684\uff0c\u6211\u4f1a\u5728\u660e\u592912:30\u4e3b\u52a8\u95ee\u4f60\u201c\u6e05\u5355\u53d1\u51fa\u4e86\u5417\u201d\u3002",
      ),
    ).toBe(dueContent);
  });

  it("keeps a direct due-time question and leaves activity messages unchanged", () => {
    expect(
      finalizeProactiveContent(
        "follow_up",
        dueContent,
        "\u5230\u65f6\u95f4\u4e86\uff0c\u6e05\u5355\u53d1\u51fa\u4e86\u5417\uff1f",
      ),
    ).toBe(
      "\u5230\u65f6\u95f4\u4e86\uff0c\u6e05\u5355\u53d1\u51fa\u4e86\u5417\uff1f",
    );
    expect(
      finalizeProactiveContent(
        "activity_candidate",
        "fallback",
        "Tomorrow I will share the walk.",
      ),
    ).toBe("Tomorrow I will share the walk.");
  });
});
