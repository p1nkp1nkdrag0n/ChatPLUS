import { DateTime } from "luxon";

import {
  evaluateProactivePostflight,
  evaluateProactivePreflight,
  type ProactivePostflightRejectionCode,
  type ProactivePreflightRejectionCode,
} from "@personasim/features";
import type { Clock } from "@personasim/providers";

import { createEntityId } from "../domain/id.js";
import type { ActorQueue } from "../runtime/actor-queue.js";
import type {
  ConversationActivityTracker,
  ConversationActivitySnapshot,
} from "./conversation-activity-tracker.js";
import type {
  ProactiveGenerationRepository,
  ClaimedGeneration,
  ProactiveSubjectRecord,
  ProactiveSubjectRef,
  StoredGenerationRun,
  StoredProactiveMessage,
} from "./proactive-generation-repository.js";

export interface ProactiveGenerationPolicy {
  tierSupportsProactive: boolean;
  policyEnabled: boolean;
  quietHours: boolean;
  timezone: string;
  dailyLimit: number;
  relationshipCloseness: number;
  minimumCloseness: number;
  cooldownUntilUtc?: string;
  maximumUnanswered: number;
  activeConversation?: boolean;
  activeConversationWindowMs?: number;
}

export type ProactivePolicyLoader = (
  agentId: string,
  nowUtc: string,
) => ProactiveGenerationPolicy;

export interface ProactiveComposeContext {
  runId: string;
  claimToken: string;
  generationEpoch: number;
  agentId: string;
  sessionId: string;
  subject: ProactiveSubjectRecord;
  suggestedContent: string;
}

export type ProactiveComposer = (
  context: ProactiveComposeContext,
) => Promise<string> | string;

export type ProactiveClaimRejectionCode =
  | ProactivePreflightRejectionCode
  | "no_delivery_subject"
  | "subject_not_found"
  | "subject_agent_mismatch"
  | "agent_state_missing"
  | "session_mismatch"
  | "claim_conflict";

export type ProactiveGenerationOutcome =
  | {
      status: "not_claimed";
      reasonCode: ProactiveClaimRejectionCode;
    }
  | {
      status: "committed";
      runId: string;
      message: StoredProactiveMessage;
    }
  | {
      status: "discarded";
      runId: string;
      reasonCode: ProactivePostflightRejectionCode | "generation_lease_expired";
    }
  | {
      status: "failed";
      runId: string;
      reasonCode:
        "compose_failed" | "empty_generated_content" | "postflight_failed";
    };

type PreflightClaimResult =
  | { claimed: true; generation: ClaimedGeneration }
  | {
      claimed: false;
      reasonCode: ProactiveClaimRejectionCode;
    };

export interface ProactiveGenerationServiceOptions {
  generationLeaseMs?: number;
}

// The provider permits up to four five-minute attempts. Keep the default lease
// above that retry envelope while still guaranteeing bounded crash recovery.
export const DEFAULT_PROACTIVE_GENERATION_LEASE_MS = 30 * 60_000;

export class ProactiveGenerationService {
  private readonly generationLeaseMs: number;

  constructor(
    private readonly repository: ProactiveGenerationRepository,
    private readonly activityTracker: ConversationActivityTracker,
    private readonly actorQueue: ActorQueue,
    private readonly clock: Clock,
    private readonly loadPolicy: ProactivePolicyLoader,
    options: ProactiveGenerationServiceOptions = {},
  ) {
    const generationLeaseMs =
      options.generationLeaseMs ?? DEFAULT_PROACTIVE_GENERATION_LEASE_MS;
    if (!Number.isSafeInteger(generationLeaseMs) || generationLeaseMs <= 0) {
      throw new RangeError(
        "Proactive generation lease must be a positive safe integer.",
      );
    }
    this.generationLeaseMs = generationLeaseMs;
  }

  async generate(input: {
    agentId: string;
    sessionId: string;
    compose: ProactiveComposer;
    subject?: ProactiveSubjectRef;
  }): Promise<ProactiveGenerationOutcome> {
    const claim = await this.actorQueue.runExclusive(input.agentId, () =>
      this.repository.transaction(() => this.preflightClaim(input)),
    );
    if (!claim.claimed) {
      return { status: "not_claimed", reasonCode: claim.reasonCode };
    }

    const context = composeContext(claim.generation);
    let generatedContent: string;
    try {
      generatedContent = (await input.compose(context)).trim();
    } catch {
      await this.finishFailed(
        claim.generation.run,
        "compose_failed",
        this.clock.nowUtc(),
      );
      return {
        status: "failed",
        runId: claim.generation.run.id,
        reasonCode: "compose_failed",
      };
    }
    if (generatedContent === "") {
      await this.finishFailed(
        claim.generation.run,
        "empty_generated_content",
        this.clock.nowUtc(),
      );
      return {
        status: "failed",
        runId: claim.generation.run.id,
        reasonCode: "empty_generated_content",
      };
    }

    try {
      return await this.actorQueue.runExclusive(input.agentId, () =>
        this.repository.transaction(() =>
          this.postflightCommit(claim.generation, generatedContent),
        ),
      );
    } catch {
      await this.finishFailed(
        claim.generation.run,
        "postflight_failed",
        this.clock.nowUtc(),
      );
      return {
        status: "failed",
        runId: claim.generation.run.id,
        reasonCode: "postflight_failed",
      };
    }
  }

  private preflightClaim(input: {
    agentId: string;
    sessionId: string;
    subject?: ProactiveSubjectRef;
  }): PreflightClaimResult {
    const nowUtc = this.clock.nowUtc();
    if (
      !this.repository.sessionBelongsToAgent(input.sessionId, input.agentId)
    ) {
      return { claimed: false, reasonCode: "session_mismatch" };
    }
    const revisions = this.repository.readAgentRevisions(input.agentId);
    if (revisions === undefined) {
      return { claimed: false, reasonCode: "agent_state_missing" };
    }
    this.repository.recoverExpiredGeneratingRuns({
      agentId: input.agentId,
      leaseCutoffUtc: generationLeaseCutoffUtc(nowUtc, this.generationLeaseMs),
      completedAtUtc: nowUtc,
    });
    if (this.repository.hasGeneratingRun(input.agentId)) {
      return { claimed: false, reasonCode: "generation_in_progress" };
    }

    this.repository.expirePendingSources(input.agentId, nowUtc);
    const subject =
      input.subject === undefined
        ? this.repository.findNextDueSubject(input.agentId, nowUtc)
        : isDeliveryRef(input.subject)
          ? this.repository.getSubject(input.subject)
          : undefined;
    if (subject === undefined) {
      return {
        claimed: false,
        reasonCode:
          input.subject === undefined
            ? "no_delivery_subject"
            : "subject_not_found",
      };
    }
    if (subject.agentId !== input.agentId) {
      return { claimed: false, reasonCode: "subject_agent_mismatch" };
    }

    const policy = this.loadPolicy(input.agentId, nowUtc);
    const activity = this.activityTracker.snapshot(input.agentId);
    const gate = evaluateProactivePreflight(
      this.preflightInput(subject, policy, activity, nowUtc),
    );
    if (!gate.allowed) {
      return { claimed: false, reasonCode: gate.reasonCode };
    }

    const runId = createEntityId("proactive_generation");
    const claimToken = createEntityId("proactive_claim");
    const generation = this.repository.claimSubject({
      runId,
      claimToken,
      subject,
      sessionId: input.sessionId,
      specVersion: revisions.specVersion,
      stateRevision: revisions.stateRevision,
      messageRowid: activity.messageRowid,
      lastUserMessageRowid: activity.lastUserMessageRowid,
      userArrivalEpoch: activity.userArrivalEpoch,
      snapshot: {
        subject: { kind: subject.kind, id: subject.id },
        policy,
      },
      startedAtUtc: nowUtc,
    });
    return generation === undefined
      ? { claimed: false, reasonCode: "claim_conflict" }
      : { claimed: true, generation };
  }

  private postflightCommit(
    claimed: ClaimedGeneration,
    generatedContent: string,
  ): ProactiveGenerationOutcome {
    const nowUtc = this.clock.nowUtc();
    const currentRun = this.repository.getRun(claimed.run.id);
    if (
      currentRun !== undefined &&
      currentRun.status === "generating" &&
      generationLeaseExpired(
        currentRun.startedAtUtc,
        nowUtc,
        this.generationLeaseMs,
      )
    ) {
      this.repository.discardGeneration({
        runId: currentRun.id,
        claimToken: claimed.run.claimToken,
        reasonCode: "generation_lease_expired",
        completedAtUtc: nowUtc,
        generatedContent,
      });
      return {
        status: "discarded",
        runId: claimed.run.id,
        reasonCode: "generation_lease_expired",
      };
    }
    const currentSubject = this.repository.getSubject({
      kind: claimed.run.sourceKind,
      id: claimed.run.sourceId,
    });
    const currentRevisions = this.repository.readAgentRevisions(
      claimed.run.agentId,
    );
    const currentActivity = this.activityTracker.snapshot(claimed.run.agentId);
    const generationMatches =
      currentRun !== undefined &&
      currentRun.status === "generating" &&
      currentRun.claimToken === claimed.run.claimToken &&
      currentRun.generationEpoch === claimed.run.generationEpoch &&
      currentSubject !== undefined &&
      currentSubject.generationEpoch === claimed.run.generationEpoch;
    const sourceStillClaimed =
      currentRun !== undefined && this.repository.isSourceClaimed(currentRun);
    const policy = this.loadPolicy(claimed.run.agentId, nowUtc);
    const dynamicGate =
      currentSubject === undefined
        ? undefined
        : evaluateProactivePreflight(
            this.preflightInput(
              currentSubject,
              policy,
              currentActivity,
              nowUtc,
            ),
          );
    const decision = evaluateProactivePostflight({
      generationMatches,
      preflightSpecVersion: claimed.run.preflightSpecVersion,
      currentSpecVersion: currentRevisions?.specVersion ?? -1,
      preflightStateRevision: claimed.run.preflightStateRevision,
      currentStateRevision: currentRevisions?.stateRevision ?? -1,
      preflightUserArrivalEpoch: claimed.run.preflightUserArrivalEpoch,
      currentUserArrivalEpoch: currentActivity.userArrivalEpoch,
      inFlightUserTurns: currentActivity.inFlightUserTurns,
      preflightLastUserMessageRowid: claimed.run.preflightLastUserMessageRowid,
      currentLastUserMessageRowid: currentActivity.lastUserMessageRowid,
      preflightMessageRowid: claimed.run.preflightMessageRowid,
      currentMessageRowid: currentActivity.messageRowid,
      sourceStillClaimed,
      sourceExpired:
        currentSubject !== undefined &&
        Date.parse(currentSubject.expiresAtUtc) <= Date.parse(nowUtc),
      alreadyDiscussed: currentSubject?.alreadyDiscussed ?? false,
      ...(dynamicGate !== undefined && !dynamicGate.allowed
        ? { dynamicGateFailure: dynamicGate.reasonCode }
        : {}),
    });
    if (!decision.allowed) {
      if (currentRun !== undefined) {
        this.repository.discardGeneration({
          runId: currentRun.id,
          claimToken: claimed.run.claimToken,
          reasonCode: decision.reasonCode,
          completedAtUtc: nowUtc,
          generatedContent,
        });
      }
      return {
        status: "discarded",
        runId: claimed.run.id,
        reasonCode: decision.reasonCode,
      };
    }
    if (currentRun === undefined || currentSubject === undefined) {
      return {
        status: "discarded",
        runId: claimed.run.id,
        reasonCode: "stale_generation",
      };
    }

    const message = this.repository.commitGeneration({
      run: currentRun,
      subject: currentSubject,
      messageId: createEntityId("message"),
      content: generatedContent,
      completedAtUtc: nowUtc,
    });
    return { status: "committed", runId: currentRun.id, message };
  }

  private preflightInput(
    subject: ProactiveSubjectRecord,
    policy: ProactiveGenerationPolicy,
    activity: ConversationActivitySnapshot,
    nowUtc: string,
  ): Parameters<typeof evaluateProactivePreflight>[0] {
    const bounds = localDayBounds(nowUtc, policy.timezone);
    return {
      subject,
      nowUtc,
      tierSupportsProactive: policy.tierSupportsProactive,
      policyEnabled: policy.policyEnabled,
      generationInProgress: false,
      quietHours: policy.quietHours,
      sentToday: this.repository.countSentToday(
        subject.agentId,
        bounds.startUtc,
        bounds.endUtc,
      ),
      dailyLimit: policy.dailyLimit,
      relationshipCloseness: policy.relationshipCloseness,
      minimumCloseness: policy.minimumCloseness,
      unansweredCount: this.repository.countUnanswered(subject.agentId),
      maximumUnanswered: policy.maximumUnanswered,
      activeConversation:
        (policy.activeConversation ?? false) ||
        activity.inFlightUserTurns > 0 ||
        this.activityTracker.isConversationActive(
          subject.agentId,
          nowUtc,
          policy.activeConversationWindowMs ?? 120_000,
        ),
      ...(policy.cooldownUntilUtc === undefined
        ? {}
        : { cooldownUntilUtc: policy.cooldownUntilUtc }),
    };
  }

  private async finishFailed(
    run: StoredGenerationRun,
    reasonCode:
      "compose_failed" | "empty_generated_content" | "postflight_failed",
    completedAtUtc: string,
  ): Promise<void> {
    await this.actorQueue.runExclusive(run.agentId, () =>
      this.repository.transaction(() => {
        this.repository.failGeneration({
          runId: run.id,
          claimToken: run.claimToken,
          reasonCode,
          completedAtUtc,
        });
      }),
    );
  }
}

function composeContext(claimed: ClaimedGeneration): ProactiveComposeContext {
  const subject = claimed.subject;
  const suggestedContent =
    subject.kind === "activity_candidate"
      ? (subject.draftMessage ??
        `I wanted to share this with you: ${subject.summary}`)
      : buildDueFollowUpContent(subject.contextSummary);
  return {
    runId: claimed.run.id,
    claimToken: claimed.run.claimToken,
    generationEpoch: claimed.run.generationEpoch,
    agentId: claimed.run.agentId,
    sessionId: claimed.run.sessionId,
    subject,
    suggestedContent,
  };
}

export function buildDueFollowUpContent(contextSummary: string): string {
  const quotedQuestion =
    /[\u201c"]([^\u201d"\r\n]{2,160}(?:\u5417|\u5462|[?\uff1f]))[\u201d"]/u
      .exec(contextSummary)?.[1]
      ?.trim();
  if (quotedQuestion === undefined) {
    return /[\p{Script=Han}]/u.test(contextSummary)
      ? "\u5230\u65f6\u95f4\u4e86\uff0c\u4e4b\u524d\u63d0\u5230\u7684\u4e8b\u60c5\u73b0\u5728\u8fdb\u5c55\u600e\u4e48\u6837\uff1f"
      : "I am checking in now: how did it go?";
  }
  const question = /[?\uff1f.!\u3002\uff01]$/u.test(quotedQuestion)
    ? quotedQuestion
    : quotedQuestion +
      (/[\p{Script=Han}]/u.test(quotedQuestion) ? "\uff1f" : "?");
  const conditionalQuestion =
    /((?:\u5982\u679c|\u8981\u662f)(?:\u6211|\u7528\u6237)?[^\uff0c,\u3002\uff01\uff1f\uff1b\r\n]{1,80})[\uff0c,][^\u201c"]{0,40}[\u201c"]([^\u201d"\r\n]{2,160}(?:\u5417|\u5462|[?\uff1f]))[\u201d"]/u.exec(
      contextSummary,
    );
  if (conditionalQuestion !== null) {
    const conditionSource = conditionalQuestion[1]!;
    const nestedQuestionSource = conditionalQuestion[2]!;
    const condition = conditionSource
      .replace(/^\u5982\u679c(?:\u6211|\u7528\u6237)/u, "\u5982\u679c\u4f60")
      .replace(/^\u8981\u662f(?:\u6211|\u7528\u6237)/u, "\u8981\u662f\u4f60");
    const nestedQuestion = /[?\uff1f.!\u3002\uff01]$/u.test(
      nestedQuestionSource,
    )
      ? nestedQuestionSource
      : nestedQuestionSource + "\uff1f";
    return question + condition + "\uff0c" + nestedQuestion;
  }
  const conditional =
    /((?:\u5982\u679c|\u8981\u662f)[^\u3002\uff01\uff1f\uff1b\r\n]{2,160})/u
      .exec(contextSummary)?.[1]
      ?.replace(/(?:\u5c31)?(?:\u8bf7)?\u63d0\u9192\u6211/gu, "")
      .replace(/\s+/gu, " ")
      .trim();
  if (conditional === undefined || conditional === "") return question;
  return (
    question +
    conditional +
    (/[?\uff1f.!\u3002\uff01]$/u.test(conditional) ? "" : "\u3002")
  );
}

function localDayBounds(
  nowUtc: string,
  timezone: string,
): { startUtc: string; endUtc: string } {
  const local = DateTime.fromISO(nowUtc, { setZone: true }).setZone(timezone);
  if (!local.isValid) {
    throw new RangeError("Invalid proactive policy timezone: " + timezone);
  }
  return {
    startUtc: local.startOf("day").toUTC().toISO()!,
    endUtc: local.endOf("day").toUTC().toISO()!,
  };
}

function generationLeaseCutoffUtc(
  nowUtc: string,
  generationLeaseMs: number,
): string {
  const nowMs = Date.parse(nowUtc);
  if (!Number.isFinite(nowMs)) {
    throw new RangeError("Invalid proactive generation clock value: " + nowUtc);
  }
  return new Date(nowMs - generationLeaseMs).toISOString();
}

function generationLeaseExpired(
  startedAtUtc: string,
  nowUtc: string,
  generationLeaseMs: number,
): boolean {
  const startedAtMs = Date.parse(startedAtUtc);
  const nowMs = Date.parse(nowUtc);
  return (
    !Number.isFinite(startedAtMs) ||
    !Number.isFinite(nowMs) ||
    nowMs - startedAtMs >= generationLeaseMs
  );
}
function isDeliveryRef(value: ProactiveSubjectRef): boolean {
  return value.kind === "activity_candidate" || value.kind === "follow_up";
}
