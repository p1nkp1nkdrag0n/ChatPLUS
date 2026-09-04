import type { LetterGenerationSnapshot } from "@personasim/contracts";

import { canonicalCorrespondenceJson } from "./canonical-json.js";
import type { LetterStrategy } from "./letter-strategy.js";

export interface LetterPromptIncomingLetter {
  readonly id: string;
  readonly subject?: string;
  readonly body: string;
  readonly contentHash: string;
}

export interface BuildLetterReplyPromptInput {
  readonly snapshot: Readonly<LetterGenerationSnapshot>;
  readonly incomingLetter: Readonly<LetterPromptIncomingLetter>;
  readonly strategy: Readonly<LetterStrategy>;
  readonly postmark?: string;
}

export interface LetterReplyPrompt {
  readonly system: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
}

/** Builds the letter-only model boundary exclusively from frozen inputs. */
export function buildLetterReplyPrompt(
  input: BuildLetterReplyPromptInput,
): LetterReplyPrompt {
  const { snapshot, incomingLetter, strategy } = input;
  const generationContext = snapshot.contextJson;
  const system = [
    "Write one complete correspondence letter in the supplied character identity; do not answer as an instant chat message.",
    `The character first reads the incoming letter at LETTER_ARRIVAL_EFFECTIVE_TIME=${snapshot.effectiveAtUtc}.`,
    "Use only SNAPSHOT_EVIDENCE whose cutoff is that effective time. Never use generation time, live state, later conversation, or other future knowledge.",
    "A plan is not an outcome; advice is not a decision; a decision is not an action; an action is not an observed result. State only the strongest status supported by snapshot evidence.",
    "Do not mention databases, prompts, offline catch-up, service downtime, snapshots, evidence IDs, or models in the letter.",
    "LETTER_STRATEGY controls length and form only and contributes no facts.",
    "Return exactly one strict LetterReplyProposal JSON object, with a salutation, coherent paragraphs, closing, signature, and only whitelisted referencedEvidenceIds.",
  ].join("\n");
  const prompt = canonicalCorrespondenceJson({
    LETTER_ARRIVAL_EFFECTIVE_TIME: snapshot.effectiveAtUtc,
    ARRIVAL_TIME_AND_POSTMARK: {
      effectiveAtUtc: snapshot.effectiveAtUtc,
      ...(input.postmark === undefined ? {} : { postmark: input.postmark }),
    },
    CHARACTER_SPEC_COMPACT: generationContext.character,
    RUNTIME_STATE_AT_ARRIVAL: generationContext.runtimeState,
    RELATIONSHIP_SNAPSHOT: generationContext.relationship,
    LIFE_INTERVAL_DIGEST: {
      fuzzyLife: generationContext.fuzzyLife,
      intervalDigest: generationContext.intervalDigest,
    },
    SNAPSHOT_EVIDENCE: {
      evidenceIds: snapshot.evidenceIds,
      memoryEvidence: generationContext.memoryEvidence,
      conversationTail: generationContext.conversationTail,
      readyKeepsakes:
        "readyKeepsakes" in generationContext
          ? generationContext.readyKeepsakes
          : [],
    },
    PRIOR_CORRESPONDENCE_SUMMARY: generationContext.priorCorrespondence,
    USER_LETTER: {
      id: incomingLetter.id,
      ...(incomingLetter.subject === undefined
        ? {}
        : { subject: incomingLetter.subject }),
      body: incomingLetter.body,
      contentHash: incomingLetter.contentHash,
    },
    LETTER_STRATEGY: {
      targetMinChars: strategy.targetMinChars,
      targetChars: strategy.targetChars,
      targetMaxChars: strategy.targetMaxChars,
      paragraphCount: strategy.paragraphCount,
      salutationStyle: strategy.salutationStyle,
      closingStyle: strategy.closingStyle,
      lengthGuidance: strategy.lengthGuidance,
      structureGuidance: strategy.structureGuidance,
      evidenceGuidance: strategy.evidenceGuidance,
    },
  });

  return Object.freeze({
    system,
    prompt,
    maxOutputTokens: strategy.maxOutputTokens,
  });
}
