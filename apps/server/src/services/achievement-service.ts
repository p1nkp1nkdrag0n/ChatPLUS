import { createHash, randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import sharp from "sharp";
import {
  AchievementSchema,
  AchievementPageSchema,
  AchievementImageSettingsInputSchema,
  AchievementBadgeVisualSpecSchema,
  type Achievement,
  type AchievementPage,
  type AchievementImageSettings,
  type AchievementImageSettingsInput,
  type AchievementBadgeVisualSpec,
} from "@personasim/contracts";
import {
  createFixtureImageGenerationProvider,
  RemoteImageGenerationProvider,
  ImageProviderError,
  normalizeImageBaseUrl,
} from "@personasim/providers";
import type { Database } from "../db/connection.js";
import type { Clock } from "../runtime/clock.js";
import { ApiError, notFound } from "../domain/errors.js";
import { KeepsakeAssetStore } from "./keepsake-asset-store.js";
import { LlmCredentialService } from "./llm-credential-service.js";

const SELECT_UNLOCKS = `SELECT u.*,j.status AS badge_status,j.storage_key,j.thumbnail_storage_key,j.sha256
  FROM achievement_unlocks u LEFT JOIN achievement_badge_jobs j ON j.achievement_id=u.id`;
interface UnlockRow {
  sequence: number;
  id: string;
  title: string;
  description: string;
  category: "global" | "character";
  agent_id: string | null;
  agent_name: string | null;
  badge_key: string;
  unlocked_at_utc: string;
  notification_read_at_utc: string | null;
  badge_status: "pending" | "generating" | "ready" | "failed" | null;
  storage_key: string | null;
  thumbnail_storage_key: string | null;
  sha256: string | null;
}
interface ImageSettingsRow {
  protocol: AchievementImageSettings["protocol"];
  base_url: string;
  model: string;
  enabled: number;
  credential_json: string | null;
}
interface BadgeJob {
  achievement_id: string;
  attempts: number;
  claim_token: string;
  agent_id: string;
  title: string;
  profile_json: string;
  badge_key: string;
  visual_version: number;
  request_id: string;
}

/** Collection projections never expose achievement definitions or runtime state.
 * Business unlocks live in migration 032's transactional fact triggers. */
export class AchievementService {
  readonly assets: KeepsakeAssetStore;
  private readonly credentials: LlmCredentialService;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private readonly controller = new AbortController();
  constructor(
    readonly database: Database,
    private readonly clock: Clock,
    options: {
      databasePath: string;
      assetRoot: string;
      fetch?: typeof fetch;
      developerMode?: boolean;
    },
  ) {
    this.assets = new KeepsakeAssetStore(options.assetRoot);
    this.credentials = new LlmCredentialService(database, options.databasePath);
    this.options = options;
  }
  private readonly options: {
    databasePath: string;
    assetRoot: string;
    fetch?: typeof fetch;
    developerMode?: boolean;
  };

  visit(): { serverTimeUtc: string } {
    const now = this.clock.nowUtc();
    const date = DateTime.fromISO(now, { setZone: true })
      .setZone("Asia/Shanghai")
      .toISODate()!;
    this.database.transaction(() => {
      const latest = this.database
        .prepare(
          "SELECT max(local_date) AS date FROM achievement_activity_days WHERE user_id='local-user'",
        )
        .get() as { date: string | null };
      // A backwards test/system clock cannot manufacture visits in missing days.
      if (latest.date !== null && date < latest.date) return;
      this.database
        .prepare(
          "INSERT OR IGNORE INTO achievement_activity_days(local_date,first_seen_at_utc) VALUES(?,?)",
        )
        .run(date, now);
      const days = this.database
        .prepare(
          "SELECT local_date FROM achievement_activity_days WHERE user_id='local-user' ORDER BY local_date DESC LIMIT 365",
        )
        .all() as { local_date: string }[];
      let expected = DateTime.fromISO(date, { zone: "Asia/Shanghai" });
      let streak = 0;
      for (const day of days) {
        if (day.local_date !== expected.toISODate()) break;
        streak += 1;
        expected = expected.minus({ days: 1 });
      }
      this.database
        .prepare(
          `INSERT OR IGNORE INTO achievement_unlocks(
        definition_key,scope_key,title,description,category,badge_key,unlocked_at_utc,recorded_at_utc,evidence_kind,evidence_id)
        SELECT key,'global',title,description,category,badge_key,@now,@now,'activity_day',@date
        FROM achievement_definitions WHERE trigger_kind='visit' AND threshold<=@streak`,
        )
        .run({ now, date, streak });
    })();
    return { serverTimeUtc: now };
  }

  list(query: {
    category?: "all" | "global" | "character";
    agentId?: string;
    cursor?: string;
    limit?: number;
  }): AchievementPage {
    const limit = query.limit ?? 24;
    const rows = this.database
      .prepare(
        `${SELECT_UNLOCKS}
      WHERE (@category='all' OR u.category=@category)
      AND (@agentId IS NULL OR u.agent_id=@agentId)
      AND (@cursor IS NULL OR u.sequence<@cursor)
      ORDER BY u.sequence DESC LIMIT @limit`,
      )
      .all({
        category: query.category ?? "all",
        agentId: query.agentId ?? null,
        cursor: query.cursor === undefined ? null : Number(query.cursor),
        limit: limit + 1,
      }) as UnlockRow[];
    const items = rows.slice(0, limit);
    const notifications = this.database
      .prepare(
        `${SELECT_UNLOCKS} WHERE u.notification_read_at_utc IS NULL ORDER BY u.sequence LIMIT 100`,
      )
      .all() as UnlockRow[];
    const agents = this.database
      .prepare(
        `SELECT agent_id AS id,agent_name AS name FROM achievement_unlocks
      WHERE agent_id IS NOT NULL GROUP BY agent_id ORDER BY max(sequence) DESC`,
      )
      .all();
    return AchievementPageSchema.parse({
      items: items.map(project),
      ...(rows.length > limit
        ? { nextCursor: String(items.at(-1)!.sequence) }
        : {}),
      notifications: notifications.map(project),
      agents,
      serverTimeUtc: this.clock.nowUtc(),
    });
  }
  get(id: string): Achievement {
    const row = this.database
      .prepare(`${SELECT_UNLOCKS} WHERE u.id=?`)
      .get(id) as UnlockRow | undefined;
    if (!row) throw notFound("Achievement");
    return project(row);
  }
  acknowledge(ids: string[]): void {
    const statement = this.database.prepare(
      "UPDATE achievement_unlocks SET notification_read_at_utc=? WHERE id=? AND notification_read_at_utc IS NULL",
    );
    const now = this.clock.nowUtc();
    this.database.transaction(() => {
      for (const id of ids) statement.run(now, id);
    })();
  }
  revision(): number {
    return (
      this.database
        .prepare("SELECT revision FROM achievement_revision WHERE id=1")
        .get() as { revision: number }
    ).revision;
  }
  diagnostics() {
    return {
      unlocks: this.database
        .prepare(
          "SELECT * FROM achievement_unlocks ORDER BY sequence DESC LIMIT 200",
        )
        .all(),
      definitions: this.database
        .prepare("SELECT * FROM achievement_definitions")
        .all(),
      jobs: this.database
        .prepare(
          "SELECT achievement_id,visual_version,status,attempts,error_code,provider,model,updated_at_utc FROM achievement_badge_jobs ORDER BY updated_at_utc DESC LIMIT 200",
        )
        .all(),
    };
  }

  imageSettings(): AchievementImageSettings {
    const row = this.settingsRow();
    return {
      protocol: row.protocol,
      baseUrl: row.base_url,
      model: row.model,
      enabled: row.enabled === 1,
      apiKeyConfigured:
        row.credential_json !== null &&
        this.credentials.available("achievement-images", row.credential_json),
    };
  }
  saveImageSettings(
    raw: AchievementImageSettingsInput,
  ): AchievementImageSettings {
    const input = AchievementImageSettingsInputSchema.parse(raw);
    if (input.protocol === "fixture" && !this.options.developerMode)
      throw new ApiError(
        400,
        "image_protocol_unavailable",
        "请选择图片供应商协议。",
      );
    let baseUrl = input.baseUrl;
    if (
      input.protocol !== "fixture" &&
      (input.enabled || input.baseUrl || input.model)
    ) {
      try {
        baseUrl = normalizeImageBaseUrl(input.baseUrl, input.protocol);
      } catch {
        throw new ApiError(
          400,
          "image_invalid_base_url",
          "请填写有效的图片接口地址。",
        );
      }
      if (!input.model)
        throw new ApiError(400, "image_model_required", "请填写生图模型名称。");
    }
    const previous = this.settingsRow();
    // Changing destinations never forwards a previously saved secret implicitly.
    let encrypted =
      previous.base_url === baseUrl && previous.protocol === input.protocol
        ? previous.credential_json
        : null;
    if (input.clearApiKey) encrypted = null;
    if (input.apiKey)
      encrypted = this.credentials.encrypt("achievement-images", input.apiKey);
    this.database
      .prepare(
        `UPDATE achievement_image_settings SET protocol=?,base_url=?,model=?,enabled=?,credential_json=? WHERE id=1`,
      )
      .run(
        input.protocol,
        baseUrl,
        input.model,
        Number(input.enabled),
        encrypted,
      );
    this.wake();
    return this.imageSettings();
  }
  async testImageSettings(): Promise<{ success: true }> {
    const provider = this.provider();
    const asset = await provider.generate({
      visualSpec: {
        version: "achievement_badge_v2",
        subject: "a small leaf",
        setting: "quiet garden",
        motifs: ["leaf", "sunlight"],
        palette: ["#C69A4F", "#E8D09A"],
        theme: "a small memento",
        finish: "gold",
      },
      width: 1024,
      height: 1024,
      idempotencyKey: `image-test:${randomUUID()}`,
    });
    await assertTransparentWax(asset.bytes);
    const saved = await this.assets.persist({
      agentId: "image-probe",
      bytes: asset.bytes,
      maxWidth: 1024,
      maxHeight: 1024,
    });
    await this.assets.removeIfCreated(saved, () => false);
    return { success: true };
  }

  retryBadge(id: string): Achievement {
    this.get(id);
    const now = this.clock.nowUtc();
    this.database
      .prepare(
        `UPDATE achievement_badge_jobs SET status='pending',attempts=0,next_attempt_at_utc=?,
      request_id=CASE WHEN error_code IN ('image_outcome_unknown','image_request_failed') THEN request_id ELSE NULL END,
      error_code=NULL,claim_token=NULL,lease_until_utc=NULL,updated_at_utc=? WHERE achievement_id=? AND status='failed'`,
      )
      .run(now, now, id);
    this.wake();
    return this.get(id);
  }
  async readAsset(
    id: string,
    thumbnail: boolean,
    version?: string,
  ): Promise<Buffer> {
    const row = this.database
      .prepare(
        version === undefined
          ? `SELECT storage_key,thumbnail_storage_key FROM achievement_badge_jobs WHERE achievement_id=? AND storage_key IS NOT NULL AND thumbnail_storage_key IS NOT NULL`
          : `SELECT storage_key,thumbnail_storage_key FROM achievement_badge_versions WHERE achievement_id=? AND sha256=?`,
      )
      .get(...(version === undefined ? [id] : [id, version])) as
      { storage_key: string; thumbnail_storage_key: string } | undefined;
    if (!row) throw notFound("Achievement badge");
    return this.assets.read(
      thumbnail ? row.thumbnail_storage_key : row.storage_key,
    );
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.wake(), 2000);
    this.timer.unref();
    this.wake();
  }
  wake(): void {
    if (this.controller.signal.aborted || this.running !== undefined) return;
    this.running = this.processNext()
      .catch(() => undefined)
      .finally(() => {
        this.running = undefined;
      });
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.controller.abort();
    await this.running;
  }
  /** Public for deterministic integration tests and the independent worker. */
  async processNext(): Promise<void> {
    const settings = this.settingsRow();
    if (!settings.enabled) return;
    const now = this.clock.nowUtc();
    // A lost lease can mean the provider already rendered an image. Do not
    // automatically issue another paid request after an uncertain interruption.
    this.database
      .prepare(
        `UPDATE achievement_badge_jobs SET status='failed',error_code='image_outcome_unknown',
      claim_token=NULL,lease_until_utc=NULL,updated_at_utc=? WHERE status='generating' AND (lease_until_utc IS NULL OR lease_until_utc<=?)`,
      )
      .run(now, now);
    const job = this.database.transaction(() => {
      if (
        this.database
          .prepare(
            "SELECT 1 FROM achievement_badge_jobs WHERE status='generating' LIMIT 1",
          )
          .get()
      )
        return undefined;
      const pending = this.database
        .prepare(
          `SELECT j.achievement_id,j.attempts,j.visual_version,j.request_id,u.agent_id,u.title,u.badge_key,p.profile_json
        FROM achievement_badge_jobs j JOIN achievement_unlocks u ON u.id=j.achievement_id
        JOIN achievement_visual_profiles p ON p.agent_id=u.agent_id
        WHERE j.status='pending' AND j.next_attempt_at_utc<=? ORDER BY u.sequence LIMIT 1`,
        )
        .get(now) as
        | (Omit<BadgeJob, "claim_token" | "request_id"> & {
            request_id: string | null;
          })
        | undefined;
      if (!pending) return undefined;
      const claim = randomUUID();
      const signature = createHash("sha256")
        .update(
          JSON.stringify({
            protocol: settings.protocol,
            baseUrl: settings.base_url,
            model: settings.model,
            profile: pending.profile_json,
            title: pending.title,
            badgeKey: pending.badge_key,
          }),
        )
        .digest("hex")
        .slice(0, 16);
      const prefix = `achievement-badge:${pending.achievement_id}:v${pending.visual_version}:${signature}:`;
      // Reuse an automatic/uncertain attempt only while its actual request is
      // unchanged. An intentional retry of invalid output clears request_id.
      const requestId = pending.request_id?.startsWith(prefix)
        ? pending.request_id
        : `${prefix}${randomUUID()}`;
      const lease = DateTime.fromISO(now).plus({ minutes: 5 }).toUTC().toISO()!;
      this.database
        .prepare(
          `UPDATE achievement_badge_jobs SET status='generating',attempts=attempts+1,
        claim_token=?,lease_until_utc=?,provider=?,model=?,request_id=?,updated_at_utc=? WHERE achievement_id=? AND status='pending'`,
        )
        .run(
          claim,
          lease,
          settings.protocol,
          settings.model,
          requestId,
          now,
          pending.achievement_id,
        );
      return {
        ...pending,
        attempts: pending.attempts + 1,
        claim_token: claim,
        request_id: requestId,
      };
    })();
    if (!job) return;
    let files: Awaited<ReturnType<KeepsakeAssetStore["persist"]>> | undefined;
    try {
      const visualSpec = badgeVisualSpec(
        job.profile_json,
        job.title,
        job.badge_key,
        job.visual_version,
      );
      const generated = await this.provider().generate({
        visualSpec,
        width: 1024,
        height: 1024,
        idempotencyKey: job.request_id,
      });
      if (job.visual_version === 2) await assertTransparentWax(generated.bytes);
      files = await this.assets.persist({
        agentId: job.achievement_id,
        bytes: generated.bytes,
        maxWidth: 1024,
        maxHeight: 1024,
        thumbnailWidth: 320,
      });
      const saved = files;
      const committed = this.database.transaction(() => {
        const completedAt = this.clock.nowUtc();
        if (this.expireClaim(job, completedAt)) return false;
        const owned = this.database
          .prepare(
            `SELECT 1 FROM achievement_badge_jobs
          WHERE achievement_id=? AND status='generating' AND claim_token=? AND visual_version=? AND lease_until_utc>?`,
          )
          .get(
            job.achievement_id,
            job.claim_token,
            job.visual_version,
            completedAt,
          );
        if (!owned) return false;
        this.database
          .prepare(
            `INSERT OR IGNORE INTO achievement_badge_versions(
          achievement_id,sha256,visual_version,storage_key,thumbnail_storage_key,thumbnail_sha256,
          visual_spec_json,provider,model,request_id,created_at_utc) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            job.achievement_id,
            saved.sha256,
            job.visual_version,
            saved.storageKey,
            saved.thumbnailStorageKey,
            saved.thumbnailSha256,
            JSON.stringify(visualSpec),
            settings.protocol,
            settings.model,
            job.request_id,
            completedAt,
          );
        this.database
          .prepare(
            `UPDATE achievement_badge_jobs SET status='ready',storage_key=?,thumbnail_storage_key=?,
          sha256=?,error_code=NULL,claim_token=NULL,lease_until_utc=NULL,updated_at_utc=?
          WHERE achievement_id=? AND status='generating' AND claim_token=? AND visual_version=? AND lease_until_utc>?`,
          )
          .run(
            saved.storageKey,
            saved.thumbnailStorageKey,
            saved.sha256,
            completedAt,
            job.achievement_id,
            job.claim_token,
            job.visual_version,
            completedAt,
          );
        return true;
      })();
      if (!committed)
        await this.assets.removeIfCreated(files, (key) =>
          this.assetReferenced(key),
        );
    } catch (error) {
      if (files)
        await this.assets.removeIfCreated(files, (key) =>
          this.assetReferenced(key),
        );
      const retryable =
        error instanceof ImageProviderError &&
        error.retryable &&
        job.attempts < 3;
      const errorCode =
        error instanceof ImageProviderError
          ? error.code
          : error instanceof ApiError
            ? error.code
            : "image_generation_failed";
      const failedAt = this.clock.nowUtc();
      this.database.transaction(() => {
        if (this.expireClaim(job, failedAt)) return;
        this.database
          .prepare(
            `UPDATE achievement_badge_jobs SET status=?,error_code=?,claim_token=NULL,lease_until_utc=NULL,
        next_attempt_at_utc=?,updated_at_utc=? WHERE achievement_id=? AND status='generating' AND claim_token=? AND visual_version=? AND lease_until_utc>?`,
          )
          .run(
            retryable ? "pending" : "failed",
            errorCode,
            DateTime.fromISO(failedAt)
              .plus({ seconds: 60 * job.attempts })
              .toUTC()
              .toISO(),
            failedAt,
            job.achievement_id,
            job.claim_token,
            job.visual_version,
            failedAt,
          );
      })();
    }
  }
  private expireClaim(job: BadgeJob, observedAt: string): boolean {
    return (
      this.database
        .prepare(
          `UPDATE achievement_badge_jobs SET status='failed',error_code='image_outcome_unknown',
      claim_token=NULL,lease_until_utc=NULL,updated_at_utc=?
      WHERE achievement_id=? AND status='generating' AND claim_token=? AND visual_version=?
      AND (lease_until_utc IS NULL OR lease_until_utc<=?)`,
        )
        .run(
          observedAt,
          job.achievement_id,
          job.claim_token,
          job.visual_version,
          observedAt,
        ).changes > 0
    );
  }
  private provider() {
    const row = this.settingsRow();
    if (row.protocol === "fixture")
      return createFixtureImageGenerationProvider();
    if (!row.base_url || !row.model)
      throw new ApiError(409, "image_not_configured", "请先配置徽章生图模型。");
    const apiKey =
      row.credential_json === null
        ? ""
        : this.credentials.decrypt("achievement-images", row.credential_json);
    return new RemoteImageGenerationProvider({
      settings: {
        protocol: row.protocol,
        baseUrl: row.base_url,
        model: row.model,
      },
      apiKey,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      signal: this.controller.signal,
    });
  }
  private settingsRow(): ImageSettingsRow {
    return this.database
      .prepare("SELECT * FROM achievement_image_settings WHERE id=1")
      .get() as ImageSettingsRow;
  }
  private assetReferenced(key: string): boolean {
    return (
      this.database
        .prepare(
          `SELECT 1 FROM achievement_badge_jobs WHERE storage_key=? OR thumbnail_storage_key=?
           UNION ALL SELECT 1 FROM achievement_badge_versions WHERE storage_key=? OR thumbnail_storage_key=? LIMIT 1`,
        )
        .get(key, key, key, key) !== undefined
    );
  }
}

async function assertTransparentWax(bytes: Uint8Array): Promise<void> {
  const image = sharp(Buffer.from(bytes), {
    failOn: "error",
    limitInputPixels: 32_000_000,
  });
  const metadata = await image.metadata();
  const stats = metadata.hasAlpha ? await image.stats() : undefined;
  const alpha = stats?.channels.at(-1);
  // A few rounded transparent corners on an otherwise solid square are not a
  // usable cutout. Keep enough transparent surround for the irregular wax rim.
  if (
    !alpha ||
    stats?.isOpaque ||
    alpha.min !== 0 ||
    alpha.mean > 230 ||
    alpha.max < 240
  )
    throw new ApiError(
      422,
      "image_transparency_required",
      "火漆章图片需要透明背景，请使用支持透明图片的生图模型。",
    );
}

function project(row: UnlockRow): Achievement {
  return AchievementSchema.parse({
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    ...(row.agent_id === null
      ? {}
      : {
          agentId: row.agent_id,
          agentName: row.agent_name ?? "一位曾相识的角色",
        }),
    unlockedAtUtc: row.unlocked_at_utc,
    badge: {
      key: row.badge_key,
      status: row.badge_status ?? "fixed",
      ...(row.storage_key && row.thumbnail_storage_key && row.sha256
        ? {
            imageUrl: `/api/achievements/${row.id}/badge?v=${row.sha256}`,
            thumbnailUrl: `/api/achievements/${row.id}/badge?thumbnail=true&v=${row.sha256}`,
          }
        : {}),
    },
    notificationRead: row.notification_read_at_utc !== null,
  });
}

export function badgeVisualSpec(
  json: string,
  theme: string,
  badgeKey = "star",
  visualVersion = 2,
): AchievementBadgeVisualSpec {
  if (visualVersion !== 1 && visualVersion !== 2)
    throw new ApiError(
      409,
      "image_visual_version_unsupported",
      "图片样式版本不受支持。",
    );
  const profile = JSON.parse(json) as {
    name?: string;
    role?: string;
    setting?: string;
    traits?: { name?: string }[];
    appearance?: string;
  };
  const seed = createHash("sha256").update(json).digest();
  const palettes = [
    ["#EDF3E9", "#426450", "#CAA666"],
    ["#EDEAF4", "#535277", "#C7AE77"],
    ["#F6EBDE", "#935E42", "#CBA86D"],
    ["#E5F0F2", "#3E6274", "#C4B38A"],
  ];
  return AchievementBadgeVisualSpecSchema.parse({
    version:
      visualVersion === 1 ? "achievement_badge_v1" : "achievement_badge_v2",
    subject: `${profile.name ?? "角色"} · ${profile.role ?? ""}`.slice(0, 500),
    setting: (profile.setting ?? "").slice(0, 500),
    motifs: [
      profile.appearance,
      profile.role,
      ...(profile.traits ?? []).map((item) => item.name),
    ]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .slice(0, 6)
      .map((v) => v.slice(0, 200)),
    palette:
      visualVersion === 1
        ? palettes[seed[0]! % palettes.length]
        : badgeKey === "constellation"
          ? ["#DBB2C9", "#B3DEDE", "#B8A8D7", "#E6D19F"]
          : ["#C69A4F", "#E8D09A"],
    theme,
    ...(visualVersion === 2
      ? {
          finish:
            badgeKey === "constellation" ? "mother-of-pearl-aurora" : "gold",
        }
      : {}),
  });
}
