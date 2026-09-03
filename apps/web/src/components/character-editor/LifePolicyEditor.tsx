import { Plus, Trash2 } from "lucide-react";
import type { CharacterSpec } from "../../api/types";
import type { SelectedField } from "./types";
import {
  EditableStringList,
  EditorSectionHeading,
  NumberSetting,
  RangeSetting,
} from "./EditorFields";

export function LifePolicyEditor({
  spec,
  onChange,
  onSelect,
}: {
  spec: CharacterSpec;
  onChange: (value: CharacterSpec) => void;
  onSelect: (field: SelectedField) => void;
}) {
  const schedule = spec.schedulePolicy;
  const proactive = spec.proactivePolicy;
  const updateSchedule = (schedulePolicy: CharacterSpec["schedulePolicy"]) =>
    onChange({ ...spec, schedulePolicy });
  const updateProactive = (proactivePolicy: CharacterSpec["proactivePolicy"]) =>
    onChange({ ...spec, proactivePolicy });

  return (
    <section>
      <EditorSectionHeading
        title="生活策略"
        description="当前 fuzzy life 以生活规律为创作入口；暂停能力与旧版精确日程参数被单独隔离。"
      />
      <div className="structured-rule-section">
        <div className="rule-section__header">
          <h3>
            生活规律 <span>({spec.routines.length})</span>
          </h3>
          <button
            className="text-button"
            type="button"
            onClick={() =>
              onChange({
                ...spec,
                routines: [
                  ...spec.routines,
                  {
                    id: crypto.randomUUID(),
                    title: "新的生活规律",
                    category: "personal",
                    recurrence: "每周按需要安排",
                    preferredStartLocal: "09:00",
                    preferredDurationMinutes: 60,
                    rigidity: "flexible",
                    priority: 0.5,
                  },
                ],
              })
            }
          >
            <Plus size={15} /> 添加规律
          </button>
        </div>
        {spec.routines.length === 0 ? (
          <p className="structured-empty">还没有定义生活规律。</p>
        ) : (
          <div className="structured-card-list">
            {spec.routines.map((routine, index) => (
              <article className="structured-card" key={routine.id}>
                <div className="structured-card__toolbar">
                  <strong>规律 {index + 1}</strong>
                  <button
                    type="button"
                    aria-label={`删除生活规律 ${index + 1}`}
                    onClick={() =>
                      onChange({
                        ...spec,
                        routines: spec.routines.filter(
                          (_, itemIndex) => itemIndex !== index,
                        ),
                      })
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <div className="structured-editor-grid structured-editor-grid--routine">
                  <label className="field editor-field">
                    <span>名称</span>
                    <input
                      aria-label={`生活规律 ${index + 1} 名称`}
                      value={routine.title}
                      onFocus={() =>
                        onSelect({
                          path: `routines.${index}.title`,
                          label: `生活规律 ${index + 1}`,
                        })
                      }
                      onChange={(event) =>
                        onChange({
                          ...spec,
                          routines: spec.routines.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, title: event.target.value }
                              : item,
                          ),
                        })
                      }
                    />
                  </label>
                  <label className="field editor-field">
                    <span>类别</span>
                    <input
                      value={routine.category}
                      onChange={(event) =>
                        onChange({
                          ...spec,
                          routines: spec.routines.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, category: event.target.value }
                              : item,
                          ),
                        })
                      }
                    />
                  </label>
                  <label className="field editor-field">
                    <span>发生规律</span>
                    <input
                      value={routine.recurrence}
                      placeholder="例如：每个工作日"
                      onChange={(event) =>
                        onChange({
                          ...spec,
                          routines: spec.routines.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, recurrence: event.target.value }
                              : item,
                          ),
                        })
                      }
                    />
                  </label>
                  <label className="field editor-field">
                    <span>偏好开始时间</span>
                    <input
                      type="time"
                      value={routine.preferredStartLocal}
                      onChange={(event) =>
                        onChange({
                          ...spec,
                          routines: spec.routines.map((item, itemIndex) =>
                            itemIndex === index
                              ? {
                                  ...item,
                                  preferredStartLocal: event.target.value,
                                }
                              : item,
                          ),
                        })
                      }
                    />
                  </label>
                  <NumberSetting
                    label="大致时长"
                    value={routine.preferredDurationMinutes}
                    min={5}
                    max={1440}
                    step={5}
                    suffix="分钟"
                    onChange={(preferredDurationMinutes) =>
                      onChange({
                        ...spec,
                        routines: spec.routines.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, preferredDurationMinutes }
                            : item,
                        ),
                      })
                    }
                  />
                  <label className="field editor-field">
                    <span>弹性</span>
                    <select
                      value={routine.rigidity}
                      onChange={(event) =>
                        onChange({
                          ...spec,
                          routines: spec.routines.map((item, itemIndex) =>
                            itemIndex === index
                              ? {
                                  ...item,
                                  rigidity: event.target
                                    .value as typeof item.rigidity,
                                }
                              : item,
                          ),
                        })
                      }
                    >
                      <option value="fixed">固定</option>
                      <option value="committed">通常会做</option>
                      <option value="flexible">灵活</option>
                      <option value="filler">有空才做</option>
                    </select>
                  </label>
                  <RangeSetting
                    label="重要程度"
                    value={routine.priority}
                    onChange={(priority) =>
                      onChange({
                        ...spec,
                        routines: spec.routines.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, priority } : item,
                        ),
                      })
                    }
                  />
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <div className="policy-panels">
        <details className="policy-panel compatibility-settings legacy-policy-panel">
          <summary>旧版精确日程兼容（fuzzy 产品模式不启用）</summary>
          <div className="policy-panel__heading">
            <div>
              <h3>旧版 72 小时排程参数</h3>
              <p>
                这些字段只为读取旧角色版本和 legacy_exact
                运行模式保留，不控制当前 fuzzy life。
              </p>
            </div>
            <label className="switch-field">
              <input
                type="checkbox"
                checked={schedule.enabled}
                onChange={(event) =>
                  updateSchedule({ ...schedule, enabled: event.target.checked })
                }
              />
              启用旧版精确排程
            </label>
          </div>
          <div className="range-settings range-settings--single">
            <RangeSetting
              label="旧排程：遵循规律"
              value={schedule.routineAdherence}
              onFocus={() =>
                onSelect({
                  path: "schedulePolicy.routineAdherence",
                  label: "旧排程：遵循规律",
                })
              }
              onChange={(routineAdherence) =>
                updateSchedule({ ...schedule, routineAdherence })
              }
            />
            <RangeSetting
              label="旧排程：临时起意"
              value={schedule.spontaneity}
              onChange={(spontaneity) =>
                updateSchedule({ ...schedule, spontaneity })
              }
            />
            <RangeSetting
              label="旧排程：接受社交邀请"
              value={schedule.socialInvitationBias}
              onChange={(socialInvitationBias) =>
                updateSchedule({ ...schedule, socialInvitationBias })
              }
            />
          </div>
          <div className="structured-editor-grid structured-editor-grid--compact">
            <label className="field editor-field">
              <span>旧排程睡眠开始</span>
              <input
                type="time"
                value={schedule.sleepWindow.startLocal}
                onChange={(event) =>
                  updateSchedule({
                    ...schedule,
                    sleepWindow: {
                      ...schedule.sleepWindow,
                      startLocal: event.target.value,
                    },
                  })
                }
              />
            </label>
            <label className="field editor-field">
              <span>旧排程睡眠结束</span>
              <input
                type="time"
                value={schedule.sleepWindow.endLocal}
                onChange={(event) =>
                  updateSchedule({
                    ...schedule,
                    sleepWindow: {
                      ...schedule.sleepWindow,
                      endLocal: event.target.value,
                    },
                  })
                }
              />
            </label>
            <NumberSetting
              label="旧排程每日承诺上限"
              value={schedule.maxCommittedHoursPerDay}
              min={1}
              max={24}
              suffix="小时"
              onChange={(maxCommittedHoursPerDay) =>
                updateSchedule({ ...schedule, maxCommittedHoursPerDay })
              }
            />
          </div>
          <div className="compatibility-settings__extension">
            <NumberSetting
              label="旧排程延展阈值"
              value={schedule.extendWhenRemainingHoursBelow}
              min={1}
              max={71}
              suffix="小时"
              onChange={(extendWhenRemainingHoursBelow) =>
                updateSchedule({
                  ...schedule,
                  extendWhenRemainingHoursBelow,
                })
              }
            />
          </div>
        </details>

        <details className="policy-panel compatibility-settings paused-policy-panel">
          <summary>主动联系（当前暂停，发布时保持关闭）</summary>
          <div className="policy-panel__heading">
            <div>
              <h3>主动联系兼容偏好</h3>
              <p>
                当前所有模拟档位都暂停主动消息。以下偏好仅供读取旧角色版本和未来能力恢复时使用。
              </p>
            </div>
            <label className="switch-field">
              <input
                type="checkbox"
                checked={proactive.enabled}
                disabled
                readOnly
              />
              当前不可启用
            </label>
          </div>
          <div className="structured-editor-grid structured-editor-grid--compact">
            <NumberSetting
              label="每天最多主动消息"
              value={proactive.maxMessagesPerDay}
              min={0}
              max={2}
              suffix="条"
              onChange={(maxMessagesPerDay) =>
                updateProactive({ ...proactive, maxMessagesPerDay })
              }
            />
            <label className="field editor-field">
              <span>安静时段开始</span>
              <input
                type="time"
                value={proactive.quietHours.startLocal}
                onChange={(event) =>
                  updateProactive({
                    ...proactive,
                    quietHours: {
                      ...proactive.quietHours,
                      startLocal: event.target.value,
                    },
                  })
                }
              />
            </label>
            <label className="field editor-field">
              <span>安静时段结束</span>
              <input
                type="time"
                value={proactive.quietHours.endLocal}
                onChange={(event) =>
                  updateProactive({
                    ...proactive,
                    quietHours: {
                      ...proactive.quietHours,
                      endLocal: event.target.value,
                    },
                  })
                }
              />
            </label>
          </div>
          <RangeSetting
            label="主动联系所需亲近度"
            value={proactive.minimumCloseness}
            onFocus={() =>
              onSelect({
                path: "proactivePolicy.minimumCloseness",
                label: "主动联系所需亲近度",
              })
            }
            onChange={(minimumCloseness) =>
              updateProactive({ ...proactive, minimumCloseness })
            }
          />
          <EditableStringList
            title="可以主动分享的生活类别"
            values={proactive.shareableCategories}
            placeholder="例如：学习、朋友、兴趣"
            onChange={(shareableCategories) =>
              updateProactive({ ...proactive, shareableCategories })
            }
          />
        </details>
      </div>
    </section>
  );
}
