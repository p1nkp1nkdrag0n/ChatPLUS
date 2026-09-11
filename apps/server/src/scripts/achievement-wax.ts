import { resolve } from "node:path";
import { parseArgs } from "node:util";
import BetterSqlite3 from "better-sqlite3";
import { readConfig } from "../config.js";
import { AchievementWaxAdmin } from "../services/achievement-wax-admin.js";
import { KeepsakeAssetStore } from "../services/keepsake-asset-store.js";

const { values } = parseArgs({
  strict: true,
  allowPositionals: false,
  options: {
    database: { type: "string" },
    assets: { type: "string" },
    id: { type: "string", multiple: true },
    "dry-run": { type: "boolean", default: false },
    enqueue: { type: "boolean", default: false },
    history: { type: "boolean", default: false },
    restore: { type: "string" },
  },
});
const config = readConfig();
if (values.restore !== undefined && !/^[a-f0-9]{64}$/u.test(values.restore))
  throw new TypeError("--restore requires a lowercase SHA-256 content hash.");
const actions =
  Number(values.enqueue) +
  Number(values.history) +
  Number(values.restore !== undefined) +
  Number(values["dry-run"]);
if (actions > 1)
  throw new TypeError(
    "Choose one action: --dry-run (default), --enqueue, --history, or --restore <sha256>.",
  );
if ((values.restore || values.history) && values.id?.length !== 1)
  throw new TypeError(
    "--history and --restore require exactly one --id <achievement-id>.",
  );
const databasePath = resolve(values.database ?? config.databasePath);
const database = new BetterSqlite3(databasePath, {
  readonly: !values.enqueue && values.restore === undefined,
  fileMustExist: true,
});
database.pragma("foreign_keys=ON");
database.pragma("busy_timeout=5000");
try {
  const admin = new AchievementWaxAdmin(database);
  const schemaReady = Boolean(
    database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='achievement_badge_versions'",
      )
      .get(),
  );
  if ((values.enqueue || values.restore || values.history) && !schemaReady)
    throw new TypeError(
      "Run pnpm db:migrate before changing or reading image versions. This command never runs migrations.",
    );
  let result: unknown;
  if (values.enqueue)
    result = {
      mode: "enqueue",
      ...admin.enqueue(new Date().toISOString(), values.id),
    };
  else if (values.restore) {
    await admin.restore(
      values.id![0]!,
      values.restore,
      new KeepsakeAssetStore(
        values.assets ?? `${config.assetStoragePath}-achievements`,
      ),
      new Date().toISOString(),
    );
    result = { mode: "restore", id: values.id![0], sha256: values.restore };
  } else if (values.history)
    result = { mode: "history", versions: admin.versions(values.id![0]!) };
  else {
    const items = admin.plan(values.id);
    result = {
      mode: "dry-run",
      databasePath,
      schemaReady,
      total: items.length,
      toEnqueue: items.filter((row) => row.action === "enqueue").length,
      waitingForGeneration: items.filter(
        (row) => row.action === "wait-for-generating",
      ).length,
      alreadyV2: items.filter((row) => row.action === "already-v2").length,
      items,
    };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  database.close();
}
