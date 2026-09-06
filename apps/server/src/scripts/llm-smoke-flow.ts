import {
  AgentTurnDecisionSchema,
  ListMessagesResponseSchema,
  SendMessageResponseSchema,
} from "@personasim/contracts";
import { z } from "zod";

import { buildApp, type PersonaSimApp } from "../app.js";
import type { ServerConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";
import type { LlmServiceObservationOptions } from "../services/llm-service.js";

const SMOKE_NOW_UTC = "2026-08-16T10:00:00.000Z";
const DEFAULT_USER_TEXT =
  "今晚学校有一场海边主题晚会，你愿意和我一起去吗？请用中文简短回应。";

const HealthResponseSchema = z
  .object({
    status: z.literal("ok"),
    llmProvider: z.literal("openai-compatible"),
  })
  .passthrough();

const PersistedDecisionMetadataSchema = z
  .object({
    chunks: z.array(z.string().trim().min(1).max(4_000)).min(1).max(12),
    toneTags: z.array(z.string().trim().min(1).max(64)).max(12),
    reasonCode: z.string().trim().min(1).max(120),
    reasonSummary: z.string().trim().min(1).max(240),
  })
  .passthrough();

export type LlmHttpSmokeResult = {
  provider: "openai-compatible";
  profile: string;
  model: string;
  reasoningEffort?: string;
  reasoningRequestFormat?: string;
  assistantText: string;
  chunks: string[];
  sessionId: string;
  applicationLlmPurposes: string[];
  repairUsed: boolean;
};

export async function runLlmHttpSmoke(
  inputConfig: ServerConfig,
  options: {
    userText?: string;
    clientMessageId?: string;
    host?: string;
    observation?: LlmServiceObservationOptions;
  } = {},
): Promise<LlmHttpSmokeResult> {
  if (
    inputConfig.llm.provider !== "openai-compatible" ||
    !inputConfig.llm.apiKey
  ) {
    throw new TypeError(
      "The HTTP LLM smoke flow requires an OpenAI-compatible provider and API key.",
    );
  }

  const database = openDatabase(":memory:");
  const clock = new FakeClock(SMOKE_NOW_UTC);
  const config: ServerConfig = {
    ...inputConfig,
    nodeEnv: "test",
    profile: "llm-http-smoke",
    databasePath: ":memory:",
    clockMode: "fake",
    fakeClockStart: SMOKE_NOW_UTC,
    seedDemo: false,
    developerRoutes: false,
    chatEffectsMode: "off",
    scheduleNegotiationMode: "legacy",
    selfInitiatedPlanningMode: "off",
    liveWorldEffectsMode: "off",
    memoryRecallMode: "legacy",
    autobiographyMode: "off",
    llm: { ...inputConfig.llm, provider: "openai-compatible" },
  };

  let app: PersonaSimApp | undefined;
  try {
    app = await buildApp({
      config,
      database,
      clock,
      seedDemo: false,
      startScheduler: false,
      logger: false,
      ...(options.observation === undefined
        ? {}
        : { llmObservation: options.observation }),
    });

    const draft = app.personasim.characters.createDemoCharacter();
    const lightweight = app.personasim.characters.updateDraft(draft.id, {
      patch: { tier: "lightweight" },
      expectedVersion: draft.version,
    });
    const character = app.personasim.characters.publish(
      lightweight.id,
      lightweight.version,
    );

    const origin = await app.listen({
      host: options.host ?? "127.0.0.1",
      port: 0,
    });
    HealthResponseSchema.parse(await requestJson(origin, "/api/health"));

    const turn = SendMessageResponseSchema.parse(
      await requestJson(origin, "/api/agents/" + character.id + "/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientMessageId:
            options.clientMessageId ?? "llm-http-smoke-conversation-1",
          text: options.userText ?? DEFAULT_USER_TEXT,
        }),
      }),
    );
    if (turn.idempotentReplay) {
      throw new Error("The live HTTP smoke turn unexpectedly replayed.");
    }
    if (turn.assistantMessage.content !== turn.decision.chunks.join("\n")) {
      throw new Error(
        "The HTTP response did not expose the server-materialized reply invariant.",
      );
    }

    const stored = ListMessagesResponseSchema.parse(
      await requestJson(
        origin,
        "/api/sessions/" + turn.assistantMessage.sessionId + "/messages",
      ),
    ).messages.find((message) => message.id === turn.assistantMessage.id);
    if (!stored || stored.role !== "assistant") {
      throw new Error(
        "The assistant reply was not persisted by the HTTP turn.",
      );
    }
    const metadata = PersistedDecisionMetadataSchema.parse(stored.metadata);
    if (
      stored.content !== metadata.chunks.join("\n") ||
      stored.content !== turn.assistantMessage.content ||
      JSON.stringify(metadata.chunks) !== JSON.stringify(turn.decision.chunks)
    ) {
      throw new Error(
        "The persisted assistant reply did not preserve the strict text/chunks invariant.",
      );
    }

    AgentTurnDecisionSchema.parse({
      reply: {
        text: stored.content,
        chunks: metadata.chunks,
        toneTags: metadata.toneTags,
      },
      scheduleEffects: [],
      memoryCandidates: [],
      reasonCode: metadata.reasonCode,
      reasonSummary: metadata.reasonSummary,
    });

    const calls = app.personasim.store.listLlmCalls(10);
    const applicationLlmPurposes = calls
      .map((call) => z.string().parse(call["purpose"]))
      .reverse();
    const recordedProfiles = calls.map((call) =>
      z.string().parse(call["providerProfile"]),
    );
    const recordedReasoningEfforts = calls.map(
      (call) => call["reasoningEffort"] ?? undefined,
    );
    const recordedReasoningRequestFormats = calls.map(
      (call) => call["reasoningRequestFormat"] ?? undefined,
    );
    if (
      applicationLlmPurposes.length === 0 ||
      applicationLlmPurposes[0] !== "chat_turn" ||
      applicationLlmPurposes.some(
        (purpose) => purpose !== "chat_turn" && purpose !== "repair_chat_turn",
      )
    ) {
      throw new Error(
        "The HTTP smoke setup invoked an unexpected application LLM purpose.",
      );
    }
    if (
      recordedProfiles.some(
        (profile) => profile !== app?.personasim.llm.profileName,
      )
    ) {
      throw new Error("The HTTP smoke calls did not preserve the LLM profile.");
    }
    if (
      recordedReasoningEfforts.some(
        (effort) => effort !== app?.personasim.llm.reasoningEffort,
      )
    ) {
      throw new Error(
        "The HTTP smoke calls did not preserve the LLM reasoning effort.",
      );
    }
    if (
      recordedReasoningRequestFormats.some(
        (format) => format !== app?.personasim.llm.reasoningRequestFormat,
      )
    ) {
      throw new Error(
        "The HTTP smoke calls did not preserve the LLM reasoning request format.",
      );
    }

    return {
      provider: "openai-compatible",
      profile: app.personasim.llm.profileName,
      model: app.personasim.llm.modelName,
      ...(app.personasim.llm.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: app.personasim.llm.reasoningEffort }),
      ...(app.personasim.llm.reasoningRequestFormat === undefined
        ? {}
        : {
            reasoningRequestFormat: app.personasim.llm.reasoningRequestFormat,
          }),
      assistantText: stored.content,
      chunks: metadata.chunks,
      sessionId: stored.sessionId,
      applicationLlmPurposes,
      repairUsed: applicationLlmPurposes.includes("repair_chat_turn"),
    };
  } finally {
    if (app) await app.close();
  }
}

async function requestJson(
  origin: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetch(new URL(path, origin), init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      "HTTP " +
        String(response.status) +
        " " +
        response.statusText +
        ": " +
        text.slice(0, 500),
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      "HTTP " + String(response.status) + " returned a non-JSON response.",
    );
  }
}
