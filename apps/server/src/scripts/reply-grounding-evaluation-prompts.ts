import { createHash } from "node:crypto";
import {
  assembleChatPrompt,
  REPLY_TASK_GROUNDING_POLICY,
  type AssemblePromptInput,
} from "@personasim/features";
import { initialRuntimeState } from "../domain/defaults.js";
import { buildArchitecturePersonaFixtureCharacter } from "./architecture-persona-cases.js";
import {
  REPLY_GROUNDING_EVALUATION_CASES,
  REPLY_GROUNDING_EVALUATION_NOW,
  type ReplyGroundingEvaluationCase,
} from "./reply-grounding-evaluation-cases.js";

export const REPLY_GROUNDING_EVALUATION_ARMS = [
  "without_new_policy",
  "with_new_policy",
] as const;
export const replyGroundingEvaluationHash = (value: unknown): string =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");

/** Includes provider-added JSON/schema headers and all HTTP body parameters. */
export function replyGroundingWireProof(
  request: unknown,
  arm: (typeof REPLY_GROUNDING_EVALUATION_ARMS)[number],
) {
  if (
    !request ||
    typeof request !== "object" ||
    !("messages" in request) ||
    !Array.isArray(request.messages)
  )
    throw new Error("Expected a complete provider wire request");
  let occurrences = 0;
  const normalized = {
    ...request,
    messages: request.messages.map((message: unknown) => {
      if (
        !message ||
        typeof message !== "object" ||
        !("content" in message) ||
        typeof message.content !== "string"
      )
        throw new Error("Expected textual provider wire messages");
      occurrences +=
        message.content.split(REPLY_TASK_GROUNDING_POLICY).length - 1;
      return {
        ...message,
        content: message.content.replace(REPLY_TASK_GROUNDING_POLICY, ""),
      };
    }),
  };
  if (occurrences !== (arm === "with_new_policy" ? 1 : 0))
    throw new Error("Wire policy count differs from the assigned arm");
  return {
    requestSha256: replyGroundingEvaluationHash(request),
    nonPolicyRequestSha256: replyGroundingEvaluationHash(normalized),
  };
}

/** Remove only the final admitted policy. Do not reassemble or refill budget. */
export function removeReplyTaskGroundingPolicy(system: string): string {
  if (
    system.split(REPLY_TASK_GROUNDING_POLICY).length !== 2 ||
    system.split("END_REPLY_TASK_GROUNDING_POLICY").length !== 2
  )
    throw new Error("Expected exactly one complete admitted grounding policy");
  return system.replace(REPLY_TASK_GROUNDING_POLICY, "");
}

export function replyGroundingEvaluationInput(
  probe: ReplyGroundingEvaluationCase,
): AssemblePromptInput {
  const original = buildArchitecturePersonaFixtureCharacter(probe.personaId);
  const character = {
    ...original,
    identity: {
      ...original.identity,
      temporalFrame: { mode: "realtime" as const, eraLabel: "2026年的上海" },
    },
  };
  const initial = initialRuntimeState(
    character.id,
    REPLY_GROUNDING_EVALUATION_NOW,
    character,
  );
  const { currentActivityId, locationContext, ...state } = initial;
  void currentActivityId;
  void locationContext;
  return {
    character,
    state: { ...state, ...probe.state },
    schedule: [],
    memories: [],
    recentMessages: probe.history.map((message, index) => ({
      ...message,
      createdAtUtc: new Date(
        Date.parse(REPLY_GROUNDING_EVALUATION_NOW) -
          (probe.history.length - index) * 60_000,
      ).toISOString(),
    })),
    nowUtc: REPLY_GROUNDING_EVALUATION_NOW,
    userMessage: probe.userText,
    lifePlanningMode: "fuzzy",
    liveWorldEffectsMode: "off",
    decisionMode: "reply_only",
    maxInputTokens: 32_000,
  };
}

export function buildReplyGroundingEvaluationCells() {
  const captures = REPLY_GROUNDING_EVALUATION_CASES.map((probe) => {
    const input = replyGroundingEvaluationInput(probe);
    const assembled = assembleChatPrompt(input);
    if (assembled.prompt.includes(REPLY_TASK_GROUNDING_POLICY))
      throw new Error("Grounding policy must occur only once in system");
    const without = removeReplyTaskGroundingPolicy(assembled.system);
    const proof = {
      policySha256: replyGroundingEvaluationHash(REPLY_TASK_GROUNDING_POLICY),
      productionSha256: replyGroundingEvaluationHash({
        system: assembled.system,
        prompt: assembled.prompt,
      }),
      nonPolicySystemSha256: replyGroundingEvaluationHash(without),
      promptSha256: replyGroundingEvaluationHash(assembled.prompt),
      strategySha256: replyGroundingEvaluationHash(assembled.replyStrategy),
      inputSha256: replyGroundingEvaluationHash(input),
      onlyChange: "remove_exact_admitted_policy_block",
      productionStrategyUnchanged: true,
    };
    return { caseId: probe.id, input, assembled, without, proof };
  });
  return {
    captures,
    cells: captures.flatMap((capture) =>
      REPLY_GROUNDING_EVALUATION_ARMS.map((arm) => ({
        id: `${capture.caseId}/${arm}`,
        caseId: capture.caseId,
        arm,
        system:
          arm === "with_new_policy"
            ? capture.assembled.system
            : capture.without,
        prompt: capture.assembled.prompt,
        proof: capture.proof,
      })),
    ),
  };
}
export type ReplyGroundingEvaluationCell = ReturnType<
  typeof buildReplyGroundingEvaluationCells
>["cells"][number];
