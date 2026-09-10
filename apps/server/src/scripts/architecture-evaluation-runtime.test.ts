import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readConfig } from "../config.js";
import { transformArchitecturePrompt } from "./architecture-prompt-ablation.js";
import type { PromptAssemblyTrace } from "@personasim/features";
import {
  ARCHITECTURE_PROBES,
  architectureModelInput,
} from "./architecture-evaluation-cases.js";
import {
  ARCHITECTURE_SESSION,
  architectureConfig,
  architectureFixtureFetch,
  architectureInstant,
  architectureSimplePrompt,
  createArchitectureRuntime,
  runArchitectureFullTurn,
} from "./architecture-evaluation-runtime.js";

const directories: string[] = [];
const directory = () => {
  const result = mkdtempSync(join(tmpdir(), "architecture-runtime-"));
  directories.push(result);
  return result;
};
afterEach(() =>
  directories
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);

function config(path: string) {
  const base = readConfig();
  return architectureConfig(
    base,
    {
      ...base.llm,
      provider: "openai-compatible",
      profileName: "offline-architecture-test",
      apiKey: "offline-test-key",
      baseUrl: "https://example.invalid",
      model: "offline-test-model",
      maxRetries: 0,
    },
    path,
  );
}

describe("architecture evaluation runtime isolation", () => {
  it("keeps private case expectations out of simple prompts and preserves distinct cards", () => {
    const probe = ARCHITECTURE_PROBES.find((item) => item.id === "P05")!;
    const publicInput = architectureModelInput(probe);
    const first = architectureSimplePrompt({
      caseId: "social-outward",
      history: publicInput.history,
      userText: publicInput.userText,
      nowUtc: architectureInstant(),
    });
    const second = architectureSimplePrompt({
      caseId: "social-private",
      history: publicInput.history,
      userText: publicInput.userText,
      nowUtc: architectureInstant(),
    });
    expect(first.prompt).not.toBe(second.prompt);
    expect(first.prompt).not.toContain(probe.title);
    expect(first.prompt).not.toContain(probe.category);
    expect(first.prompt).not.toContain("successCriteria");
    expect(first.system).toBe(second.system);
  });

  it("uses exactly the bounded recent prefix, including an empty window", () => {
    const history = [
      { role: "user" as const, content: "old" },
      { role: "assistant" as const, content: "new" },
    ];
    for (const limit of [0, 1, 2]) {
      const prompt = architectureSimplePrompt({
        caseId: "social-outward",
        history,
        userText: "current",
        nowUtc: architectureInstant(),
        recentLimit: limit,
      });
      const payload = JSON.parse(prompt.prompt) as {
        recentMessages: unknown[];
      };
      expect(payload.recentMessages).toHaveLength(limit);
    }
    expect(() =>
      architectureSimplePrompt({
        caseId: "social-outward",
        history,
        userText: "current",
        nowUtc: architectureInstant(),
        recentLimit: -1,
      }),
    ).toThrow();
  });

  it("seeds only grounded memory and keeps older prefix out of the active session", async () => {
    const path = directory();
    const probe = ARCHITECTURE_PROBES.find((item) => item.id === "P08")!;
    let dispatches = 0;
    const runtime = await createArchitectureRuntime({
      directory: path,
      caseId: "social-outward",
      config: config(path),
      history: probe.history,
      recentLimit: probe.recentHistoryLimit!,
      transport: async (...args) => {
        dispatches += 1;
        return architectureFixtureFetch(...args);
      },
    });
    try {
      expect(dispatches).toBe(0);
      const current =
        runtime.store.listMessagesForContext(ARCHITECTURE_SESSION);
      expect(current.map((item) => item.content)).toEqual(
        probe.history
          .slice(-probe.recentHistoryLimit!)
          .map((item) => item.content),
      );
      expect(runtime.seeding.length).toBe(
        probe.history.filter((item) => item.role === "user").length,
      );
      const memoryCount = runtime.store.database
        .prepare("SELECT count(*) AS count FROM memories")
        .get() as { count: number };
      expect(memoryCount.count).toBeGreaterThan(0);
      const invalid = runtime.store.database
        .prepare(
          "SELECT count(*) AS count FROM memory_evidence e LEFT JOIN messages m ON m.id = e.source_id WHERE e.source_type = 'message' AND m.id IS NULL",
        )
        .get() as { count: number };
      expect(invalid.count).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it("preserves the public state override through the full prompt", async () => {
    const path = directory();
    const probe = ARCHITECTURE_PROBES.find((item) => item.id === "P13")!;
    const runtime = await createArchitectureRuntime({
      directory: path,
      caseId: "social-outward",
      config: config(path),
      history: probe.history,
      stateOverride: probe.stateOverride!,
      transport: architectureFixtureFetch,
    });
    try {
      const before = runtime.store.getRuntimeState(runtime.spec.id)!;
      for (const [key, value] of Object.entries(probe.stateOverride!))
        expect(before[key as keyof typeof before]).toBe(value);
      const result = await runArchitectureFullTurn(
        runtime,
        probe.userText,
        "state-test",
      );
      expect(result.statusCode).toBe(201);
      const call = result.events.find(
        (event) => event.stage === "started" && event.purpose === "chat_turn",
      );
      expect(call?.stage).toBe("started");
      if (call?.stage !== "started") throw new Error("Missing full prompt");
      expect(call.prompt).toContain('"energy":0.12');
      expect(call.prompt).toContain('"stress":0.82');
    } finally {
      await runtime.close();
    }
  });

  it.each([
    ["P08", "桥灯-6837"],
    ["P09", "柳桥站西口"],
  ] as const)(
    "distinguishes stored versus delivered %s memory in the diagnostic",
    async (probeId, expected) => {
      const path = directory();
      const probe = ARCHITECTURE_PROBES.find((item) => item.id === probeId)!;
      const runtime = await createArchitectureRuntime({
        directory: path,
        caseId: "social-outward",
        config: config(path),
        history: probe.history,
        recentLimit: probe.recentHistoryLimit!,
        transport: architectureFixtureFetch,
      });
      try {
        const result = await runArchitectureFullTurn(
          runtime,
          probe.userText,
          `memory-${probeId}`,
        );
        expect(result.statusCode).toBe(201);
        const call = result.events.find(
          (event) => event.stage === "started" && event.purpose === "chat_turn",
        );
        if (call?.stage !== "started") throw new Error("Missing full prompt");
        const stored = runtime.store.database
          .prepare("SELECT content FROM memories")
          .all() as Array<{ content: string }>;
        expect(stored.some((item) => item.content.includes(expected))).toBe(
          true,
        );
        if (probeId === "P08") {
          expect(call.prompt).toContain(expected);
          expect(call.prompt).toContain("architecture-history-");
        }
        const removed = transformArchitecturePrompt(
          {
            system: call.system,
            prompt: call.prompt,
            segmentTrace: result.metadata[
              "promptSegmentTrace"
            ] as PromptAssemblyTrace,
          },
          "no_memory_readout",
        );
        expect(removed.prompt).not.toContain(expected);
        expect(removed.proof.nonTargetEqual).toBe(true);
        const trace = result.metadata[
          "promptSegmentTrace"
        ] as PromptAssemblyTrace;
        expect(
          removed.proof.removedLabels.includes("RETRIEVED_EVIDENCE_JSON"),
        ).toBe(
          trace.segments.some(
            (segment) =>
              segment.id === "13_retrieved_evidence" && segment.included,
          ),
        );
      } finally {
        await runtime.close();
      }
    },
  );

  it("captures the diagnostic practice from its original source without a model", async () => {
    const path = directory();
    const probe = ARCHITECTURE_PROBES.find((item) => item.id === "P16")!;
    const runtime = await createArchitectureRuntime({
      directory: path,
      caseId: "social-outward",
      config: config(path),
      history: probe.history,
      recentLimit: probe.recentHistoryLimit!,
      transport: architectureFixtureFetch,
    });
    try {
      expect(runtime.events).toEqual([]);
      expect(JSON.stringify(runtime.seeding)).toContain(
        "acceptedAdaptationIds",
      );
      const result = await runArchitectureFullTurn(
        runtime,
        probe.userText,
        "practice-test",
      );
      const call = result.events.find(
        (event) => event.stage === "started" && event.purpose === "chat_turn",
      );
      if (call?.stage !== "started") throw new Error("Missing full prompt");
      expect(call.system).toContain('"practice":"plain_expression"');
    } finally {
      await runtime.close();
    }
  });

  it("closes the isolated database if fixture initialization fails", async () => {
    const path = directory();
    const probe = ARCHITECTURE_PROBES.find((item) => item.id === "P15")!;
    await expect(
      createArchitectureRuntime({
        directory: path,
        caseId: "social-outward",
        config: config(path),
        history: probe.history,
        recentLimit: probe.recentHistoryLimit!,
        autobiographySeed: {
          ...probe.autobiographySeed!,
          entries: [
            { ...probe.autobiographySeed!.entries[0]!, sourceHistoryIndex: 99 },
          ],
        },
        transport: architectureFixtureFetch,
      }),
    ).rejects.toThrow("source missing");
    expect(() => rmSync(path, { recursive: true, force: true })).not.toThrow();
  });

  it("persists the autobiography fixture with valid source dependencies and an actual readout", async () => {
    const path = directory();
    const probe = ARCHITECTURE_PROBES.find((item) => item.id === "P15")!;
    const runtime = await createArchitectureRuntime({
      directory: path,
      caseId: "social-outward",
      config: config(path),
      history: probe.history,
      recentLimit: probe.recentHistoryLimit!,
      autobiographySeed: probe.autobiographySeed!,
      nowUtc: architectureInstant(probe.simulatedDay),
      transport: architectureFixtureFetch,
    });
    try {
      const snapshot = runtime.app.personasim.autobiographies.latest(
        runtime.spec.id,
        runtime.clock.nowUtc(),
      );
      expect(snapshot?.entries.length).toBeGreaterThan(0);
      expect(runtime.store.database.pragma("foreign_key_check")).toEqual([]);
      const result = await runArchitectureFullTurn(
        runtime,
        probe.userText,
        "autobio-test",
      );
      expect(result.statusCode).toBe(201);
      const call = result.events.find(
        (event) => event.stage === "started" && event.purpose === "chat_turn",
      );
      expect(call?.stage).toBe("started");
      if (call?.stage !== "started") throw new Error("Missing full prompt");
      expect(call.prompt).toContain("AUTOBIOGRAPHY_JSON");
    } finally {
      await runtime.close();
    }
  });
});
