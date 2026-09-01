import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { ServerConfig } from "../config.js";
import { getLongRunV3Turn } from "../scenarios/companion-long-run-v3-manifest.js";
import {
  assertPaidLongRunV3ProfileReady,
  assertLongRunV3EngineeringGatePassed,
  parseCompanionLongRunV3CliArgs,
  suggestedRunId,
} from "./companion-long-run-v3.js";
import {
  assertionBackedHardGateOutcome,
  assertLongRunV3DeepSeekProfileExpectation,
  artifactBranchForScope,
  buildLongRunV3ServerConfig,
  evaluateLongRunV3FrontendMigrationSources,
  expectedArtifactTurns,
  hardGateFailureMatches,
  longRunV3PromptShapeValid,
  resolveLongRunV3UserTextForDecision,
  runCompanionLongRunV3,
} from "./companion-long-run-v3-runner.js";
import {
  inspectLongRunV3ArtifactCoverage,
  readLatestLongRunV3Checkpoint,
  readLongRunV3Evidence,
  renderLongRunV3Conversation,
  resolveLongRunV3ArtifactPaths,
  type LongRunV3RunManifest,
} from "./companion-long-run-v3-artifacts.js";
const execFileAsync = promisify(execFile);
const cleanup: string[] = [];
const FAKE_API_KEY = "test-only-deepseek-key-never-send";

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) =>
      rm(path, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("companion long-run v3 CLI", () => {
  it("parses fixture, paid run, and explicit resume without consulting provider state", () => {
    const now = new Date("2026-09-01T01:02:03.004Z");

    expect(parseCompanionLongRunV3CliArgs(["fixture"], now)).toEqual({
      command: "fixture",
      profile: "fixture",
      runId: "fixture-20260901-010203-004Z",
      resume: false,
    });
    expect(
      parseCompanionLongRunV3CliArgs([
        "run",
        "--run-id=deepseek-reviewed-r1",
        "--profile",
        "deepseek",
        "--runs=1",
      ]),
    ).toEqual({
      command: "run",
      profile: "deepseek",
      runId: "deepseek-reviewed-r1",
      resume: false,
    });
    expect(
      parseCompanionLongRunV3CliArgs([
        "resume",
        "--run-id",
        "deepseek-reviewed-r1",
      ]),
    ).toEqual({
      command: "resume",
      profile: "deepseek",
      runId: "deepseek-reviewed-r1",
      resume: true,
    });
    expect(
      parseCompanionLongRunV3CliArgs([
        "run",
        "--run-id",
        "bigmodel-reviewed-r1",
        "--profile=bigmodel",
      ]),
    ).toEqual({
      command: "run",
      profile: "bigmodel",
      runId: "bigmodel-reviewed-r1",
      resume: false,
    });
    expect(suggestedRunId("deepseek", now)).toBe(
      "deepseek-20260901-010203-004Z",
    );
    expect(suggestedRunId("bigmodel", now)).toBe(
      "bigmodel-20260901-010203-004Z",
    );
  });

  it.each([
    { argv: [] as string[], message: /Usage:/u },
    { argv: ["pilot"], message: /Usage:/u },
    { argv: ["resume"], message: /requires --run-id/u },
    {
      argv: ["run", "--profile", "claude"],
      message: /deepseek or bigmodel/u,
    },
    {
      argv: ["run", "--runs", "3"],
      message: /--runs must be 1/u,
    },
    {
      argv: ["run", "--run-id", "../outside"],
      message: /Run ID must start/u,
    },
    {
      argv: ["fixture", "--unknown"],
      message: /Unknown argument/u,
    },
    {
      argv: ["run", "--run-id", "one", "--run-id=two"],
      message: /only once/u,
    },
  ])(
    "rejects an invalid or unsafe argument set: $argv",
    ({ argv, message }) => {
      expect(() => parseCompanionLongRunV3CliArgs(argv)).toThrow(message);
    },
  );

  it("turns an engineering hard-gate failure into a thrown CLI failure", () => {
    expect(() =>
      assertLongRunV3EngineeringGatePassed({
        engineeringGatePassed: false,
        runDirectory: "tmp/companion-long-run-v3/failed-run",
      }),
    ).toThrow(/engineering gate failed/u);
    expect(() =>
      assertLongRunV3EngineeringGatePassed({
        engineeringGatePassed: true,
        runDirectory: "tmp/companion-long-run-v3/passed-run",
      }),
    ).not.toThrow();
  });
});

describe("companion long-run v3 paid guard", () => {
  it("rejects before profile or Git inspection unless the exact paid switch is present", async () => {
    const deliberatelyInvalidEnvironment = {
      RUN_PAID_LONGRUN: "true",
      OPENAI_COMPATIBLE_BASE_URL: "not-a-url",
      OPENAI_COMPATIBLE_API_KEY: FAKE_API_KEY,
    };

    await expect(
      assertPaidLongRunV3ProfileReady(
        join(tmpdir(), "this-git-directory-must-not-be-read"),
        "deepseek",
        deliberatelyInvalidEnvironment,
      ),
    ).rejects.toThrow(/RUN_PAID_LONGRUN=1/u);
  });

  it.each([
    {
      profile: "deepseek" as const,
      environment: fakeDeepSeekEnvironment(),
      keyEnvironment: "OPENAI_COMPATIBLE_API_KEY",
    },
    {
      profile: "bigmodel" as const,
      environment: fakeBigModelEnvironment(),
      keyEnvironment: "LLM_PROFILE_BIGMODEL_API_KEY",
    },
  ])(
    "reports a missing $profile key without opening the Git dependency",
    async ({ profile, environment, keyEnvironment }) => {
      delete environment[keyEnvironment];

      await expect(
        assertPaidLongRunV3ProfileReady(
          join(tmpdir(), "this-git-directory-also-must-not-be-read"),
          profile,
          environment,
        ),
      ).rejects.toThrow(keyEnvironment);
    },
  );

  it.each([
    {
      profile: "deepseek" as const,
      environment: fakeDeepSeekEnvironment(),
      secret: FAKE_API_KEY,
    },
    {
      profile: "bigmodel" as const,
      environment: fakeBigModelEnvironment(),
      secret: "test-only-bigmodel-key-never-send",
    },
  ])(
    "accepts a clean injected Git root for $profile and rejects a dirty one without exposing the key",
    async ({ profile, environment, secret }) => {
      const repository = await createCleanGitRepository();

      await expect(
        assertPaidLongRunV3ProfileReady(repository, profile, environment),
      ).resolves.toBeUndefined();

      await writeFile(join(repository, "uncommitted.txt"), "dirty\n", "utf8");
      let message = "";
      try {
        await assertPaidLongRunV3ProfileReady(repository, profile, environment);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/clean Git worktree/u);
      expect(message).not.toContain(secret);

      environment.RUN_PAID_LONGRUN_ALLOW_DIRTY = "1";
      await expect(
        assertPaidLongRunV3ProfileReady(repository, profile, environment),
      ).resolves.toBeUndefined();
    },
  );
});

describe("companion long-run v3 runner pure helpers", () => {
  it("forces the reviewed fuzzy-life profile and strips fixture credentials", () => {
    const config = buildLongRunV3ServerConfig(
      baseServerConfig("placeholder.sqlite"),
      "isolated.sqlite",
      true,
    );

    expect(config).toMatchObject({
      nodeEnv: "test",
      profile: "companion-long-run-v3",
      databasePath: "isolated.sqlite",
      clockMode: "fake",
      fakeClockStart: "2026-09-01T01:00:00.000Z",
      developerRoutes: true,
      seedDemo: false,
      chatEffectsMode: "gated",
      lifePlanningMode: "fuzzy",
      scheduleNegotiationMode: "legacy",
      selfInitiatedPlanningMode: "off",
      liveWorldEffectsMode: "enforced",
      memoryRecallMode: "enforced",
      autobiographyMode: "off",
      llm: {
        provider: "fixture",
        baseUrl: "http://fixture.invalid",
        model: "personasim-fixture-v1",
        timeoutMs: 5_000,
        maxRetries: 0,
      },
    });
    expect(config.llm.apiKey).toBeUndefined();
  });

  it("preserves the injected live provider while overriding only run invariants", () => {
    const base = baseServerConfig("placeholder.sqlite");
    const config = buildLongRunV3ServerConfig(
      base,
      "deepseek-run.sqlite",
      false,
    );

    expect(config.llm).toEqual(base.llm);
    expect(config.databasePath).toBe("deepseek-run.sqlite");
    expect(config.lifePlanningMode).toBe("fuzzy");
    expect(config.scheduleNegotiationMode).toBe("legacy");
  });

  it("requires every paid DeepSeek runtime field to equal the reviewed profile", () => {
    const config = baseServerConfig("deepseek-run.sqlite");
    const profileConfig = reviewedDeepSeekProfileConfig(config);
    expect(() =>
      assertLongRunV3DeepSeekProfileExpectation(config, profileConfig),
    ).not.toThrow();

    const mutations: Array<{
      field: string;
      mutate: (
        actual: ServerConfig,
        recorded: Parameters<
          typeof assertLongRunV3DeepSeekProfileExpectation
        >[1],
      ) => void;
    }> = [
      {
        field: "provider",
        mutate: (actual) => {
          (actual.llm as { provider: string }).provider = "fixture";
        },
      },
      {
        field: "baseUrl",
        mutate: (actual, recorded) => {
          actual.llm.baseUrl = "https://api.deepseek.com/unreviewed-proxy-path";
          recorded.baseUrl = actual.llm.baseUrl;
        },
      },
      {
        field: "requestModel",
        mutate: (actual, recorded) => {
          actual.llm.model = "deepseek-unreviewed";
          recorded.requestedModel = actual.llm.model;
        },
      },
      {
        field: "reasoningEffort",
        mutate: (actual, recorded) => {
          actual.llm.capabilities!.reasoningEffort = "high";
          recorded.reasoningEffort = "high";
        },
      },
      {
        field: "reasoningRequestFormat",
        mutate: (actual, recorded) => {
          actual.llm.capabilities!.reasoningRequestFormat =
            "openai_reasoning_effort";
          recorded.reasoningRequestFormat = "openai_reasoning_effort";
        },
      },
      {
        field: "attemptTimeoutMs",
        mutate: (actual, recorded) => {
          actual.llm.timeoutMs = 299_999;
          recorded.timeoutMs = actual.llm.timeoutMs;
        },
      },
      {
        field: "maxTransportRetries",
        mutate: (actual, recorded) => {
          actual.llm.maxRetries = 1;
          recorded.maxRetries = actual.llm.maxRetries;
        },
      },
      {
        field: "providerMaxOutputTokens",
        mutate: (actual, recorded) => {
          actual.llm.maxOutputTokens = 16_384;
          actual.llm.capabilities!.maxOutputTokens = 16_384;
          recorded.maxOutputTokens = 16_384;
        },
      },
      {
        field: "maxContextTokens",
        mutate: (actual, recorded) => {
          actual.llm.capabilities!.maxContextTokens = 65_536;
          recorded.maxContextTokens = 65_536;
        },
      },
      {
        field: "repairMaxOutputTokens",
        mutate: (_actual, recorded) => {
          recorded.repairMaxOutputTokens = 8_192;
        },
      },
    ];
    for (const mutation of mutations) {
      const actual = structuredClone(config);
      const recorded = structuredClone(profileConfig);
      mutation.mutate(actual, recorded);
      expect(
        () => assertLongRunV3DeepSeekProfileExpectation(actual, recorded),
        mutation.field,
      ).toThrow(new RegExp(mutation.field, "u"));
    }
  });

  it("maps shared and fork scopes to their immutable artifact branches", () => {
    expect(artifactBranchForScope("shared")).toBe("shared");
    expect(artifactBranchForScope("branch_a")).toBe("stable");
    expect(artifactBranchForScope("branch_b")).toBe("independent");
  });

  it("resolves persisted-decision inputs for A, B, fallback, and plain turns", () => {
    const conditional = getLongRunV3Turn(55);
    expect(resolveLongRunV3UserTextForDecision(conditional, "A")).toContain(
      "正式拒绝山鸣影像",
    );
    expect(resolveLongRunV3UserTextForDecision(conditional, "B")).toContain(
      "接受 offer",
    );
    expect(
      resolveLongRunV3UserTextForDecision(conditional, undefined),
    ).toContain("自己选择 B");

    const plain = getLongRunV3Turn(1);
    expect(resolveLongRunV3UserTextForDecision(plain, "B")).toBe(
      plain.userText,
    );
  });

  it("routes exact assertion codes to their owning hard gates", () => {
    expect(
      hardGateFailureMatches("H07", "shared-055:causal_stage_separation"),
    ).toBe(true);
    expect(
      hardGateFailureMatches("H03", "shared-055:causal_stage_separation"),
    ).toBe(false);
    expect(
      hardGateFailureMatches(
        "H12",
        "shared-035:pressure_change_requires_explicit_evidence",
      ),
    ).toBe(true);
    expect(
      hardGateFailureMatches("H13", "shared-013:memory_write_grounded"),
    ).toBe(true);
    expect(
      hardGateFailureMatches(
        "H13",
        "shared-018:memory_abstains_without_evidence",
      ),
    ).toBe(true);
    expect(
      hardGateFailureMatches("H07", "shared-061:causal_recap_grounded"),
    ).toBe(true);
    expect(
      hardGateFailureMatches("H07", "shared-105:causal_provenance_grounded"),
    ).toBe(true);
    expect(
      hardGateFailureMatches(
        "H07",
        "shared-107:relationship_continuity_grounded",
      ),
    ).toBe(false);
    expect(
      hardGateFailureMatches(
        "H13",
        "shared-107:relationship_continuity_grounded",
      ),
    ).toBe(true);
    expect(
      hardGateFailureMatches("H12", "shared-013:memory_write_grounded"),
    ).toBe(false);
    expect(
      hardGateFailureMatches("H17", "shared-001:prompt_includes_life_context"),
    ).toBe(true);
    expect(
      hardGateFailureMatches("H13", "shared-013:not_memory_write_grounded"),
    ).toBe(false);
  });

  it("fails the aggregate H17 gate for missing or truncated LIFE_CONTEXT_JSON", () => {
    for (const failure of [
      "shared-001:prompt_includes_life_context:life_context_segment_missing",
      "shared-002:prompt_includes_life_context:life_context_json_invalid_or_truncated",
    ]) {
      expect(assertionBackedHardGateOutcome("H17", [failure], true)).toEqual({
        passed: false,
        evidence: [failure],
      });
    }
  });

  it("rejects retired exact-schedule labels and keys from the aggregate H06 prompt shape", () => {
    expect(
      longRunV3PromptShapeValid([
        {
          system:
            'CURRENT_TIME_JSON\n{"localDate":"2026-09-01"}\nLIFE_CONTEXT_JSON\n{}',
          prompt: "ordinary turn",
        },
      ]),
    ).toBe(true);
    for (const retiredLabel of [
      "FUTURE_SCHEDULE_JSON",
      "CURRENT_ACTIVITY_JSON",
    ]) {
      expect(
        longRunV3PromptShapeValid([
          {
            system: `LIFE_CONTEXT_JSON\n{}\n${retiredLabel}\n{}`,
            prompt: "ordinary turn",
          },
        ]),
      ).toBe(false);
    }
    for (const retiredKey of [
      "currentActivity",
      "futureSchedule",
      "preferredStartLocal",
      "preferredDurationMinutes",
      "sleepWindow",
      "horizonHours",
      "maxCommittedHoursPerDay",
      "quietHours",
      "schedulePolicy",
      "proactivePolicy",
      "routines",
    ]) {
      expect(
        longRunV3PromptShapeValid([
          {
            system: `CORE_PERSONA_JSON\n{"${retiredKey}":{}}\nLIFE_CONTEXT_JSON\n{}`,
            prompt: "ordinary turn",
          },
        ]),
        retiredKey,
      ).toBe(false);
    }
  });

  it("fails H18 if the timeline reintroduces schedule sources or bypasses its presentation helper", () => {
    const valid = {
      appShellSource: 'const nav = [{ to: "/timeline", label: "变化" }];',
      chatSource: "function sendMessage() { return '发送 message'; }",
      timelineSource:
        'import { timelineEventTitle } from "../lib/timelinePresentation";\nconst title = timelineEventTitle(event);\nconst heading = "共同经历";',
      timelineLineageSource:
        'const fields = [{ field: "messageId", label: "Message" }];',
      timelinePresentationSource:
        "export function timelineEventTitle(event: TimelineEvent) { return event.title; }",
      scheduleRailExists: false,
    };
    expect(evaluateLongRunV3FrontendMigrationSources(valid).passed).toBe(true);

    expect(
      evaluateLongRunV3FrontendMigrationSources({
        ...valid,
        timelineSource: `${valid.timelineSource}\nvoid event.scheduleItemId;`,
      }).checks.timelinePageScheduleSourceAbsent,
    ).toBe(false);
    expect(
      evaluateLongRunV3FrontendMigrationSources({
        ...valid,
        timelineLineageSource:
          'const fields = [{ field: "scheduleItemId", label: "ScheduleItem" }];',
      }).checks.timelineLineageScheduleNodeAbsent,
    ).toBe(false);
    expect(
      evaluateLongRunV3FrontendMigrationSources({
        ...valid,
        timelineSource:
          'import { timelineEventTitle } from "../lib/timelinePresentation";\nconst title = event.title;\nconst heading = "共同经历";',
      }).checks.timelinePresentationUsed,
    ).toBe(false);
  });

  it("keeps every fail-closed validator wired into its runtime assertion branch", async () => {
    const source = await readFile(
      new URL("./companion-long-run-v3-runtime.ts", import.meta.url),
      "utf8",
    );
    const expectedCalls = [
      ["support_mode_matches_request", "validateCompanionLongRunV3SupportMode"],
      ["memory_write_grounded", "validateCompanionLongRunV3MemoryWrite"],
      [
        "memory_recall_evidence_bound",
        "validateCompanionLongRunV3MemoryRecall",
      ],
      [
        "memory_abstains_without_evidence",
        "validateCompanionLongRunV3MemoryAbstentionDurability",
      ],
      [
        "planned_not_occurred",
        "validateCompanionLongRunV3PlannedNotOccurredDurability",
      ],
      [
        "bidirectional_causality_grounded",
        "validateCompanionLongRunV3BidirectionalCausality",
      ],
      [
        "causal_recap_grounded",
        "validateCompanionLongRunV3CausalRecapProvenance",
      ],
      [
        "causal_provenance_grounded",
        "validateCompanionLongRunV3CausalRecapProvenance",
      ],
      [
        "relationship_continuity_grounded",
        "validateCompanionLongRunV3RelationshipContinuityGrounding",
      ],
    ] as const;
    for (const [assertion, validator] of expectedCalls) {
      expect(runtimeCaseSource(source, assertion)).toContain(`${validator}(`);
    }
    expect(
      runtimeCaseSource(source, "memory_abstains_without_evidence"),
    ).not.toContain("abstentionResponseValid(");
    expect(runtimeCaseSource(source, "planned_not_occurred")).not.toContain(
      "plannedOccurrenceResponseValid(",
    );
    expect(
      runtimeCaseSource(source, "memory_correction_supersedes"),
    ).not.toMatch(/ResponseValid\(/u);
    for (let candidate = 1; candidate <= 108; candidate += 1) {
      expect(getLongRunV3Turn(candidate).hardAssertions).not.toContain(
        "user_boundary_respected",
      );
    }
    expect(
      runtimeCaseSource(source, "pressure_change_requires_explicit_evidence"),
    ).toContain('coreResult("pressure_change_evidence_bound", code)');
    expect(source).toContain("case 26:");
    expect(source).toContain("currentPressure: 0.8");
    expect(source).toContain("currentClarity: 0.2");
    expect(source).toContain("requirePreexistingEpisode: true");
  });
});

describe("companion long-run v3 checkpoint resume", () => {
  it("defers response grading while preserving abstention and plan durability evidence", async () => {
    const root = process.cwd();
    const runId = `fixture-plan-evidence-${randomUUID()}`;
    const runDirectory = join(root, "tmp", "companion-long-run-v3", runId);
    cleanup.push(runDirectory);

    await runCompanionLongRunV3({
      workspaceRoot: root,
      profile: "fixture",
      runId,
      stopAfterCandidate: 23,
    });
    const paths = resolveLongRunV3ArtifactPaths(runDirectory);
    const turns = await readLongRunV3Evidence(paths.turnEvidence);
    for (const turnId of ["shared-018", "shared-019"] as const) {
      const abstentionTurn = turns.find(
        (evidence) => evidence.turnId === turnId,
      );
      const abstentionAssertion = abstentionTurn?.assertions.find(
        (candidate) => candidate.code === "memory_abstains_without_evidence",
      );
      expect(abstentionTurn?.status).toBe("PASS");
      expect(abstentionAssertion).toMatchObject({
        status: "PASS",
        actual: {
          responseReview: {
            status: "PENDING_MANUAL",
            evidence: ["conversation.md", "model-io.jsonl"],
          },
          durability: { passed: true, issues: [] },
        },
      });
    }
    const turn = turns.find((evidence) => evidence.turnId === "shared-023");
    const assertion = turn?.assertions.find(
      (candidate) => candidate.code === "planned_not_occurred",
    );

    expect(turn?.status).toBe("PASS");
    expect(assertion).toMatchObject({
      status: "PASS",
      actual: {
        responseReview: {
          status: "PENDING_MANUAL",
          evidence: ["conversation.md", "model-io.jsonl"],
        },
        durability: { passed: true, issues: [] },
      },
    });
  }, 60_000);

  it("restores checkpoint-000 before retrying a turn whose artifact write set was incomplete", async () => {
    const root = process.cwd();
    const runId = `fixture-resume-${randomUUID()}`;
    const runDirectory = join(root, "tmp", "companion-long-run-v3", runId);
    cleanup.push(runDirectory);

    await runCompanionLongRunV3({
      workspaceRoot: root,
      profile: "fixture",
      runId,
      stopAfterCandidate: 1,
    });
    const paths = resolveLongRunV3ArtifactPaths(runDirectory);
    expect(
      (await readLongRunV3Evidence(paths.turnEvidence)).map(
        (turn) => turn.turnId,
      ),
    ).toEqual(["shared-001"]);

    // The evidence line landed, while all sibling per-turn artifacts are
    // missing. Resume must discard this uncheckpointed candidate instead of
    // treating its evidence line as proof of completion.
    await writeFile(paths.modelIo, "", "utf8");
    await writeFile(paths.causalEvidence, "", "utf8");
    await writeFile(
      paths.conversation,
      renderLongRunV3Conversation([]),
      "utf8",
    );

    await runCompanionLongRunV3({
      workspaceRoot: root,
      profile: "fixture",
      runId,
      resume: true,
      stopAfterCandidate: 1,
    });
    const restoredTurns = await readLongRunV3Evidence(paths.turnEvidence);
    expect(restoredTurns.map((turn) => turn.turnId)).toEqual(["shared-001"]);
    const manifest = JSON.parse(
      await readFile(paths.runManifest, "utf8"),
    ) as LongRunV3RunManifest;
    await expect(
      inspectLongRunV3ArtifactCoverage({
        paths,
        expectedTurns: expectedArtifactTurns().slice(0, 1),
        manifest,
      }),
    ).resolves.toMatchObject({ passed: true });
  }, 30_000);

  it("rolls a stop-after-17 run back to checkpoint-010 and deterministically replaces its seven-turn tail", async () => {
    const root = process.cwd();
    const runId = `fixture-resume-tail-${randomUUID()}`;
    const runDirectory = join(root, "tmp", "companion-long-run-v3", runId);
    cleanup.push(runDirectory);
    const options = {
      workspaceRoot: root,
      profile: "fixture" as const,
      runId,
      stopAfterCandidate: 17,
    };

    await runCompanionLongRunV3(options);
    const paths = resolveLongRunV3ArtifactPaths(runDirectory);
    const beforeResume = await readLongRunV3Evidence(paths.turnEvidence);
    expect(beforeResume).toHaveLength(17);
    expect(
      (await readLatestLongRunV3Checkpoint(runDirectory))
        .completedCandidateTurns,
    ).toBe(10);
    await writeFile(
      paths.conversation,
      `${await readFile(paths.conversation, "utf8")}TORN-POST-CHECKPOINT-TAIL\n`,
      "utf8",
    );

    await runCompanionLongRunV3({ ...options, resume: true });
    const afterResume = await readLongRunV3Evidence(paths.turnEvidence);
    expect(afterResume).toHaveLength(17);
    expect(new Set(afterResume.map((turn) => turn.turnId)).size).toBe(17);
    expect(await readFile(paths.conversation, "utf8")).not.toContain(
      "TORN-POST-CHECKPOINT-TAIL",
    );
    const manifest = JSON.parse(
      await readFile(paths.runManifest, "utf8"),
    ) as LongRunV3RunManifest;
    await expect(
      inspectLongRunV3ArtifactCoverage({
        paths,
        expectedTurns: expectedArtifactTurns().slice(0, 17),
        manifest,
      }),
    ).resolves.toMatchObject({ passed: true });
  }, 60_000);
});

function fakeDeepSeekEnvironment(): NodeJS.ProcessEnv {
  return {
    RUN_PAID_LONGRUN: "1",
    LLM_PROVIDER: "openai-compatible",
    OPENAI_COMPATIBLE_BASE_URL: "https://api.deepseek.test/v1",
    OPENAI_COMPATIBLE_API_KEY: FAKE_API_KEY,
    OPENAI_COMPATIBLE_MODEL: "deepseek-v4-flash",
    OPENAI_COMPATIBLE_TIMEOUT_MS: "300000",
    OPENAI_COMPATIBLE_MAX_RETRIES: "2",
    OPENAI_COMPATIBLE_STRUCTURED_OUTPUT_MODE: "json_object",
    OPENAI_COMPATIBLE_REASONING_EFFORT: "max",
    OPENAI_COMPATIBLE_REASONING_FORMAT: "openai_reasoning_effort_with_thinking",
    OPENAI_COMPATIBLE_SUPPORTS_THINKING_CONTROL: "false",
    OPENAI_COMPATIBLE_MAX_CONTEXT_TOKENS: "131072",
    OPENAI_COMPATIBLE_MAX_OUTPUT_TOKENS: "32768",
  };
}

function fakeBigModelEnvironment(): NodeJS.ProcessEnv {
  return {
    RUN_PAID_LONGRUN: "1",
    LLM_PROVIDER: "openai-compatible",
    LLM_ACTIVE_PROFILE: "bigmodel",
    LLM_PROFILE_BIGMODEL_BASE_URL:
      "https://open.bigmodel.test/api/coding/paas/v4",
    LLM_PROFILE_BIGMODEL_API_KEY: "test-only-bigmodel-key-never-send",
    LLM_PROFILE_BIGMODEL_MODEL: "glm-5.3-flash",
    LLM_PROFILE_BIGMODEL_TIMEOUT_MS: "300000",
    LLM_PROFILE_BIGMODEL_MAX_RETRIES: "1",
    LLM_PROFILE_BIGMODEL_STRUCTURED_OUTPUT_MODE: "json_object",
    LLM_PROFILE_BIGMODEL_REASONING_EFFORT: "max",
    LLM_PROFILE_BIGMODEL_REASONING_FORMAT:
      "openai_reasoning_effort_with_thinking",
    LLM_PROFILE_BIGMODEL_SUPPORTS_THINKING_CONTROL: "false",
    LLM_PROFILE_BIGMODEL_SUPPORTS_STREAMING: "false",
    LLM_PROFILE_BIGMODEL_MAX_CONTEXT_TOKENS: "1000000",
    LLM_PROFILE_BIGMODEL_MAX_OUTPUT_TOKENS: "32768",
  };
}

function baseServerConfig(databasePath: string): ServerConfig {
  return {
    nodeEnv: "development",
    profile: "development",
    port: 3001,
    host: "127.0.0.1",
    webOrigin: "http://localhost:5173",
    databasePath,
    clockMode: "system",
    fakeClockStart: "2026-08-16T10:00:00.000Z",
    llm: {
      provider: "openai-compatible",
      baseUrl: "https://api.deepseek.com",
      apiKey: FAKE_API_KEY,
      model: "deepseek-v4-flash",
      timeoutMs: 300_000,
      maxRetries: 2,
      maxOutputTokens: 32_768,
      capabilities: {
        structuredOutputMode: "json_object",
        supportsThinkingControl: false,
        supportsStreaming: false,
        reasoningEffort: "max",
        reasoningRequestFormat: "openai_reasoning_effort_with_thinking",
        maxContextTokens: 131_072,
        maxOutputTokens: 32_768,
      },
    },
    conversationRetention: {
      fullVerbatimHours: 24,
      softTokenLimit: 8_000,
      hardTokenLimit: 12_000,
      minimumTailTokens: 3_000,
      minimumRecentTurns: 12,
    },
    logLevel: "silent",
    seedDemo: true,
    developerRoutes: false,
    chatEffectsMode: "off",
    lifePlanningMode: "legacy_exact",
    scheduleNegotiationMode: "enforced",
    selfInitiatedPlanningMode: "enforced",
    liveWorldEffectsMode: "off",
    memoryRecallMode: "legacy",
    autobiographyMode: "enforced",
  };
}

function reviewedDeepSeekProfileConfig(
  config: ServerConfig,
): Parameters<typeof assertLongRunV3DeepSeekProfileExpectation>[1] {
  return {
    provider: "openai-compatible",
    profileName: "legacy",
    baseOrigin: "https://api.deepseek.com",
    baseUrl: config.llm.baseUrl,
    requestedModel: "deepseek-v4-flash",
    timeoutMs: 300_000,
    maxRetries: 2,
    reasoningEffort: "max",
    reasoningRequestFormat: "openai_reasoning_effort_with_thinking",
    structuredOutputMode: "json_object",
    maxContextTokens: 131_072,
    maxOutputTokens: 32_768,
    repairMaxOutputTokens: 16_384,
    apiKeyEnvironment: "OPENAI_COMPATIBLE_API_KEY",
    apiKeyPresent: true,
  };
}

async function createCleanGitRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "chatplus-v3-guard-"));
  cleanup.push(repository);
  await execFileAsync("git", ["init"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "ChatPLUS Test"], {
    cwd: repository,
  });
  await execFileAsync(
    "git",
    ["config", "user.email", "chatplus-test@example.invalid"],
    { cwd: repository },
  );
  await writeFile(join(repository, "committed.txt"), "baseline\n", "utf8");
  await execFileAsync("git", ["add", "committed.txt"], { cwd: repository });
  await execFileAsync("git", ["commit", "-m", "test baseline"], {
    cwd: repository,
  });
  return repository;
}

function runtimeCaseSource(source: string, assertion: string): string {
  const marker = `case "${assertion}"`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing runtime assertion case ${assertion}`);
  const next = source.indexOf('\n      case "', start + marker.length);
  return source.slice(start, next < 0 ? undefined : next);
}
