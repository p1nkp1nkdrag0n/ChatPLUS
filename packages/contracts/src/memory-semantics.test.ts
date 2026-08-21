import { describe, expect, it } from "vitest";

import {
  ContextAttachmentTypeSchema,
  MemoryCandidateSchema,
  TemporalMetadataSchema,
  isFormalEvidenceContextAttachmentType,
} from "./index.js";

const RECORDED_AT = "2026-08-20T10:00:00.000Z";

describe("memory semantic contracts", () => {
  it("does not allow a planned event to masquerade as occurred", () => {
    const result = TemporalMetadataSchema.safeParse({
      plannedStartAtUtc: "2026-08-21T10:00:00.000Z",
      plannedEndAtUtc: "2026-08-21T11:00:00.000Z",
      occurredStartAtUtc: "2026-08-21T10:05:00.000Z",
      recordedAtUtc: RECORDED_AT,
      temporalCertainty: "exact",
      temporalStatus: "planned",
    });
    expect(result.success).toBe(false);
  });

  it("never accepts model inference as an explicit memory", () => {
    const result = MemoryCandidateSchema.safeParse({
      kind: "semantic",
      content: "The user always prefers quiet cafes.",
      importance: 0.8,
      confidence: 0.8,
      tags: ["preference"],
      sourceMessageIds: ["message-1"],
      sourceActivityEventIds: [],
      origin: "model_inference",
      namespace: "user_model",
      certainty: "explicit",
      attribution: "model_inference",
      stability: "stable",
      temporalMetadata: {
        mentionedAtUtc: RECORDED_AT,
        recordedAtUtc: RECORDED_AT,
        temporalCertainty: "exact",
        temporalStatus: "unknown",
      },
      evidence: [
        {
          sourceType: "message",
          sourceId: "message-1",
          quote: "This cafe is quiet.",
          recordedAtUtc: RECORDED_AT,
        },
      ],
      shouldWrite: true,
      forbiddenOverclaims: [],
      reasonCode: "preference_inference",
      reasonSummary: "Inferred from one remark.",
    });
    expect(result.success).toBe(false);
  });

  it("classifies runtime prompt attachments as non-formal evidence", () => {
    const runtime = ContextAttachmentTypeSchema.parse("runtime_state_context");
    expect(isFormalEvidenceContextAttachmentType(runtime)).toBe(false);
    expect(isFormalEvidenceContextAttachmentType("user_visible_text")).toBe(
      true,
    );
  });
});
