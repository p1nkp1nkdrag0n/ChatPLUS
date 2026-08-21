import type { Database } from "../db/connection.js";

export interface ConversationActivitySnapshot {
  userArrivalEpoch: number;
  inFlightUserTurns: number;
  messageRowid: number;
  lastUserMessageRowid: number;
}

export interface UserTurnLease {
  readonly agentId: string;
  readonly arrivalEpoch: number;
  end(): void;
}

interface ActivityState {
  userArrivalEpoch: number;
  inFlightUserTurns: number;
}

export class ConversationActivityTracker {
  private readonly states = new Map<string, ActivityState>();

  constructor(private readonly database: Database) {}

  /**
   * Call this synchronously when a user request arrives, before it waits on the
   * actor queue. The returned lease must be ended in a finally block.
   */
  beginUserTurn(agentId: string): UserTurnLease {
    const state = this.stateFor(agentId);
    state.userArrivalEpoch += 1;
    state.inFlightUserTurns += 1;
    const arrivalEpoch = state.userArrivalEpoch;
    let ended = false;
    return {
      agentId,
      arrivalEpoch,
      end: () => {
        if (ended) return;
        ended = true;
        const current = this.stateFor(agentId);
        current.inFlightUserTurns = Math.max(0, current.inFlightUserTurns - 1);
      },
    };
  }

  async withUserTurn<T>(
    agentId: string,
    operation: (lease: UserTurnLease) => Promise<T> | T,
  ): Promise<T> {
    const lease = this.beginUserTurn(agentId);
    try {
      return await operation(lease);
    } finally {
      lease.end();
    }
  }

  snapshot(agentId: string): ConversationActivitySnapshot {
    const state = this.stateFor(agentId);
    const row = this.database
      .prepare(
        `SELECT
           COALESCE(MAX(rowid), 0) AS message_rowid,
           COALESCE(MAX(CASE WHEN role = 'user' THEN rowid END), 0)
             AS last_user_message_rowid
         FROM messages
         WHERE agent_id = ?`,
      )
      .get(agentId) as {
      message_rowid: number;
      last_user_message_rowid: number;
    };
    return {
      userArrivalEpoch: state.userArrivalEpoch,
      inFlightUserTurns: state.inFlightUserTurns,
      messageRowid: Number(row.message_rowid),
      lastUserMessageRowid: Number(row.last_user_message_rowid),
    };
  }

  isConversationActive(
    agentId: string,
    nowUtc: string,
    activeWindowMs = 120_000,
  ): boolean {
    if (this.stateFor(agentId).inFlightUserTurns > 0) return true;
    if (activeWindowMs <= 0) return false;
    const row = this.database
      .prepare(
        `SELECT created_at_utc
         FROM messages
         WHERE agent_id = ?
         ORDER BY rowid DESC
         LIMIT 1`,
      )
      .get(agentId) as { created_at_utc: string } | undefined;
    if (row === undefined) return false;
    const latest = Date.parse(row.created_at_utc);
    const now = Date.parse(nowUtc);
    return (
      Number.isFinite(latest) &&
      Number.isFinite(now) &&
      latest >= now - activeWindowMs &&
      latest <= now
    );
  }

  get userArrivalEpochs(): ReadonlyMap<string, number> {
    return new Map(
      [...this.states].map(([agentId, state]) => [
        agentId,
        state.userArrivalEpoch,
      ]),
    );
  }

  private stateFor(agentId: string): ActivityState {
    const existing = this.states.get(agentId);
    if (existing !== undefined) return existing;
    const created = { userArrivalEpoch: 0, inFlightUserTurns: 0 };
    this.states.set(agentId, created);
    return created;
  }
}
