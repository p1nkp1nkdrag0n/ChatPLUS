import type { CharacterSpec, RuntimeState } from "@personasim/contracts";
import type { DatabaseStore } from "../db/store.js";
import { MemoryValidityRepository } from "../repositories/memory-validity-repository.js";
import {
  analyzeStateAttributions,
  type StateAttributionCandidate,
} from "./fuzzy-life-evidence.js";

export type PressureEvidenceRejection =
  | "source_not_current"
  | "experiencer_not_speaker"
  | "non_asserted_state"
  | "unverified_life_claim"
  | "runtime_state_not_supporting";
export interface ValidatedPressureEvidence {
  candidate: StateAttributionCandidate;
  subject: "character";
  sourceHash: string;
  basis: "runtime_state" | "existing_pressure";
  runtimeRevision: number;
}

/** Validates the final stored reply against pre-turn application state. A reply
 * cannot authorize its own enduring pressure by proposing a state delta. */
export function validateCharacterPressureEvidence(input: {
  store: DatabaseStore;
  agentId: string;
  sessionId: string;
  messageId: string;
  text: string;
  spec: CharacterSpec;
  priorState: RuntimeState | undefined;
  hasExistingPressure: boolean;
}) {
  const accepted: ValidatedPressureEvidence[] = [];
  const rejected: Array<{
    candidate: StateAttributionCandidate;
    reason: PressureEvidenceRejection;
  }> = [];
  const source = input.store.database
    .prepare(
      "SELECT agent_id AS agentId, session_id AS sessionId, role, content FROM messages WHERE id = ?",
    )
    .get(input.messageId) as
    | { agentId: string; sessionId: string; role: string; content: string }
    | undefined;
  const validity = new MemoryValidityRepository(input.store);
  const reference = validity.readSource(
    input.agentId,
    "message",
    input.messageId,
  );
  const sourceCurrent =
    source?.agentId === input.agentId &&
    source.sessionId === input.sessionId &&
    source.role === "assistant" &&
    source.content === input.text &&
    reference !== undefined &&
    !validity.messageSourceNeedsReview(input.agentId, input.messageId);
  for (const candidate of analyzeStateAttributions({
    text: input.text,
    speakerRole: "character",
    sourceMessageId: input.messageId,
  })) {
    let reason: PressureEvidenceRejection | undefined;
    if (
      !sourceCurrent ||
      input.text.slice(candidate.sourceSpan.start, candidate.sourceSpan.end) !==
        candidate.sourceText
    )
      reason = "source_not_current";
    else if (candidate.experiencer !== "speaker")
      reason = "experiencer_not_speaker";
    else if (candidate.modality !== "asserted") reason = "non_asserted_state";
    else if (hasUnsupportedLifeClaim(candidate.sourceText, input.spec))
      reason = "unverified_life_claim";
    else if (
      input.priorState === undefined ||
      (!input.hasExistingPressure &&
        !stateSupportsPressure(candidate.sourceText, input.priorState))
    )
      reason = "runtime_state_not_supporting";
    if (reason !== undefined) rejected.push({ candidate, reason });
    else
      accepted.push({
        candidate,
        subject: "character",
        sourceHash: reference!.sourceHash,
        basis: input.hasExistingPressure
          ? "existing_pressure"
          : "runtime_state",
        runtimeRevision: input.priorState!.revision,
      });
  }
  return { accepted, rejected };
}

function stateSupportsPressure(text: string, state: RuntimeState): boolean {
  // The same bands used by runtime-state-description; these are simulation
  // values, not a clinical measurement or a model's self-reported authority.
  if (/疲惫|疲倦|累|疲劳/u.test(text)) return state.energy < 0.5;
  if (/难受|难过|低落|伤心/u.test(text)) return state.moodValence < -0.1;
  return state.stress >= 0.55;
}

function hasUnsupportedLifeClaim(text: string, spec: CharacterSpec): boolean {
  // Present emotion is distinct from an invented past event. Conservative,
  // bounded recognition; ambiguous new life history is not persisted here.
  const claims = [
    ...text.matchAll(
      /(?:昨天|前天|上周|上个月|刚刚|刚才|已经|经历了|失去了|被辞退|失恋|加班)[^，。；！？!?\n]{0,100}/gu,
    ),
  ].map((match) => match[0]);
  if (claims.length === 0) return false;
  const authored = JSON.stringify({
    biography: spec.persona.biography,
    knownFacts: spec.knowledge.knownFacts,
  });
  return claims.some((claim) => !authored.includes(claim));
}
