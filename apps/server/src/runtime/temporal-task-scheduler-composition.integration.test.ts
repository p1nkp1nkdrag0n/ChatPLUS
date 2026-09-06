import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalLetterContent } from "@personasim/features";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { FakeClock } from "./clock.js";

const T0 = "2026-09-03T04:00:00.000Z";
const DUE = "2026-09-08T04:00:00.000Z";
const BEFORE_DUE = "2026-09-07T04:00:00.000Z";
const AFTER_DUE = "2026-09-09T04:00:00.000Z";

describe("temporal task scheduler composition", () => {
  const directories: string[] = [];
  let app: PersonaSimApp | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app !== undefined) await app.close();
    app = undefined;
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["resident", "worker"] as const)(
    "%s starts with a global scan and processes an agent with no SSE client",
    async (execution) => {
      const fixture = await seedPendingOutbound(directories);

      app = await startApp(fixture.databasePath, execution, AFTER_DUE, true);

      expect(app.personasim.temporalTaskScheduler.execution).toBe(execution);
      expect(app.personasim.temporalTaskScheduler.isRunning).toBe(true);
      expect(
        app.personasim.correspondenceRepository.getTask(fixture.taskId),
      ).toMatchObject({ status: "completed", attempt: 1 });
      expect(
        app.personasim.correspondenceRepository.getLetter(fixture.letterId),
      ).toMatchObject({
        status: "read",
        deliveredEffectiveAtUtc: DUE,
        readAtUtc: DUE,
      });
      expect(app.personasim.sse.getActiveAgentIds()).toEqual([]);

      await app.close();
      expect(app.personasim.temporalTaskScheduler.isRunning).toBe(false);
      app = undefined;
    },
  );

  it("keeps lazy non-resident while using the same one-time catch-up service", async () => {
    const fixture = await seedPendingOutbound(directories);

    app = await startApp(fixture.databasePath, "lazy", AFTER_DUE, true);

    expect(app.personasim.temporalTaskScheduler.isRunning).toBe(false);
    expect(
      app.personasim.correspondenceRepository.getTask(fixture.taskId),
    ).toMatchObject({ status: "completed", attempt: 1 });
  });

  it("does not start or claim work while correspondence mode is off", async () => {
    const fixture = await seedPendingOutbound(directories);

    app = await startApp(
      fixture.databasePath,
      "resident",
      AFTER_DUE,
      true,
      "off",
    );

    expect(app.personasim.temporalTaskScheduler.isRunning).toBe(false);
    expect(
      app.personasim.correspondenceRepository.getTask(fixture.taskId),
    ).toMatchObject({ status: "pending", attempt: 0 });
  });

  it("wakes the resident database scan after a developer clock change", async () => {
    const fixture = await seedPendingOutbound(directories);
    const clock = new FakeClock(BEFORE_DUE);
    app = await startApp(
      fixture.databasePath,
      "resident",
      BEFORE_DUE,
      true,
      "shadow",
      clock,
    );
    const wake = vi.spyOn(app.personasim.temporalTaskScheduler, "wake");

    const response = await app.inject({
      method: "POST",
      url: "/api/developer/clock/advance",
      payload: { days: 2 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ nowUtc: AFTER_DUE });
    expect(wake).toHaveBeenCalledOnce();
    expect(
      app.personasim.correspondenceRepository.getTask(fixture.taskId),
    ).toMatchObject({ status: "completed", attempt: 1 });
  });

  it("converges to the same due-boundary facts after downtime across due", async () => {
    const continuousFixture = await seedPendingOutbound(directories);
    const offlineFixture = await seedPendingOutbound(directories);
    const continuousClock = new FakeClock(BEFORE_DUE);
    const continuous = await startApp(
      continuousFixture.databasePath,
      "resident",
      BEFORE_DUE,
      true,
      "shadow",
      continuousClock,
    );
    let offline: PersonaSimApp | undefined;
    try {
      continuousClock.setUtc(AFTER_DUE);
      await continuous.personasim.temporalTaskScheduler.wake();

      // This process starts only after the same due instant has passed.
      offline = await startApp(
        offlineFixture.databasePath,
        "resident",
        AFTER_DUE,
        true,
      );

      expect(
        letterAndTaskFacts(
          continuous.personasim.correspondenceRepository,
          continuousFixture,
        ),
      ).toEqual(
        letterAndTaskFacts(
          offline.personasim.correspondenceRepository,
          offlineFixture,
        ),
      );
    } finally {
      await continuous.close();
      if (offline !== undefined) await offline.close();
    }
  });
});

interface PendingFixture {
  readonly databasePath: string;
  readonly letterId: string;
  readonly taskId: string;
}

async function seedPendingOutbound(
  directories: string[],
): Promise<PendingFixture> {
  const directory = mkdtempSync(join(tmpdir(), "chatplus-resident-worker-"));
  directories.push(directory);
  const databasePath = join(directory, "instance.sqlite");
  const seedApp = await buildApp({
    config: config(databasePath, "lazy", T0, "off"),
    clock: new FakeClock(T0),
    seedDemo: true,
    startScheduler: false,
    logger: false,
  });
  try {
    const agent = seedApp.personasim.characters.list(true)[0];
    if (agent === undefined)
      throw new TypeError("demo character was not seeded");
    const repository = seedApp.personasim.correspondenceRepository;
    const thread = repository.createThread(agent.id, {
      id: "thread-scheduler-composition",
      nowUtc: T0,
    });
    const subject = "Resident worker test";
    const body = "This letter must arrive without an active browser.";
    const draft = repository.createDraftLetter({
      id: "letter-scheduler-composition",
      threadId: thread.id,
      agentId: agent.id,
      subject,
      body,
      nowUtc: T0,
    });
    const sealed = repository.sealLetter({
      letterId: draft.id,
      contentHash: createHash("sha256")
        .update(canonicalLetterContent({ subject, body }), "utf8")
        .digest("hex"),
      transitPolicyVersion: "fixed_5d_v1",
      transitTimezone: "Asia/Shanghai",
      dispatchedAtUtc: T0,
      arrivalDueAtUtc: DUE,
      effectiveAuthorTimeUtc: T0,
      taskId: "task-scheduler-composition",
      clientRequestId: "seal-scheduler-composition",
    });
    return {
      databasePath,
      letterId: sealed.letter.id,
      taskId: sealed.task.id,
    };
  } finally {
    await seedApp.close();
  }
}

function startApp(
  databasePath: string,
  execution: "lazy" | "resident" | "worker",
  nowUtc: string,
  startScheduler: boolean,
  mode: "off" | "shadow" = "shadow",
  clock = new FakeClock(nowUtc),
): Promise<PersonaSimApp> {
  return buildApp({
    config: config(databasePath, execution, nowUtc, mode),
    clock,
    seedDemo: false,
    startScheduler,
    logger: false,
  });
}

function config(
  databasePath: string,
  correspondenceExecution: "lazy" | "resident" | "worker",
  nowUtc: string,
  correspondenceMode: "off" | "shadow",
) {
  return readConfig({
    nodeEnv: "test",
    profile: "lightweight",
    databasePath,
    clockMode: "fake",
    fakeClockStart: nowUtc,
    seedDemo: false,
    developerRoutes: true,
    correspondenceMode,
    correspondenceExecution,
    llm: {
      provider: "fixture",
      baseUrl: "https://example.invalid",
      model: "personasim-fixture-v1",
      timeoutMs: 1_000,
      maxRetries: 0,
    },
  });
}

function letterAndTaskFacts(
  repository: PersonaSimApp["personasim"]["correspondenceRepository"],
  fixture: PendingFixture,
) {
  const letter = repository.getLetter(fixture.letterId);
  const task = repository.getTask(fixture.taskId);
  return {
    letter: {
      status: letter?.status,
      deliveredEffectiveAtUtc: letter?.deliveredEffectiveAtUtc,
      processedAtUtc: letter?.processedAtUtc,
      readAtUtc: letter?.readAtUtc,
    },
    task: {
      status: task?.status,
      attempt: task?.attempt,
      completedAtUtc: task?.completedAtUtc,
    },
  };
}
