import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  architecturePersonaFixtureCard,
  runArchitecturePersonaExperiment,
  type ArchitecturePersonaResult,
} from "./architecture-persona-experiment.js";
import {
  architectureTransferProbes,
  architectureTransferPromptProof,
  readArchitectureTransferSource,
  renderArchitectureTransferBlindReview,
  runArchitecturePersonaTransfer,
} from "./architecture-persona-transfer.js";
import { CONTINUITY_WORKSPACE_ROOT } from "./continuity-run-identity.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function workspaceDirectory() {
  const parent = join(CONTINUITY_WORKSPACE_ROOT, "tmp");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "architecture-transfer-test-"));
  directories.push(directory);
  return directory;
}
async function sourceRun(parent: string) {
  const source = join(parent, "source");
  const rows = await runArchitecturePersonaExperiment({
    output: source,
    fixture: true,
  });
  return { source, rows };
}

describe("generated persona transfer through a common runtime", () => {
  it("routes all six poles to their registered pair-specific probes", () => {
    expect(
      architectureTransferProbes("social-outward").map((probe) => probe.id),
    ).toEqual(["P01", "P02"]);
    expect(
      architectureTransferProbes("social-private").map((probe) => probe.id),
    ).toEqual(["P01", "P02"]);
    expect(
      architectureTransferProbes("planning-rigorous").map((probe) => probe.id),
    ).toEqual(["PT01", "PT02"]);
    expect(
      architectureTransferProbes("planning-experimental").map(
        (probe) => probe.id,
      ),
    ).toEqual(["PT01", "PT02"]);
    expect(
      architectureTransferProbes("conflict-blunt").map((probe) => probe.id),
    ).toEqual(["P03", "P04"]);
    expect(
      architectureTransferProbes("conflict-diplomatic").map(
        (probe) => probe.id,
      ),
    ).toEqual(["P03", "P04"]);
  });

  it("preserves each generated card and changes no non-card prompt content", () => {
    const first = architecturePersonaFixtureCard("planning-experimental");
    const second = structuredClone(first);
    second.voice = "这是不同生成产物的原始语言指导";
    second.facts = ["这份生成产物漏掉了其余事实，运行时不可回填。"];
    const probe = architectureTransferProbes("planning-experimental")[0]!;
    const a = architectureTransferPromptProof({
      caseId: "planning-experimental",
      card: first,
      probe,
    });
    const b = architectureTransferPromptProof({
      caseId: "planning-experimental",
      card: second,
      probe,
    });
    expect(a.cardSha256).not.toBe(b.cardSha256);
    expect(a.nonCardPromptSha256).toBe(b.nonCardPromptSha256);
    const parsed = JSON.parse(b.prompt) as Record<string, unknown>;
    expect(parsed["characterCard"]).toEqual(second);
    expect(Object.keys(parsed).sort()).toEqual([
      "characterCard",
      "currentTimeUtc",
      "recentMessages",
      "userMessage",
    ]);
    expect(parsed).not.toHaveProperty("privateCriteria");
    expect(parsed).not.toHaveProperty("title");
    expect(parsed).not.toHaveProperty("sourceId");
  });

  it("requires all registered generation cells and detects card/result tampering", async () => {
    const { source, rows } = await sourceRun(await workspaceDirectory());
    expect(readArchitectureTransferSource(source).rows).toHaveLength(24);
    await writeFile(
      join(source, "results.json"),
      JSON.stringify(rows.slice(0, 23)),
    );
    expect(() => readArchitectureTransferSource(source)).toThrow("incomplete");
    await writeFile(join(source, "results.json"), JSON.stringify(rows));
    await writeFile(
      join(source, rows[0]!.id, "normalized-card.json"),
      JSON.stringify({ altered: true }),
    );
    expect(() => readArchitectureTransferSource(source)).toThrow(
      "card mismatch",
    );
  }, 30_000);

  it("executes all 48 fixture responses with unchanged cards, equal prompts, provenance, and anonymous review labels", async () => {
    const parent = await workspaceDirectory();
    const { source } = await sourceRun(parent);
    const output = join(parent, "transfer");
    const results = await runArchitecturePersonaTransfer({
      source,
      output,
      fixture: true,
      concurrency: 2,
    });
    expect(results).toHaveLength(48);
    expect(
      results.every(
        (row) =>
          row.success && row.physicalRequests === 1 && row.sourceCardSha256,
      ),
    ).toBe(true);
    expect(new Set(results.map((row) => row.sourceManifestSha256)).size).toBe(
      1,
    );
    const groups = new Map<string, Set<string | null>>();
    for (const row of results) {
      const id = `${row.caseId}_${row.probeId}`;
      if (!groups.has(id)) groups.set(id, new Set());
      groups.get(id)!.add(row.nonCardPromptSha256);
    }
    expect([...groups.values()].every((hashes) => hashes.size === 1)).toBe(
      true,
    );
    const blind = renderArchitectureTransferBlindReview(results);
    expect(Object.keys(blind.key)).toHaveLength(48);
    expect(blind.markdown).not.toContain("production_compiler");
    expect(blind.markdown).not.toContain("simple_card");
    const ledger = await readFile(join(output, "attempts.jsonl"), "utf8");
    expect(ledger).not.toContain("offline-fixture-only");
    const reservations = ledger
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            stage: string;
            request?: { max_tokens?: number };
          },
      )
      .filter((row) => row.stage === "reserved");
    expect(reservations).toHaveLength(48);
    expect(
      reservations.every((row) => row.request?.max_tokens === 32_000),
    ).toBe(true);
    await expect(
      runArchitecturePersonaTransfer({ source, output, fixture: true }),
    ).rejects.toThrow("Never overwrite");
  }, 60_000);

  it("propagates a failed source as two non-dispatched failures without replacement", async () => {
    const parent = await workspaceDirectory();
    const { source, rows } = await sourceRun(parent);
    const failed = rows[0]!;
    failed.success = false;
    failed.error = "injected_source_failure";
    failed.card = null;
    await writeFile(join(source, "results.json"), JSON.stringify(rows));
    await writeFile(
      join(source, failed.id, "result.json"),
      JSON.stringify(failed),
    );
    await writeFile(join(source, failed.id, "normalized-card.json"), "null");
    const results = await runArchitecturePersonaTransfer({
      source,
      output: join(parent, "transfer"),
      fixture: true,
    });
    expect(results).toHaveLength(48);
    const skipped = results.filter((row) => row.sourceId === failed.id);
    expect(skipped).toHaveLength(2);
    expect(
      skipped.every(
        (row) =>
          !row.success &&
          row.physicalRequests === 0 &&
          row.text === "" &&
          row.error?.includes("injected_source_failure"),
      ),
    ).toBe(true);
    expect(results.filter((row) => row.success)).toHaveLength(46);
  }, 60_000);

  it("retains the denominator when the shared budget prevents additional dispatch", async () => {
    const parent = await workspaceDirectory();
    const { source } = await sourceRun(parent);
    let dispatches = 0;
    const results = await runArchitecturePersonaTransfer({
      source,
      output: join(parent, "transfer"),
      fixture: true,
      budget: { maxPhysicalRequests: 1, maxReservedTokenUnits: 1_000_000 },
      transport: () => {
        dispatches++;
        return Promise.resolve(
          Response.json({
            choices: [
              {
                message: { role: "assistant", content: "{}" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          }),
        );
      },
    });
    expect(dispatches).toBe(1);
    expect(results).toHaveLength(48);
    expect(results.every((row) => !row.success)).toBe(true);
    expect(results.reduce((sum, row) => sum + row.physicalRequests, 0)).toBe(1);
  }, 60_000);

  it("refuses to label fixture generation cards as real transfer evidence", async () => {
    const parent = await workspaceDirectory();
    const { source } = await sourceRun(parent);
    vi.stubEnv("RUN_PAID_ARCHITECTURE_EVAL", "1");
    await expect(
      runArchitecturePersonaTransfer({
        source,
        output: join(parent, "blocked"),
      }),
    ).rejects.toThrow("real generated cards");
    const sourceRows = JSON.parse(
      await readFile(join(source, "results.json"), "utf8"),
    ) as ArchitecturePersonaResult[];
    expect(sourceRows).toHaveLength(24);
  }, 30_000);
});
