import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { restoreInstance } from "../apps/server/src/runtime/instance-backup.js";

const { values } = parseArgs({
  strict: true,
  allowPositionals: false,
  options: {
    backup: { type: "string" },
    database: { type: "string" },
    assets: { type: "string" },
    "env-file": { type: "string", default: ".env" },
  },
});

if (
  values.backup === undefined ||
  values.database === undefined ||
  values.assets === undefined
) {
  throw new TypeError(
    "Usage: pnpm selfhost:restore -- --backup <directory> --database <new-sqlite> --assets <new-directory> [--env-file <file>]",
  );
}

const envFile = resolve(values["env-file"]);
if (existsSync(envFile)) loadEnvFile(envFile);

const manifest = await restoreInstance({
  backupDirectory: values.backup,
  targetDatabasePath: values.database,
  targetAssetsPath: values.assets,
  ...(process.env.INSTANCE_SECRET === undefined
    ? {}
    : { instanceSecret: process.env.INSTANCE_SECRET }),
});

process.stdout.write(
  `Restore complete: ${resolve(values.database)} (${manifest.database.latestSchemaMigration ?? "no migrations"}, ${manifest.assets.fileCount} assets)\n`,
);
