import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp } from "../app.js";
import { readConfig, readLlmProfileConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";
import type { ChatTurnResult } from "../services/conversation-service.js";
import type { GenerateObjectInput } from "../services/llm-service.js";
import qwenRegressions from "../test-fixtures/qwen-fresh-regressions.json";
import { redactLongRunArtifact } from "./companion-long-run-v2-artifacts.js";
import { createContinuityMeteredFetch } from "./continuity-metered-fetch.js";
import {
  captureContinuityRunIdentity,
  CONTINUITY_WORKSPACE_ROOT,
  continuityHash,
  freezeContinuityManifest,
} from "./continuity-run-identity.js";

const BUDGET = { maxPhysicalRequests: 5, maxReservedTokenUnits: 500_000 };
const START = "2026-09-07T00:00:00.000Z";
const REQUEST = "以后聊工作时，请先听我说，不要急着给建议。";
const BAD_MEMORY =
  "你之前一直记得先听我说不急着给建议，那份是你主动给的，跟这事是两码事。";
const SAFE_REPAIR = "听起来这一天挺耗神的，我在听。";
const CHARACTER_INPUT = {
  name: "许岚",
  worldSetting: "当代城市",
  workOrRole: "设计师",
  coreTraits: ["直接", "温和", "独立"],
  relationshipToUser: "朋友",
  dialogueStyle: "自然简洁",
  tier: "high_fidelity",
  timezone: "Asia/Shanghai",
};
const CASES = [
  {
    id: "advice-original-t6",
    track: "injected_bad_reply_real_repair",
    user: `${qwenRegressions.advice.userText}今天我只想吐槽一句，不用替我解决。`,
    reply: qwenRegressions.advice.assistantText,
    repairs: 1,
    characterPressure: false,
    origin: "verbatim Qwen pilot T6 failure, plus explicit current none_now request",
  },
  {
    id: "advice-unparsed-action",
    track: "injected_bad_reply_real_repair",
    user: "今天改了一天东西，我只想吐槽一句，不用替我解决。",
    reply: "你可以把旧票根粘成一张拼贴。",
    repairs: 1,
    characterPressure: false,
    origin: "new explicit action outside the finite action vocabulary",
  },
  {
    id: "advice-example-holdout",
    track: "injected_bad_reply_real_repair",
    user: "今天改了一天东西，我只想吐槽一句，不用替我解决。",
    reply:
      "不如找件随手的小事，比如给旧照片换个相框，或者试着编一段口哨旋律。",
    repairs: 1,
    characterPressure: false,
    origin: "new coordinated-example paraphrase; no production rule changes for this case",
  },
  {
    id: "state-user-experiencer-holdout",
    track: "fixed_reply_state_stub",
    user: "今天的工作终于收尾了，我只想说一句，不用替我解决。",
    reply: "你最近压力很大，累得不行，我听到了。",
    repairs: 0,
    characterPressure: false,
    origin: "second-person fatigue must not create character pressure",
  },
  {
    id: "state-character-authorized-holdout",
    track: "fixed_reply_state_stub",
    user: "你最近怎么样？不用给我建议，聊聊你的近况就好。",
    reply: "我这两天压力很大，确实累得不行。",
    repairs: 0,
    characterPressure: true,
    origin: "first-person feeling supported by independent pre-turn runtime state",
  },
] as const;

/** Track C deliberately injects chat output. Only repair_chat_turn may reach the
 * real provider; this is not a natural-dialogue run or part of its 9/3 denominator.
 * Every invocation requires a new ignored directory. Failed runs are retained.
 */
export async function runQwenRepairHoldout(options: {
  runDirectory: string;
  fixture: boolean;
}) {
  if (!options.fixture && process.env.RUN_PAID_CONTINUITY !== "1")
    throw new Error("Paid repair requires RUN_PAID_CONTINUITY=1 and prior user authorization");
  // Check the gate before reading any paid credentials.
  const llm = options.fixture
    ? {
        provider: "openai-compatible" as const,
        baseUrl: "https://fixture.invalid",
        apiKey: "fixture-only-never-dispatched",
        model: "fixture-repair",
        timeoutMs: 1_000,
        maxRetries: 0,
        maxOutputTokens: 8_192,
      }
    : { ...readLlmProfileConfig("qwen"), maxRetries: 0, maxOutputTokens: 8_192 };
  if (!llm.apiKey) throw new Error("Qwen profile API key is missing");
  const apiKey = llm.apiKey;
  const directory = resolve(options.runDirectory);
  const relativeDirectory = relative(CONTINUITY_WORKSPACE_ROOT, directory);
  if (!relativeDirectory || relativeDirectory.startsWith("..") || isAbsolute(relativeDirectory))
    throw new Error("Output must be a new ignored directory inside the workspace");
  execFileSync("git", ["check-ignore", "--quiet", "--", join(directory, "manifest.json")], {
    cwd: CONTINUITY_WORKSPACE_ROOT,
    windowsHide: true,
    stdio: "pipe",
  });
  if (existsSync(directory)) throw new Error("Output directory already exists; never overwrite or resume this holdout");
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory);
  const instanceSecret = randomBytes(32).toString("base64");
  const config = readConfig({
    nodeEnv: "test",
    host: "127.0.0.1",
    databasePath: join(directory, "personasim.sqlite"),
    assetStoragePath: join(directory, "assets"),
    instanceSecret,
    clockMode: "fake",
    fakeClockStart: START,
    seedDemo: false,
    serveWeb: false,
    developerRoutes: true,
    chatEffectsMode: "gated",
    lifePlanningMode: "fuzzy",
    selfInitiatedPlanningMode: "off",
    scheduleNegotiationMode: "off",
    companionContextMode: "enforced",
    personaRuntimeMode: "enforced",
    liveWorldEffectsMode: "enforced",
    autobiographyMode: "off",
    memoryRecallMode: "enforced",
    correspondenceMode: "off",
    llm,
  });
  const safe = (value: unknown) => redactLongRunArtifact(value, [instanceSecret, apiKey]);
  const append = (name: string, value: unknown) =>
    appendFileSync(join(directory, name), `${JSON.stringify(safe(value))}\n`);
  const json = (name: string, value: unknown) =>
    writeFile(join(directory, name), `${JSON.stringify(safe(value), null, 2)}\n`, { flag: "wx" });
  const identity = await captureContinuityRunIdentity({
    config,
    experiment: {
      schema: "qwen-repair-holdout-v1",
      mode: options.fixture ? "fixture-dry-run-zero-paid" : "real-repair-only",
      budget: BUDGET,
      scheduler: false,
      transport: "TCP-loopback",
      character: "new fixture-generated character, separate sessions, isolated database",
      characterInput: CHARACTER_INPUT,
      cases: CASES,
      badMemory: BAD_MEMORY,
      fixtureRepair: SAFE_REPAIR,
      paidPurposes: ["repair_chat_turn"],
      prohibitedInterpretation: "Not natural dialogue, generation validation, or the 9 ordinary / 3 help denominator",
      node: process.version,
    },
  });
  await freezeContinuityManifest(join(directory, "manifest.json"), identity, false);
  await json("cases.json", CASES);
  const ledgerPath = join(directory, "attempts.jsonl");
  await writeFile(ledgerPath, "", { flag: "wx" });
  const usage = () => {
    const reservations = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { stage: string; reservedTokenUnits?: number })
      .filter((row) => row.stage === "reserved");
    return { physicalRequests: reservations.length,
      reservedTokenUnits: reservations.reduce((sum, row) => sum + (row.reservedTokenUnits ?? 0), 0) };
  };
  let activeCase = "character-fixture";
  let activePhase: "setup" | "seed" | "case" | "replay" = "setup";
  let activePurpose = "none";
  let injected: unknown;
  const calls: Array<{ caseId: string; purpose: string; route: string; success?: boolean }> = [];
  const app = await buildApp({
    config,
    database: openDatabase(config.databasePath),
    clock: new FakeClock(START),
    seedDemo: false,
    startScheduler: false,
    logger: false,
    llmObservation: {
      fetch: createContinuityMeteredFetch({
        ledgerPath, budget: BUDGET, secrets: [instanceSecret, apiKey],
        context: () => ({ caseId: activeCase, phase: activePhase, purpose: activePurpose }),
        fetch: async (url, init) => {
          if (options.fixture || activePurpose !== "repair_chat_turn" || activePhase !== "case")
            throw new Error("holdout_transport_scope_violation");
          return globalThis.fetch(url, init);
        },
      }),
      promptDiagnostics: true,
      onLogicalCall: (event) => append("model-io.jsonl", { caseId: activeCase, ...event }),
      onMetric: (metric) => append("provider-metrics.jsonl", { caseId: activeCase, ...metric }),
    },
  });
  const original = app.personasim.llm.generateObject.bind(app.personasim.llm);
  app.personasim.llm.generateObject = async <T>(input: GenerateObjectInput<T>): Promise<T> => {
    const route = input.purpose === "repair_chat_turn" && !options.fixture ? "paid-repair"
      : input.purpose === "chat_turn" ? "fixed-injection" : "fixture-stub";
    const call: (typeof calls)[number] = { caseId: activeCase, purpose: input.purpose, route };
    calls.push(call);
    append("dispatch.jsonl", { ...call, stage: "started", system: input.system, prompt: input.prompt });
    try {
      activePurpose = input.purpose;
      let output: T;
      if (input.purpose === "repair_chat_turn") {
        assert.equal(activePhase, "case", "Repairs outside the holdout case are blocked");
        output = options.fixture
          ? input.schema.parse({ text: SAFE_REPAIR, deliveryMode: "single_block" })
          : await original({ ...input, maxRetries: 0 });
      } else if (input.purpose === "chat_turn") {
        assert.notEqual(injected, undefined, "Missing fixed chat injection");
        output = input.schema.parse(injected);
        injected = undefined;
      } else {
        assert.notEqual(input.fixture, undefined, `Unstubbed non-repair purpose: ${input.purpose}`);
        output = input.schema.parse(input.fixture);
      }
      call.success = true;
      append("dispatch.jsonl", { ...call, stage: "completed", output });
      return output;
    } catch (error) {
      call.success = false;
      append("dispatch.jsonl", { ...call, stage: "failed", error: String(error) });
      throw error;
    } finally { activePurpose = "none"; }
  };
  const reports: unknown[] = [];
  let status = "failed";
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const post = async <T>(url: string, payload: unknown, expected: number): Promise<T> => {
      const response = await globalThis.fetch(`${address}${url}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      });
      const body: unknown = await response.json();
      assert.equal(response.status, expected, JSON.stringify(safe(body)).slice(0, 1_000));
      return body as T;
    };
    const generated = await post<{ character: { id: string; version: number } }>(
      "/api/characters/generate", CHARACTER_INPUT, 201);
    const agentId = generated.character.id;
    await post(`/api/characters/${agentId}/publish`, { expectedVersion: generated.character.version }, 200);
    await json("fixture-character.json", generated);
    const db = app.personasim.store.database;
    const snapshot = () => ({
      memories: db.prepare("SELECT * FROM memories WHERE agent_id = ?").all(agentId),
      pressure: db.prepare("SELECT * FROM pressure_episodes WHERE agent_id = ?").all(agentId) as Array<{ id: string; subject: string; episode_json: string }>,
      rejected: db.prepare("SELECT * FROM rejected_proposals").all(),
      events: db.prepare("SELECT * FROM domain_events").all(),
      messages: db.prepare("SELECT * FROM messages WHERE agent_id = ?").all(agentId),
    });
    for (const testCase of CASES) {
      activeCase = testCase.id;
      activePhase = "seed";
      const session = await post<{ session: { id: string } }>(`/api/agents/${agentId}/sessions`, {}, 201);
      const url = `/api/sessions/${session.session.id}/messages`;
      injected = { replyDecision: { text: "聊工作时，我会先听你说。" }, worldEffects: {} };
      await post(url, { agentId, text: REQUEST, clientMessageId: `${testCase.id}-seed` }, 201);
      const state = app.personasim.store.getRuntimeState(agentId)!;
      app.personasim.store.updateRuntimeState({ ...state,
        stress: testCase.characterPressure ? 0.75 : 0.1,
        energy: testCase.characterPressure ? 0.3 : 0.9 });
      const before = snapshot();
      const beforeUsage = usage();
      const beforeCalls = calls.length;
      activePhase = "case";
      const raw = {
        replyDecision: { text: testCase.reply },
        worldEffects: testCase.repairs ? { memoryCandidates: [{
          type: "relationship", content: BAD_MEMORY, importance: 0.8, confidence: 0.8,
        }] } : {},
      };
      injected = raw;
      await json(`${testCase.id}.raw.json`, { testCase, injected: raw, independentPreTurnState: app.personasim.store.getRuntimeState(agentId) });
      const payload = { agentId, text: testCase.user, clientMessageId: testCase.id };
      const final = await post<ChatTurnResult>(url, payload, 201);
      const after = snapshot();
      const afterUsage = usage();
      const caseCalls = calls.slice(beforeCalls);
      const repairCalls = caseCalls.filter((call) => call.purpose === "repair_chat_turn");
      const guard = final.assistantMessage.metadata.semanticReplyGuard as {
        repairCalls?: number; finalIssues?: unknown[]; finalAdvice?: { policy?: string };
      } | undefined;
      const newPressure = after.pressure.filter((row) => !before.pressure.some((old) => old.id === row.id));
      const memories = db.prepare("SELECT content FROM memories WHERE agent_id = ?").all(agentId) as Array<{ content: string }>;
      const rejected = db.prepare("SELECT reason_code, raw_json FROM rejected_proposals WHERE correlation_id = ?").all(testCase.id) as Array<{ reason_code: string; raw_json: string }>;
      const beforeReplayCalls = calls.length;
      activePhase = "replay";
      const replay = await post<ChatTurnResult>(url, payload, 200);
      const replayUsage = usage();
      const checks = {
        oneSharedRepairOrExpectedZero: repairCalls.length === testCase.repairs && guard?.repairCalls === testCase.repairs,
        repairReturnedSuccessfully: repairCalls.every((call) => call.success === true),
        finalGuardClean: guard?.finalIssues?.length === 0,
        explicitNoneNowPolicy: !testCase.repairs || guard?.finalAdvice?.policy === "none_now",
        finalTextChunksAgree: final.decision.chunks.join("\n") === final.assistantMessage.content,
        visibleRepairOrPreservedStub: testCase.repairs ? final.assistantMessage.content !== testCase.reply : final.assistantMessage.content === testCase.reply,
        badMemoryNotStored: memories.every((row) => !row.content.includes(BAD_MEMORY)),
        badMemoryAudited: !testCase.repairs || rejected.some((row) => row.reason_code === "unsupported_interaction_memory" && row.raw_json.includes(BAD_MEMORY)),
        characterPressureBoundary: testCase.characterPressure
          ? newPressure.length === 1 && newPressure[0]?.subject === "character"
            && (JSON.parse(newPressure[0].episode_json) as { sourceMessageIds: string[] }).sourceMessageIds.includes(final.assistantMessage.id)
          : newPressure.length === 0,
        replayIdempotent: replay.idempotentReplay && replay.assistantMessage.id === final.assistantMessage.id,
        replayNoLogicalOrPhysicalCall: calls.length === beforeReplayCalls && continuityHash(replayUsage) === continuityHash(afterUsage),
        replayNoStorageEffects: continuityHash(snapshot()) === continuityHash(after),
        paidScope: options.fixture ? afterUsage.physicalRequests === 0
          : afterUsage.physicalRequests - beforeUsage.physicalRequests === testCase.repairs,
      };
      const report = { id: testCase.id, track: testCase.track,
        execution: repairCalls.length === 0 ? "stub-zero-paid-no-real-repair" : options.fixture ? "fixture-repair-zero-paid" : "fixed-bad-output-with-real-qwen-repair",
        paidPhysicalRequests: afterUsage.physicalRequests - beforeUsage.physicalRequests,
        calls: caseCalls, checks, passed: Object.values(checks).every(Boolean) };
      reports.push(report);
      await json(`${testCase.id}.final.json`, { report, final, replay });
      await json(`${testCase.id}.effects.json`, { before, after, afterReplay: snapshot() });
      console.log(JSON.stringify({ caseId: testCase.id, ...report }));
      assert.ok(report.passed, `Holdout failed: ${testCase.id}; inspect its final/effects artifacts`);
    }
    status = "completed";
  } catch (error) {
    await json("failure.json", { caseId: activeCase, error: String(error), usage: usage() });
    throw error;
  } finally {
    await app.close();
    await json("summary.json", { schema: "qwen-repair-holdout-v1", status,
      fixture: options.fixture, budget: BUDGET, usage: usage(), reports,
      scope: "Track C fixed chat injections; only repairs may use Qwen. State cases with no repair are zero-paid stubs. Excluded from natural-dialogue 9/3 scoring." });
  }
  return { directory, status, usage: usage() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const fixture = args.includes("--fixture");
  const outIndex = args.indexOf("--out");
  const runDirectory = outIndex >= 0 ? args[outIndex + 1] : undefined;
  const permitted = args.filter((_, index) => index !== outIndex && index !== outIndex + 1);
  if (!runDirectory || permitted.some((arg) => arg !== "--fixture"))
    throw new Error("Usage: qwen-repair-holdout.ts [--fixture] --out <NEW ignored runDirectory>");
  console.log(JSON.stringify(await runQwenRepairHoldout({ runDirectory, fixture })));
}
