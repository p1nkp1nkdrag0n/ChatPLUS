import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  KeepsakeDetailResponse,
  KeepsakePageResponse,
} from "@personasim/contracts";
import { FixtureImageGenerationProvider } from "@personasim/providers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "./app.js";
import { readConfig } from "./config.js";
import { FakeClock } from "./runtime/clock.js";

const NOW = "2026-09-20T12:00:00.000Z";

describe("managed keepsake background generation", () => {
  let app: PersonaSimApp | undefined;
  let directory: string | undefined;
  const releases: Array<() => void> = [];

  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    if (app !== undefined) await app.close();
    app = undefined;
    vi.restoreAllMocks();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
    directory = undefined;
  });

  async function fixture(execution: "lazy" | "resident" | "worker" = "lazy") {
    directory = mkdtempSync(join(tmpdir(), "chatplus-keepsake-background-"));
    const clock = new FakeClock(NOW);
    app = await buildApp({
      config: readConfig({
        nodeEnv: "test",
        profile: "keepsake-background",
        databasePath: join(directory, "keepsake.db"),
        assetStoragePath: join(directory, "assets"),
        clockMode: "fake",
        fakeClockStart: NOW,
        seedDemo: false,
        developerRoutes: false,
        lifePlanningMode: "fuzzy",
        correspondenceMode: "shadow",
        correspondenceExecution: execution,
        correspondenceGenerationLeaseMs: 300_000,
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
      startScheduler: true,
      logger: false,
    });
    const draft = app.personasim.characters.createDemoCharacter();
    app.personasim.characters.publish(draft.id);
    app.personasim.store.database
      .prepare(
        `INSERT INTO relationship_milestones(
           id, agent_id, session_id, kind, title, summary, significance,
           relationship_delta_json, intervention_ids_json, decision_ids_json,
           outcome_ids_json, reflection_ids_json, source_message_ids_json,
           effective_local_date, effective_period, temporal_precision,
           recorded_at_utc, idempotency_key, schema_version, milestone_json
         ) VALUES ('milestone-background', ?, NULL, 'meaningful_support',
           '雨夜电影', '一起看完电影后把雨中的街景画了下来。', 0.9, NULL,
           '["intervention-background"]', '[]', '[]', '[]', '["message-background"]',
           '2026-09-20', NULL, 'day', ?, 'milestone:background', 1,
           '{"tags":["cinema","rain"]}')`,
      )
      .run(draft.id, NOW);
    const enqueued = app.personasim.keepsakes.enqueueSource({
      agentId: draft.id,
      sourceType: "relationship_milestone",
      sourceId: "milestone-background",
      requestedKind: "sketch",
    });
    expect(enqueued.enqueued).toBe(true);
    return {
      agentId: draft.id,
      taskId: enqueued.taskId!,
      keepsakeId: enqueued.keepsake!.id,
      clock,
      services: app.personasim,
    };
  }

  function holdImage() {
    const entered = deferred();
    const gate = deferred();
    releases.push(gate.resolve);
    const provider = new FixtureImageGenerationProvider();
    const original = provider.generate.bind(provider);
    const generate = vi
      .spyOn(FixtureImageGenerationProvider.prototype, "generate")
      .mockImplementation(async (input) => {
        entered.resolve();
        await gate.promise;
        return original(input);
      });
    return { generate, entered: entered.promise, release: gate.resolve };
  }

  it.each(["lazy", "resident", "worker"] as const)(
    "%s returns cabinet and foreground correspondence reads while one real generation is pending",
    async (execution) => {
      const held = holdImage();
      const { agentId, taskId, keepsakeId, services } =
        await fixture(execution);
      const url = `/api/agents/${agentId}/keepsakes`;
      const first = app!.inject({ method: "GET", url });
      await withinDeadline(held.entered);

      const response = await withinDeadline(first);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json<KeepsakePageResponse>().items).toEqual([]);
      expect(services.correspondenceRepository.getTask(taskId)).toMatchObject({
        status: "claimed",
        attempt: 1,
      });

      const repeated = await withinDeadline(
        Promise.all(
          Array.from({ length: 5 }, () => app!.inject({ method: "GET", url })),
        ),
      );
      expect(repeated.map((item) => item.statusCode)).toEqual([
        200, 200, 200, 200, 200,
      ]);
      await withinDeadline(services.correspondence.catchUpAgent(agentId, NOW));
      expect(held.generate).toHaveBeenCalledTimes(1);

      const completed = services.temporalTaskScheduler.requestAgentCatchUp(
        agentId,
        NOW,
      );
      held.release();
      await withinDeadline(completed);
      expect(services.correspondenceRepository.getTask(taskId)).toMatchObject({
        status: "completed",
        attempt: 1,
      });
      expect(
        services.store.database
          .prepare("SELECT COUNT(*) AS count FROM keepsake_assets")
          .get(),
      ).toEqual({ count: 1 });
      const ready = await app!.inject({ method: "GET", url });
      expect(ready.json<KeepsakePageResponse>().items).toEqual([
        expect.objectContaining({ id: keepsakeId, status: "ready" }),
      ]);
      expect(held.generate).toHaveBeenCalledTimes(1);
    },
  );

  it("returns a received pending detail and drives generation without waiting for the image", async () => {
    const held = holdImage();
    const { agentId, keepsakeId, services } = await fixture();
    // Receipt transitions are covered by keepsake-http. This fixture starts at
    // an already received non-letter artifact with its image still pending.
    services.store.database
      .prepare(
        "UPDATE keepsakes SET given_to = 'user', gifted_at_utc = ? WHERE id = ?",
      )
      .run(NOW, keepsakeId);
    const url = `/api/keepsakes/${keepsakeId}`;

    const pending = app!.inject({ method: "GET", url });
    await withinDeadline(held.entered);
    const response = await withinDeadline(pending);
    expect(response.statusCode).toBe(200);
    expect(response.json<KeepsakeDetailResponse>().keepsake).toMatchObject({
      id: keepsakeId,
      status: "pending",
      giftedAtUtc: NOW,
    });
    const generating = await withinDeadline(
      app!.inject({ method: "GET", url }),
    );
    expect(generating.statusCode).toBe(200);
    expect(generating.json<KeepsakeDetailResponse>().keepsake.status).toBe(
      "generating",
    );
    expect(held.generate).toHaveBeenCalledTimes(1);

    const completed = services.temporalTaskScheduler.requestAgentCatchUp(
      agentId,
      NOW,
    );
    held.release();
    await withinDeadline(completed);
    const ready = await app!.inject({ method: "GET", url });
    expect(ready.json<KeepsakeDetailResponse>().keepsake).toMatchObject({
      id: keepsakeId,
      status: "ready",
      giftedAtUtc: NOW,
    });
  });

  it("does not schedule model work for an invalid cursor, unknown character, or inaccessible detail", async () => {
    const { agentId, keepsakeId, services } = await fixture();
    const processDue = vi.spyOn(services.keepsakes, "processDueForAgent");
    const schedule = vi.spyOn(
      services.temporalTaskScheduler,
      "requestAgentCatchUp",
    );
    const urls = [
      `/api/agents/${agentId}/keepsakes?cursor=invalid-cursor`,
      "/api/agents/agent-does-not-exist/keepsakes",
      `/api/keepsakes/${keepsakeId}`,
    ];

    const responses = await Promise.all(
      urls.map((url) => app!.inject({ method: "GET", url })),
    );

    expect(responses.map((response) => response.statusCode)).toEqual([
      400, 404, 404,
    ]);
    expect(schedule).not.toHaveBeenCalled();
    expect(processDue).not.toHaveBeenCalled();
  });

  it("keeps GET successful after a provider failure and retries the durable task later", async () => {
    const generate = vi
      .spyOn(FixtureImageGenerationProvider.prototype, "generate")
      .mockRejectedValueOnce(new Error("fixture provider unavailable"));
    const { agentId, taskId, keepsakeId, clock, services } = await fixture();
    const url = `/api/agents/${agentId}/keepsakes`;
    const response = await app!.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    await services.temporalTaskScheduler.requestAgentCatchUp(agentId, NOW);
    expect(services.correspondenceRepository.getTask(taskId)).toMatchObject({
      status: "retryable",
      attempt: 1,
    });

    const retryPending = await app!.inject({ method: "GET", url });
    expect(retryPending.statusCode).toBe(200);
    expect(generate).toHaveBeenCalledTimes(1);
    clock.setUtc("2026-09-20T12:01:01.000Z");
    const retryResponse = await app!.inject({ method: "GET", url });
    expect(retryResponse.statusCode).toBe(200);
    await services.temporalTaskScheduler.requestAgentCatchUp(agentId);

    expect(generate).toHaveBeenCalledTimes(2);
    expect(services.correspondenceRepository.getTask(taskId)).toMatchObject({
      status: "completed",
      attempt: 2,
    });
    expect(services.keepsakes.getDetail(keepsakeId).keepsake.status).toBe(
      "ready",
    );
  });

  it("pauses new work and resumes lazy requests after scheduler restart", async () => {
    const held = holdImage();
    const { agentId, services } = await fixture();
    const url = `/api/agents/${agentId}/keepsakes`;
    services.temporalTaskScheduler.stop();
    const paused = await app!.inject({ method: "GET", url });
    expect(paused.statusCode).toBe(200);
    expect(held.generate).not.toHaveBeenCalled();

    await services.temporalTaskScheduler.start();
    const resumed = app!.inject({ method: "GET", url });
    await withinDeadline(held.entered);
    expect((await withinDeadline(resumed)).statusCode).toBe(200);
    expect(services.temporalTaskScheduler.isRunning).toBe(false);
    held.release();
    await services.temporalTaskScheduler.requestAgentCatchUp(agentId, NOW);
    expect(held.generate).toHaveBeenCalledTimes(1);
  });

  it("lets a received detail poll drive its retry after the due time in lazy mode", async () => {
    const generate = vi
      .spyOn(FixtureImageGenerationProvider.prototype, "generate")
      .mockRejectedValueOnce(new Error("fixture provider unavailable"));
    const { agentId, taskId, keepsakeId, clock, services } = await fixture();
    services.store.database
      .prepare(
        "UPDATE keepsakes SET given_to = 'user', gifted_at_utc = ? WHERE id = ?",
      )
      .run(NOW, keepsakeId);
    const url = `/api/keepsakes/${keepsakeId}`;

    const first = await app!.inject({ method: "GET", url });
    expect(first.statusCode).toBe(200);
    await services.temporalTaskScheduler.requestAgentCatchUp(agentId, NOW);
    const pending = await app!.inject({ method: "GET", url });
    expect(pending.statusCode).toBe(200);
    expect(pending.json<KeepsakeDetailResponse>().keepsake.status).toBe(
      "pending",
    );
    expect(generate).toHaveBeenCalledTimes(1);

    clock.setUtc("2026-09-20T12:01:01.000Z");
    const retried = await app!.inject({ method: "GET", url });
    expect(retried.statusCode).toBe(200);
    await services.temporalTaskScheduler.requestAgentCatchUp(agentId);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(services.correspondenceRepository.getTask(taskId)).toMatchObject({
      status: "completed",
      attempt: 2,
    });
    const ready = await app!.inject({ method: "GET", url });
    expect(ready.json<KeepsakeDetailResponse>().keepsake).toMatchObject({
      id: keepsakeId,
      status: "ready",
      giftedAtUtc: NOW,
    });
  });

  it("waits for a background image before closing its database", async () => {
    const held = holdImage();
    const { agentId, taskId, services } = await fixture();
    const response = app!.inject({
      method: "GET",
      url: `/api/agents/${agentId}/keepsakes`,
    });
    await withinDeadline(held.entered);
    expect((await withinDeadline(response)).statusCode).toBe(200);
    let closed = false;
    const closing = app!.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    expect(services.store.database.open).toBe(true);
    expect(services.correspondenceRepository.getTask(taskId)?.status).toBe(
      "claimed",
    );

    held.release();
    await withinDeadline(closing);
    expect(closed).toBe(true);
    expect(services.store.database.open).toBe(false);
    app = undefined;
  });
});

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withinDeadline<T>(promise: PromiseLike<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("Foreground work waited for the blocked image")),
          2_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
