import {
  PressureEpisodeSchema,
  type OutcomeRecord,
  type PressureEpisode,
  type ReflectionRecord,
} from "@personasim/contracts";

import { clamp01 } from "./fuzzy-life-planning.js";

export function linkPressureOutcomeEvidence(
  episode: PressureEpisode,
  outcome: OutcomeRecord,
  updatedAtUtc: string,
): PressureEpisode {
  const sourceMessageIds = [
    ...new Set([...episode.sourceMessageIds, ...outcome.sourceEvidenceIds]),
  ];
  return PressureEpisodeSchema.parse({
    ...episode,
    outcomeIds: [...new Set([...episode.outcomeIds, outcome.id])],
    sourceMessageIds,
    latestEvidenceMessageId:
      outcome.sourceEvidenceIds.at(-1) ?? episode.latestEvidenceMessageId,
    effectiveLocalDate: outcome.effectiveLocalDate,
    ...(outcome.effectivePeriod === undefined
      ? { effectivePeriod: undefined, temporalPrecision: "day" as const }
      : {
          effectivePeriod: outcome.effectivePeriod,
          temporalPrecision: "period" as const,
        }),
    updatedAtUtc,
  });
}

export function progressPressureFromOutcome(
  episode: PressureEpisode,
  outcome: OutcomeRecord,
  updatedAtUtc: string,
): PressureEpisode {
  const transition =
    episode.status === "resolved"
      ? { pressure: 0, clarity: 0, status: "resolved" as const }
      : outcomePressureTransition(outcome.valence);
  const sourceMessageIds = [
    ...new Set([...episode.sourceMessageIds, ...outcome.sourceEvidenceIds]),
  ];
  const latestEvidenceMessageId =
    outcome.sourceEvidenceIds.at(-1) ?? episode.latestEvidenceMessageId;
  return PressureEpisodeSchema.parse({
    ...episode,
    status: transition.status,
    currentPressure: clamp01(episode.currentPressure + transition.pressure),
    currentClarity: clamp01(episode.currentClarity + transition.clarity),
    outcomeIds: [...new Set([...episode.outcomeIds, outcome.id])],
    sourceMessageIds,
    latestEvidenceMessageId,
    effectiveLocalDate: outcome.effectiveLocalDate,
    ...(outcome.effectivePeriod === undefined
      ? { effectivePeriod: undefined, temporalPrecision: "day" as const }
      : {
          effectivePeriod: outcome.effectivePeriod,
          temporalPrecision: "period" as const,
        }),
    updatedAtUtc,
  });
}

export function progressPressureFromReflection(
  episode: PressureEpisode,
  reflection: ReflectionRecord,
  updatedAtUtc: string,
): PressureEpisode {
  const closesCompletedChain =
    reflection.outcomeId !== undefined &&
    episode.outcomeIds.includes(reflection.outcomeId) &&
    (reflection.stanceTowardDecision === "affirm" ||
      reflection.stanceTowardDecision === "mixed");
  const transition =
    episode.status === "resolved"
      ? { pressure: 0, clarity: 0, status: "resolved" as const }
      : closesCompletedChain
        ? { pressure: -0.06, clarity: 0.12, status: "resolved" as const }
        : reflectionPressureTransition(
            reflection.stanceTowardDecision,
            episode.status,
          );
  const sourceMessageIds = [
    ...new Set([...episode.sourceMessageIds, ...reflection.sourceMessageIds]),
  ];
  const latestEvidenceMessageId =
    reflection.sourceMessageIds.at(-1) ?? episode.latestEvidenceMessageId;
  return PressureEpisodeSchema.parse({
    ...episode,
    status: transition.status,
    currentPressure: clamp01(episode.currentPressure + transition.pressure),
    currentClarity: clamp01(episode.currentClarity + transition.clarity),
    sourceMessageIds,
    latestEvidenceMessageId,
    ...(transition.status === "resolved"
      ? {
          resolutionEvidenceMessageId:
            latestEvidenceMessageId ?? episode.resolutionEvidenceMessageId,
        }
      : { resolutionEvidenceMessageId: undefined }),
    effectiveLocalDate: reflection.effectiveLocalDate,
    ...(reflection.effectivePeriod === undefined
      ? { effectivePeriod: undefined, temporalPrecision: "day" as const }
      : {
          effectivePeriod: reflection.effectivePeriod,
          temporalPrecision: "period" as const,
        }),
    updatedAtUtc,
  });
}

function outcomePressureTransition(valence: OutcomeRecord["valence"]): {
  pressure: number;
  clarity: number;
  status: Exclude<PressureEpisode["status"], "open" | "resolved">;
} {
  switch (valence) {
    case "positive":
      return { pressure: -0.12, clarity: 0.14, status: "improving" };
    case "negative":
      return { pressure: 0.1, clarity: 0.08, status: "worsening" };
    case "mixed":
      return { pressure: -0.04, clarity: 0.12, status: "improving" };
    case "neutral":
      return { pressure: -0.02, clarity: 0.08, status: "improving" };
  }
}

function reflectionPressureTransition(
  stance: ReflectionRecord["stanceTowardDecision"],
  currentStatus: PressureEpisode["status"],
): {
  pressure: number;
  clarity: number;
  status: PressureEpisode["status"];
} {
  switch (stance) {
    case "affirm":
      return { pressure: -0.06, clarity: 0.12, status: "improving" };
    case "mixed":
      return { pressure: -0.03, clarity: 0.1, status: "improving" };
    case "question":
      return { pressure: 0.02, clarity: 0.06, status: "worsening" };
    case "reverse":
      return { pressure: 0.06, clarity: 0.08, status: "worsening" };
    case "unclear":
      return { pressure: 0, clarity: 0.05, status: currentStatus };
  }
}

export function pressureLifecycleSnapshot(episode: PressureEpisode): {
  status: PressureEpisode["status"];
  pressure: number;
  clarity: number;
  feltUnderstood: number;
  outcomeIds: string[];
  latestEvidenceMessageId: string;
} {
  return {
    status: episode.status,
    pressure: episode.currentPressure,
    clarity: episode.currentClarity,
    feltUnderstood: episode.currentFeltUnderstood,
    outcomeIds: episode.outcomeIds,
    latestEvidenceMessageId: episode.latestEvidenceMessageId,
  };
}
