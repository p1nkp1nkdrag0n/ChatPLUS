import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ImageGenerationInput } from "@personasim/providers";
import {
  DecisionRecordSchema,
  DilemmaEpisodeSchema,
  OutcomeRecordSchema,
  ReflectionRecordSchema,
  RelationshipMilestoneSchema,
  type KeepsakeDetailResponse,
  type KeepsakeKind,
  type KeepsakePageResponse,
  type KeepsakeSourceType,
} from "@personasim/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "./app.js";
import { readConfig } from "./config.js";
import { FakeClock } from "./runtime/clock.js";
import { SseHub } from "./sse/hub.js";
import { CorrespondenceRepository } from "./repositories/correspondence-repository.js";
import { KeepsakeRepository } from "./repositories/keepsake-repository.js";
import { LifeRepository } from "./repositories/life-repository.js";
import { KeepsakeAssetStore } from "./services/keepsake-asset-store.js";
import { KeepsakeService } from "./services/keepsake-service.js";

const NOW = "2026-09-20T12:00:00.000Z";
const INSTANCE_SECRET = Buffer.alloc(32, 0x6b).toString("base64");

describe("keepsake HTTP lifecycle", () => {
  let directory: string | undefined;
  let app: PersonaSimApp | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app !== undefined) await app.close();
    app = undefined;
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("gates durable evidence, generates one content-addressed asset, and exposes traceable safe APIs", async () => {
    directory = mkdtempSync(join(tmpdir(), "chatplus-keepsake-http-"));
    const assetPath = join(directory, "assets");
    const clock = new FakeClock(NOW);
    app = await buildApp({
      config: readConfig({
        nodeEnv: "test",
        profile: "keepsake-stage6",
        databasePath: join(directory, "keepsake.db"),
        assetStoragePath: assetPath,
        clockMode: "fake",
        fakeClockStart: NOW,
        seedDemo: false,
        developerRoutes: true,
        lifePlanningMode: "fuzzy",
        correspondenceMode: "off",
        correspondenceExecution: "lazy",
        correspondenceTransitPolicy: "fixed_5d_v1",
        correspondenceGenerationLeaseMs: 300_000,
        correspondenceMaxOpenThreads: 1,
        keepsakeMode: "enforced",
        llm: {
          provider: "fixture",
          baseUrl: "https://example.invalid",
          model: "personasim-fixture-v1",
          timeoutMs: 1_000,
          maxRetries: 0,
        },
      }),
      clock,
      seedDemo: false,
      startScheduler: false,
      logger: false,
    });
    const draft = app.personasim.characters.createDemoCharacter();
    const published = await app.inject({
      method: "POST",
      url: `/api/characters/${draft.id}/publish`,
    });
    expect(published.statusCode).toBe(200);

    const planned = await app.inject({
      method: "POST",
      url: `/api/developer/agents/${draft.id}/keepsakes/generate`,
      payload: {
        sourceType: "life_outcome",
        sourceId: "planned-decision-1",
      },
    });
    expect(planned.statusCode).toBe(404);
    expect(
      app.personasim.store.database
        .prepare("SELECT COUNT(*) AS count FROM keepsakes")
        .get(),
    ).toEqual({ count: 0 });

    seedMilestone(app, draft.id, "milestone-cinema-1");
    const enqueue = await app.inject({
      method: "POST",
      url: `/api/developer/agents/${draft.id}/keepsakes/generate`,
      payload: {
        sourceType: "relationship_milestone",
        sourceId: "milestone-cinema-1",
        requestedKind: "ticket_stub",
      },
    });
    expect(enqueue.statusCode).toBe(201);
    const enqueued = enqueue.json<{
      keepsake: { id: string; visualSpecHash: string; status: string };
      taskId: string;
      replayed: boolean;
    }>();
    expect(enqueued.keepsake).toMatchObject({ status: "pending" });
    expect(enqueued.keepsake.visualSpecHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      app.personasim.keepsakes.relationshipArtifactsPromptContext(draft.id, NOW)
        .readyKeepsakes,
    ).toEqual([]);

    // A competing process owns different random IDs but the same frozen
    // semantic/source/visual identity. Repository re-entry must converge on
    // the first durable row and its task/run.
    const keepsakeRepository = new KeepsakeRepository(
      app.personasim.store.database,
    );
    const firstKeepsake = keepsakeRepository.require(enqueued.keepsake.id);
    const projectedSource = keepsakeRepository.projectSource(
      draft.id,
      "relationship_milestone",
      "milestone-cinema-1",
    )!;
    const identity = app.personasim.store.database
      .prepare(
        `SELECT semantic_key AS semanticKey,
                semantic_signature AS semanticSignature
           FROM keepsakes WHERE id = ?`,
      )
      .get(firstKeepsake.id) as {
      semanticKey: string;
      semanticSignature: string;
    };
    const getByIdempotencyKey =
      keepsakeRepository.getByIdempotencyKey.bind(keepsakeRepository);
    const lookup = vi
      .spyOn(keepsakeRepository, "getByIdempotencyKey")
      .mockImplementationOnce(() => undefined)
      .mockImplementation(getByIdempotencyKey);
    const repositoryReplay = keepsakeRepository.createPending({
      keepsake: { ...firstKeepsake, id: "keepsake-competing-random-id" },
      ...identity,
      source: projectedSource,
      taskId: "temporal-task-competing-random-id",
      runId: "keepsake-run-competing-random-id",
    });
    expect(lookup).toHaveBeenCalledTimes(2);
    lookup.mockRestore();
    expect(repositoryReplay).toMatchObject({
      replayed: true,
      keepsake: { id: firstKeepsake.id },
      taskId: enqueued.taskId,
    });
    expect(() =>
      keepsakeRepository.createPending({
        keepsake: {
          ...firstKeepsake,
          id: "keepsake-conflicting-random-id",
          title: "同一幂等键下被篡改的标题",
        },
        ...identity,
        source: projectedSource,
        taskId: "temporal-task-conflicting-random-id",
        runId: "keepsake-run-conflicting-random-id",
      }),
    ).toThrow("idempotency key was reused with new content");

    const replay = await app.inject({
      method: "POST",
      url: `/api/developer/agents/${draft.id}/keepsakes/generate`,
      payload: {
        sourceType: "relationship_milestone",
        sourceId: "milestone-cinema-1",
        requestedKind: "ticket_stub",
      },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toMatchObject({
      keepsake: { id: enqueued.keepsake.id },
      replayed: true,
    });
    expect(
      app.personasim.store.database
        .prepare("SELECT COUNT(*) AS count FROM keepsakes")
        .get(),
    ).toEqual({ count: 1 });
    const publish = vi.spyOn(SseHub.prototype, "publish");
    const process = await app.inject({
      method: "POST",
      url: `/api/developer/keepsake-tasks/${enqueued.taskId}/process`,
      payload: {},
    });
    expect(process.statusCode).toBe(200);
    expect(process.json()).toMatchObject({
      keepsake: { id: enqueued.keepsake.id, status: "ready" },
    });
    expect(
      app.personasim.store.database
        .prepare("SELECT COUNT(*) AS count FROM keepsake_assets")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      app.personasim.store.database
        .prepare("SELECT COUNT(*) AS count FROM keepsake_generation_runs")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      app.personasim.keepsakes.relationshipArtifactsPromptContext(draft.id, NOW)
        .readyKeepsakes,
    ).toEqual([
      expect.objectContaining({
        id: enqueued.keepsake.id,
        title: expect.stringContaining("票根") as string,
        kind: "ticket_stub",
        sourceEventIds: ["milestone-cinema-1"],
      }),
    ]);

    const list = await app.inject({
      method: "GET",
      url: `/api/agents/${draft.id}/keepsakes`,
    });
    expect(list.statusCode).toBe(200);
    const page = list.json<KeepsakePageResponse>();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: enqueued.keepsake.id,
      thumbnailUrl: `/api/keepsakes/${enqueued.keepsake.id}/thumbnail`,
    });

    const detailResponse = await app.inject({
      method: "GET",
      url: `/api/keepsakes/${enqueued.keepsake.id}`,
    });
    expect(detailResponse.statusCode).toBe(200);
    const detail = detailResponse.json<KeepsakeDetailResponse>();
    expect(detail.sources).toEqual([
      expect.objectContaining({
        type: "relationship_milestone",
        id: "milestone-cinema-1",
        href: `/characters/${draft.id}/relationship-archive?entryId=${encodeURIComponent("relationship_milestone:milestone-cinema-1")}`,
      }),
    ]);
    expect(detail.assets[0]).toMatchObject({
      mimeType: "image/webp",
      provider: "structured-template",
      promptSpecHash: enqueued.keepsake.visualSpecHash,
    });

    const asset = await app.inject({
      method: "GET",
      url: `/api/keepsakes/${enqueued.keepsake.id}/asset`,
    });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("image/webp");
    expect(asset.headers["cache-control"]).toContain("immutable");
    expect(asset.rawPayload.byteLength).toBeGreaterThan(100);
    expect(existsSync(assetPath)).toBe(true);
    expect(
      allFiles(assetPath).filter((name) => name.endsWith(".webp")),
    ).toHaveLength(2);

    const createdEvents = publish.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "keepsake.created");
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]?.data).toEqual({
      keepsakeId: enqueued.keepsake.id,
      invalidates: [["keepsakes", draft.id]],
    });
    expect(JSON.stringify(createdEvents)).not.toMatch(
      /雨夜|电影|description|visualSpec|storageKey|sourceIds/iu,
    );
  }, 30_000);

  it("does not turn recorded future-local life facts into keepsakes before they take effect", async () => {
    directory = mkdtempSync(join(tmpdir(), "chatplus-keepsake-future-gate-"));
    const clock = new FakeClock(NOW);
    app = await startKeepsakeApp(directory, join(directory, "assets"), clock);
    const draft = app.personasim.characters.createDemoCharacter();
    app.personasim.characters.publish(draft.id);
    expect(
      app.personasim.store.getCharacterSpec(draft.id)?.identity.timezone,
    ).toBe("Asia/Shanghai");
    seedFutureEffectiveSources(app, draft.id);

    const repository = new KeepsakeRepository(app.personasim.store.database);
    const sources = [
      {
        sourceType: "relationship_milestone",
        sourceId: "milestone-future-local",
        requestedKind: "ticket_stub",
        effectiveAtUtc: "2026-09-20T16:00:00.000Z",
      },
      {
        sourceType: "life_outcome",
        sourceId: "outcome-future-local",
        requestedKind: "postcard",
        effectiveAtUtc: "2026-09-20T22:00:00.000Z",
      },
      {
        sourceType: "reflection",
        sourceId: "reflection-future-local",
        requestedKind: "sketch",
        effectiveAtUtc: "2026-09-21T06:00:00.000Z",
      },
    ] as const;

    for (const { sourceType, sourceId, effectiveAtUtc } of sources) {
      expect(repository.projectSource(draft.id, sourceType, sourceId)).toEqual(
        expect.objectContaining({ sourceType, sourceId, effectiveAtUtc }),
      );
    }

    for (const source of sources) {
      expect(
        app.personasim.keepsakes.enqueueSource({
          agentId: draft.id,
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          requestedKind: source.requestedKind,
        }),
      ).toMatchObject({
        eligible: false,
        enqueued: false,
        reasonCodes: ["source_in_future"],
      });
    }
    expect(
      app.personasim.store.database
        .prepare("SELECT COUNT(*) AS count FROM keepsakes")
        .get(),
    ).toEqual({ count: 0 });

    for (const source of sources) {
      clock.setUtc(source.effectiveAtUtc);
      expect(
        app.personasim.keepsakes.enqueueSource({
          agentId: draft.id,
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          requestedKind: source.requestedKind,
        }),
      ).toMatchObject({
        eligible: true,
        enqueued: true,
        reasonCodes: [],
        keepsake: {
          kind: source.requestedKind,
          createdEffectiveAtUtc: source.effectiveAtUtc,
        },
      });
    }

    expect(
      repository
        .listSignatures(draft.id)
        .map(({ kind, createdEffectiveAtUtc }) => ({
          kind,
          createdEffectiveAtUtc,
        })),
    ).toEqual(
      sources.map(({ requestedKind: kind, effectiveAtUtc }) => ({
        kind,
        createdEffectiveAtUtc: effectiveAtUtc,
      })),
    );
  }, 30_000);

  it("filters the complete ready cabinet before paging and binds cursors to their filters", async () => {
    directory = mkdtempSync(join(tmpdir(), "chatplus-keepsake-filtering-"));
    const assetPath = join(directory, "assets");
    const clock = new FakeClock(NOW);
    app = await startKeepsakeApp(directory, assetPath, clock);
    const firstAgent = app.personasim.characters.createDemoCharacter();
    app.personasim.characters.publish(firstAgent.id);
    const secondAgent = app.personasim.characters.createDemoCharacter();
    app.personasim.characters.publish(secondAgent.id);

    seedReadyKeepsake(app, firstAgent.id, {
      id: "keepsake-filter-a1",
      index: 1,
      kind: "postcard",
      sourceType: "relationship_milestone",
      sourceId: "milestone-filter-a1",
      createdAtUtc: "2026-09-01T08:00:00.000Z",
    });
    seedReadyKeepsake(app, firstAgent.id, {
      id: "keepsake-filter-a2",
      index: 2,
      kind: "sketch",
      sourceType: "reflection",
      sourceId: "reflection-filter-a2",
      createdAtUtc: "2026-09-02T08:00:00.000Z",
    });
    seedReadyKeepsake(app, firstAgent.id, {
      id: "keepsake-filter-a3",
      index: 3,
      kind: "postcard",
      sourceType: "life_outcome",
      sourceId: "outcome-filter-a3",
      createdAtUtc: "2026-09-03T08:00:00.000Z",
    });
    seedReadyKeepsake(app, firstAgent.id, {
      id: "keepsake-filter-a4",
      index: 4,
      kind: "ticket_stub",
      sourceType: "letter",
      sourceId: "letter-filter-a4",
      createdAtUtc: "2026-10-01T08:00:00.000Z",
    });
    seedReadyKeepsake(app, firstAgent.id, {
      id: "keepsake-filter-a5",
      index: 5,
      kind: "recipe_or_note_card",
      sourceType: "relationship_milestone",
      sourceId: "milestone-filter-a5",
      createdAtUtc: "2026-10-02T08:00:00.000Z",
    });
    seedReadyKeepsake(app, secondAgent.id, {
      id: "keepsake-filter-b1",
      index: 6,
      kind: "pressed_flower",
      sourceType: "reflection",
      sourceId: "reflection-filter-b1",
      createdAtUtc: "2026-11-01T08:00:00.000Z",
    });

    const assetRead = vi.spyOn(KeepsakeAssetStore.prototype, "read");
    const firstPageResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${firstAgent.id}/keepsakes?kind=postcard&limit=1`,
    });
    expect(firstPageResponse.statusCode).toBe(200);
    const firstPage = firstPageResponse.json<KeepsakePageResponse>();
    expect(firstPage.items.map((item) => item.id)).toEqual([
      "keepsake-filter-a3",
    ]);
    expect(firstPage.nextCursor).toBeDefined();
    expect(firstPage.filterOptions).toEqual({
      kinds: ["postcard", "recipe_or_note_card", "sketch", "ticket_stub"],
      sourceTypes: [
        "letter",
        "life_outcome",
        "reflection",
        "relationship_milestone",
      ],
      periods: ["2026-10", "2026-09"],
    });

    const secondPageResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${firstAgent.id}/keepsakes?kind=postcard&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    });
    expect(secondPageResponse.statusCode).toBe(200);
    expect(
      secondPageResponse
        .json<KeepsakePageResponse>()
        .items.map((item) => item.id),
    ).toEqual(["keepsake-filter-a1"]);

    const mismatchedCursor = await app.inject({
      method: "GET",
      url: `/api/agents/${firstAgent.id}/keepsakes?kind=sketch&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    });
    expect(mismatchedCursor.statusCode).toBe(400);
    expect(mismatchedCursor.json()).toMatchObject({
      error: { code: "invalid_cursor" },
    });

    const sourceFiltered = await app.inject({
      method: "GET",
      url: `/api/agents/${firstAgent.id}/keepsakes?sourceType=reflection`,
    });
    expect(
      sourceFiltered.json<KeepsakePageResponse>().items.map((item) => item.id),
    ).toEqual(["keepsake-filter-a2"]);

    const periodFiltered = await app.inject({
      method: "GET",
      url: `/api/agents/${firstAgent.id}/keepsakes?period=2026-10`,
    });
    expect(
      periodFiltered.json<KeepsakePageResponse>().items.map((item) => item.id),
    ).toEqual(["keepsake-filter-a5", "keepsake-filter-a4"]);

    const combined = await app.inject({
      method: "GET",
      url: `/api/agents/${firstAgent.id}/keepsakes?kind=postcard&sourceType=life_outcome&period=2026-09`,
    });
    expect(combined.statusCode).toBe(200);
    expect(
      combined.json<KeepsakePageResponse>().items.map((item) => item.id),
    ).toEqual(["keepsake-filter-a3"]);
    const repository = new KeepsakeRepository(app.personasim.store.database);
    expect(repository.getDetail("keepsake-filter-a1")?.sources[0]?.href).toBe(
      `/characters/${firstAgent.id}/relationship-archive?entryId=${encodeURIComponent("relationship_milestone:milestone-filter-a1")}`,
    );
    expect(repository.getDetail("keepsake-filter-a2")?.sources[0]?.href).toBe(
      `/characters/${firstAgent.id}/relationship-archive?entryId=${encodeURIComponent("reflection:reflection-filter-a2")}`,
    );
    expect(repository.getDetail("keepsake-filter-a3")?.sources[0]?.href).toBe(
      `/characters/${firstAgent.id}/relationship-archive?entryId=${encodeURIComponent("outcome_record:outcome-filter-a3")}`,
    );
    expect(repository.getDetail("keepsake-filter-a4")?.sources[0]?.href).toBe(
      `/letters/letter-filter-a4?agentId=${firstAgent.id}`,
    );
    expect(assetRead).not.toHaveBeenCalled();
  });

  it("cleans files after a database failure and retries into one durable main asset", async () => {
    directory = mkdtempSync(join(tmpdir(), "chatplus-keepsake-cleanup-"));
    const assetPath = join(directory, "assets");
    const clock = new FakeClock(NOW);
    app = await startKeepsakeApp(directory, assetPath, clock);
    const draft = app.personasim.characters.createDemoCharacter();
    app.personasim.characters.publish(draft.id);
    seedMilestone(app, draft.id, "milestone-cleanup-1");
    const enqueued = app.personasim.keepsakes.enqueueSource({
      agentId: draft.id,
      sourceType: "relationship_milestone",
      sourceId: "milestone-cleanup-1",
      requestedKind: "ticket_stub",
    });
    expect(enqueued.taskId).toBeDefined();
    app.personasim.store.database.exec(`
      CREATE TRIGGER fail_keepsake_asset_insert
      BEFORE INSERT ON keepsake_assets
      BEGIN
        SELECT RAISE(ABORT, 'simulated metadata commit failure');
      END;
    `);

    await expect(
      app.personasim.keepsakes.processTask(enqueued.taskId!),
    ).rejects.toThrow(/simulated metadata commit failure/u);
    expect(
      existsSync(assetPath)
        ? allFiles(assetPath).filter((name) => name.endsWith(".webp"))
        : [],
    ).toHaveLength(0);
    expect(
      app.personasim.store.database
        .prepare("SELECT status, attempt FROM temporal_tasks WHERE id = ?")
        .get(enqueued.taskId),
    ).toEqual({ status: "retryable", attempt: 1 });
    expect(
      app.personasim.store.database
        .prepare("SELECT status, attempt FROM keepsake_generation_runs")
        .get(),
    ).toEqual({ status: "retryable", attempt: 1 });

    app.personasim.store.database.exec(
      "DROP TRIGGER fail_keepsake_asset_insert",
    );
    clock.setUtc("2026-09-20T12:02:00.000Z");
    const ready = await app.personasim.keepsakes.processTask(
      enqueued.taskId!,
      clock.nowUtc(),
    );
    expect(ready.status).toBe("ready");
    expect(
      app.personasim.store.database
        .prepare("SELECT COUNT(*) AS count FROM keepsakes")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      app.personasim.store.database
        .prepare("SELECT COUNT(*) AS count FROM keepsake_assets")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      app.personasim.store.database
        .prepare("SELECT status, attempt FROM keepsake_generation_runs")
        .get(),
    ).toEqual({ status: "committed", attempt: 2 });
  }, 30_000);

  it("freezes story semantics before a replaceable image provider runs", async () => {
    directory = mkdtempSync(join(tmpdir(), "chatplus-keepsake-provider-"));
    const assetPath = join(directory, "assets");
    const clock = new FakeClock(NOW);
    app = await startKeepsakeApp(directory, assetPath, clock);
    const draft = app.personasim.characters.createDemoCharacter();
    app.personasim.characters.publish(draft.id);
    seedMilestone(app, draft.id, "milestone-provider-1");
    const database = app.personasim.store.database;
    const repository = new KeepsakeRepository(database);
    const correspondence = new CorrespondenceRepository(database);
    const assets = new KeepsakeAssetStore(assetPath);
    let providerInput: unknown;
    const firstProvider = new KeepsakeService(
      repository,
      correspondence,
      app.personasim.store,
      assets,
      clock,
      app.personasim.sse,
      {
        mode: "enforced",
        imageProvider: {
          name: "provider-before-restart",
          model: "model-a",
          generate: () =>
            Promise.reject(
              new Error("This provider must not be called before restart"),
            ),
        },
      },
    );
    const enqueued = firstProvider.enqueueSource({
      agentId: draft.id,
      sourceType: "relationship_milestone",
      sourceId: "milestone-provider-1",
      requestedKind: "sketch",
    });
    const before = storyProjection(enqueued.keepsake!);

    const replacement = new KeepsakeService(
      repository,
      correspondence,
      app.personasim.store,
      assets,
      clock,
      app.personasim.sse,
      {
        mode: "enforced",
        imageProvider: {
          name: "provider-after-restart",
          model: "model-b",
          generate: (input) => {
            providerInput = input;
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><rect width="640" height="640" fill="#F3E9D2"/></svg>`;
            return Promise.resolve({
              bytes: new TextEncoder().encode(svg),
              mimeType: "image/svg+xml" as const,
              width: 640,
              height: 640,
            });
          },
        },
      },
    );
    const ready = await replacement.processTask(enqueued.taskId!);
    expect(storyProjection(ready)).toEqual(before);
    expect(
      database.prepare("SELECT provider, model FROM keepsake_assets").get(),
    ).toEqual({ provider: "provider-after-restart", model: "model-b" });
    expect(providerInput).toBeDefined();
    const captured = providerInput as ImageGenerationInput;
    expect(captured.visualSpec.version).toBe("keepsake_visual_v1");
    expect(captured.visualSpec.semanticSourceHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(captured.idempotencyKey).toBe(before.idempotencyKey);
    expect(JSON.stringify(providerInput)).not.toMatch(
      /source_snapshot|sourceMessageIds|relationship_delta|full private/iu,
    );
  }, 30_000);

  it("uses the read incoming letter to enqueue at most one keepsake after reply commit", async () => {
    directory = mkdtempSync(join(tmpdir(), "chatplus-keepsake-letter-hook-"));
    const assetPath = join(directory, "assets");
    const clock = new FakeClock(NOW);
    app = await buildApp({
      config: readConfig({
        nodeEnv: "test",
        profile: "keepsake-letter-hook",
        databasePath: join(directory, "hook.db"),
        assetStoragePath: assetPath,
        clockMode: "fake",
        fakeClockStart: NOW,
        seedDemo: false,
        developerRoutes: true,
        lifePlanningMode: "fuzzy",
        correspondenceMode: "enforced",
        correspondenceExecution: "lazy",
        correspondenceTransitPolicy: "fixed_5d_v1",
        correspondenceGenerationLeaseMs: 300_000,
        correspondenceMaxOpenThreads: 1,
        keepsakeMode: "enforced",
        instanceSecret: INSTANCE_SECRET,
        llm: {
          provider: "fixture",
          baseUrl: "https://example.invalid",
          model: "personasim-fixture-v1",
          timeoutMs: 1_000,
          maxRetries: 0,
        },
      }),
      clock,
      seedDemo: false,
      startScheduler: false,
      logger: false,
    });
    const draft = app.personasim.characters.createDemoCharacter();
    app.personasim.characters.publish(draft.id);
    const created = await app.inject({
      method: "POST",
      url: `/api/agents/${draft.id}/letters`,
      payload: {
        clientRequestId: "keepsake-hook-create",
        subject: "厨房里的那张便笺",
        body: "这是一封会在抵达后成为纪念物证据的信。",
      },
    });
    const incomingLetterId = created.json<{ letter: { id: string } }>().letter
      .id;
    const sealed = await app.inject({
      method: "POST",
      url: `/api/letters/${incomingLetterId}/seal`,
      payload: { clientRequestId: "keepsake-hook-seal" },
    });
    expect(sealed.statusCode).toBe(200);

    clock.setUtc("2026-09-26T12:00:00.000Z");
    const caughtUp = await app.inject({
      method: "GET",
      url: `/api/letters/${incomingLetterId}`,
    });
    expect(caughtUp.statusCode).toBe(200);
    await Promise.resolve();
    await Promise.resolve();

    const replies = app.personasim.store.database
      .prepare(
        `SELECT id, status FROM letters
         WHERE reply_to_letter_id = ? AND direction = 'agent_to_user'`,
      )
      .all(incomingLetterId) as Array<{ id: string; status: string }>;
    expect(replies).toHaveLength(1);
    expect(replies[0]?.status).toBe("in_transit");
    const relationshipArtifacts =
      app.personasim.keepsakes.relationshipArtifactsPromptContext(
        draft.id,
        clock.nowUtc(),
      );
    expect(relationshipArtifacts.correspondence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: incomingLetterId,
          direction: "user_to_agent",
          status: "read",
        }),
        expect.objectContaining({
          id: replies[0]!.id,
          direction: "agent_to_user",
          status: "in_transit",
        }),
      ]),
    );
    expect(JSON.stringify(relationshipArtifacts)).not.toContain(
      "这是一封会在抵达后成为纪念物证据的信。",
    );
    expect(JSON.stringify(relationshipArtifacts.correspondence)).not.toContain(
      "厨房里的那张便笺",
    );
    const sourceRows = app.personasim.store.database
      .prepare(
        `SELECT keepsake_id AS keepsakeId, source_type AS sourceType,
                source_id AS sourceId
         FROM keepsake_sources WHERE source_type = 'letter' AND source_id = ?`,
      )
      .all(incomingLetterId) as Array<{
      keepsakeId: string;
      sourceType: string;
      sourceId: string;
    }>;
    expect(sourceRows).toHaveLength(1);
    const letterKeepsake = app.personasim.keepsakes.getDetail(
      sourceRows[0]!.keepsakeId,
    ).keepsake;
    expect(letterKeepsake.visualSpecJson.templateVersion).toBe(
      `${letterKeepsake.kind}-v2`,
    );
    expect(letterKeepsake.visualSpecJson.caption).toContain("已读的书信");
    expect(letterKeepsake.visualSpecJson.caption).not.toBe(
      letterKeepsake.visualSpecJson.theme,
    );
    expect(JSON.stringify(letterKeepsake.visualSpecJson)).not.toContain(
      "这是一封会在抵达后成为纪念物证据的信。",
    );
    expect(sourceRows[0]).toMatchObject({
      sourceType: "letter",
      sourceId: incomingLetterId,
    });
    expect(
      app.personasim.store.database
        .prepare(
          `SELECT incoming_letter_id AS incomingLetterId,
                  reply_letter_id AS replyLetterId,
                  keepsake_id AS keepsakeId
             FROM keepsake_letter_links`,
        )
        .get(),
    ).toEqual({
      incomingLetterId,
      replyLetterId: replies[0]!.id,
      keepsakeId: sourceRows[0]!.keepsakeId,
    });
    expect(
      app.personasim.store.database
        .prepare("SELECT COUNT(*) AS count FROM keepsakes")
        .get(),
    ).toEqual({ count: 1 });

    // Re-entering catch-up cannot create a second attachment candidate.
    await app.inject({
      method: "GET",
      url: `/api/agents/${draft.id}/keepsakes`,
    });
    expect(app.personasim.keepsakes.listReadyForReply(replies[0]!.id)).toEqual([
      sourceRows[0]!.keepsakeId,
    ]);
    expect(
      app.personasim.store.database
        .prepare("SELECT COUNT(*) AS count FROM keepsakes")
        .get(),
    ).toEqual({ count: 1 });
  }, 30_000);

  it.each(["lazy", "resident", "worker"] as const)(
    "%s execution drives keepsake.generate without routing it through letter handlers",
    async (execution) => {
      directory = mkdtempSync(
        join(tmpdir(), `chatplus-keepsake-${execution}-`),
      );
      const assetPath = join(directory, "assets");
      const clock = new FakeClock(NOW);
      app = await startKeepsakeApp(directory, assetPath, clock, {
        execution,
        startScheduler: true,
      });
      const draft = app.personasim.characters.createDemoCharacter();
      app.personasim.characters.publish(draft.id);
      seedMilestone(app, draft.id, `milestone-${execution}-1`);
      const enqueued = app.personasim.keepsakes.enqueueSource({
        agentId: draft.id,
        sourceType: "relationship_milestone",
        sourceId: `milestone-${execution}-1`,
        requestedKind: "ticket_stub",
      });
      expect(
        app.personasim.store.database
          .prepare("SELECT priority FROM temporal_tasks WHERE id = ?")
          .get(enqueued.taskId),
      ).toEqual({ priority: 40 });

      if (execution === "lazy") {
        const response = await app.inject({
          method: "GET",
          url: `/api/agents/${draft.id}/keepsakes`,
        });
        expect(response.statusCode).toBe(200);
      } else {
        await app.personasim.temporalTaskScheduler.wake();
      }
      expect(
        app.personasim.keepsakes.getDetail(enqueued.keepsake!.id).keepsake,
      ).toMatchObject({
        status: "ready",
      });
    },
    30_000,
  );
});

function seedFutureEffectiveSources(app: PersonaSimApp, agentId: string): void {
  const session = app.personasim.store.createSession(
    agentId,
    "future effective keepsake sources",
    NOW,
  );
  const repository = new LifeRepository(app.personasim.store.database);
  repository.insertDilemma(
    DilemmaEpisodeSchema.parse({
      id: "dilemma-future-local",
      agentId,
      sessionId: session.id,
      subject: "character",
      title: "明天如何记录一次创作旅行",
      summary: "角色将在明天完成一次有意义的创作旅行。",
      domain: "creative",
      options: [
        {
          id: "option-future-local-sketch",
          label: "用速写记录",
          description: "在旅途中用速写保存观察。",
          likelyTradeoffs: ["需要放慢行程"],
          valuesAtStake: ["创作完整性"],
        },
        {
          id: "option-future-local-photo",
          label: "用照片记录",
          description: "用照片快速保存沿途细节。",
          likelyTradeoffs: ["可能减少现场观察"],
          valuesAtStake: ["记录效率"],
        },
      ],
      status: "open",
      sourceMessageIds: ["message-future-local"],
      effectiveLocalDate: "2026-09-21",
      temporalPrecision: "day",
      recordedAtUtc: NOW,
      updatedAtUtc: NOW,
      idempotencyKey: "dilemma:future-local",
      schemaVersion: 1,
    }),
  );
  repository.insertDecision(
    DecisionRecordSchema.parse({
      id: "decision-future-local",
      agentId,
      sessionId: session.id,
      dilemmaId: "dilemma-future-local",
      subject: "character",
      supportMode: "deliberate",
      authority: "subject",
      decidedBy: "character",
      selectedOptionId: "option-future-local-sketch",
      selectionSummary: "用速写记录",
      reasoningSummary: "这更符合角色的创作方式。",
      supportInterventionIds: [],
      sourceMessageIds: ["message-future-local"],
      confidence: 0.9,
      status: "current",
      effectiveLocalDate: "2026-09-21",
      temporalPrecision: "day",
      recordedAtUtc: NOW,
      idempotencyKey: "decision:future-local",
      schemaVersion: 1,
    }),
  );
  repository.insertOutcomeRecord(
    OutcomeRecordSchema.parse({
      id: "outcome-future-local",
      agentId,
      sessionId: session.id,
      decisionId: "decision-future-local",
      actionIds: [],
      causeKind: "external",
      valence: "positive",
      summary: "清晨的旅行带来了新的创作视角。",
      consequenceFacts: ["角色在旅行中找到新的创作视角"],
      sourceEvidenceIds: ["message-future-local"],
      confidence: 0.9,
      status: "confirmed",
      effectiveLocalDate: "2026-09-21",
      effectivePeriod: "morning",
      temporalPrecision: "period",
      recordedAtUtc: NOW,
      idempotencyKey: "outcome:future-local",
      schemaVersion: 1,
    }),
  );
  repository.insertReflection(
    ReflectionRecordSchema.parse({
      id: "reflection-future-local",
      agentId,
      sessionId: session.id,
      subject: "character",
      reflectedBy: "character",
      decisionId: "decision-future-local",
      outcomeId: "outcome-future-local",
      summary: "下午整理速写时确认了慢下来观察的价值。",
      lessons: ["放慢速度能让观察更具体"],
      stanceTowardDecision: "affirm",
      changedInterpretation: true,
      sourceMessageIds: ["message-future-local"],
      effectiveLocalDate: "2026-09-21",
      effectivePeriod: "afternoon",
      temporalPrecision: "period",
      recordedAtUtc: NOW,
      idempotencyKey: "reflection:future-local",
      schemaVersion: 1,
    }),
  );
  repository.insertMilestone(
    RelationshipMilestoneSchema.parse({
      id: "milestone-future-local",
      agentId,
      sessionId: session.id,
      kind: "turning_point",
      title: "一次值得记住的创作旅行",
      summary: "这次旅行会成为关系中共同理解创作选择的转折点。",
      significance: 0.9,
      interventionIds: [],
      decisionIds: ["decision-future-local"],
      outcomeIds: [],
      reflectionIds: [],
      sourceMessageIds: ["message-future-local"],
      effectiveLocalDate: "2026-09-21",
      temporalPrecision: "day",
      recordedAtUtc: NOW,
      idempotencyKey: "milestone:future-local",
      schemaVersion: 1,
    }),
  );
}

function seedMilestone(app: PersonaSimApp, agentId: string, id: string): void {
  app.personasim.store.database
    .prepare(
      `INSERT INTO relationship_milestones(
         id, agent_id, session_id, kind, title, summary, significance,
         relationship_delta_json, intervention_ids_json, decision_ids_json,
         outcome_ids_json, reflection_ids_json, source_message_ids_json,
         effective_local_date, effective_period, temporal_precision,
         recorded_at_utc, idempotency_key, schema_version, milestone_json
       ) VALUES (?, ?, NULL, 'meaningful_support', '雨夜电影',
                 '一起看完已经发生的电影，散场时雨刚停。', 0.9, NULL,
                 '["intervention-1"]', '[]', '[]', '[]', '["message-1"]',
                 '2026-09-20', NULL, 'day', ?, ?, 1,
                 '{"tags":["cinema","rain"]}')`,
    )
    .run(id, agentId, NOW, `milestone:${id}`);
}

function seedReadyKeepsake(
  app: PersonaSimApp,
  agentId: string,
  input: {
    id: string;
    index: number;
    kind: KeepsakeKind;
    sourceType: KeepsakeSourceType;
    sourceId: string;
    createdAtUtc: string;
  },
): void {
  const sourceEventIds = input.sourceType === "letter" ? [] : [input.sourceId];
  const sourceLetterIds = input.sourceType === "letter" ? [input.sourceId] : [];
  app.personasim.store.database.transaction(() => {
    app.personasim.store.database
      .prepare(
        `INSERT INTO keepsakes(
           id, agent_id, title, kind, description, created_by, owned_by,
           given_to, source_event_ids_json, source_memory_ids_json,
           source_letter_ids_json, semantic_key, semantic_signature,
           canonicality, status, visual_spec_json, visual_spec_hash,
           primary_asset_id, created_effective_at_utc, gifted_at_utc,
                   idempotency_key, created_at_utc, updated_at_utc
         ) VALUES (?, ?, ?, ?, ?, 'agent', 'user', NULL, ?, '[]', ?, ?, ?,
                   'evidence_derived', 'ready', ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        input.id,
        agentId,
        `筛选纪念物 ${input.index}`,
        input.kind,
        `服务端筛选测试 ${input.index}`,
        JSON.stringify(sourceEventIds),
        JSON.stringify(sourceLetterIds),
        `filter-semantic:${agentId}:${input.index}`,
        input.index.toString(16).padStart(64, "0"),
        JSON.stringify({
          version: "keepsake_visual_v1",
          templateVersion: "filter-fixture-v1",
          theme: "服务端筛选",
          caption: `筛选纪念物 ${input.index}`,
          palette: ["#C56F46", "#22354B"],
          materials: ["旧纸"],
        }),
        "f".repeat(64),
        `asset-filter-${agentId}-${input.index}`,
        input.createdAtUtc,
        `filter-idempotency:${agentId}:${input.index}`,
        input.createdAtUtc,
        input.createdAtUtc,
      );
    app.personasim.store.database
      .prepare(
        `INSERT INTO keepsake_sources(
           keepsake_id, source_type, source_id, agent_id, label,
           effective_at_utc, source_snapshot_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.sourceType,
        input.sourceId,
        agentId,
        `来源 ${input.index}`,
        input.createdAtUtc,
        JSON.stringify({ sourceId: input.sourceId }),
      );
  })();
}

function allFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" }).map(String);
}

async function startKeepsakeApp(
  directory: string,
  assetPath: string,
  clock: FakeClock,
  options: {
    execution?: "lazy" | "resident" | "worker";
    startScheduler?: boolean;
  } = {},
): Promise<PersonaSimApp> {
  return buildApp({
    config: readConfig({
      nodeEnv: "test",
      profile: "keepsake-stage6",
      databasePath: join(directory, "keepsake.db"),
      assetStoragePath: assetPath,
      clockMode: "fake",
      fakeClockStart: clock.nowUtc(),
      seedDemo: false,
      developerRoutes: true,
      lifePlanningMode: "fuzzy",
      correspondenceMode: "off",
      correspondenceExecution: options.execution ?? "lazy",
      correspondenceTransitPolicy: "fixed_5d_v1",
      correspondenceGenerationLeaseMs: 300_000,
      correspondenceMaxOpenThreads: 1,
      keepsakeMode: "enforced",
      llm: {
        provider: "fixture",
        baseUrl: "https://example.invalid",
        model: "personasim-fixture-v1",
        timeoutMs: 1_000,
        maxRetries: 0,
      },
    }),
    clock,
    seedDemo: false,
    startScheduler: options.startScheduler ?? false,
    logger: false,
  });
}

function storyProjection(keepsake: {
  title: string;
  kind: string;
  description: string;
  sourceEventIds: readonly string[];
  sourceMemoryIds: readonly string[];
  sourceLetterIds: readonly string[];
  canonicality: string;
  visualSpecHash: string;
  idempotencyKey: string;
}) {
  return {
    title: keepsake.title,
    kind: keepsake.kind,
    description: keepsake.description,
    sourceEventIds: keepsake.sourceEventIds,
    sourceMemoryIds: keepsake.sourceMemoryIds,
    sourceLetterIds: keepsake.sourceLetterIds,
    canonicality: keepsake.canonicality,
    visualSpecHash: keepsake.visualSpecHash,
    idempotencyKey: keepsake.idempotencyKey,
  };
}
