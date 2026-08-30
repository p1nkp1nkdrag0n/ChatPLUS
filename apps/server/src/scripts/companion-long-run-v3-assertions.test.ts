import type {
  ActionRecord,
  DailyLifeContext,
  DecisionRecord,
  DilemmaEpisode,
  OutcomeRecord,
  PressureEpisode,
  ReflectionRecord,
  RelationshipMilestone,
  SupportIntervention,
} from "@personasim/contracts";
import { describe, expect, it } from "vitest";

import {
  evaluateCompanionLongRunV3HardAssertions,
  validateCompanionLongRunV3BidirectionalCausality,
  validateCompanionLongRunV3CausalRecapProvenance,
  validateCompanionLongRunV3MemoryAbstentionDurability,
  validateCompanionLongRunV3MemoryRecall,
  validateCompanionLongRunV3MemoryWrite,
  validateCompanionLongRunV3PlannedNotOccurredDurability,
  validateCompanionLongRunV3RelationshipContinuityGrounding,
  validateCompanionLongRunV3SupportMode,
  type CompanionLongRunV3HardAssertionInput,
  type CompanionLongRunV3HardGateCode,
  type CompanionLongRunV3MemoryProjection,
  type CompanionLongRunV3Snapshot,
} from "./companion-long-run-v3-assertions.js";

const AT = "2026-09-01T01:00:00.000Z";

describe("companion long-run v3 fuzzy-life hard gates", () => {
  it("accepts one fuzzy daily context, no schedule, a complete causal chain, and a fuzzy prompt", () => {
    const after = snapshot({
      dailyContexts: [dailyContext()],
      dilemmas: [dilemma()],
      supportInterventions: [intervention()],
      decisions: [decision()],
      actions: [action()],
      outcomes: [outcome()],
      reflections: [reflection()],
    });
    const results = evaluateCompanionLongRunV3HardAssertions({
      before: snapshot(),
      after,
      touchedLocalDates: ["2026-09-01"],
      scheduleCapability: false,
      promptCalls: [fuzzyPrompt()],
    });

    expect(gate(results, "daily_context_unique").status).toBe("PASS");
    expect(gate(results, "no_schedule_growth").status).toBe("PASS");
    expect(gate(results, "causal_stage_separated").status).toBe("PASS");
    expect(gate(results, "delegated_decision_authorized").status).toBe("PASS");
    expect(gate(results, "prompt_excludes_future_schedule").status).toBe(
      "PASS",
    );
    expect(gate(results, "prompt_includes_life_context").status).toBe("PASS");
  });

  it("rejects duplicate daily contexts, any schedule mutation, and exposed schedule capability", () => {
    const day = dailyContext();
    const results = evaluateCompanionLongRunV3HardAssertions({
      before: snapshot(),
      after: snapshot({
        dailyContexts: [
          { ...day, id: "day-1" },
          { ...day, id: "day-2" },
        ],
        scheduleItems: [{ id: "schedule-new" }],
      }),
      touchedLocalDates: ["2026-09-01"],
      scheduleCapability: true,
      responseScheduleChangeCount: 1,
      promptCalls: [fuzzyPrompt()],
    });

    expect(gate(results, "daily_context_unique")).toMatchObject({
      status: "FAIL",
    });
    expect(gate(results, "no_schedule_growth")).toMatchObject({
      status: "FAIL",
    });
  });

  it("detects a skipped causal stage and duplicate idempotency key", () => {
    const invalidOutcome: OutcomeRecord = {
      ...outcome(),
      actionIds: ["missing-action"],
    };
    const duplicateDecision: DecisionRecord = {
      ...decision(),
      id: "decision-2",
    };
    const results = evaluateCompanionLongRunV3HardAssertions({
      before: snapshot(),
      after: snapshot({
        dailyContexts: [dailyContext()],
        dilemmas: [dilemma()],
        supportInterventions: [intervention()],
        decisions: [decision(), duplicateDecision],
        outcomes: [invalidOutcome],
      }),
      promptCalls: [fuzzyPrompt()],
    });

    const causalGate = gate(results, "causal_stage_separated");
    expect(causalGate.status).toBe("FAIL");
    expect(JSON.stringify(causalGate.actual)).toContain(
      "outcome:outcome-1:missing_action:missing-action",
    );
    expect(JSON.stringify(causalGate.actual)).toContain(
      "decisions:duplicate_key:decision-key",
    );
  });

  it("requires every causal source id to resolve to persisted message, activity, or domain evidence", () => {
    const persisted = snapshot({
      dilemmas: [dilemma()],
      supportInterventions: [intervention()],
      decisions: [decision()],
      actions: [{ ...action(), sourceEvidenceIds: ["activity-55"] }],
      outcomes: [{ ...outcome(), sourceEvidenceIds: ["domain-64"] }],
      reflections: [reflection()],
      messages: [
        rawMessage("message-37", "user"),
        rawMessage("message-48", "user"),
        rawMessage("message-68", "user"),
      ],
      activityEvents: [{ id: "activity-55" }],
      domainEvents: [{ id: "domain-64" }],
    });
    expect(
      gate(
        evaluateCompanionLongRunV3HardAssertions({
          before: snapshot(),
          after: persisted,
          promptCalls: [fuzzyPrompt()],
        }),
        "causal_stage_separated",
      ).status,
    ).toBe("PASS");

    const detached = evaluateCompanionLongRunV3HardAssertions({
      before: snapshot(),
      after: {
        ...persisted,
        messages: [],
        activityEvents: [],
        domainEvents: [],
      },
      promptCalls: [fuzzyPrompt()],
    });
    const actual = JSON.stringify(
      gate(detached, "causal_stage_separated").actual,
    );
    expect(gate(detached, "causal_stage_separated").status).toBe("FAIL");
    for (const issue of [
      "dilemma:dilemma-1:source_not_persisted:message-37",
      "intervention:support-1:source_not_persisted:message-48",
      "decision:decision-1:source_not_persisted:message-48",
      "action:action-1:source_not_persisted:activity-55",
      "outcome:outcome-1:source_not_persisted:domain-64",
      "reflection:reflection-1:source_not_persisted:message-68",
    ]) {
      expect(actual).toContain(issue);
    }
  });

  it("requires the exact delegated authorization and forbids same-turn action/outcome", () => {
    const before = snapshot({
      dailyContexts: [dailyContext()],
      dilemmas: [dilemma()],
    });
    const after = snapshot({
      dailyContexts: [dailyContext()],
      dilemmas: [dilemma()],
      supportInterventions: [intervention()],
      decisions: [decision()],
    });
    const valid = evaluateCompanionLongRunV3HardAssertions({
      before,
      after,
      expectedDelegatedAuthorizationMessageId: "message-48",
      currentUserMessageId: "message-48",
      promptCalls: [fuzzyPrompt()],
    });
    expect(gate(valid, "delegated_decision_authorized").status).toBe("PASS");

    const actionInvented = evaluateCompanionLongRunV3HardAssertions({
      before,
      after: { ...after, actions: [action()] },
      expectedDelegatedAuthorizationMessageId: "message-48",
      currentUserMessageId: "message-48",
      promptCalls: [fuzzyPrompt()],
    });
    expect(gate(actionInvented, "delegated_decision_authorized").status).toBe(
      "FAIL",
    );

    const wrongMessage = evaluateCompanionLongRunV3HardAssertions({
      before,
      after,
      expectedDelegatedAuthorizationMessageId: "message-other",
      currentUserMessageId: "message-other",
      promptCalls: [fuzzyPrompt()],
    });
    expect(gate(wrongMessage, "delegated_decision_authorized").status).toBe(
      "FAIL",
    );
  });

  it("binds pressure direction changes to explicit current-turn evidence", () => {
    const beforeEpisode = pressureEpisode();
    const afterEpisode: PressureEpisode = {
      ...beforeEpisode,
      status: "improving",
      currentClarity: 0.5,
      currentFeltUnderstood: 0.45,
      sourceMessageIds: ["message-26", "message-35"],
      latestEvidenceMessageId: "message-35",
      updatedAtUtc: "2026-09-05T12:00:00.000Z",
    };
    const input: CompanionLongRunV3HardAssertionInput = {
      before: snapshot({ pressureEpisodes: [beforeEpisode] }),
      after: snapshot({ pressureEpisodes: [afterEpisode] }),
      currentUserMessageId: "message-35",
      pressureExpectation: {
        episodeId: "pressure-1",
        evidenceMessageId: "message-35",
        pressure: "unchanged",
        clarity: "increase",
        feltUnderstood: "increase",
      },
      promptCalls: [fuzzyPrompt()],
    };
    const valid = evaluateCompanionLongRunV3HardAssertions(input);
    expect(gate(valid, "pressure_change_evidence_bound").status).toBe("PASS");

    const ungrounded = evaluateCompanionLongRunV3HardAssertions({
      ...input,
      after: snapshot({
        pressureEpisodes: [
          {
            ...afterEpisode,
            currentPressure: 0.5,
            sourceMessageIds: ["message-26"],
            latestEvidenceMessageId: "message-26",
          },
        ],
      }),
    });
    const pressureGate = gate(ungrounded, "pressure_change_evidence_bound");
    expect(pressureGate.status).toBe("FAIL");
    expect(JSON.stringify(pressureGate.actual)).toContain(
      '"ungroundedEpisodeIds":["pressure-1"]',
    );
  });

  it("requires a replay to make no provider call and no durable mutation", () => {
    const frozen = snapshot({ durableSha256: "same" });
    const valid = evaluateCompanionLongRunV3HardAssertions({
      before: frozen,
      after: frozen,
      expectReplay: true,
      idempotentReplay: true,
      promptCalls: [],
    });
    expect(gate(valid, "idempotent_replay").status).toBe("PASS");
    expect(gate(valid, "prompt_excludes_future_schedule").status).toBe("PASS");
    expect(gate(valid, "prompt_includes_life_context").status).toBe("PASS");

    const mutated = evaluateCompanionLongRunV3HardAssertions({
      before: frozen,
      after: { ...frozen, durableSha256: "changed" },
      expectReplay: true,
      idempotentReplay: true,
      promptCalls: [fuzzyPrompt()],
    });
    expect(gate(mutated, "idempotent_replay").status).toBe("FAIL");
  });

  it("finds retired schedule prompt segments and missing fuzzy-life context", () => {
    const results = evaluateCompanionLongRunV3HardAssertions({
      before: snapshot(),
      after: snapshot(),
      promptCalls: [
        {
          purpose: "chat_turn",
          system: "system",
          prompt:
            'FUTURE_SCHEDULE_JSON\n[]\nCURRENT_ACTIVITY_JSON\n{"title":"精确活动"}\nUSER_MESSAGE\n你好',
        },
      ],
    });
    expect(gate(results, "prompt_excludes_future_schedule").status).toBe(
      "FAIL",
    );
    expect(
      JSON.stringify(gate(results, "prompt_excludes_future_schedule").actual),
    ).toContain("CURRENT_ACTIVITY_JSON");
    expect(gate(results, "prompt_includes_life_context").status).toBe("FAIL");
  });

  it("fails closed when LIFE_CONTEXT_JSON is truncated, unbounded, or appears in multiple primary prompts", () => {
    const base = {
      before: snapshot(),
      after: snapshot(),
    };
    const truncated = evaluateCompanionLongRunV3HardAssertions({
      ...base,
      promptCalls: [
        {
          purpose: "chat_turn",
          system: "system",
          prompt:
            'LIFE_CONTEXT_JSON\n{"today":"剪片","threads":[\nCURRENT_USER_MESSAGE_JSON\n{"content":"你好"}',
        },
      ],
    });
    expect(gate(truncated, "prompt_includes_life_context")).toMatchObject({
      status: "FAIL",
      actual: {
        primaryPromptCount: 1,
        lifeContextOccurrenceCount: 1,
        adjacentLabel: "CURRENT_USER_MESSAGE_JSON",
        issues: ["life_context_json_invalid_or_truncated"],
      },
    });

    const unbounded = evaluateCompanionLongRunV3HardAssertions({
      ...base,
      promptCalls: [
        {
          purpose: "chat_turn",
          system: "system",
          prompt: 'LIFE_CONTEXT_JSON\n{"today":"剪片"}',
        },
      ],
    });
    expect(gate(unbounded, "prompt_includes_life_context")).toMatchObject({
      status: "FAIL",
      actual: { issues: ["life_context_adjacent_label_missing"] },
    });

    const duplicatePrimary = evaluateCompanionLongRunV3HardAssertions({
      ...base,
      promptCalls: [fuzzyPrompt(), fuzzyPrompt()],
    });
    expect(
      gate(duplicatePrimary, "prompt_includes_life_context"),
    ).toMatchObject({
      status: "FAIL",
      actual: {
        primaryPromptCount: 2,
        issues: ["expected_one_primary_prompt:actual_2"],
      },
    });
  });

  it("checks the shared fork anchor and excludes counterfactual branch facts", () => {
    const base = {
      before: snapshot(),
      after: snapshot(),
      promptCalls: [fuzzyPrompt()],
    };
    const valid = evaluateCompanionLongRunV3HardAssertions({
      ...base,
      branch: {
        branch: "A",
        expectedAnchorSha256: "anchor",
        actualAnchorSha256: "anchor",
        durableProjection: { decision: "签署副主编合同" },
        forbiddenDurableFragments: ["独立影像项目已启动"],
        assistantText: "你选择并签署了副主编合同。",
        forbiddenAssistantFragments: ["第一个小客户"],
      },
    });
    expect(gate(valid, "branch_isolated").status).toBe("PASS");

    const leaked = evaluateCompanionLongRunV3HardAssertions({
      ...base,
      branch: {
        branch: "A",
        expectedAnchorSha256: "anchor",
        actualAnchorSha256: "wrong-anchor",
        durableProjection: { outcome: "独立影像项目已启动" },
        forbiddenDurableFragments: ["独立影像项目已启动"],
        assistantText: "我们已经拿到第一个小客户。",
        forbiddenAssistantFragments: ["第一个小客户"],
      },
    });
    expect(gate(leaked, "branch_isolated")).toMatchObject({
      status: "FAIL",
      actual: {
        anchorSha256: "wrong-anchor",
        durableLeaks: ["独立影像项目已启动"],
        assistantLeaks: ["第一个小客户"],
      },
    });
  });
});

describe("companion long-run v3 fail-closed causal validation", () => {
  it("allows explicitly linked causal stages to continue across sessions", () => {
    const crossSessionIntervention = {
      ...intervention(),
      sessionId: "session-2",
    } satisfies SupportIntervention;
    const crossSessionDecision = {
      ...decision(),
      sessionId: "session-3",
    } satisfies DecisionRecord;
    const crossSessionAction = {
      ...action(),
      sessionId: "session-4",
    } satisfies ActionRecord;
    const crossSessionOutcome = {
      ...outcome(),
      sessionId: "session-5",
    } satisfies OutcomeRecord;
    const crossSessionReflection = {
      ...reflection(),
      sessionId: "session-6",
    } satisfies ReflectionRecord;
    const results = evaluateCompanionLongRunV3HardAssertions({
      before: snapshot(),
      after: snapshot({
        dilemmas: [dilemma()],
        supportInterventions: [crossSessionIntervention],
        decisions: [crossSessionDecision],
        actions: [crossSessionAction],
        outcomes: [crossSessionOutcome],
        reflections: [crossSessionReflection],
      }),
      promptCalls: [fuzzyPrompt()],
    });

    expect(gate(results, "causal_stage_separated").status).toBe("PASS");
  });

  it("accepts a decision with several historical support modes when one matches", () => {
    const earlierListen = {
      ...intervention(),
      id: "support-listen",
      mode: "listen_only",
      recommendationOptionId: undefined,
      idempotencyKey: "support-listen-key",
    } satisfies SupportIntervention;
    const supportedDecision = {
      ...decision(),
      supportInterventionIds: [earlierListen.id, intervention().id],
    } satisfies DecisionRecord;
    const valid = evaluateCompanionLongRunV3HardAssertions({
      before: snapshot(),
      after: snapshot({
        dilemmas: [dilemma()],
        supportInterventions: [earlierListen, intervention()],
        decisions: [supportedDecision],
      }),
      promptCalls: [fuzzyPrompt()],
    });
    expect(gate(valid, "causal_stage_separated").status).toBe("PASS");

    const unsupportedMode = evaluateCompanionLongRunV3HardAssertions({
      before: snapshot(),
      after: snapshot({
        dilemmas: [dilemma()],
        supportInterventions: [earlierListen],
        decisions: [
          {
            ...supportedDecision,
            supportInterventionIds: [earlierListen.id],
          },
        ],
      }),
      promptCalls: [fuzzyPrompt()],
    });
    expect(gate(unsupportedMode, "causal_stage_separated").status).toBe("FAIL");
    expect(
      JSON.stringify(gate(unsupportedMode, "causal_stage_separated").actual),
    ).toContain(
      "decision:decision-1:no_matching_intervention_mode:delegated_decision",
    );
  });

  it("parses adjacent prompt labels without consuming the following LIFE_CONTEXT_JSON label", () => {
    const results = evaluateCompanionLongRunV3HardAssertions({
      before: snapshot(),
      after: snapshot(),
      promptCalls: [
        {
          purpose: "chat_turn",
          system: "system",
          prompt: [
            "USER_MODEL_JSON",
            "LIFE_CONTEXT_JSON",
            '{"today":"剪片"}',
            "CURRENT_USER_MESSAGE_JSON",
            '{"content":"你好"}',
          ].join("\n"),
        },
      ],
    });
    expect(gate(results, "prompt_includes_life_context")).toMatchObject({
      status: "PASS",
      actual: {
        lifeContextOccurrenceCount: 1,
        adjacentLabel: "CURRENT_USER_MESSAGE_JSON",
        issues: [],
      },
    });
  });

  it("rejects cross-subject and cross-decision stage links even when every referenced id exists", () => {
    const secondDilemma = {
      ...dilemma(),
      id: "dilemma-2",
      options: dilemma().options.map((option) => ({
        ...option,
        id: `${option.id}-2`,
      })),
      idempotencyKey: "dilemma-key-2",
    } satisfies DilemmaEpisode;
    const decisionWithoutAuth = { ...decision() };
    delete decisionWithoutAuth.authorizedByMessageId;
    const secondDecision = {
      ...decisionWithoutAuth,
      id: "decision-2",
      dilemmaId: "dilemma-2",
      selectedOptionId: "option-b-2",
      supportInterventionIds: [],
      authority: "subject",
      decidedBy: "user",
      supportMode: "recommend",
      idempotencyKey: "decision-key-2",
    } satisfies DecisionRecord;
    const crossSubjectAction = {
      ...action(),
      subject: "character",
      performedBy: "character",
    } satisfies ActionRecord;
    const secondAction = {
      ...action(),
      id: "action-2",
      decisionId: "decision-2",
      idempotencyKey: "action-key-2",
    } satisfies ActionRecord;
    const crossDecisionOutcome = {
      ...outcome(),
      actionIds: ["action-2"],
    } satisfies OutcomeRecord;

    const results = evaluateCompanionLongRunV3HardAssertions({
      before: snapshot(),
      after: snapshot({
        dilemmas: [dilemma(), secondDilemma],
        supportInterventions: [intervention()],
        decisions: [decision(), secondDecision],
        actions: [crossSubjectAction, secondAction],
        outcomes: [crossDecisionOutcome],
      }),
      promptCalls: [fuzzyPrompt()],
    });

    const actual = JSON.stringify(
      gate(results, "causal_stage_separated").actual,
    );
    expect(gate(results, "causal_stage_separated").status).toBe("FAIL");
    expect(actual).toContain("action:action-1:subject_mismatch");
    expect(actual).toContain(
      "outcome:outcome-1:action_wrong_decision:action-2",
    );
  });

  it("requires T26 exact initial pressure and keeps every later update on that episode only", () => {
    const initial = pressureEpisode();
    const disclosed = {
      ...initial,
      initialPressure: 0.72,
      currentPressure: 0.72,
      initialClarity: 0.45,
      currentClarity: 0.45,
      sourceMessageIds: ["message-25"],
      latestEvidenceMessageId: "message-25",
    } satisfies PressureEpisode;
    const initialResult = evaluateCompanionLongRunV3HardAssertions({
      before: snapshot({
        dilemmas: [dilemma()],
        pressureEpisodes: [disclosed],
      }),
      after: snapshot({
        dilemmas: [dilemma()],
        pressureEpisodes: [initial],
      }),
      currentUserMessageId: "message-26",
      pressureExpectation: {
        episodeId: initial.id,
        evidenceMessageId: "message-26",
        initialPressure: 0.8,
        initialClarity: 0.2,
        currentPressure: 0.8,
        currentClarity: 0.2,
        requirePreexistingEpisode: true,
      },
      promptCalls: [fuzzyPrompt()],
    });
    expect(gate(initialResult, "pressure_change_evidence_bound").status).toBe(
      "PASS",
    );

    const wrongInitial = evaluateCompanionLongRunV3HardAssertions({
      before: snapshot({ pressureEpisodes: [initial] }),
      after: snapshot({
        pressureEpisodes: [
          {
            ...initial,
            initialPressure: 0.72,
            initialClarity: 0.45,
            sourceMessageIds: ["message-25", "message-26"],
            latestEvidenceMessageId: "message-26",
          },
        ],
      }),
      currentUserMessageId: "message-26",
      pressureExpectation: {
        episodeId: initial.id,
        evidenceMessageId: "message-26",
        initialPressure: 0.8,
        initialClarity: 0.2,
        currentPressure: 0.8,
        currentClarity: 0.2,
        requirePreexistingEpisode: true,
      },
      promptCalls: [fuzzyPrompt()],
    });
    expect(
      JSON.stringify(
        gate(wrongInitial, "pressure_change_evidence_bound").actual,
      ),
    ).toContain("initial_pressure:expected_0.8:actual_0.72");

    const later = {
      ...initial,
      status: "improving",
      currentPressure: 0.7,
      currentClarity: 0.5,
      sourceMessageIds: ["message-26", "message-35"],
      latestEvidenceMessageId: "message-35",
      updatedAtUtc: "2026-09-05T12:00:00.000Z",
    } satisfies PressureEpisode;
    const laterResult = evaluateCompanionLongRunV3HardAssertions({
      before: snapshot({
        dilemmas: [dilemma()],
        pressureEpisodes: [initial],
      }),
      after: snapshot({
        dilemmas: [dilemma()],
        pressureEpisodes: [later],
      }),
      currentUserMessageId: "message-35",
      pressureExpectation: {
        episodeId: initial.id,
        evidenceMessageId: "message-35",
        pressure: "decrease",
        clarity: "increase",
        currentPressure: 0.7,
        currentClarity: 0.5,
        requirePreexistingEpisode: true,
      },
      promptCalls: [fuzzyPrompt()],
    });
    expect(gate(laterResult, "pressure_change_evidence_bound").status).toBe(
      "PASS",
    );

    const extra = {
      ...later,
      id: "pressure-extra",
      idempotencyKey: "pressure-extra-key",
    } satisfies PressureEpisode;
    const splitEpisode = evaluateCompanionLongRunV3HardAssertions({
      before: snapshot({
        dilemmas: [dilemma()],
        pressureEpisodes: [initial],
      }),
      after: snapshot({
        dilemmas: [dilemma()],
        pressureEpisodes: [later, extra],
      }),
      currentUserMessageId: "message-35",
      pressureExpectation: {
        episodeId: initial.id,
        evidenceMessageId: "message-35",
        currentPressure: 0.7,
        currentClarity: 0.5,
        requirePreexistingEpisode: true,
      },
      promptCalls: [fuzzyPrompt()],
    });
    const splitActual = JSON.stringify(
      gate(splitEpisode, "pressure_change_evidence_bound").actual,
    );
    expect(gate(splitEpisode, "pressure_change_evidence_bound").status).toBe(
      "FAIL",
    );
    expect(splitActual).toContain("unexpected_changed_episode:pressure-extra");

    const wrongTarget = evaluateCompanionLongRunV3HardAssertions({
      before: snapshot({
        dilemmas: [dilemma()],
        pressureEpisodes: [initial],
      }),
      after: snapshot({
        dilemmas: [dilemma()],
        pressureEpisodes: [{ ...later, currentPressure: 0.6 }],
      }),
      currentUserMessageId: "message-35",
      pressureExpectation: {
        episodeId: initial.id,
        evidenceMessageId: "message-35",
        currentPressure: 0.7,
        currentClarity: 0.5,
        requirePreexistingEpisode: true,
      },
      promptCalls: [fuzzyPrompt()],
    });
    expect(
      JSON.stringify(
        gate(wrongTarget, "pressure_change_evidence_bound").actual,
      ),
    ).toContain("pressure:expected_0.7:actual_0.6");
  });

  it("rejects pressure/intervention backlinks that merely point at existing unrelated rows", () => {
    const pressure = {
      ...pressureEpisode(),
      interventionIds: ["support-1"],
    } satisfies PressureEpisode;
    const unrelated = {
      ...intervention(),
      pressureEpisodeId: "pressure-other",
    } satisfies SupportIntervention;
    const results = evaluateCompanionLongRunV3HardAssertions({
      before: snapshot(),
      after: snapshot({
        dilemmas: [dilemma()],
        supportInterventions: [unrelated],
        pressureEpisodes: [pressure],
      }),
      promptCalls: [fuzzyPrompt()],
    });
    expect(
      JSON.stringify(gate(results, "causal_stage_separated").actual),
    ).toContain("pressure:pressure-1:intervention_backlink_mismatch:support-1");
  });
});

describe("companion long-run v3 fail-closed support and memory validation", () => {
  it("requires exactly one current-message support row with the requested mode and no premature stage", () => {
    const before = snapshot({
      dilemmas: [dilemma()],
      pressureEpisodes: [pressureEpisode()],
    });
    const listen = {
      ...intervention(),
      dilemmaId: undefined,
      pressureEpisodeId: "pressure-1",
      mode: "listen_only",
      recommendationOptionId: undefined,
      sourceMessageId: "message-26",
    } satisfies SupportIntervention;
    const valid = validateCompanionLongRunV3SupportMode({
      before,
      after: snapshot({
        dilemmas: [dilemma()],
        pressureEpisodes: [pressureEpisode()],
        supportInterventions: [listen],
      }),
      expectedMode: "listen_only",
      evidenceMessageId: "message-26",
      offeredBy: "character",
      receivedBy: "user",
    });
    expect(valid).toMatchObject({ passed: true, issues: [] });

    const wrongAndAmbiguous = validateCompanionLongRunV3SupportMode({
      before,
      after: snapshot({
        dilemmas: [dilemma()],
        pressureEpisodes: [pressureEpisode()],
        supportInterventions: [
          { ...listen, sourceMessageId: "message-old" },
          {
            ...listen,
            id: "support-extra",
            idempotencyKey: "support-extra-key",
          },
        ],
        decisions: [decision()],
      }),
      expectedMode: "listen_only",
      evidenceMessageId: "message-26",
      offeredBy: "character",
      receivedBy: "user",
    });
    expect(wrongAndAmbiguous.passed).toBe(false);
    expect(wrongAndAmbiguous.issues).toEqual(
      expect.arrayContaining([
        "expected_one_intervention:actual_2",
        "source_message_mismatch",
        "non_delegated_mode_created_decision:listen_only",
      ]),
    );
  });

  it("requires delegated support, authorization, and decision to be one linked atomic stage", () => {
    const before = snapshot({ dilemmas: [dilemma()] });
    const valid = validateCompanionLongRunV3SupportMode({
      before,
      after: snapshot({
        dilemmas: [dilemma()],
        supportInterventions: [intervention()],
        decisions: [decision()],
      }),
      expectedMode: "delegated_decision",
      evidenceMessageId: "message-48",
      offeredBy: "character",
      receivedBy: "user",
    });
    expect(valid.passed).toBe(true);

    const assistantSourcedIntervention = {
      ...intervention(),
      sourceMessageId: "message-assistant-48",
    } satisfies SupportIntervention;
    const splitEvidenceValid = validateCompanionLongRunV3SupportMode({
      before,
      after: snapshot({
        dilemmas: [dilemma()],
        supportInterventions: [assistantSourcedIntervention],
        decisions: [decision()],
      }),
      expectedMode: "delegated_decision",
      evidenceMessageId: "message-assistant-48",
      authorizationMessageId: "message-48",
      offeredBy: "character",
      receivedBy: "user",
    });
    expect(splitEvidenceValid.passed).toBe(true);

    const detached = validateCompanionLongRunV3SupportMode({
      before,
      after: snapshot({
        dilemmas: [dilemma()],
        supportInterventions: [intervention()],
        decisions: [{ ...decision(), supportInterventionIds: [] }],
      }),
      expectedMode: "delegated_decision",
      evidenceMessageId: "message-48",
      offeredBy: "character",
      receivedBy: "user",
    });
    expect(detached).toMatchObject({
      passed: false,
      issues: ["delegated_decision_not_uniquely_authorized_and_linked"],
    });
  });

  it("requires every new memory to cite the persisted current user message through its own evidence row", () => {
    const before = memoryProjection();
    const after = memoryProjection({
      messages: [rawMessage("message-13", "user")],
      memories: [rawMemory("memory-13", "message-13")],
      memoryEvidence: [
        rawMemoryEvidence("evidence-13", "memory-13", "message-13"),
      ],
    });
    expect(
      validateCompanionLongRunV3MemoryWrite({
        before,
        after,
        evidenceMessageId: "message-13",
      }),
    ).toMatchObject({ passed: true, issues: [] });

    const wrongEvidence = memoryProjection({
      messages: [rawMessage("message-13", "user")],
      memories: [rawMemory("memory-13", "message-13")],
      memoryEvidence: [
        rawMemoryEvidence("evidence-13", "memory-13", "message-other"),
      ],
    });
    expect(
      validateCompanionLongRunV3MemoryWrite({
        before,
        after: wrongEvidence,
        evidenceMessageId: "message-13",
      }).issues,
    ).toContain("memory:memory-13:evidence_source_mismatch");

    const assistantSource = memoryProjection({
      messages: [rawMessage("message-13", "assistant")],
      memories: [rawMemory("memory-13", "message-13")],
      memoryEvidence: [
        rawMemoryEvidence("evidence-13", "memory-13", "message-13"),
      ],
    });
    expect(
      validateCompanionLongRunV3MemoryWrite({
        before,
        after: assistantSource,
        evidenceMessageId: "message-13",
      }).issues,
    ).toContain("memory:memory-13:source_message_not_user");
  });

  it("requires a positive recall to select persisted active memory and evidence in the prompt and current retrieval run", () => {
    const before = memoryProjection({
      messages: [rawMessage("message-13", "user")],
      memories: [rawMemory("memory-13", "message-13")],
      memoryEvidence: [
        rawMemoryEvidence("evidence-13", "memory-13", "message-13"),
      ],
    });
    const retrievalRun = rawRetrievalRun("run-20", "message-20", 1);
    const after = memoryProjection({
      ...before,
      messages: [...before.messages, rawMessage("message-20", "user")],
      retrievalRuns: [retrievalRun],
    });
    const diagnostic = rawRecallDiagnostic();
    expect(
      validateCompanionLongRunV3MemoryRecall({
        before,
        after,
        evidenceMessageId: "message-20",
        diagnostic,
        promptCalls: [
          {
            purpose: "chat_turn",
            system: "system",
            prompt: primaryPromptWithMemoryEvidence(
              retrievalRun.evidence_bundle!,
            ),
          },
        ],
        expectation: {
          minimumSelectedMemories: 1,
          requiredGroups: [
            {
              label: "notebook",
              subjectKeys: ["user_fact:memory-13"],
              contentIncludesAll: ["fact:memory-13"],
              requiredSourceMessageOrdinals: [13],
            },
          ],
          forbiddenContent: ["superseded green fact"],
          requiredSourceMessageIds: ["message-13"],
          requiredSourceMessageOrdinals: [13],
        },
      }),
    ).toMatchObject({ passed: true, issues: [] });

    const malformedFragment = validateCompanionLongRunV3MemoryRecall({
      before,
      after: memoryProjection({
        ...after,
        retrievalRuns: [
          { ...retrievalRun, rendered_prompt_fragment: "{not-json" },
        ],
      }),
      evidenceMessageId: "message-20",
      diagnostic,
      promptCalls: [
        {
          purpose: "chat_turn",
          system: "system",
          prompt: primaryPromptWithMemoryEvidence(
            retrievalRun.evidence_bundle!,
          ),
        },
      ],
    });
    expect(malformedFragment.passed).toBe(false);
    expect(malformedFragment.issues).toContain(
      "retrieval_rendered_prompt_fragment_invalid",
    );

    const missingReference = validateCompanionLongRunV3MemoryRecall({
      before,
      after,
      evidenceMessageId: "message-20",
      diagnostic,
      promptCalls: [
        {
          purpose: "chat_turn",
          system: "system",
          prompt: 'RUNTIME_STATE_JSON\n{"energy":0.5}',
        },
      ],
    });
    expect(missingReference.passed).toBe(false);
    expect(missingReference.issues).toEqual(
      expect.arrayContaining([
        "retrieval_reference_context_missing_or_invalid",
        "retrieval_fragment_not_in_primary_prompt",
      ]),
    );

    const differentReference = validateCompanionLongRunV3MemoryRecall({
      before,
      after,
      evidenceMessageId: "message-20",
      diagnostic,
      promptCalls: [
        {
          purpose: "chat_turn",
          system: "system",
          prompt: primaryPromptWithMemoryEvidence({
            ...retrievalRun.evidence_bundle!,
            query: "different evidence",
          }),
        },
      ],
    });
    expect(differentReference.passed).toBe(false);
    expect(differentReference.issues).toContain(
      "retrieval_fragment_not_in_primary_prompt",
    );

    const staleAndDetached = memoryProjection({
      ...after,
      memories: [
        { ...rawMemory("memory-13", "message-13"), status: "superseded" },
      ],
      memoryEvidence: [],
      retrievalRuns: [rawRetrievalRun("run-20", "message-old", 0)],
    });
    const invalid = validateCompanionLongRunV3MemoryRecall({
      before,
      after: staleAndDetached,
      evidenceMessageId: "message-20",
      diagnostic,
    });
    expect(invalid.passed).toBe(false);
    expect(invalid.issues).toEqual(
      expect.arrayContaining([
        "retrieval_run_source_message_mismatch",
        "selected_memory_not_active:memory-13",
        "selected_evidence_not_persisted:evidence-13",
        "retrieval_run_selected_count_mismatch",
      ]),
    );
  });

  it("fails closed on incomplete per-memory evidence, run/result drift, and unmet turn-specific recall groups", () => {
    const sourceMessages = [12, 14, 16].map((ordinal) =>
      rawMessage(`message-${ordinal}`, "user"),
    );
    const selectedMemories = [12, 14, 16].map((ordinal) => ({
      ...rawMemory(`memory-${ordinal}`, `message-${ordinal}`),
      claim_subject_key:
        ordinal === 12
          ? "user_fact:name"
          : ordinal === 14
            ? "user_fact:notebook"
            : "user_fact:friend",
      content:
        ordinal === 12
          ? "用户名叫林舟"
          : ordinal === 14
            ? "采访笔记在藏青色帆布包内层"
            : "最好的朋友叫许宁",
    }));
    const selectedEvidence = [12, 14, 16].map((ordinal) => ({
      ...rawMemoryEvidence(
        `evidence-${ordinal}`,
        `memory-${ordinal}`,
        `message-${ordinal}`,
      ),
      ...(ordinal === 16
        ? { quote: "许宁准备去重庆进修", context_summary: "朋友的进修计划" }
        : {}),
    }));
    const before = memoryProjection({
      messages: sourceMessages,
      memories: selectedMemories,
      memoryEvidence: selectedEvidence,
    });
    const run = rawPositiveRetrievalRun({
      id: "run-24",
      sourceMessageId: "message-24",
      memoryIds: ["memory-12", "memory-14", "memory-16"],
      evidenceIds: ["evidence-12", "evidence-14", "evidence-16"],
      memoryContents: selectedMemories.map((memory) => memory.content),
    });
    const diagnostic = rawRecallDiagnosticFor(
      ["memory-12", "memory-14", "memory-16"],
      ["evidence-12", "evidence-14", "evidence-16"],
      "basic_memory",
    );
    const after = memoryProjection({
      ...before,
      messages: [...sourceMessages, rawMessage("message-24", "user")],
      retrievalRuns: [run],
    });
    const expectation = {
      minimumSelectedMemories: 3,
      requireDistinctGroupMatches: true,
      requiredGroups: [
        { label: "name", subjectKeys: ["user_fact:name"] },
        {
          label: "notebook",
          subjectKeys: ["user_fact:notebook"],
          contentIncludesAll: ["藏青色", "内层"],
          requiredSourceMessageOrdinals: [14],
        },
        {
          label: "friend",
          subjectKeys: ["user_fact:friend"],
          contentIncludesAll: ["许宁", "重庆", "进修"],
        },
      ],
      forbiddenContent: ["绿色"],
      requiredSourceMessageOrdinals: [12, 14, 16],
      forbiddenSourceMessageOrdinals: [15],
    } as const;
    expect(
      validateCompanionLongRunV3MemoryRecall({
        before,
        after,
        evidenceMessageId: "message-24",
        diagnostic,
        promptCalls: [
          {
            purpose: "chat_turn",
            system: "system",
            prompt: primaryPromptWithMemoryEvidence(run.evidence_bundle),
          },
        ],
        expectation,
      }),
    ).toMatchObject({ passed: true, issues: [] });

    const driftedRun = {
      ...run,
      mode: "event_card",
      candidate_count: 99,
      result: {
        ...run.result,
        selectedMemoryIds: ["memory-12", "memory-14"],
      },
    };
    const invalid = validateCompanionLongRunV3MemoryRecall({
      before,
      after: memoryProjection({
        ...after,
        memories: selectedMemories.map((memory) => {
          if (memory.id === "memory-12")
            return { ...memory, superseded_by_id: "memory-name-current" };
          if (memory.id === "memory-14")
            return { ...memory, merged_into_id: "memory-notebook-current" };
          return { ...memory, content: "旧事实是绿色" };
        }),
        memoryEvidence: selectedEvidence.slice(0, 2),
        retrievalRuns: [driftedRun],
      }),
      evidenceMessageId: "message-24",
      diagnostic,
      promptCalls: [
        { purpose: "chat_turn", system: "system", prompt: "fragment missing" },
      ],
      expectation: {
        ...expectation,
        requiredSourceMessageOrdinals: [12, 14, 16, 99],
        forbiddenSourceMessageIds: ["message-16"],
        forbiddenSourceMessageOrdinals: [15, 16],
      },
    });
    expect(invalid.passed).toBe(false);
    expect(invalid.issues).toEqual(
      expect.arrayContaining([
        "retrieval_run_diagnostic_mode_mismatch",
        "retrieval_run_evidence_bundle_mode_mismatch",
        "retrieval_run_result_memory_selection_mismatch",
        "selected_memory_superseded:memory-12",
        "selected_memory_merged:memory-14",
        "selected_evidence_not_persisted:evidence-16",
        "selected_memory_missing_evidence:memory-16",
        "retrieval_run_candidate_count_mismatch",
        "retrieval_fragment_not_in_primary_prompt",
        "forbidden_selected_memory_content:绿色",
        "required_source_message_ordinal_missing:99",
        "required_memory_group_missing:friend",
      ]),
    );

    const forbiddenSource = validateCompanionLongRunV3MemoryRecall({
      before,
      after,
      evidenceMessageId: "message-24",
      diagnostic,
      promptCalls: [
        {
          purpose: "chat_turn",
          system: "system",
          prompt: primaryPromptWithMemoryEvidence(run.evidence_bundle),
        },
      ],
      expectation: {
        ...expectation,
        forbiddenSourceMessageIds: ["message-16"],
        forbiddenSourceMessageOrdinals: [16],
      },
    });
    expect(forbiddenSource.passed).toBe(false);
    expect(forbiddenSource.issues).toEqual(
      expect.arrayContaining([
        "forbidden_source_message_selected:message-16",
        "forbidden_source_message_ordinal_selected:16",
      ]),
    );
  });

  it("makes unsupported-fact abstention durable: no new user/shared memory may be written", () => {
    const before = durableNegativeSnapshot();
    expect(
      validateCompanionLongRunV3MemoryAbstentionDurability({
        before,
        after: durableNegativeSnapshot(),
        evidenceMessageId: "message-18",
      }),
    ).toMatchObject({ passed: true, issues: [] });

    const invented = rawMemory("memory-invented", "message-18");
    const invalid = validateCompanionLongRunV3MemoryAbstentionDurability({
      before,
      after: durableNegativeSnapshot({ memories: [invented] }),
      evidenceMessageId: "message-18",
    });
    expect(invalid).toMatchObject({
      passed: false,
      issues: ["unsupported_memory_created:memory-invented"],
    });

    const characterSelf = {
      ...rawMemory("memory-character", "message-assistant"),
      namespace: "character_self",
      attribution: "character_decision",
      claim_subject_key: "character:self:choice",
    };
    expect(
      validateCompanionLongRunV3MemoryAbstentionDurability({
        before,
        after: durableNegativeSnapshot({ memories: [characterSelf] }),
        evidenceMessageId: "message-18",
      }).passed,
    ).toBe(true);

    const disguisedUserFact = {
      ...characterSelf,
      id: "memory-disguised-user-fact",
      claim_subject_key: "user_fact:unknown_answer",
    };
    expect(
      validateCompanionLongRunV3MemoryAbstentionDurability({
        before,
        after: durableNegativeSnapshot({ memories: [disguisedUserFact] }),
        evidenceMessageId: "message-18",
      }).issues,
    ).toContain("unsupported_memory_created:memory-disguised-user-fact");
  });

  it("makes planned-not-occurred durable across memory, action, and outcome tables", () => {
    const before = durableNegativeSnapshot();
    const planned = {
      ...rawMemory("memory-plan", "message-23"),
      temporal_status: "planned",
      occurred_start_at_utc: null,
      occurred_at_utc: null,
    };
    expect(
      validateCompanionLongRunV3PlannedNotOccurredDurability({
        before,
        after: durableNegativeSnapshot({ memories: [planned] }),
        evidenceMessageId: "message-23",
      }).passed,
    ).toBe(true);

    const invalid = validateCompanionLongRunV3PlannedNotOccurredDurability({
      before,
      after: durableNegativeSnapshot({
        memories: [
          {
            ...planned,
            id: "memory-false-completion",
            temporal_status: "occurred",
            claim_disposition: "completed",
            occurred_start_at_utc: AT,
          },
        ],
        actions: [action()],
        outcomes: [outcome()],
      }),
      evidenceMessageId: "message-23",
    });
    expect(invalid.passed).toBe(false);
    expect(invalid.issues).toEqual(
      expect.arrayContaining([
        "plan_persisted_as_occurred_memory:memory-false-completion",
        "plan_persisted_as_action:action-1",
        "plan_persisted_as_outcome:outcome-1",
      ]),
    );

    const realColumnOnly =
      validateCompanionLongRunV3PlannedNotOccurredDurability({
        before,
        after: durableNegativeSnapshot({
          memories: [
            {
              ...planned,
              id: "memory-real-column-completion",
              occurred_start_at_utc: AT,
              occurred_at_utc: null,
            },
          ],
        }),
        evidenceMessageId: "message-23",
      });
    expect(realColumnOnly.issues).toContain(
      "plan_persisted_as_occurred_memory:memory-real-column-completion",
    );

    const legacyColumnOnly =
      validateCompanionLongRunV3PlannedNotOccurredDurability({
        before,
        after: durableNegativeSnapshot({
          memories: [
            {
              ...planned,
              id: "memory-legacy-column-completion",
              occurred_at_utc: AT,
            },
          ],
        }),
        evidenceMessageId: "message-23",
      });
    expect(legacyColumnOnly.issues).toContain(
      "plan_persisted_as_occurred_memory:memory-legacy-column-completion",
    );
  });
});

describe("companion long-run v3 fail-closed bidirectional causality", () => {
  it("accepts two independently evidenced chains and rejects a character outcome borrowed from the user chain", () => {
    const full = bidirectionalSnapshot();
    expect(
      validateCompanionLongRunV3BidirectionalCausality({
        snapshot: full,
        characterDilemmaId: "dilemma-character",
        requiredCharacterStage: "character_reflection",
      }),
    ).toMatchObject({ passed: true, issues: [] });

    const characterOutcome = full.outcomes.find(
      (item) => item.id === "outcome-character",
    )!;
    const crossLinked = snapshot({
      ...full,
      outcomes: full.outcomes.map((item) =>
        item.id === characterOutcome.id
          ? { ...item, actionIds: ["action-1"] }
          : item,
      ),
    });
    const invalid = validateCompanionLongRunV3BidirectionalCausality({
      snapshot: crossLinked,
      characterDilemmaId: "dilemma-character",
      requiredCharacterStage: "character_reflection",
    });
    expect(invalid.passed).toBe(false);
    expect(invalid.issues).toEqual(
      expect.arrayContaining([
        "character_mixed_outcome_missing",
        "character_reflection_missing",
      ]),
    );
  });
});

describe("companion long-run v3 grounded causal recap and relationship continuity", () => {
  it("requires exact causal stage counts, persisted sources, and record ids plus summaries in the primary prompt", () => {
    const full = snapshot({
      dilemmas: [dilemma()],
      supportInterventions: [intervention()],
      decisions: [decision()],
      actions: [action()],
      outcomes: [outcome()],
      reflections: [reflection()],
      relationshipMilestones: [relationshipMilestone()],
    });
    const historyMemory = {
      ...rawMemory("memory-history", "message-68"),
      content: "用户愿意为创作承担不确定性",
      claim_subject_key: "relationship:choice:reflection",
    };
    const evidence = memoryProjection({
      messages: causalSourceMessages(),
      memories: [historyMemory],
      memoryEvidence: [
        rawMemoryEvidence("evidence-history", "memory-history", "message-68"),
      ],
    });
    const fullPrompt = causalPrompt(full, [historyMemory]);
    expect(
      validateCompanionLongRunV3CausalRecapProvenance({
        snapshot: full,
        evidence,
        promptCalls: [fullPrompt],
        dilemmaId: "dilemma-1",
        decisionId: "decision-1",
        requiredStages: [
          "dilemma",
          "support",
          "decision",
          "action",
          "outcome",
          "reflection",
        ],
        expectedStageCounts: {
          dilemma: 1,
          decision: 1,
          action: 1,
          outcome: 1,
          reflection: 1,
        },
        requiredMemoryIds: ["memory-history"],
        minimumDurableMemories: 1,
      }),
    ).toMatchObject({ passed: true, issues: [] });

    const intermediate = snapshot({
      dilemmas: [dilemma()],
      supportInterventions: [intervention()],
      decisions: [decision()],
      actions: [action()],
    });
    expect(
      validateCompanionLongRunV3CausalRecapProvenance({
        snapshot: intermediate,
        evidence: memoryProjection({ messages: causalSourceMessages() }),
        promptCalls: [causalPrompt(intermediate)],
        dilemmaId: "dilemma-1",
        decisionId: "decision-1",
        requiredStages: ["dilemma", "support", "decision", "action"],
        expectedStageCounts: {
          decision: 1,
          action: 1,
          outcome: 0,
          reflection: 0,
        },
      }),
    ).toMatchObject({ passed: true, issues: [] });

    const support = intervention();
    const provenanceStripped = validateCompanionLongRunV3CausalRecapProvenance({
      snapshot: full,
      evidence: memoryProjection({ messages: causalSourceMessages() }),
      promptCalls: [
        {
          purpose: "chat_turn",
          system: "system",
          prompt: `LIFE_CONTEXT_JSON\n${JSON.stringify({
            evidencedSupport: [
              {
                id: support.id,
                summary: support.summary,
                intendedEffect: support.intendedEffect,
              },
            ],
          })}\nCURRENT_USER_MESSAGE_JSON\n{"content":"请回顾"}`,
        },
      ],
      dilemmaId: "dilemma-1",
      decisionId: "decision-1",
      requiredStages: ["support"],
      expectedStageCounts: { support: 1 },
    });
    expect(provenanceStripped.passed).toBe(false);
    expect(provenanceStripped.issues).toEqual(
      expect.arrayContaining([
        "causal_source_not_in_prompt:support:support-1:message-48",
        "causal_source_not_in_record:support:support-1:message-48",
        "causal_backlink_not_in_prompt:support:support-1:dilemma-1",
        "causal_backlink_not_in_record:support:support-1:dilemma-1",
      ]),
    );

    const missingSourceEvidence = memoryProjection({
      ...evidence,
      messages: causalSourceMessages().filter(
        (message) => message.id !== "message-64" && message.id !== "message-68",
      ),
    });
    const promptWithoutLateStages = causalPrompt(
      snapshot({
        dilemmas: full.dilemmas,
        supportInterventions: full.supportInterventions,
        decisions: full.decisions,
        actions: full.actions,
      }),
      [historyMemory],
    );
    const invalid = validateCompanionLongRunV3CausalRecapProvenance({
      snapshot: full,
      evidence: missingSourceEvidence,
      promptCalls: [promptWithoutLateStages],
      dilemmaId: "dilemma-1",
      decisionId: "decision-1",
      requiredStages: ["outcome", "reflection"],
      expectedStageCounts: { outcome: 0 },
      requiredMemoryIds: ["memory-history"],
      minimumDurableMemories: 1,
    });
    expect(invalid.passed).toBe(false);
    expect(invalid.issues).toEqual(
      expect.arrayContaining([
        "causal_stage_count_mismatch:outcome:expected_0:actual_1",
        "causal_source_missing:outcome:outcome-1:message-64",
        "causal_source_missing:reflection:reflection-1:message-68",
        "causal_record_summary_not_in_prompt:outcome:outcome-1",
        "causal_record_id_not_in_prompt:reflection:reflection-1",
        "required_durable_memory_source_missing:memory-history:evidence-history",
      ]),
    );
  });

  it("requires distinct prompted boundary and repair memories on top of the complete causal chain", () => {
    const full = snapshot({
      dilemmas: [dilemma()],
      supportInterventions: [intervention()],
      decisions: [decision()],
      actions: [action()],
      outcomes: [outcome()],
      reflections: [reflection()],
      relationshipMilestones: [relationshipMilestone()],
    });
    const boundary = {
      ...rawMemory("memory-boundary", "message-87"),
      content: "用户要求停止讨论工作选择",
      claim_subject_key: "relationship:boundary:stop",
    };
    const repair = {
      ...rawMemory("memory-repair", "message-96"),
      content: "关系修复需要准确区分影响、建议和强迫",
      claim_subject_key: "relationship:repair:responsibility",
    };
    const evidence = memoryProjection({
      messages: [
        ...causalSourceMessages(),
        rawMessage("message-87", "user"),
        rawMessage("message-96", "user"),
      ],
      memories: [boundary, repair],
      memoryEvidence: [
        rawMemoryEvidence("evidence-boundary", "memory-boundary", "message-87"),
        rawMemoryEvidence("evidence-repair", "memory-repair", "message-96"),
      ],
    });
    const baseInput = {
      snapshot: full,
      evidence,
      promptCalls: [causalPrompt(full, [boundary, repair])],
      dilemmaId: "dilemma-1",
      decisionId: "decision-1",
      requiredCausalStages: [
        "support",
        "decision",
        "action",
        "outcome",
        "reflection",
      ],
      expectedStageCounts: {
        decision: 1,
        action: 1,
        outcome: 1,
        reflection: 1,
      },
      requiredMemoryGroups: [
        {
          label: "boundary",
          subjectKeys: ["relationship:boundary:stop"],
          requiredSourceMessageOrdinals: [87],
        },
        {
          label: "repair",
          subjectKeys: ["relationship:repair:responsibility"],
          contentIncludesAll: ["影响", "建议", "强迫"],
          requiredSourceMessageOrdinals: [96],
        },
      ],
      requireDistinctMemoryGroups: true,
      minimumDurableMemories: 2,
    } as const;
    expect(
      validateCompanionLongRunV3RelationshipContinuityGrounding(baseInput),
    ).toMatchObject({ passed: true, issues: [] });

    const brokenMilestone = {
      ...relationshipMilestone(),
      sourceMessageIds: ["message-not-persisted"],
      outcomeIds: ["outcome-not-persisted"],
    };
    const brokenSnapshot = {
      ...full,
      relationshipMilestones: [brokenMilestone],
    };
    const broken = validateCompanionLongRunV3RelationshipContinuityGrounding({
      ...baseInput,
      snapshot: brokenSnapshot,
      promptCalls: [
        causalPrompt(
          brokenSnapshot,
          [boundary, repair],
          [
            {
              id: brokenMilestone.id,
              kind: brokenMilestone.kind,
              summary: brokenMilestone.summary,
            },
          ],
        ),
      ],
    });
    expect(broken.passed).toBe(false);
    expect(broken.issues).toEqual(
      expect.arrayContaining([
        `relationship_milestone:${brokenMilestone.id}:source_not_persisted:message-not-persisted`,
        `relationship_milestone:${brokenMilestone.id}:missing_outcome:outcome-not-persisted`,
        `relationship_milestone_source_not_in_record:${brokenMilestone.id}:message-not-persisted`,
        `relationship_milestone_backlink_not_in_record:${brokenMilestone.id}:decision-1`,
      ]),
    );

    const invalid = validateCompanionLongRunV3RelationshipContinuityGrounding({
      ...baseInput,
      evidence: memoryProjection({
        ...evidence,
        memories: [boundary],
        memoryEvidence: [
          rawMemoryEvidence(
            "evidence-boundary",
            "memory-boundary",
            "message-87",
          ),
        ],
      }),
      promptCalls: [causalPrompt(full, [boundary])],
    });
    expect(invalid.passed).toBe(false);
    expect(invalid.issues).toEqual(
      expect.arrayContaining([
        "required_memory_group_missing:repair",
        "required_memory_groups_not_distinct",
        "minimum_relationship_memories_not_met:expected_2:actual_1",
      ]),
    );

    const unconstrained =
      validateCompanionLongRunV3RelationshipContinuityGrounding({
        ...baseInput,
        requiredMemoryGroups: [{ label: "anything" }],
        minimumDurableMemories: 1,
      });
    expect(unconstrained.passed).toBe(false);
    expect(unconstrained.issues).toContain(
      "invalid_required_memory_group:anything",
    );
  });
});

function gate(
  results: ReturnType<typeof evaluateCompanionLongRunV3HardAssertions>,
  code: CompanionLongRunV3HardGateCode,
) {
  const found = results.find((result) => result.code === code);
  if (found === undefined) throw new Error(`Missing gate ${code}`);
  return found;
}

function snapshot(
  overrides: Partial<CompanionLongRunV3Snapshot> = {},
): CompanionLongRunV3Snapshot {
  return {
    durableSha256: "durable-0",
    dailyContexts: [],
    scheduleItems: [],
    dilemmas: [],
    supportInterventions: [],
    decisions: [],
    actions: [],
    outcomes: [],
    reflections: [],
    pressureEpisodes: [],
    relationshipMilestones: [],
    messages: causalSourceMessages(),
    activityEvents: [],
    domainEvents: [],
    ...overrides,
  };
}

function fuzzyPrompt() {
  return {
    purpose: "chat_turn",
    system: "system policy",
    prompt: 'LIFE_CONTEXT_JSON\n{"today":"剪片"}\nUSER_MESSAGE\n你好',
  };
}

function dailyContext(): DailyLifeContext {
  return {
    id: "day-1",
    agentId: "agent-1",
    localDate: "2026-09-01",
    timezone: "Asia/Shanghai",
    status: "active",
    currentPeriod: "morning",
    availability: "interruptible",
    availabilityConfidence: "inferred",
    theme: "夜航",
    currentFocus: "整理素材",
    todayFocus: ["整理素材"],
    intentIds: ["intent-1"],
    activeThreadIds: ["thread-1"],
    currentPressureEpisodeIds: [],
    recentOutcomeIds: [],
    revision: 1,
    schemaVersion: 1,
    createdAtUtc: AT,
    updatedAtUtc: AT,
  };
}

function dilemma(): DilemmaEpisode {
  return {
    id: "dilemma-1",
    agentId: "agent-1",
    sessionId: "session-1",
    subject: "user",
    title: "职业选择",
    summary: "在稳定工作和纪录片工作之间选择",
    domain: "work",
    options: [
      {
        id: "option-a",
        label: "留在上海",
        description: "保留稳定收入",
        likelyTradeoffs: ["创作空间较少"],
        valuesAtStake: ["稳定"],
      },
      {
        id: "option-b",
        label: "去杭州",
        description: "做纪录片研究",
        likelyTradeoffs: ["收入较低"],
        valuesAtStake: ["创作"],
      },
    ],
    status: "open",
    sourceMessageIds: ["message-37"],
    idempotencyKey: "dilemma-key",
    schemaVersion: 1,
    effectiveLocalDate: "2026-09-10",
    temporalPrecision: "day",
    recordedAtUtc: AT,
    updatedAtUtc: AT,
  };
}

function intervention(): SupportIntervention {
  return {
    id: "support-1",
    agentId: "agent-1",
    sessionId: "session-1",
    dilemmaId: "dilemma-1",
    mode: "delegated_decision",
    offeredBy: "character",
    receivedBy: "user",
    summary: "在明确授权后给出唯一选择",
    intendedEffect: "形成决定",
    recommendationOptionId: "option-b",
    sourceMessageId: "message-48",
    idempotencyKey: "support-key",
    schemaVersion: 1,
    effectiveLocalDate: "2026-09-12",
    temporalPrecision: "day",
    recordedAtUtc: AT,
  };
}

function decision(): DecisionRecord {
  return {
    id: "decision-1",
    agentId: "agent-1",
    sessionId: "session-1",
    dilemmaId: "dilemma-1",
    subject: "user",
    supportMode: "delegated_decision",
    authority: "delegated",
    decidedBy: "character",
    selectedOptionId: "option-b",
    selectionSummary: "去杭州做纪录片研究",
    reasoningSummary: "更符合长期创作价值",
    supportInterventionIds: ["support-1"],
    sourceMessageIds: ["message-48"],
    authorizedByMessageId: "message-48",
    confidence: 0.8,
    status: "current",
    idempotencyKey: "decision-key",
    schemaVersion: 1,
    effectiveLocalDate: "2026-09-12",
    temporalPrecision: "day",
    recordedAtUtc: AT,
  };
}

function action(): ActionRecord {
  return {
    id: "action-1",
    agentId: "agent-1",
    sessionId: "session-1",
    decisionId: "decision-1",
    subject: "user",
    performedBy: "user",
    actionKind: "initiated",
    summary: "发送接受邮件并提出离职",
    sourceEvidenceIds: ["message-55"],
    idempotencyKey: "action-key",
    schemaVersion: 1,
    effectiveLocalDate: "2026-09-13",
    temporalPrecision: "day",
    recordedAtUtc: AT,
  };
}

function outcome(): OutcomeRecord {
  return {
    id: "outcome-1",
    agentId: "agent-1",
    sessionId: "session-1",
    decisionId: "decision-1",
    actionIds: ["action-1"],
    causeKind: "mixed",
    valence: "mixed",
    summary: "确认接受但初期收入降低",
    consequenceFacts: ["offer 已确认", "前两个月八成薪资"],
    sourceEvidenceIds: ["message-64"],
    confidence: 1,
    status: "confirmed",
    idempotencyKey: "outcome-key",
    schemaVersion: 1,
    effectiveLocalDate: "2026-09-16",
    temporalPrecision: "day",
    recordedAtUtc: AT,
  };
}

function reflection(): ReflectionRecord {
  return {
    id: "reflection-1",
    agentId: "agent-1",
    sessionId: "session-1",
    subject: "user",
    reflectedBy: "user",
    decisionId: "decision-1",
    outcomeId: "outcome-1",
    summary: "愿意为创作承担不确定性",
    lessons: ["选择包含代价"],
    stanceTowardDecision: "affirm",
    changedInterpretation: true,
    sourceMessageIds: ["message-68"],
    idempotencyKey: "reflection-key",
    schemaVersion: 1,
    effectiveLocalDate: "2026-09-17",
    temporalPrecision: "day",
    recordedAtUtc: AT,
  };
}

function relationshipMilestone(): RelationshipMilestone {
  return {
    id: "milestone-choice-1",
    agentId: "agent-1",
    sessionId: "session-1",
    kind: "turning_point",
    title: "共同选择产生了后果",
    summary: "用户确认这个选择改变了对创作代价的理解",
    significance: 0.8,
    interventionIds: ["support-1"],
    decisionIds: ["decision-1"],
    outcomeIds: ["outcome-1"],
    reflectionIds: ["reflection-1"],
    sourceMessageIds: ["message-68"],
    idempotencyKey: "milestone-choice-key",
    schemaVersion: 1,
    effectiveLocalDate: "2026-09-17",
    temporalPrecision: "day",
    recordedAtUtc: AT,
  };
}

function pressureEpisode(): PressureEpisode {
  return {
    id: "pressure-1",
    agentId: "agent-1",
    sessionId: "session-1",
    dilemmaId: "dilemma-1",
    subject: "user",
    pressureKind: "work",
    triggerSummary: "工作选择",
    status: "open",
    initialPressure: 0.8,
    currentPressure: 0.8,
    initialClarity: 0.2,
    currentClarity: 0.2,
    initialFeltUnderstood: 0.2,
    currentFeltUnderstood: 0.2,
    interventionIds: [],
    outcomeIds: [],
    sourceMessageIds: ["message-26"],
    latestEvidenceMessageId: "message-26",
    idempotencyKey: "pressure-key",
    schemaVersion: 1,
    effectiveLocalDate: "2026-09-05",
    temporalPrecision: "day",
    recordedAtUtc: AT,
    updatedAtUtc: AT,
  };
}

function memoryProjection(
  overrides: Partial<CompanionLongRunV3MemoryProjection> = {},
): CompanionLongRunV3MemoryProjection {
  return {
    messages: [],
    memories: [],
    memoryEvidence: [],
    retrievalRuns: [],
    ...overrides,
  };
}

function durableNegativeSnapshot(
  overrides: Partial<
    CompanionLongRunV3MemoryProjection & {
      actions: readonly ActionRecord[];
      outcomes: readonly OutcomeRecord[];
    }
  > = {},
) {
  return {
    ...memoryProjection(),
    actions: [] as readonly ActionRecord[],
    outcomes: [] as readonly OutcomeRecord[],
    ...overrides,
  };
}

function rawMessage(id: string, role: "user" | "assistant") {
  const ordinal = id.match(/message-(\d+)$/u)?.[1];
  return {
    id,
    agent_id: "agent-1",
    session_id: "session-1",
    role,
    content: `${role}:${id}`,
    ...(ordinal === undefined
      ? {}
      : {
          client_message_id: `client-long-run-v3-shared-${ordinal.padStart(3, "0")}`,
        }),
  };
}

function rawMemory(id: string, sourceMessageId: string) {
  return {
    id,
    agent_id: "agent-1",
    type: "semantic",
    content: `fact:${id}`,
    namespace: "user_model",
    attribution: "user_explicit",
    status: "active",
    source_message_id: sourceMessageId,
    claim_subject_key: `user_fact:${id}`,
    temporal_status: "timeless",
    claim_disposition: "affirmed",
    occurred_start_at_utc: null,
    occurred_at_utc: null,
  };
}

function rawMemoryEvidence(
  id: string,
  memoryId: string,
  sourceMessageId: string,
) {
  return {
    id,
    memory_id: memoryId,
    source_type: "message",
    source_id: sourceMessageId,
  };
}

function rawRetrievalRun(
  id: string,
  sourceMessageId: string,
  selectedCount: number,
) {
  const evidenceBundle = {
    query: "采访笔记",
    mode: "verbatim_quote",
    generatedAtUtc: AT,
    score: 1,
    evidence: [
      {
        memoryId: "memory-13",
        memoryContent: "fact:memory-13",
        memoryKind: "semantic",
        evidence: { id: "evidence-13" },
      },
    ],
  };
  const selected = selectedCount === 1;
  return {
    id,
    agent_id: "agent-1",
    session_id: "session-1",
    source_message_id: sourceMessageId,
    mode: selected ? "verbatim_quote" : "none",
    candidate_count: 1,
    selected_count: selectedCount,
    candidates: [{ memoryId: "memory-13", score: 1 }],
    result: selected
      ? {
          mode: "verbatim_quote",
          selectedMemoryIds: ["memory-13"],
          selectedEvidenceIds: ["evidence-13"],
          score: 1,
          abstained: false,
          evidenceBundle,
        }
      : {
          mode: "none",
          selectedMemoryIds: [],
          selectedEvidenceIds: [],
          score: 0,
          abstained: true,
          abstentionReason: "no_match",
        },
    evidence_bundle: selected ? evidenceBundle : null,
    rendered_prompt_fragment: selected
      ? JSON.stringify({ memoryEvidence: evidenceBundle }, null, 2)
      : null,
  };
}

function rawRecallDiagnostic() {
  return {
    rolloutMode: "enforced",
    promptStrategy: "evidence_selected",
    legacyPromptMemoryIds: [],
    promptMemoryIds: ["memory-13"],
    selectedMemoryIds: ["memory-13"],
    selectedEvidenceIds: ["evidence-13"],
    rejectedMemoryIds: [],
    recallMode: "verbatim_quote",
    score: 1,
    abstained: false,
    durationMs: 1,
  };
}

function rawPositiveRetrievalRun(input: {
  id: string;
  sourceMessageId: string;
  memoryIds: readonly string[];
  evidenceIds: readonly string[];
  memoryContents: readonly string[];
}) {
  const evidenceBundle = {
    query: "durable facts",
    mode: "basic_memory",
    generatedAtUtc: AT,
    score: 1,
    evidence: input.memoryIds.map((memoryId, index) => ({
      memoryId,
      memoryContent: input.memoryContents[index] ?? memoryId,
      memoryKind: "semantic",
      evidence: { id: input.evidenceIds[index] },
    })),
  };
  const rendered = JSON.stringify({ memoryEvidence: evidenceBundle }, null, 2);
  return {
    id: input.id,
    agent_id: "agent-1",
    session_id: "session-1",
    source_message_id: input.sourceMessageId,
    mode: "basic_memory",
    candidate_count: input.memoryIds.length,
    selected_count: input.memoryIds.length,
    candidates: input.memoryIds.map((memoryId) => ({ memoryId, score: 1 })),
    result: {
      mode: "basic_memory",
      selectedMemoryIds: [...input.memoryIds],
      selectedEvidenceIds: [...input.evidenceIds],
      score: 1,
      abstained: false,
      evidenceBundle,
    },
    evidence_bundle: evidenceBundle,
    rendered_prompt_fragment: rendered,
  };
}

function primaryPromptWithMemoryEvidence(
  memoryEvidence: Record<string, unknown>,
): string {
  return [
    "USER_MODEL_JSON",
    "REFERENCE_CONTEXT_JSON",
    JSON.stringify({
      dialogue: { style: "fixture" },
      memoryEvidence,
      relevantMemories: [],
    }),
    "RUNTIME_STATE_JSON",
    JSON.stringify({ energy: 0.5 }),
  ].join("\n");
}

function rawRecallDiagnosticFor(
  memoryIds: readonly string[],
  evidenceIds: readonly string[],
  mode: "event_card" | "verbatim_quote" | "date_digest" | "basic_memory",
) {
  return {
    rolloutMode: "enforced",
    promptStrategy: "evidence_selected",
    legacyPromptMemoryIds: [],
    promptMemoryIds: [...memoryIds],
    selectedMemoryIds: [...memoryIds],
    selectedEvidenceIds: [...evidenceIds],
    rejectedMemoryIds: [],
    recallMode: mode,
    score: 1,
    abstained: false,
    durationMs: 1,
  };
}

function causalSourceMessages() {
  return [37, 48, 55, 64, 68].map((ordinal) =>
    rawMessage(`message-${ordinal}`, "user"),
  );
}

function causalPrompt(
  causalSnapshot: CompanionLongRunV3Snapshot,
  memories: readonly Record<string, unknown>[] = [],
  projectedMilestones: readonly unknown[] = causalSnapshot.relationshipMilestones,
) {
  return {
    purpose: "chat_turn",
    system: "system",
    prompt: `LIFE_CONTEXT_JSON\n${JSON.stringify({
      unresolvedDilemmas: causalSnapshot.dilemmas,
      evidencedSupport: causalSnapshot.supportInterventions,
      recentDecisions: causalSnapshot.decisions,
      evidencedActions: causalSnapshot.actions,
      evidencedConsequences: causalSnapshot.outcomes,
      reflections: causalSnapshot.reflections,
      relationshipMilestones: projectedMilestones,
      retrievedEvidence: memories.map((memory) => ({
        memoryId: memory.id,
        memoryContent: memory.content,
      })),
    })}\nCURRENT_USER_MESSAGE_JSON\n{"content":"请回顾"}`,
  };
}

function bidirectionalSnapshot(): CompanionLongRunV3Snapshot {
  const characterDilemma = {
    ...dilemma(),
    id: "dilemma-character",
    subject: "character",
    title: "夜航剪辑选择",
    summary: "克制结尾还是强化冲突",
    options: dilemma().options.map((option, index) => ({
      ...option,
      id: index === 0 ? "character-option-a" : "character-option-b",
    })),
    sourceMessageIds: ["control-night-voyage"],
    idempotencyKey: "dilemma-character-key",
  } satisfies DilemmaEpisode;
  const characterSupport = {
    ...intervention(),
    id: "support-character",
    dilemmaId: "dilemma-character",
    mode: "recommend",
    offeredBy: "user",
    receivedBy: "character",
    recommendationOptionId: "character-option-a",
    sourceMessageId: "message-73",
    idempotencyKey: "support-character-key",
  } satisfies SupportIntervention;
  const decisionBase = { ...decision() };
  delete decisionBase.authorizedByMessageId;
  const characterDecision = {
    ...decisionBase,
    id: "decision-character",
    dilemmaId: "dilemma-character",
    subject: "character",
    supportMode: "recommend",
    authority: "subject",
    decidedBy: "character",
    selectedOptionId: "character-option-a",
    supportInterventionIds: ["support-character"],
    sourceMessageIds: ["message-76"],
    idempotencyKey: "decision-character-key",
  } satisfies DecisionRecord;
  const characterAction = {
    ...action(),
    id: "action-character",
    decisionId: "decision-character",
    subject: "character",
    performedBy: "character",
    sourceEvidenceIds: ["control-character-action"],
    idempotencyKey: "action-character-key",
  } satisfies ActionRecord;
  const characterOutcome = {
    ...outcome(),
    id: "outcome-character",
    decisionId: "decision-character",
    actionIds: ["action-character"],
    sourceEvidenceIds: ["control-character-outcome"],
    idempotencyKey: "outcome-character-key",
  } satisfies OutcomeRecord;
  const characterReflection = {
    ...reflection(),
    id: "reflection-character",
    subject: "character",
    reflectedBy: "character",
    decisionId: "decision-character",
    outcomeId: "outcome-character",
    sourceMessageIds: ["message-79"],
    idempotencyKey: "reflection-character-key",
  } satisfies ReflectionRecord;
  return snapshot({
    dilemmas: [dilemma(), characterDilemma],
    supportInterventions: [intervention(), characterSupport],
    decisions: [decision(), characterDecision],
    actions: [action(), characterAction],
    outcomes: [outcome(), characterOutcome],
    reflections: [reflection(), characterReflection],
  });
}
