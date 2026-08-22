import { basename } from "node:path";

import type { ScheduleItem } from "@personasim/contracts";
import { StructuredOutputError } from "@personasim/providers";
import { describe, expect, it } from "vitest";

import type { ServerConfig } from "../config.js";
import {
  acceptanceDateFor,
  acceptanceReportPathFor,
  assertDeepSeekAcceptanceConfig,
  evaluateDeepSeekAcceptance,
  containsCommittedScheduleRecall,
  containsCompleteAnchor,
  redactAcceptanceValue,
  matchSelectedAnchorEvidence,
  toSafeStructuredOutputDiagnostic,
  renderDeepSeekAcceptanceReport,
  selectSharedSlot,
  type DeepSeekAcceptanceResult,
  type AcceptanceTurn,
  type RetrievalRunRecord,
} from "./deepseek-acceptance-flow.js";

describe("DeepSeek real-network acceptance flow (offline helpers)", () => {
  it("uses a timestamp and short run id so same-day reports stay distinct", () => {
    const now = new Date("2026-08-21T18:30:00.000Z");
    const first = acceptanceReportPathFor(now, "E:/workspace", "run-alpha");
    const second = acceptanceReportPathFor(now, "E:/workspace", "run-beta");

    expect(acceptanceDateFor(now)).toBe("2026-08-22");
    expect(basename(first)).toBe(
      "ChatPLUS_Real_Network_Acceptance_2026-08-22_023000_000_run-alpha.md",
    );
    expect(second).not.toBe(first);
  });

  it("requires an explicit DeepSeek provider endpoint and model", () => {
    expect(() =>
      assertDeepSeekAcceptanceConfig(
        deepSeekConfig("https://api.deepseek.com", "deepseek-chat"),
      ),
    ).not.toThrow();
    expect(() =>
      assertDeepSeekAcceptanceConfig(
        deepSeekConfig("http://api.deepseek.com", "deepseek-chat"),
      ),
    ).toThrow(/HTTPS/iu);
    expect(() =>
      assertDeepSeekAcceptanceConfig(
        deepSeekConfig("https://user:pass@api.deepseek.com", "deepseek-chat"),
      ),
    ).toThrow(/credentials/iu);
    expect(() =>
      assertDeepSeekAcceptanceConfig(
        deepSeekConfig("https://example.com", "deepseek-chat"),
      ),
    ).toThrow(/deepseek\.com/iu);
    expect(() =>
      assertDeepSeekAcceptanceConfig(
        deepSeekConfig("https://api.deepseek.com", "some-model"),
      ),
    ).toThrow(/model/iu);
  });

  it("chooses a daytime 45-minute gap without overlapping schedule items", () => {
    const now = new Date("2026-08-22T02:00:00.000Z");
    const first = selectSharedSlot([], now, "Asia/Shanghai");
    expect(first).toMatchObject({
      startAtUtc: "2026-08-23T03:30:00.000Z",
      endAtUtc: "2026-08-23T04:15:00.000Z",
      localLabel: "2026年08月23日 11:30",
    });

    const conflict = {
      startAtUtc: first.startAtUtc,
      endAtUtc: first.endAtUtc,
    } as ScheduleItem;
    const next = selectSharedSlot([conflict], now, "Asia/Shanghai");
    expect(next.startAtUtc).toBe("2026-08-23T04:30:00.000Z");
  });

  it("searches the final morning window inside the exact 72-hour horizon", () => {
    const now = new Date("2026-08-22T02:00:00.000Z");
    const firstTwoDaysBlocked = {
      startAtUtc: "2026-08-22T23:00:00.000Z",
      endAtUtc: "2026-08-24T23:00:00.000Z",
    } as ScheduleItem;
    const thirdDay = selectSharedSlot(
      [firstTwoDaysBlocked],
      now,
      "Asia/Shanghai",
    );
    expect(thirdDay).toMatchObject({
      startAtUtc: "2026-08-24T23:30:00.000Z",
      endAtUtc: "2026-08-25T00:15:00.000Z",
      localLabel: "2026年08月25日 07:30",
    });
  });

  it("redacts credentials and Windows path variants while retaining token counts", () => {
    const secret = "sk-test-super-secret-value";
    const workspace = "E:/private/workspace";
    const redacted = redactAcceptanceValue(
      {
        apiKey: secret,
        Authorization: "Bearer " + secret,
        inputTokens: 321,
        hasApiKey: true,
        nested: {
          note:
            "provider rejected " +
            secret +
            " at E:\\private\\workspace\\file.ts and file:///E:/private/workspace/file.ts",
        },
      },
      [secret, workspace],
    );
    const text = JSON.stringify(redacted);

    expect(text).not.toContain(secret);
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("E:\\private\\workspace");
    expect(text).not.toContain("E:/private/workspace");
    expect(text).not.toContain("file:///E:/private/workspace");
    expect(redacted).toMatchObject({
      apiKey: "[REDACTED]",
      Authorization: "[REDACTED]",
      inputTokens: 321,
      hasApiKey: true,
    });
  });

  it("allowlists bounded StructuredOutputError diagnostics without leaking unsafe fields", () => {
    const secret = "sk-diagnostic-super-secret";
    const workspace = "E:/private/workspace";
    const error = Object.assign(
      new StructuredOutputError("MESSAGE_NOT_TO_LOG", [
        `identity.name: ${secret} at E:\\private\\workspace\\compile.ts`,
        "systemPrompt: DO_NOT_LOG_FULL_PROMPT",
        "raw output: RAW_MODEL_BODY",
        "x".repeat(500),
        "issue five",
        "issue six",
        "issue seven",
        "issue eight",
        "issue nine",
        "issue ten",
      ]),
      {
        rawOutput: "RAW_MODEL_BODY",
        systemPrompt: "DO_NOT_LOG_FULL_PROMPT",
        stack: "STACK_NOT_TO_LOG",
      },
    );
    const diagnostic = toSafeStructuredOutputDiagnostic(
      error,
      {
        requestId: "req-compile",
        method: "post",
        routePath: `/api/characters/generate?unsafe=${secret}`,
      },
      [secret, workspace],
    );
    const text = JSON.stringify(diagnostic);

    expect(diagnostic).toMatchObject({
      requestId: "req-compile",
      method: "POST",
      routePath: "/api/characters/generate",
      name: "StructuredOutputError",
      code: "INVALID_STRUCTURED_OUTPUT",
      issueCount: 10,
      issuesTruncated: true,
    });
    expect(diagnostic?.issues).toHaveLength(8);
    expect(diagnostic?.issues.every((issue) => issue.length <= 300)).toBe(true);
    expect(text).toContain("[REDACTED]");
    for (const unsafe of [
      secret,
      workspace,
      "RAW_MODEL_BODY",
      "DO_NOT_LOG_FULL_PROMPT",
      "STACK_NOT_TO_LOG",
      "MESSAGE_NOT_TO_LOG",
    ]) {
      expect(text).not.toContain(unsafe);
    }
    expect(
      toSafeStructuredOutputDiagnostic(new Error("ordinary"), {
        requestId: "req",
        method: "GET",
        routePath: "/",
      }),
    ).toBeUndefined();
  });

  it("requires the code, object, and location in the combined anchor text", () => {
    expect(containsCompleteAnchor(["BGW-7419", "蓝色玻璃鲸", "左口袋"])).toBe(
      true,
    );
    expect(containsCompleteAnchor(["BGW-7419", "蓝色玻璃鲸"])).toBe(false);
    expect(containsCompleteAnchor(["BGW-7419", "左口袋"])).toBe(false);
    expect(containsCompleteAnchor(["蓝色玻璃鲸", "左口袋"])).toBe(false);
  });

  it("maps every selected id to one current-turn anchored EvidenceBundle", () => {
    const distractor = retrievalRunFixture({
      runId: "run-distractor",
      sourceMessageId: "message-other",
      items: [
        {
          evidenceId: "evidence-other",
          memoryId: "memory-other",
          content: "BGW-7419 是蓝色玻璃鲸，放在左口袋。",
        },
      ],
    });
    const anchored = retrievalRunFixture({
      runId: "run-anchor",
      sourceMessageId: "message-anchor",
      items: [
        {
          evidenceId: "evidence-code-object",
          memoryId: "memory-code-object",
          content: "代号 BGW-7419 对应蓝色玻璃鲸。",
        },
        {
          evidenceId: "evidence-location",
          memoryId: "memory-location",
          content: "演讲前会把它放在左口袋。",
        },
      ],
    });
    const selectedIds = ["evidence-code-object", "evidence-location"];

    expect(
      matchSelectedAnchorEvidence(
        { selectedEvidenceIds: selectedIds },
        [distractor, anchored],
        "message-anchor",
      ),
    ).toMatchObject({
      matched: true,
      runId: "run-anchor",
      evidenceId: "evidence-code-object,evidence-location",
      memoryId: "memory-code-object,memory-location",
    });

    const missingLocation = retrievalRunFixture({
      runId: "run-missing-location",
      sourceMessageId: "message-anchor",
      items: [
        {
          evidenceId: "evidence-incomplete",
          memoryId: "memory-incomplete",
          content: "BGW-7419 是蓝色玻璃鲸。",
        },
      ],
    });
    expect(
      matchSelectedAnchorEvidence(
        { selectedEvidenceIds: ["evidence-incomplete"] },
        [missingLocation],
        "message-anchor",
      ).matched,
    ).toBe(false);
    expect(
      matchSelectedAnchorEvidence(
        { selectedEvidenceIds: selectedIds },
        [anchored],
        "different-message",
      ).matched,
    ).toBe(false);

    const misaligned = retrievalRunFixture({
      runId: "run-misaligned",
      sourceMessageId: "message-anchor",
      items: [
        {
          evidenceId: "evidence-anchor",
          memoryId: "memory-anchor",
          snapshotMemoryId: "different-memory",
          content: "BGW-7419 是蓝色玻璃鲸，放在左口袋。",
        },
      ],
    });
    expect(
      matchSelectedAnchorEvidence(
        { selectedEvidenceIds: ["evidence-anchor"] },
        [misaligned],
        "message-anchor",
      ).matched,
    ).toBe(false);
  });
  it("rejects a follow-up-only turn even when an empty care segment is marked included", () => {
    const result = fiveTurnCareResult();
    const firstTurn = result.turns[0]!;
    const careTurn = result.turns[1]!;
    firstTurn.persistence.followUps = [
      {
        id: "follow-up-only",
        sourceMessageId: firstTurn.userMessageId,
      },
    ];
    careTurn.promptSegmentTrace = includedCareTrace();

    const assertion = evaluateDeepSeekAcceptance(result).find(
      (candidate) => candidate.id === "care_followup",
    );

    expect(assertion).toMatchObject({
      id: "care_followup",
      passed: false,
    });
    expect(assertion?.evidence).toContain("care_cues=0");
    expect(assertion?.evidence).toContain("follow_ups=1");
    expect(assertion?.evidence).toContain("prompt_injected=false");
  });

  it("accepts an included care segment only when it names the source-mapped care cue", () => {
    const result = fiveTurnCareResult();
    const firstTurn = result.turns[0]!;
    const careTurn = result.turns[1]!;
    firstTurn.persistence.careCues = [
      {
        id: "care-cue-1",
        sourceMessageId: firstTurn.userMessageId,
      },
    ];
    careTurn.persistedContract = {
      continuityPromptCueIds: ["care-cue-1"],
    };
    careTurn.promptSegmentTrace = includedCareTrace();

    const assertion = evaluateDeepSeekAcceptance(result).find(
      (candidate) => candidate.id === "care_followup",
    );

    expect(assertion).toMatchObject({
      id: "care_followup",
      passed: true,
    });
    expect(assertion?.evidence).toContain("care_cues=1");
    expect(assertion?.evidence).toContain("prompt_cue_ids=1");
    expect(assertion?.evidence).toContain("prompt_injected=true");
  });

  it("accepts shared schedule evidence only with explicit model contracts and an atomic server write", () => {
    const result = validSharedScheduleResult();

    const assertion = evaluateDeepSeekAcceptance(result).find(
      (candidate) => candidate.id === "shared_schedule",
    );

    expect(assertion).toMatchObject({
      id: "shared_schedule",
      passed: true,
    });
    expect(assertion?.evidence).toContain(
      "invitation_action=model_explicit_valid:accept_user_offer",
    );
    expect(assertion?.evidence).toContain(
      "confirmation_action=model_explicit_valid:accept_pending_offer",
    );
    expect(assertion?.evidence).toContain("invitation_zero_write=true");
    expect(assertion?.evidence).toContain("confirmation_exactly_one=true");
  });

  it("rejects prose-only acceptance provenance and any extra persisted schedule write", () => {
    const proseOnly = validSharedScheduleResult();
    proseOnly.turns[2]!.persistedContract["scheduleActionAudit"] = {
      origin: "model_explicit_valid",
      kind: "none",
    };
    expect(
      evaluateDeepSeekAcceptance(proseOnly).find(
        (candidate) => candidate.id === "shared_schedule",
      ),
    ).toMatchObject({ passed: false });

    const extraWrite = validSharedScheduleResult();
    const committed = extraWrite.turns[3]!;
    committed.persistence.sharedScheduleItems.push({
      ...committed.persistence.sharedScheduleItems[0]!,
      id: "schedule-illegal-extra",
    });
    expect(
      evaluateDeepSeekAcceptance(extraWrite).find(
        (candidate) => candidate.id === "shared_schedule",
      ),
    ).toMatchObject({ passed: false });
  });

  it("requires a cross-session reply to recall the exact committed schedule semantics", () => {
    const result = validSharedScheduleResult();
    const finalTurn = result.turns[4]!;
    const sharedItem = result.turns[3]!.persistence.sharedScheduleItems[0];
    finalTurn.memoryRecall = {
      selectedEvidenceIds: ["evidence-anchor"],
    };
    finalTurn.retrievalRuns = [
      retrievalRunFixture({
        runId: "run-final-anchor",
        sourceMessageId: finalTurn.userMessageId,
        items: [
          {
            evidenceId: "evidence-anchor",
            memoryId: "memory-anchor",
            content: "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。",
          },
        ],
      }),
    ];
    finalTurn.promptSegmentTrace = {
      segments: [
        {
          id: "13_retrieved_evidence",
          placement: "prompt",
          priority: 100,
          tokenBudget: 128,
          estimatedTokens: 32,
          required: false,
          included: true,
          truncated: false,
          cacheHit: false,
        },
      ],
      droppedSegmentIds: [],
      estimatedInputTokens: 32,
    };
    finalTurn.assistantText =
      "我记得 BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋；我们还约了2026年8月23日11:30去北岸书店喝茶。";

    expect(
      containsCommittedScheduleRecall(finalTurn.assistantText, sharedItem),
    ).toBe(true);
    expect(
      evaluateDeepSeekAcceptance(result).find(
        (candidate) => candidate.id === "cross_session_recall",
      ),
    ).toMatchObject({ passed: true });

    finalTurn.assistantText =
      "我记得 BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。";
    expect(
      evaluateDeepSeekAcceptance(result).find(
        (candidate) => candidate.id === "cross_session_recall",
      ),
    ).toMatchObject({ passed: false });
  });

  it("renders a readable failure report and keeps all acceptance checks explicit", () => {
    const secret = "sk-report-secret-value";
    const result = emptyResult();
    result.characterRequest = {
      name: "顾澜",
      apiKey: secret,
      localPath: "E:\\private\\workspace\\data\\acceptance.sqlite",
    };
    result.turns = [acceptanceTurnFixture("模型文本 ~~~\n## 伪造标题")];
    result.setupExchanges = [
      {
        label: "real compile_character over HTTP",
        method: "POST",
        path: "/api/characters/generate",
        status: 500,
        durationMs: 42,
        responseBody: {
          error: {
            code: "internal_error",
            message: "Internal server error.",
            requestId: "req-compile",
          },
        },
        requestId: "req-compile",
      },
    ];
    result.structuredOutputDiagnostics = [
      {
        requestId: "req-compile",
        method: "POST",
        routePath: "/api/characters/generate",
        name: "StructuredOutputError",
        code: "INVALID_STRUCTURED_OUTPUT",
        issueCount: 1,
        issuesTruncated: false,
        issues: ["identity.name: Required"],
      },
    ];
    result.failure = {
      name: "ProviderError",
      message:
        "Bearer " + secret + " failed at file:///E:/private/workspace/file.ts",
      requestId: "req-compile",
    };
    result.assertions = evaluateDeepSeekAcceptance(result);
    const markdown = renderDeepSeekAcceptanceReport(result, [
      secret,
      "E:/private/workspace",
    ]);

    expect(result.assertions.length).toBeGreaterThanOrEqual(10);
    expect(result.assertions.every((assertion) => !assertion.passed)).toBe(
      true,
    );
    expect(markdown).toContain("模型文本 ~ ~ ~");
    expect(markdown).not.toContain("模型文本 ~~~");
    expect(markdown).toContain("# ChatPLUS Real Network Acceptance");
    expect(markdown).not.toContain("E:\\private\\workspace");
    expect(markdown).not.toContain("file:///E:/private/workspace");
    expect(markdown).toContain("## 跨新会话证据摘要");
    expect(markdown).toContain("## 运行失败");
    expect(markdown).toContain(
      "compile_character safe structured-output diagnostics",
    );
    expect(markdown).toContain("INVALID_STRUCTURED_OUTPUT");
    expect(markdown).toContain("req-compile");
    expect(markdown).toContain("[REDACTED]");
    expect(markdown).not.toContain(secret);
    expect(markdown).not.toContain("E:/private/workspace");
  });
});

function deepSeekConfig(baseUrl: string, model: string): ServerConfig {
  return {
    nodeEnv: "test",
    profile: "test",
    port: 3001,
    host: "127.0.0.1",
    webOrigin: "http://localhost:5173",
    databasePath: ":memory:",
    clockMode: "system",
    fakeClockStart: "2026-08-16T10:00:00.000Z",
    llm: {
      provider: "openai-compatible",
      baseUrl,
      apiKey: "test-placeholder-key",
      model,
      timeoutMs: 1_000,
      maxRetries: 0,
    },
    conversationRetention: {
      fullVerbatimHours: 24,
      softTokenLimit: 8_000,
      hardTokenLimit: 12_000,
      minimumTailTokens: 3_000,
      minimumRecentTurns: 12,
    },
    logLevel: "silent",
    seedDemo: false,
    developerRoutes: true,
    chatEffectsMode: "gated",
    scheduleNegotiationMode: "enforced",
    selfInitiatedPlanningMode: "enforced",
    liveWorldEffectsMode: "enforced",

    memoryRecallMode: "enforced",
    autobiographyMode: "enforced",
  };
}

function retrievalRunFixture(input: {
  runId: string;
  sourceMessageId: string;
  items: Array<{
    evidenceId: string;
    memoryId: string;
    snapshotMemoryId?: string;
    content: string;
  }>;
}): RetrievalRunRecord {
  return {
    id: input.runId,
    sourceMessageId: input.sourceMessageId,
    result: {
      abstained: false,
      selectedEvidenceIds: input.items.map((item) => item.evidenceId),
    },
    evidenceBundle: {
      evidence: input.items.map((item) => ({
        memoryId: item.memoryId,
        memoryContent: item.content,
        evidence: {
          id: item.evidenceId,
        },
      })),
    },
    inputSnapshot: {
      evidence: input.items.map((item) => ({
        id: item.evidenceId,
        memoryId: item.memoryId,
      })),
      memories: input.items.map((item) => ({
        id: item.snapshotMemoryId ?? item.memoryId,
      })),
    },
  } as unknown as RetrievalRunRecord;
}

function acceptanceTurnFixture(assistantText: string): AcceptanceTurn {
  return {
    number: 1,
    objective: "Markdown fence redaction",
    sessionId: "session-offline",
    startedNewSession: false,
    clientMessageId: "client-offline",
    userMessageId: "message-user-offline",
    userText: "普通用户文本",
    exchange: {
      label: "offline turn",
      method: "POST",
      path: "/api/sessions/session-offline/messages",
      status: 201,
      durationMs: 1,
      requestBody: {},
      responseBody: {},
    },
    assistantText,
    persistedAssistant: {},
    persistedContract: {},
    contractErrors: [],
    promptSegmentTrace: {
      segments: [],
      droppedSegmentIds: [],
      estimatedInputTokens: 1,
    },
    scheduleChanges: [],
    domainEvents: [],
    retrievalRuns: [],
    rejectedProposals: [],
    llmCalls: [],
    persistence: {
      memories: [],
      memoryEvidence: [],
      careCues: [],
      followUps: [],
      scheduleNegotiations: [],
      sharedScheduleItems: [],
    },
  } as unknown as AcceptanceTurn;
}
function fiveTurnCareResult(): DeepSeekAcceptanceResult {
  const result = emptyResult();
  result.turns = Array.from({ length: 5 }, (_, index) => {
    const turn = acceptanceTurnFixture("assistant turn " + (index + 1));
    return {
      ...turn,
      number: index + 1,
      sessionId: index === 4 ? "session-new" : "session-primary",
      startedNewSession: index === 4,
      clientMessageId: "client-" + (index + 1),
      userMessageId: "message-user-" + (index + 1),
    };
  });
  return result;
}

function validSharedScheduleResult(): DeepSeekAcceptanceResult {
  const result = fiveTurnCareResult();
  const invitationTurn = result.turns[2]!;
  const confirmationTurn = result.turns[3]!;
  const negotiationId = "negotiation-shared";
  const startAtUtc = "2026-08-23T03:30:00.000Z";
  const endAtUtc = "2026-08-23T04:15:00.000Z";
  const sharedItem = {
    id: "schedule-shared",
    agentId: "agent-offline",
    title: "北岸书店喝茶",
    description: "和用户一起去北岸书店喝茶",
    category: "social",
    startAtUtc,
    endAtUtc,
    timezone: "Asia/Shanghai",
    rigidity: "flexible",
    priority: 0.8,
    source: "user_invitation",
    adherenceProbability: 1,
    narrativeImportance: 0.8,
    shareable: true,
    stateEffects: {},
    status: "planned",
    revision: 1,
    createdAtUtc: "2026-08-22T00:00:00.000Z",
    updatedAtUtc: "2026-08-22T00:00:00.000Z",
  } as unknown as ScheduleItem;
  const pendingState = {
    id: negotiationId,
    status: "awaiting_confirmation",
    offerVersion: 1,
    details: {},
    evidenceIds: [invitationTurn.userMessageId],
    offer: {
      operation: "create",
      activity: "北岸书店喝茶",
      category: "social",
      startAtUtc,
      durationMinutes: 45,
      timezone: "Asia/Shanghai",
      version: 1,
      offeredAtUtc: "2026-08-22T00:00:00.000Z",
      evidenceIds: [invitationTurn.userMessageId],
    },
    createdAtUtc: "2026-08-22T00:00:00.000Z",
    updatedAtUtc: "2026-08-22T00:00:00.000Z",
  };

  result.sharedSlot = {
    startAtUtc,
    endAtUtc,
    localLabel: "2026年08月23日 11:30",
  };
  invitationTurn.persistedContract["scheduleActionAudit"] = {
    origin: "model_explicit_valid",
    kind: "accept_user_offer",
  };
  invitationTurn.persistence.scheduleNegotiations = [
    {
      id: negotiationId,
      sessionId: invitationTurn.sessionId,
      status: "awaiting_confirmation",
      offerVersion: 1,
      record: { negotiation: pendingState },
    },
  ];
  invitationTurn.domainEvents = [
    {
      eventType: "schedule.negotiation_offer_presented",
      correlationId: invitationTurn.clientMessageId,
      causationId: invitationTurn.userMessageId,
      payload: {
        actionKind: "accept_user_offer",
        negotiationId,
        offerVersion: 1,
      },
    },
  ] as AcceptanceTurn["domainEvents"];

  confirmationTurn.persistedContract["scheduleActionAudit"] = {
    origin: "model_explicit_valid",
    kind: "accept_pending_offer",
  };
  confirmationTurn.persistence.scheduleNegotiations = [
    {
      id: negotiationId,
      sessionId: confirmationTurn.sessionId,
      status: "committed",
      offerVersion: 1,
      record: {
        negotiation: { ...pendingState, status: "committed" },
      },
    },
  ];
  confirmationTurn.persistence.sharedScheduleItems = [sharedItem];
  confirmationTurn.scheduleChanges = [sharedItem];
  confirmationTurn.domainEvents = [
    {
      eventType: "schedule.command_committed",
      correlationId: confirmationTurn.clientMessageId,
      payload: {
        operation: "create",
        negotiationId,
        changedItemIds: [sharedItem.id],
      },
    },
  ] as AcceptanceTurn["domainEvents"];
  return result;
}

function includedCareTrace(): AcceptanceTurn["promptSegmentTrace"] {
  return {
    segments: [
      {
        id: "07z_followup_context",
        placement: "prompt",
        priority: 100,
        tokenBudget: 64,
        estimatedTokens: 0,
        required: false,
        included: true,
        truncated: false,
        cacheHit: false,
      },
    ],
    droppedSegmentIds: [],
    estimatedInputTokens: 1,
  };
}

function emptyResult(): DeepSeekAcceptanceResult {
  return {
    runId: "offline-test",
    acceptanceDate: "2026-08-22",
    startedAtUtc: "2026-08-22T00:00:00.000Z",
    completedAtUtc: "2026-08-22T00:00:01.000Z",
    elapsedMs: 1_000,
    passed: false,
    reportPath:
      "E:/private/workspace/docs/reports/ChatPLUS_Real_Network_Acceptance_2026-08-22.md",
    databasePath: "tmp/real-network-acceptance/offline.sqlite",
    config: {
      provider: "openai-compatible",
      model: "deepseek-chat",
      providerOrigin: "https://api.deepseek.com",
      profile: "deepseek-real-network-acceptance",
      clockMode: "system",
      flags: {
        chatEffectsMode: "gated",
        scheduleNegotiationMode: "enforced",
        selfInitiatedPlanningMode: "enforced",
        liveWorldEffectsMode: "enforced",
        memoryRecallMode: "enforced",
        autobiographyMode: "enforced",
      },
      promptTokenBudget: 8_192,
    },
    characterRequest: {},
    setupExchanges: [],
    turns: [],
    llmCalls: [],
    structuredOutputDiagnostics: [],
    assertions: [],
  };
}
