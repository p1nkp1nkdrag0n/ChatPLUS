import { EntityIdSchema } from "@personasim/contracts";
import { z } from "zod";
import { createUuid } from "./uuid";

export const REFINEMENT_KEY = "dearvale.character-refinement.v1";
export const REFINEMENT_FEEDBACK_LIMIT = 5_000;

const refinementDraftSchema = z
  .object({
    version: z.literal(1),
    characterId: EntityIdSchema,
    characterVersion: z.number().int().positive(),
    requestId: EntityIdSchema,
    feedback: z.string().max(REFINEMENT_FEEDBACK_LIMIT),
  })
  .strict();
const refinementStorageSchema = z.array(refinementDraftSchema).max(10);

export type RefinementDraft = z.infer<typeof refinementDraftSchema>;

export function newRefinementDraft(
  characterId: string,
  characterVersion: number,
  feedback = "",
): RefinementDraft {
  return {
    version: 1,
    characterId,
    characterVersion,
    feedback,
    requestId: createUuid(),
  };
}

function readDrafts(): RefinementDraft[] {
  const raw = localStorage.getItem(REFINEMENT_KEY);
  if (!raw || raw.length > 100_000) return [];
  try {
    const parsed = refinementStorageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function readRefinementDraft(
  characterId: string,
): RefinementDraft | undefined {
  try {
    return readDrafts().find((draft) => draft.characterId === characterId);
  } catch {
    return undefined;
  }
}

/** A changed request body gets a new identity; retrying the same body does not. */
export function updateRefinementFeedback(
  draft: RefinementDraft,
  feedback: string,
): RefinementDraft {
  return feedback === draft.feedback
    ? draft
    : { ...draft, feedback, requestId: createUuid() };
}

export function saveRefinementDraft(draft: RefinementDraft): boolean {
  const parsed = refinementDraftSchema.safeParse(draft);
  if (!parsed.success) return false;
  try {
    const previous = readDrafts().filter(
      (item) => item.characterId !== draft.characterId,
    );
    localStorage.setItem(
      REFINEMENT_KEY,
      JSON.stringify([...previous.slice(-9), parsed.data]),
    );
    return true;
  } catch {
    return false;
  }
}

/** Completing an older request must preserve newer writing from another tab. */
export function clearRefinementDraft(
  characterId: string,
  requestId: string,
): void {
  try {
    const drafts = readDrafts().filter(
      (draft) =>
        draft.characterId !== characterId || draft.requestId !== requestId,
    );
    if (drafts.length)
      localStorage.setItem(REFINEMENT_KEY, JSON.stringify(drafts));
    else localStorage.removeItem(REFINEMENT_KEY);
  } catch {
    // The saved server preview remains available if browser storage is blocked.
  }
}
