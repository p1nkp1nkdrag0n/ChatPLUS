import {
  RuntimeStateSchema,
  type SendMessageResponse,
} from "@personasim/contracts";
import {
  RELATIONSHIP_SINGLE_TURN_LIMITS,
  estimateConversationTokens,
} from "@personasim/features";
import { DateTime } from "luxon";

import type {
  HardAssertion,
  LongRunTurnSpec,
} from "../scenarios/companion-long-run-v2-types.js";
import type { RetrievalRun } from "../repositories/retrieval-run-repository.js";
import { canonicalJson } from "./companion-long-run-v2-baseline.js";
import type { ScenarioActionResult } from "./companion-long-run-v2-runtime.js";
import type {
  HardAssertionResult,
  LogicalCallTrace,
  LongRunStateSnapshot,
} from "./companion-long-run-v2-run-types.js";

export interface HardAssertionEvaluationInput {
  turn: LongRunTurnSpec;
  httpStatus: number;
  response?: SendMessageResponse;
  persistedAssistant?: unknown;
  before: LongRunStateSnapshot;
  after: LongRunStateSnapshot;
  logicalCalls: readonly LogicalCallTrace[];
  actions: readonly ScenarioActionResult[];
  retrievalRuns: readonly RetrievalRun[];
  promptHardTokenLimit: number;
  expectedBranchAnchorSha256?: string;
  actualBranchAnchorSha256?: string;
}

export function evaluateLongRunV2HardAssertions(
  input: HardAssertionEvaluationInput,
): HardAssertionResult[] {
  return input.turn.hardAssertions.map((code) => evaluate(code, input));
}

function evaluate(
  code: HardAssertion,
  input: HardAssertionEvaluationInput,
): HardAssertionResult {
  const assistantText = input.response?.assistantMessage.content ?? "";
  const beforeState = runtimeState(input.before);
  const afterState = runtimeState(input.after);
  const newMemories = differenceById(
    input.before.memories,
    input.after.memories,
  );
  const newEvidence = differenceById(
    input.before.memoryEvidence,
    input.after.memoryEvidence,
  );
  const newSchedule = differenceById(
    input.before.schedule,
    input.after.schedule,
  );
  const newInvitationSchedule = invitationSchedule(newSchedule);
  const newSelfInitiatedSchedule = selfInitiatedSchedule(newSchedule);
  const newActivityEvents = differenceById(
    input.before.activityEvents,
    input.after.activityEvents,
  );
  const newDomainEvents = differenceById(
    input.before.domainEvents,
    input.after.domainEvents,
  );
  const newSettlements = differenceById(
    input.before.settlements,
    input.after.settlements,
  );

  switch (code) {
    case "http_success":
      return result(code, input.httpStatus >= 200 && input.httpStatus < 300, {
        expected: "2xx",
        actual: input.httpStatus,
      });
    case "response_contract_valid":
      return result(code, input.response !== undefined, {
        actual: input.response === undefined ? "invalid" : "valid",
      });
    case "persisted_turn_matches_response": {
      const persisted = asRecord(input.persistedAssistant);
      return result(
        code,
        input.response !== undefined &&
          persisted["id"] === input.response.assistantMessage.id &&
          persisted["content"] === input.response.assistantMessage.content,
        { actual: persisted },
      );
    }
    case "no_unvalidated_write": {
      const responseScheduleIds = new Set(
        input.response?.scheduleChanges.map((item) => item.id) ?? [],
      );
      const unreportedInvitations = newInvitationSchedule.filter(
        (item) => !responseScheduleIds.has(rowId(item)),
      );
      const invitationLineageIssues = newInvitationSchedule.flatMap((item) =>
        invitationCommitLineageIssues(item, newDomainEvents),
      );
      const selfInitiatedLineageIssues = newSelfInitiatedSchedule.flatMap(
        (item) => selfPlanLineageIssues(item, input.after.domainEvents),
      );
      return result(
        code,
        unreportedInvitations.length === 0 &&
          invitationLineageIssues.length === 0 &&
          selfInitiatedLineageIssues.length === 0,
        {
          actual: {
            unreportedInvitationWrites: unreportedInvitations.map(rowId),
            invitationLineageIssues,
            selfInitiatedLineageIssues,
          },
        },
      );
    }
    case "persona_boundary_respected":
    case "no_ai_meta_disclosure":
      return result(
        code,
        !/(?:作为(?:一个|一名)?AI|语言模型|system prompt|系统提示(?:是|内容)|数据库内部|隐藏评分)/iu.test(
          assistantText,
        ),
        { actual: assistantText },
      );
    case "memory_write_grounded": {
      const grounded =
        newMemories.length > 0 &&
        newMemories.every((memory) => {
          const row = asRecord(memory);
          const memoryId = rowId(memory);
          return (
            nonEmptyString(row["source_message_id"]) ||
            nonEmptyString(row["source_event_id"]) ||
            input.after.memoryEvidence.some((evidence) =>
              validEvidenceForMemory(evidence, memoryId),
            )
          );
        });
      return result(code, grounded, {
        actual: {
          newMemories: newMemories.length,
          newEvidence: newEvidence.length,
        },
      });
    }
    case "memory_recall_evidence_bound": {
      const recall = input.response?.memoryRecall;
      const selectedEvidenceIds = recall?.selectedEvidenceIds ?? [];
      const selectedMemoryIds = recall?.selectedMemoryIds ?? [];
      const sourceMessageId = input.response?.userMessage.id;
      const candidateRuns = input.retrievalRuns.filter(
        (run) => run.sourceMessageId === sourceMessageId,
      );
      const inspections = candidateRuns.map((run) =>
        inspectRetrievalRunBinding(
          run,
          selectedMemoryIds,
          selectedEvidenceIds,
          input.after,
        ),
      );
      const matched = inspections.find((inspection) => inspection.valid);
      return result(code, recall !== undefined && matched !== undefined, {
        actual: {
          selectedEvidenceIds,
          selectedMemoryIds,
          sourceMessageId,
          candidateRunIds: candidateRuns.map((run) => run.id),
          matchedRunId: matched?.runId,
          issues:
            matched === undefined
              ? candidateRuns.length === 0
                ? ["no_current_turn_retrieval_run"]
                : inspections.flatMap((inspection) => inspection.issues)
              : [],
        },
      });
    }
    case "memory_abstains_without_evidence":
      return result(code, newMemories.length === 0, {
        actual: { newMemories: newMemories.length },
      });
    case "memory_correction_supersedes": {
      const newMemoryIds = new Set(newMemories.map(rowId));
      const supersession = inspectMemorySupersession(
        input.before.memories,
        input.after.memories,
      );
      const grounded = newMemories.every((memory) => {
        const row = asRecord(memory);
        return (
          nonEmptyString(row["source_message_id"]) ||
          nonEmptyString(row["source_event_id"]) ||
          input.after.memoryEvidence.some((evidence) =>
            validEvidenceForMemory(evidence, rowId(memory)),
          )
        );
      });
      const correctionLinked =
        newMemoryIds.size === 0
          ? supersession.validLinks.length > 0
          : supersession.validLinks.some((link) =>
              newMemoryIds.has(link.replacementId),
            );
      return result(
        code,
        grounded &&
          correctionLinked &&
          supersession.invalidLinks.length === 0 &&
          supersession.duplicateActiveSubjects.length === 0,
        {
          actual: {
            newMemories: newMemories.length,
            validLinks: supersession.validLinks,
            invalidLinks: supersession.invalidLinks,
            duplicateActiveSubjects: supersession.duplicateActiveSubjects,
          },
        },
      );
    }
    case "planned_not_occurred": {
      const futureIds = new Set(
        input.after.schedule
          .filter((item) => {
            const row = asRecord(item);
            return (
              Date.parse(text(row["endAtUtc"] ?? row["end_at_utc"])) >
              Date.parse(input.after.capturedAtUtc)
            );
          })
          .map(rowId),
      );
      const invented = newActivityEvents.filter((event) => {
        const row = asRecord(event);
        const currentEventType = text(field(row, "eventType", "event_type"));
        return (
          currentEventType === "completed" &&
          futureIds.has(text(field(row, "scheduleItemId", "schedule_item_id")))
        );
      });
      return result(code, invented.length === 0, {
        actual: { prematureActivityEvents: invented.length },
      });
    }
    case "schedule_requires_server_commit": {
      const responseIds = new Set(
        input.response?.scheduleChanges.map((item) => item.id) ?? [],
      );
      const persistedInvitationIds = new Set(
        invitationSchedule(input.after.schedule).map(rowId),
      );
      const responseInvitations =
        input.response?.scheduleChanges.filter(
          (item) => item.source === "user_invitation",
        ) ?? [];
      const unreportedInvitations = newInvitationSchedule.filter(
        (item) => !responseIds.has(rowId(item)),
      );
      const unpersistedResponseInvitations = responseInvitations.filter(
        (item) => !persistedInvitationIds.has(item.id),
      );
      const invitationLineageIssues = newInvitationSchedule.flatMap((item) =>
        invitationCommitLineageIssues(item, newDomainEvents),
      );
      const selfInitiatedLineageIssues = newSelfInitiatedSchedule.flatMap(
        (item) => selfPlanLineageIssues(item, input.after.domainEvents),
      );
      return result(
        code,
        unreportedInvitations.length === 0 &&
          unpersistedResponseInvitations.length === 0 &&
          invitationLineageIssues.length === 0 &&
          selfInitiatedLineageIssues.length === 0,
        {
          actual: {
            newInvitationIds: newInvitationSchedule.map(rowId),
            responseIds: [...responseIds],
            unreportedInvitationIds: unreportedInvitations.map(rowId),
            unpersistedResponseInvitationIds:
              unpersistedResponseInvitations.map((item) => item.id),
            invitationLineageIssues,
            selfInitiatedLineageIssues,
          },
        },
      );
    }
    case "schedule_exactly_once": {
      const currentInvitations = invitationSchedule(input.after.schedule);
      const keys = currentInvitations.map(scheduleIdentity);
      const expectsConfirmationCommit = input.turn.hardAssertions.includes(
        "schedule_requires_server_commit",
      );
      const expectedNewInvitations = expectsConfirmationCommit ? 1 : 0;
      const responseIds = new Set(
        input.response?.scheduleChanges.map((item) => item.id) ?? [],
      );
      const responseAligned = newInvitationSchedule.every((item) =>
        responseIds.has(rowId(item)),
      );
      const expectedCommit = input.turn.expectedScheduleCommit;
      const actualCommit =
        expectedCommit === undefined
          ? undefined
          : scheduleCommitProjection(
              newInvitationSchedule[0],
              expectedCommit.timezone,
            );
      const expectedCommitMatched =
        expectedCommit === undefined ||
        (newInvitationSchedule.length === 1 &&
          actualCommit !== undefined &&
          actualCommit.startAtUtc === expectedCommit.startAtUtc &&
          actualCommit.endAtUtc === expectedCommit.endAtUtc &&
          actualCommit.timezone === expectedCommit.timezone &&
          actualCommit.localStart === expectedCommit.localStart &&
          actualCommit.category === expectedCommit.category &&
          actualCommit.title.includes(expectedCommit.titleIncludes));
      return result(
        code,
        new Set(keys).size === keys.length &&
          newInvitationSchedule.length === expectedNewInvitations &&
          responseAligned &&
          expectedCommitMatched,
        {
          expected: {
            newUserInvitationItems: expectedNewInvitations,
            ...(expectedCommit === undefined
              ? {}
              : { scheduleCommit: expectedCommit }),
          },
          actual: {
            newUserInvitationIds: newInvitationSchedule.map(rowId),
            newSelfInitiatedIds: newSelfInitiatedSchedule.map(rowId),
            invitationKeys: keys,
            responseIds: [...responseIds],
            ...(actualCommit === undefined
              ? {}
              : { scheduleCommit: actualCommit }),
          },
        },
      );
    }
    case "schedule_unchanged": {
      const responseInvitationChanges =
        input.response?.scheduleChanges.filter(
          (item) => item.source === "user_invitation",
        ) ?? [];
      return result(
        code,
        newInvitationSchedule.length === 0 &&
          responseInvitationChanges.length === 0,
        {
          actual: {
            newUserInvitationIds: newInvitationSchedule.map(rowId),
            responseUserInvitationIds: responseInvitationChanges.map(
              (item) => item.id,
            ),
            ignoredSelfInitiatedIds: newSelfInitiatedSchedule.map(rowId),
          },
        },
      );
    }
    case "settlement_monotonic": {
      const beforeCursor = asRecord(input.before.cursor);
      const afterCursor = asRecord(input.after.cursor);
      const beforeSettledAt = text(beforeCursor["lastSettledAtUtc"]);
      const afterSettledAt = text(afterCursor["lastSettledAtUtc"]);
      const monotonic =
        validUtc(beforeSettledAt) &&
        validUtc(afterSettledAt) &&
        Date.parse(afterSettledAt) >= Date.parse(beforeSettledAt);
      return result(code, monotonic && newSettlements.length <= 1, {
        expected: beforeCursor,
        actual: {
          cursor: afterCursor,
          newSettlementIds: newSettlements.map(rowId),
        },
      });
    }
    case "settlement_idempotent": {
      const keys = input.after.settlements.map((item) =>
        text(field(asRecord(item), "idempotencyKey", "idempotency_key")),
      );
      const intervalIssues = newSettlements.flatMap((settlement) =>
        settlementIntervalIssues(
          settlement,
          input.before.cursor,
          input.after.cursor,
        ),
      );
      return result(
        code,
        keys.every(nonEmptyString) &&
          new Set(keys).size === keys.length &&
          newSettlements.length <= 1 &&
          intervalIssues.length === 0,
        {
          actual: {
            settlementCount: keys.length,
            uniqueKeys: new Set(keys).size,
            newSettlementIds: newSettlements.map(rowId),
            intervalIssues,
          },
        },
      );
    }
    case "state_delta_bounded": {
      const effectiveBeforeState = stateAfterSetupActions(
        beforeState,
        input.actions,
      );
      const valid = RuntimeStateSchema.safeParse(afterState).success;
      const deltas = stateDeltas(effectiveBeforeState, afterState);
      return result(
        code,
        valid &&
          Object.values(deltas).every((value) => Math.abs(value) <= 0.5 + 1e-9),
        { actual: deltas },
      );
    }
    case "relationship_delta_bounded": {
      const effectiveBeforeState = stateAfterSetupActions(
        beforeState,
        input.actions,
      );
      const beforeRelationship = asRecord(effectiveBeforeState["relationship"]);
      const afterRelationship = asRecord(afterState["relationship"]);
      const deltas = Object.fromEntries(
        Object.keys(RELATIONSHIP_SINGLE_TURN_LIMITS).map((field) => [
          field,
          number(afterRelationship[field]) - number(beforeRelationship[field]),
        ]),
      );
      const bounded = Object.entries(deltas).every(
        ([field, value]) =>
          Math.abs(value) <=
          RELATIONSHIP_SINGLE_TURN_LIMITS[
            field as keyof typeof RELATIONSHIP_SINGLE_TURN_LIMITS
          ] +
            0.0011,
      );
      return result(code, bounded, { actual: deltas });
    }
    case "cross_session_continuity": {
      const sessions = new Set(
        input.after.messages.map((message) =>
          text(asRecord(message)["session_id"]),
        ),
      );
      return result(code, sessions.size >= 2, {
        actual: { sessions: [...sessions] },
      });
    }
    case "restart_preserves_state": {
      const restart = input.actions.find(
        (item) => item.action.kind === "restart_app",
      );
      const detail = asRecord(restart?.detail);
      return result(
        code,
        restart?.status === "completed" &&
          detail["beforeRestartSha256"] !== undefined &&
          detail["beforeRestartSha256"] === detail["afterRestartSha256"],
        { actual: detail },
      );
    }
    case "idempotent_replay": {
      const noDurableMutation =
        input.before.durableSha256 === input.after.durableSha256;
      return result(
        code,
        input.response?.idempotentReplay === true && noDurableMutation,
        {
          actual: {
            idempotentReplay: input.response?.idempotentReplay,
            noDurableMutation,
          },
        },
      );
    }
    case "no_background_llm_while_closed": {
      const unexpected = input.actions.some((item) => {
        const detail = asRecord(item.detail);
        return Object.entries(detail).some(
          ([key, value]) =>
            key.startsWith("logicalCallsWhile") && number(value) !== 0,
        );
      });
      return result(code, !unexpected, { actual: { unexpected } });
    }
    case "proactive_policy_respected": {
      const proactive = input.after.messages.filter(
        (message) =>
          asRecord(message)["message_kind"] === "assistant_proactive",
      );
      const byDay = new Map<string, number>();
      let quietHourViolation = false;
      for (const message of proactive) {
        const created = text(asRecord(message)["created_at_utc"]);
        const local = localShanghaiParts(created);
        byDay.set(local.day, (byDay.get(local.day) ?? 0) + 1);
        if (local.hour >= 23 || local.hour < 8) quietHourViolation = true;
      }
      return result(
        code,
        !quietHourViolation && [...byDay.values()].every((count) => count <= 2),
        { actual: { byDay: Object.fromEntries(byDay), quietHourViolation } },
      );
    }
    case "proactive_source_linked": {
      const proactive = input.after.messages.filter(
        (message) =>
          asRecord(message)["message_kind"] === "assistant_proactive",
      );
      const sourceIssues = proactive.flatMap((message) =>
        proactiveSourceIssues(message, input.after),
      );
      const activityLinked = proactive.filter((message) =>
        nonEmptyString(asRecord(message)["trigger_event_id"]),
      );
      return result(
        code,
        activityLinked.length > 0 && sourceIssues.length === 0,
        {
          actual: {
            proactiveMessages: proactive.length,
            activityLinkedMessages: activityLinked.map(rowId),
            sourceIssues,
          },
        },
      );
    }
    case "prompt_budget_bounded": {
      const tokens = input.logicalCalls.map((call) =>
        estimateConversationTokens(`${call.system}\n${call.prompt}`),
      );
      const replay = input.response?.idempotentReplay === true;
      return result(
        code,
        replay
          ? input.logicalCalls.length === 0
          : input.logicalCalls.length > 0 &&
              tokens.every((count) => count <= input.promptHardTokenLimit),
        {
          expected: input.promptHardTokenLimit,
          actual: { replay, tokens },
        },
      );
    }
    case "trace_lineage_complete": {
      const response = input.response;
      const replay = response?.idempotentReplay === true;
      const candidateEvents = replay
        ? input.after.domainEvents
        : newDomainEvents;
      const committed = candidateEvents.find((event) =>
        turnEventMatchesResponse(event, response, input.after),
      );
      const chatCall = input.logicalCalls.some(
        (call) => call.purpose === "chat_turn",
      );
      const callShapeValid = replay
        ? input.logicalCalls.length === 0
        : chatCall;
      return result(
        code,
        response !== undefined && callShapeValid && committed !== undefined,
        {
          actual: {
            replay,
            chatCall,
            logicalCallCount: input.logicalCalls.length,
            committedEventId:
              committed === undefined ? undefined : rowId(committed),
          },
        },
      );
    }
    case "branch_anchor_preserved":
      return result(
        code,
        input.expectedBranchAnchorSha256 !== undefined &&
          input.expectedBranchAnchorSha256 === input.actualBranchAnchorSha256,
        {
          expected: input.expectedBranchAnchorSha256,
          actual: input.actualBranchAnchorSha256,
        },
      );
    case "user_boundary_respected":
      return result(
        code,
        !/(?:再考虑一下|给我一个机会|为什么不|你会后悔|我不会放弃|只是约会而已|必须告诉我原因)/u.test(
          assistantText,
        ),
        { actual: assistantText },
      );
  }
}

function result(
  code: HardAssertion,
  passed: boolean,
  detail: { expected?: unknown; actual?: unknown } = {},
): HardAssertionResult {
  return {
    code,
    status: passed ? "PASS" : "FAIL",
    summary: passed ? `${code} passed.` : `${code} failed.`,
    ...detail,
  };
}

function runtimeState(snapshot: LongRunStateSnapshot): Record<string, unknown> {
  return asRecord(snapshot.runtimeState);
}

function differenceById(
  before: readonly unknown[],
  after: readonly unknown[],
): unknown[] {
  const beforeKeys = new Set(before.map(rowIdentity));
  return after.filter((item) => !beforeKeys.has(rowIdentity(item)));
}

function rowIdentity(value: unknown): string {
  const record = asRecord(value);
  const id = record["id"];
  return typeof id === "string" ? `id:${id}` : `json:${canonicalJson(value)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stateDeltas(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, number> {
  return Object.fromEntries(
    [
      "moodValence",
      "moodArousal",
      "energy",
      "stress",
      "socialBattery",
      "focus",
    ].map((field) => [field, number(after[field]) - number(before[field])]),
  );
}

function stateAfterSetupActions(
  before: Record<string, unknown>,
  actions: readonly ScenarioActionResult[],
): Record<string, unknown> {
  let effective = { ...before };
  for (const action of actions) {
    if (action.status !== "completed") continue;
    if (action.action.kind === "set_runtime_state") {
      effective = { ...effective, ...action.action.patch };
      continue;
    }
    if (action.action.kind === "set_relationship_state") {
      effective = {
        ...effective,
        relationship: {
          ...asRecord(effective["relationship"]),
          ...action.action.patch,
        },
      };
    }
  }
  return effective;
}

function scheduleIdentity(value: unknown): string {
  const row = asRecord(value);
  return [
    text(row["title"]).trim().toLocaleLowerCase(),
    field(row, "startAtUtc", "start_at_utc"),
    field(row, "endAtUtc", "end_at_utc"),
  ].join("|");
}

function scheduleCommitProjection(
  value: unknown,
  timezone: string,
):
  | {
      id: string;
      title: string;
      category: string;
      startAtUtc: string;
      endAtUtc: string;
      timezone: string;
      localStart: string;
    }
  | undefined {
  if (value === undefined) return undefined;
  const row = asRecord(value);
  const startAtUtc = text(field(row, "startAtUtc", "start_at_utc"));
  const start = DateTime.fromISO(startAtUtc, { setZone: true });
  return {
    id: rowId(row),
    title: text(row["title"]),
    category: text(row["category"]),
    startAtUtc,
    endAtUtc: text(field(row, "endAtUtc", "end_at_utc")),
    timezone: text(row["timezone"]),
    localStart: start.isValid
      ? start.setZone(timezone).toFormat("yyyy-LL-dd HH:mm")
      : "",
  };
}

function rowId(value: unknown): string {
  const id = asRecord(value)["id"];
  return typeof id === "string" ? id : "";
}

function byId(values: readonly unknown[]): Map<string, unknown> {
  return new Map(
    values
      .map((value) => [rowId(value), value] as const)
      .filter(([id]) => id !== ""),
  );
}

function field(
  row: Record<string, unknown>,
  camelCase: string,
  snakeCase: string,
): unknown {
  return row[camelCase] ?? row[snakeCase];
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function validUtc(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function invitationSchedule(values: readonly unknown[]): unknown[] {
  return values.filter(
    (item) => asRecord(item)["source"] === "user_invitation",
  );
}

function selfInitiatedSchedule(values: readonly unknown[]): unknown[] {
  return values.filter((item) => asRecord(item)["source"] === "self_initiated");
}

function eventType(value: unknown): string {
  const row = asRecord(value);
  return text(field(row, "eventType", "event_type"));
}

function eventStreamId(value: unknown): string {
  const row = asRecord(value);
  return text(field(row, "streamId", "stream_id"));
}

function eventCorrelationId(value: unknown): string {
  const row = asRecord(value);
  return text(field(row, "correlationId", "correlation_id"));
}

function eventCausationId(value: unknown): string {
  const row = asRecord(value);
  return text(field(row, "causationId", "causation_id"));
}

function eventPayload(value: unknown): Record<string, unknown> {
  const row = asRecord(value);
  return asRecord(row["payload"] ?? row["payload_json"]);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function invitationCommitLineageIssues(
  scheduleItem: unknown,
  domainEvents: readonly unknown[],
): string[] {
  const id = rowId(scheduleItem);
  if (id === "") return ["user_invitation:missing_schedule_item_id"];
  const command = domainEvents.find((event) => {
    if (eventType(event) !== "schedule.command_committed") return false;
    const payload = eventPayload(event);
    return stringArray(payload["changedItemIds"]).includes(id);
  });
  if (command === undefined) {
    return [`user_invitation:${id}:missing_schedule_command_commit`];
  }
  const issues: string[] = [];
  if (!nonEmptyString(eventCorrelationId(command))) {
    issues.push(`user_invitation:${id}:missing_correlation_id`);
  }
  if (!nonEmptyString(eventCausationId(command))) {
    issues.push(`user_invitation:${id}:missing_causation_id`);
  }
  return issues;
}

function selfPlanLineageIssues(
  scheduleItem: unknown,
  domainEvents: readonly unknown[],
): string[] {
  const row = asRecord(scheduleItem);
  const id = rowId(scheduleItem);
  const intentId = text(field(row, "sourceIntentId", "source_intent_id"));
  const correlationId = text(field(row, "correlationId", "correlation_id"));
  const causationId = text(field(row, "causationId", "causation_id"));
  const prefix = `self_initiated:${id || "missing-id"}`;
  const issues: string[] = [];
  if (!nonEmptyString(intentId))
    issues.push(`${prefix}:missing_source_intent_id`);
  if (!nonEmptyString(correlationId))
    issues.push(`${prefix}:missing_correlation_id`);
  if (!nonEmptyString(causationId))
    issues.push(`${prefix}:missing_causation_id`);
  if (issues.length > 0) return issues;

  const intentOrigin = domainEvents.some(
    (event) =>
      (eventType(event) === "personal_intent.created" ||
        eventType(event) === "personal_intent.merged") &&
      eventStreamId(event) === intentId,
  );
  if (!intentOrigin) issues.push(`${prefix}:missing_intent_origin`);

  const consumed = domainEvents.some(
    (event) =>
      eventType(event) === "personal_intent.consumed" &&
      eventStreamId(event) === intentId &&
      eventCorrelationId(event) === correlationId &&
      eventCausationId(event) === causationId,
  );
  if (!consumed) issues.push(`${prefix}:missing_intent_consumed`);

  const committed = domainEvents.some((event) => {
    if (
      eventType(event) !== "self_plan.committed" ||
      eventStreamId(event) !== intentId ||
      eventCorrelationId(event) !== correlationId ||
      eventCausationId(event) !== causationId
    ) {
      return false;
    }
    return stringArray(eventPayload(event)["createdScheduleItemIds"]).includes(
      id,
    );
  });
  if (!committed) issues.push(`${prefix}:missing_self_plan_commit`);
  return issues;
}

function validEvidenceForMemory(evidence: unknown, memoryId: string): boolean {
  const row = asRecord(evidence);
  return (
    row["memory_id"] === memoryId &&
    nonEmptyString(row["source_type"]) &&
    nonEmptyString(row["source_id"])
  );
}

interface RetrievalRunBindingInspection {
  runId: string;
  valid: boolean;
  issues: string[];
}

function inspectRetrievalRunBinding(
  run: RetrievalRun,
  selectedMemoryIds: readonly string[],
  selectedEvidenceIds: readonly string[],
  snapshot: LongRunStateSnapshot,
): RetrievalRunBindingInspection {
  const issues: string[] = [];
  if (!sameStringSet(run.result.selectedMemoryIds, selectedMemoryIds)) {
    issues.push(`${run.id}:selected_memory_ids_mismatch`);
  }
  if (!sameStringSet(run.result.selectedEvidenceIds, selectedEvidenceIds)) {
    issues.push(`${run.id}:selected_evidence_ids_mismatch`);
  }

  if (selectedEvidenceIds.length === 0) {
    if (!run.result.abstained) issues.push(`${run.id}:unexpected_selection`);
    if (run.evidenceBundle !== undefined) {
      issues.push(`${run.id}:abstention_has_evidence_bundle`);
    }
    return { runId: run.id, valid: issues.length === 0, issues };
  }

  if (run.result.abstained || run.evidenceBundle === undefined) {
    issues.push(`${run.id}:selected_recall_missing_evidence_bundle`);
    return { runId: run.id, valid: false, issues };
  }

  const selectedMemories = new Set(selectedMemoryIds);
  const bundleByEvidenceId = new Map(
    run.evidenceBundle.evidence.map((item) => [item.evidence.id, item]),
  );
  for (const evidenceId of selectedEvidenceIds) {
    const item = bundleByEvidenceId.get(evidenceId);
    if (item === undefined) {
      issues.push(`${run.id}:${evidenceId}:missing_bundle_item`);
      continue;
    }
    if (
      item.evidence.memoryId !== item.memoryId ||
      !selectedMemories.has(item.memoryId) ||
      !nonEmptyString(item.evidence.sourceId) ||
      !nonEmptyString(item.evidence.sourceType)
    ) {
      issues.push(`${run.id}:${evidenceId}:invalid_bundle_lineage`);
    }
    if (!retrievalSourceExists(item.evidence, snapshot)) {
      issues.push(`${run.id}:${evidenceId}:missing_source_row`);
    }

    const snapshotEvidence = run.inputSnapshot.evidence.find(
      (evidence) => evidence.id === evidenceId,
    );
    if (
      snapshotEvidence === undefined ||
      snapshotEvidence.memoryId !== item.memoryId ||
      snapshotEvidence.sourceId !== item.evidence.sourceId ||
      snapshotEvidence.sourceType !== item.evidence.sourceType
    ) {
      issues.push(`${run.id}:${evidenceId}:input_evidence_mismatch`);
    }
    const snapshotMemory = run.inputSnapshot.memories.find(
      (memory) => memory.id === item.memoryId,
    );
    if (!isRecallableMemory(snapshotMemory)) {
      issues.push(`${run.id}:${item.memoryId}:input_memory_not_recallable`);
    }
  }

  const bundleEvidenceIds = run.evidenceBundle.evidence.map(
    (item) => item.evidence.id,
  );
  if (!sameStringSet(bundleEvidenceIds, selectedEvidenceIds)) {
    issues.push(`${run.id}:bundle_evidence_ids_mismatch`);
  }
  return { runId: run.id, valid: issues.length === 0, issues };
}

function retrievalSourceExists(
  evidence: { sourceId: string; sourceType: string },
  snapshot: LongRunStateSnapshot,
): boolean {
  switch (evidence.sourceType) {
    case "message":
      return snapshot.messages.some(
        (item) => rowId(item) === evidence.sourceId,
      );
    case "activity_event":
      return snapshot.activityEvents.some(
        (item) => rowId(item) === evidence.sourceId,
      );
    case "schedule_event":
      return snapshot.schedule.some(
        (item) => rowId(item) === evidence.sourceId,
      );
    default:
      // Character sources and manual evidence are represented inside the
      // immutable retrieval input, but are not duplicated in this snapshot.
      return true;
  }
}

function isRecallableMemory(memory: unknown): boolean {
  if (memory === undefined) return false;
  const row = asRecord(memory);
  const status = row["status"] === undefined ? "active" : text(row["status"]);
  return (
    status === "active" &&
    !nonEmptyString(field(row, "supersededById", "superseded_by_id")) &&
    !nonEmptyString(field(row, "mergedIntoId", "merged_into_id"))
  );
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

interface MemorySupersessionInspection {
  validLinks: Array<{ memoryId: string; replacementId: string }>;
  invalidLinks: string[];
  duplicateActiveSubjects: string[];
}

function inspectMemorySupersession(
  before: readonly unknown[],
  after: readonly unknown[],
): MemorySupersessionInspection {
  const beforeById = byId(before);
  const afterById = byId(after);
  const validLinks: MemorySupersessionInspection["validLinks"] = [];
  const invalidLinks: string[] = [];
  for (const memory of after) {
    const row = asRecord(memory);
    if (row["status"] !== "superseded") continue;
    const id = rowId(memory);
    const replacementId = text(row["superseded_by_id"]);
    const replacement = afterById.get(replacementId);
    if (
      id === "" ||
      replacementId === "" ||
      replacementId === id ||
      replacement === undefined ||
      !isRecallableMemory(replacement)
    ) {
      invalidLinks.push(id || "missing-id");
      continue;
    }
    const replacementRow = asRecord(replacement);
    const subject = text(row["claim_subject_key"]);
    const replacementSubject = text(replacementRow["claim_subject_key"]);
    if (
      subject !== "" &&
      replacementSubject !== "" &&
      subject !== replacementSubject
    ) {
      invalidLinks.push(id);
      continue;
    }
    validLinks.push({ memoryId: id, replacementId });
  }

  const activeSubjects = new Map<string, string[]>();
  for (const memory of after) {
    const row = asRecord(memory);
    if (row["status"] !== "active") continue;
    const subject = text(row["claim_subject_key"]).trim();
    if (subject === "") continue;
    activeSubjects.set(subject, [
      ...(activeSubjects.get(subject) ?? []),
      rowId(memory),
    ]);
  }
  const duplicateActiveSubjects = [...activeSubjects.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([subject]) => subject);

  // Reading an already-corrected claim is valid; the before map is retained so
  // a malformed mutation cannot hide behind an unrelated historical link.
  const changedToSuperseded = validLinks.filter((link) => {
    const previous = asRecord(beforeById.get(link.memoryId));
    return previous["status"] !== "superseded";
  });
  if (changedToSuperseded.length > 0)
    return {
      validLinks: changedToSuperseded,
      invalidLinks,
      duplicateActiveSubjects,
    };
  return { validLinks, invalidLinks, duplicateActiveSubjects };
}

function settlementIntervalIssues(
  settlement: unknown,
  beforeCursorValue: unknown,
  afterCursorValue: unknown,
): string[] {
  const row = asRecord(settlement);
  const beforeCursor = asRecord(beforeCursorValue);
  const afterCursor = asRecord(afterCursorValue);
  const id = rowId(settlement) || "missing-id";
  const fromUtc = text(field(row, "fromUtc", "from_utc"));
  const toUtc = text(field(row, "toUtc", "to_utc"));
  const beforeUtc = text(beforeCursor["lastSettledAtUtc"]);
  const afterUtc = text(afterCursor["lastSettledAtUtc"]);
  const issues: string[] = [];
  if (
    !validUtc(fromUtc) ||
    !validUtc(toUtc) ||
    Date.parse(toUtc) <= Date.parse(fromUtc)
  ) {
    issues.push(`${id}:invalid_interval`);
  }
  if (fromUtc !== beforeUtc) issues.push(`${id}:from_cursor_mismatch`);
  if (toUtc !== afterUtc) issues.push(`${id}:to_cursor_mismatch`);
  return issues;
}

function proactiveSourceIssues(
  message: unknown,
  snapshot: LongRunStateSnapshot,
): string[] {
  const row = asRecord(message);
  const messageId = rowId(message) || "missing-id";
  const triggerEventId = text(row["trigger_event_id"]);
  const followUpId = text(row["trigger_follow_up_intent_id"]);
  if (triggerEventId === "") {
    return followUpId === "" ? [`${messageId}:missing_proactive_source`] : [];
  }

  const activityExists = snapshot.activityEvents.some(
    (event) => rowId(event) === triggerEventId,
  );
  const candidate = snapshot.proactiveCandidates.find((item) => {
    const candidateRow = asRecord(item);
    return (
      candidateRow["trigger_event_id"] === triggerEventId &&
      candidateRow["sent_message_id"] === messageId
    );
  });
  const sentEvent = snapshot.domainEvents.find((event) => {
    if (eventType(event) !== "conversation.proactive_message_sent")
      return false;
    const payload = eventPayload(event);
    return (
      payload["messageId"] === messageId &&
      payload["triggerEventId"] === triggerEventId &&
      (candidate === undefined ||
        payload["proactiveCandidateId"] === rowId(candidate))
    );
  });
  const issues: string[] = [];
  if (!activityExists) issues.push(`${messageId}:missing_activity_event`);
  if (candidate === undefined)
    issues.push(`${messageId}:missing_proactive_candidate`);
  if (sentEvent === undefined) issues.push(`${messageId}:missing_sent_event`);
  return issues;
}

function turnEventMatchesResponse(
  event: unknown,
  response: SendMessageResponse | undefined,
  snapshot: LongRunStateSnapshot,
): boolean {
  if (
    response === undefined ||
    eventType(event) !== "conversation.turn_committed"
  ) {
    return false;
  }
  const payload = eventPayload(event);
  if (
    payload["userMessageId"] !== response.userMessage.id ||
    payload["assistantMessageId"] !== response.assistantMessage.id ||
    eventCausationId(event) !== response.userMessage.id ||
    !nonEmptyString(eventCorrelationId(event))
  ) {
    return false;
  }
  const messages = new Set(snapshot.messages.map(rowId));
  if (
    !messages.has(response.userMessage.id) ||
    !messages.has(response.assistantMessage.id)
  ) {
    return false;
  }
  const scheduleIds = new Set(snapshot.schedule.map(rowId));
  if (
    !stringArray(payload["scheduleItemIds"]).every((id) => scheduleIds.has(id))
  ) {
    return false;
  }
  const memoryIds = new Set(snapshot.memories.map(rowId));
  return stringArray(payload["memoryIds"]).every((id) => memoryIds.has(id));
}

function localShanghaiParts(utc: string): { day: string; hour: number } {
  if (!validUtc(utc)) return { day: "invalid", hour: -1 };
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(utc));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "00";
  return {
    day: `${part("year")}-${part("month")}-${part("day")}`,
    hour: Number(part("hour")),
  };
}
