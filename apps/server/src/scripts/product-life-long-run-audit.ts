import type { Database } from "../db/connection.js";

type Row = Record<string, unknown>;
type Detail = {
  id: string;
  field: string;
  reason: string;
  referenceId?: string;
};

export interface ProductLifeAuditCheck {
  status: "passed" | "failed" | "not_reached";
  passed: boolean | null;
  checked: number;
  invalidCount: number;
  details: Detail[];
}

const selections = {
  daily_life_contexts: "id, local_date, status, intent_ids_json",
  daily_life_intents:
    "id, context_id, local_date, status, thread_ids_json, evidence_message_ids_json",
  life_outcomes:
    "id, intent_id, effective_local_date, outcome_kind, source_evidence_ids_json, thread_ids_json",
  life_threads:
    "id, subject, status, current_stage, revision, last_advanced_local_date, source_message_ids_json",
  dilemma_episodes:
    "id, subject, status, closing_decision_id, source_message_ids_json",
  pressure_episodes: "id, subject, status, source_message_ids_json",
  support_interventions:
    "id, dilemma_id, pressure_episode_id, mode, offered_by, received_by, source_message_id",
  decision_records:
    "id, dilemma_id, subject, authority, decided_by, status, authorized_by_message_id, source_message_ids_json, support_intervention_ids_json",
  action_records:
    "id, decision_id, subject, performed_by, action_kind, source_evidence_ids_json",
  outcome_records:
    "id, decision_id, action_ids_json, cause_kind, status, source_evidence_ids_json",
  reflection_records:
    "id, decision_id, outcome_id, subject, reflected_by, source_message_ids_json",
  relationship_milestones:
    "id, kind, decision_ids_json, outcome_ids_json, reflection_ids_json, intervention_ids_json, source_message_ids_json",
  messages:
    "id, session_id, role, message_kind, client_message_id, created_at_utc",
  message_archive: "id, session_id, role, source_created_at_utc",
  sessions: "id",
  domain_events: "id, event_type, stream_id, recorded_at_utc",
  activity_events: "id",
  memories: "id, status, source_message_id, source_event_id",
  memory_evidence: "id, memory_id, source_type, source_id",
  character_sources: "id",
  schedule_items: "id",
  conversation_checkpoints:
    "id, session_id, status, from_message_id, through_message_id, autobiography_snapshot_id, source_message_count, source_token_estimate",
  autobiography_snapshots:
    "id, source_checkpoint_id, previous_snapshot_id, revision, source_evidence_ids_json",
  autobiography_entries:
    "id, snapshot_id, temporal_status, source_evidence_ids_json, evidence_json",
  event_cards:
    "id, checkpoint_id, temporal_status, source_evidence_ids_json, evidence_json",
} as const;
type Table = keyof typeof selections;

/** SELECT-only evidence audit. It verifies observed references, never the truth
 * of simulated user reports or whether an unobserved behavior would succeed. */
export function auditProductLifeDatabase(database: Database, agentId: string) {
  const rows = Object.fromEntries(
    Object.entries(selections).map(([table, columns]) => [
      table,
      database
        .prepare(
          table === "memory_evidence"
            ? "SELECT e.id, e.memory_id, e.source_type, e.source_id FROM memory_evidence e JOIN memories m ON m.id = e.memory_id WHERE m.agent_id = ? ORDER BY e.id"
            : `SELECT ${columns} FROM ${table} WHERE ${table === "character_sources" ? "character_id" : "agent_id"} = ? ORDER BY id`,
        )
        .all(agentId) as Row[],
    ]),
  ) as Record<Table, Row[]>;
  const indexes = Object.fromEntries(
    Object.entries(rows).map(([table, records]) => [
      table,
      new Map(records.map((row) => [text(row.id), row])),
    ]),
  ) as Record<Table, Map<string, Row>>;
  const counts = Object.fromEntries(
    Object.entries(rows).map(([table, records]) => [table, records.length]),
  );
  const checks: Record<string, ProductLifeAuditCheck> = {};
  const details: Detail[] = [];
  const invalidRowIds = new Set<string>();
  let checked = 0;
  const fail = (
    row: Row,
    field: string,
    reason: string,
    referenceId?: string,
  ) => {
    invalidRowIds.add(text(row.id));
    details.push({
      id: text(row.id),
      field,
      reason,
      ...(referenceId === undefined ? {} : { referenceId }),
    });
  };
  const reference = (
    row: Row,
    field: string,
    id: unknown,
    targets: readonly Table[],
    required = true,
  ) => {
    if ((id === null || id === undefined || id === "") && !required) return;
    checked += 1;
    if (
      typeof id !== "string" ||
      !targets.some((table) => indexes[table].has(id))
    ) {
      fail(
        row,
        field,
        "missing_or_other_agent_reference",
        typeof id === "string" ? id : undefined,
      );
    }
  };
  const references = (
    row: Row,
    field: string,
    targets: readonly Table[],
    requireNonEmpty = false,
  ) => {
    const ids = jsonArray(row[field]);
    if (ids === undefined || (requireNonEmpty && ids.length === 0)) {
      checked += 1;
      fail(row, field, "invalid_or_empty_reference_array");
      return;
    }
    for (const id of ids) reference(row, field, id, targets);
  };
  const runCheck = (
    name: string,
    records: readonly Row[],
    verify: (row: Row) => void,
  ) => {
    details.length = 0;
    checked = 0;
    for (const row of records) verify(row);
    checks[name] = resultCheck(records.length, checked, details);
  };

  runCheck(
    "daily_life_references",
    [
      ...rows.daily_life_contexts,
      ...rows.daily_life_intents,
      ...rows.life_outcomes,
    ],
    (row) => {
      const id = text(row.id);
      if (indexes.daily_life_contexts.has(id)) {
        references(row, "intent_ids_json", ["daily_life_intents"], true);
        for (const intentId of jsonArray(row.intent_ids_json) ?? []) {
          const intent = indexes.daily_life_intents.get(text(intentId));
          if (
            intent !== undefined &&
            (intent.context_id !== id || intent.local_date !== row.local_date)
          )
            fail(
              row,
              "intent_ids_json",
              "intent_context_or_date_mismatch",
              text(intentId),
            );
        }
      } else if (indexes.daily_life_intents.has(id)) {
        reference(row, "context_id", row.context_id, ["daily_life_contexts"]);
        references(row, "thread_ids_json", ["life_threads"]);
        references(row, "evidence_message_ids_json", ["messages"]);
      } else {
        reference(row, "intent_id", row.intent_id, ["daily_life_intents"]);
        references(
          row,
          "source_evidence_ids_json",
          ["domain_events", "messages", "activity_events"],
          true,
        );
        references(row, "thread_ids_json", ["life_threads"]);
        const intent = indexes.daily_life_intents.get(text(row.intent_id));
        if (
          intent !== undefined &&
          intent.local_date !== row.effective_local_date
        )
          fail(row, "effective_local_date", "outcome_intent_date_mismatch");
      }
    },
  );
  runCheck(
    "dilemma_and_support_references",
    [
      ...rows.dilemma_episodes,
      ...rows.pressure_episodes,
      ...rows.support_interventions,
    ],
    (row) => {
      if (indexes.support_interventions.has(text(row.id))) {
        reference(
          row,
          "dilemma_id",
          row.dilemma_id,
          ["dilemma_episodes"],
          false,
        );
        reference(
          row,
          "pressure_episode_id",
          row.pressure_episode_id,
          ["pressure_episodes"],
          false,
        );
        reference(row, "source_message_id", row.source_message_id, [
          "messages",
        ]);
      } else {
        references(row, "source_message_ids_json", ["messages"], true);
        if (indexes.dilemma_episodes.has(text(row.id)))
          reference(
            row,
            "closing_decision_id",
            row.closing_decision_id,
            ["decision_records"],
            false,
          );
      }
    },
  );
  runCheck("decision_references", rows.decision_records, (row) => {
    reference(row, "dilemma_id", row.dilemma_id, ["dilemma_episodes"]);
    references(row, "source_message_ids_json", ["messages"], true);
    references(row, "support_intervention_ids_json", ["support_interventions"]);
    reference(
      row,
      "authorized_by_message_id",
      row.authorized_by_message_id,
      ["messages"],
      row.authority === "delegated",
    );
    const dilemma = indexes.dilemma_episodes.get(text(row.dilemma_id));
    if (dilemma !== undefined && dilemma.subject !== row.subject)
      fail(row, "subject", "decision_dilemma_subject_mismatch");
  });
  runCheck(
    "thread_milestone_references",
    rows.domain_events.filter(
      (row) => row.event_type === "life.thread_milestone_reached",
    ),
    (row) => {
      reference(row, "stream_id", row.stream_id, ["life_threads"]);
    },
  );
  runCheck("action_references", rows.action_records, (row) => {
    reference(row, "decision_id", row.decision_id, ["decision_records"]);
    references(
      row,
      "source_evidence_ids_json",
      ["messages", "domain_events", "activity_events", "life_outcomes"],
      true,
    );
    const decision = indexes.decision_records.get(text(row.decision_id));
    if (decision !== undefined && decision.subject !== row.subject)
      fail(row, "subject", "action_decision_subject_mismatch");
  });
  runCheck("outcome_references", rows.outcome_records, (row) => {
    reference(row, "decision_id", row.decision_id, ["decision_records"]);
    references(
      row,
      "source_evidence_ids_json",
      ["messages", "domain_events", "activity_events", "life_outcomes"],
      true,
    );
    references(
      row,
      "action_ids_json",
      ["action_records"],
      row.cause_kind !== "external",
    );
    for (const actionId of jsonArray(row.action_ids_json) ?? []) {
      const action = indexes.action_records.get(text(actionId));
      if (action !== undefined && action.decision_id !== row.decision_id)
        fail(
          row,
          "action_ids_json",
          "action_belongs_to_other_decision",
          text(actionId),
        );
    }
  });
  runCheck("reflection_references", rows.reflection_records, (row) => {
    reference(row, "decision_id", row.decision_id, ["decision_records"], false);
    reference(row, "outcome_id", row.outcome_id, ["outcome_records"], false);
    references(row, "source_message_ids_json", ["messages"], true);
    const outcome = indexes.outcome_records.get(text(row.outcome_id));
    const decision = indexes.decision_records.get(
      text(row.decision_id ?? outcome?.decision_id),
    );
    if (decision !== undefined && decision.subject !== row.subject)
      fail(row, "subject", "reflection_decision_subject_mismatch");
    if (
      outcome !== undefined &&
      row.decision_id !== null &&
      outcome.decision_id !== row.decision_id
    )
      fail(
        row,
        "outcome_id",
        "outcome_belongs_to_other_decision",
        text(row.outcome_id),
      );
  });
  runCheck(
    "relationship_milestone_references",
    rows.relationship_milestones,
    (row) => {
      references(row, "source_message_ids_json", ["messages"], true);
      references(row, "decision_ids_json", ["decision_records"]);
      references(row, "outcome_ids_json", ["outcome_records"]);
      references(row, "reflection_ids_json", ["reflection_records"]);
      references(row, "intervention_ids_json", ["support_interventions"]);
    },
  );
  runCheck("memory_references", rows.memories, (row) => {
    reference(
      row,
      "source_message_id",
      row.source_message_id,
      ["messages"],
      false,
    );
    reference(
      row,
      "source_event_id",
      row.source_event_id,
      ["activity_events"],
      false,
    );
  });
  runCheck("archive_references", rows.message_archive, (row) => {
    reference(row, "id", row.id, ["messages"]);
    const message = indexes.messages.get(text(row.id));
    if (
      message !== undefined &&
      (message.session_id !== row.session_id || message.role !== row.role)
    )
      fail(row, "id", "archive_message_ownership_mismatch");
  });
  runCheck("memory_evidence_references", rows.memory_evidence, (row) => {
    reference(row, "memory_id", row.memory_id, ["memories"]);
    const targets: Record<string, readonly Table[]> = {
      message: ["messages"],
      activity_event: ["activity_events"],
      schedule_event: ["schedule_items"],
      character_source: ["character_sources"],
    };
    const target = targets[text(row.source_type)];
    // Manual evidence has no backing source table; do not claim to verify it.
    if (target !== undefined)
      reference(row, "source_id", row.source_id, target);
  });
  runCheck("checkpoint_references", rows.conversation_checkpoints, (row) => {
    reference(row, "from_message_id", row.from_message_id, ["message_archive"]);
    reference(row, "through_message_id", row.through_message_id, [
      "message_archive",
    ]);
    for (const field of ["from_message_id", "through_message_id"]) {
      const message = indexes.message_archive.get(text(row[field]));
      if (message !== undefined && message.session_id !== row.session_id)
        fail(
          row,
          field,
          "checkpoint_message_session_mismatch",
          text(row[field]),
        );
    }
    reference(
      row,
      "autobiography_snapshot_id",
      row.autobiography_snapshot_id,
      ["autobiography_snapshots"],
      row.status === "committed",
    );
  });
  const evidenceTargets: Record<string, readonly Table[]> = {
    message_archive: ["message_archive"],
    message: ["messages"],
    activity_event: ["activity_events"],
    domain_event: ["domain_events"],
    memory: ["memories"],
    event_card: ["event_cards"],
    memory_evidence: ["memory_evidence"],
  };
  runCheck(
    "autobiography_evidence_references",
    [...rows.autobiography_entries, ...rows.event_cards],
    (row) => {
      if (indexes.autobiography_entries.has(text(row.id)))
        reference(row, "snapshot_id", row.snapshot_id, [
          "autobiography_snapshots",
        ]);
      else
        reference(
          row,
          "checkpoint_id",
          row.checkpoint_id,
          ["conversation_checkpoints"],
          false,
        );
      const evidence = jsonArray(row.evidence_json);
      if (evidence === undefined || evidence.length === 0) {
        checked += 1;
        fail(row, "evidence_json", "invalid_or_empty_evidence");
        return;
      }
      const evidenceIds = new Set<string>();
      for (const value of evidence) {
        if (!isRecord(value)) {
          checked += 1;
          fail(row, "evidence_json", "invalid_evidence_object");
          continue;
        }
        evidenceIds.add(text(value.id));
        const targets = evidenceTargets[text(value.sourceType)];
        if (targets === undefined) {
          checked += 1;
          fail(
            row,
            "evidence_json",
            "unsupported_source_type",
            text(value.sourceType),
          );
        } else
          reference(row, "evidence_json.sourceId", value.sourceId, targets);
      }
      const ids = jsonArray(row.source_evidence_ids_json);
      if (ids === undefined || ids.length === 0) {
        checked += 1;
        fail(
          row,
          "source_evidence_ids_json",
          "invalid_or_empty_reference_array",
        );
      } else
        for (const id of ids) {
          checked += 1;
          if (!evidenceIds.has(text(id)))
            fail(
              row,
              "source_evidence_ids_json",
              "evidence_not_in_catalog",
              text(id),
            );
        }
    },
  );
  runCheck(
    "autobiography_snapshot_references",
    rows.autobiography_snapshots,
    (row) => {
      reference(row, "source_checkpoint_id", row.source_checkpoint_id, [
        "conversation_checkpoints",
      ]);
      reference(
        row,
        "previous_snapshot_id",
        row.previous_snapshot_id,
        ["autobiography_snapshots"],
        false,
      );
      const checkpoint = indexes.conversation_checkpoints.get(
        text(row.source_checkpoint_id),
      );
      if (
        checkpoint !== undefined &&
        (checkpoint.status !== "committed" ||
          checkpoint.autobiography_snapshot_id !== row.id)
      )
        fail(
          row,
          "source_checkpoint_id",
          "snapshot_not_linked_to_committed_checkpoint",
        );
      const entryEvidence = new Set(
        rows.autobiography_entries
          .filter((entry) => entry.snapshot_id === row.id)
          .flatMap((entry) =>
            (jsonArray(entry.source_evidence_ids_json) ?? []).map(text),
          ),
      );
      const sourceIds = jsonArray(row.source_evidence_ids_json);
      if (sourceIds === undefined || sourceIds.length === 0) {
        checked += 1;
        fail(
          row,
          "source_evidence_ids_json",
          "invalid_or_empty_reference_array",
        );
      } else
        for (const id of sourceIds) {
          checked += 1;
          if (!entryEvidence.has(text(id)))
            fail(
              row,
              "source_evidence_ids_json",
              "snapshot_evidence_not_in_entries",
              text(id),
            );
        }
    },
  );

  const chains = ["user", "character", "shared"].map((subject) => {
    const decisions = rows.decision_records.filter(
      (row) => row.subject === subject,
    );
    const complete = decisions.flatMap((decision) => {
      const actions = rows.action_records.filter(
        (row) => row.decision_id === decision.id && row.subject === subject,
      );
      const actionIds = new Set(actions.map((row) => text(row.id)));
      const outcomes = rows.outcome_records.filter(
        (row) =>
          row.decision_id === decision.id &&
          (jsonArray(row.action_ids_json) ?? []).some((id) =>
            actionIds.has(text(id)),
          ),
      );
      const outcomeIds = new Set(outcomes.map((row) => text(row.id)));
      const reflections = rows.reflection_records.filter(
        (row) =>
          row.subject === subject &&
          (row.decision_id === decision.id ||
            outcomeIds.has(text(row.outcome_id))),
      );
      if (
        actions.length === 0 ||
        outcomes.length === 0 ||
        reflections.length === 0
      )
        return [];
      return [
        {
          dilemmaId: text(decision.dilemma_id),
          decisionId: text(decision.id),
          actionIds: [...actionIds],
          outcomeIds: [...outcomeIds],
          reflectionIds: reflections.map((row) => text(row.id)),
        },
      ];
    });
    const invalidChains = complete.filter((chain) =>
      [
        chain.dilemmaId,
        chain.decisionId,
        ...chain.actionIds,
        ...chain.outcomeIds,
        ...chain.reflectionIds,
      ].some((id) => invalidRowIds.has(id)),
    );
    checks[`${subject}_complete_causal_chain`] = resultCheck(
      complete.length,
      complete.length,
      invalidChains.map((chain) => ({
        id: chain.decisionId,
        field: "chain",
        reason: "causal_reference_checks_failed",
      })),
    );
    return {
      subject,
      dilemmas: rows.dilemma_episodes.filter((row) => row.subject === subject)
        .length,
      decisions: decisions.length,
      completeChains: complete.length,
      samples: complete.slice(0, 10),
    };
  });
  const stateRows = database
    .prepare(
      "SELECT revision, updated_at_utc, state_json FROM runtime_states WHERE agent_id = ?",
    )
    .all(agentId) as Row[];
  const state = stateRows[0];
  const snapshots = rows.autobiography_snapshots;
  return {
    schemaVersion: "product-life-database-audit-v1",
    agentId,
    boundary:
      "Read-only structural evidence for simulated dialogue; no semantic truth, human impact, restart correctness or unobserved behavior is inferred.",
    counts,
    eventsByType: groupCounts(rows.domain_events, "event_type"),
    subjects: chains,
    lifeProgress: {
      localDates: rows.daily_life_contexts
        .map((row) => text(row.local_date))
        .sort(),
      contextStatuses: groupCounts(rows.daily_life_contexts, "status"),
      outcomeKinds: groupCounts(rows.life_outcomes, "outcome_kind"),
      threadMilestoneEventCount: rows.domain_events.filter(
        (row) => row.event_type === "life.thread_milestone_reached",
      ).length,
      threads: rows.life_threads.map((row) => ({
        id: text(row.id),
        subject: text(row.subject),
        status: text(row.status),
        stage: text(row.current_stage),
        revision: number(row.revision),
        lastAdvancedLocalDate: nullableText(row.last_advanced_local_date),
      })),
    },
    continuity: {
      checkpointStatuses: groupCounts(rows.conversation_checkpoints, "status"),
      memoryStatuses: groupCounts(rows.memories, "status"),
      latestAutobiographyRevision: Math.max(
        0,
        ...snapshots.map((row) => number(row.revision)),
      ),
    },
    messages: {
      byRole: groupCounts(rows.messages, "role"),
      byKind: groupCounts(rows.messages, "message_kind"),
      withClientMessageId: rows.messages.filter(
        (row) => row.client_message_id !== null,
      ).length,
    },
    state:
      state === undefined
        ? null
        : {
            revision: number(state.revision),
            updatedAtUtc: text(state.updated_at_utc),
            numericValues: numericValues(parseJson(state.state_json)),
          },
    checks,
  };
}

function resultCheck(
  observed: number,
  checked: number,
  details: readonly Detail[],
): ProductLifeAuditCheck {
  const passed = observed === 0 || checked === 0 ? null : details.length === 0;
  return {
    status: passed === null ? "not_reached" : passed ? "passed" : "failed",
    passed,
    checked,
    invalidCount: details.length,
    details: details.slice(0, 20),
  };
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function parseJson(value: unknown): unknown {
  try {
    return typeof value === "string"
      ? (JSON.parse(value) as unknown)
      : undefined;
  } catch {
    return undefined;
  }
}
function jsonArray(value: unknown): unknown[] | undefined {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed : undefined;
}
function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function groupCounts(
  rows: readonly Row[],
  field: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = text(row[field]);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
function numericValues(value: unknown, prefix = ""): Record<string, number> {
  if (!isRecord(value)) return {};
  const result: Record<string, number> = {};
  for (const [key, child] of Object.entries(value)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (typeof child === "number" && Number.isFinite(child))
      result[path] = child;
    else if (isRecord(child)) Object.assign(result, numericValues(child, path));
  }
  return result;
}
