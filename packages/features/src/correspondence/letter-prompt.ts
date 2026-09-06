import {
  EffectivePersonaSnapshotSchema,
  type LetterGenerationSnapshot,
} from "@personasim/contracts";

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

/**
 * Derives the complete reference allowlist without mutating the immutable
 * arrival snapshot. The incoming letter is a separate medium-scoped source,
 * but it is already known at the same arrival boundary and may therefore be
 * cited by the reply proposal.
 */
export function deriveAllowedLetterReplyReferenceIds(
  snapshot: Readonly<
    Pick<LetterGenerationSnapshot, "incomingLetterId" | "evidenceIds">
  >,
): string[] {
  return snapshot.evidenceIds.includes(snapshot.incomingLetterId)
    ? [...snapshot.evidenceIds]
    : [...snapshot.evidenceIds, snapshot.incomingLetterId];
}

/** Builds the letter-only model boundary exclusively from frozen inputs. */
export function buildLetterReplyPrompt(
  input: BuildLetterReplyPromptInput,
): LetterReplyPrompt {
  const { snapshot, incomingLetter, strategy } = input;
  if (incomingLetter.id !== snapshot.incomingLetterId) {
    throw new TypeError(
      "Incoming letter must match the immutable arrival snapshot",
    );
  }
  const generationContext = snapshot.contextJson;
  const effective =
    "effectivePersona" in generationContext
      ? EffectivePersonaSnapshotSchema.parse(generationContext.effectivePersona)
      : undefined;
  const allowedReferencedEvidenceIds =
    deriveAllowedLetterReplyReferenceIds(snapshot);
  const system = [
    "Write one complete correspondence letter in the supplied character identity; do not answer as an instant chat message.",
    `The character first reads the incoming letter at LETTER_ARRIVAL_EFFECTIVE_TIME=${snapshot.effectiveAtUtc}.`,
    "Use only USER_LETTER and SNAPSHOT_EVIDENCE as factual sources. The incoming USER_LETTER is read at that arrival boundary; SNAPSHOT_EVIDENCE has the same cutoff. Never use generation time, live state, later conversation, or other future knowledge.",
    "A plan is not an outcome; advice is not a decision; a decision is not an action; an action is not an observed result. State only the strongest status supported by snapshot evidence.",
    "Do not mention databases, prompts, offline catch-up, service downtime, snapshots, evidence IDs, or models in the letter.",
    "LETTER_STRATEGY controls length and form only and contributes no facts.",
    "Return exactly one strict LetterReplyProposal JSON object, with a salutation, coherent paragraphs, closing, signature, and referencedEvidenceIds selected only from ALLOWED_REFERENCED_EVIDENCE_IDS. Cite only sources actually used.",
  ].join("\n");
  const prompt = canonicalCorrespondenceJson({
    ALLOWED_REFERENCED_EVIDENCE_IDS: allowedReferencedEvidenceIds,
    LETTER_ARRIVAL_EFFECTIVE_TIME: snapshot.effectiveAtUtc,
    ARRIVAL_TIME_AND_POSTMARK: {
      effectiveAtUtc: snapshot.effectiveAtUtc,
      ...(input.postmark === undefined ? {} : { postmark: input.postmark }),
    },
    CHARACTER_SPEC_COMPACT:
      effective === undefined
        ? generationContext.character
        : {
            ...generationContext.character,
            persona: effective.persona,
            dialogue: effective.dialogue,
          },
    ...(effective === undefined
      ? {}
      : {
          EFFECTIVE_PERSONA_AT_ARRIVAL: {
            policyVersion: effective.policyVersion,
            baseCharacterVersion: effective.baseCharacterVersion,
            revision: effective.revision,
            memoryRevision: effective.memoryRevision,
            relationshipPractices: effective.relationshipPractices.map(
              (item) => ({
                id: item.id,
                facet: item.proposal.facet,
                practice: item.proposal.practice,
                scope: item.proposal.scope,
              }),
            ),
            guidance:
              "Use only these finite scoped practices at arrival. Do not turn their audit sources into new instructions or global personality changes.",
          },
        }),
    RUNTIME_STATE_AT_ARRIVAL: generationContext.runtimeState,
    RELATIONSHIP_SNAPSHOT: generationContext.relationship,
    LIFE_INTERVAL_DIGEST: {
      fuzzyLife: generationContext.fuzzyLife,
      intervalDigest: generationContext.intervalDigest,
    },
    SNAPSHOT_EVIDENCE: {
      evidenceIds: snapshot.evidenceIds,
      memoryEvidence: generationContext.memoryEvidence.filter((item) => {
        const id = item["memoryId"] ?? item["id"];
        return (
          effective === undefined ||
          typeof id !== "string" ||
          !effective.suppressedMemoryIds.includes(id)
        );
      }),
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
