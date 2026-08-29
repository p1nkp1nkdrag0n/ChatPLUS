import type { SendMessageResponse } from "@personasim/contracts";
import { describe, expect, it } from "vitest";

import type {
  HardAssertion,
  LongRunTurnSpec,
} from "../scenarios/companion-long-run-v2-types.js";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import type { RetrievalRun } from "../repositories/retrieval-run-repository.js";
import {
  evaluateLongRunV2HardAssertions,
  type HardAssertionEvaluationInput,
} from "./companion-long-run-v2-assertions.js";
import type { ScenarioActionResult } from "./companion-long-run-v2-runtime.js";
import type {
  HardAssertionResult,
  LogicalCallTrace,
  LongRunStateSnapshot,
} from "./companion-long-run-v2-run-types.js";

const T0 = "2026-09-01T01:00:00.000Z";
const T1 = "2026-09-02T01:00:00.000Z";
const T2 = "2026-09-03T01:00:00.000Z";

describe("companion long-run v2 hard assertions", () => {
  describe("memory evidence and supersession", () => {
    it("uses the real SQLite superseded_by_id column", () => {
      const database = openDatabase(":memory:");
      try {
        runMigrations(database);
        const columns = (
          database.pragma("table_info(memories)") as Array<{ name: string }>
        ).map((column) => column.name);
        expect(columns).toContain("superseded_by_id");
        expect(columns).not.toContain("superseded_by_memory_id");
      } finally {
        database.close();
      }
    });

    it("requires a grounded replacement and a valid superseded_by_id link", () => {
      const oldMemory = memoryRow("memory-old", {
        claim_subject_key: "preference:drink",
      });
      const replacement = memoryRow("memory-new", {
        claim_subject_key: "preference:drink",
        content: "The user now prefers warm water.",
        source_message_id: "message-user",
      });
      const correctedOld = {
        ...oldMemory,
        status: "superseded",
        superseded_by_id: "memory-new",
      };

      expect(
        status(
          evaluate(["memory_correction_supersedes"], {
            before: snapshot({ memories: [oldMemory] }),
            after: snapshot({ memories: [correctedOld, replacement] }),
          }),
          "memory_correction_supersedes",
        ),
      ).toBe("PASS");

      expect(
        status(
          evaluate(["memory_correction_supersedes"], {
            before: snapshot({ memories: [oldMemory] }),
            after: snapshot({
              memories: [
                {
                  ...oldMemory,
                  status: "superseded",
                  superseded_by_memory_id: "memory-new",
                },
                replacement,
              ],
            }),
          }),
          "memory_correction_supersedes",
        ),
      ).toBe("FAIL");
    });

    it("does not treat absent source columns as grounded", () => {
      expect(
        status(evaluate(["memory_write_grounded"]), "memory_write_grounded"),
      ).toBe("FAIL");

      const ungrounded = memoryRow("memory-new", {
        source_message_id: undefined,
        source_event_id: undefined,
      });
      expect(
        status(
          evaluate(["memory_write_grounded"], {
            after: snapshot({ memories: [ungrounded] }),
          }),
          "memory_write_grounded",
        ),
      ).toBe("FAIL");

      const evidence = evidenceRow("evidence-1", "memory-new");
      expect(
        status(
          evaluate(["memory_write_grounded"], {
            after: snapshot({
              memories: [ungrounded],
              memoryEvidence: [evidence],
            }),
          }),
          "memory_write_grounded",
        ),
      ).toBe("PASS");
    });

    it("binds projected recall ids through the current retrieval run", () => {
      const memory = memoryRow("memory-1");
      const evidence = evidenceRow("evidence-1", "memory-1");
      const selected = response({
        memoryRecall: {
          selectedMemoryIds: ["memory-1"],
          selectedEvidenceIds: ["evidence-1"],
          abstained: false,
        },
      });
      expect(
        status(
          evaluate(["memory_recall_evidence_bound"], {
            response: selected,
            retrievalRuns: [retrievalRun(memory, evidence)],
            // Hierarchy projection ids intentionally need not exist in the
            // durable memory_evidence table captured after the turn.
            after: snapshot({ messages: [{ id: "message-user" }] }),
          }),
          "memory_recall_evidence_bound",
        ),
      ).toBe("PASS");

      expect(
        status(
          evaluate(["memory_recall_evidence_bound"], {
            response: selected,
            retrievalRuns: [
              retrievalRun(
                { ...memory, status: "superseded", superseded_by_id: "other" },
                evidence,
              ),
            ],
            after: snapshot({ messages: [{ id: "message-user" }] }),
          }),
          "memory_recall_evidence_bound",
        ),
      ).toBe("FAIL");
    });

    it("rejects a retrieval bundle whose source lineage differs from its input snapshot", () => {
      const memory = memoryRow("memory-1");
      const evidence = evidenceRow("evidence-1", "memory-1");
      const run = retrievalRun(memory, evidence);
      const broken = {
        ...run,
        evidenceBundle: {
          ...run.evidenceBundle!,
          evidence: run.evidenceBundle!.evidence.map((item) => ({
            ...item,
            evidence: { ...item.evidence, sourceId: "message-other" },
          })),
        },
      } as RetrievalRun;
      expect(
        status(
          evaluate(["memory_recall_evidence_bound"], {
            response: response({
              memoryRecall: {
                selectedMemoryIds: ["memory-1"],
                selectedEvidenceIds: ["evidence-1"],
                abstained: false,
              },
            }),
            retrievalRuns: [broken],
          }),
          "memory_recall_evidence_bound",
        ),
      ).toBe("FAIL");
    });
  });

  describe("invitation and autonomous schedule writes", () => {
    it("accepts a self-initiated plan outside scheduleChanges only with full lineage", () => {
      const selfPlan = selfPlanItem();
      const after = snapshot({
        schedule: [selfPlan],
        domainEvents: selfPlanEvents(),
      });
      const results = evaluate(
        ["no_unvalidated_write", "schedule_requires_server_commit"],
        { after },
      );
      expect(status(results, "no_unvalidated_write")).toBe("PASS");
      expect(status(results, "schedule_requires_server_commit")).toBe("PASS");

      const broken = snapshot({
        schedule: [selfPlan],
        domainEvents: selfPlanEvents().filter(
          (event) => event.eventType !== "self_plan.committed",
        ),
      });
      const brokenResults = evaluate(
        ["no_unvalidated_write", "schedule_requires_server_commit"],
        { after: broken },
      );
      expect(status(brokenResults, "no_unvalidated_write")).toBe("FAIL");
      expect(status(brokenResults, "schedule_requires_server_commit")).toBe(
        "FAIL",
      );
    });

    it("requires a new user invitation in both the response and command lineage", () => {
      const invitation = invitationItem("schedule-invite");
      const command = scheduleCommandEvent(invitation.id);
      const committed = evaluate(
        ["no_unvalidated_write", "schedule_requires_server_commit"],
        {
          response: response({ scheduleChanges: [invitation] }),
          after: snapshot({ schedule: [invitation], domainEvents: [command] }),
        },
      );
      expect(status(committed, "no_unvalidated_write")).toBe("PASS");
      expect(status(committed, "schedule_requires_server_commit")).toBe("PASS");

      expect(
        status(
          evaluate(["no_unvalidated_write"], {
            after: snapshot({
              schedule: [invitation],
              domainEvents: [command],
            }),
          }),
          "no_unvalidated_write",
        ),
      ).toBe("FAIL");
      expect(
        status(
          evaluate(["schedule_requires_server_commit"], {
            response: response({ scheduleChanges: [invitation] }),
            after: snapshot({ schedule: [invitation] }),
          }),
          "schedule_requires_server_commit",
        ),
      ).toBe("FAIL");
    });

    it("checks pending no-write only for user_invitation rows", () => {
      const existing = invitationItem("schedule-existing");
      const settledExisting = { ...existing, status: "completed", revision: 2 };
      expect(
        status(
          evaluate(["schedule_unchanged"], {
            before: snapshot({ schedule: [existing] }),
            after: snapshot({ schedule: [settledExisting, selfPlanItem()] }),
          }),
          "schedule_unchanged",
        ),
      ).toBe("PASS");

      expect(
        status(
          evaluate(["schedule_unchanged"], {
            before: snapshot({ schedule: [existing] }),
            after: snapshot({
              schedule: [existing, invitationItem("schedule-unconfirmed")],
            }),
          }),
          "schedule_unchanged",
        ),
      ).toBe("FAIL");
    });

    it("requires one invitation on confirmation and zero on later reads", () => {
      const invitation = invitationItem("schedule-confirmed");
      const selfPlan = selfPlanItem();
      const confirmation = evaluate(
        ["schedule_requires_server_commit", "schedule_exactly_once"],
        {
          response: response({ scheduleChanges: [invitation] }),
          after: snapshot({
            schedule: [invitation, selfPlan],
            domainEvents: [
              scheduleCommandEvent(invitation.id),
              ...selfPlanEvents(),
            ],
          }),
        },
      );
      expect(status(confirmation, "schedule_exactly_once")).toBe("PASS");

      expect(
        status(
          evaluate(["schedule_exactly_once"], {
            before: snapshot({ schedule: [invitation, selfPlan] }),
            after: snapshot({ schedule: [invitation, selfPlan] }),
          }),
          "schedule_exactly_once",
        ),
      ).toBe("PASS");

      const duplicate = {
        ...invitation,
        id: "schedule-duplicate",
      };
      expect(
        status(
          evaluate(["schedule_exactly_once"], {
            before: snapshot({ schedule: [invitation, duplicate] }),
            after: snapshot({ schedule: [invitation, duplicate] }),
          }),
          "schedule_exactly_once",
        ),
      ).toBe("FAIL");
    });

    it("fails a count-correct confirmation when its authoritative slot is wrong", () => {
      const expectedScheduleCommit = {
        startAtUtc: T1,
        endAtUtc: T2,
        timezone: "Asia/Shanghai",
        localStart: "2026-09-02 09:00",
        category: "social" as const,
        titleIncludes: "North Shore",
      };
      const assertions = [
        "schedule_requires_server_commit",
        "schedule_exactly_once",
      ] as const;
      const correct = invitationItem("schedule-correct-slot", {
        category: "social",
        timezone: "Asia/Shanghai",
      });
      expect(
        status(
          evaluate(assertions, {
            turn: { ...turn(assertions), expectedScheduleCommit },
            response: response({ scheduleChanges: [correct] }),
            after: snapshot({ schedule: [correct] }),
          }),
          "schedule_exactly_once",
        ),
      ).toBe("PASS");

      const wrongDate = invitationItem("schedule-wrong-slot", {
        category: "social",
        timezone: "Asia/Shanghai",
        startAtUtc: "2026-09-03T01:00:00.000Z",
        endAtUtc: "2026-09-04T01:00:00.000Z",
      });
      expect(
        status(
          evaluate(assertions, {
            turn: { ...turn(assertions), expectedScheduleCommit },
            response: response({ scheduleChanges: [wrongDate] }),
            after: snapshot({ schedule: [wrongDate] }),
          }),
          "schedule_exactly_once",
        ),
      ).toBe("FAIL");
    });
  });

  describe("offline settlement, restart and idempotency", () => {
    it("accepts one contiguous settlement and rejects two durable settlements", () => {
      const before = snapshot({ cursor: cursor(T0) });
      const oneSettlement = settlement("settlement-1", T0, T1);
      const after = snapshot({
        cursor: cursor(T1),
        settlements: [oneSettlement],
      });
      const one = evaluate(["settlement_monotonic", "settlement_idempotent"], {
        before,
        after,
      });
      expect(status(one, "settlement_monotonic")).toBe("PASS");
      expect(status(one, "settlement_idempotent")).toBe("PASS");

      const two = evaluate(["settlement_monotonic", "settlement_idempotent"], {
        before,
        after: snapshot({
          cursor: cursor(T2),
          settlements: [oneSettlement, settlement("settlement-2", T1, T2)],
        }),
      });
      expect(status(two, "settlement_monotonic")).toBe("FAIL");
      expect(status(two, "settlement_idempotent")).toBe("FAIL");
    });

    it("passes repeated activation with no new settlement", () => {
      const existing = settlement("settlement-existing", T0, T1);
      const before = snapshot({ cursor: cursor(T1), settlements: [existing] });
      const after = snapshot({ cursor: cursor(T1), settlements: [existing] });
      expect(
        status(
          evaluate(["settlement_idempotent"], { before, after }),
          "settlement_idempotent",
        ),
      ).toBe("PASS");
    });

    it("requires restart hash equality and a mutation-free replay", () => {
      const restart = actionResult("restart_app", {
        beforeRestartSha256: "stable",
        afterRestartSha256: "stable",
      });
      expect(
        status(
          evaluate(["restart_preserves_state"], { actions: [restart] }),
          "restart_preserves_state",
        ),
      ).toBe("PASS");

      const before = snapshot({ durableSha256: "same" });
      const after = snapshot({ durableSha256: "same" });
      expect(
        status(
          evaluate(["idempotent_replay"], {
            response: response({ idempotentReplay: true }),
            before,
            after,
          }),
          "idempotent_replay",
        ),
      ).toBe("PASS");
      expect(
        status(
          evaluate(["idempotent_replay"], {
            response: response({ idempotentReplay: true }),
            before,
            after: snapshot({ durableSha256: "changed" }),
          }),
          "idempotent_replay",
        ),
      ).toBe("FAIL");
    });

    it("measures candidate state deltas after completed setup patches", () => {
      const before = runtimeState({ energy: 1, stress: 0, focus: 0.76 });
      const after = runtimeState({ energy: 0.58, stress: 0.62, focus: 0.84 });
      const setup: ScenarioActionResult = {
        action: {
          kind: "set_runtime_state",
          patch: { energy: 0.58, stress: 0.62, focus: 0.84 },
        },
        status: "completed",
        atUtc: T1,
      };
      expect(
        status(
          evaluate(["state_delta_bounded"], {
            before: snapshot({ runtimeState: before }),
            after: snapshot({ runtimeState: after }),
            actions: [setup],
          }),
          "state_delta_bounded",
        ),
      ).toBe("PASS");
    });

    it("measures relationship deltas after completed setup patches", () => {
      const before = runtimeState({
        relationship: { closeness: 0.2, trust: 0.2 },
      });
      const after = runtimeState({
        relationship: { closeness: 0.8, trust: 0.8 },
      });
      const setup: ScenarioActionResult = {
        action: {
          kind: "set_relationship_state",
          patch: { closeness: 0.8, trust: 0.8 },
        },
        status: "completed",
        atUtc: T1,
      };
      expect(
        status(
          evaluate(["relationship_delta_bounded"], {
            before: snapshot({ runtimeState: before }),
            after: snapshot({ runtimeState: after }),
            actions: [setup],
          }),
          "relationship_delta_bounded",
        ),
      ).toBe("PASS");
    });
  });

  describe("proactive delivery, prompt budget and trace lineage", () => {
    it("requires an activity, candidate and sent-event chain for proactive sharing", () => {
      const proactive = proactiveFixture();
      expect(
        status(
          evaluate(["proactive_source_linked"], {
            after: snapshot(proactive),
          }),
          "proactive_source_linked",
        ),
      ).toBe("PASS");

      expect(
        status(
          evaluate(["proactive_source_linked"], {
            after: snapshot({ ...proactive, domainEvents: [] }),
          }),
          "proactive_source_linked",
        ),
      ).toBe("FAIL");
    });

    it("enforces Shanghai quiet hours and the two-message daily limit", () => {
      const messages = [
        proactiveMessage("proactive-1", "2026-09-01T02:00:00.000Z"),
        proactiveMessage("proactive-2", "2026-09-01T06:00:00.000Z"),
      ];
      expect(
        status(
          evaluate(["proactive_policy_respected"], {
            after: snapshot({ messages }),
          }),
          "proactive_policy_respected",
        ),
      ).toBe("PASS");
      expect(
        status(
          evaluate(["proactive_policy_respected"], {
            after: snapshot({
              messages: [
                ...messages,
                proactiveMessage("proactive-3", "2026-09-01T10:00:00.000Z"),
              ],
            }),
          }),
          "proactive_policy_respected",
        ),
      ).toBe("FAIL");
      expect(
        status(
          evaluate(["proactive_policy_respected"], {
            after: snapshot({
              messages: [
                proactiveMessage("proactive-quiet", "2026-09-01T16:30:00.000Z"),
              ],
            }),
          }),
          "proactive_policy_respected",
        ),
      ).toBe("FAIL");
    });

    it("uses a conservative mixed-language prompt estimate", () => {
      const call = logicalCall("", "中文中文中文");
      expect(
        status(
          evaluate(["prompt_budget_bounded"], {
            logicalCalls: [call],
            promptHardTokenLimit: 7,
          }),
          "prompt_budget_bounded",
        ),
      ).toBe("PASS");
      expect(
        status(
          evaluate(["prompt_budget_bounded"], {
            logicalCalls: [call],
            promptHardTokenLimit: 6,
          }),
          "prompt_budget_bounded",
        ),
      ).toBe("FAIL");
    });

    it("accepts an idempotent replay only when it performs zero LLM calls", () => {
      const replay = response({ idempotentReplay: true });
      expect(
        status(
          evaluate(["prompt_budget_bounded"], {
            response: replay,
            logicalCalls: [],
          }),
          "prompt_budget_bounded",
        ),
      ).toBe("PASS");
      expect(
        status(
          evaluate(["prompt_budget_bounded"], {
            response: replay,
            logicalCalls: [logicalCall("system", "prompt")],
          }),
          "prompt_budget_bounded",
        ),
      ).toBe("FAIL");
    });

    it("matches the committed turn payload to persisted response rows", () => {
      const applicationResponse = response();
      const committed = turnCommittedEvent(applicationResponse);
      const after = snapshot({
        messages: [
          { id: applicationResponse.userMessage.id },
          { id: applicationResponse.assistantMessage.id },
        ],
        domainEvents: [committed],
      });
      expect(
        status(
          evaluate(["trace_lineage_complete"], {
            response: applicationResponse,
            logicalCalls: [logicalCall("system", "prompt")],
            after,
          }),
          "trace_lineage_complete",
        ),
      ).toBe("PASS");

      expect(
        status(
          evaluate(["trace_lineage_complete"], {
            response: applicationResponse,
            logicalCalls: [logicalCall("system", "prompt")],
            after: snapshot({ domainEvents: [committed] }),
          }),
          "trace_lineage_complete",
        ),
      ).toBe("FAIL");
    });

    it("accepts replay lineage from the existing event without a new LLM call", () => {
      const replay = response({ idempotentReplay: true });
      const committed = turnCommittedEvent(replay);
      const stable = snapshot({
        messages: [
          { id: replay.userMessage.id },
          { id: replay.assistantMessage.id },
        ],
        domainEvents: [committed],
      });
      expect(
        status(
          evaluate(["trace_lineage_complete"], {
            response: replay,
            logicalCalls: [],
            before: stable,
            after: stable,
          }),
          "trace_lineage_complete",
        ),
      ).toBe("PASS");
    });

    it("rejects a completed activity whose authoritative end is still future", () => {
      const future = invitationItem("schedule-future", {
        endAtUtc: T2,
      });
      const completed = {
        id: "activity-premature",
        scheduleItemId: future.id,
        eventType: "completed",
      };
      expect(
        status(
          evaluate(["planned_not_occurred"], {
            after: snapshot({
              schedule: [future],
              activityEvents: [completed],
            }),
          }),
          "planned_not_occurred",
        ),
      ).toBe("FAIL");
    });
  });
});

function evaluate(
  hardAssertions: readonly HardAssertion[],
  overrides: Partial<HardAssertionEvaluationInput> = {},
): HardAssertionResult[] {
  return evaluateLongRunV2HardAssertions({
    turn: turn(hardAssertions),
    httpStatus: 201,
    response: response(),
    persistedAssistant: { id: "message-assistant", content: "收到。" },
    before: snapshot(),
    after: snapshot(),
    logicalCalls: [],
    actions: [],
    retrievalRuns: [],
    promptHardTokenLimit: 12_000,
    ...overrides,
  });
}

function status(
  results: readonly HardAssertionResult[],
  code: HardAssertion,
): HardAssertionResult["status"] {
  const found = results.find((item) => item.code === code);
  if (found === undefined) throw new Error(`Missing assertion ${code}`);
  return found.status;
}

function turn(hardAssertions: readonly HardAssertion[]): LongRunTurnSpec {
  return {
    id: "shared-001-test",
    candidateNumber: 1,
    executionOrdinal: 1,
    scope: "shared",
    blockId: "test",
    phase: "test",
    objective: "test",
    sessionKey: "S1",
    userText: "test",
    hardAssertions,
    semanticRubricTags: [],
  };
}

function snapshot(
  overrides: Partial<LongRunStateSnapshot> = {},
): LongRunStateSnapshot {
  return {
    capturedAtUtc: T1,
    runtimeState: null,
    cursor: cursor(T0),
    schedule: [],
    scheduleNegotiations: [],
    settlements: [],
    activityEvents: [],
    memories: [],
    memoryEvidence: [],
    proactiveCandidates: [],
    messages: [],
    domainEvents: [],
    rejectedProposals: [],
    retrievalRuns: [],
    llmCalls: [],
    tableCounts: {},
    durableSha256: "stable",
    ...overrides,
  };
}

function response(
  overrides: {
    idempotentReplay?: boolean;
    scheduleChanges?: readonly unknown[];
    memoryRecall?: {
      selectedMemoryIds: string[];
      selectedEvidenceIds: string[];
      abstained: boolean;
    };
  } = {},
): SendMessageResponse {
  return {
    idempotentReplay: overrides.idempotentReplay ?? false,
    userMessage: { id: "message-user", content: "test" },
    assistantMessage: { id: "message-assistant", content: "收到。" },
    scheduleChanges: [...(overrides.scheduleChanges ?? [])],
    state: {},
    ...(overrides.memoryRecall === undefined
      ? {}
      : {
          memoryRecall: {
            rolloutMode: "enforced",
            promptStrategy: "evidence_selected",
            legacyPromptMemoryIds: [],
            promptMemoryIds: overrides.memoryRecall.selectedMemoryIds,
            selectedMemoryIds: overrides.memoryRecall.selectedMemoryIds,
            selectedEvidenceIds: overrides.memoryRecall.selectedEvidenceIds,
            rejectedMemoryIds: [],
            recallMode: overrides.memoryRecall.abstained
              ? "none"
              : "basic_memory",
            score: overrides.memoryRecall.abstained ? 0 : 1,
            abstained: overrides.memoryRecall.abstained,
            durationMs: 1,
          },
        }),
    decision: {
      reasonCode: "test",
      reasonSummary: "test",
      toneTags: [],
      deliveryMode: "single_block",
      chunks: ["收到。"],
    },
  } as unknown as SendMessageResponse;
}

function memoryRow(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    content: "The user likes jasmine tea.",
    status: "active",
    claim_subject_key: "preference:tea",
    source_message_id: null,
    source_event_id: null,
    superseded_by_id: null,
    merged_into_id: null,
    ...overrides,
  };
}

function evidenceRow(id: string, memoryId: string): Record<string, unknown> {
  return {
    id,
    memory_id: memoryId,
    source_type: "message",
    source_id: "message-user",
  };
}

function retrievalRun(
  memory: Record<string, unknown>,
  evidence: Record<string, unknown>,
): RetrievalRun {
  const memoryId = String(memory["id"]);
  const evidenceId = String(evidence["id"]);
  const sourceId = String(evidence["source_id"]);
  const sourceType = String(evidence["source_type"]);
  const bundleEvidence = {
    memoryId,
    evidence: {
      id: evidenceId,
      memoryId,
      sourceId,
      sourceType,
    },
  };
  return {
    id: "retrieval-run-1",
    sourceMessageId: "message-user",
    result: {
      abstained: false,
      selectedMemoryIds: [memoryId],
      selectedEvidenceIds: [evidenceId],
    },
    evidenceBundle: { evidence: [bundleEvidence] },
    inputSnapshot: {
      memories: [memory],
      evidence: [{ id: evidenceId, memoryId, sourceId, sourceType }],
    },
  } as unknown as RetrievalRun;
}

function runtimeState(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const relationshipOverrides = asTestRecord(overrides["relationship"]);
  const rootOverrides = { ...overrides };
  delete rootOverrides["relationship"];
  return {
    agentId: "agent-test",
    asOfUtc: T1,
    moodValence: 0,
    moodArousal: 0.5,
    energy: 0.5,
    stress: 0.5,
    socialBattery: 0.5,
    focus: 0.5,
    sleepDebtMinutes: 0,
    revision: 1,
    ...rootOverrides,
    relationship: {
      userId: "local-user",
      closeness: 0.5,
      trust: 0.5,
      familiarity: 0.5,
      recentInteractionValence: 0,
      ...relationshipOverrides,
    },
  };
}

function asTestRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function invitationItem(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> & { id: string } {
  return {
    id,
    title: "North Shore Books",
    source: "user_invitation",
    startAtUtc: T1,
    endAtUtc: T2,
    status: "planned",
    revision: 1,
    ...overrides,
  };
}

function selfPlanItem(): Record<string, unknown> {
  return {
    id: "schedule-self",
    title: "Riverside photography",
    source: "self_initiated",
    startAtUtc: T1,
    endAtUtc: T2,
    sourceIntentId: "intent-photo",
    correlationId: "self-plan-correlation",
    causationId: "self-plan-correlation",
  };
}

function domainEvent(input: {
  id: string;
  eventType: string;
  streamId: string;
  correlationId?: string;
  causationId?: string;
  payload?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: input.id,
    eventType: input.eventType,
    streamId: input.streamId,
    correlationId: input.correlationId ?? "self-plan-correlation",
    causationId: input.causationId ?? "self-plan-correlation",
    payload: input.payload ?? {},
  };
}

function selfPlanEvents(): Record<string, unknown>[] {
  return [
    domainEvent({
      id: "event-intent-created",
      eventType: "personal_intent.created",
      streamId: "intent-photo",
      correlationId: "intent-origin",
      causationId: "character-spec",
    }),
    domainEvent({
      id: "event-intent-consumed",
      eventType: "personal_intent.consumed",
      streamId: "intent-photo",
    }),
    domainEvent({
      id: "event-self-plan",
      eventType: "self_plan.committed",
      streamId: "intent-photo",
      payload: { createdScheduleItemIds: ["schedule-self"] },
    }),
  ];
}

function scheduleCommandEvent(scheduleId: string): Record<string, unknown> {
  return domainEvent({
    id: `event-command-${scheduleId}`,
    eventType: "schedule.command_committed",
    streamId: "agent",
    correlationId: "client-message",
    causationId: "message-user",
    payload: { changedItemIds: [scheduleId] },
  });
}

function cursor(lastSettledAtUtc: string): Record<string, unknown> {
  return { lastSettledAtUtc };
}

function settlement(
  id: string,
  fromUtc: string,
  toUtc: string,
): Record<string, unknown> {
  return {
    id,
    from_utc: fromUtc,
    to_utc: toUtc,
    idempotency_key: `settlement:${fromUtc}:${toUtc}`,
  };
}

function actionResult(
  kind: "restart_app",
  detail: Record<string, unknown>,
): ScenarioActionResult {
  return {
    action: { kind, preserveDatabase: true },
    status: "completed",
    atUtc: T1,
    detail,
  };
}

function proactiveMessage(
  id: string,
  createdAtUtc: string,
): Record<string, unknown> {
  return {
    id,
    message_kind: "assistant_proactive",
    created_at_utc: createdAtUtc,
    trigger_event_id: "activity-1",
  };
}

function proactiveFixture(): Partial<LongRunStateSnapshot> {
  return {
    messages: [proactiveMessage("proactive-1", "2026-09-01T02:00:00.000Z")],
    activityEvents: [{ id: "activity-1" }],
    proactiveCandidates: [
      {
        id: "candidate-1",
        trigger_event_id: "activity-1",
        sent_message_id: "proactive-1",
      },
    ],
    domainEvents: [
      domainEvent({
        id: "event-proactive-sent",
        eventType: "conversation.proactive_message_sent",
        streamId: "session",
        payload: {
          messageId: "proactive-1",
          triggerEventId: "activity-1",
          proactiveCandidateId: "candidate-1",
        },
      }),
    ],
  };
}

function logicalCall(system: string, prompt: string): LogicalCallTrace {
  return {
    index: 1,
    purpose: "chat_turn",
    system,
    prompt,
    promptSha256: "prompt-sha",
  };
}

function turnCommittedEvent(
  applicationResponse: SendMessageResponse,
): Record<string, unknown> {
  return domainEvent({
    id: "event-turn-committed",
    eventType: "conversation.turn_committed",
    streamId: "session",
    correlationId: "client-message",
    causationId: applicationResponse.userMessage.id,
    payload: {
      userMessageId: applicationResponse.userMessage.id,
      assistantMessageId: applicationResponse.assistantMessage.id,
      scheduleItemIds: [],
      memoryIds: [],
    },
  });
}
