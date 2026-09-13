import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Database } from "./connection.js";

export function resolveMigrationDirectory(): string {
  return (
    process.env.PERSONASIM_MIGRATIONS_PATH ??
    join(dirname(fileURLToPath(import.meta.url)), "migrations")
  );
}

export function runMigrations(database: Database): string[] {
  const migrationDirectory = resolveMigrationDirectory();
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
    const rebuildsForeignKeyTarget = sql.startsWith(
      "-- requires-foreign-keys-off",
    );
    const foreignKeysEnabled =
      database.pragma("foreign_keys", { simple: true }) === 1;
    if (rebuildsForeignKeyTarget && database.inTransaction) {
      throw new Error(
        `Migration ${name} must run outside an existing transaction`,
      );
    }
    if (rebuildsForeignKeyTarget) database.pragma("foreign_keys = OFF");
    try {
      database.transaction(() => {
        database.exec(sql);
        if (
          rebuildsForeignKeyTarget &&
          database.prepare("PRAGMA foreign_key_check").all().length > 0
        ) {
          throw new Error(
            `Migration ${name} left invalid foreign-key references`,
          );
        }
        database
          .prepare(
            "INSERT INTO schema_migrations(name, applied_at_utc) VALUES (?, ?)",
          )
          .run(name, new Date().toISOString());
      })();
    } finally {
      if (rebuildsForeignKeyTarget && foreignKeysEnabled)
        database.pragma("foreign_keys = ON");
    }
    newlyApplied.push(name);
  }

  return newlyApplied;
}
