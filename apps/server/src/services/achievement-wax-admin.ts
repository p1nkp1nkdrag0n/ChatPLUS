import { createHash } from "node:crypto";
import { EntityIdSchema } from "@personasim/contracts";
import type { Database } from "../db/connection.js";
import { ApiError, notFound } from "../domain/errors.js";
import type { KeepsakeAssetStore } from "./keepsake-asset-store.js";

export interface WaxRepaintEntry {
  id: string;
  title: string;
  badgeKey: string;
  visualVersion: number;
  status: "pending" | "generating" | "ready" | "failed";
  hasImage: boolean;
  action: "enqueue" | "already-v2" | "wait-for-generating";
}

interface BadgeVersionRow {
  achievement_id: string;
  sha256: string;
  visual_version: number;
  storage_key: string;
  thumbnail_storage_key: string;
  thumbnail_sha256: string | null;
  created_at_utc: string;
}

/** Administrator-only operations. Never starts a worker or calls a provider. */
export class AchievementWaxAdmin {
  constructor(private readonly database: Database) {}

  plan(ids?: readonly string[]): WaxRepaintEntry[] {
    const selected =
      ids === undefined
        ? undefined
        : new Set(ids.map((id) => EntityIdSchema.parse(id)));
    const rows = this.database
      .prepare(
        `SELECT j.achievement_id AS id,u.title,u.badge_key AS badgeKey,
      j.visual_version AS visualVersion,j.status,j.storage_key IS NOT NULL AS hasImage
      FROM achievement_badge_jobs j JOIN achievement_unlocks u ON u.id=j.achievement_id
      ORDER BY u.sequence`,
      )
      .all() as (Omit<WaxRepaintEntry, "action" | "hasImage"> & {
      hasImage: number;
    })[];
    if (
      selected &&
      [...selected].some((id) => !rows.some((row) => row.id === id))
    )
      throw notFound("Custom achievement badge");
    return rows
      .filter((row) => selected === undefined || selected.has(row.id))
      .map((row) => ({
        ...row,
        hasImage: Boolean(row.hasImage),
        action:
          row.visualVersion >= 2
            ? "already-v2"
            : row.status === "generating"
              ? "wait-for-generating"
              : "enqueue",
      }));
  }

  enqueue(
    nowUtc: string,
    ids?: readonly string[],
  ): { queued: string[]; skipped: string[] } {
    return this.database.transaction(() => {
      const plan = this.plan(ids);
      if (plan.some((row) => row.action === "wait-for-generating"))
        throw new ApiError(
          409,
          "image_drawing_in_progress",
          "有旧版图片正在生成，请等待任务完成或恢复后再安排重绘。",
        );
      const queued: string[] = [];
      const skipped: string[] = [];
      for (const row of plan) {
        if (row.action === "already-v2") {
          skipped.push(row.id);
          continue;
        }
        // Capture any image written by a legacy worker since the migration.
        this.database
          .prepare(
            `INSERT OR IGNORE INTO achievement_badge_versions(
          achievement_id,sha256,visual_version,storage_key,thumbnail_storage_key,provider,model,request_id,created_at_utc)
          SELECT achievement_id,sha256,visual_version,storage_key,thumbnail_storage_key,provider,model,request_id,updated_at_utc
          FROM achievement_badge_jobs WHERE achievement_id=? AND storage_key IS NOT NULL
          AND thumbnail_storage_key IS NOT NULL AND sha256 IS NOT NULL`,
          )
          .run(row.id);
        this.database
          .prepare(
            `UPDATE achievement_badge_jobs SET visual_version=2,status='pending',attempts=0,
          next_attempt_at_utc=?,claim_token=NULL,lease_until_utc=NULL,error_code=NULL,
          provider=NULL,model=NULL,request_id=NULL,updated_at_utc=?
          WHERE achievement_id=? AND visual_version<2 AND status<>'generating'`,
          )
          .run(nowUtc, nowUtc, row.id);
        queued.push(row.id);
      }
      return { queued, skipped };
    })();
  }

  versions(id: string): BadgeVersionRow[] {
    EntityIdSchema.parse(id);
    return this.database
      .prepare(
        `SELECT achievement_id,sha256,visual_version,storage_key,
      thumbnail_storage_key,thumbnail_sha256,created_at_utc FROM achievement_badge_versions
      WHERE achievement_id=? ORDER BY created_at_utc,sha256`,
      )
      .all(id) as BadgeVersionRow[];
  }

  async restore(
    id: string,
    sha256: string,
    assets: KeepsakeAssetStore,
    nowUtc: string,
  ): Promise<void> {
    const version = this.versions(id).find((item) => item.sha256 === sha256);
    if (!version) throw notFound("Achievement badge version");
    const [primary, thumbnail] = await Promise.all([
      assets.read(version.storage_key),
      assets.read(version.thumbnail_storage_key),
    ]);
    const thumbnailDigest =
      version.thumbnail_sha256 ??
      version.thumbnail_storage_key.match(
        /\/([a-f0-9]{64})\.thumb\.webp$/u,
      )?.[1];
    if (
      createHash("sha256").update(primary).digest("hex") !== sha256 ||
      !thumbnailDigest ||
      createHash("sha256").update(thumbnail).digest("hex") !== thumbnailDigest
    )
      throw new ApiError(
        409,
        "image_asset_integrity_failed",
        "历史图片完整性检查失败，未切换当前图片。",
      );
    this.database.transaction(() => {
      const row = this.database
        .prepare(
          "SELECT status FROM achievement_badge_jobs WHERE achievement_id=?",
        )
        .get(id) as { status: string } | undefined;
      if (!row) throw notFound("Achievement badge");
      if (row.status === "generating")
        throw new ApiError(
          409,
          "image_drawing_in_progress",
          "请等待当前图片生成完成或恢复后再切换历史图片。",
        );
      // Keep the attempted visual version, so re-running the one-off v2 command
      // does not silently overwrite an administrator's restored image.
      this.database
        .prepare(
          `UPDATE achievement_badge_jobs SET status='ready',storage_key=?,thumbnail_storage_key=?,
        sha256=?,error_code=NULL,claim_token=NULL,lease_until_utc=NULL,updated_at_utc=? WHERE achievement_id=?`,
        )
        .run(
          version.storage_key,
          version.thumbnail_storage_key,
          sha256,
          nowUtc,
          id,
        );
    })();
  }

  referencedStorageKeys(): ReadonlySet<string> {
    const rows = this.database
      .prepare(
        `SELECT storage_key,thumbnail_storage_key FROM achievement_badge_jobs
      UNION ALL SELECT storage_key,thumbnail_storage_key FROM achievement_badge_versions`,
      )
      .all() as {
      storage_key: string | null;
      thumbnail_storage_key: string | null;
    }[];
    return new Set(
      rows
        .flatMap((row) => [row.storage_key, row.thumbnail_storage_key])
        .filter((key): key is string => key !== null),
    );
  }
}
