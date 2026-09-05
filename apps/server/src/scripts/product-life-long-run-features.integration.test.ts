import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import type { ServerConfig } from "../config.js";
import { FakeClock } from "../runtime/clock.js";
import type { LlmLogicalCallEvent } from "../services/llm-service.js";
import {
  dispatchProductLifeLetter,
  inspectProductLifeArtifacts,
  inspectProductLifeCorrespondence,
} from "./product-life-long-run-features.js";

const START = "2026-09-03T04:00:00.000Z";
const BODY =
  "最近我开始给晚饭留一点时间，今天认真做了番茄鸡蛋面。以前总觉得照顾自己也得很用力，现在愿意先从一碗热面开始。把这个小变化写给你，等信慢慢抵达。";

describe("product long-run correspondence and relationship artifacts", () => {
  const apps: PersonaSimApp[] = [];
  const directories: string[] = [];

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValue(
          new Error("No external network in product feature tests"),
        ),
    );
  });
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    vi.unstubAllGlobals();
    for (const directory of directories.splice(0)) {
      const contained = relative(resolve(tmpdir()), resolve(directory));
      if (
        contained.startsWith("..") ||
        !contained.startsWith("product-life-features-")
      )
        throw new Error("Unexpected cleanup directory");
      await rm(directory, { recursive: true, force: true });
    }
  });

  async function setup() {
    const directory = await mkdtemp(join(tmpdir(), "product-life-features-"));
    directories.push(directory);
    const clock = new FakeClock(START);
    const observations: LlmLogicalCallEvent[] = [];
    const config: ServerConfig = {
      nodeEnv: "test",
      profile: "product-life-feature-test",
      port: 0,
      host: "127.0.0.1",
      webOrigin: "http://localhost:5173",
      databasePath: join(directory, "instance.sqlite"),
      clockMode: "fake",
      fakeClockStart: START,
      llm: {
        provider: "fixture",
        baseUrl: "https://fixture.invalid",
        model: "product-feature-fixture",
        timeoutMs: 1_000,
        maxRetries: 0,
      },
      conversationRetention: {
        fullVerbatimHours: 24,
        softTokenLimit: 8_000,
        hardTokenLimit: 12_000,
        minimumTailTokens: 3_000,
        minimumRecentTurns: 12,
      },
      logLevel: "silent",
      seedDemo: false,
      developerRoutes: false,
      chatEffectsMode: "gated",
      lifePlanningMode: "fuzzy",
      scheduleNegotiationMode: "off",
      selfInitiatedPlanningMode: "off",
      liveWorldEffectsMode: "enforced",
      memoryRecallMode: "enforced",
      autobiographyMode: "enforced",
      correspondenceMode: "enforced",
      correspondenceExecution: "lazy",
      correspondenceTransitPolicy: "fixed_5d_v1",
      correspondenceGenerationLeaseMs: 60_000,
      correspondenceMaxOpenThreads: 1,
      keepsakeMode: "enforced",
      assetStoragePath: join(directory, "assets"),
      instanceSecret: Buffer.alloc(32, 0x6f).toString("base64"),
    };
    const app = await buildApp({
      config,
      clock,
      seedDemo: false,
      startScheduler: false,
      logger: false,
      llmObservation: { onLogicalCall: (event) => observations.push(event) },
    });
    apps.push(app);
    const draft = app.personasim.characters.createDemoCharacter();
    const published = await app.inject({
      method: "POST",
      url: `/api/characters/${draft.id}/publish`,
    });
    expect(published.statusCode).toBe(200);
    return { app, clock, agentId: draft.id, observations };
  }

  it("uses public draft/update/seal, late catch-up, early-open rejection and normal decrypt/open without fabricated sources", async () => {
    const { app, clock, agentId, observations } = await setup();
    const dispatched = await dispatchProductLifeLetter(app, agentId, {
      requestId: "product-letter-1",
      subject: "一碗热面的小记",
      body: BODY,
    });
    expect(dispatched.status).toBe("completed");
    expect(dispatched.letterId).toBeTypeOf("string");
    expect(dispatched.publicMessages).toMatchObject([
      {
        sourceId: dispatched.letterId,
        role: "user",
        channel: "letter",
        content: `【我已寄出的信】\n一碗热面的小记\n${BODY}`,
      },
    ]);
    expect(
      dispatched.publicMessages[0]?.authoredDisplayDate.length,
    ).toBeGreaterThan(0);
    expect(dispatched.evidence).toMatchObject({
      http: [
        { method: "POST", statusCode: 201 },
        { method: "PATCH", statusCode: 200 },
        { method: "POST", statusCode: 200 },
      ],
    });
    const incomingLetterId = dispatched.letterId!;

    clock.setUtc("2026-09-07T04:00:00.000Z");
    const outbound = await inspectProductLifeCorrespondence(app, agentId, {
      incomingLetterId,
      probeEarlyOpen: true,
    });
    expect(outbound.status).toBe("completed");
    expect(outbound.publicMessages).toEqual([]);
    expect(outbound.evidence).toMatchObject({
      internalEvidence: { snapshot: null, generation: null },
    });
    expect(
      observations.filter(
        (event) =>
          event.stage === "started" && event.purpose === "letter_reply",
      ),
    ).toHaveLength(0);

    clock.setUtc("2026-09-10T04:00:00.000Z");
    const arrived = await inspectProductLifeCorrespondence(app, agentId, {
      incomingLetterId,
      probeEarlyOpen: true,
    });
    expect(arrived.status).toBe("completed");
    expect(arrived.publicMessages).toEqual([]);
    expect(arrived.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "snapshot_effective_time",
          passed: true,
        }),
        expect.objectContaining({
          id: "reply_encrypted_at_rest",
          passed: true,
        }),
        expect.objectContaining({
          id: "unopened_reply_plaintext_hidden",
          passed: true,
        }),
        expect.objectContaining({
          id: "early_reply_open_rejected",
          passed: true,
        }),
      ]),
    );
    expect(arrived.evidence).toMatchObject({
      internalEvidence: {
        snapshot: {
          effectiveAtUtc: "2026-09-08T04:00:00.000Z",
          createdAtUtc: "2026-09-10T04:00:00.000Z",
        },
        generation: { status: "committed" },
        replyStorage: {
          encryptedEnvelopePresent: true,
          plaintextBodyPresent: false,
          arrivalDueAtUtc: "2026-09-13T04:00:00.000Z",
        },
      },
    });
    expect(JSON.stringify(arrived.evidence)).not.toMatch(
      /"(?:ciphertext|iv|authTag|claimToken)"/u,
    );
    expect(
      observations.filter(
        (event) =>
          event.stage === "started" && event.purpose === "letter_reply",
      ),
    ).toHaveLength(1);

    clock.setUtc("2026-09-15T04:00:00.000Z");
    const opened = await inspectProductLifeCorrespondence(app, agentId, {
      incomingLetterId,
      openReply: true,
    });
    expect(opened.status).toBe("completed");
    expect(opened.replyLetterId).toBe(arrived.replyLetterId);
    expect(opened.publicMessages).toHaveLength(1);
    expect(opened.publicMessages[0]).toMatchObject({
      role: "assistant",
      channel: "letter",
    });
    expect(opened.publicMessages[0]!.content).toContain(BODY);
    expect(opened.publicMessages[0]!.content).not.toMatch(
      /snapshot|runtimeState|memoryEvidence|ciphertext|authTag/iu,
    );
    const replay = await inspectProductLifeCorrespondence(app, agentId, {
      incomingLetterId,
      openReply: true,
    });
    expect(replay.publicMessages).toEqual(opened.publicMessages);
    expect(
      observations.filter(
        (event) =>
          event.stage === "started" && event.purpose === "letter_reply",
      ),
    ).toHaveLength(1);

    const artifacts = await inspectProductLifeArtifacts(app, agentId, {
      letterId: opened.replyLetterId!,
      recapFromUtc: START,
    });
    expect(artifacts.status).toBe("completed");
    expect(artifacts.publicMessages).toEqual([]);
    expect(artifacts.evidence).toMatchObject({
      internalEvidence: { keepsakeOutcome: { kind: "generated", count: 1 } },
    });
    expect(artifacts.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "keepsake_observed", passed: true }),
        expect.objectContaining({
          id: "relationship_recap_contract",
          passed: true,
        }),
        expect.objectContaining({
          id: "local_share_preview_without_letter_body",
          passed: true,
        }),
      ]),
    );
    const assetChecks = artifacts.checks.filter(
      (check) =>
        check.id.startsWith("keepsake_asset_") ||
        check.id.startsWith("keepsake_thumbnail_"),
    );
    expect(assetChecks).toHaveLength(2);
    expect(assetChecks.every((check) => check.passed)).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("reports an empty cabinet without injecting eligibility or sources while preserving real bootstrap archive evidence", async () => {
    const { app, agentId } = await setup();
    const result = await inspectProductLifeArtifacts(app, agentId, {
      recapFromUtc: "2026-09-02T04:00:00.000Z",
    });
    expect(result.status).toBe("completed");
    expect(result.publicMessages).toEqual([]);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "keepsake_observed", passed: null }),
        expect.objectContaining({
          id: "relationship_recap_contract",
          passed: true,
        }),
        expect.objectContaining({
          id: "share_preview_has_source",
          passed: null,
        }),
      ]),
    );
    expect(result.evidence).toMatchObject({
      internalEvidence: { keepsakeOutcome: { kind: "none_generated" } },
    });
    expect(
      app.personasim.correspondenceRepository.listLetters(agentId),
    ).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
