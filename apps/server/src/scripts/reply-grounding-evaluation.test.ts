import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assembleChatPrompt,
  REPLY_TASK_GROUNDING_POLICY,
} from "@personasim/features";
import * as configuration from "../config.js";
import * as steering from "./reply-steering-runner.js";
import * as architectureRuntime from "./architecture-evaluation-runtime.js";
import { CONTINUITY_WORKSPACE_ROOT } from "./continuity-run-identity.js";
import { RUNTIME_STATE_AUDIT_CASES } from "./runtime-state-audit-cases.js";
import { REPLY_GROUNDING_EVALUATION_CASES } from "./reply-grounding-evaluation-cases.js";
import {
  buildReplyGroundingEvaluationCells,
  removeReplyTaskGroundingPolicy,
  replyGroundingEvaluationInput,
  replyGroundingWireProof,
} from "./reply-grounding-evaluation-prompts.js";
import {
  REPLY_GROUNDING_EVALUATION_BUDGET,
  runReplyGroundingEvaluation,
} from "./reply-grounding-evaluation.js";

const testRoot = resolve(
  CONTINUITY_WORKSPACE_ROOT,
  "tmp",
  `reply-grounding-evaluation-test-${randomUUID()}`,
);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const inside = relative(resolve(CONTINUITY_WORKSPACE_ROOT, "tmp"), testRoot);
  if (!inside || inside.startsWith("..") || isAbsolute(inside))
    throw new Error("Unsafe fixture cleanup directory");
  rmSync(testRoot, { recursive: true, force: true });
});
function offlineGuard() {
  const config = vi
    .spyOn(configuration, "readConfig")
    .mockImplementation(() => {
      throw new Error("Offline must not resolve deployment configuration");
    });
  const profile = vi
    .spyOn(steering, "resolveSteeringProfile")
    .mockImplementation(() => {
      throw new Error("Offline must not resolve private model profiles");
    });
  const network = vi.fn(() =>
    Promise.reject(new Error("Network forbidden in fixture")),
  );
  vi.stubGlobal("fetch", network);
  vi.stubEnv("RUN_PAID_ARCHITECTURE_EVAL", "");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  return () => {
    expect(config).not.toHaveBeenCalled();
    expect(profile).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  };
}
const read = (output: string, name: string) =>
  JSON.parse(readFileSync(join(output, name), "utf8")) as unknown;

describe("reply grounding policy matched comparison", () => {
  it("freezes four historical regressions and twelve new tasks across balanced personas", () => {
    expect(REPLY_GROUNDING_EVALUATION_CASES).toHaveLength(16);
    expect(
      new Set(REPLY_GROUNDING_EVALUATION_CASES.map((item) => item.id)).size,
    ).toBe(16);
    expect(
      REPLY_GROUNDING_EVALUATION_CASES.filter(
        (item) => item.origin === "new_transfer",
      ),
    ).toHaveLength(12);
    for (const persona of ["social-outward", "social-private"])
      expect(
        REPLY_GROUNDING_EVALUATION_CASES.filter(
          (item) => item.personaId === persona,
        ),
      ).toHaveLength(8);
    for (const [index, oldId] of ["S08", "S08", "S04", "S04"].entries()) {
      const old = RUNTIME_STATE_AUDIT_CASES.find((item) => item.id === oldId)!;
      expect(REPLY_GROUNDING_EVALUATION_CASES[index]!.history).toEqual(
        old.history,
      );
      expect(REPLY_GROUNDING_EVALUATION_CASES[index]!.userText).toEqual(
        old.userText,
      );
    }
  });

  it("changes only the admitted new policy and preserves actual production strategy and data", () => {
    const { captures, cells } = buildReplyGroundingEvaluationCells();
    expect(cells).toHaveLength(32);
    for (const capture of captures) {
      const probe = REPLY_GROUNDING_EVALUATION_CASES.find(
        (item) => item.id === capture.caseId,
      )!;
      const original = assembleChatPrompt(replyGroundingEvaluationInput(probe));
      const current = cells.find(
        (cell) => cell.caseId === probe.id && cell.arm === "with_new_policy",
      )!;
      const control = cells.find(
        (cell) => cell.caseId === probe.id && cell.arm === "without_new_policy",
      )!;
      expect(current.system).toBe(original.system);
      expect(current.prompt).toBe(original.prompt);
      expect(control.system).toBe(
        current.system.replace(REPLY_TASK_GROUNDING_POLICY, ""),
      );
      expect(control.prompt).toBe(current.prompt);
      expect(capture.assembled.replyStrategy).toEqual(original.replyStrategy);
      expect(control.system).not.toContain("REPLY_TASK_GROUNDING_POLICY");
      expect(current.system).toContain(REPLY_TASK_GROUNDING_POLICY);
      for (const criterion of probe.criteria)
        expect(current.system + current.prompt).not.toContain(criterion);
      expect(current.system + current.prompt).not.toContain(probe.title);
      expect(current.proof).toEqual(control.proof);
    }
  });

  it("rejects missing, partial and duplicated policy interventions", () => {
    expect(() => removeReplyTaskGroundingPolicy("No policy")).toThrow(
      "exactly one",
    );
    expect(() =>
      removeReplyTaskGroundingPolicy(REPLY_TASK_GROUNDING_POLICY.slice(0, -10)),
    ).toThrow("exactly one");
    expect(() =>
      removeReplyTaskGroundingPolicy(
        `${REPLY_TASK_GROUNDING_POLICY}\n${REPLY_TASK_GROUNDING_POLICY}`,
      ),
    ).toThrow("exactly one");
  });

  it("compares all wire parameters and provider headers outside the policy", () => {
    const without = {
      model: "fixture",
      max_tokens: 4096,
      messages: [
        { role: "system", content: "JSON schema header\n" },
        { role: "user", content: "same request" },
      ],
    };
    const withPolicy = {
      ...without,
      messages: [
        {
          role: "system",
          content: `JSON schema header\n${REPLY_TASK_GROUNDING_POLICY}`,
        },
        without.messages[1]!,
      ],
    };
    const control = replyGroundingWireProof(without, "without_new_policy");
    const current = replyGroundingWireProof(withPolicy, "with_new_policy");
    expect(current.nonPolicyRequestSha256).toBe(control.nonPolicyRequestSha256);
    expect(current.requestSha256).not.toBe(control.requestSha256);
    expect(
      replyGroundingWireProof(
        { ...without, max_tokens: 2048 },
        "without_new_policy",
      ).nonPolicyRequestSha256,
    ).not.toBe(control.nonPolicyRequestSha256);
    expect(() => replyGroundingWireProof(without, "with_new_policy")).toThrow(
      "Wire policy count",
    );
  });
});

describe("reply grounding bounded evidence runner", () => {
  it("records 32 actual fixture requests, caps parallel calls at two and saves review context", async () => {
    const assertOffline = offlineGuard();
    const output = join(testRoot, "complete");
    const originalFixture = architectureRuntime.architectureFixtureFetch;
    let active = 0;
    let maximumActive = 0;
    vi.spyOn(
      architectureRuntime,
      "architectureFixtureFetch",
    ).mockImplementation(async (...args) => {
      maximumActive = Math.max(maximumActive, ++active);
      try {
        await new Promise((done) => setTimeout(done, 1));
        return await originalFixture(...args);
      } finally {
        active--;
      }
    });
    expect(
      await runReplyGroundingEvaluation({ output, fixture: true }),
    ).toMatchObject({
      completed: 32,
      errors: 0,
      physicalRequests: 32,
      usageComplete: true,
    });
    expect(maximumActive).toBe(2);
    const requests = readFileSync(join(output, "attempts.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            stage: string;
            request?: { max_tokens: number; messages: unknown[] };
          },
      )
      .filter((row) => row.stage === "reserved");
    expect(requests).toHaveLength(32);
    for (const row of requests) {
      expect(row.request?.max_tokens).toBe(4096);
      expect(row.request?.messages).toHaveLength(4);
      expect(JSON.stringify(row.request)).not.toContain(
        "STRUCTURED_OUTPUT_REPAIR",
      );
    }
    const anonymous = JSON.stringify(read(output, "anonymous-candidates.json"));
    expect(anonymous).not.toContain("with_new_policy");
    expect(anonymous).not.toContain("without_new_policy");
    const context = read(output, "shared-review-context.json") as {
      cases: Array<Record<string, unknown>>;
    };
    expect(context.cases).toHaveLength(16);
    expect(context.cases[0]).toHaveProperty("inputCharacter");
    expect(context.cases[0]).toHaveProperty("admittedPersona");
    expect(context.cases[0]).toHaveProperty("history");
    expect(context.cases[0]).toHaveProperty("userText");
    expect(JSON.stringify(read(output, "manifest.json"))).not.toContain(
      "offline-fixture-key",
    );
    expect(read(output, "manifest.json")).toHaveProperty("sourceHashes");
    const wirePairs = Object.values(
      read(output, "wire-pair-proof.json") as Record<
        string,
        { requests: unknown[] }
      >,
    );
    expect(wirePairs).toHaveLength(16);
    for (const pair of wirePairs) expect(pair.requests).toHaveLength(2);
    expect(REPLY_GROUNDING_EVALUATION_BUDGET.maxPhysicalRequests).toBe(32);
    await expect(
      runReplyGroundingEvaluation({ output, fixture: true }),
    ).rejects.toThrow("Never overwrite");
    assertOffline();
  }, 30_000);

  it.each(["rate_limit", "malformed"] as const)(
    "records %s failures without any retry or replacement",
    async (kind) => {
      const assertOffline = offlineGuard();
      vi.spyOn(
        architectureRuntime,
        "architectureFixtureFetch",
      ).mockImplementation(() =>
        Promise.resolve(
          kind === "rate_limit"
            ? Response.json(
                { error: { message: "fixture rate limit" } },
                { status: 429 },
              )
            : Response.json({
                choices: [
                  {
                    message: { role: "assistant", content: "not-json" },
                    finish_reason: "stop",
                  },
                ],
              }),
        ),
      );
      expect(
        await runReplyGroundingEvaluation({
          output: join(testRoot, kind),
          fixture: true,
        }),
      ).toMatchObject({
        completed: 0,
        errors: 32,
        physicalRequests: 32,
        usageComplete: false,
      });
      assertOffline();
    },
    30_000,
  );

  it("preflights without network and denies unarmed paid runs before reading profiles or creating output", async () => {
    const assertOffline = offlineGuard();
    const denied = join(testRoot, "paid");
    await expect(
      runReplyGroundingEvaluation({ output: denied }),
    ).rejects.toThrow("RUN_PAID_ARCHITECTURE_EVAL");
    expect(existsSync(denied)).toBe(false);
    expect(
      await runReplyGroundingEvaluation({
        output: join(testRoot, "preflight"),
        preflightOnly: true,
      }),
    ).toEqual({ preflightOnly: true, candidates: 32, physicalRequests: 0 });
    assertOffline();
  });
});
