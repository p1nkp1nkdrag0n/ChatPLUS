import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { PressureEvidenceCorrectionService } from "../services/pressure-evidence-correction-service.js";
import { LifeRepository } from "../repositories/life-repository.js";

const { values } = parseArgs({
  strict: true,
  options: {
    source: { type: "string" },
    output: { type: "string" },
    agent: { type: "string" },
    pressure: { type: "string" },
    message: { type: "string", multiple: true },
    reason: { type: "string" },
    at: { type: "string" },
  },
});
if (
  !values.source ||
  !values.output ||
  !values.agent ||
  !values.pressure ||
  !values.message?.length ||
  !values.reason
)
  throw new Error(
    "Usage: tsx repair-pressure-snapshot.ts --source CLOSED_SNAPSHOT --output NEW_DIRECTORY --agent ID --pressure ID --message ID [--message ID] --reason TEXT",
  );
const source = realpathSync(values.source);
const output = resolve(values.output);
// Closed snapshots only. Never migrate/open the evidence DB or overwrite a run.
if (existsSync(output))
  throw new Error(
    "Output must be a new directory; existing evidence is never overwritten.",
  );
if (existsSync(`${source}-wal`) && statSync(`${source}-wal`).size > 0)
  throw new Error(
    "Use a closed, checkpointed SQLite backup, not an instance with a nonempty WAL.",
  );
const hash = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const beforeHash = hash(source);
mkdirSync(output, { recursive: true });
const backup = join(output, "before.sqlite");
const corrected = join(output, "corrected.sqlite");
copyFileSync(source, backup, constants.COPYFILE_EXCL);
copyFileSync(backup, corrected, constants.COPYFILE_EXCL);
if (hash(source) !== beforeHash || hash(backup) !== beforeHash)
  throw new Error(
    "Snapshot changed while copying; correction was not started.",
  );
const database = openDatabase(corrected);
let report: unknown;
try {
  const migrations = runMigrations(database);
  const store = new DatabaseStore(database);
  const service = new PressureEvidenceCorrectionService(store);
  const executedAtUtc = new Date().toISOString();
  const correctionAtUtc =
    values.at === undefined ? executedAtUtc : new Date(values.at).toISOString();
  const input = {
    agentId: values.agent,
    pressureEpisodeId: values.pressure,
    sourceMessageIds: values.message,
    reason: values.reason,
    nowUtc: correctionAtUtc,
  };
  const result = service.correct(input);
  const replay = service.correct(input);
  report = {
    source,
    sourceSha256: beforeHash,
    backupSha256: hash(backup),
    executedAtUtc,
    correctionAtUtc,
    migrations,
    result,
    replay,
    activePressureIds: new LifeRepository(database)
      .listOpenPressures(values.agent, 1000)
      .map((item) => item.id),
    originalUnchanged: hash(source) === beforeHash,
  };
  database.pragma("wal_checkpoint(TRUNCATE)");
} finally {
  database.close();
}
writeFileSync(
  join(output, "correction-report.json"),
  JSON.stringify(report, null, 2) + "\n",
  { flag: "wx" },
);
console.log(JSON.stringify({ output, report }, null, 2));
