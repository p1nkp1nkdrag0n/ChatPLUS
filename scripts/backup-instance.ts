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
    "achievement-assets": { type: "string" },
    output: { type: "string" },
    "env-file": { type: "string", default: ".env" },
    "llm-key-file": { type: "string" },
    "allow-missing-llm-key": { type: "boolean", default: false },
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
  ...(values["achievement-assets"] === undefined
    ? {}
    : { achievementAssetsPath: values["achievement-assets"] }),
  ...(values["llm-key-file"] === undefined
    ? {}
    : { llmKeyFile: values["llm-key-file"] }),
  allowMissingLlmKey: values["allow-missing-llm-key"],
  ...(process.env.INSTANCE_SECRET === undefined
    ? {}
    : { instanceSecret: process.env.INSTANCE_SECRET }),
});

process.stdout.write(
  `Backup complete: ${resolve(values.output)} (${manifest.database.latestSchemaMigration ?? "no migrations"}, ${manifest.assets.fileCount} keepsake assets, ${manifest.achievementAssets?.fileCount ?? 0} achievement assets)\n`,
);
if (manifest.llmKey)
  process.stdout.write(
    values["allow-missing-llm-key"]
      ? "Provider credentials require the matching LLM key file; without it, refill credentials after restoring.\n"
      : `Keep the LLM key file separately: ${resolve(values["llm-key-file"] ?? `${values.database}.llm-key`)} (not included in backup)\n`,
  );
