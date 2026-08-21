import type { RuntimeStateLike } from "./state-engine.js";

export interface RuntimeStateDescription {
  energy: string;
  stress: string;
  socialBattery: string;
  focus: string;
  sleepDebt: string;
  summary: string;
}

export function describeRuntimeState(
  state: Pick<
    RuntimeStateLike,
    "energy" | "stress" | "socialBattery" | "focus" | "sleepDebtMinutes"
  >,
): RuntimeStateDescription {
  const sleepDebt = Math.max(0, Math.min(720, state.sleepDebtMinutes ?? 0));
  const parts = {
    energy: describeBand(state.energy, [
      [
        0.25,
        "\u7cbe\u529b\u89c1\u5e95\uff0c\u6ce8\u610f\u529b\u5df2\u7ecf\u660e\u663e\u4e0b\u964d",
      ],
      [
        0.5,
        "\u6709\u4e9b\u75b2\u60eb\uff0c\u9700\u8981\u63a7\u5236\u6d88\u8017",
      ],
      [
        0.78,
        "\u7cbe\u529b\u5c1a\u53ef\uff0c\u53ef\u4ee5\u6b63\u5e38\u6295\u5165",
      ],
      [
        1.01,
        "\u7cbe\u529b\u5145\u8db3\uff0c\u884c\u52a8\u610f\u613f\u5f88\u5f3a",
      ],
    ]),
    stress: describeBand(state.stress, [
      [0.3, "\u538b\u529b\u8f83\u4f4e\uff0c\u5fc3\u6001\u653e\u677e"],
      [
        0.55,
        "\u6709\u4e00\u4e9b\u538b\u529b\uff0c\u4f46\u4ecd\u53ef\u8c03\u8282",
      ],
      [
        0.75,
        "\u538b\u529b\u504f\u9ad8\uff0c\u4e0d\u592a\u5bb9\u6613\u5b8c\u5168\u653e\u677e",
      ],
      [
        1.01,
        "\u538b\u529b\u5f88\u9ad8\uff0c\u9700\u8981\u4f18\u5148\u964d\u4f4e\u8d1f\u8377",
      ],
    ]),
    socialBattery: describeBand(state.socialBattery, [
      [
        0.2,
        "\u793e\u4ea4\u7cbe\u529b\u5f88\u4f4e\uff0c\u66f4\u503e\u5411\u5c11\u8bf4\u4e00\u70b9",
      ],
      [
        0.45,
        "\u793e\u4ea4\u7cbe\u529b\u6709\u9650\uff0c\u4f1a\u66f4\u514b\u5236",
      ],
      [
        0.75,
        "\u613f\u610f\u6b63\u5e38\u4ea4\u6d41\uff0c\u4f46\u4e0d\u4f1a\u8fc7\u5ea6\u70ed\u7edc",
      ],
      [
        1.01,
        "\u5f88\u6709\u4ea4\u6d41\u610f\u613f\uff0c\u8868\u8fbe\u66f4\u4e3b\u52a8",
      ],
    ]),
    focus: describeBand(state.focus, [
      [0.25, "\u5f88\u96be\u6301\u7eed\u4e13\u6ce8"],
      [0.5, "\u4e13\u6ce8\u529b\u5bb9\u6613\u6ce2\u52a8"],
      [0.78, "\u4e13\u6ce8\u72b6\u6001\u7a33\u5b9a"],
      [1.01, "\u6ce8\u610f\u529b\u9ad8\u5ea6\u96c6\u4e2d"],
    ]),
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
  };
  return {
    ...parts,
    summary: [
      parts.energy,
      parts.stress,
      parts.socialBattery,
      parts.sleepDebt,
    ].join("\uff1b"),
  };
}

function describeBand(
  value: number,
  bands: ReadonlyArray<readonly [number, string]>,
): string {
  const safe = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
  return bands.find(([maximum]) => safe < maximum)?.[1] ?? bands.at(-1)![1];
}
