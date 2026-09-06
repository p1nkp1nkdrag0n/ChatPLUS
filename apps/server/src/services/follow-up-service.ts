import { DateTime } from "luxon";

import {
  buildCareCueDedupeKey,
  didMentionCareCue,
  evaluateFollowUpMessage,
  normalizeFollowUpCandidate,
  resolveFollowUpWindow,
  selectRelevantCareCues,
  shouldDismissCareCue,
  type CareCueCandidateLike,
  type FollowUpCandidateLike,
  type FollowUpGroundingRejectionCode,
} from "@personasim/features";
import type { Clock } from "@personasim/providers";

import { createEntityId } from "../domain/id.js";
import {
  sourceTextHash,
  type StoredContinuityGrounding,
} from "./follow-up-repository.js";
import type {
  FollowUpRepository,
  StoredCareCue,
  StoredFollowUpIntent,
  StoredSourceMessage,
} from "./follow-up-repository.js";

export type CandidateServiceRejectionCode =
  | "source_message_not_found"
  | "source_agent_mismatch"
  | "invalid_source_role"
  | "missing_grounded_quote"
  | "unrelated_context"
  | "ambiguous_timing"
  | "follow_up_not_revalidatable"
  | "source_needs_review"
  | FollowUpGroundingRejectionCode;

export type CreateFollowUpResult =
  | {
      accepted: true;
      inserted: boolean;
      followUp: StoredFollowUpIntent;
    }
  | {
      accepted: false;
      rejection: {
        reasonCode: CandidateServiceRejectionCode;
        reasonSummary: string;
      };
    };

export type CreateCareCueResult =
  | {
      accepted: true;
      inserted: boolean;
      careCue: StoredCareCue;
    }
  | {
      accepted: false;
      rejection: {
        reasonCode: CandidateServiceRejectionCode;
        reasonSummary: string;
      };
    };

export interface UserContinuityTransitions {
  resolvedFollowUpIds: string[];
  cancelledFollowUpIds: string[];
  dismissedCareCueIds: string[];
}

export class FollowUpService {
  constructor(
    private readonly repository: FollowUpRepository,
    private readonly clock: Clock,
  ) {}

  createFollowUp(input: {
    agentId: string;
    sourceMessageId: string;
    timezone: string;
    candidate: FollowUpCandidateLike;
  }): CreateFollowUpResult {
    const source = this.repository.getSourceMessage(input.sourceMessageId);
    if (source === undefined) {
      return rejected(
        "source_message_not_found",
        "The candidate source message does not exist.",
      );
    }
    if (source.agentId !== input.agentId) {
      return rejected(
        "source_agent_mismatch",
        "The candidate source belongs to another agent.",
      );
    }
    if (source.role === "system") {
      return rejected(
        "invalid_source_role",
        "A system message cannot own a follow-up subject.",
      );
    }
    if (!this.repository.isSourceEvidenceUsable(input.agentId, source.id))
      return rejected(
        "source_needs_review",
        "The source has superseded or unreviewed memory evidence.",
      );

    const nowUtc = this.clock.nowUtc();
    const normalized = normalizeFollowUpCandidate({
      candidate: input.candidate,
      agentId: input.agentId,
      sourceMessage: {
        id: source.id,
        role: source.role,
        text: source.text,
      },
      supportingMessages: this.repository
        .getAdjacentTurnMessages(source)
        .filter(
          (message) =>
            message.role !== "system" &&
            this.repository.isSourceEvidenceUsable(input.agentId, message.id),
        )
        .map((message) => ({
          id: message.id,
          role: message.role as "user" | "assistant",
          text: message.text,
        })),
      nowUtc: source.createdAtUtc,
      timezone: input.timezone,
    });
    if (!normalized.accepted) {
      return {
        accepted: false,
        rejection: normalized.rejection,
      };
    }

    return this.repository.transaction(() => {
      const sources = normalized.followUp.grounding.sourceMessageIds.map((id) =>
        this.repository.getSourceMessage(id),
      );
      if (sources.some((message) => message === undefined))
        return rejected(
          "source_message_not_found",
          "The verified source chain is no longer available.",
        );
      const inserted = this.repository.insertFollowUp({
        id: createEntityId("followup"),
        agentId: input.agentId,
        sessionId: source.sessionId,
        subjectType: normalized.followUp.subjectType,
        contextSummary: normalized.followUp.contextSummary,
        expectedOutcomeDescription:
          normalized.followUp.expectedOutcomeDescription,
        sourceMessageId: source.id,
        earliestAtUtc: normalized.followUp.earliestAtUtc,
        expiresAtUtc: normalized.followUp.expiresAtUtc,
        dedupeKey: normalized.followUp.dedupeKey,
        createdAtUtc: nowUtc,
        grounding: {
          version: 1,
          basis: normalized.followUp.grounding,
          contextSummary: normalized.followUp.contextSummary,
          guidance: normalized.followUp.expectedOutcomeDescription,
          sources: sources.map((message) => ({
            id: message!.id,
            role: message!.role,
            hash: sourceTextHash(message!.text),
            sessionId: message!.sessionId,
            createdAtUtc: message!.createdAtUtc,
          })),
        },
      });
      return {
        accepted: true,
        inserted: inserted.inserted,
        followUp: inserted.record,
      };
    });
  }

  /** Restore one legacy pending record only after the same public semantic
   * check used for new candidates. Relative dates use the original creation
   * instant, so reviewing an old "tomorrow" never postpones it to tomorrow. */
  revalidateFollowUp(input: {
    agentId: string;
    id: string;
    timezone: string;
  }): CreateFollowUpResult {
    return this.repository.transaction(() => {
      const record = this.repository.getFollowUp(input.id);
      if (
        record === undefined ||
        record.agentId !== input.agentId ||
        record.status !== "pending" ||
        record.attemptCount !== 0 ||
        record.sentMessageId !== undefined
      ) {
        return rejected(
          "follow_up_not_revalidatable",
          "Only an unsent pending record belonging to this agent can be reviewed.",
        );
      }
      const source = this.repository.getSourceMessage(record.sourceMessageId);
      if (source === undefined || source.agentId !== record.agentId)
        return rejected(
          "source_message_not_found",
          "The record's original source is no longer available.",
        );
      if (source.role === "system")
        return rejected(
          "invalid_source_role",
          "A system message cannot establish a follow-up basis.",
        );
      if (!this.repository.isSourceEvidenceUsable(input.agentId, source.id))
        return rejected(
          "source_needs_review",
          "The source has superseded or unreviewed memory evidence.",
        );
      const normalized = normalizeFollowUpCandidate({
        agentId: record.agentId,
        sourceMessage: { id: source.id, role: source.role, text: source.text },
        supportingMessages: this.repository
          .getAdjacentTurnMessages(source)
          .filter(
            (message) =>
              message.role !== "system" &&
              this.repository.isSourceEvidenceUsable(input.agentId, message.id),
          )
          .map((message) => ({
            id: message.id,
            role: message.role as "user" | "assistant",
            text: message.text,
          })),
        candidate: {
          subjectType: record.subjectType,
          contextSummary: source.text.slice(0, 1_000),
          expectedOutcomeDescription: record.expectedOutcomeDescription,
          timingHint: source.text.slice(0, 240),
          evidenceQuotes: [source.text],
          reasonCode: "legacy_evidence_review",
          reasonSummary:
            "Rebuild a pending record from its actual stored source.",
        },
        nowUtc: record.createdAtUtc,
        timezone: input.timezone,
      });
      if (!normalized.accepted) return normalized;
      const basis = normalized.followUp;
      const sources = basis.grounding.sourceMessageIds.map((id) =>
        this.repository.getSourceMessage(id)!,
      );
      const restored = this.repository.restoreFollowUpGrounding({
        id: record.id,
        expectedRevision: record.revision,
        contextSummary: basis.contextSummary,
        expectedOutcomeDescription: basis.expectedOutcomeDescription,
        earliestAtUtc: basis.earliestAtUtc,
        expiresAtUtc: basis.expiresAtUtc,
        dedupeKey: basis.dedupeKey,
        grounding: {
          version: 1,
          basis: basis.grounding,
          contextSummary: basis.contextSummary,
          guidance: basis.expectedOutcomeDescription,
          sources: sources.map((message) => ({
            id: message.id,
            role: message.role,
            hash: sourceTextHash(message.text),
            sessionId: message.sessionId,
            createdAtUtc: message.createdAtUtc,
          })),
        },
        updatedAtUtc: this.clock.nowUtc(),
      });
      return restored === undefined
        ? rejected(
            "follow_up_not_revalidatable",
            "The pending record is claimed, changed, or duplicates another verified follow-up.",
          )
        : { accepted: true, inserted: false, followUp: restored };
    });
  }

  createCareCue(input: {
    agentId: string;
    sourceMessageId: string;
    timezone: string;
    candidate: CareCueCandidateLike;
    ttlDays?: number;
    maxMentions?: number;
  }): CreateCareCueResult {
    const source = this.repository.getSourceMessage(input.sourceMessageId);
    if (source === undefined) {
      return rejected(
        "source_message_not_found",
        "The candidate source message does not exist.",
      );
    }
    if (source.agentId !== input.agentId) {
      return rejected(
        "source_agent_mismatch",
        "The candidate source belongs to another agent.",
      );
    }
    if (source.role !== "user") {
      return rejected(
        "invalid_source_role",
        "A care cue must be grounded in a user message.",
      );
    }
    if (!this.repository.isSourceEvidenceUsable(input.agentId, source.id))
      return rejected(
        "source_needs_review",
        "The source has superseded or unreviewed memory evidence.",
      );

    const nowUtc = this.clock.nowUtc();
    const normalized = normalizeCareCue({
      agentId: input.agentId,
      source,
      candidate: input.candidate,
      timezone: input.timezone,
      nowUtc,
      ...(input.ttlDays === undefined ? {} : { ttlDays: input.ttlDays }),
      ...(input.maxMentions === undefined
        ? {}
        : { maxMentions: input.maxMentions }),
    });
    if (!normalized.accepted) return normalized;

    return this.repository.transaction(() => {
      const inserted = this.repository.insertCareCue({
        id: createEntityId("carecue"),
        agentId: input.agentId,
        sessionId: source.sessionId,
        contextSummary: normalized.careCue.contextSummary,
        mentionGuidance: normalized.careCue.mentionGuidance,
        sourceMessageId: source.id,
        expiresAtUtc: normalized.careCue.expiresAtUtc,
        maxMentions: normalized.careCue.maxMentions,
        dedupeKey: normalized.careCue.dedupeKey,
        createdAtUtc: nowUtc,
        grounding: {
          version: 1,
          basis: {
            basisKind: "user_context",
            matter: normalized.careCue.contextSummary,
          },
          contextSummary: normalized.careCue.contextSummary,
          guidance: normalized.careCue.mentionGuidance,
          sources: [
            {
              id: source.id,
              role: source.role,
              hash: sourceTextHash(source.text),
              sessionId: source.sessionId,
              createdAtUtc: source.createdAtUtc,
            },
          ],
        } satisfies StoredContinuityGrounding,
        ...(normalized.careCue.earliestAtUtc === undefined
          ? {}
          : { earliestAtUtc: normalized.careCue.earliestAtUtc }),
      });
      return {
        accepted: true,
        inserted: inserted.inserted,
        careCue: inserted.record,
      };
    });
  }

  handleUserMessage(input: {
    agentId: string;
    messageId: string;
  }): UserContinuityTransitions {
    const message = this.repository.getSourceMessage(input.messageId);
    if (
      message === undefined ||
      message.agentId !== input.agentId ||
      message.role !== "user"
    ) {
      return {
        resolvedFollowUpIds: [],
        cancelledFollowUpIds: [],
        dismissedCareCueIds: [],
      };
    }

    const nowUtc = this.clock.nowUtc();
    return this.repository.transaction(() => {
      this.repository.expireFollowUps(input.agentId, nowUtc);
      this.repository.expireCareCues(input.agentId, nowUtc);
      const resolvedFollowUpIds: string[] = [];
      const cancelledFollowUpIds: string[] = [];
      const dismissedCareCueIds: string[] = [];

      for (const followUp of this.repository.listOpenFollowUps(input.agentId)) {
        if (!textsAreRelated(followUp.contextSummary, message.text)) {
          continue;
        }
        const evaluation = evaluateFollowUpMessage(followUp, message.text);
        if (evaluation.outcome === "none") continue;
        const transitioned = this.repository.transitionFollowUp({
          id: followUp.id,
          expectedRevision: followUp.revision,
          outcome: evaluation.outcome,
          resolutionMessageId: message.id,
          updatedAtUtc: nowUtc,
        });
        if (transitioned === undefined) continue;
        if (evaluation.outcome === "resolved") {
          resolvedFollowUpIds.push(transitioned.id);
        } else {
          cancelledFollowUpIds.push(transitioned.id);
        }
      }

      for (const cue of this.repository.listActiveCareCues(input.agentId)) {
        if (!shouldDismissCareCue(cue, message.text)) continue;
        const dismissed = this.repository.dismissCareCue({
          id: cue.id,
          expectedRevision: cue.revision,
          messageId: message.id,
          updatedAtUtc: nowUtc,
        });
        if (dismissed !== undefined) dismissedCareCueIds.push(dismissed.id);
      }

      return {
        resolvedFollowUpIds,
        cancelledFollowUpIds,
        dismissedCareCueIds,
      };
    });
  }

  selectCareCues(input: {
    agentId: string;
    userText: string;
    limit?: number;
  }): StoredCareCue[] {
    const nowUtc = this.clock.nowUtc();
    return this.repository.transaction(() => {
      this.repository.expireCareCues(input.agentId, nowUtc);
      return selectRelevantCareCues({
        cues: this.repository
          .listActiveCareCues(input.agentId)
          .filter((cue) => this.repository.isCareCueEvidenceCurrent(cue.id)),
        userText: input.userText,
        nowUtc,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
    });
  }

  recordCareCueMentions(input: {
    agentId: string;
    messageId: string;
    cueIds: readonly string[];
  }): string[] {
    const message = this.repository.getSourceMessage(input.messageId);
    if (
      message === undefined ||
      message.agentId !== input.agentId ||
      message.role !== "assistant"
    ) {
      return [];
    }

    const nowUtc = this.clock.nowUtc();
    return this.repository.transaction(() => {
      const mentionedIds: string[] = [];
      for (const cueId of new Set(input.cueIds)) {
        const cue = this.repository.getCareCue(cueId);
        if (
          cue === undefined ||
          cue.agentId !== input.agentId ||
          !this.repository.isCareCueEvidenceCurrent(cue.id) ||
          !didMentionCareCue(cue, message.text)
        ) {
          continue;
        }
        const mentioned = this.repository.recordCareCueMention({
          id: cue.id,
          expectedRevision: cue.revision,
          messageId: message.id,
          updatedAtUtc: nowUtc,
        });
        if (mentioned !== undefined) mentionedIds.push(mentioned.id);
      }
      return mentionedIds;
    });
  }

  expire(agentId: string): { followUps: number; careCues: number } {
    const nowUtc = this.clock.nowUtc();
    return this.repository.transaction(() => ({
      followUps: this.repository.expireFollowUps(agentId, nowUtc),
      careCues: this.repository.expireCareCues(agentId, nowUtc),
    }));
  }
}

function normalizeCareCue(input: {
  agentId: string;
  source: StoredSourceMessage;
  candidate: CareCueCandidateLike;
  timezone: string;
  nowUtc: string;
  ttlDays?: number;
  maxMentions?: number;
}):
  | {
      accepted: true;
      careCue: {
        contextSummary: string;
        mentionGuidance: string;
        earliestAtUtc?: string;
        expiresAtUtc: string;
        maxMentions: number;
        dedupeKey: string;
      };
    }
  | Exclude<CreateCareCueResult, { accepted: true }> {
  const groundedQuotes = [...new Set(input.candidate.evidenceQuotes)]
    .map((quote) => quote.trim())
    .filter((quote) => isGroundedEvidence(quote, input.source.text));
  if (groundedQuotes.length === 0) {
    return rejected(
      "missing_grounded_quote",
      "A care cue needs a quote from its source message.",
    );
  }
  if (
    !groundedQuotes.some((quote) =>
      textsAreRelated(input.candidate.contextSummary, quote),
    )
  ) {
    return rejected(
      "unrelated_context",
      "The care cue context is not grounded in its evidence.",
    );
  }

  const timingHint = input.candidate.timingHint?.trim();
  const window =
    timingHint === undefined || timingHint === ""
      ? undefined
      : resolveFollowUpWindow(input.source.text, input.nowUtc, input.timezone);
  if (timingHint !== undefined && timingHint !== "" && window === undefined) {
    return rejected(
      "ambiguous_timing",
      "The care cue timing is too ambiguous to schedule safely.",
    );
  }

  // A related quote cannot endorse instructions that presume an unaccepted
  // activity. Preserve user context and generate bounded guidance ourselves.
  const contextSummary = compactText(input.source.text, 1_000);
  const mentionGuidance =
    "仅在相关语境中回应用户原话所述感受、事项或关心方式；不要假定用户采纳建议、已行动或已经成功，也不要安排新任务。";
  const ttlDays = clampInteger(input.ttlDays ?? 14, 1, 30);
  const maxMentions = clampInteger(input.maxMentions ?? 1, 1, 3);
  const expiryAnchor = window?.earliestAtUtc ?? input.nowUtc;
  const expiresAtUtc = DateTime.fromISO(expiryAnchor, { setZone: true })
    .plus({ days: ttlDays })
    .toUTC()
    .toISO()!;
  const dedupeKey = buildCareCueDedupeKey({
    agentId: input.agentId,
    contextSummary,
    expiresAtUtc,
    timezone: input.timezone,
  });
  const careCue = {
    contextSummary,
    mentionGuidance,
    expiresAtUtc,
    maxMentions,
    dedupeKey,
  };
  return window === undefined
    ? { accepted: true, careCue }
    : {
        accepted: true,
        careCue: { ...careCue, earliestAtUtc: window.earliestAtUtc },
      };
}

function rejected(
  reasonCode: CandidateServiceRejectionCode,
  reasonSummary: string,
): {
  accepted: false;
  rejection: {
    reasonCode: CandidateServiceRejectionCode;
    reasonSummary: string;
  };
} {
  return { accepted: false, rejection: { reasonCode, reasonSummary } };
}

function compactText(value: string, maximum: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= maximum ? compact : compact.slice(0, maximum);
}

function normalizedEvidence(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function isGroundedEvidence(quote: string, sourceText: string): boolean {
  const normalizedQuote = normalizedEvidence(quote);
  if (normalizedQuote.length < 2) return false;
  if (/^[a-z0-9]+$/iu.test(normalizedQuote) && normalizedQuote.length < 4) {
    return false;
  }
  return normalizedEvidence(sourceText).includes(normalizedQuote);
}

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "been",
  "completed",
  "done",
  "failed",
  "finished",
  "from",
  "have",
  "how",
  "later",
  "passed",
  "that",
  "the",
  "their",
  "there",
  "this",
  "user",
  "went",
  "whether",
  "will",
  "with",
]);

function textsAreRelated(leftValue: string, rightValue: string): boolean {
  const left = normalizedEvidence(leftValue);
  const right = normalizedEvidence(rightValue);
  if (
    Math.min(left.length, right.length) >= 2 &&
    (left.includes(right) || right.includes(left))
  ) {
    return true;
  }
  const rightFeatures = textFeatures(rightValue);
  return [...textFeatures(leftValue)].some((feature) =>
    rightFeatures.has(feature),
  );
}

function textFeatures(value: string): Set<string> {
  const result = new Set<string>();
  for (const word of value.toLowerCase().match(/[a-z0-9]{3,}/gu) ?? []) {
    if (!STOP_WORDS.has(word)) result.add(word);
  }
  for (const run of normalizedEvidence(value).match(/[\p{Script=Han}]{2,}/gu) ??
    []) {
    if (run.length <= 4) result.add(run);
    for (let index = 0; index < run.length - 1; index += 1) {
      result.add(run.slice(index, index + 2));
    }
  }
  return result;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}
