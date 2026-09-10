import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONVERSATION_RETENTION_POLICY } from "@personasim/contracts";
import type { LlmLogicalCallEvent } from "../services/llm-service.js";
import { ARCHITECTURE_PROBES } from "./architecture-evaluation-cases.js";
import {
  architectureConfig,
  architectureInstant,
  architectureFixtureFetch,
  createArchitectureRuntime,
  runArchitectureFullTurn,
  runArchitectureSimple,
} from "./architecture-evaluation-runtime.js";
import { captureContinuityRunIdentity } from "./continuity-run-identity.js";
import { createContinuityMeteredFetch } from "./continuity-metered-fetch.js";
import { redactLongRunArtifact } from "./companion-long-run-v2-artifacts.js";
import {
  readSteeringAttempts,
  steeringAttemptAccounting,
  visibleEvidence,
} from "./reply-steering-runner.js";
import {
  admitArchitectureOutput,
  architectureRunConfig,
} from "./architecture-run-admission.js";

/** Post-main instrumentation validation. No existing result is replaced. */
export async function runArchitectureTimestampValidation(options: {
  output: string;
  fixture?: boolean;
}) {
  if (!options.fixture && process.env["RUN_PAID_ARCHITECTURE_EVAL"] !== "1")
    throw new Error("Real calls require RUN_PAID_ARCHITECTURE_EVAL=1");
  const directory = admitArchitectureOutput(options.output);
  const { base, profile } = architectureRunConfig(
    directory,
    options.fixture === true,
  );
  mkdirSync(directory, { recursive: true });
  const config = {
    ...architectureConfig(base, profile, directory),
    conversationRetention: DEFAULT_CONVERSATION_RETENTION_POLICY,
  };
  const secrets = [profile.apiKey ?? "", base.instanceSecret ?? ""];
  const save = (name: string, value: unknown) =>
    writeFileSync(
      join(directory, name),
      JSON.stringify(
        redactLongRunArtifact(visibleEvidence(value), secrets),
        null,
        2,
      ) + "\n",
    );
  const probe = ARCHITECTURE_PROBES.find((x) => x.id === "P12")!;
  const history = probe.history.map((message, index) => ({
    ...message,
    createdAtUtc: new Date(
      Date.parse(architectureInstant()) -
        (probe.history.length - index) * 60000,
    ).toISOString(),
  }));
  const budget = { maxPhysicalRequests: 36, maxReservedTokenUnits: 4000000 };
  save(
    "manifest.json",
    await captureContinuityRunIdentity({
      config,
      experiment: {
        kind: "timestamp-instrumentation-validation-v1",
        fixture: !!options.fixture,
        candidates: 12,
        budget,
        history,
        currentTimeUtc: architectureInstant(4),
        outputCap: 24576,
        reason:
          "Original P12 prefixes were stamped immediately before day4 while the user referred to several elapsed days; full architecture had contradictory timestamp evidence unavailable to the undated baseline. This separate validation stamps the prefix on day0 and gives both simple arms those exact timestamps. It cannot replace the registered primary results or constitute a new holdout after tuning.",
      },
    }),
  );
  copyFileSync(
    fileURLToPath(import.meta.url),
    join(directory, "runner-source.ts"),
  );
  const hashes: Record<string, string> = {};
  for (const name of [
    "architecture-evaluation-runtime.ts",
    "architecture-evaluation-cases.ts",
    "architecture-persona-cases.ts",
  ]) {
    const path = join(resolve("apps/server/src/scripts"), name);
    hashes[name] = createHash("sha256")
      .update(readFileSync(path))
      .digest("hex");
    copyFileSync(path, join(directory, name));
  }
  save("source-hashes.json", hashes);
  const results: Record<string, unknown>[] = [];
  const tasks: Array<() => Promise<void>> = [];
  for (const personaId of ["social-outward", "social-private"])
    for (let repeat = 1; repeat <= 2; repeat++)
      for (const arm of repeat % 2 === 1
        ? ["full_native", "simple_recent", "simple_summary"]
        : ["simple_summary", "simple_recent", "full_native"]) {
        tasks.push(async () => {
          const id = `${personaId}-P12-r${repeat}-${arm}`;
          const cellDir = join(directory, id);
          let active: LlmLogicalCallEvent | undefined;
          const transport = createContinuityMeteredFetch({
            ledgerPath: join(directory, "attempts.jsonl"),
            budget,
            secrets,
            projectResponse: visibleEvidence,
            ...(options.fixture ? { fetch: architectureFixtureFetch } : {}),
            context: () => ({
              id,
              logicalCallIndex: active?.index,
              purpose: active?.purpose,
            }),
          });
          const onLogicalCall = (event: LlmLogicalCallEvent) => {
            if (event.stage === "started") active = event;
          };
          const cellConfig = {
            ...config,
            databasePath: join(cellDir, "turn.sqlite"),
            assetStoragePath: join(cellDir, "assets"),
          };
          let result: Record<string, unknown>;
          if (arm === "full_native") {
            const runtime = await createArchitectureRuntime({
              directory: cellDir,
              caseId: personaId,
              config: cellConfig,
              transport,
              onLogicalCall,
              history,
              nowUtc: architectureInstant(),
            });
            try {
              runtime.clock.setUtc(architectureInstant(4));
              result = await runArchitectureFullTurn(
                runtime,
                probe.userText,
                id,
              );
            } finally {
              await runtime.close();
            }
          } else
            result = await runArchitectureSimple({
              directory: cellDir,
              caseId: personaId,
              config: cellConfig,
              transport,
              onLogicalCall,
              history,
              userText: probe.userText,
              summaryMode: arm === "simple_summary" ? "rolling" : "recent",
              nowUtc: architectureInstant(4),
              maxOutputTokens: 24576,
            });
          const row = {
            id,
            personaId,
            probeId: "P12",
            repeat,
            arm,
            ...result,
            accounting: steeringAttemptAccounting(
              readSteeringAttempts(join(directory, "attempts.jsonl"), id),
            ),
          };
          results.push(row);
          save("results.json", results);
          console.log(`RESULT ${results.length}/12 ${id}`);
        });
      }
  // Pair-block alternation was specified before validation dispatch; immutable original run remains available.
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      while (cursor < tasks.length) await tasks[cursor++]!();
    }),
  );
  save("summary.json", {
    completed: results.length,
    errors: results.filter((x) => x["error"]).length,
    fixture: !!options.fixture,
  });
  return results;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--output");
  await runArchitectureTimestampValidation({
    output: i < 0 ? "tmp/architecture-timestamp-validation" : args[i + 1]!,
    fixture: args.includes("--fixture"),
  });
}
