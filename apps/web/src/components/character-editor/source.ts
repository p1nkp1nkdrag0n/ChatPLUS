import type { CharacterSpec, ProvenanceRule } from "../../api/types";

type CharacterSourceOwner = Pick<CharacterSpec, "sources">;

interface ProvenancedRule {
  origin: ProvenanceRule["origin"];
  sourceRefs: string[];
}

export function ensureUserEditSource(spec: CharacterSourceOwner): {
  id: string;
  sources: CharacterSpec["sources"];
} {
  const existing = spec.sources.find(
    (source) =>
      source.sourceType === "user_spec" && typeof source.id === "string",
  );
  if (existing && typeof existing.id === "string") {
    return { id: existing.id, sources: spec.sources };
  }
  const id = crypto.randomUUID();
  return {
    id,
    sources: [
      ...spec.sources,
      {
        id,
        sourceType: "user_spec",
        label: "角色编辑器手工设定",
      },
    ],
  };
}

export function rebaseEditedRuleToUserSpec<T extends ProvenancedRule>(
  spec: CharacterSourceOwner,
  rule: T,
  edit: (current: T) => T,
): { rule: T; sources: CharacterSpec["sources"] } {
  const editSource = ensureUserEditSource(spec);
  return {
    sources: editSource.sources,
    rule: {
      ...edit(rule),
      origin: "user_spec",
      sourceRefs: [editSource.id],
    },
  };
}
