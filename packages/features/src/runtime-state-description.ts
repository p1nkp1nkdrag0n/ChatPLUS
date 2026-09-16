import type { RuntimeStateLike } from "./state-engine.js";

/** Value-independent semantics shared by the admitted generation/repair state
 * snapshot. These explain how to read dimensions together, never derive a
 * missing dimension or claim a cause from the numeric state. */
export const RUNTIME_STATE_INTERPRETATION = Object.freeze({
  capacity:
    "Read together: energy reflects effort reserve, focus attention continuity, socialBattery conversational reserve. These are tendencies, not fixed limits or substitutes. Capacity is no quota or time/percentage commitment; small tasks stay complete and small.",
  cause:
    "Values, occupations, routines and clock time cannot establish recent events or causes. Use supplied evidence; user experiences belong to the user.",
  continuity:
    "asOfUtc/revision identify the snapshot, not individual changes. Elapsed time is not evidence of rest or resolution. Resolved events are no longer unresolved; recovery may be partial.",
});

export interface RuntimeStateDescription {
  moodValence: string;
  moodArousal: string;
  energy: string;
  stress: string;
  socialBattery: string;
  focus: string;
  sleepDebt?: string;
  summary: string;
}

export interface RuntimeStateDescriptionOptions {
  /** False when the active life model does not maintain a sleep history. */
  sleepDebtAvailable?: boolean;
}

export function describeRuntimeState(
  state: Pick<
    RuntimeStateLike,
    | "moodValence"
    | "moodArousal"
    | "energy"
    | "stress"
    | "socialBattery"
    | "focus"
    | "sleepDebtMinutes"
  >,
  options: RuntimeStateDescriptionOptions = {},
): RuntimeStateDescription {
  const sleepDebt = Math.max(0, Math.min(720, state.sleepDebtMinutes ?? 0));
  const parts = {
    moodValence: describeSignedBand(state.moodValence, [
      [-0.5, "情绪明显低落，表达更偏沉重"],
      [-0.1, "情绪略偏负向，容易流露出低落或不快"],
      [0.35, "情绪相对平稳"],
      [1.01, "情绪明显正向，更容易流露轻松和愉快"],
    ]),
    moodArousal: describeBand(state.moodArousal, [
      [0.25, "情绪唤醒度较低，表达节奏更平静"],
      [0.55, "情绪活跃度适中"],
      [0.8, "情绪较活跃，反应更鲜明"],
      [1.01, "情绪高度激活，表达节奏更紧或更快"],
    ]),
    energy: describeBand(state.energy, [
      [0.25, "精力见底，需要控制消耗"],
      [
        0.5,
        "\u6709\u4e9b\u75b2\u60eb\uff0c\u9700\u8981\u63a7\u5236\u6d88\u8017",
      ],
      [
        0.78,
        "\u7cbe\u529b\u5c1a\u53ef\uff0c\u53ef\u4ee5\u6b63\u5e38\u6295\u5165",
      ],
      [1.01, "精力充足，可投入的精力较多"],
    ]),
    stress: describeBand(state.stress, [
      [0.3, "压力较低，当前紧张负荷较轻"],
      [
        0.55,
        "\u6709\u4e00\u4e9b\u538b\u529b\uff0c\u4f46\u4ecd\u53ef\u8c03\u8282",
      ],
      [
        0.75,
        "\u538b\u529b\u504f\u9ad8\uff0c\u4e0d\u592a\u5bb9\u6613\u5b8c\u5168\u653e\u677e",
      ],
      [1.01, "压力很高，紧张负荷明显；可承受的投入仍需结合其他状态"],
    ]),
    socialBattery: describeBand(state.socialBattery, [
      [0.2, "社交精力很低，可投入交流的余量很少"],
      [0.45, "社交精力有限"],
      [0.75, "社交精力尚可"],
      [1.01, "社交精力充足"],
    ]),
    focus: describeBand(state.focus, [
      [0.25, "\u5f88\u96be\u6301\u7eed\u4e13\u6ce8"],
      [0.5, "\u4e13\u6ce8\u529b\u5bb9\u6613\u6ce2\u52a8"],
      [0.78, "\u4e13\u6ce8\u72b6\u6001\u7a33\u5b9a"],
      [1.01, "\u6ce8\u610f\u529b\u9ad8\u5ea6\u96c6\u4e2d"],
    ]),
    ...(options.sleepDebtAvailable === false
      ? {}
      : {
          sleepDebt:
            sleepDebt === 0
              ? "\u6ca1\u6709\u7d2f\u79ef\u7761\u7720\u503a"
              : sleepDebt < 120
                ? "\u6709\u8f7b\u5ea6\u7761\u7720\u503a\uff08\u7ea6 " +
                  sleepDebt +
                  " \u5206\u949f\uff09"
                : sleepDebt < 300
                  ? "\u7761\u7720\u503a\u660e\u663e\uff08\u7ea6 " +
                    sleepDebt +
                    " \u5206\u949f\uff09"
                  : "\u7761\u7720\u503a\u5f88\u9ad8\uff08\u7ea6 " +
                    sleepDebt +
                    " \u5206\u949f\uff09\uff0c\u9700\u8981\u6062\u590d",
        }),
  };
  return {
    ...parts,
    summary: [
      parts.moodValence,
      parts.moodArousal,
      parts.energy,
      parts.stress,
      parts.socialBattery,
      parts.focus,
      parts.sleepDebt,
    ]
      .filter((part) => part !== undefined)
      .join("\uff1b"),
  };
}

function describeSignedBand(
  value: number,
  bands: ReadonlyArray<readonly [number, string]>,
): string {
  const safe = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  return bands.find(([maximum]) => safe < maximum)?.[1] ?? bands.at(-1)![1];
}

function describeBand(
  value: number,
  bands: ReadonlyArray<readonly [number, string]>,
): string {
  const safe = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
  return bands.find(([maximum]) => safe < maximum)?.[1] ?? bands.at(-1)![1];
}
