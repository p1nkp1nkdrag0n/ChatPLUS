import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  CreateSessionResponseSchema,
  SendMessageResponseSchema,
  characterSpecSchema,
  type CharacterSpec,
} from "@personasim/contracts";
import { z } from "zod";

import { buildApp } from "../app.js";
import type { ServerConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";
import { writeContinuityAudit } from "./companion-continuity-audit.js";
import {
  withContinuityRunLock,
  verifyContinuityBaseline,
  verifyContinuityResume,
} from "./companion-continuity-safety.js";
import {
  redactLongRunArtifact,
  sha256Text,
} from "./companion-long-run-v2-artifacts.js";
import { sha256File } from "./companion-long-run-v2-baseline.js";
import {
  loadContinuityInputs,
  continuityMessageInput,
} from "./companion-continuity-input.js";
import {
  createContinuityMeteredFetch,
  type ContinuityRequestBudget,
} from "./continuity-metered-fetch.js";
import {
  captureContinuityRunIdentity,
  continuityHash,
  freezeContinuityManifest,
} from "./continuity-run-identity.js";
import { auditProductLifeDatabase } from "./product-life-long-run-audit.js";
import {
  dispatchProductLifeLetter,
  inspectProductLifeCorrespondence,
} from "./product-life-long-run-features.js";

export interface ContinuityRunOptions {
  runId: string;
  runDirectory: string;
  publicPath: string;
  oraclePath: string;
  config: ServerConfig;
  group: "A0" | "A1" | "A2";
  maxTurns: number;
  budget: ContinuityRequestBudget;
  resume?: boolean;
  /** Published, uncontaminated baseline from a previous run, not its final DB. */
  baselineDirectory?: string;
  onProgress?: (message: string) => void;
}

interface ContinuityJournal {
  schema: "continuity-journal-v1";
  status: "running" | "completed" | "restart_required" | "failed";
  completedTurns: number;
  nowUtc: string;
  agentId?: string;
  sessions: Record<string, string>;
  actions: Record<string, unknown>;
  generationStarted?: boolean;
  letterId?: string;
  error?: string;
}

export function buildContinuityConfig(
  options: ContinuityRunOptions,
  instanceSecret: string,
  start: string,
): ServerConfig {
  return {
    ...options.config,
    nodeEnv: "test",
    profile: "companion-continuity-real-v1",
    host: "127.0.0.1",
    databasePath: join(resolve(options.runDirectory), "personasim.sqlite"),
    clockMode: "fake",
    fakeClockStart: new Date(start).toISOString(),
    developerRoutes: true,
    seedDemo: false,
    serveWeb: false,
    selfHostedReverseProxy: false,
    chatEffectsMode: "gated",
    lifePlanningMode: "fuzzy",
    scheduleNegotiationMode: "off",
    selfInitiatedPlanningMode: "off",
    liveWorldEffectsMode: "enforced",
    companionContextMode: options.group === "A0" ? "off" : "enforced",
    personaRuntimeMode: options.group === "A2" ? "enforced" : "off",
    memoryRecallMode: "enforced",
    autobiographyMode: "enforced",
    correspondenceMode: "enforced",
    correspondenceExecution: "lazy",
    keepsakeMode: "enforced",
    assetStoragePath: join(resolve(options.runDirectory), "assets"),
    instanceSecret,
    // The main trajectory uses the actual configured production retention.
    // A stress experiment must freeze a distinct config/run identity.
  };
}

/** Fixed public inputs through the normal TCP HTTP application; no evaluator
 * answers, future turns or database exports enter model prompts. At D14 this
 * function closes and returns. The CLI resumes in a different OS process.
 */
export async function runCompanionContinuity(
  options: ContinuityRunOptions,
): Promise<ContinuityJournal> {
  return withContinuityRunLock(resolve(options.runDirectory), () =>
    runLockedContinuity(options),
  );
}

async function runLockedContinuity(
  options: ContinuityRunOptions,
): Promise<ContinuityJournal> {
  if (
    options.config.llm.provider !== "fixture" &&
    process.env.RUN_PAID_CONTINUITY !== "1"
  )
    throw new Error(
      "Real API execution requires explicit user authorization and RUN_PAID_CONTINUITY=1",
    );
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(options.runId) ||
    !Number.isInteger(options.maxTurns) ||
    options.maxTurns < 1 ||
    options.maxTurns > 120
  )
    throw new Error("invalid_continuity_run_options");
  const directory = resolve(options.runDirectory);
  const inputs = await loadContinuityInputs(
    options.publicPath,
    options.oraclePath,
  );
  if (options.baselineDirectory)
    await verifyContinuityBaseline(resolve(options.baselineDirectory));
  await mkdir(dirname(directory), { recursive: true });
  if (!options.resume) await mkdir(directory);
  const secretPath = join(directory, ".instance-secret");
  const instanceSecret = options.resume
    ? await readFile(secretPath, "utf8")
    : options.baselineDirectory
      ? await readFile(
          join(options.baselineDirectory, ".instance-secret"),
          "utf8",
        )
      : randomBytes(32).toString("base64");
  if (!options.resume)
    await writeFile(secretPath, instanceSecret, { flag: "wx", mode: 0o600 });
  const config = buildContinuityConfig(
    options,
    instanceSecret,
    inputs.scenario.simulatedStart,
  );
  const safe = (value: unknown) =>
    redactLongRunArtifact(value, [instanceSecret, config.llm.apiKey ?? ""]);
  const append = (name: string, value: unknown): void => {
    appendFileSync(join(directory, name), `${JSON.stringify(safe(value))}\n`);
  };
  const json = async (name: string, value: unknown): Promise<void> => {
    await writeFile(
      join(directory, `${name}.tmp`),
      `${JSON.stringify(safe(value), null, 2)}\n`,
    );
    await rename(join(directory, `${name}.tmp`), join(directory, name));
  };
  const baselineDirectory = options.baselineDirectory
    ? resolve(options.baselineDirectory)
    : undefined;
  const baselineSource = baselineDirectory
    ? {
        directory: baselineDirectory,
        databaseSha256: await sha256File(
          join(baselineDirectory, "baseline.sqlite"),
        ),
        characterSha256: sha256Text(
          await readFile(
            join(baselineDirectory, "baseline-character.json"),
            "utf8",
          ),
        ),
      }
    : null;
  const identity = await captureContinuityRunIdentity({
    config,
    experiment: {
      schema: "companion-continuity-real-v1",
      runId: options.runId,
      group: options.group,
      publicSha256: inputs.publicSha256,
      oracleSha256: inputs.oracleSha256,
      scenarioVersion: inputs.scenario.version,
      characterInputSha256: continuityHash(inputs.scenario.characterInput),
      maxTurns: options.maxTurns,
      budget: options.budget,
      baselineSource,
      scheduler: false,
      transport: "TCP-loopback",
      restart: "exit-and-resume-at-turn-64",
      timezone: inputs.scenario.timezone,
      node: process.version,
    },
  });
  await freezeContinuityManifest(
    join(directory, "manifest.json"),
    identity,
    options.resume === true,
  );
  if (!options.resume) {
    await writeFile(
      join(directory, "public-scenario.json"),
      inputs.publicText,
      { flag: "wx" },
    );
    await writeFile(join(directory, "oracle.private.json"), inputs.oracleText, {
      flag: "wx",
      mode: 0o600,
    });
    if (baselineDirectory)
      await copyFile(
        join(baselineDirectory, "baseline.sqlite"),
        config.databasePath,
      );
  } else {
    if (
      sha256Text(
        await readFile(join(directory, "public-scenario.json"), "utf8"),
      ) !== inputs.publicSha256 ||
      sha256Text(
        await readFile(join(directory, "oracle.private.json"), "utf8"),
      ) !== inputs.oracleSha256
    )
      throw new Error("continuity_saved_inputs_changed");
  }
  const journal: ContinuityJournal = options.resume
    ? (JSON.parse(
        await readFile(join(directory, "journal.json"), "utf8"),
      ) as ContinuityJournal)
    : {
        schema: "continuity-journal-v1",
        status: "running",
        completedTurns: 0,
        nowUtc: config.fakeClockStart,
        sessions: {},
        actions: {},
      };
  if (options.resume && !existsSync(config.databasePath))
    throw new Error("continuity_resume_database_missing");
  const resumeDatabase = options.resume
    ? openDatabase(config.databasePath)
    : undefined;
  if (resumeDatabase) {
    try {
      await verifyContinuityResume(
        resumeDatabase,
        journal,
        inputs.scenario,
        options.runId,
        directory,
      );
      if (existsSync(join(directory, "baseline-manifest.json")))
        await verifyContinuityBaseline(directory);
    } finally {
      resumeDatabase.close();
    }
  }
  if (journal.status === "completed") return journal;
  if (journal.status === "restart_required") {
    journal.nowUtc = new Date(
      Date.parse(inputs.scenario.simulatedStart) + 18 * 86400000,
    ).toISOString();
    append("feature-evidence.jsonl", {
      kind: "restart",
      previousPid: journal.actions.restartPid,
      pid: process.pid,
      distinctProcess: journal.actions.restartPid !== process.pid,
      nowUtc: journal.nowUtc,
    });
  }
  journal.status = "running";
  delete journal.error;
  await json("journal.json", journal);
  const clock = new FakeClock(journal.nowUtc);
  const database = openDatabase(config.databasePath);
  let activeTurn = 0;
  const startupFailure = async (error: unknown): Promise<never> => {
    if (database.open) database.close();
    journal.status = "failed";
    journal.error = error instanceof Error ? error.message : String(error);
    await json("journal.json", journal);
    throw error;
  };
  const app = await buildApp({
    config,
    database,
    clock,
    seedDemo: false,
    startScheduler: false,
    logger: false,
    llmObservation: {
      fetch: createContinuityMeteredFetch({
        ledgerPath: join(directory, "attempts.jsonl"),
        budget: options.budget,
        secrets: [config.llm.apiKey ?? "", instanceSecret],
        context: () => ({ turn: activeTurn, atUtc: clock.nowUtc() }),
      }),
      promptDiagnostics: true,
      onLogicalCall: (event) =>
        append("model-io.jsonl", { turn: activeTurn, ...event }),
      onMetric: (metric) =>
        append("provider-metrics.jsonl", { turn: activeTurn, ...metric }),
    },
  }).catch(startupFailure);
  const origin = await app
    .listen({ host: "127.0.0.1", port: 0 })
    .catch(async (error: unknown) => {
      await app.close();
      return startupFailure(error);
    });
  const replayCounters = () => ({
    messages: database.prepare("SELECT count(*) AS n FROM messages").get(),
    logicalCalls: database.prepare("SELECT count(*) AS n FROM llm_calls").get(),
    // Includes reservations whose transport response/usage was never received.
    physicalCalls: existsSync(join(directory, "attempts.jsonl"))
      ? readFileSync(join(directory, "attempts.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { stage: string })
          .filter((row) => row.stage === "reserved").length
      : 0,
  });
  const http = async (
    method: "GET" | "POST",
    path: string,
    payload?: unknown,
  ) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const body: unknown = await response.json();
    append("http.jsonl", {
      turn: activeTurn,
      method,
      path,
      status: response.status,
      body,
      atUtc: clock.nowUtc(),
    });
    // The product may turn a provider failure into a user-facing fallback.
    // Admission failures still stop this experiment, even after HTTP 200.
    const ledgerPath = join(directory, "attempts.jsonl");
    if (
      existsSync(ledgerPath) &&
      readFileSync(ledgerPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .some(
          (line) =>
            (JSON.parse(line) as { stage?: string }).stage === "blocked",
        )
    )
      throw new Error("physical_request_budget_reached");
    if (!response.ok)
      throw new Error(`continuity_http_${response.status}:${path}`);
    return body;
  };
  const save = async (): Promise<void> => {
    journal.nowUtc = clock.nowUtc();
    await json("journal.json", journal);
  };
  const snapshot = async (name: string): Promise<void> => {
    const path = join(directory, `${name}.sqlite`);
    if (!existsSync(path)) await database.backup(path);
    append("feature-evidence.jsonl", {
      kind: "sqlite_backup",
      name,
      databaseSha256: await sha256File(path),
      atUtc: clock.nowUtc(),
    });
  };
  try {
    let character: CharacterSpec;
    if (journal.agentId) {
      character = characterSpecSchema.parse(
        app.personasim.store.getCharacterSpec(journal.agentId),
      );
    } else if (baselineDirectory) {
      character = characterSpecSchema.parse(
        JSON.parse(
          await readFile(
            join(baselineDirectory, "baseline-character.json"),
            "utf8",
          ),
        ),
      );
      const actual = app.personasim.store.getCharacterSpec(character.id);
      if (continuityHash(actual) !== continuityHash(character))
        throw new Error("continuity_imported_baseline_mismatch");
      journal.agentId = character.id;
      await save();
    } else {
      const draftPath = join(directory, "generated-character.json");
      if (journal.generationStarted && !existsSync(draftPath))
        throw new Error(
          "continuity_generation_outcome_unknown: inspect evidence before a new run",
        );
      journal.generationStarted = true;
      await save();
      const generated = existsSync(draftPath)
        ? characterSpecSchema.parse(
            JSON.parse(await readFile(draftPath, "utf8")),
          )
        : z
            .object({ character: characterSpecSchema })
            .parse(
              await http(
                "POST",
                "/api/characters/generate",
                inputs.scenario.characterInput,
              ),
            ).character;
      await json("generated-character.json", generated);
      if (
        generated.compilationPolicyVersion !== "companion_character_v2" ||
        generated.persona.goals.length !== 0 ||
        generated.persona.contradictions.length !== 0
      )
        throw new Error("continuity_zero_goal_character_generation_failed");
      character = z.object({ character: characterSpecSchema }).parse(
        await http("POST", `/api/characters/${generated.id}/publish`, {
          expectedVersion: generated.version,
        }),
      ).character;
      journal.agentId = character.id;
      await save();
    }
    await freezeContinuityManifest(
      join(directory, "baseline-character.json"),
      character,
      existsSync(join(directory, "baseline-character.json")),
    );
    if (!existsSync(join(directory, "baseline.sqlite")))
      await snapshot("baseline");
    await freezeContinuityManifest(
      join(directory, "baseline-manifest.json"),
      {
        characterId: character.id,
        version: character.version,
        characterSha256: continuityHash(character),
        databaseSha256: await sha256File(join(directory, "baseline.sqlite")),
      },
      existsSync(join(directory, "baseline-manifest.json")),
    );

    for (const step of inputs.scenario.steps.slice(0, options.maxTurns)) {
      if (step.turn <= journal.completedTurns) continue;
      activeTurn = step.turn;
      clock.setUtc(
        new Date(
          Date.parse(inputs.scenario.simulatedStart) +
            step.simulatedDay * 86400000 +
            step.minuteInSession * 60000,
        ).toISOString(),
      );
      if (!journal.sessions[step.sessionKey]) {
        const title = `${options.runId}-${step.sessionKey}`;
        const existing = database
          .prepare(
            "SELECT id FROM sessions WHERE agent_id = ? AND title = ? ORDER BY created_at_utc LIMIT 1",
          )
          .get(character.id, title) as { id: string } | undefined;
        journal.sessions[step.sessionKey] =
          existing?.id ??
          CreateSessionResponseSchema.parse(
            await http("POST", `/api/agents/${character.id}/sessions`, {
              title,
            }),
          ).session.id;
        await save();
      }
      const arrivalKey = `arrival-${step.sessionKey}`;
      if (!journal.actions[arrivalKey]) {
        await http("POST", `/api/agents/${character.id}/activate`, {});
        if (journal.letterId) {
          const letters = await inspectProductLifeCorrespondence(
            app,
            character.id,
            { incomingLetterId: journal.letterId, openReply: true },
          );
          append("feature-evidence.jsonl", {
            kind: "correspondence",
            turn: step.turn,
            ...letters,
          });
          if (letters.status === "failed")
            throw new Error("continuity_correspondence_failed");
        }
        journal.actions[arrivalKey] = true;
        await save();
      }
      const payload = continuityMessageInput(
        inputs.scenario,
        step.turn,
        options.runId,
        character.id,
      );
      // Durable input intent precedes any model call; retries always use this ID.
      append("input-journal.jsonl", {
        turn: step.turn,
        sessionId: journal.sessions[step.sessionKey],
        payload,
        atUtc: clock.nowUtc(),
      });
      const before = auditProductLifeDatabase(database, character.id);
      const response = SendMessageResponseSchema.parse(
        await http(
          "POST",
          `/api/sessions/${journal.sessions[step.sessionKey]}/messages`,
          payload,
        ),
      );
      const after = auditProductLifeDatabase(database, character.id);
      const trace = {
        turn: step.turn,
        atUtc: clock.nowUtc(),
        response,
        before,
        after,
      };
      await json(`turn-${String(step.turn).padStart(3, "0")}.json`, trace);
      append("turn-evidence.jsonl", trace);
      append("persona-audit.jsonl", {
        turn: step.turn,
        metadata: response.assistantMessage.metadata,
      });
      append("checkpoint-evidence.jsonl", {
        turn: step.turn,
        checkpoints: database
          .prepare(
            "SELECT * FROM conversation_checkpoints WHERE agent_id = ? ORDER BY created_at_utc",
          )
          .all(character.id),
      });
      append("retrieval-runs.jsonl", {
        turn: step.turn,
        diagnostic: response.memoryRecall,
        metadata: response.assistantMessage.metadata,
      });
      // A replay goes through the product idempotency path and must not call a model.
      const callsBeforeReplay = replayCounters();
      const replay = SendMessageResponseSchema.parse(
        await http(
          "POST",
          `/api/sessions/${journal.sessions[step.sessionKey]}/messages`,
          payload,
        ),
      );
      if (
        replay.assistantMessage.id !== response.assistantMessage.id ||
        continuityHash(callsBeforeReplay) !== continuityHash(replayCounters())
      )
        throw new Error("continuity_idempotency_failed");
      append("feature-evidence.jsonl", {
        kind: "idempotency",
        turn: step.turn,
        assistantMessageId: replay.assistantMessage.id,
        countersBeforeReplay: callsBeforeReplay,
        countersAfterReplay: replayCounters(),
        passed: true,
      });
      // Complete actions before advancing the journal; interrupted turns replay safely.
      for (const action of inputs.scenario.driverOnlyActions.filter(
        (item) => item.afterTurn === step.turn,
      )) {
        if (journal.actions[action.action]) continue;
        if (action.action === "dispatch_letter_via_existing_product_helper") {
          const result = await dispatchProductLifeLetter(app, character.id, {
            requestId: `${options.runId}-letter`,
            subject: "一些普通近况",
            body: action.body ?? "",
          });
          append("feature-evidence.jsonl", {
            turn: step.turn,
            kind: action.action,
            ...result,
          });
          if (result.status === "failed" || !result.letterId)
            throw new Error("continuity_letter_dispatch_failed");
          journal.letterId = result.letterId;
        } else if (
          action.action === "create_consistent_backup_for_value_probe_siblings"
        )
          await snapshot("value-siblings-turn-088");
        else if (
          action.action === "final_consistent_backup_and_independent_review"
        )
          await snapshot("final");
        else {
          journal.actions.restartPid = process.pid;
          journal.status = "restart_required";
          await snapshot("before-process-exit");
        }
        journal.actions[action.action] = true;
        await save();
      }
      journal.completedTurns = step.turn;
      await save();
      options.onProgress?.(
        `${options.runId}: ${step.turn}/${options.maxTurns} ${step.sessionKey}`,
      );
      if (journal.status === "restart_required") return journal;
    }
    journal.status = "completed";
    await snapshot("final");
    await save();
    return journal;
  } catch (error) {
    journal.status = "failed";
    journal.error = error instanceof Error ? error.message : String(error);
    await save();
    return journal;
  } finally {
    await app.close();
    if (database.open) database.close();
    const turns = [];
    for (let turn = 1; turn <= journal.completedTurns; turn += 1) {
      const path = join(
        directory,
        `turn-${String(turn).padStart(3, "0")}.json`,
      );
      if (existsSync(path))
        turns.push(
          JSON.parse(await readFile(path, "utf8")) as {
            turn: number;
            response: z.infer<typeof SendMessageResponseSchema>;
          },
        );
    }
    await writeFile(
      join(directory, "conversation.md"),
      turns
        .map(
          (item) =>
            `### ${item.turn}\n\n用户：${item.response.userMessage.content}\n\n角色：${item.response.assistantMessage.content}\n`,
        )
        .join("\n"),
    );
    await json("run-summary.json", {
      status: journal.status,
      completedTurns: journal.completedTurns,
      plannedTurns: options.maxTurns,
      acceptance: "PARTIAL",
      semanticReview: "pending",
      humanExperience: "not_evaluated",
      oracleSha256: inputs.oracleSha256,
      uncovered: [
        "independent semantic review",
        "checkpoint stress lane",
        "character B life lane",
        "value sibling evaluation",
        "letter time-travel sibling cases",
      ],
      error: journal.error,
    });
    await writeContinuityAudit(directory);
  }
}
