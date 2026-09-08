import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as appModule from "../app.js";
import { openDatabase } from "../db/connection.js";
import { buildOriginalDraft } from "../domain/defaults.js";
import { CHARACTER_COMPILATION_POLICY_VERSION } from "../services/character-compiler.js";
import {
  buildCharacterGenerationComparisonInput,
  characterGenerationComparisonConfig,
  runCharacterGenerationCandidate,
  runCharacterGenerationComparison,
} from "./character-generation-comparison.js";
import { CONTINUITY_WORKSPACE_ROOT } from "./continuity-run-identity.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function workspaceDirectory() {
  const parent = join(CONTINUITY_WORKSPACE_ROOT, "tmp");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(
    join(parent, "character-generation-comparison-test-"),
  );
  directories.push(directory);
  return directory;
}

describe("independent character generation comparison", () => {
  it("rejects requests without a compile purpose before reserving physical budget", async () => {
    const parent = await workspaceDirectory();
    const directory = join(parent, "wrong-purpose");
    const ledgerPath = join(parent, "attempts.jsonl");
    const originalBuildApp = appModule.buildApp;
    let guardChecked = false;
    let dispatches = 0;
    vi.spyOn(appModule, "buildApp").mockImplementation(async (options) => {
      if (!options?.llmObservation?.fetch)
        throw new Error("Missing observed fetch");
      await expect(
        options.llmObservation.fetch(
          "http://provider.invalid/v1/chat/completions",
          {
            method: "POST",
            body: JSON.stringify({ max_tokens: 32_000 }),
          },
        ),
      ).rejects.toThrow("Unexpected model purpose: unknown");
      guardChecked = true;
      return originalBuildApp(options);
    });
    const result = await runCharacterGenerationCandidate({
      directory,
      config: characterGenerationComparisonConfig(
        {
          provider: "fixture",
          baseUrl: "http://127.0.0.1:9",
          model: "offline-fixture",
          timeoutMs: 1_000,
          maxRetries: 0,
        },
        directory,
      ),
      profile: "wrong-purpose-fixture",
      personaId: "warm-observant",
      ledgerPath,
      budget: { maxPhysicalRequests: 1, maxReservedTokenUnits: 1_000_000 },
      transport: () => {
        dispatches++;
        return Promise.reject(new Error("Must not dispatch"));
      },
    });
    expect(guardChecked).toBe(true);
    expect(result.success).toBe(true);
    expect(result.physicalRequests).toBe(0);
    expect(dispatches).toBe(0);
    await expect(readFile(ledgerPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("runs identical persona inputs through public generation and publication in separate databases", async () => {
    const output = join(await workspaceDirectory(), "comparison");
    const results = await runCharacterGenerationComparison({
      output,
      fixture: true,
      profiles: ["deepseek", "qwen"],
    });
    expect(results).toHaveLength(6);
    expect(results.every((row) => row.success)).toBe(true);
    expect(new Set(results.map((row) => row.published?.id)).size).toBe(6);
    for (const result of results) {
      expect(result.generatedStatus).toBe(201);
      expect(result.publishedStatus).toBe(200);
      expect(result.logicalCalls).toBe(1);
      expect(result.physicalRequests).toBe(0);
      expect(result.inputTokens).toBeNull();
      expect(result.authorPreservation).toMatchObject({
        nameMatches: true,
        workMatches: true,
        timezoneMatches: true,
        dialogueAuthorGuidanceMatches: true,
        explicitTraitNamesPresent: true,
        sourceBriefPreserved: true,
        semanticReview: "pending_manual_review",
      });
      expect(result.inputSha256).toBe(
        results.find(
          (row) =>
            row.profile !== result.profile &&
            row.personaId === result.personaId,
        )?.inputSha256,
      );
      const candidateDirectory = join(output, result.id);
      const http = (
        await readFile(join(candidateDirectory, "http.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as { method: string; status: number; url: string },
        );
      expect(http.map((entry) => entry.status)).toEqual([201, 200, 200]);
      expect(http[0]?.url).toBe("/api/characters/generate");
      expect(http[1]?.url).toContain("/publish");
      const database = openDatabase(
        join(candidateDirectory, "character.sqlite"),
      );
      try {
        expect(
          database.prepare("SELECT COUNT(*) AS count FROM characters").get(),
        ).toEqual({ count: 1 });
        expect(
          database.prepare("SELECT COUNT(*) AS count FROM sessions").get(),
        ).toEqual({ count: 0 });
      } finally {
        database.close();
      }
    }
    const manifest = await readFile(join(output, "manifest.json"), "utf8");
    expect(manifest).toContain("not_used_or_modified");
    await expect(
      runCharacterGenerationComparison({
        output,
        fixture: true,
        profiles: ["deepseek"],
      }),
    ).rejects.toThrow();
  }, 30_000);

  it("meters the real provider adapter while retaining visible output and removing hidden reasoning", async () => {
    const parent = await workspaceDirectory();
    const directory = join(parent, "candidate");
    const authorInput =
      buildCharacterGenerationComparisonInput("reserved-direct");
    const proposal = {
      draft: buildOriginalDraft(
        authorInput,
        CHARACTER_COMPILATION_POLICY_VERSION,
      ),
      reasonCode: "fixture_character_compilation",
      reasonSummary: "固定角色编译测试。",
    };
    let dispatches = 0;
    const result = await runCharacterGenerationCandidate({
      directory,
      config: characterGenerationComparisonConfig(
        {
          provider: "openai-compatible",
          baseUrl: "http://provider.invalid/v1",
          model: "transport-fixture",
          apiKey: "test-only-generation-secret",
          timeoutMs: 1_000,
          maxRetries: 0,
        },
        directory,
      ),
      profile: "offline-transport",
      personaId: "reserved-direct",
      ledgerPath: join(parent, "attempts.jsonl"),
      budget: { maxPhysicalRequests: 2, maxReservedTokenUnits: 1_000_000 },
      transport: (_url, init) => {
        dispatches++;
        if (typeof init?.body !== "string")
          throw new Error("Expected JSON body");
        const request = JSON.parse(init.body) as { max_tokens: number };
        expect(request.max_tokens).toBe(32_000);
        return Promise.resolve(
          Response.json({
            model: "transport-fixture",
            choices: [
              {
                message: {
                  role: "assistant",
                  content: JSON.stringify(proposal),
                  reasoning_content: "private-reasoning-must-not-be-persisted",
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 321, completion_tokens: 654 },
          }),
        );
      },
    });
    expect(result.success).toBe(true);
    expect(dispatches).toBe(1);
    expect(result).toMatchObject({
      physicalRequests: 1,
      retries: 0,
      logicalCalls: 1,
      inputTokens: 321,
      outputTokens: 654,
      usageComplete: true,
    });
    expect(result.rawParsedProposal).not.toBeNull();
    expect(result.rawVisibleResponses).toHaveLength(1);
    const artifacts = (
      await Promise.all(
        [
          "attempts.jsonl",
          "candidate/model-io.jsonl",
          "candidate/result.json",
        ].map((file) => readFile(join(parent, file), "utf8")),
      )
    ).join("\n");
    expect(artifacts).not.toContain("private-reasoning-must-not-be-persisted");
    expect(artifacts).not.toContain("test-only-generation-secret");
    expect(artifacts).toContain('"maxRetries":1');
  }, 20_000);

  it("blocks further physical requests after the shared budget and preserves failure evidence", async () => {
    const parent = await workspaceDirectory();
    const directory = join(parent, "failed-candidate");
    let dispatches = 0;
    const result = await runCharacterGenerationCandidate({
      directory,
      config: characterGenerationComparisonConfig(
        {
          provider: "openai-compatible",
          baseUrl: "http://provider.invalid/v1",
          model: "failing-transport-fixture",
          apiKey: "test-key",
          timeoutMs: 1_000,
          maxRetries: 0,
        },
        directory,
      ),
      profile: "failed-transport",
      personaId: "warm-observant",
      ledgerPath: join(parent, "attempts.jsonl"),
      budget: { maxPhysicalRequests: 1, maxReservedTokenUnits: 1_000_000 },
      transport: () => {
        dispatches++;
        return Promise.resolve(
          Response.json(
            { error: { message: "temporary unavailable" } },
            { status: 503 },
          ),
        );
      },
    });
    expect(result.success).toBe(false);
    expect(result.publishedStatus).toBeNull();
    expect(result.published).toBeNull();
    expect(result.physicalRequests).toBe(1);
    expect(result.inputTokens).toBeNull();
    expect(dispatches).toBe(1);
    const ledger = await readFile(join(parent, "attempts.jsonl"), "utf8");
    expect(ledger).toContain('"stage":"blocked"');
    expect(ledger).toContain('"status":503');
    expect(
      JSON.parse(await readFile(join(directory, "result.json"), "utf8")),
    ).toMatchObject({ success: false, physicalRequests: 1 });
  }, 20_000);
});
