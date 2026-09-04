import { isDeepStrictEqual } from "node:util";

import {
  CharacterVisualProfileSchema,
  EntityIdSchema,
  KeepsakeArchivePeriodSchema,
  KeepsakeAssetSchema,
  KeepsakeDetailResponseSchema,
  KeepsakeFilterOptionsSchema,
  KeepsakeKindSchema,
  KeepsakeSchema,
  KeepsakeSourceTypeSchema,
  UtcDateTimeSchema,
  type CharacterVisualProfile,
  type Keepsake,
  type KeepsakeAsset,
  type KeepsakeFilterOptions,
  type KeepsakeKind,
  type KeepsakeSourceLink,
  type KeepsakeSourceType,
  type KeepsakeVisualSpec,
} from "@personasim/contracts";
import type {
  ExistingKeepsakeSignature,
  KeepsakeSourceCandidate,
} from "@personasim/features";

import type { Database } from "../db/connection.js";
import { projectFuzzyLifeEffectiveAtUtc } from "../domain/fuzzy-life-effective-time.js";
import { createEntityId } from "../domain/id.js";

export interface KeepsakeSourceProjection extends KeepsakeSourceCandidate {
  readonly label: string;
  readonly summary: string;
  readonly sourceEventIds: readonly string[];
  readonly sourceMemoryIds: readonly string[];
  readonly sourceLetterIds: readonly string[];
  readonly snapshot: Readonly<Record<string, unknown>>;
}

export interface CreatePendingKeepsakeInput {
  readonly keepsake: Keepsake;
  readonly semanticKey: string;
  readonly semanticSignature: string;
  readonly source: KeepsakeSourceProjection;
  readonly taskId: string;
  readonly runId: string;
  readonly taskPriority?: number;
  readonly maxAttempts?: number;
}

export interface CreatePendingKeepsakeResult {
  readonly keepsake: Keepsake;
  readonly taskId: string;
  readonly runId: string;
  readonly replayed: boolean;
}

export interface CommitKeepsakeGenerationInput {
  readonly taskId: string;
  readonly claimToken: string;
  readonly keepsakeId: string;
  readonly runId: string;
  readonly asset: KeepsakeAsset;
  readonly provider: string;
  readonly model: string;
  readonly resultHash: string;
  readonly nowUtc: string;
}

export interface RecordKeepsakeFailureInput {
  readonly taskId: string;
  readonly claimToken: string;
  readonly runId: string;
  readonly keepsakeId: string;
  readonly errorCode: string;
  readonly nowUtc: string;
  readonly nextDueAtUtc?: string;
  readonly retryable: boolean;
}

interface KeepsakeRow {
  id: string;
  agent_id: string;
  title: string;
  kind: KeepsakeKind;
  description: string;
  created_by: "user" | "agent";
  owned_by: "user" | "agent";
  given_to: "user" | "agent" | null;
  source_event_ids_json: string;
  source_memory_ids_json: string;
  source_letter_ids_json: string;
  semantic_key: string;
  semantic_signature: string;
  canonicality: "canonical" | "evidence_derived";
  status: Keepsake["status"];
  visual_spec_json: string;
  visual_spec_hash: string;
  primary_asset_id: string | null;
  created_effective_at_utc: string;
  gifted_at_utc: string | null;
  idempotency_key: string;
  created_at_utc: string;
  updated_at_utc: string;
}

interface AssetRow {
  id: string;
  keepsake_id: string;
  storage_key: string;
  thumbnail_storage_key: string;
  mime_type: "image/webp";
  width: number;
  height: number;
  sha256: string;
  thumbnail_sha256: string;
  provider: string;
  model: string;
  prompt_spec_hash: string;
  generation_run_id: string;
  created_at_utc: string;
}

interface SourceRow {
  source_type: KeepsakeSourceType;
  source_id: string;
  agent_id: string;
  label: string;
  effective_at_utc: string | null;
}

interface FuzzyEffectiveTimeRow {
  effective_local_date: string;
  effective_period: string | null;
  temporal_precision: string;
}

interface GenerationRow {
  id: string;
  task_id: string;
  keepsake_id: string;
  agent_id: string;
  generation_epoch: number;
  visual_spec_hash: string;
  status: "pending" | "generating" | "retryable" | "committed" | "failed";
  attempt: number;
  provider: string | null;
  model: string | null;
  error_code: string | null;
  result_hash: string | null;
  created_at_utc: string;
  updated_at_utc: string;
  committed_at_utc: string | null;
}

export class KeepsakeRepository {
  constructor(readonly database: Database) {}

  projectSource(
    agentId: string,
    sourceType: KeepsakeSourceType,
    sourceId: string,
  ): KeepsakeSourceProjection | undefined {
    EntityIdSchema.parse(agentId);
    EntityIdSchema.parse(sourceId);
    KeepsakeSourceTypeSchema.parse(sourceType);
    switch (sourceType) {
      case "life_outcome":
        return this.#projectOutcome(agentId, sourceId);
      case "relationship_milestone":
        return this.#projectMilestone(agentId, sourceId);
      case "reflection":
        return this.#projectReflection(agentId, sourceId);
      case "letter":
        return this.#projectLetter(agentId, sourceId);
    }
  }

  listSignatures(agentId: string): ExistingKeepsakeSignature[] {
    EntityIdSchema.parse(agentId);
    return (
      this.database
        .prepare(
          `SELECT kind, semantic_key, created_effective_at_utc
           FROM keepsakes WHERE agent_id = ? AND status <> 'failed'
           ORDER BY created_effective_at_utc, id`,
        )
        .all(agentId) as Array<{
        kind: KeepsakeKind;
        semantic_key: string;
        created_effective_at_utc: string;
      }>
    ).map((row) => ({
      kind: row.kind,
      semanticKey: row.semantic_key,
      createdEffectiveAtUtc: row.created_effective_at_utc,
    }));
  }

  saveVisualProfile(profile: CharacterVisualProfile): CharacterVisualProfile {
    const value = CharacterVisualProfileSchema.parse(profile);
    this.database
      .prepare(
        `INSERT OR IGNORE INTO character_visual_profiles(
          agent_id, version, character_version,
          stable_appearance_traits_json, period_and_setting,
          material_language_json, image_language_json,
          forbidden_elements_json, profile_hash, created_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        value.agentId,
        value.version,
        value.characterVersion,
        JSON.stringify(value.stableAppearanceTraits),
        value.periodAndSetting,
        JSON.stringify(value.materialLanguage),
        JSON.stringify(value.imageLanguage),
        JSON.stringify(value.forbiddenElements),
        value.profileHash,
        value.createdAtUtc,
      );
    return this.getVisualProfile(value.agentId, value.version)!;
  }

  getVisualProfile(
    agentId: string,
    version?: number,
  ): CharacterVisualProfile | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM character_visual_profiles WHERE agent_id = ?
         ${version === undefined ? "ORDER BY version DESC LIMIT 1" : "AND version = ?"}`,
      )
      .get(...(version === undefined ? [agentId] : [agentId, version])) as
      Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return CharacterVisualProfileSchema.parse({
      version: Number(row.version),
      agentId: String(row.agent_id),
      characterVersion: Number(row.character_version),
      stableAppearanceTraits: parseStringArray(
        row.stable_appearance_traits_json,
      ),
      periodAndSetting: String(row.period_and_setting),
      materialLanguage: parseStringArray(row.material_language_json),
      imageLanguage: parseStringArray(row.image_language_json),
      forbiddenElements: parseStringArray(row.forbidden_elements_json),
      profileHash: String(row.profile_hash),
      createdAtUtc: String(row.created_at_utc),
    });
  }

  createPending(
    input: CreatePendingKeepsakeInput,
  ): CreatePendingKeepsakeResult {
    const keepsake = KeepsakeSchema.parse(input.keepsake);
    if (
      keepsake.status !== "pending" ||
      keepsake.primaryAssetId !== undefined
    ) {
      throw new TypeError("A newly enqueued keepsake must be pending");
    }
    const existing = this.getByIdempotencyKey(keepsake.idempotencyKey);
    if (existing !== undefined) {
      return this.#resolveCreateReplay(input, existing);
    }

    const taskPriority = input.taskPriority ?? 40;
    const maxAttempts = input.maxAttempts ?? 3;
    const transaction = this.database.transaction(
      (): CreatePendingKeepsakeResult => {
        // BEGIN IMMEDIATE serializes competing writers. Re-read after taking
        // the write lock so two processes with different random entity IDs
        // still converge on the same logical artifact.
        const concurrent = this.getByIdempotencyKey(keepsake.idempotencyKey);
        if (concurrent !== undefined) {
          return this.#resolveCreateReplay(input, concurrent);
        }
        this.database
          .prepare(
            `INSERT INTO keepsakes(
            id, agent_id, title, kind, description, created_by, owned_by,
            given_to, source_event_ids_json, source_memory_ids_json,
            source_letter_ids_json, semantic_key, semantic_signature,
            canonicality, status, visual_spec_json, visual_spec_hash,
            primary_asset_id, created_effective_at_utc, gifted_at_utc,
            idempotency_key, created_at_utc, updated_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?,
                    NULL, ?, ?, ?, ?, ?)`,
          )
          .run(
            keepsake.id,
            keepsake.agentId,
            keepsake.title,
            keepsake.kind,
            keepsake.description,
            keepsake.createdBy,
            keepsake.ownedBy,
            keepsake.givenTo ?? null,
            JSON.stringify(keepsake.sourceEventIds),
            JSON.stringify(keepsake.sourceMemoryIds),
            JSON.stringify(keepsake.sourceLetterIds),
            input.semanticKey,
            input.semanticSignature,
            keepsake.canonicality,
            JSON.stringify(keepsake.visualSpecJson),
            keepsake.visualSpecHash,
            keepsake.createdEffectiveAtUtc,
            keepsake.giftedAtUtc ?? null,
            keepsake.idempotencyKey,
            keepsake.createdAtUtc,
            keepsake.updatedAtUtc,
          );
        this.database
          .prepare(
            `INSERT INTO keepsake_sources(
             keepsake_id, source_type, source_id, agent_id, label,
             effective_at_utc, source_snapshot_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            keepsake.id,
            input.source.sourceType,
            input.source.sourceId,
            keepsake.agentId,
            input.source.label,
            input.source.effectiveAtUtc,
            JSON.stringify(input.source.snapshot),
          );
        this.database
          .prepare(
            `INSERT INTO temporal_tasks(
             id, agent_id, kind, entity_id, due_at_utc, priority, status,
             attempt, max_attempts, idempotency_key, payload_json,
             created_at_utc, updated_at_utc
           ) VALUES (?, ?, 'keepsake.generate', ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.taskId,
            keepsake.agentId,
            keepsake.id,
            keepsake.createdAtUtc,
            taskPriority,
            maxAttempts,
            `keepsake-generation:${keepsake.id}:v1`,
            JSON.stringify({
              sourceType: input.source.sourceType,
              sourceId: input.source.sourceId,
              semanticSignature: input.semanticSignature,
              visualSpecHash: keepsake.visualSpecHash,
              generationEpoch: 0,
            }),
            keepsake.createdAtUtc,
            keepsake.createdAtUtc,
          );
        this.database
          .prepare(
            `INSERT INTO keepsake_generation_runs(
             id, task_id, keepsake_id, agent_id, generation_epoch,
             visual_spec_hash, status, attempt, created_at_utc, updated_at_utc
           ) VALUES (?, ?, ?, ?, 0, ?, 'pending', 0, ?, ?)`,
          )
          .run(
            input.runId,
            input.taskId,
            keepsake.id,
            keepsake.agentId,
            keepsake.visualSpecHash,
            keepsake.createdAtUtc,
            keepsake.createdAtUtc,
          );
        return {
          keepsake: this.require(keepsake.id),
          taskId: input.taskId,
          runId: input.runId,
          replayed: false,
        };
      },
    );
    try {
      return transaction.immediate();
    } catch (error) {
      // Recover a cross-connection UNIQUE winner only when every frozen
      // semantic/source/visual field is identical. Integrity failures with no
      // exact winner are never hidden.
      const raced = this.getByIdempotencyKey(keepsake.idempotencyKey);
      if (raced !== undefined) return this.#resolveCreateReplay(input, raced);
      throw error;
    }
  }

  markGenerating(
    taskId: string,
    claimToken: string,
    nowUtc: string,
  ): {
    readonly keepsake: Keepsake;
    readonly runId: string;
  } {
    EntityIdSchema.parse(taskId);
    EntityIdSchema.parse(claimToken);
    UtcDateTimeSchema.parse(nowUtc);
    const transaction = this.database.transaction(() => {
      const task = this.database
        .prepare(
          `SELECT entity_id FROM temporal_tasks
           WHERE id = ? AND kind = 'keepsake.generate'
             AND status = 'claimed' AND claim_token = ?
             AND lease_expires_at_utc > ?`,
        )
        .get(taskId, claimToken, nowUtc) as { entity_id: string } | undefined;
      if (task === undefined)
        throw new Error("Keepsake task claim is not active");
      const run = this.#requireGenerationByTask(taskId);
      if (run.status === "committed") {
        return { keepsake: this.require(task.entity_id), runId: run.id };
      }
      this.database
        .prepare(
          `UPDATE keepsake_generation_runs
           SET status = 'generating', attempt = attempt + 1,
               error_code = NULL, updated_at_utc = ?
           WHERE id = ? AND status IN ('pending', 'retryable')`,
        )
        .run(nowUtc, run.id);
      this.database
        .prepare(
          `UPDATE keepsakes SET status = 'generating', updated_at_utc = ?
           WHERE id = ? AND status IN ('pending', 'failed')`,
        )
        .run(nowUtc, task.entity_id);
      return { keepsake: this.require(task.entity_id), runId: run.id };
    });
    return transaction.immediate();
  }

  commitGeneration(input: CommitKeepsakeGenerationInput): Keepsake {
    const asset = KeepsakeAssetSchema.parse(input.asset);
    UtcDateTimeSchema.parse(input.nowUtc);
    const transaction = this.database.transaction(() => {
      const replay = this.get(input.keepsakeId);
      if (replay?.status === "ready") return replay;
      const task = this.database
        .prepare(
          `SELECT agent_id FROM temporal_tasks
           WHERE id = ? AND entity_id = ? AND kind = 'keepsake.generate'
             AND status = 'claimed' AND claim_token = ?
             AND lease_expires_at_utc > ?`,
        )
        .get(input.taskId, input.keepsakeId, input.claimToken, input.nowUtc) as
        { agent_id: string } | undefined;
      const run = this.#requireGenerationByTask(input.taskId);
      const keepsake = this.require(input.keepsakeId);
      if (
        task === undefined ||
        run.id !== input.runId ||
        run.status !== "generating" ||
        run.visual_spec_hash !== keepsake.visualSpecHash ||
        asset.keepsakeId !== keepsake.id ||
        asset.generationRunId !== run.id ||
        asset.promptSpecHash !== keepsake.visualSpecHash
      ) {
        throw new Error("Keepsake generation commit failed its fenced claim");
      }
      this.database
        .prepare(
          `INSERT INTO keepsake_assets(
             id, keepsake_id, agent_id, storage_key, thumbnail_storage_key,
             mime_type, width, height, sha256, thumbnail_sha256, provider,
             model, prompt_spec_hash, generation_run_id, created_at_utc
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          asset.id,
          asset.keepsakeId,
          keepsake.agentId,
          asset.storageKey,
          asset.thumbnailStorageKey,
          asset.mimeType,
          asset.width,
          asset.height,
          asset.sha256,
          asset.thumbnailSha256,
          asset.provider,
          asset.model,
          asset.promptSpecHash,
          asset.generationRunId,
          asset.createdAtUtc,
        );
      this.database
        .prepare(
          `UPDATE keepsake_generation_runs
           SET status = 'committed', provider = ?, model = ?, result_hash = ?,
               updated_at_utc = ?, committed_at_utc = ?
           WHERE id = ? AND status = 'generating'`,
        )
        .run(
          input.provider,
          input.model,
          input.resultHash,
          input.nowUtc,
          input.nowUtc,
          run.id,
        );
      this.database
        .prepare(
          `UPDATE keepsakes
           SET status = 'ready', primary_asset_id = ?, given_to = 'user',
               gifted_at_utc = ?, updated_at_utc = ?
           WHERE id = ? AND status = 'generating'`,
        )
        .run(asset.id, input.nowUtc, input.nowUtc, keepsake.id);
      this.database
        .prepare(
          `UPDATE temporal_tasks
           SET status = 'completed', claim_token = NULL, claimed_at_utc = NULL,
               lease_expires_at_utc = NULL, completed_at_utc = ?, updated_at_utc = ?
           WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
        )
        .run(input.nowUtc, input.nowUtc, input.taskId, input.claimToken);
      this.database
        .prepare(
          `INSERT INTO domain_events(
             id, agent_id, stream_type, stream_id, stream_version, event_type,
             recorded_at_utc, effective_at_utc, payload_json,
             correlation_id, causation_id, idempotency_key
           ) VALUES (?, ?, 'keepsake', ?, 1, 'keepsake.created', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          createEntityId("event"),
          keepsake.agentId,
          keepsake.id,
          input.nowUtc,
          keepsake.createdEffectiveAtUtc,
          JSON.stringify({
            keepsakeId: keepsake.id,
            sourceIds: [
              ...keepsake.sourceEventIds,
              ...keepsake.sourceMemoryIds,
              ...keepsake.sourceLetterIds,
            ],
          }),
          input.taskId,
          run.id,
          `keepsake-created:${keepsake.id}:v1`,
        );
      return this.require(keepsake.id);
    });
    return transaction.immediate();
  }

  recordFailure(input: RecordKeepsakeFailureInput): void {
    UtcDateTimeSchema.parse(input.nowUtc);
    const transaction = this.database.transaction(() => {
      const task = this.database
        .prepare(
          `SELECT attempt, max_attempts FROM temporal_tasks
           WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
        )
        .get(input.taskId, input.claimToken) as
        { attempt: number; max_attempts: number } | undefined;
      if (task === undefined) throw new Error("Keepsake task claim was lost");
      const retryable = input.retryable && task.attempt < task.max_attempts;
      const nextStatus = retryable ? "retryable" : "failed";
      this.database
        .prepare(
          `UPDATE keepsake_generation_runs
           SET status = ?, error_code = ?, updated_at_utc = ?
           WHERE id = ? AND keepsake_id = ? AND status = 'generating'`,
        )
        .run(
          nextStatus,
          input.errorCode,
          input.nowUtc,
          input.runId,
          input.keepsakeId,
        );
      this.database
        .prepare(
          `UPDATE keepsakes SET status = 'failed', updated_at_utc = ?
           WHERE id = ? AND status = 'generating'`,
        )
        .run(input.nowUtc, input.keepsakeId);
      this.database
        .prepare(
          `UPDATE temporal_tasks
           SET status = ?, due_at_utc = ?, claim_token = NULL,
               claimed_at_utc = NULL, lease_expires_at_utc = NULL,
               last_error_code = ?, updated_at_utc = ?
           WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
        )
        .run(
          retryable ? "retryable" : "dead_letter",
          retryable ? (input.nextDueAtUtc ?? input.nowUtc) : input.nowUtc,
          input.errorCode,
          input.nowUtc,
          input.taskId,
          input.claimToken,
        );
    });
    transaction.immediate();
  }

  get(id: string): Keepsake | undefined {
    const row = this.database
      .prepare("SELECT * FROM keepsakes WHERE id = ?")
      .get(id) as KeepsakeRow | undefined;
    return row === undefined ? undefined : mapKeepsake(row);
  }

  require(id: string): Keepsake {
    const value = this.get(id);
    if (value === undefined) throw new Error(`Keepsake ${id} was not found`);
    return value;
  }

  getByIdempotencyKey(idempotencyKey: string): Keepsake | undefined {
    const row = this.database
      .prepare("SELECT * FROM keepsakes WHERE idempotency_key = ?")
      .get(idempotencyKey) as KeepsakeRow | undefined;
    return row === undefined ? undefined : mapKeepsake(row);
  }

  getDetail(
    id: string,
  ): ReturnType<typeof KeepsakeDetailResponseSchema.parse> | undefined {
    const keepsake = this.get(id);
    if (keepsake === undefined) return undefined;
    const assets = (
      this.database
        .prepare(
          "SELECT * FROM keepsake_assets WHERE keepsake_id = ? ORDER BY id",
        )
        .all(id) as AssetRow[]
    ).map(mapAsset);
    const sources = (
      this.database
        .prepare(
          `SELECT source_type, source_id, agent_id, label, effective_at_utc
           FROM keepsake_sources WHERE keepsake_id = ?
           ORDER BY source_type, source_id`,
        )
        .all(id) as SourceRow[]
    ).map(mapSourceLink);
    return KeepsakeDetailResponseSchema.parse({ keepsake, assets, sources });
  }

  getAsset(assetId: string): KeepsakeAsset | undefined {
    const row = this.database
      .prepare("SELECT * FROM keepsake_assets WHERE id = ?")
      .get(assetId) as AssetRow | undefined;
    return row === undefined ? undefined : mapAsset(row);
  }

  list(
    agentId: string,
    options: {
      readonly limit?: number;
      readonly before?: { atUtc: string; id: string };
      readonly kind?: KeepsakeKind;
      readonly sourceType?: KeepsakeSourceType;
      readonly period?: string;
    } = {},
  ): Keepsake[] {
    EntityIdSchema.parse(agentId);
    const limit = Math.max(1, Math.min(101, options.limit ?? 50));
    const parameters: unknown[] = [agentId];
    const predicates: string[] = [];
    if (options.kind !== undefined) {
      predicates.push("keepsake.kind = ?");
      parameters.push(KeepsakeKindSchema.parse(options.kind));
    }
    if (options.sourceType !== undefined) {
      predicates.push(
        `EXISTS (
           SELECT 1 FROM keepsake_sources source
            WHERE source.keepsake_id = keepsake.id
              AND source.agent_id = keepsake.agent_id
              AND source.source_type = ?
         )`,
      );
      parameters.push(KeepsakeSourceTypeSchema.parse(options.sourceType));
    }
    if (options.period !== undefined) {
      predicates.push("substr(keepsake.created_effective_at_utc, 1, 7) = ?");
      parameters.push(KeepsakeArchivePeriodSchema.parse(options.period));
    }
    if (options.before !== undefined) {
      UtcDateTimeSchema.parse(options.before.atUtc);
      EntityIdSchema.parse(options.before.id);
      predicates.push(
        `(keepsake.created_effective_at_utc < ?
          OR (keepsake.created_effective_at_utc = ? AND keepsake.id < ?))`,
      );
      parameters.push(
        options.before.atUtc,
        options.before.atUtc,
        options.before.id,
      );
    }
    parameters.push(limit);
    return (
      this.database
        .prepare(
          `SELECT keepsake.* FROM keepsakes keepsake
            WHERE keepsake.agent_id = ? AND keepsake.status = 'ready'
              ${predicates.map((predicate) => `AND ${predicate}`).join("\n")}
            ORDER BY keepsake.created_effective_at_utc DESC, keepsake.id DESC
            LIMIT ?`,
        )
        .all(...parameters) as KeepsakeRow[]
    ).map(mapKeepsake);
  }

  listFilterOptions(agentIdInput: string): KeepsakeFilterOptions {
    const agentId = EntityIdSchema.parse(agentIdInput);
    const kinds = this.database
      .prepare(
        `SELECT DISTINCT kind
           FROM keepsakes
          WHERE agent_id = ? AND status = 'ready'
          ORDER BY kind`,
      )
      .all(agentId) as Array<{ kind: unknown }>;
    const sourceTypes = this.database
      .prepare(
        `SELECT DISTINCT source.source_type AS sourceType
           FROM keepsake_sources source
           JOIN keepsakes keepsake
             ON keepsake.id = source.keepsake_id
            AND keepsake.agent_id = source.agent_id
          WHERE keepsake.agent_id = ? AND keepsake.status = 'ready'
          ORDER BY source.source_type`,
      )
      .all(agentId) as Array<{ sourceType: unknown }>;
    const periods = this.database
      .prepare(
        `SELECT DISTINCT substr(created_effective_at_utc, 1, 7) AS period
           FROM keepsakes
          WHERE agent_id = ? AND status = 'ready'
          ORDER BY period DESC`,
      )
      .all(agentId) as Array<{ period: unknown }>;
    return KeepsakeFilterOptionsSchema.parse({
      kinds: kinds.map((row) => row.kind),
      sourceTypes: sourceTypes.map((row) => row.sourceType),
      periods: periods.map((row) => row.period),
    });
  }

  listReferencedStorageKeys(): Set<string> {
    const rows = this.database
      .prepare(
        `SELECT storage_key AS key FROM keepsake_assets
         UNION SELECT thumbnail_storage_key AS key FROM keepsake_assets`,
      )
      .all() as Array<{ key: string }>;
    return new Set(rows.map((row) => row.key));
  }

  isStorageKeyReferenced(storageKey: string): boolean {
    return (
      this.database
        .prepare(
          `SELECT 1 FROM keepsake_assets
           WHERE storage_key = ? OR thumbnail_storage_key = ? LIMIT 1`,
        )
        .get(storageKey, storageKey) !== undefined
    );
  }

  linkToReply(
    keepsakeIdInput: string,
    incomingLetterIdInput: string,
    replyLetterIdInput: string,
    createdAtUtcInput: string,
  ): void {
    const keepsakeId = EntityIdSchema.parse(keepsakeIdInput);
    const incomingLetterId = EntityIdSchema.parse(incomingLetterIdInput);
    const replyLetterId = EntityIdSchema.parse(replyLetterIdInput);
    const createdAtUtc = UtcDateTimeSchema.parse(createdAtUtcInput);
    const keepsake = this.get(keepsakeId);
    if (keepsake === undefined) {
      throw new TypeError("Cannot link an unknown keepsake to a reply");
    }
    this.database
      .prepare(
        `INSERT OR IGNORE INTO keepsake_letter_links(
           reply_letter_id, incoming_letter_id, keepsake_id, agent_id,
           created_at_utc
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        replyLetterId,
        incomingLetterId,
        keepsakeId,
        keepsake.agentId,
        createdAtUtc,
      );

    const linked = this.database
      .prepare(
        `SELECT incoming_letter_id, keepsake_id, agent_id
           FROM keepsake_letter_links WHERE reply_letter_id = ?`,
      )
      .get(replyLetterId) as
      | {
          incoming_letter_id: string;
          keepsake_id: string;
          agent_id: string;
        }
      | undefined;
    if (
      linked?.incoming_letter_id !== incomingLetterId ||
      linked.keepsake_id !== keepsakeId ||
      linked.agent_id !== keepsake.agentId
    ) {
      throw new Error("Reply already has a different keepsake association");
    }
  }

  listReadyKeepsakeIdsForLetter(replyLetterIdInput: string): string[] {
    const replyLetterId = EntityIdSchema.parse(replyLetterIdInput);
    const rows = this.database
      .prepare(
        `SELECT artifact.id
           FROM keepsake_letter_links link
           JOIN keepsakes artifact ON artifact.id = link.keepsake_id
          WHERE link.reply_letter_id = ? AND artifact.status = 'ready'
          ORDER BY artifact.created_effective_at_utc, artifact.id`,
      )
      .all(replyLetterId) as Array<{ id: string }>;
    return rows.map((row) => EntityIdSchema.parse(row.id));
  }

  #requireGenerationByTask(taskId: string): GenerationRow {
    const row = this.database
      .prepare("SELECT * FROM keepsake_generation_runs WHERE task_id = ?")
      .get(taskId) as GenerationRow | undefined;
    if (row === undefined)
      throw new Error("Keepsake generation run was not found");
    return row;
  }

  #requireGenerationByKeepsake(keepsakeId: string): GenerationRow {
    const row = this.database
      .prepare("SELECT * FROM keepsake_generation_runs WHERE keepsake_id = ?")
      .get(keepsakeId) as GenerationRow | undefined;
    if (row === undefined)
      throw new Error("Keepsake generation run was not found");
    return row;
  }

  #resolveCreateReplay(
    input: CreatePendingKeepsakeInput,
    existing: Keepsake,
  ): CreatePendingKeepsakeResult {
    const proposed = KeepsakeSchema.parse(input.keepsake);
    const identity = this.database
      .prepare(
        `SELECT semantic_key, semantic_signature
           FROM keepsakes WHERE id = ?`,
      )
      .get(existing.id) as
      { semantic_key: string; semantic_signature: string } | undefined;
    const sources = this.database
      .prepare(
        `SELECT source_type, source_id, agent_id, label, effective_at_utc,
                source_snapshot_json
           FROM keepsake_sources WHERE keepsake_id = ?
           ORDER BY source_type, source_id`,
      )
      .all(existing.id) as Array<{
      source_type: string;
      source_id: string;
      agent_id: string;
      label: string;
      effective_at_utc: string | null;
      source_snapshot_json: string;
    }>;
    const source = sources[0];
    const sameStory =
      existing.agentId === proposed.agentId &&
      existing.kind === proposed.kind &&
      existing.title === proposed.title &&
      existing.description === proposed.description &&
      existing.createdBy === proposed.createdBy &&
      existing.ownedBy === proposed.ownedBy &&
      existing.givenTo === proposed.givenTo &&
      existing.canonicality === proposed.canonicality &&
      existing.createdEffectiveAtUtc === proposed.createdEffectiveAtUtc &&
      existing.visualSpecHash === proposed.visualSpecHash &&
      isDeepStrictEqual(existing.visualSpecJson, proposed.visualSpecJson) &&
      isDeepStrictEqual(existing.sourceEventIds, proposed.sourceEventIds) &&
      isDeepStrictEqual(existing.sourceMemoryIds, proposed.sourceMemoryIds) &&
      isDeepStrictEqual(existing.sourceLetterIds, proposed.sourceLetterIds);
    const sameSource =
      sources.length === 1 &&
      source !== undefined &&
      source.source_type === input.source.sourceType &&
      source.source_id === input.source.sourceId &&
      source.agent_id === input.source.agentId &&
      source.label === input.source.label &&
      source.effective_at_utc === input.source.effectiveAtUtc &&
      isDeepStrictEqual(
        JSON.parse(source.source_snapshot_json) as unknown,
        input.source.snapshot,
      );
    if (
      identity?.semantic_key !== input.semanticKey ||
      identity.semantic_signature !== input.semanticSignature ||
      !sameStory ||
      !sameSource
    ) {
      throw new Error("Keepsake idempotency key was reused with new content");
    }

    const run = this.#requireGenerationByKeepsake(existing.id);
    if (
      run.agent_id !== existing.agentId ||
      run.visual_spec_hash !== existing.visualSpecHash
    ) {
      throw new Error("Keepsake replay generation identity is inconsistent");
    }
    const task = this.database
      .prepare(`SELECT id, entity_id, kind FROM temporal_tasks WHERE id = ?`)
      .get(run.task_id) as
      { id: string; entity_id: string; kind: string } | undefined;
    if (task?.kind !== "keepsake.generate" || task.entity_id !== existing.id) {
      throw new Error("Keepsake replay task identity is inconsistent");
    }
    return {
      keepsake: existing,
      taskId: task.id,
      runId: run.id,
      replayed: true,
    };
  }

  #projectOutcome(
    agentId: string,
    sourceId: string,
  ): KeepsakeSourceProjection | undefined {
    const row = this.database
      .prepare(
        `SELECT outcome.id, outcome.agent_id, outcome.summary,
                outcome.confidence, outcome.status,
                outcome.effective_local_date, outcome.effective_period,
                outcome.temporal_precision, outcome.outcome_json,
                outcome.source_evidence_ids_json,
                json_extract(version.spec_json, '$.identity.timezone')
                  AS character_timezone
         FROM outcome_records outcome
         JOIN characters character ON character.id = outcome.agent_id
         JOIN character_versions version
           ON version.character_id = character.id
          AND version.version = character.current_version
         WHERE outcome.id = ? AND outcome.agent_id = ?`,
      )
      .get(sourceId, agentId) as
      | (FuzzyEffectiveTimeRow & {
          status: string;
          summary: string;
          confidence: number;
          outcome_json: string;
          source_evidence_ids_json: string;
          character_timezone: unknown;
        })
      | undefined;
    if (row === undefined) return undefined;
    const summary = String(row.summary);
    const status = String(row.status);
    return {
      agentId,
      sourceType: "life_outcome",
      sourceId,
      status:
        status === "observed" || status === "confirmed" ? status : "unknown",
      significance: Number(row.confidence),
      effectiveAtUtc: projectFuzzyEffectiveAtUtc(row, row.character_timezone),
      semanticTags: semanticTags(summary, row.outcome_json),
      label: summary.slice(0, 240),
      summary,
      sourceEventIds: [sourceId],
      sourceMemoryIds: [],
      sourceLetterIds: [],
      snapshot: {
        sourceType: "life_outcome",
        sourceId,
        status,
        summary,
        confidence: Number(row.confidence),
        evidenceIds: parseStringArray(row.source_evidence_ids_json),
      },
    };
  }

  #projectMilestone(
    agentId: string,
    sourceId: string,
  ): KeepsakeSourceProjection | undefined {
    const row = this.database
      .prepare(
        `SELECT milestone.id, milestone.agent_id, milestone.title,
                milestone.summary, milestone.significance,
                milestone.effective_local_date, milestone.effective_period,
                milestone.temporal_precision, milestone.milestone_json,
                json_extract(version.spec_json, '$.identity.timezone')
                  AS character_timezone
         FROM relationship_milestones milestone
         JOIN characters character ON character.id = milestone.agent_id
         JOIN character_versions version
           ON version.character_id = character.id
          AND version.version = character.current_version
         WHERE milestone.id = ? AND milestone.agent_id = ?`,
      )
      .get(sourceId, agentId) as
      | (FuzzyEffectiveTimeRow & {
          title: string;
          summary: string;
          significance: number;
          milestone_json: string;
          character_timezone: unknown;
        })
      | undefined;
    if (row === undefined) return undefined;
    const title = String(row.title);
    const summary = String(row.summary);
    return {
      agentId,
      sourceType: "relationship_milestone",
      sourceId,
      status: "confirmed",
      significance: Number(row.significance),
      effectiveAtUtc: projectFuzzyEffectiveAtUtc(row, row.character_timezone),
      semanticTags: semanticTags(`${title} ${summary}`, row.milestone_json),
      label: title,
      summary,
      sourceEventIds: [sourceId],
      sourceMemoryIds: [],
      sourceLetterIds: [],
      snapshot: {
        sourceType: "relationship_milestone",
        sourceId,
        status: "confirmed",
        title,
        summary,
        significance: Number(row.significance),
      },
    };
  }

  #projectReflection(
    agentId: string,
    sourceId: string,
  ): KeepsakeSourceProjection | undefined {
    const row = this.database
      .prepare(
        `SELECT reflection.id, reflection.agent_id, reflection.summary,
                reflection.effective_local_date, reflection.effective_period,
                reflection.temporal_precision, reflection.reflection_json,
                reflection.source_message_ids_json,
                json_extract(version.spec_json, '$.identity.timezone')
                  AS character_timezone
         FROM reflection_records reflection
         JOIN characters character ON character.id = reflection.agent_id
         JOIN character_versions version
           ON version.character_id = character.id
          AND version.version = character.current_version
         WHERE reflection.id = ? AND reflection.agent_id = ?`,
      )
      .get(sourceId, agentId) as
      | (FuzzyEffectiveTimeRow & {
          summary: string;
          reflection_json: string;
          source_message_ids_json: string;
          character_timezone: unknown;
        })
      | undefined;
    if (row === undefined) return undefined;
    const summary = String(row.summary);
    return {
      agentId,
      sourceType: "reflection",
      sourceId,
      status: "confirmed",
      significance: 0.7,
      effectiveAtUtc: projectFuzzyEffectiveAtUtc(row, row.character_timezone),
      semanticTags: semanticTags(summary, row.reflection_json),
      label: summary.slice(0, 240),
      summary,
      sourceEventIds: [sourceId],
      sourceMemoryIds: [],
      sourceLetterIds: [],
      snapshot: {
        sourceType: "reflection",
        sourceId,
        status: "confirmed",
        summary,
        sourceMessageIds: parseStringArray(row.source_message_ids_json),
      },
    };
  }

  #projectLetter(
    agentId: string,
    sourceId: string,
  ): KeepsakeSourceProjection | undefined {
    const row = this.database
      .prepare(
        `SELECT id, agent_id, direction, status, subject, content_hash,
                COALESCE(opened_at_utc, read_at_utc) AS source_read_at_utc
         FROM letters WHERE id = ? AND agent_id = ?`,
      )
      .get(sourceId, agentId) as
      | {
          status: string;
          subject: string | null;
          direction: string;
          content_hash: string | null;
          source_read_at_utc: string | null;
        }
      | undefined;
    if (row === undefined) return undefined;
    const status = String(row.status) === "read" ? "read" : "unknown";
    const subject =
      row.subject === null || row.subject === undefined
        ? "一封已读书信"
        : String(row.subject).slice(0, 240);
    const effectiveAtUtc =
      row.source_read_at_utc === null || row.source_read_at_utc === undefined
        ? "9999-12-31T23:59:59.999Z"
        : String(row.source_read_at_utc);
    return {
      agentId,
      sourceType: "letter",
      sourceId,
      status,
      significance: 0.75,
      effectiveAtUtc,
      semanticTags: semanticTags(subject),
      label: subject,
      summary: subject,
      sourceEventIds: [],
      sourceMemoryIds: [],
      sourceLetterIds: [sourceId],
      snapshot: {
        sourceType: "letter",
        sourceId,
        status,
        direction: String(row.direction),
        subject,
        contentHash:
          row.content_hash === null ? null : String(row.content_hash),
      },
    };
  }
}

function mapKeepsake(row: KeepsakeRow): Keepsake {
  return KeepsakeSchema.parse({
    id: row.id,
    agentId: row.agent_id,
    title: row.title,
    kind: row.kind,
    description: row.description,
    createdBy: row.created_by,
    ownedBy: row.owned_by,
    ...(row.given_to === null ? {} : { givenTo: row.given_to }),
    sourceEventIds: parseStringArray(row.source_event_ids_json),
    sourceMemoryIds: parseStringArray(row.source_memory_ids_json),
    sourceLetterIds: parseStringArray(row.source_letter_ids_json),
    canonicality: row.canonicality,
    status: row.status,
    visualSpecJson: JSON.parse(row.visual_spec_json) as KeepsakeVisualSpec,
    visualSpecHash: row.visual_spec_hash,
    ...(row.primary_asset_id === null
      ? {}
      : { primaryAssetId: row.primary_asset_id }),
    createdEffectiveAtUtc: row.created_effective_at_utc,
    ...(row.gifted_at_utc === null ? {} : { giftedAtUtc: row.gifted_at_utc }),
    idempotencyKey: row.idempotency_key,
    createdAtUtc: row.created_at_utc,
    updatedAtUtc: row.updated_at_utc,
  });
}

function mapAsset(row: AssetRow): KeepsakeAsset {
  return KeepsakeAssetSchema.parse({
    id: row.id,
    keepsakeId: row.keepsake_id,
    storageKey: row.storage_key,
    thumbnailStorageKey: row.thumbnail_storage_key,
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
    sha256: row.sha256,
    thumbnailSha256: row.thumbnail_sha256,
    provider: row.provider,
    model: row.model,
    promptSpecHash: row.prompt_spec_hash,
    generationRunId: row.generation_run_id,
    createdAtUtc: row.created_at_utc,
  });
}

function mapSourceLink(row: SourceRow): KeepsakeSourceLink {
  const archiveEntryPrefix =
    row.source_type === "life_outcome" ? "outcome_record" : row.source_type;
  const href =
    row.source_type === "letter"
      ? `/letters/${encodeURIComponent(row.source_id)}?agentId=${encodeURIComponent(row.agent_id)}`
      : `/characters/${encodeURIComponent(row.agent_id)}/relationship-archive?entryId=${encodeURIComponent(`${archiveEntryPrefix}:${row.source_id}`)}`;
  return {
    type: row.source_type,
    id: row.source_id,
    label: row.label,
    ...(row.effective_at_utc === null
      ? {}
      : { effectiveAtUtc: row.effective_at_utc }),
    href,
  };
}

function projectFuzzyEffectiveAtUtc(
  row: FuzzyEffectiveTimeRow,
  characterTimezone: unknown,
): string {
  return projectFuzzyLifeEffectiveAtUtc(
    {
      effectiveLocalDate: row.effective_local_date,
      effectivePeriod: row.effective_period,
      temporalPrecision: row.temporal_precision,
    },
    characterTimezone,
  );
}

function parseStringArray(value: unknown): string[] {
  const parsed =
    typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed)) {
    throw new TypeError("Expected a persisted string array");
  }
  const output: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") {
      throw new TypeError("Expected a persisted string array");
    }
    output.push(item);
  }
  return output;
}

function semanticTags(...values: unknown[]): string[] {
  const text = values
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join(" ")
    .toLocaleLowerCase("und");
  const dictionary = [
    "travel",
    "trip",
    "location",
    "journey",
    "旅行",
    "地点",
    "exhibition",
    "performance",
    "concert",
    "cinema",
    "event",
    "展览",
    "演出",
    "电影",
    "food",
    "cooking",
    "recipe",
    "饮食",
    "料理",
    "食谱",
    "flower",
    "season",
    "garden",
    "花",
    "季节",
    "植物",
    "art",
    "drawing",
    "creative",
    "sketch",
    "绘画",
    "创作",
  ];
  const found = dictionary.filter((tag) => text.includes(tag));
  return found.length === 0 ? ["note"] : found;
}
