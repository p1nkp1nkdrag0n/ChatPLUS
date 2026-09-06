import {
  CharacterSpecSchema,
  type CharacterSpec,
  type PersonaRuntimeMode,
} from "@personasim/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import {
  PERSONA_RUNTIME_SERVICE_TOKEN,
  REPLY_REPAIR_SERVICE_TOKEN,
  TURN_DECISION_SERVICE_TOKEN,
} from "../composition/service-tokens.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";
import type { ChatTurnResult } from "./conversation-service.js";
import { validateMergeAndPersistMemories } from "./memory-service.js";

const NOW = "2026-09-06T04:00:00.000Z";
const PREFERENCE = "我谈工作烦恼时，先听我说，不急着建议。";
const TOPIC = "工作又遇到点烦恼。";

interface PromptPersona {
  revision: number;
  relationshipPractices: Array<{
    facet: string;
    practice: string;
    scope: { topic?: string };
  }>;
}

function promptPersona(system: string): PromptPersona | undefined {
  const serialized = /EFFECTIVE_PERSONA_JSON\n([^\n]+)/u.exec(system)?.[1];
  return serialized === undefined
    ? undefined
    : (JSON.parse(serialized) as PromptPersona);
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

describe("persona runtime through committed HTTP turns", () => {
  let app: PersonaSimApp;
  let spec: CharacterSpec;

  afterEach(async () => {
    await app?.close();
    vi.restoreAllMocks();
  });

  async function setup(mode: PersonaRuntimeMode = "enforced") {
    app = await buildApp({
      config: readConfig({
        nodeEnv: "test",
        databasePath: ":memory:",
        seedDemo: false,
        lifePlanningMode: "fuzzy",
        memoryRecallMode: "enforced",
        autobiographyMode: "off",
        companionContextMode: "enforced",
        personaRuntimeMode: mode,
        llm: {
          provider: "fixture",
          baseUrl: "https://example.invalid",
          model: "fixture",
          timeoutMs: 1_000,
          maxRetries: 0,
        },
      }),
      database: openDatabase(":memory:"),
      clock: new FakeClock(NOW),
      startScheduler: false,
      logger: false,
    });
    const generated = await app.inject({
      method: "POST",
      url: "/api/characters/generate",
      payload: {
        name: "林夏",
        worldSetting: "当代城市",
        workOrRole: "书店店员",
        coreTraits: ["愿意倾听"],
        initialRelationship: "邻居",
        dialogueStyle: "自然简洁",
        tier: "high_fidelity",
        timezone: "Asia/Shanghai",
      },
    });
    expect(generated.statusCode, generated.body).toBe(201);
    const draft = generated.json<{ character: CharacterSpec }>().character;
    const published = await app.inject({
      method: "POST",
      url: `/api/characters/${draft.id}/publish`,
      payload: { expectedVersion: draft.version },
    });
    expect(published.statusCode, published.body).toBe(200);
    spec = app.personasim.store.getCharacterSpec(draft.id)!;
  }

  async function newSession() {
    const created = await app.inject({
      method: "POST",
      url: `/api/agents/${spec.id}/sessions`,
      payload: {},
    });
    expect(created.statusCode, created.body).toBe(201);
    return created.json<{ session: { id: string } }>().session.id;
  }

  function send(sessionId: string, text: string, clientMessageId: string) {
    return app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: { agentId: spec.id, text, clientMessageId },
    });
  }

  async function learn() {
    const sessionId = await newSession();
    const response = await send(sessionId, PREFERENCE, "learn-practice");
    expect(response.statusCode, response.body).toBe(201);
    return response.json<ChatTurnResult>();
  }

  function runtime() {
    return app.personasim.kernel.registry.resolve(
      PERSONA_RUNTIME_SERVICE_TOKEN,
    );
  }

  function snapshot() {
    return runtime().snapshot({
      baseSpec: spec,
      nowUtc: NOW,
      topicText: TOPIC,
    });
  }

  function count(
    table: "memories" | "persona_observations" | "persona_adaptations",
  ) {
    return (
      app.personasim.store.database
        .prepare(`SELECT count(*) AS count FROM ${table} WHERE agent_id = ?`)
        .get(spec.id) as { count: number }
    ).count;
  }

  it.each(["off", "shadow", "enforced"] as const)(
    "applies %s only at its authorized boundary and learns after the current reply",
    async (mode) => {
      await setup(mode);
      const baseline = structuredClone(spec);
      const memoriesBefore = count("memories");
      const generate = vi.spyOn(app.personasim.llm, "generateObject");
      const first = await learn();
      const firstPrompt = generate.mock.calls.find(
        ([input]) => input.purpose === "chat_turn",
      )?.[0];
      expect(firstPrompt).toBeDefined();
      if (mode === "enforced") {
        expect(promptPersona(firstPrompt!.system)).toMatchObject({
          revision: 0,
          relationshipPractices: [],
        });
        expect(snapshot().revision).toBe(1);
        expect(count("memories")).toBe(memoriesBefore + 1);
      } else {
        expect(promptPersona(firstPrompt!.system)).toBeUndefined();
        expect(snapshot().revision).toBe(0);
        expect(count("memories")).toBe(memoriesBefore);
      }
      expect(count("persona_observations")).toBe(mode === "off" ? 0 : 1);
      expect(count("persona_adaptations")).toBe(mode === "enforced" ? 1 : 0);
      const diagnostic = first.assistantMessage.metadata["personaRuntime"];
      if (mode === "off") expect(diagnostic).toBeUndefined();
      else
        expect(diagnostic).toMatchObject({
          mode,
          revision: 0,
          adaptationIds: [],
        });

      generate.mockClear();
      const next = await send(await newSession(), TOPIC, "new-session");
      expect(next.statusCode, next.body).toBe(201);
      const nextPrompt = generate.mock.calls.find(
        ([input]) => input.purpose === "chat_turn",
      )?.[0];
      expect(nextPrompt).toBeDefined();
      if (mode === "enforced") {
        const effective = promptPersona(nextPrompt!.system)!;
        expect(effective.revision).toBe(1);
        expect(effective.relationshipPractices).toHaveLength(1);
        expect(effective.relationshipPractices).toMatchObject([
          {
            facet: "advice_timing",
            practice: "listen_first",
            scope: { topic: "工作烦恼" },
          },
        ]);
        expect(JSON.stringify(effective)).not.toContain(PREFERENCE);
      } else expect(promptPersona(nextPrompt!.system)).toBeUndefined();
      expect(app.personasim.store.getCharacterSpec(spec.id)).toEqual(baseline);
    },
  );

  it.each(["explicit_retraction", "source_correction"] as const)(
    "excludes the old practice and its recalled source after %s",
    async (reason) => {
      await setup();
      await learn();
      const before = snapshot();
      const adaptation = before.relationshipPractices[0]!;
      expect(adaptation).toBeDefined();
      if (reason === "explicit_retraction") {
        runtime().retract({
          agentId: spec.id,
          adaptationId: adaptation.id,
          expectedRevision: before.revision,
          nowUtc: NOW,
          reason: "user_withdrew_practice",
        });
      } else {
        const memoryId = adaptation.sources.find(
          (source) => source.sourceType === "memory",
        )!.sourceId;
        app.personasim.store.database
          .prepare("UPDATE memories SET status = 'superseded' WHERE id = ?")
          .run(memoryId);
      }
      const generate = vi.spyOn(app.personasim.llm, "generateObject");
      const next = await send(await newSession(), TOPIC, "after-withdrawal");
      expect(next.statusCode, next.body).toBe(201);
      const chat = generate.mock.calls.find(
        ([input]) => input.purpose === "chat_turn",
      )?.[0];
      expect(chat).toBeDefined();
      expect(promptPersona(chat!.system)?.relationshipPractices).toEqual([]);
      expect(`${chat!.system}\n${chat!.prompt}`).not.toContain(PREFERENCE);
      expect(snapshot().relationshipPractices).toEqual([]);
    },
  );

  it.each(["memory_source", "persona_revision", "base_version"] as const)(
    "rolls back a generated turn after %s changes and retries its client ID exactly once",
    async (change) => {
      await setup();
      await learn();
      const before = snapshot();
      const sessionId = await newSession();
      const messagesBefore =
        app.personasim.store.listMessagesForContext(sessionId);
      const observationsBefore = count("persona_observations");
      const adaptationsBefore = count("persona_adaptations");
      const entered = gate();
      const release = gate();
      const originalGenerate = app.personasim.llm.generateObject.bind(
        app.personasim.llm,
      );
      let held = false;
      const generate = vi
        .spyOn(app.personasim.llm, "generateObject")
        .mockImplementation(async (input) => {
          if (input.purpose === "chat_turn" && !held) {
            held = true;
            entered.resolve();
            await release.promise;
          }
          return originalGenerate(input);
        });
      const text = "我谈工作烦恼时，也请少追问。";
      const clientId = `fenced-${change}`;
      const pending = send(sessionId, text, clientId).then(
        (response) => response,
      );
      await entered.promise;
      try {
        const adaptation = before.relationshipPractices[0]!;
        if (change === "memory_source") {
          const memoryId = adaptation.sources.find(
            (source) => source.sourceType === "memory",
          )!.sourceId;
          app.personasim.store.database
            .prepare("UPDATE memories SET status = 'superseded' WHERE id = ?")
            .run(memoryId);
        } else if (change === "persona_revision") {
          runtime().retract({
            agentId: spec.id,
            adaptationId: adaptation.id,
            expectedRevision: before.revision,
            nowUtc: NOW,
            reason: "concurrent_practice_withdrawal",
          });
        } else {
          spec = CharacterSpecSchema.parse({
            ...spec,
            version: spec.version + 1,
            identity: { ...spec.identity, worldSetting: "隔壁街区的书店" },
          });
          app.personasim.store.transaction(() => {
            app.personasim.store.insertCharacterVersion(spec);
            app.personasim.store.updateCharacterHead(spec);
          });
        }
      } finally {
        release.resolve();
      }
      const rejected = await pending;
      expect(rejected.statusCode, rejected.body).toBe(409);
      expect(rejected.json()).toMatchObject({
        error: { code: "stale_effective_persona" },
      });
      expect(app.personasim.store.listMessagesForContext(sessionId)).toEqual(
        messagesBefore,
      );
      expect(
        app.personasim.store.findTurnByClientMessageId(sessionId, clientId),
      ).toBeUndefined();
      expect(count("persona_observations")).toBe(observationsBefore);
      expect(count("persona_adaptations")).toBe(adaptationsBefore);

      const retried = await send(sessionId, text, clientId);
      expect(retried.statusCode, retried.body).toBe(201);
      const accepted = retried.json<ChatTurnResult>();
      expect(
        snapshot().relationshipPractices.filter(
          (item) => item.proposal.practice === "fewer_questions",
        ),
      ).toHaveLength(1);
      expect(count("persona_observations")).toBe(observationsBefore + 1);
      expect(count("persona_adaptations")).toBe(adaptationsBefore + 1);
      const revisionAfter = snapshot().revision;
      const generationsAfter = generate.mock.calls.length;
      const replay = await send(sessionId, text, clientId);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json<ChatTurnResult>()).toMatchObject({
        idempotentReplay: true,
        userMessage: { id: accepted.userMessage.id },
        assistantMessage: { id: accepted.assistantMessage.id },
      });
      expect(snapshot().revision).toBe(revisionAfter);
      expect(count("persona_observations")).toBe(observationsBefore + 1);
      expect(count("persona_adaptations")).toBe(adaptationsBefore + 1);
      expect(generate.mock.calls).toHaveLength(generationsAfter);
    },
  );

  it.each(["off", "shadow"] as const)(
    "rejects stale factual memory sources and rolls back the turn while persona runtime is %s",
    async (mode) => {
      await setup(mode);
      const sourceSessionId = await newSession();
      const store = app.personasim.store;
      const sourceMessageId = `memory-source-${mode}`;
      store.insertMessage({
        id: sourceMessageId,
        sessionId: sourceSessionId,
        agentId: spec.id,
        role: "user",
        messageKind: "user",
        content: "我计划每周四晚上画画。",
        metadata: {},
        createdAtUtc: NOW,
      });
      const [memory] = validateMergeAndPersistMemories({
        store,
        agentId: spec.id,
        candidates: [],
        authoritativeMessageId: sourceMessageId,
        nowUtc: NOW,
        maxCandidates: 4,
      });
      expect(memory).toBeDefined();
      const sessionId = await newSession();
      const messagesBefore = store.listMessagesForContext(sessionId);
      const observationsBefore = count("persona_observations");
      const memoriesBefore = count("memories");
      const entered = gate();
      const release = gate();
      const originalGenerate = app.personasim.llm.generateObject.bind(
        app.personasim.llm,
      );
      let held = false;
      vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
        async (input) => {
          if (input.purpose === "chat_turn" && !held) {
            held = true;
            entered.resolve();
            await release.promise;
          }
          return originalGenerate(input);
        },
      );
      const clientId = `stale-factual-source-${mode}`;
      const pending = send(
        sessionId,
        "你还记得我每周四晚上画画的安排吗？",
        clientId,
      ).then((response) => response);
      await entered.promise;
      const stateBeforeCommit = store.getRuntimeState(spec.id);
      try {
        store.database
          .prepare("UPDATE memories SET status = 'superseded' WHERE id = ?")
          .run(memory!.id);
      } finally {
        release.resolve();
      }
      const rejected = await pending;
      expect(rejected.statusCode, rejected.body).toBe(409);
      expect(rejected.json()).toMatchObject({
        error: { code: "stale_memory_sources" },
      });
      expect(store.listMessagesForContext(sessionId)).toEqual(messagesBefore);
      expect(
        store.findTurnByClientMessageId(sessionId, clientId),
      ).toBeUndefined();
      expect(store.getRuntimeState(spec.id)).toEqual(stateBeforeCommit);
      expect(count("persona_observations")).toBe(observationsBefore);
      expect(count("persona_adaptations")).toBe(0);
      expect(count("memories")).toBe(memoriesBefore);
    },
  );

  it("commits a shadow turn without capturing stale observations when the author publishes during generation", async () => {
    await setup("shadow");
    await learn();
    const sessionId = await newSession();
    const observationsBefore = count("persona_observations");
    const memoriesBefore = count("memories");
    const entered = gate();
    const release = gate();
    const originalGenerate = app.personasim.llm.generateObject.bind(
      app.personasim.llm,
    );
    let held = false;
    vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
      async (input) => {
        if (input.purpose === "chat_turn" && !held) {
          held = true;
          entered.resolve();
          await release.promise;
        }
        return originalGenerate(input);
      },
    );
    const pending = send(
      sessionId,
      "我谈工作烦恼时，也请少追问。",
      "shadow-concurrent-publication",
    ).then((response) => response);
    await entered.promise;
    const beforePublication = spec;
    try {
      spec = CharacterSpecSchema.parse({
        ...spec,
        version: spec.version + 1,
        dialogue: { ...spec.dialogue, warmth: 0.9 },
      });
      app.personasim.store.transaction(() => {
        app.personasim.store.insertCharacterVersion(spec);
        app.personasim.store.updateCharacterHead(spec);
      });
    } finally {
      release.resolve();
    }
    const response = await pending;
    expect(response.statusCode, response.body).toBe(201);
    expect(count("persona_observations")).toBe(observationsBefore);
    expect(count("persona_adaptations")).toBe(0);
    expect(count("memories")).toBe(memoriesBefore);
    expect(app.personasim.store.getCharacterSpec(spec.id)).toEqual(spec);
    expect(
      app.personasim.store.getCharacterSpec(spec.id, beforePublication.version),
    ).toEqual(beforePublication);
    expect(
      response.json<ChatTurnResult>().assistantMessage.metadata[
        "personaRuntime"
      ],
    ).toMatchObject({ mode: "shadow", revision: 0 });
  });

  it("passes the same frozen persona to generation, inspection, and reply repair", async () => {
    await setup();
    await learn();
    const decisions = app.personasim.kernel.registry.resolve(
      TURN_DECISION_SERVICE_TOKEN,
    );
    const repairs = app.personasim.kernel.registry.resolve(
      REPLY_REPAIR_SERVICE_TOKEN,
    );
    const decide = vi.spyOn(decisions, "decide");
    const inspect = vi.spyOn(decisions, "inspect");
    const repair = vi.spyOn(repairs, "repairFixtureDecision");
    const originalGenerate = app.personasim.llm.generateObject.bind(
      app.personasim.llm,
    );
    const generate = vi
      .spyOn(app.personasim.llm, "generateObject")
      .mockImplementation((input) =>
        input.purpose === "chat_turn"
          ? Promise.resolve({ invalid: true } as never)
          : originalGenerate(input),
      );
    const response = await send(await newSession(), TOPIC, "repair-persona");
    expect(response.statusCode, response.body).toBe(201);
    const effective = decide.mock.calls[0]?.[0].effectivePersona;
    expect(effective?.relationshipPractices).toHaveLength(1);
    expect(repair).toHaveBeenCalledOnce();
    expect(repair.mock.calls[0]?.[0].effectivePersona).toBe(effective);
    expect(decide.mock.calls[0]?.[0].conversationPlan).toBeDefined();
    expect(repair.mock.calls[0]?.[0].conversationPlan).toBe(
      decide.mock.calls[0]?.[0].conversationPlan,
    );
    expect(inspect).toHaveBeenCalled();
    for (const [input] of inspect.mock.calls)
      expect(input.effectivePersona).toBe(effective);
    const repairedPrompt = generate.mock.calls.find(
      ([input]) => input.purpose === "repair_chat_turn",
    )?.[0];
    expect(repairedPrompt?.prompt).toContain('"practice":"listen_first"');
    expect(repairedPrompt?.prompt).not.toContain(PREFERENCE);
    expect(
      response.json<ChatTurnResult>().assistantMessage.metadata[
        "personaRuntime"
      ],
    ).toMatchObject({
      revision: effective?.revision,
      adaptationIds: effective?.relationshipPractices.map((item) => item.id),
    });
  });
});
