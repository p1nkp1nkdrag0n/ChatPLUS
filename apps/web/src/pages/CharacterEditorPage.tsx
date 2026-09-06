import {
  Braces,
  Check,
  CircleHelp,
  Copy,
  History,
  Link2,
  Lock,
  LockOpen,
  Plus,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CharacterSpecSchema } from "@personasim/contracts";
import { useNavigate, useParams } from "react-router-dom";
import { api, unwrapCharacter, unwrapList } from "../api/client";
import type {
  CharacterSpec,
  ProvenanceRule,
  TraitRule,
  ValueRule,
} from "../api/types";
import { ErrorBlock, LoadingBlock } from "../components/Feedback";
import { TierLabel } from "../components/TierLabel";
import { ensureUserEditSource } from "../components/character-editor/source";
import type { SelectedField } from "../components/character-editor/types";
import { rememberActiveCharacter } from "../lib/activeCharacter";
import { formatLocalDateTime } from "../lib/date";

const TABS = [
  ["identity", "基础身份"],
  ["persona", "人格与价值观"],
  ["dialogue", "语言风格"],
  ["relationship", "关系"],
  ["knowledge", "知识与边界"],
  ["life", "生活策略"],
  ["json", "高级 JSON"],
  ["versions", "版本历史"],
] as const;

type EditorTab = (typeof TABS)[number][0];

const DialogueEditor = lazy(() =>
  import("../components/character-editor/DialogueEditor").then((module) => ({
    default: module.DialogueEditor,
  })),
);
const RelationshipEditor = lazy(() =>
  import("../components/character-editor/RelationshipEditor").then(
    (module) => ({ default: module.RelationshipEditor }),
  ),
);
const KnowledgeEditor = lazy(() =>
  import("../components/character-editor/KnowledgeEditor").then((module) => ({
    default: module.KnowledgeEditor,
  })),
);
const LifePolicyEditor = lazy(() =>
  import("../components/character-editor/LifePolicyEditor").then((module) => ({
    default: module.LifePolicyEditor,
  })),
);

export default function CharacterEditorPage() {
  const { characterId } = useParams<{ characterId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<EditorTab>("persona");
  const [spec, setSpec] = useState<CharacterSpec>();
  const [baseline, setBaseline] = useState<CharacterSpec>();
  const [selected, setSelected] = useState<SelectedField>();
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string>();

  const query = useQuery({
    queryKey: ["character", characterId],
    queryFn: () => api.characters.get(characterId!),
    enabled: Boolean(characterId),
  });

  useEffect(() => {
    if (!query.data) return;
    const value = unwrapCharacter(query.data);
    setSpec(value);
    setBaseline(value);
    setJsonText(JSON.stringify(value, null, 2));
    if (value.status === "published") rememberActiveCharacter(value.id);
  }, [query.data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!spec) throw new Error("角色尚未加载");
      return api.characters.updateDraft(spec.id, spec);
    },
    onSuccess: (result) => {
      const value = unwrapCharacter(result);
      setSpec(value);
      setBaseline(value);
      setJsonText(JSON.stringify(value, null, 2));
      void queryClient.invalidateQueries({ queryKey: ["characters"] });
    },
  });

  const publishMutation = useMutation({
    mutationFn: async () => {
      if (!spec) throw new Error("角色尚未加载");
      const versionToPublish = isDirty
        ? unwrapCharacter(await saveMutation.mutateAsync())
        : spec;
      return api.characters.publish(
        versionToPublish.id,
        versionToPublish.version,
      );
    },
    onSuccess: (result) => {
      const value = unwrapCharacter(result);
      rememberActiveCharacter(value.id);
      void queryClient.invalidateQueries({ queryKey: ["characters"] });
      void navigate(`/characters/${value.id}/chat`);
    },
  });

  const isDirty = useMemo(
    () =>
      Boolean(
        spec && baseline && JSON.stringify(spec) !== JSON.stringify(baseline),
      ),
    [baseline, spec],
  );

  if (query.isPending) return <LoadingBlock label="正在打开角色草稿…" />;
  if (query.isError)
    return (
      <div className="page">
        <ErrorBlock error={query.error} />
      </div>
    );
  if (!spec) return null;

  const setAtRoot = <K extends keyof CharacterSpec>(
    key: K,
    value: CharacterSpec[K],
  ) => {
    setSpec((current) => (current ? { ...current, [key]: value } : current));
  };

  const toggleLock = (path: string) => {
    const locked = spec.lockedPaths.includes(path);
    setAtRoot(
      "lockedPaths",
      locked
        ? spec.lockedPaths.filter((item) => item !== path)
        : [...spec.lockedPaths, path],
    );
  };

  const applyJson = () => {
    try {
      const raw = JSON.parse(jsonText) as unknown;
      const result = CharacterSpecSchema.safeParse(raw);
      if (!result.success) {
        setJsonError(
          result.error.issues
            .slice(0, 8)
            .map((issue) => {
              const path = issue.path.length ? issue.path.join(".") : "根对象";
              return `${path}: ${issue.message}`;
            })
            .join("\n"),
        );
        return;
      }
      const parsed: CharacterSpec = result.data;
      const protectedFields: Array<keyof CharacterSpec> = [
        "id",
        "version",
        "createdAtUtc",
        "updatedAtUtc",
      ];
      for (const key of protectedFields) {
        if (parsed[key] !== spec[key]) {
          setJsonError(`${key} 由系统管理，不能在高级 JSON 中修改。`);
          return;
        }
      }
      setJsonError(undefined);
      setSpec(parsed);
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : "JSON 无法解析");
    }
  };

  const busy = saveMutation.isPending || publishMutation.isPending;
  return (
    <div className="editor-page">
      <header className="editor-header">
        <div>
          <div className="editor-header__name">
            <h1>{spec.identity.name}</h1>
            <span className={`draft-state draft-state--${spec.status}`}>
              {spec.status === "published" ? "已发布" : "草稿"}
            </span>
          </div>
          <p>
            ID: {spec.id} · v{spec.version}
          </p>
        </div>
        <div className="editor-header__actions">
          <TierLabel tier={spec.tier} />
          <button
            className="button button--ghost"
            type="button"
            onClick={() => saveMutation.mutate()}
            disabled={!isDirty || busy}
          >
            <Save size={16} aria-hidden="true" />
            {saveMutation.isPending
              ? "保存中…"
              : isDirty
                ? "保存草稿"
                : "已保存"}
          </button>
          <button
            className="button button--primary"
            type="button"
            onClick={() => publishMutation.mutate()}
            disabled={busy}
            data-testid="publish-character"
          >
            <Check size={16} aria-hidden="true" />
            {publishMutation.isPending ? "正在发布…" : "发布并激活"}
          </button>
        </div>
      </header>

      <nav className="editor-tabs" aria-label="角色编辑章节">
        {TABS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={tab === value ? "is-active" : ""}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="editor-workspace">
        <section className="editor-canvas">
          {tab === "identity" ? (
            <IdentityEditor
              spec={spec}
              onChange={setSpec}
              onSelect={setSelected}
            />
          ) : null}
          {tab === "persona" ? (
            <PersonaEditor
              spec={spec}
              baseline={baseline}
              onChange={setSpec}
              onSelect={setSelected}
              onToggleLock={toggleLock}
            />
          ) : null}
          <Suspense fallback={<LoadingBlock label="正在打开编辑表单…" />}>
            {tab === "dialogue" ? (
              <DialogueEditor
                spec={spec}
                onChange={setSpec}
                onSelect={setSelected}
              />
            ) : null}
            {tab === "relationship" ? (
              <RelationshipEditor
                spec={spec}
                onChange={setSpec}
                onSelect={setSelected}
              />
            ) : null}
            {tab === "knowledge" ? (
              <KnowledgeEditor
                spec={spec}
                onChange={setSpec}
                onSelect={setSelected}
              />
            ) : null}
            {tab === "life" ? (
              <LifePolicyEditor
                spec={spec}
                onChange={setSpec}
                onSelect={setSelected}
              />
            ) : null}
          </Suspense>
          {tab === "json" ? (
            <section className="json-editor">
              <div className="editor-section-title">
                <div>
                  <h2>高级 JSON</h2>
                  <p>保存时仍会经过服务端 Zod 校验；系统字段不可修改。</p>
                </div>
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={applyJson}
                >
                  <Braces size={16} aria-hidden="true" /> 应用到草稿
                </button>
              </div>
              <textarea
                spellCheck={false}
                value={jsonText}
                onChange={(event) => setJsonText(event.target.value)}
                aria-label="完整 CharacterSpec JSON"
              />
              {jsonError ? <p className="field-error">{jsonError}</p> : null}
            </section>
          ) : null}
          {tab === "versions" ? <VersionHistory characterId={spec.id} /> : null}

          {saveMutation.isError ? (
            <ErrorBlock error={saveMutation.error} />
          ) : null}
          {publishMutation.isError ? (
            <ErrorBlock error={publishMutation.error} />
          ) : null}
        </section>

        <ProvenanceInspector
          selected={selected}
          spec={spec}
          onToggleLock={toggleLock}
        />
      </div>
    </div>
  );
}

function IdentityEditor({
  spec,
  onChange,
  onSelect,
}: {
  spec: CharacterSpec;
  onChange: (value: CharacterSpec) => void;
  onSelect: (field: SelectedField) => void;
}) {
  const fields = [
    ["name", "角色名称"],
    ["workOrRole", "社会身份或职业"],
    ["worldSetting", "世界背景"],
    ["selfDescription", "自我描述"],
    ["timezone", "IANA 时区"],
  ] as const;
  return (
    <section>
      <div className="editor-section-title">
        <div>
          <h2>基础身份</h2>
          <p>角色稳定且可明确核对的自我定义。</p>
        </div>
      </div>
      <div className="identity-fields">
        {fields.map(([key, label]) => (
          <label className="field editor-field" key={key}>
            <span>{label}</span>
            {key === "worldSetting" || key === "selfDescription" ? (
              <textarea
                rows={4}
                value={spec.identity[key]}
                onFocus={() => onSelect({ path: `identity.${key}`, label })}
                onChange={(event) =>
                  onChange({
                    ...spec,
                    identity: { ...spec.identity, [key]: event.target.value },
                  })
                }
              />
            ) : (
              <input
                value={spec.identity[key]}
                onFocus={() => onSelect({ path: `identity.${key}`, label })}
                onChange={(event) =>
                  onChange({
                    ...spec,
                    identity: { ...spec.identity, [key]: event.target.value },
                  })
                }
              />
            )}
          </label>
        ))}
      </div>
    </section>
  );
}

function PersonaEditor({
  spec,
  baseline,
  onChange,
  onSelect,
  onToggleLock,
}: {
  spec: CharacterSpec;
  baseline: CharacterSpec | undefined;
  onChange: (value: CharacterSpec) => void;
  onSelect: (field: SelectedField) => void;
  onToggleLock: (path: string) => void;
}) {
  const updateTrait = (index: number, patch: Partial<TraitRule>) => {
    const traits = spec.persona.traits.map((trait, itemIndex) =>
      itemIndex === index ? { ...trait, ...patch } : trait,
    );
    onChange({ ...spec, persona: { ...spec.persona, traits } });
  };
  const updateValue = (index: number, patch: Partial<ValueRule>) => {
    const values = spec.persona.values.map((value, itemIndex) =>
      itemIndex === index ? { ...value, ...patch } : value,
    );
    onChange({ ...spec, persona: { ...spec.persona, values } });
  };

  return (
    <section>
      <div className="editor-section-title">
        <div>
          <h2>人格与价值观</h2>
          <p>用强度、触发条件和例外定义可以执行的人格规则。</p>
        </div>
        <span className="validation-status">
          <Check size={15} /> 结构有效
        </span>
      </div>

      <div className="rule-section">
        <div className="rule-section__header">
          <h3>
            人格特质 <span>({spec.persona.traits.length})</span>
          </h3>
          <button
            className="text-button"
            type="button"
            onClick={() => {
              const editSource = ensureUserEditSource(spec);
              onChange({
                ...spec,
                sources: editSource.sources,
                persona: {
                  ...spec.persona,
                  traits: [
                    ...spec.persona.traits,
                    {
                      id: crypto.randomUUID(),
                      name: "新特质",
                      description: "",
                      strength: 0.5,
                      triggers: [],
                      exceptions: [],
                      origin: "user_spec",
                      sourceRefs: [editSource.id],
                    },
                  ],
                },
              });
            }}
          >
            <Plus size={15} /> 添加特质
          </button>
        </div>
        <div className="rule-table">
          <div className="rule-table__head">
            <span>特质</span>
            <span>强度 [0,1]</span>
            <span>描述</span>
            <span>操作</span>
          </div>
          {spec.persona.traits.map((trait, index) => {
            const path = `persona.traits.${index}`;
            const locked = spec.lockedPaths.some((item) =>
              item.startsWith(path),
            );
            return (
              <div className="rule-row" key={trait.id}>
                <input
                  aria-label={`特质 ${index + 1} 名称`}
                  value={trait.name}
                  disabled={locked}
                  onChange={(event) =>
                    updateTrait(index, { name: event.target.value })
                  }
                  onFocus={() =>
                    onSelect({
                      path: `${path}.name`,
                      label: `${trait.name} · 名称`,
                      provenance: trait,
                    })
                  }
                />
                <label className="range-field">
                  <output>{trait.strength.toFixed(2)}</output>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={trait.strength}
                    disabled={locked}
                    onChange={(event) =>
                      updateTrait(index, {
                        strength: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <textarea
                  aria-label={`特质 ${index + 1} 描述`}
                  rows={2}
                  value={trait.description}
                  disabled={locked}
                  onChange={(event) =>
                    updateTrait(index, { description: event.target.value })
                  }
                  onFocus={() =>
                    onSelect({
                      path: `${path}.description`,
                      label: `${trait.name} · 描述`,
                      provenance: trait,
                      excerpt: trait.description,
                    })
                  }
                />
                <div className="rule-actions">
                  <button
                    type="button"
                    onClick={() => onToggleLock(path)}
                    aria-label={locked ? "解锁" : "锁定"}
                  >
                    {locked ? <Lock size={16} /> : <LockOpen size={16} />}
                  </button>
                  <button
                    type="button"
                    aria-label="恢复默认"
                    onClick={() => {
                      const original = baseline?.persona.traits[index];
                      if (original) updateTrait(index, original);
                    }}
                  >
                    <RotateCcw size={16} />
                  </button>
                  <button
                    type="button"
                    aria-label="删除"
                    disabled={locked}
                    onClick={() =>
                      onChange({
                        ...spec,
                        persona: {
                          ...spec.persona,
                          traits: spec.persona.traits.filter(
                            (_, itemIndex) => itemIndex !== index,
                          ),
                        },
                      })
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                  <button
                    type="button"
                    aria-label="查看来源"
                    onClick={() =>
                      onSelect({
                        path,
                        label: trait.name,
                        provenance: trait,
                        excerpt: trait.description,
                      })
                    }
                  >
                    <Link2 size={16} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="rule-section">
        <div className="rule-section__header">
          <h3>
            核心价值观 <span>({spec.persona.values.length})</span>
          </h3>
        </div>
        <div className="value-list">
          {spec.persona.values.map((value, index) => (
            <label className="value-chip" key={value.id}>
              <input
                value={value.name}
                onChange={(event) =>
                  updateValue(index, { name: event.target.value })
                }
                onFocus={() =>
                  onSelect({
                    path: `persona.values.${index}`,
                    label: value.name,
                    provenance: value,
                    excerpt: value.description,
                  })
                }
              />
              <button
                type="button"
                aria-label={`删除 ${value.name}`}
                onClick={() =>
                  onChange({
                    ...spec,
                    persona: {
                      ...spec.persona,
                      values: spec.persona.values.filter(
                        (_, itemIndex) => itemIndex !== index,
                      ),
                    },
                  })
                }
              >
                ×
              </button>
            </label>
          ))}
          <button
            className="value-chip value-chip--add"
            type="button"
            onClick={() => {
              const editSource = ensureUserEditSource(spec);
              onChange({
                ...spec,
                sources: editSource.sources,
                persona: {
                  ...spec.persona,
                  values: [
                    ...spec.persona.values,
                    {
                      id: crypto.randomUUID(),
                      name: "新价值观",
                      priority: 0.5,
                      description: "请描述这个价值观如何影响角色的选择。",
                      exceptions: [],
                      origin: "user_spec",
                      sourceRefs: [editSource.id],
                    },
                  ],
                },
              });
            }}
          >
            <Plus size={14} /> 添加价值观
          </button>
        </div>
      </div>

      <div className="rule-section">
        <div className="rule-section__header">
          <h3>目前的犹豫与张力</h3>
        </div>
        {spec.persona.contradictions.length === 0 ? (
          <p>目前没有设定矛盾。角色可以自然相处，不需要固定的内心冲突。</p>
        ) : null}
        {spec.persona.contradictions.map((item, index) => (
          <div className="contradiction-row" key={item.id}>
            <textarea
              aria-label={`张力 ${index + 1}`}
              rows={2}
              value={`${item.sideA} ↔ ${item.sideB}`}
              onFocus={() =>
                onSelect({
                  path: `persona.contradictions.${index}`,
                  label: "核心矛盾",
                })
              }
              onChange={(event) => {
                const [sideA = "", sideB = ""] = event.target.value.split("↔");
                const contradictions = spec.persona.contradictions.map(
                  (value, itemIndex) =>
                    itemIndex === index
                      ? { ...value, sideA: sideA.trim(), sideB: sideB.trim() }
                      : value,
                );
                onChange({
                  ...spec,
                  persona: { ...spec.persona, contradictions },
                });
              }}
            />
            <button
              className="text-button"
              type="button"
              aria-label={`删除张力 ${index + 1}`}
              disabled={spec.lockedPaths.some(
                (path) =>
                  path === "persona.contradictions" ||
                  path.startsWith("persona.contradictions."),
              )}
              onClick={() =>
                onChange({
                  ...spec,
                  persona: {
                    ...spec.persona,
                    contradictions: spec.persona.contradictions.filter(
                      (value) => value.id !== item.id,
                    ),
                  },
                })
              }
            >
              <Trash2 size={15} /> 删除
            </button>
          </div>
        ))}
      </div>

      <div className="rule-section">
        <div className="rule-section__header">
          <h3>
            目前在意/想做的事 <span>({spec.persona.goals.length})</span>
          </h3>
        </div>
        {spec.persona.goals.length === 0 ? (
          <p>目前没有明确目标。可以直接保存、发布，之后再补充新的关注点。</p>
        ) : null}
        <div className="goal-list">
          {spec.persona.goals.map((goal, index) => (
            <div className="goal-row" key={goal.id}>
              <span>{index + 1}</span>
              <input
                aria-label={`目标 ${index + 1} 名称`}
                value={goal.title}
                maxLength={160}
                disabled={spec.lockedPaths.some(
                  (path) =>
                    path === "persona.goals" ||
                    path === `persona.goals.${index}` ||
                    path.startsWith(`persona.goals.${index}.`),
                )}
                onChange={(event) => {
                  const editSource = ensureUserEditSource(spec);
                  onChange({
                    ...spec,
                    sources: editSource.sources,
                    persona: {
                      ...spec.persona,
                      goals: spec.persona.goals.map((value) =>
                        value.id === goal.id
                          ? {
                              ...value,
                              title: event.target.value,
                              origin: "user_spec",
                              sourceRefs: [editSource.id],
                            }
                          : value,
                      ),
                    },
                  });
                }}
              />
              <div className="goal-row__priority">
                <span style={{ width: `${goal.priority * 100}%` }} />
              </div>
              <p>{goal.description}</p>
              <button
                className="text-button"
                type="button"
                aria-label={`删除目标 ${index + 1}`}
                disabled={spec.lockedPaths.some(
                  (path) =>
                    path === "persona.goals" ||
                    path.startsWith("persona.goals."),
                )}
                onClick={() =>
                  onChange({
                    ...spec,
                    persona: {
                      ...spec.persona,
                      goals: spec.persona.goals.filter(
                        (value) => value.id !== goal.id,
                      ),
                    },
                  })
                }
              >
                <Trash2 size={15} /> 删除
              </button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ProvenanceInspector({
  selected,
  spec,
  onToggleLock,
}: {
  selected: SelectedField | undefined;
  spec: CharacterSpec;
  onToggleLock: (path: string) => void;
}) {
  const locked = selected
    ? spec.lockedPaths.some((path) => selected.path.startsWith(path))
    : false;
  return (
    <aside className="provenance-inspector">
      <div className="provenance-inspector__heading">
        <h2>字段来源</h2>
        <CircleHelp size={16} />
      </div>
      {selected ? (
        <>
          <div className="provenance-current">
            <span>当前字段</span>
            <strong>{selected.label}</strong>
            <code>{selected.path}</code>
          </div>
          <dl className="provenance-list">
            <div>
              <dt>来源类型</dt>
              <dd>{originLabel(selected.provenance?.origin)}</dd>
            </div>
            <div>
              <dt>置信度</dt>
              <dd>
                {Math.round((selected.provenance?.confidence ?? 0.82) * 100)}%
              </dd>
            </div>
            <div>
              <dt>正典级别</dt>
              <dd>
                {selected.provenance?.canonicality ??
                  (spec.sourceType === "original" ? "创作者设定" : "强推断")}
              </dd>
            </div>
          </dl>
          {selected.excerpt ? (
            <blockquote>{selected.excerpt}</blockquote>
          ) : null}
          <div className="source-refs">
            <span>来源引用</span>
            {(selected.provenance?.sourceRefs ?? []).length > 0 ? (
              selected.provenance?.sourceRefs?.map((ref) => (
                <code key={ref}>{ref}</code>
              ))
            ) : (
              <small>该字段由用户表单直接定义</small>
            )}
          </div>
          <button
            className="button button--ghost button--wide"
            type="button"
            onClick={() => onToggleLock(selected.path)}
          >
            {locked ? <LockOpen size={16} /> : <Lock size={16} />}
            {locked ? "解锁此字段" : "锁定，阻止模型覆盖"}
          </button>
        </>
      ) : (
        <div className="provenance-empty">
          <Link2 size={22} />
          <p>选择任意字段，查看它来自用户设定、正典文本还是模型推断。</p>
        </div>
      )}
      <div className="locked-paths">
        <div>
          <span>已锁定路径</span>
          <strong>{spec.lockedPaths.length}</strong>
        </div>
        {spec.lockedPaths.slice(0, 5).map((path) => (
          <code key={path}>
            <Lock size={12} /> {path}
          </code>
        ))}
      </div>
      <button
        className="text-button"
        type="button"
        onClick={() =>
          void navigator.clipboard.writeText(JSON.stringify(spec, null, 2))
        }
      >
        <Copy size={14} /> 复制完整 JSON
      </button>
    </aside>
  );
}

function originLabel(origin: ProvenanceRule["origin"] | undefined): string {
  return (
    (
      {
        user_spec: "用户设定",
        canon_extract: "正典直接抽取",
        model_inference: "模型推断",
        synthetic_extension: "合成补全",
        runtime_simulation: "运行时模拟",
      } as Record<string, string>
    )[origin ?? ""] ?? "尚未标记"
  );
}

function VersionHistory({ characterId }: { characterId: string }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["versions", characterId],
    queryFn: () => api.characters.versions(characterId),
  });
  const restore = useMutation({
    mutationFn: (version: number) =>
      api.characters.restore(characterId, version),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["character", characterId],
      });
    },
  });
  if (query.isPending) return <LoadingBlock label="正在读取版本历史…" />;
  if (query.isError) return <ErrorBlock error={query.error} />;
  const versions = unwrapList<CharacterSpec>(query.data, "versions");
  return (
    <section>
      <div className="editor-section-title">
        <div>
          <h2>版本历史</h2>
          <p>已发布版本不可原地修改；恢复会创建新的草稿。</p>
        </div>
      </div>
      <div className="version-list">
        {versions.map((version) => (
          <article key={version.version}>
            <History size={18} />
            <div>
              <strong>版本 {version.version}</strong>
              <span>{formatLocalDateTime(version.updatedAtUtc)}</span>
            </div>
            <span className={`draft-state draft-state--${version.status}`}>
              {version.status}
            </span>
            <button
              className="button button--quiet"
              type="button"
              onClick={() => restore.mutate(version.version)}
              disabled={restore.isPending}
            >
              <RotateCcw size={15} /> 恢复为新草稿
            </button>
          </article>
        ))}
      </div>
      {restore.isError ? <ErrorBlock error={restore.error} /> : null}
    </section>
  );
}
