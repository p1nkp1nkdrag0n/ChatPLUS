import { describe, expect, it, vi } from "vitest";

import type { StoredMessage } from "../db/store.js";
import type { CheckpointService } from "./checkpoint-service.js";
import { ConversationContinuityService } from "./conversation-continuity-service.js";
import type { FollowUpService } from "./follow-up-service.js";
import type { MemoryLifecycleService } from "./memory-lifecycle-service.js";

const NOW_UTC = "2026-08-21T04:00:00.000Z";

describe("ConversationContinuityService care cue epistemics", () => {
  it.each([
    {
      status: "hypothetical",
      content: "假设我明天答辩时会紧张，希望你先听我说完。这里只是举例。",
      metadata: {},
    },
    {
      status: "quoted_third_party",
      content: "小林说她明天答辩时希望你先听她说完。这是她的偏好，不是我的。",
      metadata: { epistemicStatus: "quoted_third_party" },
    },
    {
      status: "negated",
      content: "“我明天答辩时希望你先听我说完”不是我说的。",
      metadata: { epistemicStatus: "negated" },
    },
    {
      status: "retracted",
      content: "我撤回刚才的说法：明天答辩时希望你先听我说完。",
      metadata: { epistemicStatus: "retracted" },
    },
  ] as const)(
    "rejects an exactly grounded $status model candidate",
    async ({ status, content, metadata }) => {
      const { service, createCareCue } = createService();

      const result = await service.commitTurn({
        agentId: "agent-1",
        sessionId: "session-1",
        timezone: "Asia/Shanghai",
        userMessage: message("user-1", "user", content, metadata),
        assistantMessage: message("assistant-1", "assistant", "我听到了。", {}),
        memoryIds: [],
        promptCueIds: [],
        rawEffects: careEffects(content),
      });

      expect(createCareCue).not.toHaveBeenCalled();
      expect(result.careCueIds).toEqual([]);
      expect(result.rejections).toHaveLength(1);
      expect(result.rejections[0]).toMatchObject({
        effect: "care_cue",
        reasonCode: "non_authoritative_care_source",
      });
      expect(result.rejections[0]?.reasonSummary).toContain(status);
    },
  );

  it("accepts an exactly grounded explicit first-person care preference", async () => {
    const content =
      "请记住我的关怀方式：以后我谈到答辩紧张时，请先听我说完，不要马上给建议。";
    const { service, createCareCue } = createService();

    const result = await service.commitTurn({
      agentId: "agent-1",
      sessionId: "session-1",
      timezone: "Asia/Shanghai",
      userMessage: message("user-1", "user", content, {
        epistemicStatus: "asserted_fact",
      }),
      assistantMessage: message(
        "assistant-1",
        "assistant",
        "好，我会先听你说。",
        {},
      ),
      memoryIds: [],
      promptCueIds: [],
      rawEffects: careEffects(content),
    });

    expect(createCareCue).toHaveBeenCalledOnce();
    expect(result.careCueIds).toEqual(["carecue-1"]);
    expect(result.rejections).toEqual([]);
  });

  it("prefers persisted epistemic metadata over classifying the text again", async () => {
    const content = "请记住我的关怀方式：以后我谈到答辩紧张时，请先听我说完。";
    const { service, createCareCue } = createService();

    const result = await service.commitTurn({
      agentId: "agent-1",
      sessionId: "session-1",
      timezone: "Asia/Shanghai",
      userMessage: message("user-1", "user", content, {
        epistemicStatus: "retracted",
      }),
      assistantMessage: message("assistant-1", "assistant", "我听到了。", {}),
      memoryIds: [],
      promptCueIds: [],
      rawEffects: careEffects(content),
    });

    expect(createCareCue).not.toHaveBeenCalled();
    expect(result.rejections[0]).toMatchObject({
      reasonCode: "non_authoritative_care_source",
    });
    expect(result.rejections[0]?.reasonSummary).toContain("retracted");
  });

  it("keeps an envelope schema rejection while committing an independent explicit-care projection", async () => {
    const content =
      "下周四我要做一次公开分享，现在有点紧张。这一刻我只想被听见，不要马上给建议。";
    const { service, createCareCue } = createService();

    const result = await service.commitTurn({
      agentId: "agent-1",
      sessionId: "session-1",
      timezone: "Asia/Shanghai",
      userMessage: message("user-1", "user", content, {}),
      assistantMessage: message("assistant-1", "assistant", "我先听着。", {}),
      memoryIds: [],
      promptCueIds: [],
      rawEffects: malformedContinuityEnvelope(),
    });

    expect(createCareCue).toHaveBeenCalledOnce();
    expect(createCareCue.mock.calls[0]?.[0]).toMatchObject({
      sourceMessageId: "user-1",
      candidate: {
        contextSummary: "下周四我要做一次公开分享，现在有点紧张",
        evidenceQuotes: [
          "下周四我要做一次公开分享，现在有点紧张",
          "这一刻我只想被听见，不要马上给建议",
        ],
        reasonCode: "explicit_user_care_preference",
      },
    });
    expect(result.careCueIds).toEqual(["carecue-1"]);
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]).toMatchObject({
      effect: "continuity_envelope",
      reasonCode: "schema_mismatch",
      raw: malformedContinuityEnvelope(),
    });
  });

  it.each([
    "小林说：「我下周四要做公开分享，我只想被听见，不要马上给建议。」",
    "假设我下周四要做公开分享，我只想被听见，不要马上给建议。这里只是举例。",
  ])(
    "does not project non-authoritative care from a malformed envelope: %s",
    async (content) => {
      const { service, createCareCue } = createService();

      const result = await service.commitTurn({
        agentId: "agent-1",
        sessionId: "session-1",
        timezone: "Asia/Shanghai",
        userMessage: message("user-1", "user", content, {}),
        assistantMessage: message("assistant-1", "assistant", "我听到了。", {}),
        memoryIds: [],
        promptCueIds: [],
        rawEffects: malformedContinuityEnvelope(),
      });

      expect(createCareCue).not.toHaveBeenCalled();
      expect(result.careCueIds).toEqual([]);
      expect(result.rejections).toHaveLength(1);
      expect(result.rejections[0]).toMatchObject({
        effect: "continuity_envelope",
        reasonCode: "schema_mismatch",
      });
    },
  );

  it("keeps schema rejection while projecting care when every raw candidate is syntactically invalid", async () => {
    const content =
      "下周四我要做一次公开分享，现在有点紧张。这一刻我只想被听见，不要马上给建议。";
    const { service, createCareCue } = createService();

    const result = await service.commitTurn({
      agentId: "agent-1",
      sessionId: "session-1",
      timezone: "Asia/Shanghai",
      userMessage: message("user-1", "user", content, {}),
      assistantMessage: message("assistant-1", "assistant", "我先听着。", {}),
      memoryIds: [],
      promptCueIds: [],
      rawEffects: {
        followUpCandidates: [],
        followUpTransitions: [],
        careCueCandidates: [
          {
            cueType: "listen_first",
            contextSummary: null,
            evidenceQuotes: ["这一刻我只想被听见，不要马上给建议"],
          },
        ],
      },
    });

    expect(createCareCue).toHaveBeenCalledOnce();
    expect(result.careCueIds).toEqual(["carecue-1"]);
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]).toMatchObject({
      effect: "care_cue",
      reasonCode: "schema_mismatch",
    });
  });

  it("keeps the inner schema rejection without projecting from a retracted source", async () => {
    const content =
      "下周四我要做一次公开分享，现在有点紧张。这一刻我只想被听见，不要马上给建议。";
    const { service, createCareCue } = createService();

    const result = await service.commitTurn({
      agentId: "agent-1",
      sessionId: "session-1",
      timezone: "Asia/Shanghai",
      userMessage: message("user-1", "user", content, {
        epistemicStatus: "retracted",
      }),
      assistantMessage: message("assistant-1", "assistant", "我听到了。", {}),
      memoryIds: [],
      promptCueIds: [],
      rawEffects: schemaInvalidCareEffects(content),
    });

    expect(createCareCue).not.toHaveBeenCalled();
    expect(result.careCueIds).toEqual([]);
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]).toMatchObject({
      effect: "care_cue",
      reasonCode: "schema_mismatch",
    });
  });

  it("does not override persisted hypothetical status when a plausible prefix has a later hard negation", async () => {
    const content =
      "明天下午15:00请主动问我返工后缓过来了吗；如果仍然沮丧，先问我需要暂停十分钟吗，不要讲大道理。请记住这种关怀方式。不过这并不是真的。";
    const { service, createCareCue } = createService();

    const result = await service.commitTurn({
      agentId: "agent-1",
      sessionId: "session-1",
      timezone: "Asia/Shanghai",
      userMessage: message("user-1", "user", content, {
        epistemicStatus: "hypothetical",
      }),
      assistantMessage: message("assistant-1", "assistant", "我听到了。", {}),
      memoryIds: [],
      promptCueIds: [],
      rawEffects: schemaInvalidCareEffects(content),
    });

    expect(createCareCue).not.toHaveBeenCalled();
    expect(result.careCueIds).toEqual([]);
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]).toMatchObject({
      effect: "care_cue",
      reasonCode: "schema_mismatch",
    });
  });

  it.each([
    "请先听我说完以下假设：如果我下周四要做公开分享，我只想被听见，不要马上给建议。请记住这种关怀方式。",
    "请先听我说完这个设想：万一我下周四要做公开分享，我只想被听见，不要马上给建议。请记住这种关怀方式。",
  ])(
    "does not override persisted hypothetical status for a scenario-listening request: %s",
    async (content) => {
      const { service, createCareCue } = createService();

      const result = await service.commitTurn({
        agentId: "agent-1",
        sessionId: "session-1",
        timezone: "Asia/Shanghai",
        userMessage: message("user-1", "user", content, {
          epistemicStatus: "hypothetical",
        }),
        assistantMessage: message("assistant-1", "assistant", "我听到了。", {}),
        memoryIds: [],
        promptCueIds: [],
        rawEffects: schemaInvalidCareEffects(content),
      });

      expect(createCareCue).not.toHaveBeenCalled();
      expect(result.careCueIds).toEqual([]);
      expect(result.rejections).toHaveLength(1);
      expect(result.rejections[0]).toMatchObject({
        effect: "care_cue",
        reasonCode: "schema_mismatch",
      });
    },
  );

  it.each(["inner", "outer"] as const)(
    "classifies a metadata-free 万一 source as hypothetical before the %s fallback",
    async (shape) => {
      const content = "万一我下周四要公开分享，我只想被听见，不要马上给建议。";
      const { service, createCareCue } = createService();

      const result = await service.commitTurn({
        agentId: "agent-1",
        sessionId: "session-1",
        timezone: "Asia/Shanghai",
        userMessage: message("user-1", "user", content, {}),
        assistantMessage: message("assistant-1", "assistant", "我听到了。", {}),
        memoryIds: [],
        promptCueIds: [],
        rawEffects:
          shape === "inner"
            ? schemaInvalidCareEffects(content)
            : malformedContinuityEnvelope(),
      });

      expect(createCareCue).not.toHaveBeenCalled();
      expect(result.careCueIds).toEqual([]);
      expect(result.rejections).toHaveLength(1);
      expect(result.rejections[0]).toMatchObject({
        effect: shape === "inner" ? "care_cue" : "continuity_envelope",
        reasonCode: "schema_mismatch",
      });
    },
  );

  it.each(["ordinary_dialogue", "asserted_fact"] as const)(
    "projects exact T21 care from an all-invalid array when source status is %s",
    async (epistemicStatus) => {
      const content =
        "下周四我要做一次公开分享，现在有点紧张。这一刻我只想被听见，不要马上给建议。";
      const { service, createCareCue } = createService();

      const result = await service.commitTurn({
        agentId: "agent-1",
        sessionId: "session-1",
        timezone: "Asia/Shanghai",
        userMessage: message("user-1", "user", content, {
          epistemicStatus,
        }),
        assistantMessage: message("assistant-1", "assistant", "我先听着。", {}),
        memoryIds: [],
        promptCueIds: [],
        rawEffects: schemaInvalidCareEffects(content),
      });

      expect(createCareCue).toHaveBeenCalledOnce();
      expect(result.careCueIds).toEqual(["carecue-1"]);
      expect(result.rejections).toHaveLength(1);
      expect(result.rejections[0]).toMatchObject({
        effect: "care_cue",
        reasonCode: "schema_mismatch",
      });
    },
  );

  it.each([
    "小林说：「我下周四要做公开分享，我只想被听见，不要马上给建议。」",
    "假设我下周四要做公开分享，我只想被听见，不要马上给建议。这里只是举例。",
  ])(
    "keeps inner schema rejection without projecting non-authoritative care: %s",
    async (content) => {
      const { service, createCareCue } = createService();

      const result = await service.commitTurn({
        agentId: "agent-1",
        sessionId: "session-1",
        timezone: "Asia/Shanghai",
        userMessage: message("user-1", "user", content, {}),
        assistantMessage: message("assistant-1", "assistant", "我听到了。", {}),
        memoryIds: [],
        promptCueIds: [],
        rawEffects: {
          followUpCandidates: [],
          followUpTransitions: [],
          careCueCandidates: [
            {
              cueType: "listen_first",
              contextSummary: null,
              evidenceQuotes: [content],
            },
          ],
        },
      });

      expect(createCareCue).not.toHaveBeenCalled();
      expect(result.careCueIds).toEqual([]);
      expect(result.rejections).toHaveLength(1);
      expect(result.rejections[0]).toMatchObject({
        effect: "care_cue",
        reasonCode: "schema_mismatch",
      });
    },
  );

  it("does not fallback after a syntactically valid candidate is rejected by the care service", async () => {
    const content =
      "下周四我要做一次公开分享，现在有点紧张。这一刻我只想被听见，不要马上给建议。";
    const { service, createCareCue } = createService({ rejectCareCue: true });

    const result = await service.commitTurn({
      agentId: "agent-1",
      sessionId: "session-1",
      timezone: "Asia/Shanghai",
      userMessage: message("user-1", "user", content, {}),
      assistantMessage: message("assistant-1", "assistant", "我先听着。", {}),
      memoryIds: [],
      promptCueIds: [],
      rawEffects: careEffects(content),
    });

    expect(createCareCue).toHaveBeenCalledOnce();
    expect(result.careCueIds).toEqual([]);
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]).toMatchObject({
      effect: "care_cue",
      reasonCode: "ambiguous_timing",
    });
  });

  it.each([
    {
      label: "one valid non-grounded candidate",
      candidates: [
        {
          cueType: "listen_first",
          contextSummary: "用户希望先被倾听",
          mentionGuidance: "先倾听，不要马上给建议。",
          evidenceQuotes: ["模型编造的证据"],
        },
      ],
      rejectionCodes: ["missing_grounded_quote"],
    },
    {
      label: "an invalid candidate plus one valid non-grounded candidate",
      candidates: [
        {
          cueType: "listen_first",
          contextSummary: null,
          evidenceQuotes: ["这一刻我只想被听见，不要马上给建议"],
        },
        {
          cueType: "listen_first",
          contextSummary: "用户希望先被倾听",
          mentionGuidance: "先倾听，不要马上给建议。",
          evidenceQuotes: ["模型编造的证据"],
        },
      ],
      rejectionCodes: ["schema_mismatch", "missing_grounded_quote"],
    },
  ])(
    "does not fallback when the array contains $label",
    async ({ candidates, rejectionCodes }) => {
      const content =
        "下周四我要做一次公开分享，现在有点紧张。这一刻我只想被听见，不要马上给建议。";
      const { service, createCareCue } = createService();

      const result = await service.commitTurn({
        agentId: "agent-1",
        sessionId: "session-1",
        timezone: "Asia/Shanghai",
        userMessage: message("user-1", "user", content, {}),
        assistantMessage: message("assistant-1", "assistant", "我先听着。", {}),
        memoryIds: [],
        promptCueIds: [],
        rawEffects: {
          followUpCandidates: [],
          followUpTransitions: [],
          careCueCandidates: candidates,
        },
      });

      expect(createCareCue).not.toHaveBeenCalled();
      expect(result.careCueIds).toEqual([]);
      expect(
        result.rejections.map((rejection) => rejection.reasonCode),
      ).toEqual(rejectionCodes);
    },
  );
});

function createService(options: { rejectCareCue?: boolean } = {}): {
  service: ConversationContinuityService;
  createCareCue: ReturnType<typeof vi.fn>;
} {
  const createCareCue = vi.fn((input: unknown) => {
    void input;
    if (options.rejectCareCue === true) {
      return {
        accepted: false,
        rejection: {
          reasonCode: "ambiguous_timing",
          reasonSummary: "The timing could not be resolved.",
        },
      };
    }
    return {
      accepted: true,
      inserted: true,
      careCue: { id: "carecue-1" },
    };
  });
  const followUps = {
    handleUserMessage: vi.fn(() => ({
      resolvedFollowUpIds: [],
      cancelledFollowUpIds: [],
      dismissedCareCueIds: [],
    })),
    createFollowUp: vi.fn(() => {
      throw new Error("Unexpected follow-up candidate");
    }),
    createCareCue,
    recordCareCueMentions: vi.fn(() => []),
  } as unknown as FollowUpService;
  const memoryLifecycle = {
    reconcileNewMemories: vi.fn(() => []),
  } as unknown as MemoryLifecycleService;

  return {
    service: new ConversationContinuityService(
      followUps,
      {} as CheckpointService,
      memoryLifecycle,
      "off",
    ),
    createCareCue,
  };
}

function careEffects(content: string): unknown {
  return {
    followUpCandidates: [],
    followUpTransitions: [],
    careCueCandidates: [
      {
        cueType: "listen_first",
        contextSummary: content,
        mentionGuidance: "在相关语境中先听用户说完。",
        evidenceQuotes: [content],
      },
    ],
  };
}

function schemaInvalidCareEffects(content: string): unknown {
  return {
    followUpCandidates: [],
    followUpTransitions: [],
    careCueCandidates: [
      {
        cueType: "listen_first",
        contextSummary: null,
        evidenceQuotes: [content],
      },
    ],
  };
}

function malformedContinuityEnvelope(): unknown {
  return {
    followUpCandidates: [],
    followUpTransitions: [],
    careCueCandidates: null,
  };
}

function message(
  id: string,
  role: "user" | "assistant",
  content: string,
  metadata: Record<string, unknown>,
): StoredMessage {
  return {
    id,
    sessionId: "session-1",
    agentId: "agent-1",
    role,
    content,
    messageKind: role === "user" ? "user" : "assistant_reply",
    metadata,
    createdAtUtc: NOW_UTC,
  };
}
