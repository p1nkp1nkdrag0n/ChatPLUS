import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { FakeClock } from "./clock.js";
import { ProactiveTaskRepository } from "../services/proactive-task-repository.js";

const CREATED = "2026-09-03T04:00:00.000Z";
const DUE = "2026-09-03T04:01:00.000Z";
const NOW = "2026-09-03T04:02:00.000Z";
const CANDIDATE = "candidate-persistent-proactive";

describe("independent persistent proactive scheduling", () => {
  const apps: PersonaSimApp[] = [];
  const directories: string[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  async function start(
    databasePath: string,
    options: {
      mode?: "off" | "shadow" | "on";
      execution?: "lazy" | "resident" | "worker";
      now?: string;
      run?: boolean;
    } = {},
  ) {
    const clock = new FakeClock(options.now ?? NOW);
    const app = await buildApp({
      config: readConfig({
        nodeEnv: "test",
        databasePath,
        profile: "lightweight",
        clockMode: "fake",
        fakeClockStart: clock.nowUtc(),
        correspondenceMode: "off",
        correspondenceExecution: "lazy",
        keepsakeMode: "off",
        proactiveMode: options.mode ?? "on",
        proactiveExecution: options.execution ?? "resident",
        llm: {
          provider: "fixture",
          baseUrl: "https://example.invalid",
          model: "fixture",
          timeoutMs: 1000,
          maxRetries: 0,
        },
      }),
      clock,
      logger: false,
      startScheduler: options.run ?? true,
    });
    apps.push(app);
    return { app, clock };
  }

  async function seed() {
    const directory = mkdtempSync(join(tmpdir(), "chatplus-proactive-worker-"));
    directories.push(directory);
    const databasePath = join(directory, "instance.sqlite");
    const { app } = await start(databasePath, { now: CREATED, run: false });
    const spec = app.personasim.characters.publish(
      app.personasim.characters.createDemoCharacter().id,
    );
    spec.proactivePolicy.enabled = true;
    spec.proactivePolicy.minimumCloseness = 0;
    spec.proactivePolicy.quietHours = {
      startLocal: "23:00",
      endLocal: "07:00",
    };
    const database = app.personasim.store.database;
    database
      .prepare(
        "UPDATE character_versions SET spec_json = ? WHERE character_id = ? AND version = ?",
      )
      .run(JSON.stringify(spec), spec.id, spec.version);
    const session = app.personasim.conversations.createSession(spec.id);
    database
      .prepare(
        `INSERT INTO activity_events(id, agent_id, event_type, occurred_at_utc,
        summary, outcome_facts_json, state_delta_json, origin, idempotency_key, event_json)
       VALUES ('event-persistent-proactive', ?, 'completed', ?, 'Finished a memorable city walk.',
         '["Completed a city walk."]', '{}', 'deterministic', 'persistent-proactive-event', '{}')`,
      )
      .run(spec.id, CREATED);
    database
      .prepare(
        `INSERT INTO proactive_candidates(id, agent_id, trigger_event_id, intent, summary,
        earliest_at_utc, expires_at_utc, priority, cooldown_key, status, created_at_utc)
       VALUES (?, ?, 'event-persistent-proactive', 'share_experience', 'Completed a city walk.',
         ?, '2026-09-05T04:00:00.000Z', 0.9, 'city-walk', 'pending', ?)`,
      )
      .run(CANDIDATE, spec.id, DUE, CREATED);
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    return { databasePath, agentId: spec.id, sessionId: session.id };
  }

  function messages(app: PersonaSimApp) {
    return app.personasim.store.database
      .prepare(
        "SELECT id FROM messages WHERE message_kind = 'assistant_proactive' AND trigger_event_id = 'event-persistent-proactive'",
      )
      .all();
  }

  function task(app: PersonaSimApp, mode = "on") {
    return app.personasim.store.database
      .prepare(
        "SELECT id, status, attempt, due_at_utc, last_error_code FROM temporal_tasks WHERE entity_id = ? AND json_extract(payload_json, '$.mode') = ? ORDER BY rowid DESC LIMIT 1",
      )
      .get(CANDIDATE, mode) as
      | {
          id: string;
          status: string;
          attempt: number;
          due_at_utc: string;
          last_error_code: string | null;
        }
      | undefined;
  }

  it.each(["resident", "worker"] as const)(
    "%s delivers persisted work offline with correspondence disabled",
    async (execution) => {
      const fixture = await seed();
      const { app } = await start(fixture.databasePath, { execution });
      expect(app.personasim.temporalTaskScheduler.isRunning).toBe(false);
      expect(app.personasim.proactiveTaskScheduler.isRunning).toBe(true);
      expect(app.personasim.sse.getActiveAgentIds()).toEqual([]);
      expect(task(app)).toMatchObject({ status: "completed", attempt: 1 });
      expect(messages(app)).toHaveLength(1);
      await app.personasim.proactiveTaskScheduler.wake();
      expect(messages(app)).toHaveLength(1);
    },
  );

  it("shadow audits eligibility without calling a model and can later enable delivery", async () => {
    const fixture = await seed();
    const shadow = await start(fixture.databasePath, { mode: "shadow" });
    expect(task(shadow.app, "shadow")).toMatchObject({ status: "completed" });
    expect(messages(shadow.app)).toHaveLength(0);
    expect(
      shadow.app.personasim.store.database
        .prepare(
          "SELECT outcome FROM proactive_task_evaluations WHERE mode = 'shadow'",
        )
        .all(),
    ).toEqual([{ outcome: "shadow_eligible" }]);
    expect(
      shadow.app.personasim.store.database
        .prepare(
          "SELECT id FROM llm_calls WHERE purpose = 'compose_proactive_message'",
        )
        .all(),
    ).toHaveLength(0);
    await shadow.app.close();
    apps.splice(apps.indexOf(shadow.app), 1);
    const enabled = await start(fixture.databasePath);
    expect(messages(enabled.app)).toHaveLength(1);
  });

  it("persists active-conversation deferral across restart and sends only after the saved due time", async () => {
    const fixture = await seed();
    const first = await start(fixture.databasePath, { run: false });
    first.app.personasim.store.database
      .prepare(
        `INSERT INTO messages(id, session_id, agent_id, role, content, message_kind, metadata_json, created_at_utc)
       VALUES ('message-proactive-recent', ?, ?, 'user', 'Hello', 'user', '{}', ?)`,
      )
      .run(fixture.sessionId, fixture.agentId, NOW);
    await first.app.personasim.proactiveTaskScheduler.tick();
    expect(task(first.app)).toMatchObject({
      status: "retryable",
      attempt: 1,
      last_error_code: "active_conversation",
      due_at_utc: "2026-09-03T04:04:00.000Z",
    });
    expect(messages(first.app)).toHaveLength(0);
    await first.app.close();
    apps.splice(apps.indexOf(first.app), 1);
    const next = await start(fixture.databasePath, {
      now: "2026-09-03T04:03:00.000Z",
    });
    expect(task(next.app)).toMatchObject({ attempt: 1 });
    next.clock.setUtc("2026-09-03T04:05:00.000Z");
    await next.app.personasim.proactiveTaskScheduler.wake();
    expect(messages(next.app)).toHaveLength(1);
    expect(task(next.app)).toMatchObject({ status: "completed", attempt: 2 });
  });

  it("drops stale activity backlog after downtime", async () => {
    const fixture = await seed();
    const { app } = await start(fixture.databasePath, {
      now: "2026-09-03T11:00:00.000Z",
    });
    expect(task(app)).toBeUndefined();
    expect(
      app.personasim.store.database
        .prepare("SELECT status FROM proactive_candidates WHERE id = ?")
        .get(CANDIDATE),
    ).toEqual({ status: "expired" });
    expect(messages(app)).toHaveLength(0);
  });

  it("two workers claim a source once through SQLite, with no duplicate message", async () => {
    const fixture = await seed();
    const first = await start(fixture.databasePath, { run: false });
    const second = await start(fixture.databasePath, {
      run: false,
      execution: "worker",
    });
    await Promise.all([
      first.app.personasim.proactiveTaskScheduler.tick(),
      second.app.personasim.proactiveTaskScheduler.tick(),
    ]);
    expect(messages(first.app)).toHaveLength(1);
    expect(task(first.app)).toMatchObject({ status: "completed", attempt: 1 });
  });

  it("off does not discover or claim sources", async () => {
    const fixture = await seed();
    const { app } = await start(fixture.databasePath, { mode: "off" });
    expect(task(app)).toBeUndefined();
    expect(messages(app)).toHaveLength(0);
  });

  it("reclaims an abandoned task lease after restart", async () => {
    const fixture = await seed();
    const first = await start(fixture.databasePath, { run: false });
    const repository = new ProactiveTaskRepository(
      first.app.personasim.store.database,
      "on",
    );
    repository.synchronize(NOW);
    const claimed = repository.claimNext(fixture.agentId, NOW);
    expect(claimed).toMatchObject({ status: "claimed", attempt: 1 });
    await first.app.close();
    apps.splice(apps.indexOf(first.app), 1);
    const second = await start(fixture.databasePath, {
      now: "2026-09-03T04:33:00.000Z",
    });
    expect(task(second.app)).toMatchObject({ status: "completed", attempt: 2 });
    expect(messages(second.app)).toHaveLength(1);
  });

  it("bounds actual model failures separately from temporary eligibility deferrals", async () => {
    const fixture = await seed();
    const { app, clock } = await start(fixture.databasePath, { run: false });
    const delivery = vi.spyOn(app.personasim.proactiveDelivery, "deliverNext");
    delivery
      .mockResolvedValueOnce({
        status: "not_claimed",
        reasonCode: "active_conversation",
      })
      .mockResolvedValueOnce({
        status: "not_claimed",
        reasonCode: "active_conversation",
      })
      .mockResolvedValueOnce({
        status: "not_claimed",
        reasonCode: "active_conversation",
      })
      .mockResolvedValue({
        status: "failed",
        runId: "failed-fixture",
        reasonCode: "compose_failed",
      });
    for (let pass = 1; pass <= 6; pass += 1) {
      await app.personasim.proactiveTaskScheduler.tick();
      expect(task(app)).toMatchObject({
        attempt: pass,
        status: pass === 6 ? "dead_letter" : "retryable",
      });
      clock.setUtc(task(app)!.due_at_utc);
    }
    await app.personasim.proactiveTaskScheduler.tick();
    expect(delivery).toHaveBeenCalledTimes(6);
    expect(task(app)?.last_error_code).toBe("proactive_attempts_exhausted");
  });

  it("discovers a verified follow-up after restart without opening its conversation", async () => {
    const fixture = await seed();
    const first = await start(fixture.databasePath, {
      run: false,
      now: CREATED,
    });
    const text = "我明天上午有面试，请下午问问我面试怎么样。";
    first.app.personasim.store.database
      .prepare(
        `INSERT INTO messages(id, session_id, agent_id, role, content, message_kind, metadata_json, created_at_utc)
       VALUES ('followup-persistent-evidence', ?, ?, 'user', ?, 'user', '{}', ?)`,
      )
      .run(fixture.sessionId, fixture.agentId, text, CREATED);
    const created = first.app.personasim.followUps.createFollowUp({
      agentId: fixture.agentId,
      sourceMessageId: "followup-persistent-evidence",
      timezone: "Asia/Shanghai",
      candidate: {
        subjectType: "user_event",
        contextSummary: text,
        expectedOutcomeDescription: "面试进行得怎么样",
        timingHint: "tomorrow afternoon",
        evidenceQuotes: [text],
        reasonCode: "explicit_follow_up",
        reasonSummary: "Explicit check-in request",
      },
    });
    expect(created.accepted).toBe(true);
    if (!created.accepted) throw new Error(created.rejection.reasonCode);
    const due = new Date(
      Date.parse(created.followUp.earliestAtUtc) + 180_000,
    ).toISOString();
    await first.app.close();
    apps.splice(apps.indexOf(first.app), 1);
    const second = await start(fixture.databasePath, { now: due });
    expect(
      second.app.personasim.store.database
        .prepare("SELECT status FROM follow_up_intents WHERE id = ?")
        .get(created.followUp.id),
    ).toEqual({ status: "sent" });
    expect(
      second.app.personasim.store.database
        .prepare(
          "SELECT id FROM messages WHERE message_kind = 'assistant_proactive' AND trigger_follow_up_intent_id = ?",
        )
        .all(created.followUp.id),
    ).toHaveLength(1);
    expect(second.app.personasim.sse.getActiveAgentIds()).toEqual([]);
  });
});
