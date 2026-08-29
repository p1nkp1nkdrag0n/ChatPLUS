import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  COMPANION_LONG_RUN_V2_PROFILE_ORDER,
  companionLongRunV2ReviewersFor,
  type CompanionLongRunV2Profile,
  type CompanionLongRunV2RubricScores,
} from "./companion-long-run-v2-evaluation.js";
import {
  createCurrentProfileCompanionLongRunV2JudgeTransport,
  executeCompanionLongRunV2JudgePlan,
  parseCompanionLongRunV2JudgeArgs,
  planCompanionLongRunV2Judge,
  readCompanionLongRunV2JudgeCandidates,
  writeCompanionLongRunV2JudgeArtifactsExclusive,
  type CompanionLongRunV2JudgeCandidate,
  type CompanionLongRunV2ProfileJudgeExecutor,
} from "./companion-long-run-v2-judge.js";

const PASS_SCORES: CompanionLongRunV2RubricScores = {
  persona: 3,
  daily_relevance: 3,
  emotion: 3,
  memory_time: 3,
  relationship_romance: 3,
  independent_life_schedule: 3,
  language_naturalness: 3,
};

function candidate(
  profile: CompanionLongRunV2Profile,
  repetition: 1 | 2 | 3,
  number: number,
  response = `candidate response ${String(number)}`,
): CompanionLongRunV2JudgeCandidate {
  return {
    itemId: `${profile}:run-${String(repetition)}:turn-${String(number)}`,
    profile,
    scenarioId: "matrix-a",
    runId: `${profile}-run-${String(repetition)}`,
    repetition,
    candidateNumber: number,
    evidence: {
      scenarioBlock: "continuity",
      rubricTags: ["persona_identity", "memory_temporal_accuracy"],
      fakeTimeBeforeUtc: "2026-08-16T10:00:00.000Z",
      fakeTimeAfterUtc: "2026-08-16T10:05:00.000Z",
      userMessage: "你还记得昨天说过什么吗？",
      candidateResponse: response,
      assertionSummary: ["http_success:PASS:ok"],
    },
  };
}

function allMatrixCandidates(): CompanionLongRunV2JudgeCandidate[] {
  return COMPANION_LONG_RUN_V2_PROFILE_ORDER.flatMap((profile, profileIndex) =>
    ([1, 2, 3] as const).map((repetition) =>
      candidate(profile, repetition, profileIndex * 3 + repetition),
    ),
  );
}

function passingExecutor(
  rationale = "Grounded and consistent.",
): CompanionLongRunV2ProfileJudgeExecutor {
  return (_profile, requests) =>
    Promise.resolve(
      requests.map((request) => ({
        reviews: [...request.candidates].reverse().map(({ blindId }) => ({
          blindId,
          scores: PASS_SCORES,
          conclusion: "PASS" as const,
          rationale,
        })),
      })),
    );
}

describe("companion long-run v2 paid judge", () => {
  it("plans the approved offsets, two external reviewers and batches of at most ten", () => {
    const candidates = allMatrixCandidates();
    const plan = planCompanionLongRunV2Judge(candidates, "fixed-seed");
    const mappedByBlindId = new Map(
      plan.mappingKey.candidates.map((entry) => [entry.blindId, entry]),
    );
    const assignmentsByBlindId = new Map<string, CompanionLongRunV2Profile[]>();
    for (const batch of plan.batches) {
      expect(batch.request.candidates.length).toBeLessThanOrEqual(10);
      expect(batch.request.candidates.length).toBeGreaterThan(0);
      for (const blind of batch.request.candidates) {
        const mapped = mappedByBlindId.get(blind.blindId);
        expect(mapped).toBeDefined();
        expect(batch.reviewerProfile).not.toBe(mapped!.profile);
        const assigned = assignmentsByBlindId.get(blind.blindId) ?? [];
        assigned.push(batch.reviewerProfile);
        assignmentsByBlindId.set(blind.blindId, assigned);
      }
    }
    for (const mapped of plan.mappingKey.candidates) {
      const actual = assignmentsByBlindId.get(mapped.blindId) ?? [];
      expect(actual).toHaveLength(2);
      expect(new Set(actual).size).toBe(2);
      expect(new Set(actual)).toEqual(
        new Set(
          companionLongRunV2ReviewersFor(mapped.profile, mapped.repetition),
        ),
      );
    }
  });

  it("executes injected transports and keeps model identity in the private mapping only", async () => {
    const plan = planCompanionLongRunV2Judge(
      allMatrixCandidates(),
      "anonymous-seed",
    );
    const calledProfiles: CompanionLongRunV2Profile[] = [];
    const artifact = await executeCompanionLongRunV2JudgePlan({
      plan,
      createdAtUtc: "2026-08-29T00:00:00.000Z",
      executeProfile: (profile, requests) => {
        calledProfiles.push(profile);
        return passingExecutor()(profile, requests);
      },
    });
    expect(calledProfiles).toEqual(COMPANION_LONG_RUN_V2_PROFILE_ORDER);
    expect(artifact.reviews).toHaveLength(
      plan.mappingKey.candidates.length * 2,
    );
    const publicJson = JSON.stringify(artifact);
    for (const profile of COMPANION_LONG_RUN_V2_PROFILE_ORDER) {
      expect(publicJson).not.toContain(`"${profile}"`);
    }
    expect(plan.mappingKey.candidates[0]?.profile).toBeDefined();
    expect(plan.mappingKey.reviewers).toHaveLength(5);
  });

  it("rejects missing or duplicated candidate results from a judge", async () => {
    const plan = planCompanionLongRunV2Judge(
      [candidate("deepseek", 1, 1)],
      "bad-response",
    );
    await expect(
      executeCompanionLongRunV2JudgePlan({
        plan,
        executeProfile: (_profile, requests) =>
          Promise.resolve(
            requests.map(() => ({
              reviews: [
                {
                  blindId: "wrong-id",
                  scores: PASS_SCORES,
                  conclusion: "PASS" as const,
                  rationale: "wrong mapping",
                },
              ],
            })),
          ),
      }),
    ).rejects.toThrow(/blindId set/u);
  });

  it("renders escaped anonymous HTML", () => {
    const plan = planCompanionLongRunV2Judge(
      [candidate("deepseek", 1, 1, "<script>alert('x')</script>")],
      "html-seed",
    );
    expect(plan.html).toContain("Anonymous companion long-run review");
    expect(plan.html).toContain("&lt;script&gt;");
    expect(plan.html).not.toContain("<script>alert");
    expect(plan.html).not.toContain("deepseek");
  });

  it("reads matrix JSONL evidence and retains bounded prompt/state context", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "chatplus-v2-evidence-test-"),
    );
    try {
      const snapshot = {
        capturedAtUtc: "2026-08-16T10:00:00.000Z",
        runtimeState: { mood: "calm" },
        cursor: {},
        schedule: [],
        scheduleNegotiations: [],
        settlements: [],
        activityEvents: [],
        memories: [{ text: "昨天约好去图书馆" }],
        memoryEvidence: [],
        proactiveCandidates: [],
        messages: [],
        domainEvents: [],
        rejectedProposals: [],
        retrievalRuns: [],
        llmCalls: [],
        tableCounts: {},
        durableSha256: "state-sha",
      };
      const turn = {
        schemaVersion: "companion-long-run-turn-evidence-v2",
        matrixId: "matrix-a",
        runId: "deepseek-run-1",
        profile: "deepseek",
        repetition: 1,
        track: "paired",
        branch: "shared",
        turnId: "turn-1",
        logicalOrdinal: 1,
        candidateOrdinal: 1,
        scenarioBlock: "memory",
        rubricTags: ["memory_temporal_accuracy"],
        fakeTimeBeforeUtc: "2026-08-16T10:00:00.000Z",
        fakeTimeAfterUtc: "2026-08-16T10:05:00.000Z",
        sessionId: "session",
        clientMessageId: "client-message",
        userMessage: "昨天说了什么？",
        actions: [],
        http: { method: "POST", path: "/messages", status: 200, latencyMs: 1 },
        logicalCalls: [
          {
            index: 1,
            purpose: "chat_turn",
            system: "你是顾澜。",
            prompt: "使用已有记忆回答。",
          },
        ],
        providerAttempts: [],
        persistedAssistant: { content: "约好今天去图书馆。" },
        before: snapshot,
        after: snapshot,
        assertions: [{ code: "http_success", status: "PASS", summary: "ok" }],
        status: "PASS",
        repairAttempted: false,
        idempotentReplay: false,
      };
      const path = join(directory, "turn-evidence.jsonl");
      await writeFile(path, `${JSON.stringify(turn)}\n`, "utf8");
      const [loaded] = await readCompanionLongRunV2JudgeCandidates(directory);
      expect(loaded?.evidence.candidateResponse).toBe("约好今天去图书馆。");
      expect(loaded?.evidence.promptContext).toContain("你是顾澜");
      expect(loaded?.evidence.stateContext).toContain("昨天约好去图书馆");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writes redacted artifacts exclusively and refuses overwrite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatplus-v2-judge-test-"));
    try {
      const plan = planCompanionLongRunV2Judge(
        [candidate("deepseek", 1, 1)],
        "write-seed",
      );
      const artifact = await executeCompanionLongRunV2JudgePlan({
        plan,
        executeProfile: passingExecutor("do-not-leak-secret"),
      });
      const paths = await writeCompanionLongRunV2JudgeArtifactsExclusive({
        outputDirectory: directory,
        plan,
        artifact,
        environment: {
          RUN_PAID_LONGRUN: "1",
          TEST_API_KEY: "do-not-leak-secret",
        },
      });
      expect(await readFile(paths.resultsPath, "utf8")).toContain("[REDACTED]");
      expect(await readFile(paths.mappingKeyPath, "utf8")).toContain(
        '"profile": "deepseek"',
      );
      await expect(
        writeCompanionLongRunV2JudgeArtifactsExclusive({
          outputDirectory: directory,
          plan,
          artifact,
        }),
      ).rejects.toMatchObject({ code: "EEXIST" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("parses orchestrator/worker CLI modes and guards real transport", () => {
    expect(
      parseCompanionLongRunV2JudgeArgs([
        "--evidence=matrix",
        "--output-dir",
        "out",
        "--seed",
        "s",
      ]),
    ).toEqual({
      mode: "orchestrator",
      evidencePath: "matrix",
      outputDirectory: "out",
      seed: "s",
    });
    expect(
      parseCompanionLongRunV2JudgeArgs(["--worker", "--reviewer-profile=grok"]),
    ).toMatchObject({ mode: "worker", reviewerProfile: "grok" });
    expect(() =>
      createCurrentProfileCompanionLongRunV2JudgeTransport("deepseek", {}),
    ).toThrow(/RUN_PAID_LONGRUN=1/u);
  });
});
