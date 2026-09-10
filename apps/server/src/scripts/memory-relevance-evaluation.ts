import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  buildConversationContextPlan,
  recallMemory,
  selectMemoryUseForTurn,
  type MemorySemanticSignal,
} from "@personasim/features";

import {
  MEMORY_EVALUATION_NOW,
  MEMORY_RELEVANCE_CASES,
  type MemoryRelevanceCase,
} from "./memory-relevance-evaluation-cases.js";

export const MEMORY_RELEVANCE_ARMS = [
  { id: "R0U0", retrieval: "lexical", use: "legacy_lexical" },
  { id: "R0U1", retrieval: "lexical", use: "shared" },
  { id: "R1U0", retrieval: "fixture_semantic_hybrid", use: "legacy_lexical" },
  { id: "R1U1", retrieval: "fixture_semantic_hybrid", use: "shared" },
] as const;

function signalsFor(scenario: MemoryRelevanceCase): MemorySemanticSignal[] {
  return scenario.memories.flatMap((memory) => {
    const score = scenario.semanticScores[memory.id];
    const evidence = memory.evidence?.[0];
    if (score === undefined || evidence === undefined) return [];
    return [
      {
        query: scenario.query,
        memoryId: memory.id,
        memoryContent: memory.content,
        evidenceId: evidence.id,
        evidenceSourceId: evidence.sourceId,
        evidenceText: evidence.quote ?? evidence.contextSummary ?? "",
        evidenceSourceType: evidence.sourceType,
        evidenceQuote: evidence.quote ?? null,
        evidenceContextSummary: evidence.contextSummary ?? null,
        score,
      },
    ];
  });
}

export function evaluateMemoryRelevance(
  scenarios: readonly MemoryRelevanceCase[] = MEMORY_RELEVANCE_CASES,
) {
  return scenarios.flatMap((scenario) =>
    MEMORY_RELEVANCE_ARMS.map((arm) => {
      const plan = buildConversationContextPlan({
        originalQuery: scenario.query,
        agentId: "agent-memory-evaluation",
        sessionId: "session-memory-evaluation",
        recentMessages: [],
      });
      const recall = recallMemory({
        query: scenario.query,
        memories: scenario.memories,
        nowUtc: MEMORY_EVALUATION_NOW,
        minimumScore: 0.42,
        maxEvidence: 3,
        ...(scenario.namespaces
          ? { namespaceFilters: scenario.namespaces }
          : {}),
        ...(arm.retrieval === "lexical"
          ? {}
          : { semanticSignals: signalsFor(scenario) }),
      });
      const evidence = recall.abstained ? [] : recall.evidenceBundle.evidence;
      const use = selectMemoryUseForTurn({
        plan,
        evidence,
        relevanceMode: arm.use,
        ...(scenario.suppressedMemoryIds
          ? { suppressedMemoryIds: scenario.suppressedMemoryIds }
          : {}),
        ...(scenario.recentlyMentionedMemoryIds
          ? { recentlyMentionedMemoryIds: scenario.recentlyMentionedMemoryIds }
          : {}),
      });
      const memoryIdsFor = (ids: readonly string[]) =>
        evidence
          .filter((item) => ids.includes(item.evidence.id))
          .map((item) => item.memoryId);
      const explicitMemoryIds = memoryIdsFor(use.explicitMentionEvidenceIds);
      const usedMemoryIds = memoryIdsFor([
        ...use.backgroundEvidenceIds,
        ...use.behavioralPreferenceEvidenceIds,
        ...use.explicitMentionEvidenceIds,
      ]);
      return {
        caseId: scenario.id,
        arm: arm.id,
        query: scenario.query,
        selectedMemoryIds: recall.selectedMemoryIds,
        selectedEvidenceIds: recall.selectedEvidenceIds,
        explicitMemoryIds,
        use,
        evidence,
        abstained: recall.abstained,
        checks: {
          missedRelevantMemories: scenario.expected.relevantMemoryIds.filter(
            (id) => !recall.selectedMemoryIds.includes(id),
          ),
          missedMentions: scenario.expected.mentionableMemoryIds.filter(
            (id) => !explicitMemoryIds.includes(id),
          ),
          unexpectedMentions: explicitMemoryIds.filter(
            (id) => !scenario.expected.mentionableMemoryIds.includes(id),
          ),
          forbiddenRecall: recall.selectedMemoryIds.filter((id) =>
            scenario.expected.forbiddenRecallMemoryIds.includes(id),
          ),
          forbiddenUse: usedMemoryIds.filter((id) =>
            scenario.expected.forbiddenUseMemoryIds.includes(id),
          ),
        },
      };
    }),
  );
}

export async function runMemoryRelevanceEvaluation(output: string) {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const directory = resolve(output);
  const localPath = relative(root, directory);
  if (
    !localPath ||
    localPath === ".." ||
    localPath.startsWith("..\\") ||
    localPath.startsWith("../") ||
    isAbsolute(localPath)
  ) {
    throw new Error(
      "Output must be a new ignored directory inside this repository.",
    );
  }
  execFileSync(
    "git",
    ["check-ignore", "--quiet", "--", `${localPath}/manifest.json`],
    { cwd: root },
  );
  await mkdir(dirname(directory), { recursive: true });
  // Non-recursive creation rejects existing experiments instead of replacing evidence.
  await mkdir(directory);
  const results = evaluateMemoryRelevance();
  const sourceFiles = [
    "packages/features/src/memory-recall.ts",
    "packages/features/src/memory-use.ts",
    "packages/features/src/conversation-context-plan.ts",
    "packages/contracts/src/retrieval.ts",
    "apps/server/src/scripts/memory-relevance-evaluation.ts",
    "apps/server/src/scripts/memory-relevance-evaluation-cases.ts",
  ];
  const sourceSha256 = Object.fromEntries(
    await Promise.all(
      sourceFiles.map(
        async (path) =>
          [
            path,
            createHash("sha256")
              .update(await readFile(resolve(root, path)))
              .digest("hex"),
          ] as const,
      ),
    ),
  );
  const manifest = {
    schemaVersion: 1,
    experiment: "memory_retrieval_use_2x2",
    evidenceKind: "deterministic_fixture_mechanism_test",
    semanticSource: "hand_labeled_bound_fixture_scores_not_embeddings",
    limitations: [
      "No model calls, embedding index, database candidate discovery or language-quality evaluation.",
      "Scores exercise routing; differences are not measured embedding quality or user-experience gains.",
      "R0 and R1 both use the current validity implementation; this is not an old-commit replay.",
    ],
    gitCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    dirty:
      execFileSync("git", ["status", "--porcelain"], {
        cwd: root,
        encoding: "utf8",
      }).trim().length > 0,
    generatedAtUtc: new Date().toISOString(),
    clockUtc: MEMORY_EVALUATION_NOW,
    sourceSha256,
    corpusSha256: createHash("sha256")
      .update(JSON.stringify(MEMORY_RELEVANCE_CASES))
      .digest("hex"),
    config: { minimumScore: 0.42, maxEvidence: 3 },
    arms: MEMORY_RELEVANCE_ARMS,
    cases: MEMORY_RELEVANCE_CASES,
  };
  const rows = MEMORY_RELEVANCE_ARMS.map((arm) => {
    const selected = results.filter((result) => result.arm === arm.id);
    const count = (key: keyof (typeof results)[number]["checks"]) =>
      selected.reduce((sum, result) => sum + result.checks[key].length, 0);
    return `| ${arm.id} | ${count("missedRelevantMemories")} | ${count("missedMentions")} | ${count("unexpectedMentions")} | ${count("forbiddenRecall")} | ${count("forbiddenUse")} |`;
  });
  const report = [
    "# Memory retrieval × use mechanism experiment",
    "",
    "Deterministic synthetic fixtures with hand-labeled semantic scores. No real embedding or model-quality result is implied.",
    "",
    "| Arm | Recall misses | Mention misses | Unexpected mentions | Forbidden recall | Forbidden use |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    "Inspect results.json for selected source IDs, relevance bindings, scores and omission reasons. Misses are diagnostic outcomes; forbidden recall/use and unexpected mentions fail the command.",
    "",
  ].join("\n");
  await writeFile(
    resolve(directory, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx" },
  );
  await writeFile(
    resolve(directory, "results.json"),
    JSON.stringify(results, null, 2) + "\n",
    { flag: "wx" },
  );
  await writeFile(resolve(directory, "comparison.md"), report, { flag: "wx" });
  return { directory, results };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const { values } = parseArgs({
      options: { output: { type: "string" } },
      strict: true,
    });
    if (!values.output)
      throw new Error("Use --output tmp/memory-relevance-NEW");
    const { directory, results } = await runMemoryRelevanceEvaluation(
      values.output,
    );
    const violations = results.filter(
      ({ checks }) =>
        checks.forbiddenRecall.length +
          checks.forbiddenUse.length +
          checks.unexpectedMentions.length >
        0,
    );
    console.log(
      `Completed ${results.length} mechanism probes; ${violations.length} constraint violations. Evidence: ${directory}`,
    );
    if (violations.length) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
