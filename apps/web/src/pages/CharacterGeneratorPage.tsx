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
  workOrRole: string;
  traits: [string, string, string];
  coreContradiction: string;
  primaryGoal: string;
  initialRelationship: string;
  dialogueStyle: string;
  tier: SimulationTier;
  timezone: string;
}

const INITIAL_FORM: GeneratorForm = {
  name: "",
  worldSetting: "当代现实世界",
  workOrRole: "",
  traits: ["", "", ""],
  coreContradiction: "",
  primaryGoal: "",
  initialRelationship: "刚认识、愿意保持礼貌的朋友",
  dialogueStyle: "自然、克制，像即时通讯中的真实对话",
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
          </div>

          <div className="form-section">
            <div className="form-section__heading">
              <span>02</span>
              <div>
                <h2>他如何选择</h2>
                <p>性格不是形容词清单；矛盾和目标会决定未知场景中的取舍。</p>
              </div>
            </div>
            <fieldset className="field fieldset-reset">
              <legend>三个核心性格</legend>
              <div className="trait-inputs">
                {form.traits.map((trait, index) => (
                  <input
                    key={index}
                    required
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
              <span>一个核心矛盾</span>
              <textarea
                required
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
              <span>主要目标</span>
              <input
                required
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
                description="传统角色对话，不推进独立日程。"
              />
              <TierOption
                value="daily"
                selected={form.tier === "daily"}
                onSelect={() => update("tier", "daily")}
                title="日常模拟"
                description="72 小时日程、离线结算和动态状态。"
              />
              <TierOption
                value="high_fidelity"
                selected={form.tier === "high_fidelity"}
                onSelect={() => update("tier", "high_fidelity")}
                title="拟真模拟"
                description="完整日常模拟，并可基于经历主动开口。"
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
