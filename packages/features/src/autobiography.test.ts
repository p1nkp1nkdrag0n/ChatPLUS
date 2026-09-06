import { describe, expect, it } from "vitest";

import {
  buildAutobiographyProjection,
  validateAutobiographyRevision,
  type AutobiographyEvidenceCatalogItemLike,
} from "./autobiography.js";

const EVIDENCE: AutobiographyEvidenceCatalogItemLike = {
  id: "evidence-run",
  sourceType: "activity_event",
  sourceId: "activity-run",
  text: "Finished the morning run and returned home.",
  temporalStatus: "occurred",
  reliability: "fact",
};

function proposal(evidenceId = EVIDENCE.id) {
  return {
    summaryFirstPerson: "I remember the morning run.",
    entries: [
      {
        entryKind: "important_experience" as const,
        content: "I finished the morning run.",
        temporalStatus: "occurred" as const,
        evidence: [
          {
            id: evidenceId,
            sourceType: "activity_event" as const,
            sourceId: "activity-run",
          },
        ],
      },
    ],
  };
}

describe("autobiography evidence validation", () => {
  it("accepts only an exact server-owned source receipt for an unrefined message", () => {
    const receipt =
      "【长消息来源索引，内容尚未提炼】消息 message-alpha 的原文仍在档案中。";
    const catalog: AutobiographyEvidenceCatalogItemLike = {
      id: "evidence-alpha",
      sourceType: "message_archive",
      sourceId: "message-alpha",
      text: "unrelated original utterance",
      reliability: "reported",
      temporalStatus: "unknown",
      sourceReceipt: receipt,
    };
    const candidate = {
      summaryFirstPerson: receipt,
      entries: [
        {
          entryKind: "unresolved_thread" as const,
          content: receipt,
          temporalStatus: "unknown" as const,
          evidence: [
            {
              id: catalog.id,
              sourceType: catalog.sourceType,
              sourceId: catalog.sourceId,
            },
          ],
        },
      ],
    };
    expect(
      validateAutobiographyRevision({
        proposal: candidate,
        evidenceCatalog: [catalog],
      }).accepted,
    ).toBe(true);
    const withoutReceipt = { ...catalog };
    delete withoutReceipt.sourceReceipt;
    expect(
      validateAutobiographyRevision({
        proposal: candidate,
        evidenceCatalog: [withoutReceipt],
      }).accepted,
    ).toBe(false);
    expect(
      validateAutobiographyRevision({
        proposal: {
          ...candidate,
          entries: [
            { ...candidate.entries[0]!, content: receipt + "我们变得更亲近。" },
          ],
        },
        evidenceCatalog: [catalog],
      }).accepted,
    ).toBe(false);
    expect(
      validateAutobiographyRevision({
        proposal: {
          ...candidate,
          entries: [{ ...candidate.entries[0]!, temporalStatus: "occurred" }],
        },
        evidenceCatalog: [catalog],
      }).accepted,
    ).toBe(false);
  });

  it("builds a category projection only from verified evidence", () => {
    const candidate = proposal();
    const validation = validateAutobiographyRevision({
      proposal: candidate,
      evidenceCatalog: [EVIDENCE],
    });
    expect(validation.accepted).toBe(true);
    expect(
      buildAutobiographyProjection({
        proposal: candidate,
        validation,
      }),
    ).toEqual({
      summaryFirstPerson: "I remember the morning run.",
      importantExperiences: ["I finished the morning run."],
      relationshipChanges: [],
      activeGoals: [],
      unresolvedThreads: [],
      commitments: [],
      sourceEvidenceIds: ["evidence-run"],
    });
  });

  it("rejects unknown evidence identifiers", () => {
    const validation = validateAutobiographyRevision({
      proposal: proposal("evidence-missing"),
      evidenceCatalog: [EVIDENCE],
    });
    expect(validation.accepted).toBe(false);
    expect(validation.issues.map((issue) => issue.code)).toContain(
      "evidence_not_found",
    );
  });

  it("does not promote planned context into an occurred experience", () => {
    const validation = validateAutobiographyRevision({
      proposal: proposal(),
      evidenceCatalog: [
        {
          ...EVIDENCE,
          text: "The morning run is planned for tomorrow.",
          temporalStatus: "planned",
          reliability: "context",
        },
      ],
    });
    expect(validation.accepted).toBe(false);
    expect(validation.issues.map((issue) => issue.code)).toContain(
      "occurred_without_occurrence_evidence",
    );
  });
});
