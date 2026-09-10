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
  /** A fresh opaque namespace supplied by the server for this model call. */
  readonly referenceScope?: string;
}

export interface LetterReplyPrompt {
  readonly system: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
  /** Server-only mapping; never serialize durable IDs as model citations. */
  readonly referenceBindings: readonly LetterReplyReferenceBinding[];
}

export interface LetterReplyReferenceBinding {
  readonly localId: string;
  readonly evidenceId: string;
}

export function letterReplyParticipants(
  snapshot: Readonly<LetterGenerationSnapshot>,
): {
  readonly author: string;
  readonly recipient: string;
  readonly salutation: string;
} {
  const character = snapshot.contextJson.character;
  const author = character.identity["name"];
  const address = character.userRelationship["preferredAddress"];
  if (typeof author !== "string" || !author.trim()) {
    throw new TypeError(
      "Letter reply requires the frozen character author identity",
    );
  }
  const recipient =
    typeof address === "string" && address.trim() ? address.trim() : "朋友";
  return { author: author.trim(), recipient, salutation: `${recipient}：` };
}

/** Resolve exact local identifiers only. Prefix repair or durable-ID fallback
 * could silently turn a fabricated source into a different legitimate one. */
export function resolveLetterReplyReferences(
  localIds: readonly string[],
  bindings: readonly LetterReplyReferenceBinding[],
): string[] | undefined {
  if (new Set(localIds).size !== localIds.length) return undefined;
  if (
    new Set(bindings.map((item) => item.localId)).size !== bindings.length ||
    new Set(bindings.map((item) => item.evidenceId)).size !== bindings.length
  )
    return undefined;
  const mapping = new Map(
    bindings.map((item) => [item.localId, item.evidenceId]),
  );
  const resolved: string[] = [];
  for (const localId of localIds) {
    const evidenceId = mapping.get(localId);
    if (evidenceId === undefined) return undefined;
    resolved.push(evidenceId);
  }
  return resolved;
}

function localizeReferenceFields(
  value: unknown,
  mapping: ReadonlyMap<string, string>,
): unknown {
  if (Array.isArray(value))
    return value.map((item) => localizeReferenceFields(item, mapping));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (/(?:^id$|Id$)/.test(key) && typeof item === "string") {
        return [key, mapping.get(item) ?? item];
      }
      if (/(?:Ids$|^sourceRefs$)/.test(key) && Array.isArray(item)) {
        return [
          key,
          item.map((id: unknown) =>
            typeof id === "string" ? (mapping.get(id) ?? id) : id,
          ),
        ];
      }
      return [key, localizeReferenceFields(item, mapping)];
    }),
  );
}

/**
 * Derives the retained reference allowlist without mutating the immutable
 * arrival snapshot. The incoming letter is a separate medium-scoped source,
 * but it is already known at the same arrival boundary and may therefore be
 * cited by the reply proposal.
 */
export function deriveAllowedLetterReplyReferenceIds(
  snapshot: Readonly<
    Pick<LetterGenerationSnapshot, "incomingLetterId" | "evidenceIds"> &
      Partial<Pick<LetterGenerationSnapshot, "contextJson">>
  >,
): string[] {
  const context = snapshot.contextJson;
  const effective =
    context !== undefined && "effectivePersona" in context
      ? EffectivePersonaSnapshotSchema.parse(context.effectivePersona)
      : undefined;
  const suppressedIds = new Set(effective?.suppressedMemoryIds ?? []);
  for (const item of context?.memoryEvidence ?? []) {
    const memoryId = item["memoryId"] ?? item["id"];
    const evidenceId = item["id"];
    if (
      typeof memoryId === "string" &&
      suppressedIds.has(memoryId) &&
      typeof evidenceId === "string"
    ) {
      suppressedIds.add(evidenceId);
    }
  }
  const retainedIds = snapshot.evidenceIds.filter(
    (id) => !suppressedIds.has(id),
  );
  return retainedIds.includes(snapshot.incomingLetterId)
    ? retainedIds
    : [...retainedIds, snapshot.incomingLetterId];
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
  const referenceScope = input.referenceScope ?? "letter";
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(referenceScope)) {
    throw new TypeError(
      "Letter reference scope must be a bounded opaque identifier",
    );
  }
  const referenceBindings = allowedReferencedEvidenceIds.map(
    (evidenceId, index) =>
      Object.freeze({
        localId: `ref_${referenceScope}_${index + 1}`,
        evidenceId,
      }),
  );
  const localIds = new Map(
    referenceBindings.map((item) => [item.evidenceId, item.localId]),
  );
  const participants = letterReplyParticipants(snapshot);
  const system = [
    "Write one complete correspondence letter in the supplied character identity; do not answer as an instant chat message.",
    `The character first reads the incoming letter at LETTER_ARRIVAL_EFFECTIVE_TIME=${snapshot.effectiveAtUtc}.`,
    "Use only USER_LETTER and SNAPSHOT_EVIDENCE as factual sources. The incoming USER_LETTER is read at that arrival boundary; SNAPSHOT_EVIDENCE has the same cutoff. Never use generation time, live state, later conversation, or other future knowledge.",
    "A plan is not an outcome; advice is not a decision; a decision is not an action; an action is not an observed result. State only the strongest status supported by snapshot evidence.",
    "The application user and character begin as strangers. Character biography and canonical third-party relationships do not establish prior intimacy or shared history with this user. Shared experiences with the user require actual conversation or correspondence evidence supplied by the application. Internal state and relationship numbers are private simulation data: never recite scores, thresholds, stages, or diagnostics to the user.",
    "Do not mention databases, prompts, offline catch-up, service downtime, snapshots, evidence IDs, or models in the letter.",
    "LETTER_STRATEGY controls length and form only and contributes no facts.",
    "LETTER_PARTICIPANTS fixes the reply author and recipient. Write as the author to the recipient; quoted first-person statements in USER_LETTER belong to the user, not the author. The server assigns salutation and signature. Copy their supplied values into the required response fields; do not infer them from the incoming letter's greeting or signature.",
    "References are opaque identifiers local to this invocation. Use only the exact allowed ref_* strings; never fabricate, reuse another call's references, or repair a prefix. A valid reference does not authorize reversing who experienced the cited event.",
    "Return exactly one strict LetterReplyProposal JSON object, with a salutation, coherent paragraphs, closing, signature, and referencedEvidenceIds selected only from ALLOWED_REFERENCED_EVIDENCE_IDS. Cite only sources actually used.",
  ].join("\n");
  const prompt = canonicalCorrespondenceJson(
    localizeReferenceFields(
      {
        ALLOWED_REFERENCED_EVIDENCE_IDS: referenceBindings.map(
          (item) => item.localId,
        ),
        LETTER_PARTICIPANTS: {
          ...participants,
          signature: participants.author,
        },
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
          evidenceIds: snapshot.evidenceIds.filter((id) =>
            allowedReferencedEvidenceIds.includes(id),
          ),
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
      },
      localIds,
    ),
  );

  return Object.freeze({
    system,
    prompt,
    maxOutputTokens: strategy.maxOutputTokens,
    referenceBindings: Object.freeze(referenceBindings),
  });
}
