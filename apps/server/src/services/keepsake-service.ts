import { createHash } from "node:crypto";

import {
  CharacterVisualProfileSchema,
  EntityIdSchema,
  KeepsakeDetailResponseSchema,
  KeepsakeKindSchema,
  KeepsakeListQuerySchema,
  KeepsakePageResponseSchema,
  KeepsakeSourceTypeSchema,
  KeepsakeSummaryResponseSchema,
  KeepsakeVisualSpecSchema,
  UtcDateTimeSchema,
  VisualPromptSpecSchema,
  type CharacterSpec,
  type CharacterVisualProfile,
  type Keepsake,
  type KeepsakeDetailResponse,
  type KeepsakeKind,
  type KeepsakeListQuery,
  type KeepsakePageResponse,
  type KeepsakeSourceType,
  type KeepsakeVisualSpec,
} from "@personasim/contracts";
import {
  KeepsakeTemplateEngine,
  buildKeepsakeSemanticKey,
  canonicalCorrespondenceJson,
  evaluateKeepsakeEligibility,
  isStructuredKeepsakeKind,
} from "@personasim/features";
import {
  createFixtureImageGenerationProvider,
  type GeneratedImageAsset,
  type ImageGenerationProvider,
} from "@personasim/providers";

import type { DatabaseStore } from "../db/store.js";
import { createEntityId } from "../domain/id.js";
import type { CorrespondenceRepository } from "../repositories/correspondence-repository.js";
import type {
  KeepsakeRepository,
  KeepsakeSourceProjection,
} from "../repositories/keepsake-repository.js";
import type { Clock } from "../runtime/clock.js";
import type { SseHub } from "../sse/hub.js";
import type {
  KeepsakeAssetStore,
  StoredKeepsakeAssetFiles,
} from "./keepsake-asset-store.js";
import type { RelationshipArtifactsPromptContext } from "./conversation-context-service.js";

export type KeepsakeMode = "off" | "shadow" | "enforced";

export interface KeepsakeServiceOptions {
  readonly mode: KeepsakeMode;
  readonly imageProvider?: ImageGenerationProvider;
  readonly templateEngine?: KeepsakeTemplateEngine;
  readonly leaseMs?: number;
  readonly retryDelayMs?: number;
  readonly onBackgroundError?: (errorCode: string) => void;
}

export interface EnqueueKeepsakeResult {
  readonly eligible: boolean;
  readonly enqueued: boolean;
  readonly reasonCodes: readonly string[];
  readonly kind: KeepsakeKind;
  readonly keepsake?: Keepsake;
  readonly taskId?: string;
  readonly replayed?: boolean;
}

export interface KeepsakeAssetReadResult {
  readonly bytes: Buffer;
  readonly mimeType: "image/webp";
  readonly etag: string;
}

export class KeepsakeService {
  readonly #mode: KeepsakeMode;
  readonly #provider: ImageGenerationProvider;
  readonly #templates: KeepsakeTemplateEngine;
  readonly #leaseMs: number;
  readonly #retryDelayMs: number;
  readonly #onBackgroundError: ((errorCode: string) => void) | undefined;

  constructor(
    private readonly repository: KeepsakeRepository,
    private readonly correspondence: CorrespondenceRepository,
    private readonly store: DatabaseStore,
    private readonly assets: KeepsakeAssetStore,
    private readonly clock: Clock,
    private readonly sse: SseHub,
    options: KeepsakeServiceOptions,
  ) {
    this.#mode = options.mode;
    this.#provider =
      options.imageProvider ?? createFixtureImageGenerationProvider();
    this.#templates = options.templateEngine ?? new KeepsakeTemplateEngine();
    this.#leaseMs = positiveInteger(options.leaseMs ?? 300_000, "leaseMs");
    this.#retryDelayMs = positiveInteger(
      options.retryDelayMs ?? 60_000,
      "retryDelayMs",
    );
    this.#onBackgroundError = options.onBackgroundError;
  }

  enqueueSource(input: {
    readonly agentId: string;
    readonly sourceType: KeepsakeSourceType;
    readonly sourceId: string;
    readonly requestedKind?: KeepsakeKind;
    readonly observedNowUtc?: string;
  }): EnqueueKeepsakeResult {
    const nowUtc = input.observedNowUtc ?? this.clock.nowUtc();
    const source = this.repository.projectSource(
      input.agentId,
      input.sourceType,
      input.sourceId,
    );
    if (source === undefined) {
      throw new KeepsakeServiceError(
        "source_not_found",
        "Keepsake source was not found",
      );
    }
    const decision = evaluateKeepsakeEligibility(
      source,
      this.repository.listSignatures(input.agentId),
      nowUtc,
      input.requestedKind === undefined
        ? {}
        : { requestedKind: input.requestedKind },
    );
    const idempotencyKey = `keepsake:${source.sourceType}:${source.sourceId}:${decision.kind}:v1`;
    const existing = this.repository.getByIdempotencyKey(idempotencyKey);
    if (existing !== undefined && this.#mode === "enforced") {
      return {
        eligible: true,
        enqueued: true,
        reasonCodes: [],
        kind: decision.kind,
        keepsake: existing,
        replayed: true,
      };
    }
    if (!decision.eligible || this.#mode !== "enforced") {
      return {
        eligible: decision.eligible,
        enqueued: false,
        reasonCodes:
          this.#mode === "off"
            ? [...decision.reasonCodes, "keepsake_mode_off"]
            : this.#mode === "shadow"
              ? [...decision.reasonCodes, "shadow_observation_only"]
              : decision.reasonCodes,
        kind: decision.kind,
      };
    }

    const semanticSignature = sha256(decision.semanticKey);
    const profile = this.#ensureVisualProfile(input.agentId, nowUtc);
    const visualSpec = buildVisualSpec(source, decision.kind, profile);
    const visualSpecHash = sha256(canonicalCorrespondenceJson(visualSpec));
    const keepsakeId = createEntityId("keepsake");
    const keepsake: Keepsake = {
      id: keepsakeId,
      agentId: input.agentId,
      title: keepsakeTitle(source, decision.kind),
      kind: decision.kind,
      description: `源自已经发生并留有证据的经历：${source.summary}`.slice(
        0,
        2_000,
      ),
      createdBy: "agent",
      ownedBy: "user",
      sourceEventIds: [...source.sourceEventIds],
      sourceMemoryIds: [...source.sourceMemoryIds],
      sourceLetterIds: [...source.sourceLetterIds],
      canonicality: "evidence_derived",
      status: "pending",
      visualSpecJson: visualSpec,
      visualSpecHash,
      createdEffectiveAtUtc: source.effectiveAtUtc,
      idempotencyKey,
      createdAtUtc: nowUtc,
      updatedAtUtc: nowUtc,
    };
    const result = this.repository.createPending({
      keepsake,
      semanticKey: decision.semanticKey,
      semanticSignature,
      source,
      taskId: createEntityId("temporal_task"),
      runId: createEntityId("keepsake_run"),
    });
    return {
      eligible: true,
      enqueued: true,
      reasonCodes: [],
      kind: decision.kind,
      keepsake: result.keepsake,
      taskId: result.taskId,
      replayed: result.replayed,
    };
  }

  async processTask(
    taskId: string,
    observedNowUtc = this.clock.nowUtc(),
  ): Promise<Keepsake> {
    if (this.#mode !== "enforced") {
      throw new KeepsakeServiceError(
        "generation_disabled",
        "Keepsake generation is not enforced",
      );
    }
    const existingTask = this.correspondence.getTask(taskId);
    if (
      existingTask === undefined ||
      existingTask.kind !== "keepsake.generate"
    ) {
      throw new KeepsakeServiceError(
        "task_not_found",
        "Keepsake generation task was not found",
      );
    }
    if (existingTask.status === "completed") {
      return this.repository.require(existingTask.entityId);
    }
    const claimToken = createEntityId("keepsake_claim");
    const claimed = this.correspondence.claimDueTask({
      taskId,
      agentId: existingTask.agentId,
      kinds: ["keepsake.generate"],
      nowUtc: observedNowUtc,
      leaseExpiresAtUtc: addMs(observedNowUtc, this.#leaseMs),
      claimToken,
    });
    if (claimed === undefined) {
      throw new KeepsakeServiceError(
        "task_not_due",
        "Keepsake task is not due or is already claimed",
      );
    }
    const generation = this.repository.markGenerating(
      claimed.id,
      claimToken,
      observedNowUtc,
    );
    let stored: StoredKeepsakeAssetFiles | undefined;
    let committed: Keepsake;
    try {
      const rendered = await this.#render(generation.keepsake);
      stored = await this.assets.persist({
        agentId: generation.keepsake.agentId,
        bytes: rendered.asset.bytes,
      });
      const asset = {
        id: createEntityId("keepsake_asset"),
        keepsakeId: generation.keepsake.id,
        storageKey: stored.storageKey,
        thumbnailStorageKey: stored.thumbnailStorageKey,
        mimeType: "image/webp" as const,
        width: stored.width,
        height: stored.height,
        sha256: stored.sha256,
        thumbnailSha256: stored.thumbnailSha256,
        provider: rendered.provider,
        model: rendered.model,
        promptSpecHash: generation.keepsake.visualSpecHash,
        generationRunId: generation.runId,
        createdAtUtc: observedNowUtc,
      };
      committed = this.repository.commitGeneration({
        taskId: claimed.id,
        claimToken,
        keepsakeId: generation.keepsake.id,
        runId: generation.runId,
        asset,
        provider: rendered.provider,
        model: rendered.model,
        resultHash: stored.sha256,
        nowUtc: observedNowUtc,
      });
    } catch (error) {
      if (stored !== undefined) {
        await this.assets.removeIfCreated(stored, (key) =>
          this.repository.isStorageKeyReferenced(key),
        );
      }
      this.repository.recordFailure({
        taskId: claimed.id,
        claimToken,
        runId: generation.runId,
        keepsakeId: generation.keepsake.id,
        errorCode: safeErrorCode(error),
        nowUtc: observedNowUtc,
        nextDueAtUtc: addMs(observedNowUtc, this.#retryDelayMs),
        retryable: isRetryable(error),
      });
      throw error;
    }
    // Notification is intentionally after the durable commit and outside the
    // retry block. A disconnected SSE client must never roll back or retry a
    // successfully created keepsake.
    this.sse.publish({
      type: "keepsake.created",
      agentId: committed.agentId,
      occurredAtUtc: observedNowUtc,
      data: {
        keepsakeId: committed.id,
        invalidates: [["keepsakes", committed.agentId]],
      },
    });
    return committed;
  }

  async processDueForAgent(
    agentId: string,
    observedNowUtc = this.clock.nowUtc(),
  ): Promise<readonly Keepsake[]> {
    const completed: Keepsake[] = [];
    while (true) {
      const task = this.correspondence.findEarliestDueTask(
        agentId,
        observedNowUtc,
        ["keepsake.generate"],
      );
      if (task === undefined) return completed;
      if (
        task.status === "claimed" &&
        task.leaseExpiresAtUtc !== undefined &&
        Date.parse(task.leaseExpiresAtUtc) > Date.parse(observedNowUtc)
      ) {
        return completed;
      }
      completed.push(await this.processTask(task.id, observedNowUtc));
    }
  }

  /** Non-blocking seam for the correspondence post-commit path. */
  enqueueLetterKeepsakeNonBlocking(
    agentId: string,
    incomingLetterId: string,
    replyLetterId: string,
  ): void {
    try {
      const result = this.enqueueSource({
        agentId,
        sourceType: "letter",
        sourceId: incomingLetterId,
      });
      if (result.keepsake !== undefined) {
        this.repository.linkToReply(
          result.keepsake.id,
          incomingLetterId,
          replyLetterId,
          this.clock.nowUtc(),
        );
      }
    } catch (error) {
      this.#onBackgroundError?.(safeErrorCode(error));
    }
  }

  listReadyForReply(replyLetterId: string): readonly string[] {
    return this.repository.listReadyKeepsakeIdsForLetter(replyLetterId);
  }

  list(
    agentId: string,
    input: Partial<KeepsakeListQuery> = {},
  ): KeepsakePageResponse {
    const query = KeepsakeListQuerySchema.parse(input);
    const filters = {
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.sourceType === undefined
        ? {}
        : { sourceType: query.sourceType }),
      ...(query.period === undefined ? {} : { period: query.period }),
    };
    const before =
      query.cursor === undefined
        ? undefined
        : decodeCursor(query.cursor, filters);
    const rows = this.repository.list(agentId, {
      limit: query.limit + 1,
      ...filters,
      ...(before === undefined ? {} : { before }),
    });
    const hasNext = rows.length > query.limit;
    const items = rows.slice(0, query.limit).map((keepsake) =>
      KeepsakeSummaryResponseSchema.parse({
        id: keepsake.id,
        agentId: keepsake.agentId,
        title: keepsake.title,
        kind: keepsake.kind,
        description: keepsake.description,
        status: keepsake.status,
        ...(keepsake.primaryAssetId === undefined
          ? {}
          : { primaryAssetId: keepsake.primaryAssetId }),
        createdEffectiveAtUtc: keepsake.createdEffectiveAtUtc,
        ...(keepsake.giftedAtUtc === undefined
          ? {}
          : { giftedAtUtc: keepsake.giftedAtUtc }),
        thumbnailUrl: `/api/keepsakes/${encodeURIComponent(keepsake.id)}/thumbnail`,
      }),
    );
    const last = items.at(-1);
    return KeepsakePageResponseSchema.parse({
      items,
      ...(hasNext && last !== undefined
        ? {
            nextCursor: encodeCursor(
              last.createdEffectiveAtUtc,
              last.id,
              filters,
            ),
          }
        : {}),
      filterOptions: this.repository.listFilterOptions(agentId),
    });
  }

  getDetail(keepsakeId: string): KeepsakeDetailResponse {
    const detail = this.repository.getDetail(keepsakeId);
    if (detail === undefined || detail.keepsake.status !== "ready") {
      throw new KeepsakeServiceError("not_found", "Keepsake was not found");
    }
    return KeepsakeDetailResponseSchema.parse(detail);
  }

  async readAsset(
    keepsakeId: string,
    thumbnail: boolean,
  ): Promise<KeepsakeAssetReadResult> {
    const detail = this.getDetail(keepsakeId);
    const asset = detail.assets.find(
      (item) => item.id === detail.keepsake.primaryAssetId,
    );
    if (asset === undefined) {
      throw new KeepsakeServiceError(
        "asset_not_found",
        "Keepsake asset was not found",
      );
    }
    return {
      bytes: await this.assets.read(
        thumbnail ? asset.thumbnailStorageKey : asset.storageKey,
      ),
      mimeType: "image/webp",
      etag: thumbnail ? asset.thumbnailSha256 : asset.sha256,
    };
  }

  relationshipArtifactsPromptContext(
    agentIdInput: string,
    nowUtcInput: string,
  ): RelationshipArtifactsPromptContext {
    const agentId = EntityIdSchema.parse(agentIdInput);
    const nowUtc = UtcDateTimeSchema.parse(nowUtcInput);
    const correspondence = (
      this.store.database
        .prepare(
          `SELECT id, direction, status,
                  effective_author_time_utc AS effectiveAuthorTimeUtc,
                  dispatched_at_utc AS dispatchedAtUtc,
                  arrival_due_at_utc AS arrivalDueAtUtc,
                  delivered_effective_at_utc AS deliveredEffectiveAtUtc,
                  read_at_utc AS readAtUtc
             FROM letters
            WHERE agent_id = ? AND status NOT IN ('draft', 'cancelled')
              AND julianday(created_at_utc) <= julianday(?)
              AND julianday(updated_at_utc) <= julianday(?)
            ORDER BY COALESCE(effective_author_time_utc, created_at_utc) DESC,
                     id DESC
            LIMIT 12`,
        )
        .all(agentId, nowUtc, nowUtc) as Array<{
        id: string;
        direction: string;
        status: string;
        effectiveAuthorTimeUtc: string | null;
        dispatchedAtUtc: string | null;
        arrivalDueAtUtc: string | null;
        deliveredEffectiveAtUtc: string | null;
        readAtUtc: string | null;
      }>
    )
      .reverse()
      .map((row) => ({
        id: row.id,
        direction: row.direction,
        status: row.status,
        ...(row.effectiveAuthorTimeUtc === null
          ? {}
          : { effectiveAuthorTimeUtc: row.effectiveAuthorTimeUtc }),
        ...(row.dispatchedAtUtc === null
          ? {}
          : { dispatchedAtUtc: row.dispatchedAtUtc }),
        ...(row.arrivalDueAtUtc === null
          ? {}
          : { arrivalDueAtUtc: row.arrivalDueAtUtc }),
        ...(row.deliveredEffectiveAtUtc === null
          ? {}
          : { deliveredEffectiveAtUtc: row.deliveredEffectiveAtUtc }),
        ...(row.readAtUtc === null ? {} : { readAtUtc: row.readAtUtc }),
      }));
    const readyKeepsakes = (
      this.store.database
        .prepare(
          `SELECT keepsake.id, keepsake.title, keepsake.kind,
                  keepsake.description,
                  keepsake.source_event_ids_json AS sourceEventIdsJson,
                  keepsake.source_memory_ids_json AS sourceMemoryIdsJson,
                  keepsake.source_letter_ids_json AS sourceLetterIdsJson,
                  keepsake.created_effective_at_utc AS createdEffectiveAtUtc,
                  keepsake.gifted_at_utc AS giftedAtUtc
             FROM keepsakes keepsake
             JOIN keepsake_assets asset ON asset.id = keepsake.primary_asset_id
            WHERE keepsake.agent_id = ? AND keepsake.status = 'ready'
              AND julianday(keepsake.created_at_utc) <= julianday(?)
              AND julianday(keepsake.created_effective_at_utc) <= julianday(?)
              AND julianday(asset.created_at_utc) <= julianday(?)
            ORDER BY keepsake.created_effective_at_utc DESC,
                     asset.created_at_utc DESC, keepsake.id DESC
            LIMIT 6`,
        )
        .all(agentId, nowUtc, nowUtc, nowUtc) as Array<{
        id: string;
        title: string;
        kind: string;
        description: string;
        sourceEventIdsJson: string;
        sourceMemoryIdsJson: string;
        sourceLetterIdsJson: string;
        createdEffectiveAtUtc: string;
        giftedAtUtc: string | null;
      }>
    )
      .reverse()
      .map((row) => ({
        id: row.id,
        title: row.title,
        kind: row.kind,
        description: row.description,
        sourceEventIds: parseEntityIds(row.sourceEventIdsJson),
        sourceMemoryIds: parseEntityIds(row.sourceMemoryIdsJson),
        sourceLetterIds: parseEntityIds(row.sourceLetterIdsJson),
        createdEffectiveAtUtc: row.createdEffectiveAtUtc,
        ...(row.giftedAtUtc === null ||
        Date.parse(row.giftedAtUtc) > Date.parse(nowUtc)
          ? {}
          : { giftedAtUtc: row.giftedAtUtc }),
      }));
    return Object.freeze({ correspondence, readyKeepsakes });
  }

  scanOrphanAssets(): ReturnType<KeepsakeAssetStore["scanOrphans"]> {
    return this.assets.scanOrphans(this.repository.listReferencedStorageKeys());
  }

  async #render(keepsake: Keepsake): Promise<{
    readonly asset: GeneratedImageAsset;
    readonly provider: string;
    readonly model: string;
  }> {
    if (isStructuredKeepsakeKind(keepsake.kind)) {
      const rendered = this.#templates.render({
        kind: keepsake.kind,
        title: keepsake.title,
        visualSpec: keepsake.visualSpecJson,
      });
      return {
        asset: rendered,
        provider: this.#templates.name,
        model: rendered.templateVersion,
      };
    }
    const visualPrompt = keepsake.visualSpecJson.visualPrompt;
    if (visualPrompt === undefined) {
      throw new KeepsakeServiceError(
        "visual_prompt_missing",
        "Multimodal keepsake requires a bounded visual prompt",
        false,
      );
    }
    return {
      asset: await this.#provider.generate({
        visualSpec: visualPrompt,
        width: 1200,
        height: 1200,
        idempotencyKey: keepsake.idempotencyKey,
      }),
      provider: this.#provider.name,
      model: this.#provider.model,
    };
  }

  #ensureVisualProfile(
    agentId: string,
    nowUtc: string,
  ): CharacterVisualProfile {
    const spec = this.store.getCharacterSpec(agentId);
    if (spec === undefined) {
      throw new KeepsakeServiceError(
        "agent_not_found",
        "Character was not found",
      );
    }
    const existing = this.repository.getVisualProfile(agentId);
    if (existing?.characterVersion === spec.version) return existing;
    const base = visualProfileBase(spec);
    const profile = CharacterVisualProfileSchema.parse({
      ...base,
      profileHash: sha256(canonicalCorrespondenceJson(base)),
      createdAtUtc: nowUtc,
    });
    return this.repository.saveVisualProfile(profile);
  }
}

export class KeepsakeServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "KeepsakeServiceError";
  }
}

function visualProfileBase(spec: CharacterSpec) {
  const appearance = spec.identity.appearance;
  const stableAppearanceTraits = [
    ...(appearance?.distinctiveFeatures ?? []),
    ...(appearance === undefined ? [] : [appearance.summary]),
  ].slice(0, 8);
  const era = spec.identity.temporalFrame?.eraLabel;
  return {
    version: spec.version,
    agentId: spec.id,
    characterVersion: spec.version,
    stableAppearanceTraits,
    periodAndSetting: [era, spec.identity.worldSetting]
      .filter((value): value is string => value !== undefined)
      .join("；")
      .slice(0, 240),
    materialLanguage: ["哑光纸", "低饱和油墨"],
    imageLanguage: ["自然光", "克制构图"],
    forbiddenElements: ["水印", "可读品牌标志", "不属于角色时代的设备"],
  };
}

function buildVisualSpec(
  source: KeepsakeSourceProjection,
  kind: KeepsakeKind,
  profile: CharacterVisualProfile,
): KeepsakeVisualSpec {
  const semanticSourceHash = sha256(buildKeepsakeSemanticKey(source, kind));
  const palette = ["#F3E9D2", "#22354B", "#C56F46"];
  const materials = materialForKind(kind);
  return KeepsakeVisualSpecSchema.parse({
    version: "keepsake_visual_v1",
    templateVersion: `${kind}-v1`,
    theme: source.label.slice(0, 240),
    caption: source.summary.slice(0, 500),
    palette,
    materials,
    visualPrompt: VisualPromptSpecSchema.parse({
      version: "keepsake_visual_v1",
      kind,
      subject: source.label.slice(0, 240),
      setting: profile.periodAndSetting,
      mood: "克制、温暖、像被保存过的真实物件",
      composition: "以物件或场景为主体，不出现可读品牌和水印",
      materials,
      palette,
      stableCharacterTraits: profile.stableAppearanceTraits,
      forbiddenElements: profile.forbiddenElements,
      visualProfileHash: profile.profileHash,
      semanticSourceHash,
    }),
  });
}

function materialForKind(kind: KeepsakeKind): string[] {
  switch (kind) {
    case "ticket_stub":
      return ["旧票纸", "蓝色油墨"];
    case "postcard":
      return ["哑光卡纸", "颗粒水彩"];
    case "recipe_or_note_card":
      return ["横线便笺", "钢笔墨水"];
    case "pressed_flower":
      return ["压花纸", "植物纤维"];
    case "polaroid":
      return ["拍立得相纸", "自然颗粒"];
    case "sketch":
      return ["素描纸", "石墨铅笔"];
  }
}

function keepsakeTitle(
  source: KeepsakeSourceProjection,
  kind: KeepsakeKind,
): string {
  const suffix: Record<KeepsakeKind, string> = {
    postcard: "明信片",
    ticket_stub: "票根",
    polaroid: "拍立得",
    sketch: "速写",
    pressed_flower: "压花",
    recipe_or_note_card: "便笺卡",
  };
  return `${source.label.slice(0, 130)} · ${suffix[kind]}`.slice(0, 160);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function addMs(valueUtc: string, milliseconds: number): string {
  return new Date(Date.parse(valueUtc) + milliseconds).toISOString();
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function safeErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/u.test(error.code)
  ) {
    return error.code;
  }
  return "keepsake_generation_failed";
}

function isRetryable(error: unknown): boolean {
  return !(
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    error.retryable === false
  );
}

function parseEntityIds(serialized: string): string[] {
  return EntityIdSchema.array().parse(JSON.parse(serialized) as unknown);
}

interface KeepsakeCursorFilters {
  readonly kind?: KeepsakeKind;
  readonly sourceType?: KeepsakeSourceType;
  readonly period?: string;
}

function encodeCursor(
  atUtc: string,
  id: string,
  filters: KeepsakeCursorFilters,
): string {
  return Buffer.from(
    JSON.stringify({ version: 1, atUtc, id, ...filters }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(
  cursor: string,
  expectedFilters: KeepsakeCursorFilters,
): { atUtc: string; id: string } {
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      !("version" in value) ||
      value.version !== 1 ||
      !("atUtc" in value) ||
      !("id" in value) ||
      typeof value.atUtc !== "string" ||
      typeof value.id !== "string" ||
      !UtcDateTimeSchema.safeParse(value.atUtc).success ||
      !EntityIdSchema.safeParse(value.id).success
    ) {
      throw new TypeError("Invalid cursor");
    }
    const kind = "kind" in value ? value.kind : undefined;
    const sourceType = "sourceType" in value ? value.sourceType : undefined;
    const period = "period" in value ? value.period : undefined;
    if (
      (kind !== undefined && !KeepsakeKindSchema.safeParse(kind).success) ||
      (sourceType !== undefined &&
        !KeepsakeSourceTypeSchema.safeParse(sourceType).success) ||
      (period !== undefined &&
        (typeof period !== "string" ||
          !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(period))) ||
      kind !== expectedFilters.kind ||
      sourceType !== expectedFilters.sourceType ||
      period !== expectedFilters.period
    ) {
      throw new TypeError("Cursor filters do not match");
    }
    return { atUtc: value.atUtc, id: value.id };
  } catch {
    throw new KeepsakeServiceError(
      "invalid_cursor",
      "Keepsake cursor is invalid",
    );
  }
}
