import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  assembleChatPrompt,
  type AssemblePromptInput,
} from "@personasim/features";
import { initialRuntimeState } from "../domain/defaults.js";
import { buildArchitecturePersonaFixtureCharacter } from "./architecture-persona-cases.js";
import {
  parseArchitecturePrompt,
  type ArchitecturePromptSegment,
} from "./architecture-prompt-ablation.js";
import { CONTINUITY_WORKSPACE_ROOT } from "./continuity-run-identity.js";
import {
  RUNTIME_STATE_AUDIT_CASES,
  RUNTIME_STATE_AUDIT_DIMENSIONS,
  RUNTIME_STATE_AUDIT_NEUTRAL,
  RUNTIME_STATE_AUDIT_NOW,
  RUNTIME_STATE_AUDIT_PERSONAS,
  type RuntimeStateAuditCase,
  type RuntimeStateAuditDimension,
} from "./runtime-state-audit-cases.js";

export const RUNTIME_STATE_AUDIT_LEGACY_COMMIT =
  "4492a9cfb34bfc3c4a32d4298127ba86eda274f2";
export const RUNTIME_STATE_AUDIT_ARMS = [
  "legacy_state_readout",
  "current",
  "param_ablation",
] as const;
export type RuntimeStateAuditArm = (typeof RUNTIME_STATE_AUDIT_ARMS)[number];
export const runtimeStateAuditHash = (value: unknown): string =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a complete state audit JSON object");
  return value as JsonRecord;
};

export function loadLegacyRuntimeStateReadout() {
  const selections: Record<string, string[]> = {
    "packages/features/src/runtime-state-description.ts": [
      "describeRuntimeState",
      "describeSignedBand",
      "describeBand",
    ],
    "packages/features/src/prompt-assembler.ts": ["compactRuntimeState"],
    "packages/features/src/reply-strategy.ts": ["stateGuidanceFor"],
    "packages/features/src/shared.ts": ["clamp"],
  };
  const sources: Record<string, string> = {};
  const extracted: string[] = [];
  for (const [path, names] of Object.entries(selections)) {
    const source = execFileSync(
      "git",
      ["show", `${RUNTIME_STATE_AUDIT_LEGACY_COMMIT}:${path}`],
      {
        cwd: CONTINUITY_WORKSPACE_ROOT,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
    );
    sources[path] = source;
    const ast = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    for (const name of names) {
      const matches = ast.statements.filter(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
      );
      if (matches.length !== 1)
        throw new Error(`Legacy function missing or ambiguous: ${name}`);
      extracted.push(matches[0]!.getText(ast));
    }
  }
  const source = `${extracted.join("\n\n")}\nmodule.exports = { compactRuntimeState, stateGuidanceFor };`;
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = {
    exports: {} as {
      compactRuntimeState: (state: unknown) => unknown;
      stateGuidanceFor: (state: unknown) => string;
    },
  };
  runInNewContext(
    compiled,
    { exports: module.exports, module },
    { timeout: 1000 },
  );
  return {
    source,
    sourceHashes: Object.fromEntries(
      Object.entries(sources).map(([path, text]) => [
        path,
        runtimeStateAuditHash(text),
      ]),
    ),
    runtimeState: (state: unknown) =>
      record(
        JSON.parse(JSON.stringify(module.exports.compactRuntimeState(state))),
      ),
    stateGuidance: (state: unknown) => module.exports.stateGuidanceFor(state),
  };
}

export function runtimeStateAuditInput(
  personaId: string,
  probe: RuntimeStateAuditCase,
  mode: "fuzzy" | "legacy_exact" = "fuzzy",
): AssemblePromptInput {
  const original = buildArchitecturePersonaFixtureCharacter(personaId);
  const character = {
    ...original,
    identity: {
      ...original.identity,
      temporalFrame: { mode: "realtime" as const, eraLabel: "2026年的上海" },
    },
  };
  const initial = initialRuntimeState(
    character.id,
    RUNTIME_STATE_AUDIT_NOW,
    character,
  );
  return {
    character,
    state: {
      agentId: initial.agentId,
      asOfUtc: initial.asOfUtc,
      revision: initial.revision,
      relationship: initial.relationship,
      ...(initial.locationContext === undefined
        ? {}
        : { locationContext: initial.locationContext }),
      ...RUNTIME_STATE_AUDIT_NEUTRAL,
      ...probe.state,
    },
    schedule: [],
    memories: [],
    recentMessages: probe.history.map((message, index) => ({
      ...message,
      createdAtUtc: new Date(
        Date.parse(RUNTIME_STATE_AUDIT_NOW) -
          (probe.history.length - index) * 60_000,
      ).toISOString(),
    })),
    nowUtc: RUNTIME_STATE_AUDIT_NOW,
    userMessage: probe.userText,
    lifePlanningMode: mode,
    liveWorldEffectsMode: "off",
    decisionMode: "reply_only",
    maxInputTokens: 32_000,
  };
}

function segmentPayload(segment: ArchitecturePromptSegment): JsonRecord {
  const lines = segment.content.split("\n");
  const index = lines.indexOf(segment.label);
  if (index !== 0 || lines.length !== 2)
    throw new Error(
      `State audit requires one complete JSON payload: ${segment.label}`,
    );
  return record(JSON.parse(lines[1]!));
}
function replacePayload(
  segment: ArchitecturePromptSegment,
  payload: JsonRecord,
): ArchitecturePromptSegment {
  return {
    ...segment,
    content: `${segment.label}\n${JSON.stringify(payload)}`,
  };
}
function join(
  segments: ArchitecturePromptSegment[],
  placement: "system" | "prompt",
) {
  return segments
    .filter((item) => item.placement === placement)
    .map((item) => item.content)
    .join("\n");
}
function removeDimensions(
  runtime: JsonRecord,
  dimensions: readonly RuntimeStateAuditDimension[],
) {
  const result = structuredClone(runtime);
  const qualitative = record(result["qualitative"]);
  if ("summary" in qualitative)
    throw new Error(
      "Current qualitative summary would leak removed dimensions; finish the production audit first",
    );
  const removed: string[] = [];
  for (const field of dimensions) {
    if (Object.hasOwn(result, field)) {
      delete result[field];
      removed.push(`runtime.${field}`);
    }
    const description = field === "sleepDebtMinutes" ? "sleepDebt" : field;
    if (Object.hasOwn(qualitative, description)) {
      delete qualitative[description];
      removed.push(`runtime.qualitative.${description}`);
    }
  }
  return { result, removed };
}

export interface RuntimeStateAuditCell {
  id: string;
  personaId: string;
  caseId: string;
  arm: RuntimeStateAuditArm;
  system: string;
  prompt: string;
  proof: {
    target: RuntimeStateAuditCase["target"];
    removedPaths: string[];
    nonTargetEqual: boolean;
    interventionPresent: boolean;
    promptSha256: string;
    currentPromptSha256: string;
    rawProductionPromptSha256: string;
    nonStateSegmentsSha256: string;
    stateGuidancePresent: boolean;
    budgetAndIntentEqual: boolean;
    strategyControl: "same_persona_task_neutral_state";
  };
  skipped?: string;
}

export function buildRuntimeStateAuditCells(
  legacy = loadLegacyRuntimeStateReadout(),
  personas: readonly string[] = RUNTIME_STATE_AUDIT_PERSONAS,
  cases: readonly RuntimeStateAuditCase[] = RUNTIME_STATE_AUDIT_CASES,
) {
  const cells: RuntimeStateAuditCell[] = [];
  const captures: unknown[] = [];
  for (const personaId of personas)
    for (const probe of cases) {
      const input = runtimeStateAuditInput(personaId, probe);
      const assembled = assembleChatPrompt(input);
      const productionSegments = parseArchitecturePrompt(assembled);
      const neutralInput = {
        ...input,
        state: { ...input.state, ...RUNTIME_STATE_AUDIT_NEUTRAL },
      };
      const neutralAssembled = assembleChatPrompt(neutralInput);
      const neutralSegments = parseArchitecturePrompt(neutralAssembled);
      const neutralStrategy = neutralSegments.find(
        (segment) => segment.id === "15_reply_strategy",
      );
      if (!neutralStrategy)
        throw new Error("Neutral strategy capture is missing");
      const otherSegments = (segments: ArchitecturePromptSegment[]) =>
        segments.filter(
          (item) =>
            !["08_runtime_state", "15_reply_strategy"].includes(item.id),
        );
      if (
        runtimeStateAuditHash(otherSegments(productionSegments)) !==
        runtimeStateAuditHash(otherSegments(neutralSegments))
      )
        throw new Error(
          "State affected another production segment outside the registered state/strategy controls",
        );
      // Freeze the neutral-state strategy in every arm. Otherwise delivery and
      // length controls retain an indirect readout of the dimension being removed.
      const original = productionSegments.map((segment) =>
        segment.id === neutralStrategy.id ? neutralStrategy : segment,
      );
      const runtime = original.find((item) => item.id === "08_runtime_state")!;
      const strategy = original.find(
        (item) => item.id === "15_reply_strategy",
      )!;
      if (!runtime || !strategy)
        throw new Error(
          "Production assembler did not emit required state and strategy segments",
        );
      const runtimePayload = segmentPayload(runtime);
      const strategyPayload = segmentPayload(strategy);
      if ("stateGuidance" in strategyPayload)
        throw new Error(
          "Production prompt still contains duplicate stateGuidance; finish the audit before evaluation",
        );
      if (
        "sleepDebtMinutes" in runtimePayload ||
        "sleepDebt" in record(runtimePayload["qualitative"])
      )
        throw new Error(
          "Fuzzy prompt contains unsupported sleep debt projection",
        );
      captures.push({
        personaId,
        caseId: probe.id,
        input,
        system: assembled.system,
        prompt: assembled.prompt,
        segmentTrace: assembled.segmentTrace,
        planningOnlyStrategy: assembled.replyStrategy,
        neutralStrategyCapture: {
          input: neutralInput,
          system: neutralAssembled.system,
          prompt: neutralAssembled.prompt,
          segmentTrace: neutralAssembled.segmentTrace,
          strategy: neutralAssembled.replyStrategy,
        },
      });
      const rawProductionPromptSha256 = runtimeStateAuditHash({
        system: assembled.system,
        prompt: assembled.prompt,
      });
      const currentPromptSha256 = runtimeStateAuditHash({
        system: join(original, "system"),
        prompt: join(original, "prompt"),
      });
      const nonState = original.filter(
        (item) => !["08_runtime_state", "15_reply_strategy"].includes(item.id),
      );
      for (const arm of RUNTIME_STATE_AUDIT_ARMS) {
        let transformed = original;
        let removedPaths: string[] = [];
        if (arm === "legacy_state_readout") {
          transformed = original.map((segment) =>
            segment.id === runtime.id
              ? replacePayload(segment, legacy.runtimeState(input.state))
              : segment.id === strategy.id
                ? replacePayload(segment, {
                    ...strategyPayload,
                    stateGuidance: legacy.stateGuidance(input.state),
                  })
                : segment,
          );
        } else if (arm === "param_ablation") {
          const dimensions =
            probe.target === "all_short_term"
              ? RUNTIME_STATE_AUDIT_DIMENSIONS
              : [probe.target];
          const changed = removeDimensions(runtimePayload, dimensions);
          removedPaths = changed.removed;
          transformed = original.map((segment) =>
            segment.id === runtime.id
              ? replacePayload(segment, changed.result)
              : segment,
          );
        }
        const system = join(transformed, "system");
        const prompt = join(transformed, "prompt");
        const transformedStrategy = {
          ...segmentPayload(
            transformed.find((segment) => segment.id === strategy.id)!,
          ),
        };
        delete transformedStrategy["stateGuidance"];
        const nonTargetEqual =
          runtimeStateAuditHash(nonState) ===
          runtimeStateAuditHash(
            transformed.filter(
              (item) => ![runtime.id, strategy.id].includes(item.id),
            ),
          );
        const budgetAndIntentEqual =
          JSON.stringify(strategyPayload) ===
          JSON.stringify(transformedStrategy);
        if (!nonTargetEqual || !budgetAndIntentEqual)
          throw new Error(
            "State readout intervention changed other admitted context, strategy or budget",
          );
        const promptSha256 = runtimeStateAuditHash({ system, prompt });
        const interventionPresent = promptSha256 !== currentPromptSha256;
        cells.push({
          id: `${personaId}-${probe.id}-${arm}`,
          personaId,
          caseId: probe.id,
          arm,
          system,
          prompt,
          proof: {
            target: probe.target,
            removedPaths,
            nonTargetEqual,
            interventionPresent,
            promptSha256,
            currentPromptSha256,
            rawProductionPromptSha256,
            nonStateSegmentsSha256: runtimeStateAuditHash(nonState),
            stateGuidancePresent:
              "stateGuidance" in
              segmentPayload(
                transformed.find((segment) => segment.id === strategy.id)!,
              ),
            budgetAndIntentEqual,
            strategyControl: "same_persona_task_neutral_state",
          },
          ...(arm === "param_ablation" && !interventionPresent
            ? {
                skipped:
                  "No-op: this dimension is not available in the current production projection; no request dispatched and no value judgment inferred.",
              }
            : {}),
        });
      }
    }
  const sleepProbe = RUNTIME_STATE_AUDIT_CASES.find(
    (probe) => probe.target === "sleepDebtMinutes",
  )!;
  const legacyInput = runtimeStateAuditInput(
    RUNTIME_STATE_AUDIT_PERSONAS[0],
    { ...sleepProbe, state: { sleepDebtMinutes: 360 } },
    "legacy_exact",
  );
  const legacyAssembled = assembleChatPrompt(legacyInput);
  const legacyState = segmentPayload(
    parseArchitecturePrompt(legacyAssembled).find(
      (segment) => segment.id === "08_runtime_state",
    )!,
  );
  const legacyRemoved = removeDimensions(legacyState, ["sleepDebtMinutes"]);
  if (
    legacyState["sleepDebtMinutes"] !== 360 ||
    typeof record(legacyState["qualitative"])["sleepDebt"] !== "string" ||
    legacyRemoved.removed.length !== 2
  )
    throw new Error(
      "Legacy sourced-sleep projection fixture did not preserve and remove its supported state",
    );
  return {
    cells,
    captures,
    legacy,
    legacySleepFixture: {
      kind: "offline legacy_exact state-projection fixture only; not an executed sleep settlement or paid model candidate",
      provenance:
        "Authored legacy_exact persisted-state fixture with sleepDebtMinutes=360 and fixed asOfUtc; production source/evolution validity is covered separately by integration tests.",
      original: legacyState,
      ablated: legacyRemoved.result,
      removedPaths: legacyRemoved.removed,
    },
  };
}
