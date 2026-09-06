import { describe, expect, it } from "vitest";
import type {
  ActionRecord,
  DecisionRecord,
  DilemmaEpisode,
  OutcomeRecord,
} from "@personasim/contracts";

import { analyzeLifeEvidence } from "./fuzzy-life-evidence.js";
import {
  collectLifeAssociationEvidence,
  selectLifeEvidenceAssociation,
  type LifeAssociationCandidate,
  type LifeAssociationInput,
  type LifeAssociationStage,
} from "./fuzzy-life-association.js";

const NOW = "2026-09-05T08:00:00.000Z";
const BEFORE = "2026-09-05T07:00:00.000Z";
const OLD = "2026-09-01T07:00:00.000Z";

function candidate(
  id: string,
  selection: string,
  sessionId = "current",
  atUtc = BEFORE,
): LifeAssociationCandidate {
  const decision: DecisionRecord = {
    id,
    agentId: "agent",
    sessionId,
    dilemmaId: `${id}-dilemma`,
    subject: "user",
    supportMode: "deliberate",
    authority: "subject",
    decidedBy: "user",
    selectedOptionId: `${id}-option`,
    selectionSummary: selection,
    reasoningSummary: selection,
    supportInterventionIds: [],
    sourceMessageIds: [`${id}-source`],
    confidence: 1,
    status: "current",
    effectiveLocalDate: atUtc.slice(0, 10),
    effectivePeriod: "afternoon",
    temporalPrecision: "period",
    recordedAtUtc: atUtc,
    idempotencyKey: id,
    schemaVersion: 1,
  };
  const dilemma: DilemmaEpisode = {
    id: decision.dilemmaId,
    agentId: decision.agentId,
    sessionId,
    subject: "user",
    domain: "work",
    status: "closed",
    title: selection,
    summary: selection,
    options: [
      {
        id: decision.selectedOptionId,
        label: selection,
        description: selection,
        likelyTradeoffs: [],
        valuesAtStake: [],
      },
      {
        id: `${id}-alternative`,
        label: "暂缓安排",
        description: "暂缓安排",
        likelyTradeoffs: [],
        valuesAtStake: [],
      },
    ],
    sourceMessageIds: decision.sourceMessageIds,
    effectiveLocalDate: decision.effectiveLocalDate,
    effectivePeriod: "afternoon",
    temporalPrecision: "period",
    recordedAtUtc: atUtc,
    updatedAtUtc: atUtc,
    idempotencyKey: decision.dilemmaId,
    schemaVersion: 1,
  };
  return { decision, dilemma, actions: [], outcomes: [] };
}

function action(
  value: LifeAssociationCandidate,
  text: string,
  id = `${value.decision.id}-action`,
): ActionRecord {
  return {
    id,
    agentId: value.decision.agentId,
    sessionId: value.decision.sessionId,
    decisionId: value.decision.id,
    subject: value.decision.subject,
    performedBy: "user",
    actionKind: "completed",
    summary: text,
    sourceEvidenceIds: [`${id}-source`],
    effectiveLocalDate: value.decision.effectiveLocalDate,
    effectivePeriod: "afternoon",
    temporalPrecision: "period",
    recordedAtUtc: value.decision.recordedAtUtc,
    idempotencyKey: id,
    schemaVersion: 1,
  };
}

function outcome(
  value: LifeAssociationCandidate,
  text: string,
  id = `${value.decision.id}-outcome`,
): OutcomeRecord {
  return {
    id,
    agentId: value.decision.agentId,
    sessionId: value.decision.sessionId,
    decisionId: value.decision.id,
    actionIds: value.actions.map((item) => item.id),
    causeKind: "external",
    valence: "negative",
    summary: text,
    consequenceFacts: [text],
    sourceEvidenceIds: [`${id}-source`],
    confidence: 1,
    status: "observed",
    effectiveLocalDate: value.decision.effectiveLocalDate,
    effectivePeriod: "afternoon",
    temporalPrecision: "period",
    recordedAtUtc: value.decision.recordedAtUtc,
    idempotencyKey: id,
    schemaVersion: 1,
  };
}

function evidence(text: string, stage: LifeAssociationStage) {
  const clauses = collectLifeAssociationEvidence(
    analyzeLifeEvidence(text),
    stage,
  );
  expect(
    clauses.length,
    `Expected actual ${stage} evidence: ${text}`,
  ).toBeGreaterThan(0);
  return clauses[0]!;
}

function select(
  text: string,
  stage: LifeAssociationStage,
  candidates: readonly LifeAssociationCandidate[],
  extra: Partial<LifeAssociationInput> = {},
) {
  return selectLifeEvidenceAssociation({
    stage,
    clause: evidence(text, stage),
    candidates,
    sessionId: "current",
    atUtc: NOW,
    ...extra,
  });
}

function source(id: string, text: string, atUtc = BEFORE) {
  return {
    id,
    agentId: "agent",
    sessionId: "current",
    role: "user" as const,
    text,
    createdAtUtc: atUtc,
  };
}

function branches() {
  const work = candidate("work", "接受外包项目", "earlier", OLD);
  work.actions = [action(work, "我已经提交了外包项目申请。")];
  work.outcomes = [outcome(work, "后来公司拒绝了我的外包项目申请。")];
  const walk = candidate("walk", "散步二十分钟");
  walk.actions = [action(walk, "我已经散步二十分钟了。")];
  walk.outcomes = [outcome(walk, "散步回来我轻松多了。")];
  return { work, walk };
}

describe("life evidence association", () => {
  it("uses separately verified structured observations without treating them as first-person chat", () => {
    const character = candidate("character", "保留克制的结尾");
    character.decision.subject = "character";
    character.decision.decidedBy = "character";
    character.dilemma!.subject = "character";
    character.actions = [
      {
        ...action(character, "创作者开始落实自己的选择：保留克制的结尾"),
        performedBy: "character",
      },
    ];
    character.outcomes = [
      {
        ...outcome(
          character,
          "动作带来了混合反馈：被摄者对处理方式更放心，但合作方担心成片的市场吸引力下降。",
        ),
        valence: "mixed",
      },
    ];
    const records = [...character.actions, ...character.outcomes];
    const structuredSources = {
      messages: records.map((record) => ({
        id: record.sourceEvidenceIds[0]!,
        agentId: record.agentId,
        sessionId: record.sessionId!,
        role: "system",
        kind: "system_notice",
        createdAtUtc: record.recordedAtUtc,
      })),
      events: records.map((record) => ({
        agentId: record.agentId,
        causationId: record.sourceEvidenceIds[0]!,
        recordedAtUtc: record.recordedAtUtc,
        payload: {
          decisionId: record.decisionId,
          actionId: character.actions[0]!.id,
          ...("actionIds" in record ? { outcomeId: record.id } : {}),
        },
      })),
    };
    const text =
      "我仍认同保留克制的结尾，因为被摄者的尊严比制造冲突更重要；但合作方对市场吸引力的担心是真实代价。";
    expect(
      select(text, "reflection", [character], {
        subject: "character",
        structuredSources,
      })?.outcomeId,
    ).toBe(character.outcomes[0]!.id);
    expect(
      select(text, "reflection", [character], {
        subject: "character",
      })?.outcomeId,
    ).toBeUndefined();
    expect(
      select(text, "reflection", [character], {
        subject: "character",
        structuredSources: { ...structuredSources, events: [] },
      })?.outcomeId,
    ).toBeUndefined();
  });

  it("matches a completed action to the existing selected-option alias", () => {
    const work = candidate("work", "正式辞职");
    expect(
      select("我已经按照这个决定向主管提出离职。", "action", [work])?.decision
        .id,
    ).toBe("work");

    work.actions = [action(work, "我已经按照这个决定向主管提出离职。")];
    expect(
      select("后来公司同意了我的离职申请。", "outcome", [work], {
        recentMessages: [
          source("work-action-source", work.actions[0]!.summary),
        ],
      })?.actionIds,
    ).toEqual(["work-action"]);
  });

  it("does not use an option alias to cross subjects or guess between branches", () => {
    const work = candidate("work", "正式辞职");
    const other = candidate("other", "正式辞职");
    const text = "我已经按照这个决定向主管提出离职。";
    expect(
      select(text, "action", [work], { subject: "character" }),
    ).toBeUndefined();
    expect(select(text, "action", [work, other])).toBeUndefined();

    const stayed = candidate("stayed", "留在目前公司");
    stayed.dilemma!.options[1]!.label = "正式辞职";
    expect(select(text, "action", [stayed])).toBeUndefined();
  });

  it.each(["我明天打算向主管提出离职。", "我没有向主管提出离职。"])(
    "does not turn a non-actual alias mention into association: %s",
    (text) => {
      const clause = analyzeLifeEvidence(text).clauses[0]!;
      expect(
        selectLifeEvidenceAssociation({
          stage: "action",
          clause,
          candidates: [candidate("work", "正式辞职")],
          sessionId: "current",
          atUtc: NOW,
          subject: "user",
        }),
      ).toBeUndefined();
    },
  );

  it("does not attach an unrelated external outcome to the only recent decision", () => {
    const { walk } = branches();
    expect(
      select("后来公司拒绝了我的外包申请。", "outcome", [walk]),
    ).toBeUndefined();
  });

  it.each([false, true])(
    "keeps explicit work outcomes on their older branch regardless of candidate order: %s",
    (reverse) => {
      const { work, walk } = branches();
      const result = select(
        "后来公司拒绝了我的外包项目申请。",
        "outcome",
        reverse ? [work, walk] : [walk, work],
      );
      expect(result?.decision.id).toBe("work");
      expect(result?.actionIds).toEqual(["work-action"]);
    },
  );

  it("does not let a same-session walk outcome capture an explicit work reflection", () => {
    const { work, walk } = branches();
    const result = select("回头看外包项目的决定，我后悔了。", "reflection", [
      walk,
      work,
    ]);
    expect(result?.decision.id).toBe("work");
    expect(result?.outcomeId).toBe("work-outcome");
  });

  it.each([
    "我还没提交外包项目申请。我今天已经散步二十分钟了。",
    "如果外包项目申请成功，我就告诉你。我今天已经散步二十分钟了。",
    "我明天打算提交外包项目申请。我今天已经散步二十分钟了。",
    "我朋友提交了外包项目申请。我今天已经散步二十分钟了。",
    "原文是‘我提交了外包项目申请’。我今天已经散步二十分钟了。",
  ])(
    "cannot use excluded text to associate a different actual action: %s",
    (text) => {
      const { work, walk } = branches();
      expect(select(text, "action", [work])).toBeUndefined();
      expect(select(text, "action", [work, walk])?.decision.id).toBe("walk");
    },
  );

  it("associates different stages of the same turn independently", () => {
    const { work, walk } = branches();
    const text = "我今天已经散步二十分钟了。后来公司拒绝了我的外包项目申请。";
    expect(select(text, "action", [work, walk])?.decision.id).toBe("walk");
    const result = select(text, "outcome", [walk, work]);
    expect(result?.decision.id).toBe("work");
    expect(result?.actionIds).toEqual(["work-action"]);
  });

  it.each([
    "我今天已经散步二十分钟了，我也已经提交了外包项目申请。",
    "我今天已经散步二十分钟了，并提交了外包项目申请。",
  ])(
    "keeps two actual actions in one sentence on their own matters: %s",
    (text) => {
      const { work, walk } = branches();
      const clauses = collectLifeAssociationEvidence(
        analyzeLifeEvidence(text),
        "action",
      );
      expect(clauses).toHaveLength(2);
      expect(
        clauses.map(
          (clause) =>
            selectLifeEvidenceAssociation({
              stage: "action",
              clause,
              candidates: [work, walk],
              sessionId: "current",
              atUtc: NOW,
            })?.decision.id,
        ),
      ).toEqual(["walk", "work"]);
    },
  );

  it("does not inherit a legacy unrelated or unperformed action as a causal predecessor", () => {
    const { work } = branches();
    work.actions = [
      ...work.actions,
      action(work, "我已经散步二十分钟了。", "misassociated-walk"),
      action(work, "我明天打算提交外包项目申请。", "planned-work"),
      {
        ...action(work, "我已经提交了外包项目申请。", "missing-source"),
        sourceEvidenceIds: [],
      },
    ];
    expect(
      select("后来公司拒绝了我的外包项目申请。", "outcome", [work])?.actionIds,
    ).toEqual(["work-action"]);
  });

  it("preserves an explicit external outcome without inventing an action", () => {
    const work = candidate("work", "接受外包项目", "earlier", OLD);
    const result = select("后来公司拒绝了我的外包项目申请。", "outcome", [
      work,
    ]);
    expect(result?.decision.id).toBe("work");
    expect(result?.actionIds).toEqual([]);
  });

  it("never uses an excluded topic in a legacy mixed action as a predecessor", () => {
    const { work } = branches();
    work.actions = [
      action(
        work,
        "我还没提交外包项目申请。我已经散步二十分钟了。",
        "mixed-action",
      ),
    ];
    expect(
      select("后来公司拒绝了我的外包项目申请。", "outcome", [work])?.actionIds,
    ).toEqual([]);
    expect(select("散步回来我轻松多了。", "outcome", [work])).toBeUndefined();
  });

  it("projects every downstream match from the valid branch clauses of legacy records", () => {
    const { work } = branches();
    work.actions = [
      action(
        work,
        "我已经提交了外包项目申请。我没有散步二十分钟。",
        "mixed-action",
      ),
    ];
    work.outcomes = [
      outcome(
        work,
        "后来公司拒绝了我的外包项目申请。如果散步回来轻松多了就好了。",
        "mixed-outcome",
      ),
    ];
    const original = JSON.stringify(work);
    expect(select("散步回来我轻松多了。", "outcome", [work])).toBeUndefined();
    expect(
      select("回头看散步的决定，我后悔了。", "reflection", [work]),
    ).toBeUndefined();
    const result = select("后来公司拒绝了我的外包项目申请。", "outcome", [
      work,
    ]);
    expect(result?.actionIds).toEqual(["mixed-action"]);
    expect(
      select("回头看外包项目的决定，我后悔了。", "reflection", [work])
        ?.outcomeId,
    ).toBe("mixed-outcome");
    expect(JSON.stringify(work)).toBe(original);
  });

  it("does not use another actor's clause in a legacy branch record", () => {
    const { work } = branches();
    work.actions = [
      action(
        work,
        "你已经提交了外包项目申请。我已经散步二十分钟了。",
        "wrong-actor",
      ),
    ];
    expect(
      select("后来公司拒绝了我的外包项目申请。", "outcome", [work])?.actionIds,
    ).toEqual([]);
  });

  it("does not turn a hypothetical option tradeoff into a separate actual action", () => {
    const work = candidate("work", "接受外包项目");
    work.dilemma!.options[0]!.likelyTradeoffs = ["可能影响画画练习"];
    expect(select("我今天完成了画画练习。", "action", [work])).toBeUndefined();
    expect(
      select("我今天已经提交了外包项目申请。", "action", [work])?.decision.id,
    ).toBe("work");
  });

  it("does not use a shared duration as evidence that two activities are the same matter", () => {
    const { walk } = branches();
    expect(
      select("我今天完成了游泳二十分钟的练习。", "action", [walk]),
    ).toBeUndefined();
  });

  it("links only the most specific action when one branch has distinct applications", () => {
    const { work } = branches();
    work.actions = [
      action(work, "我已经向明川影像提交了外包项目申请。", "mingchuan-action"),
      action(work, "我已经向星河影像提交了外包项目申请。", "xinghe-action"),
    ];
    const result = select(
      "后来公司拒绝了我的明川影像外包项目申请。",
      "outcome",
      [work],
    );
    expect(result?.decision.id).toBe("work");
    expect(result?.actionIds).toEqual(["mingchuan-action"]);
  });

  it("preserves an observed branch result without guessing among equally matched actions", () => {
    const { work } = branches();
    work.actions = [
      action(work, "我已经向明川影像提交了外包项目申请。", "mingchuan-action"),
      action(work, "我已经向星河影像提交了外包项目申请。", "xinghe-action"),
    ];
    const result = select("后来公司拒绝了我的外包项目申请。", "outcome", [
      work,
    ]);
    expect(result?.decision.id).toBe("work");
    expect(result?.actionIds).toEqual([]);
  });

  it("does not use an unselected option or the whole dilemma summary as a topic anchor", () => {
    const work = candidate("work", "接受外包项目");
    work.dilemma!.summary = "接受外包项目还是散步二十分钟";
    work.dilemma!.options[1] = {
      id: "walk-option",
      label: "散步二十分钟",
      description: "散步二十分钟",
      likelyTradeoffs: [],
      valuesAtStake: [],
    };
    expect(
      select("我今天已经散步二十分钟了。", "action", [work]),
    ).toBeUndefined();
  });

  it("does not bind a routine platform email to a specific employment decision", () => {
    const work = candidate("work", "接受影像平台副主编岗位");
    expect(
      select("我今天给平台发出了一封普通邮件，只是处理日常杂事。", "action", [
        work,
      ]),
    ).toBeUndefined();
  });

  it("does not guess between equally grounded decisions", () => {
    const first = candidate("first", "接受影像顾问合同", "earlier", OLD);
    const second = candidate("second", "续签影像顾问合同");
    expect(
      select("我已经签了影像顾问合同。", "action", [second, first]),
    ).toBeUndefined();
  });

  it("respects the actual actor and allows explicit character perspective translation", () => {
    const user = candidate("user-work", "接受外包项目");
    const character = candidate("character-work", "接受外包项目");
    character.decision.subject = "character";
    expect(
      select("我已经提交了外包项目申请。", "action", [character, user])
        ?.decision.id,
    ).toBe("user-work");
    expect(
      select("我已经提交了外包项目申请。", "action", [user, character], {
        subject: "character",
      })?.decision.id,
    ).toBe("character-work");
    const thirdParty =
      analyzeLifeEvidence("我朋友已经提交了外包项目申请。").clauses[0]!;
    expect(
      selectLifeEvidenceAssociation({
        stage: "action",
        clause: thirdParty,
        candidates: [character],
        sessionId: "current",
        atUtc: NOW,
        subject: "character",
      }),
    ).toBeUndefined();
  });

  it.each(["superseded", "retracted"] as const)(
    "does not bind to a %s decision",
    (status) => {
      const work = candidate("work", "接受外包项目");
      work.decision.status = status;
      expect(
        select("我已经提交了外包项目申请。", "action", [work]),
      ).toBeUndefined();
    },
  );

  it("does not invent a unique outcome for a reflection when multiple outcomes match", () => {
    const { work } = branches();
    work.outcomes = [
      work.outcomes[0]!,
      outcome(work, work.outcomes[0]!.summary, "second-outcome"),
    ];
    const result = select("回头看外包项目的决定，我后悔了。", "reflection", [
      work,
    ]);
    expect(result?.decision.id).toBe("work");
    expect(result?.outcomeId).toBeUndefined();
  });
});

describe("bounded source-backed references", () => {
  const genericAction = "我已经执行了这个决定。";
  const genericOutcome = "这个决定带来的结果让我轻松多了。";

  it("allows an immediate unique decision reference with an actual selected source", () => {
    const walk = candidate("walk", "散步二十分钟");
    const result = select(genericAction, "action", [walk], {
      recentMessages: [source("walk-source", "我决定散步二十分钟。")],
    });
    expect(result?.decision.id).toBe("walk");
  });

  it.each([
    "我没有选择散步二十分钟。",
    "请复述：我决定散步二十分钟。",
    "我打算选择散步二十分钟。",
    "我建议你选择散步二十分钟。",
  ])(
    "does not use a non-decision source to resolve a current reference: %s",
    (text) => {
      const walk = candidate("walk", "散步二十分钟");
      expect(
        select(genericAction, "action", [walk], {
          recentMessages: [source("walk-source", text)],
        }),
      ).toBeUndefined();
    },
  );

  it("accepts a delegated decision from the assistant's actual selected source", () => {
    const walk = candidate("walk", "散步二十分钟");
    walk.decision.authority = "delegated";
    walk.decision.decidedBy = "character";
    const message = {
      ...source("walk-source", "我决定散步二十分钟。"),
      role: "assistant" as const,
    };
    expect(
      select(genericAction, "action", [walk], { recentMessages: [message] })
        ?.decision.id,
    ).toBe("walk");
  });

  it("does not use a matching system notice as a decision source", () => {
    const walk = candidate("walk", "散步二十分钟");
    const message = {
      ...source("walk-source", "我决定散步二十分钟。"),
      role: "system" as const,
    };
    expect(
      select(genericAction, "action", [walk], { recentMessages: [message] }),
    ).toBeUndefined();
  });

  it("preserves the assistant's actual decision heading and selected option", () => {
    const walk = candidate("walk", "散步二十分钟");
    walk.decision.authority = "delegated";
    walk.decision.decidedBy = "character";
    const message = {
      ...source("walk-source", "我的决定：散步二十分钟。"),
      role: "assistant" as const,
    };
    expect(
      select(genericAction, "action", [walk], { recentMessages: [message] })
        ?.decision.id,
    ).toBe("walk");
  });

  it("preserves an explicitly completed first-person decision heading and its selected option", () => {
    const work = candidate("work", "接受影像平台副主编岗位");
    const message = source(
      "work-source",
      "我最终决定了：选择接受影像平台副主编岗位。",
    );
    expect(
      select(
        "回头看，我仍认同这个决定，‘我后悔了’不是我的感受。",
        "reflection",
        [work],
        { recentMessages: [message] },
      )?.decision.id,
    ).toBe("work");
  });

  it("uses the existing selected-option match for an actual synonymous decision source", () => {
    const work = candidate("work", "辞职");
    work.decision.authority = "delegated";
    work.decision.decidedBy = "character";
    const message = {
      ...source("work-source", "我的决定：离开当前这份工作。"),
      role: "assistant" as const,
    };
    expect(
      select("回头看这个选择，我很庆幸。", "reflection", [work], {
        recentMessages: [message],
      })?.decision.id,
    ).toBe("work");
  });

  it("uses a unique actual recent action for an already identified branch's explicit result frame", () => {
    const work = candidate("work", "接受副主编岗位");
    work.dilemma!.options[0]!.description =
      "副主编岗位提供稳定收入和可预测的作息";
    work.actions = [action(work, "我已经签了副主编合同。")];
    const text =
      "几天后的结果是：收入和作息稳定了，但能留给个人创作的时间明显变少。";
    const recentMessages = [
      source("work-action-source", work.actions[0]!.summary),
    ];
    expect(
      select(text, "outcome", [work], { recentMessages })?.actionIds,
    ).toEqual(["work-action"]);
    expect(select(text, "outcome", [work])?.actionIds).toEqual([]);
    const { walk } = branches();
    expect(
      select(text, "outcome", [walk], {
        recentMessages: [
          source("walk-action-source", walk.actions[0]!.summary),
        ],
      }),
    ).toBeUndefined();
  });

  it("retains a source-backed predecessor when an identified matter has a result days later", () => {
    const work = candidate("work", "接受副主编岗位", "current", OLD);
    work.dilemma!.options[0]!.description =
      "副主编岗位提供稳定收入和可预测的作息";
    work.actions = [action(work, "我已经签了副主编合同。")];
    const text =
      "几天后的结果是：收入和作息稳定了，但能留给个人创作的时间明显变少。";
    const recentMessages = [
      source("work-action-source", work.actions[0]!.summary, OLD),
    ];
    expect(
      select(text, "outcome", [work], { recentMessages })?.actionIds,
    ).toEqual(["work-action"]);
    expect(select(text, "outcome", [work])?.actionIds).toEqual([]);
    expect(
      select(text, "outcome", [work], {
        recentMessages: [
          source("work-action-source", "我打算签副主编合同。", OLD),
        ],
      })?.actionIds,
    ).toEqual([]);
    expect(
      select("这个决定带来的结果让我轻松多了。", "outcome", [work], {
        recentMessages,
      }),
    ).toBeUndefined();
  });

  it("resolves overlapping consequence terms only with one currently evidenced predecessor", () => {
    const oldWork = candidate("old-work", "去异地影像公司", "earlier", OLD);
    oldWork.dilemma!.options[0]!.description = "收入低一些，只有一年合同。";
    oldWork.actions = [action(oldWork, "我已经给异地影像公司发出接受邮件。")];
    const work = candidate("work", "接受副主编岗位", "current", OLD);
    work.dilemma!.options[0]!.description =
      "用更稳定的收入与作息支撑未来一年。";
    work.actions = [action(work, "我今天已经签了副主编合同。")];
    const text =
      "几天后的结果是：收入和作息稳定了，但能留给个人创作的时间明显变少。这是混合结果。";
    const recentMessages = [
      source("work-action-source", work.actions[0]!.summary, OLD),
    ];
    expect(
      select(text, "outcome", [oldWork, work], { recentMessages }),
    ).toMatchObject({
      decision: { id: "work" },
      actionIds: ["work-action"],
    });
    expect(select(text, "outcome", [oldWork, work])).toBeUndefined();
    oldWork.decision.sessionId = "current";
    oldWork.actions[0]!.sessionId = "current";
    expect(
      select(text, "outcome", [oldWork, work], {
        recentMessages: [
          ...recentMessages,
          source("old-work-action-source", oldWork.actions[0]!.summary, OLD),
        ],
      }),
    ).toBeUndefined();
  });

  it("links a topically grounded personal reflection to its uniquely source-backed earlier outcome", () => {
    const work = candidate("work", "接受纪录片研究岗位", "current", OLD);
    work.dilemma!.options[0]!.description =
      "纪录片研究更接近创作，但要承担不确定性。";
    work.outcomes = [outcome(work, "后来公司同意了我的纪录片研究申请。")];
    const text =
      "我现在的理解是：真正改变我的不只是选项，而是我第一次承认自己愿意为创作承担一些不确定性。";
    const recentMessages = [
      source("work-outcome-source", work.outcomes[0]!.summary, OLD),
    ];
    expect(
      select(text, "reflection", [work], { recentMessages }),
    ).toMatchObject({
      decision: { id: "work" },
      outcomeId: "work-outcome",
    });
    expect(select(text, "reflection", [work])?.outcomeId).toBeUndefined();
    expect(
      select(text, "reflection", [work], {
        recentMessages: [{ ...recentMessages[0]!, sessionId: "other" }],
      })?.outcomeId,
    ).toBeUndefined();
    expect(
      select(text, "reflection", [work], {
        recentMessages: [
          ...recentMessages,
          ...Array.from({ length: 8 }, (_, index) =>
            source(`later-${index}`, "天气很好。"),
          ),
        ],
      })?.outcomeId,
    ).toBeUndefined();
    work.outcomes = [
      ...work.outcomes,
      outcome(work, "后来公司同意了我的纪录片研究补充申请。", "second-outcome"),
    ];
    expect(
      select(text, "reflection", [work], {
        recentMessages: [
          ...recentMessages,
          source("second-outcome-source", work.outcomes[1]!.summary, OLD),
        ],
      })?.outcomeId,
    ).toBeUndefined();
  });

  it("does not choose between multiple older source-backed result predecessors", () => {
    const work = candidate("work", "接受副主编岗位", "current", OLD);
    work.dilemma!.options[0]!.description =
      "副主编岗位提供稳定收入和可预测的作息";
    work.actions = [
      action(work, "我已经签了副主编合同。", "contract-action"),
      action(work, "我已经提交了副主编入职申请。", "application-action"),
    ];
    expect(
      select("几天后的结果是：收入和作息稳定了。", "outcome", [work], {
        recentMessages: work.actions.map((item) =>
          source(item.sourceEvidenceIds[0]!, item.summary, OLD),
        ),
      })?.actionIds,
    ).toEqual([]);
  });

  it("associates a completed coordinated launch with its selected project", () => {
    const project = candidate("project", "启动独立影像项目");
    const clauses = collectLifeAssociationEvidence(
      analyzeLifeEvidence("我今天已经拒绝副主编合同，并和伙伴确认启动项目。"),
      "action",
    );
    const results = clauses.map((clause) =>
      selectLifeEvidenceAssociation({
        stage: "action",
        clause,
        candidates: [project],
        sessionId: "current",
        atUtc: NOW,
      }),
    );
    expect(clauses).toHaveLength(2);
    expect(results[0]).toBeUndefined();
    expect(results[1]?.decision.id).toBe("project");
    expect(
      collectLifeAssociationEvidence(
        analyzeLifeEvidence(clauses[1]!.sourceText),
        "action",
      )[1],
    ).toEqual(clauses[1]);
  });

  it("does not guess an action for a result frame with multiple equally grounded recent steps", () => {
    const work = candidate("work", "接受副主编岗位");
    work.dilemma!.options[0]!.description =
      "副主编岗位提供稳定收入和可预测的作息";
    work.actions = [
      action(work, "我已经签了副主编合同。", "contract-action"),
      action(work, "我已经提交了副主编入职申请。", "application-action"),
    ];
    const text =
      "几天后的结果是：收入和作息稳定了，但能留给个人创作的时间明显变少。";
    const recentMessages = work.actions.map((item) =>
      source(item.sourceEvidenceIds[0]!, item.summary),
    );
    expect(
      select(text, "outcome", [work], { recentMessages })?.actionIds,
    ).toEqual([]);
  });

  it("allows a generic result only after a real recent action source", () => {
    const { walk } = branches();
    const result = select(genericOutcome, "outcome", [walk], {
      recentMessages: [source("walk-action-source", "我已经散步二十分钟了。")],
    });
    expect(result?.decision.id).toBe("walk");
    expect(result?.actionIds).toEqual(["walk-action"]);
  });

  it("allows a bounded external reply only after a unique actual request or application", () => {
    const work = candidate("work", "辞职");
    work.actions = [action(work, "我已经提交了辞职申请。")];
    expect(
      select("后来公司同意了。", "outcome", [work], {
        recentMessages: [
          source("work-action-source", work.actions[0]!.summary),
        ],
      })?.decision.id,
    ).toBe("work");
    const { walk } = branches();
    expect(
      select("后来公司同意了。", "outcome", [walk], {
        recentMessages: [
          source("walk-action-source", walk.actions[0]!.summary),
        ],
      }),
    ).toBeUndefined();
    expect(select("后来公司同意了。", "outcome", [work])).toBeUndefined();
  });

  it.each([
    ["missing", []],
    ["unlinked", [source("unlinked", "我已经散步二十分钟了。")]],
    ["stale", [source("walk-action-source", "我已经散步二十分钟了。", OLD)]],
    [
      "future",
      [
        source(
          "walk-action-source",
          "我已经散步二十分钟了。",
          "2026-09-06T08:00:00.000Z",
        ),
      ],
    ],
    ["unrelated", [source("walk-action-source", "我已经提交了外包申请。")]],
    ["planned", [source("walk-action-source", "我明天打算散步二十分钟。")]],
    ["negated", [source("walk-action-source", "我并没有散步二十分钟。")]],
    [
      "third party",
      [source("walk-action-source", "我朋友已经散步二十分钟了。")],
    ],
    [
      "other session",
      [
        {
          ...source("walk-action-source", "我已经散步二十分钟了。"),
          sessionId: "other",
        },
      ],
    ],
    [
      "other agent",
      [
        {
          ...source("walk-action-source", "我已经散步二十分钟了。"),
          agentId: "other",
        },
      ],
    ],
  ] as const)(
    "rejects a generic result with %s source evidence",
    (_name, recentMessages) => {
      const { walk } = branches();
      expect(
        select(genericOutcome, "outcome", [walk], { recentMessages }),
      ).toBeUndefined();
    },
  );

  it("does not revive a source pushed out of the latest eight messages", () => {
    const { walk } = branches();
    const recentMessages = [
      source("walk-action-source", "我已经散步二十分钟了。"),
      ...Array.from({ length: 8 }, (_, index) =>
        source(
          `later-${index}`,
          "今天的天气还好。",
          `2026-09-05T07:30:0${index}.000Z`,
        ),
      ),
    ];
    expect(
      select(genericOutcome, "outcome", [walk], { recentMessages }),
    ).toBeUndefined();
  });

  it("does not guess a generic result when two branches have valid recent sources", () => {
    const { walk } = branches();
    const work = candidate("work", "接受外包项目");
    work.actions = [action(work, "我已经提交了外包项目申请。")];
    expect(
      select(genericOutcome, "outcome", [work, walk], {
        recentMessages: [
          source("walk-action-source", walk.actions[0]!.summary),
          source("work-action-source", work.actions[0]!.summary),
        ],
      }),
    ).toBeUndefined();
  });

  it("does not take a new explicitly named matter as a generic reference", () => {
    const { walk } = branches();
    expect(
      select(
        "这个决定带来的结果是：后来公司拒绝了我的外包申请。",
        "outcome",
        [walk],
        {
          recentMessages: [
            source("walk-action-source", walk.actions[0]!.summary),
          ],
        },
      ),
    ).toBeUndefined();
  });

  it("requires an actual result source for a reference to that result", () => {
    const { walk } = branches();
    const text = "回头看这个结果，我后悔了。";
    expect(
      select(text, "reflection", [walk], {
        recentMessages: [
          source("walk-action-source", walk.actions[0]!.summary),
        ],
      }),
    ).toBeUndefined();
    expect(
      select(text, "reflection", [walk], {
        recentMessages: [
          source("walk-outcome-source", walk.outcomes[0]!.summary),
        ],
      })?.outcomeId,
    ).toBe("walk-outcome");
  });
});

describe("stage-specific evidence clauses", () => {
  it("keeps a result's same-subject benefit and explicit mixed declaration across a semicolon", () => {
    const text =
      "几天后的结果是：我们拿到第一个小客户，但现金流很不稳定；我重新感到有创作动力。这是混合结果。";
    const clauses = collectLifeAssociationEvidence(
      analyzeLifeEvidence(text),
      "outcome",
    );
    expect(clauses).toHaveLength(1);
    expect(clauses[0]!.sourceText).toContain("现金流很不稳定");
    expect(clauses[0]!.sourceText).toContain("重新感到有创作动力");
    expect(clauses[0]!.valence).toBe("mixed");
    const project = candidate("project", "启动独立影像项目", "current", OLD);
    project.dilemma!.options[0]!.description = "和朋友承担项目与创作自主权";
    project.dilemma!.options[0]!.likelyTradeoffs = [
      "现金流和项目连续性更不确定",
    ];
    project.actions = [action(project, "我已经确认启动独立影像项目。")];
    const associated = select(text, "outcome", [project], {
      recentMessages: [
        source("project-action-source", project.actions[0]!.summary, OLD),
      ],
    });
    expect(associated?.decision.id).toBe("project");
    expect(associated?.actionIds).toEqual(["project-action"]);
    project.outcomes = [outcome(project, clauses[0]!.sourceText)];
    expect(
      select(
        "回头看，我仍认可选择独立项目，但我低估了现金流压力。",
        "reflection",
        [project],
      )?.outcomeId,
    ).toBe("project-outcome");
  });

  it("does not absorb a different or non-actual event into an explicit result", () => {
    const project = candidate("project", "启动独立影像项目");
    project.dilemma!.options[0]!.likelyTradeoffs = ["现金流不确定"];
    const text = "几天后的结果是：现金流不稳定；我明天可能重新感到有创作动力。";
    const clauses = collectLifeAssociationEvidence(
      analyzeLifeEvidence(text),
      "outcome",
    );
    expect(clauses).toHaveLength(1);
    expect(clauses[0]!.sourceText).not.toContain("明天");
    expect(clauses[0]!.valence).toBe("negative");
    expect(
      select("散步回来我轻松多了。", "outcome", [project]),
    ).toBeUndefined();
  });

  it("preserves a result heading and its asserted same-sentence consequences", () => {
    const text =
      "几天后的结果是：收入和作息稳定了，但能留给个人创作的时间明显变少。";
    const clauses = collectLifeAssociationEvidence(
      analyzeLifeEvidence(text),
      "outcome",
    );
    expect(clauses).toHaveLength(1);
    expect(clauses[0]!.classifyText).toContain("收入和作息稳定了");
    expect(clauses[0]!.classifyText).toContain("个人创作");
    expect(clauses[0]!.valence).toBe("mixed");
  });

  it("keeps an actual departure's same-sentence purpose without claiming the intended task is complete", () => {
    const text = "去办副主编岗位的入职手续，我刚换好鞋出门了。";
    const clauses = collectLifeAssociationEvidence(
      analyzeLifeEvidence(text),
      "action",
    );
    expect(clauses).toHaveLength(1);
    expect(clauses[0]!.classifyText).toContain("去办副主编岗位");
    expect(clauses[0]!.actionKind).toBe("initiated");
    expect(
      select(text, "action", [candidate("work", "接受副主编岗位")])?.decision
        .id,
    ).toBe("work");
  });

  it("retains a departure's purpose after persistence and predecessor reanalysis", () => {
    const text = "去办副主编岗位的入职手续，我刚换好鞋出门了。";
    const first = evidence(text, "action");
    const second = evidence(first.sourceText, "action");
    expect(second.sourceText).toBe(first.sourceText);
    expect(second.classifyText).toContain("副主编岗位");
    const work = candidate("work", "接受副主编岗位");
    work.actions = [action(work, first.sourceText)];
    expect(
      select("后来我拿到了副主编岗位。", "outcome", [work])?.actionIds,
    ).toEqual(["work-action"]);
  });

  it("keeps a result's attached cost and explicit mixed valence", () => {
    const text = "后来我拿到了副主编岗位，但收入比原来少，这是混合结果。";
    const clauses = collectLifeAssociationEvidence(
      analyzeLifeEvidence(text),
      "outcome",
    );
    expect(clauses).toHaveLength(1);
    expect(clauses[0]!.classifyText).toContain("收入比原来少");
    expect(clauses[0]!.valence).toBe("mixed");
  });

  it("keeps an actual reflection's quoted source inert while preserving its source text", () => {
    const text = "回头看，我仍认同这个决定，‘我后悔了’不是我的感受。";
    const clauses = collectLifeAssociationEvidence(
      analyzeLifeEvidence(text),
      "reflection",
    );
    expect(clauses).toHaveLength(1);
    expect(clauses[0]!.sourceText).toContain("‘我后悔了’");
    expect(clauses[0]!.classifyText).not.toContain("我后悔了");
    const walk = candidate("walk", "散步二十分钟");
    expect(
      select(text, "reflection", [walk], {
        recentMessages: [source("walk-source", "我决定散步二十分钟。")],
      })?.decision.id,
    ).toBe("walk");
  });

  it("keeps a reflection's asserted same-sentence reason for matching a concrete outcome", () => {
    const character = candidate("character", "保留克制结尾");
    character.decision.subject = "character";
    character.dilemma!.options[0]!.description =
      "保留克制结尾，保护被摄者的尊严";
    character.outcomes = [
      outcome(
        character,
        "后来你成功保住了被摄者的信任，但合作方担心市场吸引力，这是混合结果。",
      ),
    ];
    const text =
      "我仍认同保留克制结尾，因为被摄者的尊严比制造冲突更重要；但合作方对市场吸引力的担心是真实代价，我不会把这次选择说成只要坚持自我就一定成功。";
    const clause = evidence(text, "reflection");
    expect(clause.classifyText).toContain("因为被摄者");
    expect(
      select(text, "reflection", [character], { subject: "character" })
        ?.outcomeId,
    ).toBe("character-outcome");
  });

  it("preserves an explicit reflection topic with its first-person stance", () => {
    const clauses = collectLifeAssociationEvidence(
      analyzeLifeEvidence("回头看外包项目的决定，我后悔了。"),
      "reflection",
    );
    expect(clauses).toHaveLength(1);
    expect(clauses[0]!.classifyText).toContain("外包项目");
    expect(clauses[0]!.classifyText).toContain("我后悔了");
    expect(clauses[0]!.subject).toBe("user");
  });

  it.each([
    "几天后的结果是：我明天打算提交外包项目申请。",
    "几天后的结果是：如果外包项目成功就好了。",
    "几天后的结果是：我没有提交外包项目申请。",
    "几天后的结果是。我已经提交了外包项目申请。",
    "几天后的结果是；我已经提交了外包项目申请。",
  ])(
    "never absorbs a different or non-actual event into a heading: %s",
    (text) => {
      const clauses = collectLifeAssociationEvidence(
        analyzeLifeEvidence(text),
        "outcome",
      );
      expect(
        clauses.every((clause) => !clause.classifyText.includes("外包")),
      ).toBe(true);
    },
  );

  it("does not mutate the analyzer's clauses", () => {
    const analysis = analyzeLifeEvidence("回头看外包项目的决定，我后悔了。");
    const original = JSON.stringify(analysis);
    collectLifeAssociationEvidence(analysis, "reflection");
    expect(JSON.stringify(analysis)).toBe(original);
  });
});
