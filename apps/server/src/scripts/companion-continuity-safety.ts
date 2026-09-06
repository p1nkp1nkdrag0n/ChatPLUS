import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { CharacterSpecSchema, type CharacterSpec } from "@personasim/contracts";
import BetterSqlite3 from "better-sqlite3";
import { z } from "zod";

import type { Database } from "../db/connection.js";
import { sha256File } from "./companion-long-run-v2-baseline.js";
import type { ContinuityScenario } from "./companion-continuity-input.js";
import { continuityHash } from "./continuity-run-identity.js";

/**
 * SQLite owns the cross-process lease, so process death releases it atomically.
 * The adjacent owner record is diagnostic only; no racy stale-file unlink can
 * remove a successor's lock. Keep the lock database after releasing its lease.
 */
export async function withContinuityRunLock<T>(
  directory: string,
  work: () => Promise<T>,
): Promise<T> {
  const lockPath = `${resolve(directory)}.run-lock.sqlite`;
  const ownerPath = `${resolve(directory)}.run-lock.owner.json`;
  await mkdir(dirname(lockPath), { recursive: true });
  const lock = new BetterSqlite3(lockPath, { timeout: 0 });
  const token = randomUUID();
  let acquired = false;
  try {
    try {
      lock.exec(
        "CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY, token TEXT NOT NULL)",
      );
      lock.exec("BEGIN EXCLUSIVE");
      acquired = true;
      lock
        .prepare("INSERT OR REPLACE INTO lease (id, token) VALUES (1, ?)")
        .run(token);
    } catch (error) {
      if ((error as { code?: string }).code === "SQLITE_BUSY")
        throw new Error("continuity_run_already_locked", { cause: error });
      throw error;
    }
    // A previous owner file can survive a killed process. Acquiring the OS-backed
    // lease proves that owner no longer holds it, even if its PID was reused.
    await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token }), {
      mode: 0o600,
    });
    return await work();
  } finally {
    try {
      if (acquired) {
        try {
          const owner: unknown = JSON.parse(await readFile(ownerPath, "utf8"));
          if (
            z.object({ token: z.string() }).safeParse(owner).data?.token ===
            token
          )
            await unlink(ownerPath);
        } catch {
          // Diagnostic corruption must not keep an OS lease alive or erase an
          // unrecognized owner record. Preserve the record for inspection.
        } finally {
          if (lock.inTransaction) lock.exec("ROLLBACK");
        }
      }
    } finally {
      lock.close();
    }
  }
}

const BaselineManifestSchema = z.object({
  characterId: z.string(),
  version: z.number().int().positive(),
  characterSha256: z.string().regex(/^[a-f0-9]{64}$/),
  databaseSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export async function verifyContinuityBaseline(directory: string): Promise<{
  character: CharacterSpec;
  characterSha256: string;
  databaseSha256: string;
}> {
  const path = join(directory, "baseline.sqlite");
  const [manifestText, characterText, databaseSha256] = await Promise.all([
    readFile(join(directory, "baseline-manifest.json"), "utf8"),
    readFile(join(directory, "baseline-character.json"), "utf8"),
    sha256File(path),
  ]);
  const manifest = BaselineManifestSchema.parse(JSON.parse(manifestText));
  const character = CharacterSpecSchema.parse(JSON.parse(characterText));
  const characterSha256 = continuityHash(character);
  if (
    character.status !== "published" ||
    manifest.characterId !== character.id ||
    manifest.version !== character.version ||
    manifest.characterSha256 !== characterSha256 ||
    manifest.databaseSha256 !== databaseSha256
  )
    throw new Error("continuity_baseline_manifest_mismatch");
  // A baseline is a completed SQLite backup, never a live main file needing WAL.
  try {
    if ((await readFile(`${path}-wal`)).length > 0)
      throw new Error("continuity_baseline_requires_consistent_backup");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  const database = new BetterSqlite3(path, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const row = database
      .prepare(
        `SELECT c.status AS head_status, cv.status AS version_status, cv.spec_json
      FROM characters c JOIN character_versions cv
      ON cv.character_id = c.id AND cv.version = c.current_version WHERE c.id = ?`,
      )
      .get(character.id) as
      | { head_status: string; version_status: string; spec_json: string }
      | undefined;
    if (
      row === undefined ||
      row.head_status !== "published" ||
      row.version_status !== "published" ||
      continuityHash(CharacterSpecSchema.parse(JSON.parse(row.spec_json))) !==
        characterSha256
    )
      throw new Error("continuity_baseline_character_mismatch");
    const userMessages = database
      .prepare("SELECT COUNT(*) AS count FROM messages WHERE role = 'user'")
      .get() as { count: number };
    if (userMessages.count !== 0)
      throw new Error("continuity_baseline_contains_user_probes");
  } finally {
    database.close();
  }
  if ((await sha256File(path)) !== databaseSha256)
    throw new Error("continuity_baseline_changed_during_verification");
  return { character, characterSha256, databaseSha256 };
}

export interface ContinuityResumeJournal {
  completedTurns: number;
  agentId?: string;
  sessions: Record<string, string>;
}

const TraceSchema = z.object({
  turn: z.number().int().positive(),
  response: z.object({
    userMessage: z.object({
      id: z.string(),
      sessionId: z.string(),
      agentId: z.string(),
      role: z.literal("user"),
      messageKind: z.literal("user"),
      content: z.string(),
      clientMessageId: z.string(),
    }),
    assistantMessage: z.object({
      id: z.string(),
      sessionId: z.string(),
      agentId: z.string(),
      role: z.literal("assistant"),
      messageKind: z.literal("assistant_reply"),
      content: z.string(),
      inReplyToMessageId: z.string(),
    }),
  }),
});

/** Check committed history before skipping any completed turn on resume. */
export async function verifyContinuityResume(
  database: Database,
  journal: ContinuityResumeJournal,
  scenario: ContinuityScenario,
  runId: string,
  directory: string,
): Promise<void> {
  if (
    !Number.isInteger(journal.completedTurns) ||
    journal.completedTurns < 0 ||
    journal.completedTurns > scenario.steps.length ||
    typeof journal.sessions !== "object" ||
    journal.sessions === null ||
    (journal.completedTurns > 0 && typeof journal.agentId !== "string")
  )
    throw new Error("continuity_invalid_resume_journal");
  for (const step of scenario.steps.slice(0, journal.completedTurns)) {
    const sessionId = journal.sessions[step.sessionKey];
    const clientMessageId = step.clientMessageIdTemplate.replaceAll(
      "{runId}",
      runId,
    );
    const source = database
      .prepare(
        `SELECT u.id AS user_id, u.content AS user_text, a.id AS assistant_id, a.content AS assistant_text
      FROM messages u JOIN sessions s ON s.id = u.session_id AND s.agent_id = u.agent_id
      JOIN messages a ON a.in_reply_to_message_id = u.id AND a.session_id = u.session_id AND a.agent_id = u.agent_id
      WHERE u.session_id = ? AND u.agent_id = ? AND u.client_message_id = ?
        AND u.role = 'user' AND u.message_kind = 'user' AND a.role = 'assistant' AND a.message_kind = 'assistant_reply'`,
      )
      .all(
        sessionId ?? null,
        journal.agentId ?? null,
        clientMessageId,
      ) as Array<{
      user_id: string;
      user_text: string;
      assistant_id: string;
      assistant_text: string;
    }>;
    if (source.length !== 1 || source[0]!.user_text !== step.userText)
      throw new Error(`continuity_resume_database_mismatch:turn_${step.turn}`);
    const trace = TraceSchema.parse(
      JSON.parse(
        await readFile(
          join(directory, `turn-${String(step.turn).padStart(3, "0")}.json`),
          "utf8",
        ),
      ),
    );
    const user = trace.response.userMessage;
    const assistant = trace.response.assistantMessage;
    if (
      trace.turn !== step.turn ||
      user.id !== source[0]!.user_id ||
      user.content !== step.userText ||
      user.clientMessageId !== clientMessageId ||
      user.sessionId !== sessionId ||
      user.agentId !== journal.agentId ||
      assistant.id !== source[0]!.assistant_id ||
      assistant.content !== source[0]!.assistant_text ||
      assistant.sessionId !== sessionId ||
      assistant.agentId !== journal.agentId ||
      assistant.inReplyToMessageId !== user.id
    )
      throw new Error(`continuity_resume_trace_mismatch:turn_${step.turn}`);
  }
}
