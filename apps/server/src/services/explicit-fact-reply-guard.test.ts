import { describe, expect, it } from "vitest";

import {
  RetrievalReplayInputSchema,
  type CreateRetrievalRunInput,
  type RetrievalReplayInput,
} from "../repositories/retrieval-run-repository.js";
import {
  applyExplicitFactReplyGuard,
  buildExplicitFactReplyContract,
  decodeExplicitFactReplyValue,
  explicitFactAbstentionReason,
  finalizeExplicitFactWorld,
  type ExplicitFactReplyContract,
} from "./explicit-fact-reply-guard.js";
import type { ResolvedTurn } from "./turn-decision-service.js";
import type { PreparedWorldEffectTurn } from "./world-effect-service.js";

const QUERY =
  "周末去暗房前，替我核对两件旧事：我喝茶的习惯，和那只铁盒的标签。只答事实，不解释它们象征什么。";
const SAFE_REPLY = "饮品记录：红茶（不加糖）；铁盒标签：1998 / 潮声。";

describe("explicit fact reply guard", () => {
  it("builds one ordered reply from the selected frozen facts", () => {
    const contract = buildExplicitFactReplyContract({
      userText: QUERY,
      recall: selectedRecall(),
    });

    expect(contract).toMatchObject({
      kind: "selected",
      expectedFacetCount: 2,
      selectedMemoryIds: ["memory-tea", "memory-box"],
      selectedEvidenceIds: ["evidence-tea", "evidence-box"],
      replyText: SAFE_REPLY,
      facts: [
        {
          index: 0,
          memoryId: "memory-tea",
          evidenceIds: ["evidence-tea"],
          value: {
            kind: "beverage_preference",
            valueKey: "affirmed:black_tea:unspecified:unsweetened",
          },
        },
        {
          index: 1,
          memoryId: "memory-box",
          evidenceIds: ["evidence-box"],
          value: {
            kind: "entity_inscription",
            valueKey: "entity_inscription:铁盒:1998/潮声",
          },
        },
      ],
    });
  });

  it("allows one selected memory and evidence source to cover both facets", () => {
    const recall = selectedRecall();
    const combinedContent =
      "用户喝不加糖的红茶。用户的铁盒标签写着“1998 / 潮声”。";
    const combinedQuote = "我喝不加糖的红茶。我的铁盒标签写着“1998 / 潮声”。";
    recall.result.selectedMemoryIds = ["memory-combined"];
    recall.result.selectedEvidenceIds = ["evidence-combined"];
    if (recall.result.abstained) throw new Error("Expected selected recall");
    recall.result.evidenceBundle.evidence = [
      {
        ...recall.result.evidenceBundle.evidence[0]!,
        memoryId: "memory-combined",
        memoryContent: combinedContent,
        evidence: {
          ...recall.result.evidenceBundle.evidence[0]!.evidence,
          id: "evidence-combined",
          memoryId: "memory-combined",
          quote: combinedQuote,
        },
      },
    ];
    const audit = recall.inputSnapshot.hierarchy!.selectorAudit!;
    audit.replayEvidenceIds = ["evidence-combined"];
    const selectedAttempt = audit.attempts.find(
      (attempt) => attempt.outcome === "selected",
    )!;
    selectedAttempt.scannedCandidateCount = 1;
    for (const facet of selectedAttempt.facets) {
      facet.candidates = [
        {
          memoryId: "memory-combined",
          decision: "selected",
          reasonCode: "fact_candidate_selected",
          valueGroupId: "value_1",
          evidence: [
            {
              evidenceId: "evidence-combined",
              decision: "accepted",
              reasonCode: "fact_evidence_accepted",
            },
          ],
        },
      ];
    }
    const combinedMemory = frozenMemory({
      id: "memory-combined",
      content: combinedContent,
    });
    const combinedEvidence = frozenEvidence({
      memoryId: "memory-combined",
      evidenceId: "evidence-combined",
      quote: combinedQuote,
    });
    recall.inputSnapshot.memories = [combinedMemory];
    recall.inputSnapshot.evidence = [combinedEvidence];
    recall.inputSnapshot.hierarchy!.candidateTiers = [
      { memoryId: "memory-combined", tier: "basic_memory" },
    ];
    recall.inputSnapshot.selectorAuditInput = {
      memories: [combinedMemory],
      evidence: [combinedEvidence],
      candidateTiers: [{ memoryId: "memory-combined", tier: "basic_memory" }],
    };

    expect(
      buildExplicitFactReplyContract({ userText: QUERY, recall }),
    ).toMatchObject({
      kind: "selected",
      selectedMemoryIds: ["memory-combined"],
      selectedEvidenceIds: ["evidence-combined"],
      replyText: SAFE_REPLY,
    });
  });

  it("turns a valid incomplete selector result into a value-free whole refusal", () => {
    expect(
      buildExplicitFactReplyContract({
        userText: QUERY,
        recall: incompleteRecall(),
      }),
    ).toEqual({
      kind: "abstain",
      policy: "explicit_fact_checklist_v1",
      expectedFacetCount: 2,
      reasonCode: "requested_fact_facets_incomplete",
      replyText: "现有可靠事实不足以完整核对这两项。",
    });
  });

  it.each([
    ["incomplete", "requested_fact_facets_incomplete"],
    ["conflicted", "requested_fact_facets_conflicted"],
    ["below_threshold", "requested_fact_below_caller_threshold"],
    ["capacity_insufficient", "requested_fact_evidence_capacity_insufficient"],
    ["scan_truncated", "requested_fact_scan_truncated"],
  ] as const)(
    "maps %s to the public whole-refusal reason",
    (outcome, reason) => {
      expect(explicitFactAbstentionReason(outcome)).toBe(reason);
    },
  );

  it("fails closed when selector and result abstention reasons disagree", () => {
    const recall = incompleteRecall();
    if (!recall.result.abstained) throw new Error("Expected abstained recall");
    recall.result.abstentionReason = "requested_fact_facets_conflicted";

    expect(buildExplicitFactReplyContract({ userText: QUERY, recall })).toEqual(
      {
        kind: "abstain",
        policy: "explicit_fact_checklist_v1",
        expectedFacetCount: 2,
        reasonCode: "requested_fact_reply_contract_invalid",
        replyText: "现有可靠事实不足以完整核对这两项。",
      },
    );
  });

  it("fails the whole contract closed when frozen evidence disagrees with memory", () => {
    const recall = selectedRecall();
    if (recall.result.abstained) throw new Error("Expected selected recall");
    recall.result.evidenceBundle.evidence[0]!.evidence.quote =
      "我喝加糖的绿茶。";

    expect(
      buildExplicitFactReplyContract({ userText: QUERY, recall }),
    ).toMatchObject({
      kind: "abstain",
      reasonCode: "requested_fact_reply_contract_invalid",
      replyText: "现有可靠事实不足以完整核对这两项。",
    });
  });

  it("fails closed when a self-consistent result disagrees with the frozen selector corpus", () => {
    const recall = selectedRecall();
    if (recall.result.abstained) throw new Error("Expected selected recall");
    recall.result.evidenceBundle.evidence[0] = evidenceItem({
      memoryId: "memory-tea",
      evidenceId: "evidence-tea",
      memoryContent: "用户喝不加糖的绿茶。",
      quote: "我喝不加糖的绿茶。",
    });

    expect(
      buildExplicitFactReplyContract({ userText: QUERY, recall }),
    ).toMatchObject({
      kind: "abstain",
      reasonCode: "requested_fact_reply_contract_invalid",
    });
  });

  it("fails closed when replay and selector evidence sources diverge", () => {
    const recall = selectedRecall();
    recall.inputSnapshot.selectorAuditInput!.evidence[0] = {
      ...recall.inputSnapshot.selectorAuditInput!.evidence[0]!,
      sourceId: "message-other-source",
    };

    expect(
      buildExplicitFactReplyContract({ userText: QUERY, recall }),
    ).toMatchObject({
      kind: "abstain",
      reasonCode: "requested_fact_reply_contract_invalid",
    });
  });

  it("does not claim that unsupported generic checklists belong to this policy", () => {
    expect(
      buildExplicitFactReplyContract({
        userText: "替我核对两件旧事：护照号码，和公司的门禁码。只答事实。",
      }),
    ).toBeUndefined();
    expect(
      buildExplicitFactReplyContract({
        userText: "替我核对两件旧事：我喝茶的习惯。",
      }),
    ).toEqual({
      kind: "abstain",
      policy: "explicit_fact_checklist_v1",
      reasonCode: "requested_fact_request_invalid",
      replyText: "现有可靠事实不足以完整核对这些项目。",
    });
  });

  it("replaces the reply and blocks every model-owned mutation surface", () => {
    const contract = selectedContract();
    const guarded = applyExplicitFactReplyGuard({
      turn: unsafeTurn(),
      contract,
      inspectDecision: () => ({
        validation: { accepted: [], rejections: [] },
        issues: [],
      }),
    });

    expect(guarded.decision).toEqual({
      reply: {
        text: SAFE_REPLY,
        chunks: [SAFE_REPLY],
        toneTags: ["事实核对"],
      },
      scheduleEffects: [],
      memoryCandidates: [],
      personalIntentCandidates: [],
      reasonCode: "explicit_fact_reply_guard_selected",
      reasonSummary: "依据本轮冻结且完整通过证据校验的事实分面生成原子化答复。",
    });
    expect(guarded.scheduleAction).toEqual({ kind: "none" });
    expect(guarded).not.toHaveProperty("continuityEffects");
    expect(guarded.worldEffectsAudit?.validation.effects).toEqual({
      memoryCandidates: [],
      personalIntentCandidates: [],
    });
    expect(
      guarded.worldEffectsAudit?.validation.rejections.map(
        (rejection) => rejection.reasonCode,
      ),
    ).toEqual([
      "explicit_fact_reply_guard_blocked",
      "explicit_fact_reply_guard_blocked",
      "explicit_fact_reply_guard_blocked",
      "explicit_fact_reply_guard_blocked",
    ]);
    expect(guarded.modelRejections.at(-1)).toMatchObject({
      reasonCode: "explicit_fact_reply_guard_blocked",
      raw: {
        scheduleEffectCount: 1,
        hasStateDelta: true,
        hasRelationshipDelta: true,
        memoryCandidateCount: 1,
        personalIntentCandidateCount: 1,
        hasContinuityEffects: true,
        scheduleActionKind: "request_details",
      },
    });
    expect(guarded.explicitFactReplyGuardAudit).toMatchObject({
      outcome: "selected",
      selectedMemoryIds: ["memory-tea", "memory-box"],
      selectedEvidenceIds: ["evidence-tea", "evidence-box"],
      serverGuardApplied: true,
      modelReplyContentChanged: true,
      modelSideEffectsBlocked: true,
      modelRepairAttempted: true,
      modelGenerationFallbackUsed: false,
      contentDerivedSemanticsSkipped: true,
    });
    expect(guarded.usedFallback).toBe(false);
    expect(guarded.explicitFactReplyGuardAudit?.finalTextSha256).toMatch(
      /^[a-f0-9]{64}$/u,
    );
  });

  it("preserves an upstream model fallback in the guard audit", () => {
    const turn = unsafeTurn();
    turn.usedFallback = true;

    const guarded = applyExplicitFactReplyGuard({
      turn,
      contract: selectedContract(),
      inspectDecision: () => ({
        validation: { accepted: [], rejections: [] },
        issues: [],
      }),
    });

    expect(guarded.usedFallback).toBe(true);
    expect(guarded.explicitFactReplyGuardAudit).toMatchObject({
      modelGenerationFallbackUsed: true,
      serverGuardApplied: true,
    });
  });

  it("rejects an unsafe post-world state instead of committing it", () => {
    const guarded = applyExplicitFactReplyGuard({
      turn: unsafeTurn(),
      contract: selectedContract(),
      inspectDecision: () => ({
        validation: { accepted: [], rejections: [] },
        issues: [],
      }),
    });
    const world = preparedWorld(guarded);
    world.validation.accepted.push({ operation: "create" } as never);

    expect(() =>
      finalizeExplicitFactWorld({
        world,
        contract: selectedContract(),
      }),
    ).toThrow(/cannot commit semantic or schedule effects/u);
  });

  it("reasserts the atomic reply after downstream reply mutation", () => {
    const contract = selectedContract();
    const guarded = applyExplicitFactReplyGuard({
      turn: unsafeTurn(),
      contract,
      inspectDecision: () => ({
        validation: { accepted: [], rejections: [] },
        issues: [],
      }),
    });
    const world = preparedWorld(guarded);
    world.decision = {
      ...world.decision,
      reply: {
        text: "只泄漏第一项。",
        chunks: ["只泄漏第一项。", "稍后再说。"],
        toneTags: ["猜测"],
      },
    };

    const finalized = finalizeExplicitFactWorld({ world, contract });

    expect(finalized.decision.reply).toEqual({
      text: SAFE_REPLY,
      chunks: [SAFE_REPLY],
      toneTags: ["事实核对"],
    });
  });

  it.each(["decision_state", "accepted_relationship"] as const)(
    "rejects a post-world %s semantic effect",
    (surface) => {
      const contract = selectedContract();
      const guarded = applyExplicitFactReplyGuard({
        turn: unsafeTurn(),
        contract,
        inspectDecision: () => ({
          validation: { accepted: [], rejections: [] },
          issues: [],
        }),
      });
      const world = preparedWorld(guarded);
      if (surface === "decision_state") {
        world.decision = { ...world.decision, stateDelta: { stress: -0.1 } };
      } else {
        world.effectTrace.accepted.relationshipDelta = { trust: 0.1 };
      }

      expect(() => finalizeExplicitFactWorld({ world, contract })).toThrow(
        /cannot commit semantic or schedule effects/u,
      );
    },
  );

  it("rejects unknown value-key enums instead of inventing display text", () => {
    expect(
      decodeExplicitFactReplyValue({
        facet: {
          kind: "beverage_preference",
          selector: { scope: "family", family: "tea" },
        },
        valueKey: "affirmed:unknown_tea:unspecified:unsweetened",
      }),
    ).toBeUndefined();
  });

  it("does not strengthen a negative preference into a non-consumption claim", () => {
    expect(
      decodeExplicitFactReplyValue({
        facet: {
          kind: "beverage_preference",
          selector: { scope: "family", family: "tea" },
        },
        valueKey: "negative:black_tea:unspecified:unspecified",
      }),
    ).toBeUndefined();
  });
});

function selectedContract(): Extract<
  ExplicitFactReplyContract,
  { kind: "selected" }
> {
  const contract = buildExplicitFactReplyContract({
    userText: QUERY,
    recall: selectedRecall(),
  });
  if (contract?.kind !== "selected") {
    throw new Error("Expected selected explicit-fact contract");
  }
  return contract;
}

function selectedRecall(): Pick<
  CreateRetrievalRunInput,
  "inputSnapshot" | "result"
> {
  const teaMemory = frozenMemory({
    id: "memory-tea",
    content: "用户喝不加糖的红茶。",
  });
  const boxMemory = frozenMemory({
    id: "memory-box",
    content: "用户的铁盒标签写着“1998 / 潮声”。",
  });
  const teaEvidence = frozenEvidence({
    memoryId: "memory-tea",
    evidenceId: "evidence-tea",
    quote: "我喝不加糖的红茶。",
  });
  const boxEvidence = frozenEvidence({
    memoryId: "memory-box",
    evidenceId: "evidence-box",
    quote: "我的铁盒标签写着“1998 / 潮声”。",
  });
  const candidateTiers = [
    { memoryId: "memory-tea", tier: "basic_memory" as const },
    { memoryId: "memory-box", tier: "basic_memory" as const },
  ];
  const recall = {
    result: {
      mode: "basic_memory",
      selectedMemoryIds: ["memory-tea", "memory-box"],
      selectedEvidenceIds: ["evidence-tea", "evidence-box"],
      score: 0.9,
      abstained: false,
      evidenceBundle: {
        query: QUERY,
        mode: "basic_memory",
        generatedAtUtc: "2026-10-12T10:00:00.000Z",
        score: 0.9,
        evidence: [
          evidenceItem({
            memoryId: "memory-tea",
            evidenceId: "evidence-tea",
            memoryContent: "用户喝不加糖的红茶。",
            quote: "我喝不加糖的红茶。",
          }),
          evidenceItem({
            memoryId: "memory-box",
            evidenceId: "evidence-box",
            memoryContent: "用户的铁盒标签写着“1998 / 潮声”。",
            quote: "我的铁盒标签写着“1998 / 潮声”。",
          }),
        ],
      },
    },
    inputSnapshot: {
      agentId: "agent-test",
      query: { query: QUERY },
      nowUtc: "2026-10-12T10:00:00.000Z",
      memories: [teaMemory, boxMemory],
      evidence: [teaEvidence, boxEvidence],
      minimumScore: 0.2,
      maxEvidence: 3,
      candidateLimit: 200,
      strategyVersion: "continuity_hierarchy_v1",
      hierarchy: {
        finalTier: "basic_memory",
        candidateTiers,
        temporalResolution: {},
        selectorAudit: {
          policy: "explicit_fact_checklist_v1",
          expectedFacetCount: 2,
          outcome: "selected",
          scanLimit: 500,
          scanTruncated: false,
          replayEvidenceIds: ["evidence-tea", "evidence-box"],
          attempts: [
            emptyEventCardAttempt(),
            {
              tier: "basic_memory",
              outcome: "selected",
              scannedCandidateCount: 2,
              facets: [
                selectedFacet({
                  index: 0,
                  kind: "beverage_preference",
                  request: {
                    kind: "beverage_preference",
                    selector: { scope: "family", family: "tea" },
                  },
                  memoryId: "memory-tea",
                  evidenceId: "evidence-tea",
                  otherMemoryId: "memory-box",
                }),
                selectedFacet({
                  index: 1,
                  kind: "entity_inscription",
                  request: { kind: "entity_inscription", entity: "铁盒" },
                  memoryId: "memory-box",
                  evidenceId: "evidence-box",
                  otherMemoryId: "memory-tea",
                }),
              ],
            },
          ],
        },
      },
      selectorAuditInput: {
        memories: [teaMemory, boxMemory],
        evidence: [teaEvidence, boxEvidence],
        candidateTiers,
      },
    },
  } as Pick<CreateRetrievalRunInput, "inputSnapshot" | "result">;
  assertValidReplaySnapshot(recall.inputSnapshot);
  return recall;
}

function incompleteRecall(): Pick<
  CreateRetrievalRunInput,
  "inputSnapshot" | "result"
> {
  const recall = selectedRecall();
  const selectorInput = recall.inputSnapshot.selectorAuditInput!;
  const teaMemory = selectorInput.memories.find(
    (memory) => memory.id === "memory-tea",
  )!;
  const teaEvidence = selectorInput.evidence.find(
    (evidence) => evidence.id === "evidence-tea",
  )!;
  recall.inputSnapshot.memories = [teaMemory];
  recall.inputSnapshot.evidence = [];
  recall.inputSnapshot.hierarchy!.finalTier = "none";
  recall.inputSnapshot.hierarchy!.candidateTiers = [
    { memoryId: "memory-tea", tier: "basic_memory" },
  ];
  recall.inputSnapshot.hierarchy!.abstentionReason =
    "requested_fact_facets_incomplete";
  recall.inputSnapshot.hierarchy!.abstentionScore = 0;
  const audit = recall.inputSnapshot.hierarchy!.selectorAudit!;
  audit.outcome = "incomplete";
  audit.replayEvidenceIds = [];
  audit.attempts = [
    emptyEventCardAttempt(),
    {
      tier: "basic_memory",
      outcome: "incomplete",
      scannedCandidateCount: 1,
      facets: [
        {
          index: 0,
          kind: "beverage_preference",
          request: {
            kind: "beverage_preference",
            selector: { scope: "family", family: "tea" },
          },
          outcome: "selected",
          candidates: [
            {
              memoryId: "memory-tea",
              decision: "rejected",
              reasonCode: "fact_candidate_lower_ranked",
              valueGroupId: "value_1",
              evidence: [
                {
                  evidenceId: "evidence-tea",
                  decision: "accepted",
                  reasonCode: "fact_evidence_accepted",
                },
              ],
            },
          ],
        },
        {
          index: 1,
          kind: "entity_inscription",
          request: { kind: "entity_inscription", entity: "铁盒" },
          outcome: "missing",
          candidates: [
            {
              memoryId: "memory-tea",
              decision: "rejected",
              reasonCode: "fact_candidate_value_unparseable",
              evidence: [],
            },
          ],
        },
      ],
    },
  ];
  recall.inputSnapshot.selectorAuditInput = {
    memories: [teaMemory],
    evidence: [teaEvidence],
    candidateTiers: [{ memoryId: "memory-tea", tier: "basic_memory" }],
  };
  recall.result = {
    mode: "none",
    selectedMemoryIds: [],
    selectedEvidenceIds: [],
    score: 0,
    abstained: true,
    abstentionReason: "requested_fact_facets_incomplete",
  };
  assertValidReplaySnapshot(recall.inputSnapshot);
  return recall;
}

function assertValidReplaySnapshot(snapshot: RetrievalReplayInput): void {
  const parsed = RetrievalReplayInputSchema.safeParse(snapshot);
  if (!parsed.success) {
    throw new Error(JSON.stringify(parsed.error.issues, undefined, 2));
  }
}

function frozenMemory(input: { id: string; content: string }) {
  return {
    id: input.id,
    agentId: "agent-test",
    kind: "semantic" as const,
    content: input.content,
    importance: 0.9,
    confidence: 0.95,
    tags: ["user fact"],
    sourceMessageIds: ["message-source"],
    sourceActivityEventIds: [],
    origin: "runtime_simulation" as const,
    namespace: "user_model" as const,
    certainty: "explicit" as const,
    attribution: "user_explicit" as const,
    stability: "stable" as const,
    status: "active" as const,
    dedupeKey: `fact:${input.id}`,
    createdAtUtc: "2026-09-04T10:00:00.000Z",
    updatedAtUtc: "2026-09-04T10:00:00.000Z",
  };
}

function frozenEvidence(input: {
  memoryId: string;
  evidenceId: string;
  quote: string;
}) {
  return {
    id: input.evidenceId,
    memoryId: input.memoryId,
    sourceType: "message" as const,
    sourceId: "message-source",
    quote: input.quote,
    recordedAtUtc: "2026-09-04T10:00:00.000Z",
  };
}

function evidenceItem(input: {
  memoryId: string;
  evidenceId: string;
  memoryContent: string;
  quote: string;
}) {
  return {
    memoryId: input.memoryId,
    memoryContent: input.memoryContent,
    memoryKind: "semantic" as const,
    namespace: "user_model" as const,
    certainty: "explicit" as const,
    attribution: "user_explicit" as const,
    stability: "stable" as const,
    evidence: {
      id: input.evidenceId,
      memoryId: input.memoryId,
      sourceType: "message" as const,
      sourceId: "message-source",
      quote: input.quote,
      recordedAtUtc: "2026-09-04T10:00:00.000Z",
    },
    score: 0.9,
    scoreBreakdown: {
      lexical: 1,
      tag: 1,
      importance: 1,
      recency: 1,
      temporal: 1,
      namespace: 1,
    },
  };
}

function selectedFacet(input: {
  index: number;
  kind: "beverage_preference" | "entity_inscription";
  request: unknown;
  memoryId: string;
  evidenceId: string;
  otherMemoryId: string;
}) {
  return {
    index: input.index,
    kind: input.kind,
    request: input.request,
    outcome: "selected" as const,
    candidates: [
      {
        memoryId: input.memoryId,
        decision: "selected" as const,
        reasonCode: "fact_candidate_selected" as const,
        valueGroupId: "value_1",
        evidence: [
          {
            evidenceId: input.evidenceId,
            decision: "accepted" as const,
            reasonCode: "fact_evidence_accepted" as const,
          },
        ],
      },
      {
        memoryId: input.otherMemoryId,
        decision: "rejected" as const,
        reasonCode: "fact_candidate_value_unparseable" as const,
        evidence: [],
      },
    ],
  };
}

function emptyEventCardAttempt() {
  return {
    tier: "event_card" as const,
    outcome: "incomplete" as const,
    scannedCandidateCount: 0,
    facets: [
      {
        index: 0,
        kind: "beverage_preference" as const,
        request: {
          kind: "beverage_preference" as const,
          selector: { scope: "family" as const, family: "tea" as const },
        },
        outcome: "missing" as const,
        candidates: [],
      },
      {
        index: 1,
        kind: "entity_inscription" as const,
        request: { kind: "entity_inscription" as const, entity: "铁盒" },
        outcome: "missing" as const,
        candidates: [],
      },
    ],
  };
}

function unsafeTurn(): ResolvedTurn {
  return {
    decision: {
      reply: {
        text: "你大概喝绿茶。铁盒也许象征着你的过去。",
        chunks: ["你大概喝绿茶。", "铁盒也许象征着你的过去。"],
        toneTags: ["猜测"],
      },
      scheduleEffects: [{ operation: "create" }],
      stateDelta: { stress: -0.1 },
      relationshipDelta: { trust: 0.1 },
      memoryCandidates: [{ content: "错误记忆" }],
      personalIntentCandidates: [{ activity: "整理暗房" }],
      continuityEffects: { careCueCandidates: [{}] },
      reasonCode: "persona_chat_decision",
      reasonSummary: "unsafe",
    } as never,
    inspection: {
      validation: { accepted: [{ operation: "create" }], rejections: [] },
      issues: [],
    } as never,
    repairAttempted: true,
    usedFallback: false,
    modelRejections: [],
    scheduleAction: { kind: "request_details" },
    modelScheduleActionAudit: {
      origin: "model_explicit_valid",
      kind: "request_details",
    },
    continuityEffects: { followUpCandidates: [{}] },
    worldEffectsAudit: {
      mode: "enforced",
      validation: {
        proposed: {
          stateDelta: { stress: -0.1 },
          relationshipDelta: { trust: 0.1 },
        },
        effects: {
          stateDelta: { stress: -0.1 },
          relationshipDelta: { trust: 0.1 },
          memoryCandidates: [{ content: "错误记忆" }],
          personalIntentCandidates: [{ activity: "整理暗房" }],
        },
        rejections: [],
        limitsApplied: [],
      } as never,
    },
  };
}

function preparedWorld(turn: ResolvedTurn): PreparedWorldEffectTurn {
  return {
    decision: turn.decision,
    validation: { accepted: [], rejections: [] },
    proposalRejections: [],
    decisionPath: "reply_only",
    nextState: {},
    stateChanged: false,
    effectTrace: {
      accepted: {},
    },
    repairAttempted: turn.repairAttempted,
    usedFallback: turn.usedFallback,
    scheduleActionAudit: { origin: "fixture", kind: "none" },
  } as unknown as PreparedWorldEffectTurn;
}
