import { performance } from "node:perf_hooks";
import { request as requestHttp } from "node:http";

import {
  CreateSessionResponseSchema,
  SendMessageResponseSchema,
  type SendMessageResponse,
} from "@personasim/contracts";

import { buildApp, type PersonaSimApp } from "../app.js";
import type { ServerConfig } from "../config.js";
import { openDatabase, type Database } from "../db/connection.js";
import type { DatabaseStore } from "../db/store.js";
import { FakeClock } from "../runtime/clock.js";
import type { FixtureTurnBehavior } from "../services/turn-decision-service.js";
import type {
  LongRunSessionKey,
  ScenarioAction,
} from "../scenarios/companion-long-run-v2-types.js";
import { sha256Canonical } from "./companion-long-run-v2-baseline.js";
import {
  LongRunV2Observer,
  type ObservationSlice,
} from "./companion-long-run-v2-observer.js";
import type { LongRunStateSnapshot } from "./companion-long-run-v2-run-types.js";

export interface LongRunHttpResult<T = unknown> {
  status: number;
  latencyMs: number;
  body: T;
}

export interface ScenarioActionResult {
  action: ScenarioAction;
  status: "completed" | "skipped";
  atUtc: string;
  detail?: unknown;
}

export interface LongRunTurnHttpResult {
  http: LongRunHttpResult;
  parsed?: SendMessageResponse;
  observations: ObservationSlice;
}

export interface LongRunRuntimeOptions {
  databasePath: string;
  config: ServerConfig;
  startAtUtc: string;
  initialSessionId: string;
  observer?: LongRunV2Observer;
  fixtureTurnBehavior?: FixtureTurnBehavior;
}

export class LongRunV2Runtime {
  readonly observer: LongRunV2Observer;
  readonly sessions = new Map<LongRunSessionKey, string>();
  readonly nativeFetch: typeof fetch;
  private app: PersonaSimApp | undefined;
  private database: Database | undefined;
  private origin: string | undefined;
  private clock: FakeClock;
  private previousClientMessageId: string | undefined;
  private repeatPreviousClientMessageId = false;

  constructor(private readonly options: LongRunRuntimeOptions) {
    this.clock = new FakeClock(options.startAtUtc);
    this.observer =
      options.observer ?? new LongRunV2Observer(() => this.clock.nowUtc());
    this.sessions.set("S1", options.initialSessionId);
    this.nativeFetch = globalThis.fetch;
  }

  get nowUtc(): string {
    return this.clock.nowUtc();
  }

  get isOpen(): boolean {
    return this.app !== undefined;
  }

  get store(): DatabaseStore {
    if (!this.app) throw new Error("The long-run application is closed.");
    return this.app.personasim.store;
  }

  get currentDatabase(): Database {
    if (!this.database) throw new Error("The long-run database is closed.");
    return this.database;
  }

  async open(): Promise<void> {
    if (this.app) return;
    this.database = openDatabase(this.options.databasePath);
    const wrappedProviderFetch = this.observer.wrapFetch(this.nativeFetch);
    const previousGlobalFetch = globalThis.fetch;
    try {
      // The provider captures fetch at construction time. Restore the process
      // global immediately afterwards so local HTTP requests are not traced as
      // Provider attempts.
      globalThis.fetch = wrappedProviderFetch;
      this.app = await buildApp({
        config: this.options.config,
        database: this.database,
        clock: this.clock,
        seedDemo: false,
        startScheduler: false,
        logger: false,
        llmObservation: {
          onMetric: this.observer.onMetric,
          onLogicalCall: this.observer.onLogicalCall,
        },
        ...(this.options.fixtureTurnBehavior === undefined
          ? {}
          : { fixtureTurnBehavior: this.options.fixtureTurnBehavior }),
      });
    } finally {
      globalThis.fetch = previousGlobalFetch;
    }
    this.origin = await this.app.listen({ host: "127.0.0.1", port: 0 });
    this.restoreSessionMap();
  }

  async close(): Promise<void> {
    if (!this.app) return;
    await this.app.close();
    this.app = undefined;
    this.database = undefined;
    this.origin = undefined;
  }

  async restart(): Promise<void> {
    const nowUtc = this.clock.nowUtc();
    await this.close();
    this.clock = new FakeClock(nowUtc);
    await this.open();
  }

  async applyActions(
    actions: readonly ScenarioAction[] = [],
    agentId: string,
  ): Promise<ScenarioActionResult[]> {
    const results: ScenarioActionResult[] = [];
    for (const action of actions) {
      switch (action.kind) {
        case "advance_clock": {
          if (this.isOpen) {
            const result = await this.request("/api/developer/clock/advance", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ minutes: action.durationMinutes }),
            });
            results.push(completed(action, this.nowUtc, result.body));
          } else {
            this.clock.advance({ minutes: action.durationMinutes });
            results.push(
              completed(action, this.nowUtc, {
                offlineAdvance: true,
                nowUtc: this.nowUtc,
              }),
            );
          }
          break;
        }
        case "set_clock": {
          if (this.isOpen) {
            const result = await this.request("/api/developer/clock/set", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ value: action.atUtc }),
            });
            results.push(completed(action, this.nowUtc, result.body));
          } else {
            this.clock.setUtc(action.atUtc);
            results.push(
              completed(action, this.nowUtc, {
                offlineSet: true,
                nowUtc: this.nowUtc,
              }),
            );
          }
          break;
        }
        case "activate_agent": {
          this.requireOpen();
          const result = await this.request(`/api/agents/${agentId}/activate`, {
            method: "POST",
          });
          results.push(completed(action, this.nowUtc, result.body));
          break;
        }
        case "settle_agent": {
          this.requireOpen();
          const result = await this.request(
            `/api/developer/agents/${agentId}/settle`,
            { method: "POST" },
          );
          results.push(completed(action, this.nowUtc, result.body));
          break;
        }
        case "close_app": {
          const observerCursor = this.observer.cursor();
          await this.close();
          results.push(
            completed(action, this.nowUtc, {
              logicalCallsWhileClosing:
                this.observer.slice(observerCursor).logicalCalls.length,
            }),
          );
          break;
        }
        case "open_app": {
          const observerCursor = this.observer.cursor();
          await this.open();
          results.push(
            completed(action, this.nowUtc, {
              logicalCallsWhileOpening:
                this.observer.slice(observerCursor).logicalCalls.length,
            }),
          );
          break;
        }
        case "restart_app": {
          const beforeRestartSha256 = this.snapshot(agentId).durableSha256;
          const observerCursor = this.observer.cursor();
          await this.restart();
          results.push(
            completed(action, this.nowUtc, {
              beforeRestartSha256,
              afterRestartSha256: this.snapshot(agentId).durableSha256,
              logicalCallsWhileRestarting:
                this.observer.slice(observerCursor).logicalCalls.length,
            }),
          );
          break;
        }
        case "create_session": {
          this.requireOpen();
          const result = await this.request(`/api/agents/${agentId}/sessions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title: `[long-run:${action.key}] 顾澜验证对话`,
            }),
          });
          const parsed = CreateSessionResponseSchema.parse(result.body);
          this.sessions.set(action.key, parsed.session.id);
          results.push(completed(action, this.nowUtc, parsed));
          break;
        }
        case "repeat_same_client_message_id": {
          if (!this.previousClientMessageId) {
            throw new Error("Cannot replay before a client message id exists.");
          }
          this.repeatPreviousClientMessageId = true;
          results.push(
            completed(action, this.nowUtc, {
              clientMessageId: this.previousClientMessageId,
            }),
          );
          break;
        }
        case "set_runtime_state": {
          this.requireOpen();
          const state = this.store.getRuntimeState(agentId);
          if (!state) throw new Error(`Runtime state missing for ${agentId}`);
          this.store.updateRuntimeState({
            ...state,
            ...action.patch,
            asOfUtc: this.nowUtc,
            revision: state.revision + 1,
          });
          results.push(completed(action, this.nowUtc, action.patch));
          break;
        }
        case "set_relationship_state": {
          this.requireOpen();
          const state = this.store.getRuntimeState(agentId);
          if (!state) throw new Error(`Runtime state missing for ${agentId}`);
          this.store.updateRuntimeState({
            ...state,
            asOfUtc: this.nowUtc,
            relationship: { ...state.relationship, ...action.patch },
            revision: state.revision + 1,
          });
          results.push(completed(action, this.nowUtc, action.patch));
          break;
        }
      }
    }
    return results;
  }

  selectSession(key: LongRunSessionKey): string {
    const sessionId = this.sessions.get(key);
    if (!sessionId) throw new Error(`Scenario session ${key} does not exist.`);
    return sessionId;
  }

  nextClientMessageId(fallback: string): string {
    if (this.repeatPreviousClientMessageId) {
      this.repeatPreviousClientMessageId = false;
      return this.previousClientMessageId!;
    }
    this.previousClientMessageId = fallback;
    return fallback;
  }

  async sendMessage(input: {
    agentId: string;
    sessionKey: LongRunSessionKey;
    text: string;
    clientMessageId: string;
  }): Promise<LongRunTurnHttpResult> {
    this.requireOpen();
    const sessionId = this.selectSession(input.sessionKey);
    const cursor = this.observer.cursor();
    const http = await this.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: input.agentId,
        clientMessageId: input.clientMessageId,
        text: input.text,
      }),
    });
    const parsed = SendMessageResponseSchema.safeParse(http.body);
    return {
      http,
      ...(parsed.success ? { parsed: parsed.data } : {}),
      observations: this.observer.slice(cursor),
    };
  }

  snapshot(agentId: string): LongRunStateSnapshot {
    this.requireOpen();
    const database = this.currentDatabase;
    const capturedAtUtc = this.nowUtc;
    const snapshot = {
      capturedAtUtc,
      runtimeState: this.store.getRuntimeState(agentId) ?? null,
      cursor: this.store.getCursor(agentId) ?? null,
      schedule: this.store.listSchedule(agentId),
      scheduleNegotiations: this.store.listScheduleNegotiations({
        agentId,
        limit: 500,
      }),
      settlements: readSettlementSummaries(database, agentId),
      activityEvents: readActivityEventSummaries(database, agentId),
      memories: readTable(database, "memories", "agent_id = ?", [agentId]),
      memoryEvidence: readMemoryEvidence(database, agentId),
      proactiveCandidates: readTable(
        database,
        "proactive_candidates",
        "agent_id = ?",
        [agentId],
      ),
      messages: readMessageSummaries(database, agentId),
      domainEvents: this.store.listDomainEvents(agentId, 500),
      rejectedProposals: this.store.listRejectedProposals(agentId, 500),
      // Retrieval rows contain full input and prompt snapshots. Exact prompts
      // are captured by the observer on the issuing turn; embedding all prior
      // snapshots again here would make the JSONL evidence grow quadratically.
      retrievalRuns: readRetrievalRunSummaries(database, agentId),
      llmCalls: this.store.listLlmCalls(500),
      tableCounts: this.store.tableCounts(),
    };
    return {
      ...snapshot,
      durableSha256: sha256Canonical(snapshot),
    };
  }

  checkpointWal(): void {
    if (!this.database) return;
    this.database.pragma("wal_checkpoint(TRUNCATE)");
  }

  private async request(
    path: string,
    init?: RequestInit,
  ): Promise<LongRunHttpResult> {
    this.requireOpen();
    const started = performance.now();
    // An OS-assigned loopback port can be on Fetch's forbidden-port list.
    // Use Node's HTTP client for this real local socket; nativeFetch remains
    // dedicated to the separately observed Provider transport.
    const request = new Request(new URL(path, this.origin), init);
    const payload =
      request.body === null
        ? undefined
        : Buffer.from(await request.arrayBuffer());
    const response = await new Promise<{ status: number; text: string }>(
      (resolve, reject) => {
        const outgoing = requestHttp(
          request.url,
          {
            method: request.method,
            headers: Object.fromEntries(request.headers),
            signal: request.signal,
          },
          (incoming) => {
            incoming.setEncoding("utf8");
            let text = "";
            incoming.on("data", (chunk: string) => {
              text += chunk;
            });
            incoming.on("error", reject);
            incoming.on("end", () =>
              resolve({ status: incoming.statusCode ?? 0, text }),
            );
          },
        );
        outgoing.on("error", reject);
        outgoing.end(payload);
      },
    );
    const { text } = response;
    let body: unknown = text;
    try {
      body = text === "" ? null : (JSON.parse(text) as unknown);
    } catch {
      // The raw text remains useful evidence for a failed contract.
    }
    return {
      status: response.status,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      body,
    };
  }

  private requireOpen(): void {
    if (!this.app || !this.database || !this.origin) {
      throw new Error("The long-run application is closed.");
    }
  }

  private restoreSessionMap(): void {
    if (!this.app) return;
    const rows = this.database
      ?.prepare("SELECT id, title FROM sessions ORDER BY created_at_utc, rowid")
      .all() as Array<{ id: string; title: string }> | undefined;
    for (const row of rows ?? []) {
      const match = /^\[long-run:(S[1234])\]/u.exec(row.title);
      if (match?.[1]) this.sessions.set(match[1] as LongRunSessionKey, row.id);
    }
  }
}

function completed(
  action: ScenarioAction,
  atUtc: string,
  detail?: unknown,
): ScenarioActionResult {
  return {
    action,
    status: "completed",
    atUtc,
    ...(detail === undefined ? {} : { detail }),
  };
}

function readTable(
  database: Database,
  table: string,
  where: string,
  parameters: unknown[],
): unknown[] {
  const exists = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (exists === undefined) return [];
  return (
    database
      .prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY rowid`)
      .all(...parameters) as Array<Record<string, unknown>>
  ).map(parseJsonColumns);
}

function parseJsonColumns(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (!key.endsWith("_json") || typeof value !== "string")
        return [key, value];
      try {
        return [key.slice(0, -5), JSON.parse(value) as unknown];
      } catch {
        return [key, value];
      }
    }),
  );
}

function readMemoryEvidence(database: Database, agentId: string): unknown[] {
  const exists = database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_evidence'",
    )
    .get();
  if (exists === undefined) return [];
  return (
    database
      .prepare(
        `SELECT e.* FROM memory_evidence e
         INNER JOIN memories m ON m.id = e.memory_id
         WHERE m.agent_id = ? ORDER BY e.rowid`,
      )
      .all(agentId) as Array<Record<string, unknown>>
  ).map(parseJsonColumns);
}

function readRetrievalRunSummaries(
  database: Database,
  agentId: string,
): unknown[] {
  const exists = database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'retrieval_runs'",
    )
    .get();
  if (exists === undefined) return [];
  return database
    .prepare(
      `SELECT id, agent_id, session_id, source_message_id, mode,
        candidate_count, selected_count, created_at_utc
       FROM retrieval_runs WHERE agent_id = ? ORDER BY rowid`,
    )
    .all(agentId);
}

function readSettlementSummaries(
  database: Database,
  agentId: string,
): unknown[] {
  return database
    .prepare(
      `SELECT id, agent_id, from_utc, to_utc, idempotency_key, created_at_utc
       FROM settlements WHERE agent_id = ? ORDER BY rowid`,
    )
    .all(agentId);
}

function readActivityEventSummaries(
  database: Database,
  agentId: string,
): unknown[] {
  return database
    .prepare(
      `SELECT id, agent_id AS agentId, schedule_item_id AS scheduleItemId,
        event_type AS eventType, occurred_at_utc AS occurredAtUtc,
        summary, origin, idempotency_key AS idempotencyKey
       FROM activity_events WHERE agent_id = ? ORDER BY rowid`,
    )
    .all(agentId);
}

function readMessageSummaries(database: Database, agentId: string): unknown[] {
  return database
    .prepare(
      `SELECT id, session_id, agent_id, role, content, message_kind,
        trigger_event_id, client_message_id, in_reply_to_message_id,
        created_at_utc
       FROM messages WHERE agent_id = ? ORDER BY rowid`,
    )
    .all(agentId);
}
