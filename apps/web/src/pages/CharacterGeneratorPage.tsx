import { ArrowRight, BookOpenText, WandSparkles } from "lucide-react";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { api, unwrapCharacter } from "../api/client";
import type { SimulationTier } from "../api/types";
import { ErrorBlock } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { rememberActiveCharacter } from "../lib/activeCharacter";

const DEFAULT_TIMEZONE =
  Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";

interface GeneratorForm {
  name: string;
  worldSetting: string;
  storyEra: string;
  storyAnchorYear: string;
  workOrRole: string;
  traits: [string, string, string];
  coreContradiction: string;
  primaryGoal: string;
  initialRelationship: string;
  dialogueStyle: string;
  characterBrief: string;
  tier: SimulationTier;
  timezone: string;
}

const INITIAL_FORM: GeneratorForm = {
  name: "",
  worldSetting: "当代现实世界",
  storyEra: "",
  storyAnchorYear: "",
  workOrRole: "",
  traits: ["", "", ""],
  coreContradiction: "",
  primaryGoal: "",
  initialRelationship: "刚认识、愿意保持礼貌的朋友",
  dialogueStyle: "自然、克制，像即时通讯中的真实对话",
  characterBrief: "",
  tier: "high_fidelity",
  timezone: DEFAULT_TIMEZONE,
};

export default function CharacterGeneratorPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState<GeneratorForm>(INITIAL_FORM);
  const mutation = useMutation({
    mutationFn: api.characters.generate,
    onSuccess: (result) => {
      const character = unwrapCharacter(result);
      rememberActiveCharacter(character.id);
      void navigate(`/characters/${character.id}/edit`);
    },
  });

  const update = <K extends keyof GeneratorForm>(
    key: K,
    value: GeneratorForm[K],
  ) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    mutation.mutate(form);
  };

  return (
    <div className="page page--form">
      <PageHeader
        title="创建角色"
        description="用最低限度的信息定下方向，其余内容由角色编译器生成并等待你的审阅。"
        actions={
          <Link className="button button--ghost" to="/import">
            <BookOpenText size={16} aria-hidden="true" /> 改为导入作品角色
          </Link>
        }
      />

      <form
        className="generator-layout"
        onSubmit={submit}
        data-testid="character-generator"
      >
        <section className="form-document">
          <div className="form-section">
            <div className="form-section__heading">
              <span>01</span>
              <div>
                <h2>他是谁</h2>
                <p>先给角色一个能约束后续生成的现实支点。</p>
              </div>
            </div>
            <div className="field-grid field-grid--two">
              <label className="field">
                <span>角色名称</span>
                <input
                  required
                  maxLength={120}
                  value={form.name}
                  onChange={(event) => update("name", event.target.value)}
                  placeholder="例如：林澈"
                  data-testid="character-name"
                />
              </label>
              <label className="field">
                <span>社会身份或职业</span>
                <input
                  required
                  maxLength={240}
                  value={form.workOrRole}
                  onChange={(event) => update("workOrRole", event.target.value)}
                  placeholder="例如：城市社会学研究生"
                />
              </label>
            </div>
            <label className="field">
              <span>世界背景</span>
              <textarea
                required
                maxLength={4000}
                rows={3}
                value={form.worldSetting}
                onChange={(event) => update("worldSetting", event.target.value)}
              />
            </label>
            <div className="field-grid field-grid--two">
              <label className="field">
                <span>故事当前年份（可选）</span>
                <input
                  type="number"
                  min={1000}
                  max={9999}
                  value={form.storyAnchorYear}
                  onChange={(event) =>
                    update("storyAnchorYear", event.target.value)
                  }
                  placeholder="例如：1951"
                />
              </label>
              <label className="field">
                <span>时代说明（可选）</span>
                <input
                  maxLength={240}
                  value={form.storyEra}
                  onChange={(event) => update("storyEra", event.target.value)}
                  placeholder="例如：战后重建初期的明斯克"
                />
              </label>
            </div>
            <small>
              只知道年份即可；具体月日由系统作为运行时刻度生成，不会被当作作者提供的角色事实。
            </small>
          </div>

          <div className="form-section">
            <div className="form-section__heading">
              <span>02</span>
              <div>
                <h2>他平时是什么样</h2>
                <p>
                  写下一些具体的相处习惯；目前没有目标或拿不准的事，也可以开始。
                </p>
              </div>
            </div>
            <fieldset className="field fieldset-reset">
              <legend>性格或行为习惯（至少一项）</legend>
              <div className="trait-inputs">
                {form.traits.map((trait, index) => (
                  <input
                    key={index}
                    required={index === 0}
                    maxLength={120}
                    value={trait}
                    onChange={(event) => {
                      const traits = [
                        ...form.traits,
                      ] as GeneratorForm["traits"];
                      traits[index] = event.target.value;
                      update("traits", traits);
                    }}
                    aria-label={`核心性格 ${index + 1}`}
                    placeholder={["理性冷静", "细腻敏锐", "克制内敛"][index]}
                  />
                ))}
              </div>
            </fieldset>
            <label className="field">
              <span>最近拿不准的事情（可空）</span>
              <textarea
                maxLength={500}
                rows={3}
                value={form.coreContradiction}
                onChange={(event) =>
                  update("coreContradiction", event.target.value)
                }
                placeholder="例如：渴望与人建立深层连接，但害怕失去独立性。"
              />
            </label>
            <label className="field">
              <span>目前在意/想做的事（可空）</span>
              <input
                maxLength={160}
                value={form.primaryGoal}
                onChange={(event) => update("primaryGoal", event.target.value)}
                placeholder="例如：完成一项真正有公共价值的研究"
              />
            </label>
          </div>

          <div className="form-section">
            <div className="form-section__heading">
              <span>03</span>
              <div>
                <h2>他如何与你相处</h2>
                <p>关系和表达方式会比口头禅更直接地影响聊天体验。</p>
              </div>
            </div>
            <label className="field">
              <span>角色与用户的初始关系</span>
              <input
                required
                maxLength={120}
                value={form.initialRelationship}
                onChange={(event) =>
                  update("initialRelationship", event.target.value)
                }
              />
            </label>
            <label className="field">
              <span>语言风格</span>
              <textarea
                required
                maxLength={500}
                rows={3}
                value={form.dialogueStyle}
                onChange={(event) =>
                  update("dialogueStyle", event.target.value)
                }
              />
            </label>
            <label className="field">
              <span>详细角色素材（可选）</span>
              <textarea
                maxLength={20000}
                rows={10}
                value={form.characterBrief}
                onChange={(event) =>
                  update("characterBrief", event.target.value)
                }
                placeholder="可粘贴人物生平、重要经历、公开与私下的关系差异、语言或翻译规则、希望避免的表达套路，以及故事所处的年份。编译器会归纳而不是逐句照搬。"
              />
              <small>
                冲突事实会保留为待确认项。材料没有支持的目标和矛盾可以留空，当前愿望也可以在生活中变化。
              </small>
            </label>
          </div>
        </section>

        <aside className="form-inspector">
          <div className="form-inspector__sticky">
            <h2>模拟方式</h2>
            <div
              className="tier-options"
              role="radiogroup"
              aria-label="模拟等级"
            >
              <TierOption
                value="lightweight"
                selected={form.tier === "lightweight"}
                onSelect={() => update("tier", "lightweight")}
                title="轻量模拟"
                description="传统角色对话，不推进独立生活主线。"
              />
              <TierOption
                value="daily"
                selected={form.tier === "daily"}
                onSelect={() => update("tier", "daily")}
                title="日常模拟"
                description="持续生活、离线推进和动态状态。"
              />
              <TierOption
                value="high_fidelity"
                selected={form.tier === "high_fidelity"}
                onSelect={() => update("tier", "high_fidelity")}
                title="拟真模拟"
                description="完整的模糊生活、关系、记忆与人生主线模拟。"
              />
            </div>
            <label className="field field--compact">
              <span>角色时区</span>
              <input
                required
                value={form.timezone}
                onChange={(event) => update("timezone", event.target.value)}
              />
            </label>
            <div className="inspector-note">
              <WandSparkles size={18} aria-hidden="true" />
              <p>
                生成结果会先保存为草稿。你可以逐字段修改、删除、锁定或查看来源。
              </p>
            </div>
            {mutation.isError ? <ErrorBlock error={mutation.error} /> : null}
            <button
              className="button button--primary button--wide"
              type="submit"
              disabled={mutation.isPending}
              data-testid="generate-character"
            >
              {mutation.isPending ? "正在编译角色…" : "生成角色草稿"}
              {!mutation.isPending ? (
                <ArrowRight size={16} aria-hidden="true" />
              ) : null}
            </button>
          </div>
        </aside>
      </form>
    </div>
  );
}

function TierOption({
  value,
  selected,
  onSelect,
  title,
  description,
}: {
  value: SimulationTier;
  selected: boolean;
  onSelect: () => void;
  title: string;
  description: string;
}) {
  return (
    <button
      className={`tier-option${selected ? " is-selected" : ""}`}
      type="button"
      role="radio"
      aria-checked={selected}
      data-tier={value}
      onClick={onSelect}
    >
      <span className="tier-option__radio" aria-hidden="true" />
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
    </button>
  );
}
