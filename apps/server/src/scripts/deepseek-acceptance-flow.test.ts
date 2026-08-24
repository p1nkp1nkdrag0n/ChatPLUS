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
  LlmCallSchema,
  containsCommittedScheduleRecall,
  containsCompleteAnchor,
  redactAcceptanceValue,
  matchSelectedAnchorEvidence,
  toSafeStructuredOutputDiagnostic,
  renderDeepSeekAcceptanceReport,
  revalidateSharedSlot,
  selectSharedSlot,
  type DeepSeekAcceptanceResult,
  type AcceptanceTurn,
  type RetrievalRunRecord,
} from "./deepseek-acceptance-flow.js";

describe("DeepSeek real-network acceptance flow (offline helpers)", () => {
  it("rejects contradictory exact physical-attempt telemetry at the API boundary", () => {
    expect(() =>
      LlmCallSchema.parse({
        id: "llm-invalid",
        purpose: "reply_generation",
        provider: "openai-compatible",
        model: "deepseek-chat",
        inputTokens: 1,
        outputTokens: 1,
        attemptCount: 1,
        failedAttemptCount: 2,
        providerInputUsageAttemptCount: 2,
        providerOutputUsageAttemptCount: 1,
        attemptTelemetrySource: "exact",
        latencyMs: 1,
        success: true,
        createdAtUtc: "2026-08-22T00:00:00.000Z",
      }),
    ).toThrow();
  });
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

  it("reselects against authoritative schedule when a late self-plan occupies the published slot", () => {
    const now = new Date("2026-08-22T02:00:00.000Z");
    const publishedSlot = selectSharedSlot([], now, "Asia/Shanghai");
    const lateSelfPlan = {
      startAtUtc: "2026-08-23T03:15:00.000Z",
      endAtUtc: "2026-08-23T04:15:00.000Z",
      source: "self_initiated",
    } as ScheduleItem;

    const invitationSlot = revalidateSharedSlot(
      publishedSlot,
      [lateSelfPlan],
      now,
      "Asia/Shanghai",
    );

    expect(publishedSlot.startAtUtc).toBe("2026-08-23T03:30:00.000Z");
    expect(invitationSlot).toMatchObject({
      startAtUtc: "2026-08-23T04:30:00.000Z",
      endAtUtc: "2026-08-23T05:15:00.000Z",
      localLabel: "2026年08月23日 12:30",
    });
  });

  it("finds a real 45-minute gap even when every preferred half-hour candidate overlaps", () => {
    const now = new Date("2026-08-22T02:00:00.000Z");
    const denseSchedule = [
      {
        startAtUtc: "2026-08-22T23:30:00.000Z",
        endAtUtc: "2026-08-23T09:00:00.000Z",
        status: "planned",
      },
      {
        startAtUtc: "2026-08-23T10:00:00.000Z",
        endAtUtc: "2026-08-23T14:15:00.000Z",
        status: "planned",
      },
    ] as ScheduleItem[];

    expect(selectSharedSlot(denseSchedule, now, "Asia/Shanghai")).toMatchObject(
      {
        startAtUtc: "2026-08-23T09:00:00.000Z",
        endAtUtc: "2026-08-23T09:45:00.000Z",
        localLabel: "2026年08月23日 17:00",
      },
    );
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

  it("passes all five split-pipeline semantic assertions from offline evidence", () => {
    const result = semanticAcceptanceResult();
    const assertions = new Map(
      evaluateDeepSeekAcceptance(result).map((assertion) => [
        assertion.id,
        assertion,
      ]),
    );

    for (const id of [
      "non_schedule_isolation",
      "objective_reply_alignment",
      "reply_mutation_independence",
      "split_call_audit",
      "no_technical_fallback_language",
    ]) {
      expect(assertions.get(id), id).toMatchObject({ id, passed: true });
    }
    expect(assertions.get("split_call_audit")?.evidence).toContain(
      "reply_generation=5/5",
    );
    expect(assertions.get("split_call_audit")?.evidence).toContain(
      "chat_turn=0",
    );
    expect(assertions.get("split_call_audit")?.evidence).toContain(
      "model_origin_turns=4",
    );
  });

  it("fails the real-call gate when retry usage covers only some attempts", () => {
    const result = semanticAcceptanceResult();
    result.llmCalls.unshift(
      llmCallFixture("compile-character", "compile_character"),
    );
    expect(
      evaluateDeepSeekAcceptance(result).find(
        (assertion) => assertion.id === "llm_calls",
      ),
    ).toMatchObject({ passed: true });

    const partial = result.llmCalls[0]!;
    partial.attemptCount = 2;
    partial.failedAttemptCount = 1;
    partial.providerInputUsageAttemptCount = 1;
    partial.providerOutputUsageAttemptCount = 1;
    expect(
      evaluateDeepSeekAcceptance(result).find(
        (assertion) => assertion.id === "llm_calls",
      ),
    ).toMatchObject({ passed: false });
  });

  it("rejects non-schedule routing leakage and technical fallback language", () => {
    const routedAsSchedule = semanticAcceptanceResult();
    routedAsSchedule.turns[0]!.persistedContract["turnRoute"] =
      "schedule_mutation";
    expect(
      evaluateDeepSeekAcceptance(routedAsSchedule).find(
        (assertion) => assertion.id === "non_schedule_isolation",
      ),
    ).toMatchObject({ passed: false });

    const leakedInternals = semanticAcceptanceResult();
    leakedInternals.turns[1]!.assistantText =
      "reply_generation 的 JSON schema 解析失败，fallback 后日程保持不变。";
    const leakedAssertions = evaluateDeepSeekAcceptance(leakedInternals);
    expect(
      leakedAssertions.find(
        (assertion) => assertion.id === "non_schedule_isolation",
      ),
    ).toMatchObject({ passed: false });
    expect(
      leakedAssertions.find(
        (assertion) => assertion.id === "no_technical_fallback_language",
      ),
    ).toMatchObject({ passed: false });
  });

  it("checks objective alignment independently from reply mutation authorization", () => {
    const baseline = semanticAcceptanceResult();
    const reworded = semanticAcceptanceResult();
    reworded.turns[2]!.assistantText =
      "我愿意去北岸书店喝茶；先保持待确认，等你确认后再落实安排。";
    reworded.turns[3]!.assistantText = "嗯，可以，北岸书店喝茶的安排确认了。";
    expect({
      scheduleChanges: reworded.turns[3]!.scheduleChanges,
      domainEvents: reworded.turns[3]!.domainEvents,
      sharedScheduleItems: reworded.turns[3]!.persistence.sharedScheduleItems,
    }).toEqual({
      scheduleChanges: baseline.turns[3]!.scheduleChanges,
      domainEvents: baseline.turns[3]!.domainEvents,
      sharedScheduleItems: baseline.turns[3]!.persistence.sharedScheduleItems,
    });
    expect(
      evaluateDeepSeekAcceptance(reworded).find(
        (assertion) => assertion.id === "reply_mutation_independence",
      ),
    ).toMatchObject({ passed: true });

    reworded.turns[4]!.assistantText = "我记得你问过这件事。";
    expect(
      evaluateDeepSeekAcceptance(reworded).find(
        (assertion) => assertion.id === "objective_reply_alignment",
      ),
    ).toMatchObject({ passed: false });

    const replyAuthorized = semanticAcceptanceResult();
    replyAuthorized.turns[3]!.persistedContract["replyMutationAuthorization"] =
      "enabled";
    expect(
      evaluateDeepSeekAcceptance(replyAuthorized).find(
        (assertion) => assertion.id === "reply_mutation_independence",
      ),
    ).toMatchObject({ passed: false });
  });

  it("maps understanding calls to model origins without charging deterministic turns", () => {
    const fallback = semanticAcceptanceResult();
    fallback.turns[0]!.persistedContract["understandingOrigin"] = "fallback";
    const fallbackUnderstanding = fallback.turns[0]!.llmCalls.find(
      (call) => call.purpose === "turn_understanding",
    )!;
    fallbackUnderstanding.success = false;
    fallbackUnderstanding.errorCode = "INVALID_STRUCTURED_OUTPUT";
    expect(
      evaluateDeepSeekAcceptance(fallback).find(
        (assertion) => assertion.id === "split_call_audit",
      ),
    ).toMatchObject({ passed: true });

    const deterministicCall = semanticAcceptanceResult();
    const unexpectedUnderstanding = llmCallFixture(
      "understanding-unexpected",
      "turn_understanding",
    );
    deterministicCall.turns[3]!.llmCalls.push(unexpectedUnderstanding);
    deterministicCall.llmCalls.push(unexpectedUnderstanding);
    expect(
      evaluateDeepSeekAcceptance(deterministicCall).find(
        (assertion) => assertion.id === "split_call_audit",
      ),
    ).toMatchObject({ passed: false });

    const missingModelCall = semanticAcceptanceResult();
    const missingId = missingModelCall.turns[0]!.llmCalls.find(
      (call) => call.purpose === "turn_understanding",
    )!.id;
    missingModelCall.turns[0]!.llmCalls =
      missingModelCall.turns[0]!.llmCalls.filter(
        (call) => call.id !== missingId,
      );
    missingModelCall.llmCalls = missingModelCall.llmCalls.filter(
      (call) => call.id !== missingId,
    );
    expect(
      evaluateDeepSeekAcceptance(missingModelCall).find(
        (assertion) => assertion.id === "split_call_audit",
      ),
    ).toMatchObject({ passed: false });

    const legacyCall = semanticAcceptanceResult();
    const chatTurn = llmCallFixture("legacy-chat", "chat_turn");
    legacyCall.turns[0]!.llmCalls.push(chatTurn);
    legacyCall.llmCalls.push(chatTurn);
    expect(
      evaluateDeepSeekAcceptance(legacyCall).find(
        (assertion) => assertion.id === "split_call_audit",
      ),
    ).toMatchObject({ passed: false });

    const missingReply = semanticAcceptanceResult();
    const replyId = missingReply.turns[2]!.llmCalls.find(
      (call) => call.purpose === "reply_generation",
    )!.id;
    missingReply.turns[2]!.llmCalls = missingReply.turns[2]!.llmCalls.filter(
      (call) => call.id !== replyId,
    );
    missingReply.llmCalls = missingReply.llmCalls.filter(
      (call) => call.id !== replyId,
    );
    expect(
      evaluateDeepSeekAcceptance(missingReply).find(
        (assertion) => assertion.id === "split_call_audit",
      ),
    ).toMatchObject({ passed: false });
  });

  it("requires split-only prompt segments only when the split path is enforced", () => {
    const result = fiveTurnCareResult();
    for (const turn of result.turns) {
      turn.promptSegmentTrace = requiredPromptTraceFixture(false);
    }

    result.config.flags.turnPipelineMode = "legacy";
    expect(
      evaluateDeepSeekAcceptance(result).find(
        (assertion) => assertion.id === "prompt_trace",
      ),
    ).toMatchObject({ passed: true });

    result.config.flags.turnPipelineMode = "shadow";
    expect(
      evaluateDeepSeekAcceptance(result).find(
        (assertion) => assertion.id === "prompt_trace",
      ),
    ).toMatchObject({ passed: true });

    result.config.flags.turnPipelineMode = "enforced";
    expect(
      evaluateDeepSeekAcceptance(result).find(
        (assertion) => assertion.id === "prompt_trace",
      ),
    ).toMatchObject({ passed: false });

    for (const turn of result.turns) {
      turn.promptSegmentTrace = requiredPromptTraceFixture(true);
    }
    const splitPromptAssertion = evaluateDeepSeekAcceptance(result).find(
      (assertion) => assertion.id === "prompt_trace",
    );
    expect(splitPromptAssertion).toMatchObject({ passed: true });
    expect(splitPromptAssertion?.evidence).toContain(
      "16a_validated_turn_outcome",
    );
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

  it("accepts shared schedule evidence only with grounded split contracts and an atomic server write", () => {
    const result = validSharedScheduleResult();

    expect(result.turns[2]!.persistedContract).not.toHaveProperty(
      "scheduleActionAudit",
    );
    expect(result.turns[3]!.persistedContract).not.toHaveProperty(
      "scheduleActionAudit",
    );

    const assertion = evaluateDeepSeekAcceptance(result).find(
      (candidate) => candidate.id === "shared_schedule",
    );

    expect(assertion).toMatchObject({
      id: "shared_schedule",
      passed: true,
    });
    expect(assertion?.evidence).toContain(
      "invitation_contract=split:create_shared_activity:pending_confirmation",
    );
    expect(assertion?.evidence).toContain(
      "confirmation_contract=split:confirm_pending_offer:committed",
    );
    expect(assertion?.evidence).toContain("invitation_zero_write=true");
    expect(assertion?.evidence).toContain("confirmation_exactly_one=true");
  });

  it("keeps the shared-schedule assertion compatible with a legacy rollback run", () => {
    const result = validSharedScheduleResult();
    result.config.flags.turnPipelineMode = "legacy";
    result.turns[2]!.persistedContract["scheduleActionAudit"] = {
      origin: "model_explicit_valid",
      kind: "accept_user_offer",
    };
    result.turns[3]!.persistedContract["scheduleActionAudit"] = {
      origin: "model_explicit_valid",
      kind: "accept_pending_offer",
    };

    const assertion = evaluateDeepSeekAcceptance(result).find(
      (candidate) => candidate.id === "shared_schedule",
    );

    expect(assertion).toMatchObject({ passed: true });
    expect(assertion?.evidence).toContain(
      "invitation_contract=model_explicit_valid:accept_user_offer",
    );
    expect(assertion?.evidence).toContain(
      "confirmation_contract=model_explicit_valid:accept_pending_offer",
    );
  });

  it("rejects an ungrounded split schedule intent and any extra persisted schedule write", () => {
    const proseOnly = validSharedScheduleResult();
    const invitationUnderstanding = proseOnly.turns[2]!.domainEvents.find(
      (event) => event.eventType === "conversation.turn_understanding_resolved",
    );
    if (
      invitationUnderstanding === undefined ||
      typeof invitationUnderstanding.payload !== "object" ||
      invitationUnderstanding.payload === null
    ) {
      throw new Error("Expected a split understanding event fixture");
    }
    (invitationUnderstanding.payload as Record<string, unknown>)[
      "scheduleIntentKind"
    ] = "none";
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
      containsCommittedScheduleRecall(
        finalTurn.assistantText,
        sharedItem,
        result.startedAtUtc,
      ),
    ).toBe(true);
    expect(
      evaluateDeepSeekAcceptance(result).find(
        (candidate) => candidate.id === "cross_session_recall",
      ),
    ).toMatchObject({ passed: true });

    finalTurn.assistantText =
      "BGW-7419 是你那枚蓝色玻璃鲸的代号，你会在重要演讲前把它放在左口袋里。至于刚确认的安排，我们约好明天（8月23日）11:30 在梧桐路23号的北岸书店喝茶，预计45分钟。如果我没记错的话。";
    expect(
      containsCommittedScheduleRecall(
        finalTurn.assistantText,
        sharedItem,
        result.startedAtUtc,
      ),
    ).toBe(true);
    expect(
      evaluateDeepSeekAcceptance(result).find(
        (candidate) => candidate.id === "cross_session_recall",
      ),
    ).toMatchObject({ passed: true });

    finalTurn.assistantText =
      "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。我们明天11:30去北岸书店喝茶。";
    expect(
      containsCommittedScheduleRecall(
        finalTurn.assistantText,
        sharedItem,
        result.startedAtUtc,
      ),
    ).toBe(true);

    const contradictedReply =
      "BGW-7419 不是蓝色玻璃鲸，也不在左口袋；我们没有确认8月23日11:30去北岸书店喝茶。";
    expect(containsCompleteAnchor(contradictedReply)).toBe(false);
    expect(
      containsCommittedScheduleRecall(
        contradictedReply,
        sharedItem,
        result.startedAtUtc,
      ),
    ).toBe(false);
    finalTurn.assistantText = contradictedReply;
    expect(
      evaluateDeepSeekAcceptance(result).find(
        (candidate) => candidate.id === "cross_session_recall",
      ),
    ).toMatchObject({ passed: false });

    expect(
      containsCompleteAnchor("BGW-7419 是蓝色玻璃鲸吗，演讲前放在左口袋吗？"),
    ).toBe(false);

    for (const assistantText of [
      "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。我们约在2025年8月23日11:30去北岸书店喝茶。",
      "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。我们约在8月24日11:30去北岸书店喝茶。",
      "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。我们明天（8月24日）11:30去北岸书店喝茶。",
      "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。我们约在8月23日去北岸书店喝茶。",
      "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。原定8月23日11:30去北岸书店喝茶，但安排已经取消了。",
      "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。我们8月23日11:30不会去北岸书店喝茶。",
      "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。我不确定是不是8月23日11:30去北岸书店喝茶。",
      "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。你是在问我们是否约了8月23日11:30去北岸书店喝茶吗？",
      "我记得 BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。",
    ]) {
      finalTurn.assistantText = assistantText;
      expect(
        containsCommittedScheduleRecall(
          finalTurn.assistantText,
          sharedItem,
          result.startedAtUtc,
        ),
      ).toBe(false);
      expect(
        evaluateDeepSeekAcceptance(result).find(
          (candidate) => candidate.id === "cross_session_recall",
        ),
      ).toMatchObject({ passed: false });
    }
  });

  it("renders a readable failure report and keeps all acceptance checks explicit", () => {
    const secret = "sk-report-secret-value";
    const unsafePrompt = "UNSAFE_SYSTEM_PROMPT_BODY";
    const unsafeRawOutput = "UNSAFE_RAW_PROVIDER_OUTPUT";
    const result = emptyResult();
    result.characterRequest = {
      name: "顾澜",
      apiKey: secret,
      localPath: "E:\\private\\workspace\\data\\acceptance.sqlite",
    };
    const reportTurn = acceptanceTurnFixture("模型文本 ~~~\n## 伪造标题");
    reportTurn.persistedContract = {
      turnRoute: "conversation",
      understandingOrigin: "model_valid",
      scheduleOutcomeKind: "none",
      replyMutationAuthorization: "disabled",
    };
    reportTurn.persistedAssistant = {
      id: "assistant-report",
      sessionId: reportTurn.sessionId,
      agentId: "agent-offline",
      role: "assistant",
      content: reportTurn.assistantText,
      messageKind: "assistant_reply",
      metadata: {
        ...reportTurn.persistedContract,
        systemPrompt: unsafePrompt,
        rawOutput: unsafeRawOutput,
      },
      createdAtUtc: "2026-08-22T00:00:00.000Z",
    };
    const retriedCall = {
      ...llmCallFixture("reply-retried", "reply_generation"),
      attemptCount: 2,
      failedAttemptCount: 1,
    };
    reportTurn.llmCalls = [retriedCall];
    result.turns = [reportTurn];
    result.llmCalls = [retriedCall];
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
    expect(markdown).toContain("Attempts / failed");
    expect(markdown).toContain("| 2 / 1 |");
    expect(markdown).toContain(
      "compile_character safe structured-output diagnostics",
    );
    expect(markdown).toContain("INVALID_STRUCTURED_OUTPUT");
    expect(markdown).toContain("req-compile");
    for (const id of [
      "non_schedule_isolation",
      "objective_reply_alignment",
      "reply_mutation_independence",
      "split_call_audit",
      "no_technical_fallback_language",
    ]) {
      expect(markdown).toContain(`| FAIL | ${id} |`);
    }
    expect(markdown).toContain("| turnPipelineMode | enforced |");
    expect(markdown).toContain("| personaContextMode | enforced |");
    expect(markdown).toContain('"turnRoute": "conversation"');
    expect(markdown).not.toContain(unsafePrompt);
    expect(markdown).not.toContain(unsafeRawOutput);
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
    turnPipelineMode: "enforced",
    personaContextMode: "enforced",
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
  Object.assign(invitationTurn.persistedContract, {
    turnPipelineMode: "enforced",
    turnRoute: "schedule_mutation",
    understandingOrigin: "model_valid",
    scheduleOutcomeKind: "pending_confirmation",
  });
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
      eventType: "conversation.turn_understanding_resolved",
      correlationId: invitationTurn.clientMessageId,
      causationId: invitationTurn.userMessageId,
      payload: {
        route: "schedule_mutation",
        scheduleIntentKind: "create_shared_activity",
      },
    },
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

  Object.assign(confirmationTurn.persistedContract, {
    turnPipelineMode: "enforced",
    turnRoute: "schedule_mutation",
    understandingOrigin: "deterministic",
    scheduleOutcomeKind: "committed",
  });
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
      eventType: "conversation.turn_understanding_resolved",
      correlationId: confirmationTurn.clientMessageId,
      causationId: confirmationTurn.userMessageId,
      payload: {
        route: "schedule_mutation",
        scheduleIntentKind: "confirm_pending_offer",
      },
    },
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

function semanticAcceptanceResult(): DeepSeekAcceptanceResult {
  const result = validSharedScheduleResult();
  const assistantTexts = [
    "我记住了：BGW-7419，也听见你想到博士资格面谈时会紧张。",
    "听起来这场面谈确实让你紧张，我陪你先用十分钟梳理准备步骤。",
    "我愿意去北岸书店喝茶；先作为待确认的共同安排，等你确认后再落实。",
    "确认好了，我们约定去北岸书店喝茶，到时候见。",
    "BGW-7419 是蓝色玻璃鲸，你演讲前会把它放在左口袋；我们约在2026年8月23日11:30去北岸书店喝茶。",
  ] as const;
  const routes = [
    "explicit_memory",
    "continuity",
    "schedule_mutation",
    "schedule_mutation",
    "schedule_query",
  ] as const;
  const origins = [
    "model_valid",
    "model_valid",
    "model_partial",
    "deterministic",
    "model_valid",
  ] as const;
  const scheduleOutcomeKinds = [
    "none",
    "none",
    "pending_confirmation",
    "committed",
    "read_only",
  ] as const;

  for (const [index, turn] of result.turns.entries()) {
    turn.assistantText = assistantTexts[index]!;
    Object.assign(turn.persistedContract, {
      turnRoute: routes[index],
      understandingOrigin: origins[index],
      scheduleOutcomeKind: scheduleOutcomeKinds[index],
      replyMutationAuthorization: "disabled",
    });
    turn.llmCalls = [llmCallFixture(`reply-${index + 1}`, "reply_generation")];
    if (origins[index] !== "deterministic") {
      turn.llmCalls.unshift(
        llmCallFixture(`understanding-${index + 1}`, "turn_understanding"),
      );
    }
  }
  result.llmCalls = result.turns.flatMap((turn) => turn.llmCalls);
  return result;
}

function llmCallFixture(
  id: string,
  purpose: string,
  success = true,
): AcceptanceTurn["llmCalls"][number] {
  return {
    id,
    agentId: "agent-offline",
    purpose,
    provider: "openai-compatible",
    model: "deepseek-chat",
    inputTokens: 100,
    outputTokens: success ? 20 : 0,
    providerInputTokens: 100,
    providerOutputTokens: success ? 20 : 0,
    usageSource: "provider",
    attemptCount: 1,
    failedAttemptCount: success ? 0 : 1,
    providerInputUsageAttemptCount: 1,
    providerOutputUsageAttemptCount: 1,
    attemptTelemetrySource: "exact",
    latencyMs: 10,
    success,
    ...(success ? {} : { errorCode: "INVALID_STRUCTURED_OUTPUT" }),
    createdAtUtc: "2026-08-22T00:00:00.000Z",
  };
}

function requiredPromptTraceFixture(
  split: boolean,
): AcceptanceTurn["promptSegmentTrace"] {
  const ids = [
    "01_app_policy",
    "02_character_identity",
    "03_core_persona",
    "05_boundaries",
    ...(split ? ["08_runtime_state"] : []),
    "10_current_time",
    "15_reply_strategy",
    "16_user_message",
    ...(split ? ["16a_validated_turn_outcome"] : []),
    "17_output_contract",
  ];
  return {
    segments: ids.map((id) => ({
      id,
      placement: /^0[1-5]_/u.test(id) ? "system" : "prompt",
      priority: 100,
      tokenBudget: 128,
      estimatedTokens: 8,
      required: true,
      included: true,
      truncated: false,
      cacheHit: false,
    })),
    droppedSegmentIds: [],
    estimatedInputTokens: ids.length * 8,
  };
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
        turnPipelineMode: "enforced",
        personaContextMode: "enforced",
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
