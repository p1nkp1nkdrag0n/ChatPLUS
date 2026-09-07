import {
  PressureEpisodeSchema,
  type PressureEpisode,
} from "@personasim/contracts";
import type { DatabaseStore } from "../db/store.js";
import { LifeRepository } from "../repositories/life-repository.js";
import { MemoryValidityRepository } from "../repositories/memory-validity-repository.js";
import {
  analyzeStateAttributions,
  STATE_ATTRIBUTION_VERSION,
} from "./fuzzy-life-evidence.js";
import { parseScaleMetric } from "./fuzzy-life-language.js";

interface Contribution {
  source_message_id: string;
  source_hash: string | null;
  before_json: string | null;
  after_json: string;
}
interface Source {
  id: string;
  content: string;
  role: string;
  created_at_utc: string;
}
export interface PressureCorrectionResult {
  changed: boolean;
  projection: "active" | "invalidated";
  retainedSourceMessageIds: string[];
  invalidatedSourceMessageIds: string[];
  dependencies: {
    dailyContextIds: string[];
    interventionIds: string[];
    derivedArtifacts: Array<{ derivedType: string; derivedId: string }>;
  };
}

/** Operator-directed evidence correction. Run on a backed-up instance/copy.
 * It does not reinterpret the whole source message or change pressure to
 * "resolved" merely because its evidence was invalidated. */
export class PressureEvidenceCorrectionService {
  private readonly repository: LifeRepository;
  private readonly validity: MemoryValidityRepository;
  constructor(private readonly store: DatabaseStore) {
    this.repository = new LifeRepository(store.database);
    this.validity = new MemoryValidityRepository(store);
  }

  correct(input: {
    agentId: string;
    pressureEpisodeId: string;
    sourceMessageIds: readonly string[];
    reason: string;
    nowUtc: string;
  }): PressureCorrectionResult {
    if (!input.reason.trim() || input.sourceMessageIds.length === 0)
      throw new Error("Pressure correction requires sources and a reason");
    return this.store.transaction(() => {
      const before = this.repository.findPressure(
        input.agentId,
        input.pressureEpisodeId,
        { includeInvalidated: true },
      );
      if (!before) throw new Error("Pressure episode not found");
      const previous = this.store.database
        .prepare(
          `SELECT source_message_id FROM pressure_evidence_invalidations WHERE agent_id = ? AND pressure_episode_id = ?`,
        )
        .all(input.agentId, before.id) as Array<{ source_message_id: string }>;
      const invalid = new Set(previous.map((item) => item.source_message_id));
      const requested = [...new Set(input.sourceMessageIds)];
      if (
        requested.some(
          (id) => !before.sourceMessageIds.includes(id) && !invalid.has(id),
        )
      )
        throw new Error(
          "Correction source is not evidence for this pressure episode",
        );
      const added = requested.filter((id) => !invalid.has(id));
      let dependencies = this.actualDependencies(input.agentId, before.id);
      if (added.length === 0)
        return {
          changed: false,
          projection: this.repository.findPressure(input.agentId, before.id)
            ? "active"
            : "invalidated",
          retainedSourceMessageIds: before.sourceMessageIds.filter(
            (id) => !invalid.has(id),
          ),
          invalidatedSourceMessageIds: [...invalid],
          dependencies,
        };
      for (const id of added) {
        const source = this.validity.readSource(input.agentId, "message", id);
        this.store.database
          .prepare(
            `INSERT INTO pressure_evidence_invalidations
          (agent_id, pressure_episode_id, subject, source_message_id, source_hash, reason, attribution_version, invalidated_at_utc)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.agentId,
            before.id,
            before.subject,
            id,
            source?.sourceHash ?? null,
            input.reason,
            STATE_ATTRIBUTION_VERSION,
            input.nowUtc,
          );
        invalid.add(id);
      }
      const remaining = before.sourceMessageIds.filter(
        (id) => !invalid.has(id),
      );
      const rebuilt = this.rebuild(before, remaining, invalid, input.nowUtc);
      this.store.database
        .prepare(
          `INSERT INTO pressure_projection_validity(agent_id, pressure_episode_id, state, updated_at_utc)
        VALUES (?, ?, ?, ?) ON CONFLICT(agent_id, pressure_episode_id) DO UPDATE SET state = excluded.state, updated_at_utc = excluded.updated_at_utc`,
        )
        .run(
          input.agentId,
          before.id,
          rebuilt ? "active" : "invalidated",
          input.nowUtc,
        );
      if (rebuilt)
        this.repository.updatePressure(rebuilt, { recordContribution: false });
      dependencies = this.actualDependencies(input.agentId, before.id);
      // A complete before snapshot preserves every old source and numeric
      // contribution even when the mutable row has a smaller current projection.
      const result: PressureCorrectionResult = {
        changed: true,
        projection: rebuilt ? "active" : "invalidated",
        retainedSourceMessageIds: rebuilt?.sourceMessageIds ?? remaining,
        invalidatedSourceMessageIds: [...invalid],
        dependencies,
      };
      this.store.database
        .prepare(
          `INSERT INTO pressure_evidence_corrections
        (agent_id, pressure_episode_id, source_message_ids_json, reason, before_json, after_json, dependencies_json, recorded_at_utc)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.agentId,
          before.id,
          JSON.stringify(added),
          input.reason,
          JSON.stringify(before),
          rebuilt ? JSON.stringify(rebuilt) : null,
          JSON.stringify(dependencies),
          input.nowUtc,
        );
      if (!rebuilt)
        this.excludeDailyReferences(input.agentId, before.id, input.nowUtc);
      for (const artifact of dependencies.derivedArtifacts) {
        this.store.database
          .prepare(
            `UPDATE memory_derived_validity SET state = 'needs_review', validator_version = ?, updated_at_utc = ?
          WHERE agent_id = ? AND derived_type = ? AND derived_id = ?`,
          )
          .run(
            STATE_ATTRIBUTION_VERSION,
            input.nowUtc,
            input.agentId,
            artifact.derivedType,
            artifact.derivedId,
          );
        if (artifact.derivedType === "event_card")
          this.store.database
            .prepare(
              "UPDATE event_cards SET status = 'needs_review' WHERE agent_id = ? AND id = ?",
            )
            .run(input.agentId, artifact.derivedId);
      }
      const revision =
        (
          this.store.database
            .prepare(
              "SELECT COALESCE(MAX(stream_version), 0) AS revision FROM domain_events WHERE agent_id = ? AND stream_type = 'pressure_correction' AND stream_id = ?",
            )
            .get(input.agentId, before.id) as { revision: number }
        ).revision + 1;
      this.store.insertDomainEvent({
        agentId: input.agentId,
        streamType: "pressure_correction",
        streamId: before.id,
        streamVersion: revision,
        eventType: "life.pressure_evidence_invalidated",
        recordedAtUtc: input.nowUtc,
        payload: {
          ...result,
          pressureEpisodeId: before.id,
          reason: input.reason,
          attributionVersion: STATE_ATTRIBUTION_VERSION,
        },
        idempotencyKey: `pressure-correction:${before.id}:${[...invalid].sort().join(":")}`,
      });
      return result;
    });
  }

  private rebuild(
    before: PressureEpisode,
    remaining: string[],
    invalid: Set<string>,
    nowUtc: string,
  ): PressureEpisode | undefined {
    let sources = remaining
      .map(
        (id) =>
          this.store.database
            .prepare(
              "SELECT id, content, role, created_at_utc FROM messages WHERE agent_id = ? AND id = ?",
            )
            .get(before.agentId, id) as Source | undefined,
      )
      .filter(
        (source): source is Source =>
          source !== undefined &&
          ["assistant", "user"].includes(source.role) &&
          !this.validity.messageSourceNeedsReview(before.agentId, source.id),
      )
      .sort((left, right) =>
        left.created_at_utc.localeCompare(right.created_at_utc),
      );
    const journal = this.store.database
      .prepare(
        `SELECT source_message_id, source_hash, before_json, after_json FROM pressure_contribution_journal
      WHERE agent_id = ? AND pressure_episode_id = ? ORDER BY sequence`,
      )
      .all(before.agentId, before.id) as Contribution[];
    sources = sources.filter((source) =>
      journal
        .filter(
          (entry) =>
            entry.source_message_id === source.id && entry.source_hash !== null,
        )
        .every(
          (entry) =>
            this.validity.readSource(before.agentId, "message", source.id)
              ?.sourceHash === entry.source_hash,
        ),
    );
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    let rebuilt: PressureEpisode | undefined;
    // Replay retained journal contributions. Explicit self-reported scales are
    // absolute observations; other numeric transitions retain their old delta.
    for (const entry of journal) {
      const source = sourceById.get(entry.source_message_id);
      if (!source || invalid.has(source.id)) continue;
      if (
        entry.source_hash !== null &&
        this.validity.readSource(before.agentId, "message", source.id)
          ?.sourceHash !== entry.source_hash
      )
        continue;
      const after = PressureEpisodeSchema.parse(JSON.parse(entry.after_json));
      const prior =
        entry.before_json === null
          ? undefined
          : PressureEpisodeSchema.parse(JSON.parse(entry.before_json));
      if (
        !rebuilt &&
        after.sourceMessageIds.every(
          (id) => !invalid.has(id) && sourceById.has(id),
        )
      ) {
        rebuilt = after;
      } else if (!rebuilt) {
        rebuilt = this.fromSelfReport(before, source);
      } else {
        const ownText = this.selfText(before, source);
        const currentPressure =
          parseScaleMetric(ownText, "pressure") ??
          clamp(
            rebuilt.currentPressure +
              after.currentPressure -
              (prior?.currentPressure ?? after.initialPressure),
          );
        rebuilt = {
          ...rebuilt,
          currentPressure,
          metricOrigin:
            parseScaleMetric(ownText, "pressure") === undefined
              ? "algorithm_update"
              : "explicit_self_report",
          currentClarity:
            parseScaleMetric(ownText, "clarity") ??
            clamp(
              rebuilt.currentClarity +
                after.currentClarity -
                (prior?.currentClarity ?? after.initialClarity),
            ),
          currentFeltUnderstood: clamp(
            rebuilt.currentFeltUnderstood +
              after.currentFeltUnderstood -
              (prior?.currentFeltUnderstood ?? after.initialFeltUnderstood),
          ),
          sourceMessageIds: [
            ...new Set([...rebuilt.sourceMessageIds, source.id]),
          ],
          latestEvidenceMessageId: source.id,
          interventionIds: [
            ...new Set([
              ...rebuilt.interventionIds,
              ...after.interventionIds.filter(
                (id) => !prior?.interventionIds.includes(id),
              ),
            ]),
          ],
          outcomeIds: [
            ...new Set([
              ...rebuilt.outcomeIds,
              ...after.outcomeIds.filter(
                (id) => !prior?.outcomeIds.includes(id),
              ),
            ]),
          ],
        };
      }
    }
    // Legacy rows have no per-write journal. Rebuild their supported self
    // reports from the real message text, never by carrying the bad aggregate.
    for (const source of sources) {
      if (rebuilt?.sourceMessageIds.includes(source.id)) continue;
      const own = this.fromSelfReport(before, source);
      if (!own) continue;
      if (!rebuilt) rebuilt = own;
      else
        rebuilt = {
          ...rebuilt,
          currentPressure:
            parseScaleMetric(this.selfText(before, source), "pressure") ??
            rebuilt.currentPressure,
          currentClarity:
            parseScaleMetric(this.selfText(before, source), "clarity") ??
            rebuilt.currentClarity,
          sourceMessageIds: [...rebuilt.sourceMessageIds, source.id],
          latestEvidenceMessageId: source.id,
        };
    }
    if (!rebuilt) return undefined;
    // Keep other still-current historical references (for example a completed
    // action) even when an unjournaled legacy row cannot recover their numeric
    // effect. Only replayed contributions/self reports determine the metrics.
    const retained = sources.map((source) => source.id);
    if (retained.length === 0) return undefined;
    const base = { ...rebuilt };
    delete base.resolutionEvidenceMessageId;
    const zeroSupported =
      rebuilt.currentPressure === 0 &&
      sources.some(
        (source) =>
          source.id === rebuilt.latestEvidenceMessageId &&
          parseScaleMetric(this.selfText(before, source), "pressure") === 0,
      );
    return PressureEpisodeSchema.parse({
      ...base,
      status: zeroSupported
        ? "resolved"
        : rebuilt.currentPressure < rebuilt.initialPressure
          ? "improving"
          : rebuilt.currentPressure > rebuilt.initialPressure
            ? "worsening"
            : "open",
      sourceMessageIds: retained,
      ...(zeroSupported
        ? { resolutionEvidenceMessageId: rebuilt.latestEvidenceMessageId }
        : {}),
      updatedAtUtc: nowUtc,
    });
  }

  private selfText(episode: PressureEpisode, source: Source): string {
    if (
      source.role !==
      (episode.subject === "character"
        ? "assistant"
        : episode.subject === "user"
          ? "user"
          : "unsupported")
    )
      return "";
    return analyzeStateAttributions({
      text: source.content,
      speakerRole: source.role === "assistant" ? "character" : "user",
      sourceMessageId: source.id,
    })
      .filter(
        (candidate) =>
          candidate.experiencer === "speaker" &&
          candidate.modality === "asserted",
      )
      .map((candidate) => candidate.sourceText)
      .join("，");
  }

  private fromSelfReport(
    before: PressureEpisode,
    source: Source,
  ): PressureEpisode | undefined {
    const own = this.selfText(before, source);
    if (
      !own ||
      !analyzeStateAttributions({
        text: source.content,
        speakerRole: source.role === "assistant" ? "character" : "user",
        sourceMessageId: source.id,
      }).some(
        (candidate) =>
          candidate.kind === "pressure" &&
          candidate.experiencer === "speaker" &&
          candidate.modality === "asserted",
      )
    )
      return undefined;
    const pressure = parseScaleMetric(own, "pressure") ?? 0.72;
    const clarity = parseScaleMetric(own, "clarity") ?? 0.45;
    const base = { ...before };
    delete base.resolutionEvidenceMessageId;
    return {
      ...base,
      triggerSummary: own,
      status: "open",
      metricOrigin:
        parseScaleMetric(own, "pressure") === undefined
          ? "algorithm_initial"
          : "explicit_self_report",
      initialPressure: pressure,
      currentPressure: pressure,
      initialClarity: clarity,
      currentClarity: clarity,
      initialFeltUnderstood: 0.2,
      currentFeltUnderstood: 0.2,
      sourceMessageIds: [source.id],
      latestEvidenceMessageId: source.id,
      interventionIds: [],
      outcomeIds: [],
    };
  }

  private actualDependencies(
    agentId: string,
    pressureId: string,
  ): PressureCorrectionResult["dependencies"] {
    const references = this.store.database
      .prepare(
        `SELECT DISTINCT d.derived_type AS derivedType, d.derived_id AS derivedId, e.id AS sourceId
      FROM memory_derivation_dependencies d JOIN domain_events e ON e.id = d.source_id
      WHERE d.agent_id = ? AND d.source_type = 'domain_event' AND e.agent_id = d.agent_id AND e.stream_id = ? AND e.stream_type = 'pressure_episode'`,
      )
      .all(agentId, pressureId) as Array<{
      derivedType: string;
      derivedId: string;
      sourceId: string;
    }>;
    return {
      dailyContextIds: (
        this.store.database
          .prepare(
            `SELECT id FROM daily_life_contexts WHERE agent_id = ? AND EXISTS
        (SELECT 1 FROM json_each(current_pressure_episode_ids_json) WHERE value = ?)`,
          )
          .all(agentId, pressureId) as Array<{ id: string }>
      ).map((row) => row.id),
      interventionIds: (
        this.store.database
          .prepare(
            "SELECT id FROM support_interventions WHERE agent_id = ? AND pressure_episode_id = ?",
          )
          .all(agentId, pressureId) as Array<{ id: string }>
      ).map((row) => row.id),
      derivedArtifacts: [
        ...new Map(
          references
            .filter(
              (ref) =>
                this.validity.readSource(
                  agentId,
                  "domain_event",
                  ref.sourceId,
                ) === undefined,
            )
            .map(({ derivedType, derivedId }) => [
              `${derivedType}:${derivedId}`,
              { derivedType, derivedId },
            ]),
        ).values(),
      ],
    };
  }

  private excludeDailyReferences(
    agentId: string,
    pressureId: string,
    nowUtc: string,
  ): void {
    const rows = this.store.database
      .prepare(
        "SELECT id, context_json FROM daily_life_contexts WHERE agent_id = ?",
      )
      .all(agentId) as Array<{ id: string; context_json: string }>;
    for (const row of rows) {
      const context = JSON.parse(row.context_json) as {
        currentPressureEpisodeIds: string[];
        revision: number;
        updatedAtUtc: string;
      };
      if (!context.currentPressureEpisodeIds.includes(pressureId)) continue;
      context.currentPressureEpisodeIds =
        context.currentPressureEpisodeIds.filter((id) => id !== pressureId);
      context.revision += 1;
      context.updatedAtUtc = nowUtc;
      this.store.database
        .prepare(
          `UPDATE daily_life_contexts SET current_pressure_episode_ids_json = ?, context_json = ?, revision = ?, updated_at_utc = ? WHERE agent_id = ? AND id = ?`,
        )
        .run(
          JSON.stringify(context.currentPressureEpisodeIds),
          JSON.stringify(context),
          context.revision,
          nowUtc,
          agentId,
          row.id,
        );
    }
  }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
