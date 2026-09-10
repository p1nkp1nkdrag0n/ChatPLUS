import { Plus, Trash2 } from "lucide-react";
import type { CharacterSpec } from "../../api/types";
import { ensureUserEditSource, rebaseEditedRuleToUserSpec } from "./source";
import type { SelectedField } from "./types";
import { EditableStringList, EditorSectionHeading } from "./EditorFields";

type RelationshipMode = NonNullable<
  CharacterSpec["userRelationship"]["behaviorModes"]
>[number];

export function RelationshipEditor({
  spec,
  onChange,
  onSelect,
}: {
  spec: CharacterSpec;
  onChange: (value: CharacterSpec) => void;
  onSelect: (field: SelectedField) => void;
}) {
  const relationship = spec.userRelationship;
  const modes = relationship.behaviorModes ?? [];
  const update = (value: CharacterSpec["userRelationship"]) =>
    onChange({ ...spec, userRelationship: value });
  const updateMode = (
    index: number,
    edit: (mode: RelationshipMode) => RelationshipMode,
  ) => {
    const current = modes[index];
    if (!current) return undefined;

    const rebased = rebaseEditedRuleToUserSpec(spec, current, edit);
    onChange({
      ...spec,
      sources: rebased.sources,
      userRelationship: {
        ...relationship,
        behaviorModes: modes.map((item, itemIndex) =>
          itemIndex === index ? rebased.rule : item,
        ),
      },
    });
    return rebased.rule;
  };

  return (
    <section>
      <EditorSectionHeading
        title="关系"
        description="你们从初次相识开始。这里描述相处方式，亲近、信任与共同经历会在交流中逐渐形成。"
      />
      <p className="structured-empty">
        初始关系：陌生人。没有预设的共同过去；之后的关系变化会由真实互动记录。
      </p>
      <div className="structured-list-columns">
        <EditableStringList
          title="称呼方式"
          values={relationship.addressTerms}
          placeholder="添加一个称呼"
          onChange={(addressTerms) => update({ ...relationship, addressTerms })}
        />
        <EditableStringList
          title="关系张力"
          values={relationship.tensions ?? []}
          placeholder="添加尚未解决的张力"
          onChange={(tensions) => update({ ...relationship, tensions })}
        />
        <EditableStringList
          title="表达在意的方式"
          values={relationship.affectionPatterns ?? []}
          placeholder="添加一种在意的表达"
          onChange={(affectionPatterns) =>
            update({ ...relationship, affectionPatterns })
          }
        />
      </div>

      <div className="structured-rule-section">
        <div className="rule-section__header">
          <h3>
            情境行为 <span>({modes.length})</span>
          </h3>
          <button
            className="text-button"
            type="button"
            onClick={() => {
              const editSource = ensureUserEditSource(spec);
              onChange({
                ...spec,
                sources: editSource.sources,
                userRelationship: {
                  ...relationship,
                  behaviorModes: [
                    ...modes,
                    {
                      id: crypto.randomUUID(),
                      conditions: ["适用情境"],
                      behavior: "描述角色在此时如何与你相处。",
                      origin: "user_spec",
                      sourceRefs: [editSource.id],
                    },
                  ],
                },
              });
            }}
          >
            <Plus size={15} /> 添加情境
          </button>
        </div>
        {modes.length === 0 ? (
          <p className="structured-empty">还没有按情境变化的关系行为。</p>
        ) : (
          <div className="structured-card-list">
            {modes.map((mode, index) => (
              <article className="structured-card" key={mode.id}>
                <div className="structured-card__toolbar">
                  <strong>情境 {index + 1}</strong>
                  <button
                    type="button"
                    aria-label={`删除关系情境 ${index + 1}`}
                    onClick={() =>
                      update({
                        ...relationship,
                        behaviorModes: modes.filter(
                          (_, itemIndex) => itemIndex !== index,
                        ),
                      })
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <EditableStringList
                  title="触发条件"
                  values={mode.conditions}
                  placeholder="添加一个触发条件"
                  onChange={(conditions) =>
                    updateMode(index, (item) => ({ ...item, conditions }))
                  }
                />
                <label className="field editor-field">
                  <span>角色行为</span>
                  <textarea
                    rows={3}
                    value={mode.behavior}
                    onFocus={() =>
                      onSelect({
                        path: `userRelationship.behaviorModes.${index}.behavior`,
                        label: `关系情境 ${index + 1}`,
                        provenance: mode,
                        excerpt: mode.behavior,
                      })
                    }
                    onChange={(event) => {
                      const edited = updateMode(index, (item) => ({
                        ...item,
                        behavior: event.target.value,
                      }));
                      if (edited) {
                        onSelect({
                          path: `userRelationship.behaviorModes.${index}.behavior`,
                          label: `关系情境 ${index + 1}`,
                          provenance: edited,
                          excerpt: edited.behavior,
                        });
                      }
                    }}
                  />
                </label>
                <label className="field editor-field">
                  <span>透露信息的方式（可选）</span>
                  <textarea
                    rows={2}
                    value={mode.disclosurePattern ?? ""}
                    onChange={(event) => {
                      updateMode(index, (item) => {
                        const next = { ...item };
                        if (event.target.value)
                          next.disclosurePattern = event.target.value;
                        else delete next.disclosurePattern;
                        return next;
                      });
                    }}
                  />
                </label>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
