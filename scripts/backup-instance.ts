import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { backupInstance } from "../apps/server/src/runtime/instance-backup.js";

const { values } = parseArgs({
  strict: true,
  allowPositionals: false,
  options: {
    database: { type: "string" },
    assets: { type: "string" },
    output: { type: "string" },
    "env-file": { type: "string", default: ".env" },
  },
});

if (values.database === undefined || values.output === undefined) {
  throw new TypeError(
    "Usage: pnpm selfhost:backup -- --database <sqlite> --output <new-directory> [--assets <directory>] [--env-file <file>]",
  );
}

const envFile = resolve(values["env-file"]);
if (existsSync(envFile)) loadEnvFile(envFile);

const manifest = await backupInstance({
  databasePath: values.database,
  outputDirectory: values.output,
  ...(values.assets === undefined ? {} : { assetsPath: values.assets }),
  ...(process.env.INSTANCE_SECRET === undefined
    ? {}
    : { instanceSecret: process.env.INSTANCE_SECRET }),
});

process.stdout.write(
  `Backup complete: ${resolve(values.output)} (${manifest.database.latestSchemaMigration ?? "no migrations"}, ${manifest.assets.fileCount} assets)\n`,
);
