import type { CharacterInterviewAnswers } from "@personasim/contracts";

export function InterviewSettings({
  answers,
  onChange,
  disabled = false,
}: {
  answers: CharacterInterviewAnswers;
  onChange: (answers: CharacterInterviewAnswers) => void;
  disabled?: boolean;
}) {
  const advanced = answers.advanced ?? {};
  return (
    <details className="creation-settings">
      <summary>更多设定</summary>
      <div className="creation-settings-fields">
        <label>
          模拟方式
          <select
            value={advanced.tier ?? "high_fidelity"}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...answers,
                advanced: {
                  ...advanced,
                  tier: event.target.value as
                    "lightweight" | "daily" | "high_fidelity",
                },
              })
            }
          >
            <option value="high_fidelity">拟真模拟</option>
            <option value="daily">日常模拟</option>
            <option value="lightweight">轻量模拟</option>
          </select>
        </label>
        <label>
          角色时区
          <input
            value={advanced.timezone ?? "Asia/Shanghai"}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...answers,
                advanced: { ...advanced, timezone: event.target.value },
              })
            }
          />
        </label>
        <label>
          故事年份（可选）
          <input
            type="number"
            min={1000}
            max={9999}
            value={advanced.storyAnchorYear ?? ""}
            disabled={disabled}
            onChange={(event) => {
              const rest = { ...advanced };
              delete rest.storyAnchorYear;
              onChange({
                ...answers,
                advanced: {
                  ...rest,
                  ...(event.target.value
                    ? { storyAnchorYear: Number(event.target.value) }
                    : {}),
                },
              });
            }}
          />
        </label>
        <label>
          时代说明（可选）
          <input
            value={advanced.storyEra ?? ""}
            maxLength={240}
            disabled={disabled}
            onChange={(event) => {
              const rest = { ...advanced };
              delete rest.storyEra;
              onChange({
                ...answers,
                advanced: {
                  ...rest,
                  ...(event.target.value
                    ? { storyEra: event.target.value }
                    : {}),
                },
              });
            }}
          />
        </label>
      </div>
    </details>
  );
}
