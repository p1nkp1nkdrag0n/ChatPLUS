import { openDatabase } from "./connection.js";
import { runMigrations } from "./migrations.js";
import { readConfig } from "../config.js";

const config = readConfig();
const database = openDatabase(config.databasePath);
try {
  const applied = runMigrations(database);
  process.stdout.write(
    applied.length > 0
      ? `Applied ${applied.length} migration(s): ${applied.join(", ")}\n`
      : "Database schema is already up to date.\n",
  );
} finally {
  database.close();
}
