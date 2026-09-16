import { afterEach, describe, expect, it, vi } from "vitest";
import * as features from "@personasim/features";
import {
  parseArchitecturePrompt,
  type ArchitecturePromptSegment,
} from "./architecture-prompt-ablation.js";
import {
  STATE_MATRIX_BASELINE_CASES,
  STATE_MATRIX_DIMENSIONS,
  STATE_MATRIX_HOLDOUT_CASES,
  STATE_MATRIX_NEUTRAL,
  STATE_MATRIX_REGRESSION_CASE_IDS,
} from "./state-matrix-validation-cases.js";
import {
  buildStateMatrixValidationPrompts,
  assertStateMatrixFixedSegments,
  stateMatrixValidationInput,
  type StateMatrixPromptCapture,
} from "./state-matrix-validation-prompts.js";

afterEach(() => vi.restoreAllMocks());

it("retains original event times across authored continuity snapshots", () => {
  const sourceTimes = new Map<string, string>();
  for (const probe of [
    ...STATE_MATRIX_BASELINE_CASES,
    ...STATE_MATRIX_HOLDOUT_CASES,
  ]) {
    const input = stateMatrixValidationInput(probe);
    for (const [index, message] of probe.history.entries()) {
      expect(message.createdAtUtc).toBeDefined();
      expect(input.recentMessages[index]!.createdAtUtc).toBe(
        message.createdAtUtc,
      );
      expect(Date.parse(message.createdAtUtc!)).toBeLessThanOrEqual(
        Date.parse(probe.nowUtc),
      );
      const previous = sourceTimes.get(message.id);
      if (previous !== undefined) expect(message.createdAtUtc).toBe(previous);
      sourceTimes.set(message.id, message.createdAtUtc!);
    }
  }
});

function jsonPayload(
  segments: readonly ArchitecturePromptSegment[],
  id: string,
) {
  const text = segments.find((segment) => segment.id === id)!.content;
  return JSON.parse(text.slice(text.indexOf("\n") + 1)) as Record<
    string,
    unknown
  >;
}

function fixedPrompt(
  capture: StateMatrixPromptCapture,
  omittedDimension: string,
) {
  return capture.model.segments.map((segment) => {
    if (segment.id !== "08_runtime_state") return segment;
    const state = jsonPayload([segment], segment.id);
    const qualitative = {
      ...(state["qualitative"] as Record<string, unknown>),
    };
    delete state[omittedDimension];
    delete qualitative[omittedDimension];
    return { ...segment, content: JSON.stringify({ ...state, qualitative }) };
  });
}

function changeProductionSegment(
  transform: (segment: ArchitecturePromptSegment) => ArchitecturePromptSegment,
) {
  const original = features.assembleChatPrompt;
  vi.spyOn(features, "assembleChatPrompt").mockImplementation((input) => {
    const assembled = original(input);
    const segments = parseArchitecturePrompt(assembled).map(transform);
    const join = (placement: "system" | "prompt") =>
      segments
        .filter((segment) => segment.placement === placement)
        .map((segment) => segment.content)
        .join("\n");
    const system = join("system");
    const prompt = join("prompt");
    return {
      ...assembled,
      system,
      prompt,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      segmentTrace: {
        ...assembled.segmentTrace,
        estimatedInputTokens:
          features.estimatePromptTokens(system) +
          features.estimatePromptTokens(prompt),
        segments: assembled.segmentTrace.segments.map((trace) => {
          const updated = segments.find((segment) => segment.id === trace.id);
          return updated === undefined
            ? trace
            : {
                ...trace,
                renderedCharacters: updated.content.length,
                estimatedTokens: features.estimatePromptTokens(updated.content),
              };
        }),
      },
    };
  });
}

describe("state matrix frozen production prompt builder", () => {
  it("rejects moving an allowed state block to a new prompt position", () => {
    const segments = parseArchitecturePrompt(
      features.assembleChatPrompt(
        stateMatrixValidationInput(STATE_MATRIX_BASELINE_CASES[0]!),
      ),
    );
    const state = segments.find(
      (segment) => segment.id === "08_runtime_state",
    )!;
    expect(() =>
      assertStateMatrixFixedSegments(segments, [
        ...segments.filter((segment) => segment !== state),
        state,
      ]),
    ).toThrow("segment layout");
  });
  it("dispatches 56 baseline cells while freezing all 63 inputs and seven holdout baselines", () => {
    const result = buildStateMatrixValidationPrompts();
    expect(result.cells).toHaveLength(56);
    expect(new Set(result.cells.map((cell) => cell.cellId)).size).toBe(56);
    expect(
      result.cells.filter((cell) => cell.family === "necessity"),
    ).toHaveLength(36);
    expect(result.cells.filter((cell) => cell.family === "mixed")).toHaveLength(
      8,
    );
    expect(
      result.cells.filter((cell) => cell.family === "continuity"),
    ).toHaveLength(12);
    expect(result.promptManifest.baseline.captures).toHaveLength(63);
    expect(result.promptManifest.baseline.holdoutCaseIds).toEqual(
      STATE_MATRIX_HOLDOUT_CASES.map((probe) => probe.id),
    );
    expect(result.promptManifest.baseline.regressionCaseIds).toEqual(
      STATE_MATRIX_REGRESSION_CASE_IDS,
    );
    expect(result.sharedReviewContexts.cases).toHaveLength(56);
    for (const cell of result.cells) {
      expect(cell.phase).toBe("baseline");
      expect(cell.variant).toBe("baseline");
      expect(cell.system).toContain("REPLY_TASK_GROUNDING_POLICY");
      expect(cell.prompt).not.toContain("sleepDebt");
      expect(cell.prompt).not.toContain('"stateGuidance"');
    }
  });

  it("isolates each low/high/omit trio with one exact neutral strategy and no source or derived leakage", () => {
    const result = buildStateMatrixValidationPrompts();
    const all = result.promptManifest.baseline.captures;
    for (const dimension of STATE_MATRIX_DIMENSIONS) {
      for (const context of ["A", "B"]) {
        const trio = all.filter(
          (capture) => capture.case.pairingId === `D-${dimension}-${context}`,
        );
        expect(trio).toHaveLength(3);
        expect(
          new Set(trio.map((capture) => capture.proof.strategySha256)).size,
        ).toBe(1);
        for (const capture of trio) {
          expect(capture.case.history).toEqual([]);
          expect(capture.input.recentMessages).toEqual([]);
          expect(capture.neutralInput!.state).toMatchObject(
            STATE_MATRIX_NEUTRAL,
          );
          expect(fixedPrompt(capture, dimension)).toEqual(
            fixedPrompt(trio[0]!, dimension),
          );
          const state = jsonPayload(capture.model.segments, "08_runtime_state");
          const qualitative = state["qualitative"] as Record<string, unknown>;
          if (capture.case.condition === "omit") {
            expect(state).not.toHaveProperty(dimension);
            expect(qualitative).not.toHaveProperty(dimension);
            const review = result.sharedReviewContexts.cases.find(
              (item) => item.caseId === capture.case.id,
            )!;
            expect(review.admittedState).not.toHaveProperty(dimension);
            expect(review.runtimeReviewAuthority).toContain("N/A");
          } else {
            expect(state[dimension]).toBe(capture.case.state[dimension]);
            expect(typeof qualitative[dimension]).toBe("string");
          }
          for (const criterion of [
            ...capture.case.criteria,
            ...capture.case.sourceNotes,
          ])
            expect(capture.model.system + capture.model.prompt).not.toContain(
              criterion,
            );
          expect(capture.model.system + capture.model.prompt).not.toContain(
            capture.case.title,
          );
        }
      }
    }
  });

  it("keeps mixed-persona and lifecycle requests identical to current production and performs no state evolution", () => {
    const result = buildStateMatrixValidationPrompts();
    for (const capture of result.promptManifest.baseline.captures.filter(
      (item) => item.case.strategyMode === "production",
    )) {
      const input = stateMatrixValidationInput(capture.case);
      const before = structuredClone(input);
      const production = features.assembleChatPrompt(input);
      expect(input).toEqual(before);
      expect(capture.input).toEqual(input);
      expect(capture.model.system).toBe(production.system);
      expect(capture.model.prompt).toBe(production.prompt);
      expect(capture.model.strategy).toEqual(production.replyStrategy);
      expect(capture.input.liveWorldEffectsMode).toBe("off");
      expect(capture.input.decisionMode).toBe("reply_only");
      expect(capture.input.state).toMatchObject(capture.case.state);
      expect(capture.neutralInput).toBeUndefined();
    }
  });

  it("replays frozen baselines and exactly 26 regression candidates plus seven holdout pairs", () => {
    const first = buildStateMatrixValidationPrompts();
    const baseline = first.promptManifest.baseline;
    const before = JSON.stringify(baseline);
    const result = buildStateMatrixValidationPrompts({
      phase: "candidate",
      frozenBaseline: baseline,
    });
    expect(result.cells).toHaveLength(40);
    expect(
      result.cells.filter((cell) => cell.variant === "candidate"),
    ).toHaveLength(33);
    expect(
      result.cells.filter((cell) => cell.variant === "baseline"),
    ).toHaveLength(7);
    expect(result.promptManifest.candidateCaptures).toHaveLength(33);
    expect(result.sharedReviewContexts.cases).toHaveLength(33);
    expect(JSON.stringify(baseline)).toBe(before);
    for (const cell of result.cells) {
      const saved = baseline.captures.find(
        (capture) => capture.case.id === cell.caseId,
      )!;
      expect(cell.system).toBe(saved.model.system);
      expect(cell.prompt).toBe(saved.model.prompt);
      expect(cell.phase).toBe("candidate");
    }
  });

  it("uses the optimized state block but never regenerates the baseline control from new production", () => {
    const baseline =
      buildStateMatrixValidationPrompts().promptManifest.baseline;
    changeProductionSegment((segment) => {
      if (segment.id !== "08_runtime_state") return segment;
      const state = jsonPayload([segment], segment.id);
      const qualitative = state["qualitative"] as Record<string, unknown>;
      qualitative["energy"] = "测试中的新版精力描述";
      return {
        ...segment,
        content: `${segment.label}\n${JSON.stringify(state)}`,
      };
    });
    const result = buildStateMatrixValidationPrompts({
      phase: "candidate",
      frozenBaseline: baseline,
    });
    for (const cell of result.cells.filter(
      (item) => item.family === "holdout",
    )) {
      expect(cell.prompt.includes("测试中的新版精力描述")).toBe(
        cell.variant === "candidate",
      );
      const saved = baseline.captures.find(
        (item) => item.case.id === cell.caseId,
      )!;
      expect(cell.system).toBe(saved.model.system);
      if (cell.variant === "baseline")
        expect(cell.prompt).toBe(saved.model.prompt);
    }
  });

  it("rejects changed persona/system instructions instead of broadening the intervention silently", () => {
    const baseline =
      buildStateMatrixValidationPrompts().promptManifest.baseline;
    changeProductionSegment((segment) =>
      segment.id === "01_app_policy"
        ? {
            ...segment,
            content: segment.content + "\nUnapproved system change.",
          }
        : segment,
    );
    expect(() =>
      buildStateMatrixValidationPrompts({
        phase: "candidate",
        frozenBaseline: baseline,
      }),
    ).toThrow("non-state/strategy segment");
  });

  it("rejects new derived state fields in omission arms until their removal is reviewed", () => {
    changeProductionSegment((segment) => {
      if (segment.id !== "08_runtime_state") return segment;
      const state = jsonPayload([segment], segment.id);
      state["combinedInterpretation"] = "An unreviewed derived readout.";
      return {
        ...segment,
        content: `${segment.label}\n${JSON.stringify(state)}`,
      };
    });
    expect(() => buildStateMatrixValidationPrompts()).toThrow(
      "Unreviewed derived state fields",
    );
  });

  it("rejects numeric-state clues hidden inside the allowed static interpretation", () => {
    changeProductionSegment((segment) => {
      if (segment.id !== "08_runtime_state") return segment;
      const state = jsonPayload([segment], segment.id);
      state["interpretation"] = {
        ...features.RUNTIME_STATE_INTERPRETATION,
        capacity: "Energy is low in this specific turn.",
      };
      return {
        ...segment,
        content: `${segment.label}\n${JSON.stringify(state)}`,
      };
    });
    expect(() => buildStateMatrixValidationPrompts()).toThrow(
      "Unreviewed state interpretation",
    );
  });

  it("rejects modified frozen inputs or private case criteria", () => {
    const baseline =
      buildStateMatrixValidationPrompts().promptManifest.baseline;
    const changed = structuredClone(baseline);
    changed.captures[0]!.input.userMessage = "Changed after baseline";
    expect(() =>
      buildStateMatrixValidationPrompts({
        phase: "candidate",
        frozenBaseline: changed,
      }),
    ).toThrow("modified frozen");
    expect(STATE_MATRIX_BASELINE_CASES).toHaveLength(56);
  });
});
