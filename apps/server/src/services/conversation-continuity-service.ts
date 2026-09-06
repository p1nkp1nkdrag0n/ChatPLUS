import {
  CareCueCandidateSchema,
  FollowUpCandidateSchema,
  ModelCareCueCandidateSchema,
  ModelContinuityTurnEffectsSchema,
  ModelFollowUpCandidateSchema,
  type CareCueCandidate,
  type FollowUpCandidate,
  type ModelCareCueCandidate,
  type ModelFollowUpCandidate,
} from "@personasim/contracts";

import type { StoredMessage } from "../db/store.js";
import type {
  CheckpointService,
  CheckpointServiceResult,
} from "./checkpoint-service.js";
import type { StoredCareCue } from "./follow-up-repository.js";
import type {
  CandidateServiceRejectionCode,
  FollowUpService,
  UserContinuityTransitions,
} from "./follow-up-service.js";
import type {
  MemoryLifecycleService,
  MemoryReconciliationResult,
} from "./memory-lifecycle-service.js";

export interface ConversationContinuityPromptContext {
  cueIds: string[];
  careCues: Array<{
    id: string;
    contextSummary: string;
    mentionGuidance: string;
    expiresAtUtc: string;
  }>;
}

export interface ConversationContinuityRejection {
  effect: "follow_up" | "care_cue" | "continuity_envelope";
  reasonCode: string;
  reasonSummary: string;
  raw: unknown;
}

export interface ConversationContinuityCommitResult {
  transitions: UserContinuityTransitions;
  followUpIds: string[];
  careCueIds: string[];
  mentionedCareCueIds: string[];
  memoryReconciliations: MemoryReconciliationResult[];
  rejections: ConversationContinuityRejection[];
  checkpoint?: CheckpointServiceResult;
}

/**
 * Owns conversation continuity rules outside ConversationService. Model output
 * remains a fuzzy proposal; source ownership, timestamps, transitions, retries,
 * and checkpoint commits stay server-owned.
 */
export class ConversationContinuityService {
  constructor(
    private readonly followUps: FollowUpService,
    private readonly checkpoints: CheckpointService,
    private readonly memoryLifecycle: MemoryLifecycleService,
    private readonly autobiographyMode: "off" | "shadow" | "enforced",
  ) {}

  preparePrompt(input: {
    agentId: string;
    userText: string;
    limit?: number;
  }): ConversationContinuityPromptContext {
    const cues = this.followUps.selectCareCues(input);
    return {
      cueIds: cues.map((cue) => cue.id),
      careCues: cues.map(promptCue),
    };
  }

  /** Called inside the message/memory transaction; background checkpoint
   * generation must never be responsible for current-fact correctness. */
  reconcileMemories(
    agentId: string,
    memoryIds: readonly string[],
  ): MemoryReconciliationResult[] {
    return this.memoryLifecycle.reconcileNewMemories(agentId, memoryIds);
  }

  async commitTurn(input: {
    agentId: string;
    sessionId: string;
    timezone: string;
    userMessage: StoredMessage;
    assistantMessage: StoredMessage;
    memoryIds: readonly string[];
    preReconciled?: MemoryReconciliationResult[];
    promptCueIds: readonly string[];
    rawEffects?: unknown;
  }): Promise<ConversationContinuityCommitResult> {
    const transitions = this.followUps.handleUserMessage({
      agentId: input.agentId,
      messageId: input.userMessage.id,
    });
    const parsed = ModelContinuityTurnEffectsSchema.safeParse(
      input.rawEffects ?? {},
    );
    const rejections: ConversationContinuityRejection[] = [];
    const followUpIds: string[] = [];
    const careCueIds: string[] = [];

    if (!parsed.success) {
      rejections.push({
        effect: "continuity_envelope",
        reasonCode: "schema_mismatch",
        reasonSummary: parsed.error.issues
          .map((issue) => issue.message)
          .join("; ")
          .slice(0, 1_000),
        raw: input.rawEffects,
      });
    } else {
      for (const rawCandidate of parsed.data.followUpCandidates) {
        const proposal = ModelFollowUpCandidateSchema.safeParse(rawCandidate);
        if (!proposal.success) {
          rejections.push(
            schemaCandidateRejection(
              "follow_up",
              proposal.error.issues.map((issue) => issue.message),
              rawCandidate,
            ),
          );
          continue;
        }

        const materialized = materializeFollowUpCandidate(proposal.data, input);
        const result = this.followUps.createFollowUp({
          agentId: input.agentId,
          sourceMessageId: materialized.source.id,
          timezone: input.timezone,
          candidate: materialized.candidate,
        });
        if (result.accepted) {
          followUpIds.push(result.followUp.id);
        } else {
          rejections.push(
            candidateRejection(
              "follow_up",
              result.rejection,
              materialized.candidate,
            ),
          );
        }
      }

      for (const rawCandidate of parsed.data.careCueCandidates) {
        const proposal = ModelCareCueCandidateSchema.safeParse(rawCandidate);
        if (!proposal.success) {
          rejections.push(
            schemaCandidateRejection(
              "care_cue",
              proposal.error.issues.map((issue) => issue.message),
              rawCandidate,
            ),
          );
          continue;
        }

        const candidate = materializeCareCueCandidate(proposal.data, input);
        const result = this.followUps.createCareCue({
          agentId: input.agentId,
          sourceMessageId: input.userMessage.id,
          timezone: input.timezone,
          candidate: {
            contextSummary: candidate.contextSummary,
            mentionGuidance: candidate.mentionGuidance,
            evidenceQuotes: candidate.evidenceQuotes,
            reasonCode: candidate.reasonCode,
            reasonSummary: candidate.reasonSummary,
            ...(candidate.timingHint === undefined
              ? {}
              : { timingHint: candidate.timingHint }),
          },
        });
        if (result.accepted) {
          careCueIds.push(result.careCue.id);
        } else {
          rejections.push(
            candidateRejection("care_cue", result.rejection, candidate),
          );
        }
      }
    }

    if (followUpIds.length === 0) {
      const deterministicCandidate = deriveExplicitFollowUpCandidate(input);
      if (deterministicCandidate !== undefined) {
        const result = this.followUps.createFollowUp({
          agentId: input.agentId,
          sourceMessageId: input.userMessage.id,
          timezone: input.timezone,
          candidate: deterministicCandidate,
        });
        if (result.accepted) {
          followUpIds.push(result.followUp.id);
        } else {
          rejections.push(
            candidateRejection(
              "follow_up",
              result.rejection,
              deterministicCandidate,
            ),
          );
        }
      }
    }

    if (careCueIds.length === 0) {
      const deterministicCandidate = deriveExplicitCareCueCandidate(input);
      if (deterministicCandidate !== undefined) {
        const result = this.followUps.createCareCue({
          agentId: input.agentId,
          sourceMessageId: input.userMessage.id,
          timezone: input.timezone,
          candidate: {
            contextSummary: deterministicCandidate.contextSummary,
            mentionGuidance: deterministicCandidate.mentionGuidance,
            evidenceQuotes: deterministicCandidate.evidenceQuotes,
            reasonCode: deterministicCandidate.reasonCode,
            reasonSummary: deterministicCandidate.reasonSummary,
            ...(deterministicCandidate.timingHint === undefined
              ? {}
              : { timingHint: deterministicCandidate.timingHint }),
          },
        });
        if (result.accepted) {
          careCueIds.push(result.careCue.id);
        } else {
          rejections.push(
            candidateRejection(
              "care_cue",
              result.rejection,
              deterministicCandidate,
            ),
          );
        }
      }
    }

    const mentionedCareCueIds = this.followUps.recordCareCueMentions({
      agentId: input.agentId,
      messageId: input.assistantMessage.id,
      cueIds: input.promptCueIds,
    });
    const memoryReconciliations =
      input.preReconciled ??
      this.reconcileMemories(input.agentId, input.memoryIds);
    const checkpoint =
      this.autobiographyMode === "off"
        ? undefined
        : await this.checkpoints.createIfNeeded({
            agentId: input.agentId,
            sessionId: input.sessionId,
          });

    return {
      transitions,
      followUpIds: [...new Set(followUpIds)],
      careCueIds: [...new Set(careCueIds)],
      mentionedCareCueIds,
      rejections,
      memoryReconciliations,
      ...(checkpoint === undefined ? {} : { checkpoint }),
    };
  }
}

type ContinuityTurnMaterializationInput = {
  userMessage: StoredMessage;
  assistantMessage: StoredMessage;
};

function materializeFollowUpCandidate(
  proposal: ModelFollowUpCandidate,
  input: ContinuityTurnMaterializationInput,
): { candidate: FollowUpCandidate; source: StoredMessage } {
  const subjectType = proposal.subjectType ?? "user_goal";
  const source = followUpProposalSource(subjectType, proposal, input);
  const evidenceQuotes = groundedQuotes(
    proposal.evidenceQuotes,
    source.content,
  );
  const groundedEvidence =
    evidenceQuotes.length > 0
      ? evidenceQuotes
      : [messageExcerpt(source.content)];
  const contextSummary = groundedSummary(
    proposal.contextSummary,
    groundedEvidence,
  );

  return {
    source,
    candidate: FollowUpCandidateSchema.parse({
      subjectType,
      contextSummary,
      expectedOutcomeDescription: compactContractText(
        proposal.expectedOutcomeDescription ??
          "询问这件事的后续结果或当前进展。",
        1_000,
      ),
      timingHint: compactContractText(
        proposal.timingHint ?? input.userMessage.content,
        240,
      ),
      evidenceQuotes: groundedEvidence,
      reasonCode: "server_materialized_follow_up",
      reasonSummary: "服务器依据本轮已存储消息物化模型的跟进语义提议。",
    }),
  };
}

function materializeCareCueCandidate(
  proposal: ModelCareCueCandidate,
  input: ContinuityTurnMaterializationInput,
): CareCueCandidate {
  const evidenceQuotes = groundedQuotes(
    proposal.evidenceQuotes,
    input.userMessage.content,
  );
  const groundedEvidence =
    evidenceQuotes.length > 0
      ? evidenceQuotes
      : [messageExcerpt(input.userMessage.content)];

  return CareCueCandidateSchema.parse({
    contextSummary: groundedSummary(proposal.contextSummary, groundedEvidence),
    mentionGuidance: compactContractText(
      proposal.mentionGuidance ??
        "在后续合适的对话中自然关心此事，避免重复追问。",
      1_000,
    ),
    evidenceQuotes: groundedEvidence,
    reasonCode: "server_materialized_care_cue",
    reasonSummary: "服务器依据本轮用户消息物化模型的关怀语义提议。",
    ...(proposal.timingHint === undefined
      ? {}
      : {
          timingHint: compactContractText(proposal.timingHint, 240),
        }),
  });
}

function deriveExplicitFollowUpCandidate(
  input: ContinuityTurnMaterializationInput,
): FollowUpCandidate | undefined {
  const userText = input.userMessage.content;
  const assistantText = input.assistantMessage.content;
  const explicitRequest =
    /提醒我|问我|记得(?:问|提醒)|到时候(?:问|提醒)|remind\s+me|ask\s+me|check\s+(?:in|on)/iu.test(
      userText,
    );
  const futureTiming =
    /明天|明日|后天|下周|下星期|周[一二三四五六日天]|星期[一二三四五六日天]|tomorrow|next\s+week|\d{1,2}\s*[:：点]\s*\d{0,2}/iu.test(
      userText,
    );
  const userCancelled = /不要|不用|别|取消|不必|无需/iu.test(userText);
  const assistantRefused =
    /不能|不行|没法|做不到|抱歉|无法|can(?:not|'t)|won't|sorry/iu.test(
      assistantText,
    );
  const assistantAccepted =
    /(?:^|[，。！？!\s])(?:好(?:的|啊|呀)?|行|没问题|可以)(?=[，。！？!\s]|$)|我(?:会|可以)|到时候(?:我)?(?:会)?(?:问|提醒)|sure|yes|i(?:'ll|\s+will)|can\s+do/iu.test(
      assistantText,
    );

  if (
    !explicitRequest ||
    !futureTiming ||
    (userCancelled && explicitFollowUpCancellationTargetsRequest(userText)) ||
    assistantRefused ||
    !assistantAccepted
  ) {
    return undefined;
  }

  const evidence = messageExcerpt(userText);
  return FollowUpCandidateSchema.parse({
    subjectType: "user_goal",
    contextSummary: evidence,
    expectedOutcomeDescription: "询问用户所述事项是否已经完成，并接收其结果。",
    timingHint: compactContractText(userText, 240),
    evidenceQuotes: [evidence],
    reasonCode: "explicit_user_follow_up_request",
    reasonSummary: "用户明确要求未来跟进，且角色在本轮回复中明确接受。",
  });
}

function explicitFollowUpCancellationTargetsRequest(userText: string): boolean {
  return /(?:\u4e0d\u8981|\u4e0d\u7528|\u522b|\u4e0d\u5fc5|\u65e0\u9700)(?:\u518d)?(?:\u63d0\u9192|\u95ee|\u8ddf\u8fdb)|\u53d6\u6d88(?:\u8fd9\u4e2a|\u8be5)?(?:\u63d0\u9192|\u8ddf\u8fdb)/iu.test(
    userText,
  );
}

function deriveExplicitCareCueCandidate(
  input: ContinuityTurnMaterializationInput,
): CareCueCandidate | undefined {
  const userText = input.userMessage.content;
  const explicitPreference =
    /(?:\u8bf7)?\u8bb0\u4f4f.{0,30}(?:\u5173\u6000|\u5173\u5fc3|\u65b9\u5f0f)|(?:\u5173\u6000|\u5173\u5fc3)(?:\u65b9\u5f0f|\u504f\u597d)/iu.test(
      userText,
    );
  const careInstruction =
    /(?:\u5148|\u9996\u5148).{0,30}(?:\u95ee\u6211|\u95ee)|(?:\u4e0d\u8981|\u522b).{0,20}(?:\u8bb2|\u8bf4).{0,20}(?:\u9053\u7406|\u8bf4\u6559)/iu.test(
      userText,
    );
  if (!explicitPreference || !careInstruction) return undefined;

  const evidence = messageExcerpt(userText);
  const hasTiming =
    /\u4eca\u5929|\u4eca\u65e5|\u660e\u5929|\u660e\u65e5|\u540e\u5929|\u4e0b\u5468|today|tomorrow|next\s+week|\d{1,2}\s*[:\uff1a\u70b9]\s*\d{0,2}/iu.test(
      userText,
    );
  return CareCueCandidateSchema.parse({
    contextSummary: evidence,
    mentionGuidance:
      "\u5728\u540e\u7eed\u76f8\u5173\u8bed\u5883\u4e2d\uff0c\u5148\u6309\u7528\u6237\u6307\u5b9a\u7684\u65b9\u5f0f\u5173\u5fc3\uff0c\u4e0d\u8981\u7acb\u523b\u8bb2\u9053\u7406\u3002",
    evidenceQuotes: [evidence],
    reasonCode: "explicit_user_care_preference",
    reasonSummary:
      "\u7528\u6237\u660e\u786e\u8981\u6c42\u8bb0\u4f4f\u4e00\u79cd\u6709\u8fb9\u754c\u7684\u5173\u6000\u65b9\u5f0f\u3002",
    ...(hasTiming ? { timingHint: compactContractText(userText, 240) } : {}),
  });
}

function followUpProposalSource(
  subjectType: FollowUpCandidate["subjectType"],
  proposal: ModelFollowUpCandidate,
  input: ContinuityTurnMaterializationInput,
): StoredMessage {
  if (subjectType === "character_commitment") {
    return input.assistantMessage;
  }
  if (subjectType !== "shared_commitment") {
    return input.userMessage;
  }

  const hasAssistantEvidence = proposal.evidenceQuotes.some((quote) =>
    containsEvidence(input.assistantMessage.content, quote),
  );
  const hasUserEvidence = proposal.evidenceQuotes.some((quote) =>
    containsEvidence(input.userMessage.content, quote),
  );
  return hasAssistantEvidence && !hasUserEvidence
    ? input.assistantMessage
    : input.userMessage;
}

function groundedQuotes(
  quotes: readonly string[],
  sourceText: string,
): string[] {
  return [...new Set(quotes.map((quote) => quote.trim()))]
    .filter((quote) => containsEvidence(sourceText, quote))
    .slice(0, 8);
}

function groundedSummary(
  proposed: string | undefined,
  evidenceQuotes: readonly string[],
): string {
  const proposedSummary =
    proposed === undefined ? undefined : compactContractText(proposed, 1_000);
  if (
    proposedSummary !== undefined &&
    evidenceQuotes.some(
      (quote) =>
        containsEvidence(proposedSummary, quote) ||
        containsEvidence(quote, proposedSummary),
    )
  ) {
    return proposedSummary;
  }
  return evidenceQuotes[0]!;
}

function messageExcerpt(text: string): string {
  return compactContractText(text, 500);
}

function compactContractText(text: string, maximum: number): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length <= maximum ? compact : compact.slice(0, maximum);
}

function schemaCandidateRejection(
  effect: "follow_up" | "care_cue",
  issues: readonly string[],
  raw: unknown,
): ConversationContinuityRejection {
  return {
    effect,
    reasonCode: "schema_mismatch",
    reasonSummary: issues.join("; ").slice(0, 1_000),
    raw,
  };
}

function promptCue(
  cue: StoredCareCue,
): ConversationContinuityPromptContext["careCues"][number] {
  return {
    id: cue.id,
    contextSummary: cue.contextSummary,
    mentionGuidance: cue.mentionGuidance,
    expiresAtUtc: cue.expiresAtUtc,
  };
}

function containsEvidence(text: string, quote: string): boolean {
  const normalize = (value: string): string =>
    value.toLowerCase().replace(/\s+/gu, "").trim();
  const normalizedQuote = normalize(quote);
  return (
    normalizedQuote.length >= 2 && normalize(text).includes(normalizedQuote)
  );
}

function candidateRejection(
  effect: "follow_up" | "care_cue",
  rejection: {
    reasonCode: CandidateServiceRejectionCode;
    reasonSummary: string;
  },
  raw: FollowUpCandidate | CareCueCandidate,
): ConversationContinuityRejection {
  return {
    effect,
    reasonCode: rejection.reasonCode,
    reasonSummary: rejection.reasonSummary,
    raw,
  };
}
