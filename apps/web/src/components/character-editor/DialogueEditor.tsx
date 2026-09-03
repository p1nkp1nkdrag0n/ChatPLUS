import { Plus, Trash2 } from "lucide-react";
import type { CharacterSpec } from "../../api/types";
import { ensureUserEditSource, rebaseEditedRuleToUserSpec } from "./source";
import type { SelectedField } from "./types";
import {
  EditableStringList,
  EditorSectionHeading,
  NumberSetting,
  RangeSetting,
} from "./EditorFields";

type DialogueRule = NonNullable<CharacterSpec["dialogue"]["rules"]>[number];

export function DialogueEditor({
  spec,
  onChange,
  onSelect,
}: {
  spec: CharacterSpec;
  onChange: (value: CharacterSpec) => void;
  onSelect: (field: SelectedField) => void;
}) {
  const dialogue = spec.dialogue;
  const update = (value: CharacterSpec["dialogue"]) =>
    onChange({ ...spec, dialogue: value });
  const rules = dialogue.rules ?? [];
  const updateRule = (
    index: number,
    edit: (rule: DialogueRule) => DialogueRule,
  ) => {
    const current = rules[index];
    if (!current) return undefined;

    const rebased = rebaseEditedRuleToUserSpec(spec, current, edit);
    onChange({
      ...spec,
      sources: rebased.sources,
      dialogue: {
        ...dialogue,
        rules: rules.map((item, itemIndex) =>
          itemIndex === index ? rebased.rule : item,
        ),
      },
    });
    return rebased.rule;
  };

  return (
    <section>
      <EditorSectionHeading
        title="语言风格"
        description="直接编辑表达温度、篇幅、惯用语和场景规则，不需要手写 JSON。"
      />

      <div className="structured-editor-grid structured-editor-grid--compact">
        <label className="field editor-field">
          <span>主要语言</span>
          <input
            value={dialogue.primaryLanguage}
            onFocus={() =>
              onSelect({ path: "dialogue.primaryLanguage", label: "主要语言" })
            }
            onChange={(event) =>
              update({ ...dialogue, primaryLanguage: event.target.value })
            }
          />
        </label>
        <NumberSetting
          label="平均消息长度"
          value={dialogue.averageMessageLength}
          min={1}
          max={4000}
          suffix="字"
          onFocus={() =>
            onSelect({
              path: "dialogue.averageMessageLength",
              label: "平均消息长度",
            })
          }
          onChange={(averageMessageLength) =>
            update({ ...dialogue, averageMessageLength })
          }
        />
        <NumberSetting
          label="平均连续消息数"
          value={dialogue.averageChunksPerTurn}
          min={1}
          max={12}
          suffix="条"
          onFocus={() =>
            onSelect({
              path: "dialogue.averageChunksPerTurn",
              label: "平均连续消息数",
            })
          }
          onChange={(averageChunksPerTurn) =>
            update({ ...dialogue, averageChunksPerTurn })
          }
        />
      </div>

      <div className="range-settings" aria-label="语言风格强度">
        {(
          [
            ["formality", "正式程度"],
            ["directness", "直接程度"],
            ["warmth", "表达温度"],
            ["verbosity", "详细程度"],
            ["humor", "幽默程度"],
          ] as const
        ).map(([key, label]) => (
          <RangeSetting
            key={key}
            label={label}
            value={dialogue[key]}
            onFocus={() => onSelect({ path: `dialogue.${key}`, label })}
            onChange={(value) => update({ ...dialogue, [key]: value })}
          />
        ))}
      </div>

      <label className="field editor-field structured-editor-wide">
        <span>创作者语言指导（可选）</span>
        <textarea
          rows={4}
          value={dialogue.authorGuidance ?? ""}
          placeholder="例如：她会先承认复杂性，再用短句说出自己的判断。"
          onFocus={() =>
            onSelect({
              path: "dialogue.authorGuidance",
              label: "创作者语言指导",
            })
          }
          onChange={(event) => {
            const next = { ...dialogue };
            if (event.target.value) next.authorGuidance = event.target.value;
            else delete next.authorGuidance;
            update(next);
          }}
        />
      </label>

      <div className="structured-list-columns">
        <EditableStringList
          title="常用表达"
          values={dialogue.frequentPhrases}
          placeholder="添加角色常说的话"
          onSelect={(index) =>
            onSelect({
              path: `dialogue.frequentPhrases.${index}`,
              label: "常用表达",
            })
          }
          onChange={(frequentPhrases) =>
            update({ ...dialogue, frequentPhrases })
          }
        />
        <EditableStringList
          title="避免表达"
          values={dialogue.avoidedPhrases}
          placeholder="添加不符合角色的说法"
          onSelect={(index) =>
            onSelect({
              path: `dialogue.avoidedPhrases.${index}`,
              label: "避免表达",
            })
          }
          onChange={(avoidedPhrases) => update({ ...dialogue, avoidedPhrases })}
        />
        <EditableStringList
          title="问候方式"
          values={dialogue.greetingPatterns}
          placeholder="添加一种问候模式"
          onChange={(greetingPatterns) =>
            update({ ...dialogue, greetingPatterns })
          }
        />
        <EditableStringList
          title="安慰方式"
          values={dialogue.comfortingPatterns}
          placeholder="添加一种安慰模式"
          onChange={(comfortingPatterns) =>
            update({ ...dialogue, comfortingPatterns })
          }
        />
        <EditableStringList
          title="拒绝方式"
          values={dialogue.refusalPatterns}
          placeholder="添加一种拒绝模式"
          onChange={(refusalPatterns) =>
            update({ ...dialogue, refusalPatterns })
          }
        />
        <EditableStringList
          title="能理解的语言"
          values={dialogue.understoodLanguages ?? []}
          placeholder="例如：中文"
          onChange={(understoodLanguages) =>
            update({ ...dialogue, understoodLanguages })
          }
        />
        <EditableStringList
          title="会使用的语言"
          values={dialogue.spokenLanguages ?? []}
          placeholder="例如：中文"
          onChange={(spokenLanguages) =>
            update({ ...dialogue, spokenLanguages })
          }
        />
      </div>

      <div className="structured-rule-section">
        <div className="rule-section__header">
          <h3>
            场景规则 <span>({rules.length})</span>
          </h3>
          <button
            className="text-button"
            type="button"
            onClick={() => {
              const editSource = ensureUserEditSource(spec);
              onChange({
                ...spec,
                sources: editSource.sources,
                dialogue: {
                  ...dialogue,
                  rules: [
                    ...rules,
                    {
                      id: crypto.randomUUID(),
                      kind: "register",
                      instruction: "描述角色在这个场景下如何表达。",
                      enforcement: "soft",
                      conditions: ["适用场景"],
                      origin: "user_spec",
                      sourceRefs: [editSource.id],
                    },
                  ],
                },
              });
            }}
          >
            <Plus size={15} /> 添加规则
          </button>
        </div>
        {rules.length === 0 ? (
          <p className="structured-empty">还没有额外的场景语言规则。</p>
        ) : (
          <div className="structured-card-list">
            {rules.map((rule, index) => (
              <article className="structured-card" key={rule.id}>
                <div className="structured-card__toolbar">
                  <select
                    aria-label={`语言规则 ${index + 1} 类型`}
                    value={rule.kind}
                    onChange={(event) =>
                      updateRule(index, (item) => ({
                        ...item,
                        kind: event.target.value as typeof item.kind,
                      }))
                    }
                  >
                    <option value="language">语言</option>
                    <option value="format">格式</option>
                    <option value="register">语域</option>
                    <option value="length">篇幅</option>
                    <option value="avoidance">禁用</option>
                  </select>
                  <select
                    aria-label={`语言规则 ${index + 1} 强制程度`}
                    value={rule.enforcement}
                    onChange={(event) =>
                      updateRule(index, (item) => ({
                        ...item,
                        enforcement: event.target
                          .value as typeof item.enforcement,
                      }))
                    }
                  >
                    <option value="soft">偏好</option>
                    <option value="hard">必须遵守</option>
                  </select>
                  <button
                    type="button"
                    aria-label={`删除语言规则 ${index + 1}`}
                    onClick={() =>
                      update({
                        ...dialogue,
                        rules: rules.filter(
                          (_, itemIndex) => itemIndex !== index,
                        ),
                      })
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <label className="field editor-field">
                  <span>规则内容</span>
                  <textarea
                    rows={3}
                    value={rule.instruction}
                    onFocus={() =>
                      onSelect({
                        path: `dialogue.rules.${index}.instruction`,
                        label: `语言规则 ${index + 1}`,
                        provenance: rule,
                        excerpt: rule.instruction,
                      })
                    }
                    onChange={(event) => {
                      const edited = updateRule(index, (item) => ({
                        ...item,
                        instruction: event.target.value,
                      }));
                      if (edited) {
                        onSelect({
                          path: `dialogue.rules.${index}.instruction`,
                          label: `语言规则 ${index + 1}`,
                          provenance: edited,
                          excerpt: edited.instruction,
                        });
                      }
                    }}
                  />
                </label>
                <EditableStringList
                  title="适用条件"
                  values={rule.conditions}
                  placeholder="添加一个适用条件"
                  onChange={(conditions) =>
                    updateRule(index, (item) => ({ ...item, conditions }))
                  }
                />
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
