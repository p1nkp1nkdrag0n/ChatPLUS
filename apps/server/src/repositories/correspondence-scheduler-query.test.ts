import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { CorrespondenceRepository } from "./correspondence-repository.js";

const CREATED_AT = "2026-09-03T00:00:00.000Z";
const FIRST_DUE = "2026-09-08T00:00:00.000Z";
const SECOND_DUE = "2026-09-08T00:10:00.000Z";
const OBSERVED = "2026-09-08T00:05:00.000Z";
const ACTIVE_LEASE = "2026-09-08T00:30:00.000Z";

describe("CorrespondenceRepository global temporal scheduling query", () => {
  let database: Database;
  let repository: CorrespondenceRepository;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    seedAgent(database, "agent-a");
    seedAgent(database, "agent-b");
    repository = new CorrespondenceRepository(database);
  });

  afterEach(() => database.close());

  it("selects globally by actionable wake time instead of SSE activity", () => {
    const first = createTask(repository, {
      id: "task-agent-a",
      agentId: "agent-a",
      dueAtUtc: FIRST_DUE,
      priority: 10,
    });
    createTask(repository, {
      id: "task-agent-b",
      agentId: "agent-b",
      dueAtUtc: SECOND_DUE,
      priority: 10,
    });
    repository.claimDueTask({
      taskId: first.id,
      agentId: first.agentId,
      nowUtc: OBSERVED,
      leaseExpiresAtUtc: ACTIVE_LEASE,
      claimToken: "claim-agent-a",
    });

    expect(repository.findNextTemporalTask(OBSERVED)?.id).toBe("task-agent-b");
    expect(
      repository.findNextTemporalTask("2026-09-08T00:31:00.000Z")?.id,
    ).toBe("task-agent-a");
  });

  it("preserves due, priority, and task-id ordering for equal wake times", () => {
    createTask(repository, {
      id: "task-z",
      agentId: "agent-a",
      dueAtUtc: SECOND_DUE,
      priority: 20,
    });
    createTask(repository, {
      id: "task-b",
      agentId: "agent-b",
      dueAtUtc: SECOND_DUE,
      priority: 10,
    });
    createTask(repository, {
      id: "task-a",
      agentId: "agent-a",
      dueAtUtc: SECOND_DUE,
      priority: 10,
    });

    expect(repository.findNextTemporalTask(OBSERVED)?.id).toBe("task-a");
  });

  it("supports mode-specific kinds and temporary per-agent exclusion", () => {
    createTask(repository, {
      id: "task-model",
      agentId: "agent-a",
      dueAtUtc: FIRST_DUE,
      priority: 10,
      kind: "letter.reply_generation",
    });
    createTask(repository, {
      id: "task-deterministic",
      agentId: "agent-b",
      dueAtUtc: SECOND_DUE,
      priority: 10,
    });

    expect(
      repository.findNextTemporalTask(OBSERVED, [
        "letter.outbound_arrival",
        "letter.return_arrival",
      ])?.id,
    ).toBe("task-deterministic");
    expect(
      repository.findNextTemporalTask(OBSERVED, undefined, ["agent-a"]),
    ).toMatchObject({ id: "task-deterministic", agentId: "agent-b" });
    expect(repository.findNextTemporalTask(OBSERVED, [])).toBeUndefined();
  });
});

function createTask(
  repository: CorrespondenceRepository,
  input: {
    id: string;
    agentId: string;
    dueAtUtc: string;
    priority: number;
    kind?: "letter.outbound_arrival" | "letter.reply_generation";
  },
) {
  return repository.createTemporalTask({
    id: input.id,
    agentId: input.agentId,
    kind: input.kind ?? "letter.outbound_arrival",
    entityId: `letter-${input.id}`,
    dueAtUtc: input.dueAtUtc,
    priority: input.priority,
    idempotencyKey: `scheduler:${input.id}`,
    payload: { letterId: `letter-${input.id}` },
    createdAtUtc: CREATED_AT,
  });
}

function seedAgent(database: Database, agentId: string): void {
  database
    .prepare(
      `INSERT INTO characters(
         id, current_version, status, tier, name, source_type,
         created_at_utc, updated_at_utc
       ) VALUES (?, 1, 'published', 'high_fidelity', ?,
         'original', ?, ?)`,
    )
    .run(agentId, agentId, CREATED_AT, CREATED_AT);
}
