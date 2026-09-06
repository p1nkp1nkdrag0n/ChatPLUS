import { describe, expect, it, vi } from "vitest";
import type { RelationshipShareProjection } from "@personasim/contracts";
import {
  paintRelationshipShare,
  relationshipShareFilename,
} from "./shareExport";

function contextDouble(): CanvasRenderingContext2D {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    measureText: vi.fn(() => ({ width: 10 })),
  } as unknown as CanvasRenderingContext2D;
}

describe("local relationship share rendering", () => {
  it("renders a default projection without any body or excerpt", () => {
    const projection: RelationshipShareProjection = {
      version: "relationship_share_projection_v1",
      templateVersion: "relationship-share-v1",
      exportMode: "local_png",
      agentId: "agent-1",
      generatedAtUtc: "2026-09-03T00:00:00.000Z",
      envelope: {
        letterId: "letter-1",
        direction: "user_to_agent",
        status: "read",
        envelope: true,
        postmark: "2026-09-01 · Asia/Shanghai",
        waitingDays: 5,
      },
      sourceIds: ["letter-1"],
    };
    const context = contextDouble();

    paintRelationshipShare(context, projection);

    const text = (context.fillText as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String(call[0]))
      .join(" ");
    expect(text).toContain("正文未包含");
    expect(text).not.toContain("SENTINEL_HIDDEN_BODY");
    expect(text).toContain("不上传 · 不创建公开链接");
  });

  it("uses a stable local PNG filename", () => {
    expect(relationshipShareFilename("2026-09-03T10:00:00.000Z")).toBe(
      "relationship-memory-20260903.png",
    );
  });
});
