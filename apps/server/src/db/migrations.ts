import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Database } from "./connection.js";

const migrationDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

export function runMigrations(database: Database): string[] {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at_utc TEXT NOT NULL
    )
  `);

  const applied = new Set(
    database
      .prepare("SELECT name FROM schema_migrations ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name),
  );
  const names = readdirSync(migrationDirectory)
    .filter((name) => /^\d+[_-].+\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right));
  const newlyApplied: string[] = [];

  for (const name of names) {
    if (applied.has(name)) continue;
    const sql = readFileSync(join(migrationDirectory, name), "utf8");
    database.transaction(() => {
      database.exec(sql);
      database
        .prepare(
          "INSERT INTO schema_migrations(name, applied_at_utc) VALUES (?, ?)",
        )
        .run(name, new Date().toISOString());
    })();
    newlyApplied.push(name);
  }

  return newlyApplied;
}
