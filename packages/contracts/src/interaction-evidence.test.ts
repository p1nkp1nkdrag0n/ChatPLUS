import { describe, expect, it } from "vitest";

import { InteractionEvidenceSnapshotSchema } from "./interaction-evidence.js";

const valid = {
  policyVersion: "directed_interaction_v1",
  userId: "user-1",
  characterId: "character-1",
  sourceMessages: [{ id: "message-1", role: "user", text: "以后请先听我说。" }],
  historicalAnchors: [
    {
      id: "anchor-1",
      kind: "communication_preference",
      requestedBy: "user:user-1",
      expectedActor: "character:character-1",
      recipient: "user:user-1",
      behavior: "listen_first",
      scope: {},
      modality: "requested",
      sourceMessageIds: ["message-1"],
      sourceQuotes: [
        { messageId: "message-1", role: "user", text: "以后请先听我说。" },
      ],
      observedAdherenceEvidenceIds: [],
    },
  ],
  activePracticeAnchorIds: [],
};

describe("interaction evidence contract", () => {
  it("keeps a historical request when no practice is active", () => {
    expect(
      InteractionEvidenceSnapshotSchema.parse(valid).historicalAnchors,
    ).toHaveLength(1);
  });
  it("rejects evidence from another participant or a missing source", () => {
    const badParticipant = structuredClone(valid);
    badParticipant.historicalAnchors[0]!.recipient = "user:another-user";
    expect(
      InteractionEvidenceSnapshotSchema.safeParse(badParticipant).success,
    ).toBe(false);
    expect(
      InteractionEvidenceSnapshotSchema.safeParse({
        ...valid,
        sourceMessages: [],
      }).success,
    ).toBe(false);
  });
  it("rejects assistant text as observed user evidence", () => {
    const assistant = structuredClone(valid);
    assistant.sourceMessages[0]!.role = "assistant";
    expect(InteractionEvidenceSnapshotSchema.safeParse(assistant).success).toBe(
      false,
    );
  });
  it("rejects modified quotes and unknown active anchors", () => {
    const modified = structuredClone(valid);
    modified.historicalAnchors[0]!.sourceQuotes[0]!.text = "我一直先听你说。";
    expect(InteractionEvidenceSnapshotSchema.safeParse(modified).success).toBe(
      false,
    );
    expect(
      InteractionEvidenceSnapshotSchema.safeParse({
        ...valid,
        activePracticeAnchorIds: ["missing"],
      }).success,
    ).toBe(false);
  });
});
