import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildOriginalDraft } from "../domain/defaults.js";
import { CHARACTER_COMPILATION_POLICY_VERSION } from "../services/character-compiler.js";
import {
  ARCHITECTURE_PERSONA_CASES,
  buildArchitecturePersonaFixtureCharacter,
  buildArchitecturePersonaInput,
} from "./architecture-persona-cases.js";
import {
  architecturePersonaFixtureCard,
  observeArchitecturePersonaCard,
  renderArchitecturePersonaBlindReview,
  runArchitecturePersonaCandidate,
  runArchitecturePersonaExperiment,
} from "./architecture-persona-experiment.js";
import { characterGenerationComparisonConfig } from "./character-generation-comparison.js";
import { CONTINUITY_WORKSPACE_ROOT } from "./continuity-run-identity.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function workspaceDirectory() {
  const parent = join(CONTINUITY_WORKSPACE_ROOT, "tmp");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "architecture-persona-test-"));
  directories.push(directory);
  return directory;
}
const offlineLlm = {
  provider: "openai-compatible" as const,
  apiKey: "persona-test-secret-key",
  model: "offline-wire-persona",
  baseUrl: "https://fixture.invalid/v1",
  timeoutMs: 1000,
  maxRetries: 0,
  maxOutputTokens: 64_000,
  capabilities: {
    structuredOutputMode: "json_object" as const,
    supportsThinkingControl: false,
    supportsStreaming: false,
    maxOutputTokens: 64_000,
  },
};
function wireResponse(content: unknown) {
  return Response.json({
    model: "offline-wire-persona",
    choices: [
      {
        message: {
          role: "assistant",
          content: JSON.stringify(content),
          reasoning_content: "HIDDEN_TEST_REASONING",
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
  });
}

describe("extreme architecture personas", () => {
  it("uses three opposite adult pairs with identical biographical facts and explicit exceptions", () => {
    expect(ARCHITECTURE_PERSONA_CASES).toHaveLength(6);
    const pairs = new Set(
      ARCHITECTURE_PERSONA_CASES.map((item) => item.pairId),
    );
    expect(pairs.size).toBe(3);
    for (const pair of pairs) {
      const members = ARCHITECTURE_PERSONA_CASES.filter(
        (item) => item.pairId === pair,
      );
      expect(members).toHaveLength(2);
      const [a, b] = members.map((item) =>
        buildArchitecturePersonaInput(item.id),
      );
      for (const field of [
        "name",
        "worldSetting",
        "workOrRole",
        "mainGoal",
        "initialRelationship",
        "timezone",
        "storyEra",
      ] as const)
        expect(a![field]).toEqual(b![field]);
      expect(a!.characterBrief!.split("\n").slice(0, 6)).toEqual(
        b!.characterBrief!.split("\n").slice(0, 6),
      );
      expect(a!.coreTraits).not.toEqual(b!.coreTraits);
      expect(a!.dialogueStyle).not.toBe(b!.dialogueStyle);
      expect(members.every((item) => item.exception.length > 30)).toBe(true);
    }
  });

  it("builds deterministic author fixtures preserving extreme style and task exceptions", () => {
    for (const item of ARCHITECTURE_PERSONA_CASES) {
      const a = buildArchitecturePersonaFixtureCharacter(item.id);
      expect(a).toEqual(buildArchitecturePersonaFixtureCharacter(item.id));
      expect(
        a.persona.traits.every(
          (trait) =>
            trait.strength === 0.95 &&
            trait.exceptions.includes(item.exception),
        ),
      ).toBe(true);
    }
    expect(
      buildArchitecturePersonaFixtureCharacter("social-outward").dialogue
        .verbosity,
    ).toBe(0.9);
    expect(
      buildArchitecturePersonaFixtureCharacter("social-private").dialogue
        .verbosity,
    ).toBe(0.1);
  });

  it("does not mistake lexical anchors for a semantic quality score", () => {
    const card = architecturePersonaFixtureCard("social-private");
    card.facts = [
      "没有任何人在上海工作，苏禾不是插画负责人，已经发行《河岸》。",
    ];
    const observations = observeArchitecturePersonaCard("social-private", card);
    expect(observations.kind).toBe("lexical_observation_not_semantic_score");
    expect(observations.factAnchors.city).toBe(true);
    expect(observations.semanticReview).toBe("pending_blinded_review");
    expect(observations).not.toHaveProperty("score");
  });

  it("runs all 24 candidates offline, preserves paired inputs, and blind labels contain no arm names", async () => {
    const output = join(await workspaceDirectory(), "run");
    const results = await runArchitecturePersonaExperiment({
      output,
      fixture: true,
      transport: () => Promise.reject(new Error("Offline means no network")),
    });
    expect(results).toHaveLength(24);
    expect(
      results.every(
        (row) =>
          row.success && row.physicalRequests === 0 && row.card && row.rawCard,
      ),
    ).toBe(true);
    for (const item of ARCHITECTURE_PERSONA_CASES) {
      const rows = results.filter((row) => row.caseId === item.id);
      expect(rows).toHaveLength(4);
      expect(new Set(rows.map((row) => row.inputSha256)).size).toBe(1);
    }
    const blind = renderArchitecturePersonaBlindReview(results);
    expect(Object.keys(blind.key)).toHaveLength(24);
    expect(blind.markdown).not.toContain("production_compiler");
    expect(blind.markdown).not.toContain("simple_card");
    expect(blind.markdown).not.toContain("architecture-persona-social");
    await expect(
      runArchitecturePersonaExperiment({ output, fixture: true }),
    ).rejects.toThrow("Never overwrite");
    const manifest = JSON.parse(
      await readFile(join(output, "manifest.json"), "utf8"),
    ) as { expectedCandidates: number };
    expect(manifest.expectedCandidates).toBe(24);
  }, 60_000);

  it("meters simple-card retries through the production adapter with equal output opportunity and no author refill", async () => {
    const parent = await workspaceDirectory();
    const directory = join(parent, "simple");
    const card = architecturePersonaFixtureCard("social-private");
    card.identity.name = "错误名字";
    let calls = 0;
    const outputCaps: number[] = [];
    const result = await runArchitecturePersonaCandidate({
      directory,
      config: characterGenerationComparisonConfig(offlineLlm, directory),
      caseId: "social-private",
      arm: "simple_card",
      repeat: 1,
      ledgerPath: join(parent, "attempts.jsonl"),
      budget: { maxPhysicalRequests: 2, maxReservedTokenUnits: 1_000_000 },
      transport: (_url, init) => {
        const request = JSON.parse(init!.body as string) as {
          max_tokens: number;
        };
        outputCaps.push(request.max_tokens);
        calls++;
        return Promise.resolve(
          wireResponse(calls === 1 ? { invalid: true } : card),
        );
      },
    });
    expect(outputCaps).toEqual([32_000, 32_000]);
    expect(result.success, result.error ?? "unexpected failure").toBe(true);
    expect(result.physicalRequests).toBe(2);
    expect(result.retries).toBe(1);
    expect(result.inputTokens).toBe(200);
    expect(result.outputTokens).toBe(80);
    expect(result.card?.identity.name).toBe("错误名字");
    expect(result.observations?.identity.name).toBe(false);
    const evidence = await readFile(join(parent, "attempts.jsonl"), "utf8");
    expect(evidence).not.toContain(offlineLlm.apiKey);
    expect(evidence).not.toContain("HIDDEN_TEST_REASONING");
    expect(evidence).toContain("invalid");
  }, 30_000);

  it("preserves the production raw proposal separately from server author-field recovery", async () => {
    const parent = await workspaceDirectory();
    const directory = join(parent, "production");
    const draft = buildOriginalDraft(
      buildArchitecturePersonaInput("social-private"),
      CHARACTER_COMPILATION_POLICY_VERSION,
    );
    draft.identity.name = "错误名字";
    const outputCaps: number[] = [];
    const result = await runArchitecturePersonaCandidate({
      directory,
      config: characterGenerationComparisonConfig(offlineLlm, directory),
      caseId: "social-private",
      arm: "production_compiler",
      repeat: 1,
      ledgerPath: join(parent, "attempts.jsonl"),
      budget: { maxPhysicalRequests: 2, maxReservedTokenUnits: 1_000_000 },
      transport: (_url, init) => {
        outputCaps.push(
          (JSON.parse(init!.body as string) as { max_tokens: number })
            .max_tokens,
        );
        return Promise.resolve(
          wireResponse({
            draft,
            reasonCode: "offline_comparison",
            reasonSummary: "离线受控提案",
          }),
        );
      },
    });
    expect(outputCaps).toEqual([32_000]);
    expect(result.success, result.error ?? "unexpected failure").toBe(true);
    expect(result.generatedStatus).toBe(201);
    expect(result.publishedStatus).toBe(200);
    expect(result.rawCard?.identity.name).toBe("错误名字");
    expect(result.card?.identity.name).toBe("沈知");
    expect(result.rawObservations?.identity.name).toBe(false);
    expect(result.observations?.identity.name).toBe(true);
  }, 30_000);

  it("retains all candidates after budget exhaustion rather than silently sampling replacements", async () => {
    const output = join(await workspaceDirectory(), "limited");
    let dispatches = 0;
    const results = await runArchitecturePersonaExperiment({
      output,
      fixture: true,
      caseIds: ["social-private"],
      repeats: 2,
      llm: offlineLlm,
      budget: { maxPhysicalRequests: 1, maxReservedTokenUnits: 1_000_000 },
      transport: () => {
        dispatches++;
        return Promise.resolve(wireResponse({ invalid: true }));
      },
    });
    expect(dispatches).toBe(1);
    expect(results).toHaveLength(4);
    expect(results.every((row) => !row.success && row.error)).toBe(true);
    expect(results.reduce((sum, row) => sum + row.physicalRequests, 0)).toBe(1);
    const blind = renderArchitecturePersonaBlindReview(results);
    expect(Object.keys(blind.key)).toHaveLength(4);
    expect(blind.markdown).toContain('"status": "failed"');
  }, 30_000);

  it("blocks accidental fixture adapter fallthrough before any paid transport", async () => {
    const output = join(await workspaceDirectory(), "blocked");
    await expect(
      runArchitecturePersonaExperiment({
        output,
        fixture: true,
        llm: offlineLlm,
      }),
    ).rejects.toThrow("explicit offline transport");
  });
});
