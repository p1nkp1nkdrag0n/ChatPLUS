import type { CharacterDraft } from "./schemas.js";

/** Authoring describes the character; the relationship with the app user starts here. */
export const STRANGER_RELATIONSHIP_TYPE = "初次相识的陌生人";
export const STRANGER_RELATIONSHIP_LEVEL = 0.1;
export const STRANGER_RELATIONSHIP_POLICY = "single_affinity_stranger_v1";

export const INITIAL_RELATIONSHIP_FIELDS = [
  "relationshipType",
  "initialCloseness",
  "sharedContext",
] as const;

export function applyStrangerRelationship(
  draft: CharacterDraft,
): CharacterDraft {
  const userRelationship = { ...draft.userRelationship };
  // Old imported drafts may still carry the retired numeric field.
  Reflect.deleteProperty(userRelationship, "initialTrust");
  return {
    ...draft,
    userRelationship: {
      ...userRelationship,
      relationshipType: STRANGER_RELATIONSHIP_TYPE,
      initialCloseness: STRANGER_RELATIONSHIP_LEVEL,
      sharedContext: "",
    },
    lockedPaths: draft.lockedPaths.filter(
      (path) =>
        path !== "userRelationship" &&
        path !== "userRelationship.initialTrust" &&
        !INITIAL_RELATIONSHIP_FIELDS.some(
          (field) => path === `userRelationship.${field}`,
        ),
    ),
  };
}

export function hasStrangerRelationship(draft: CharacterDraft): boolean {
  const normalized = applyStrangerRelationship(draft);
  return (
    !Object.hasOwn(draft.userRelationship, "initialTrust") &&
    INITIAL_RELATIONSHIP_FIELDS.every(
      (field) =>
        draft.userRelationship[field] === normalized.userRelationship[field],
    ) && normalized.lockedPaths.length === draft.lockedPaths.length
  );
}
