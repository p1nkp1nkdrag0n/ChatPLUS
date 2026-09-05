import {
  MemoryRecallResultSchema,
  type JsonValue,
  type Memory,
  type MemoryRecallResult,
} from "@personasim/contracts";
import { recallMemory } from "@personasim/features";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import {
  ExplicitFactSelectorAuditSchema,
  RETRIEVAL_RUN_STAGE_NAMES,
  RetrievalReplayInputSchema,
  RetrievalRunRepository,
  type CreateRetrievalRunInput,
  type RetrievalReplayInput,
  type RetrievalRunCandidate,
  type RetrievalRunStage,
} from "./retrieval-run-repository.js";

const NOW = "2026-08-21T04:00:00.000Z";
const AGENT_ID = "agent_retrieval_run";
const SESSION_ID = "session_retrieval_run";
const MESSAGE_ID = "message_retrieval_run";
const MEMORY_ID = "memory_retrieval_selected";
const EXCLUDED_MEMORY_ID = "memory_retrieval_excluded";
const EVIDENCE_ID = "evidence_retrieval_selected";
const EXPLICIT_FACT_QUERY =
  "周末去暗房前，替我核对两件旧事：我喝茶的习惯，和那只铁盒的标签。只答事实，不解释它们象征什么。";
const EXPLICIT_FACT_SOURCE =
  "我喝不加糖的红茶，不喜欢被替点甜的。我的钴蓝色铁盒标签写着“1998 / 潮声”。";

describe("RetrievalRunRepository", () => {
  let database: Database;
  let repository: RetrievalRunRepository;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    seedFoundation(database);
    repository = new RetrievalRunRepository(database);
  });

  afterEach(() => {
    database.close();
  });

  it("persists complete inspection snapshots and replays frozen inputs", () => {
    const input = replayInput();
    const result = evaluate(input);
    expect(result.abstained).toBe(false);
    const created = repository.create(
      createRunInput("retrieval_run_1", input, result),
    );

    expect(repository.findById(created.id)).toEqual(created);
    expect(repository.listByAgent(AGENT_ID)).toEqual([created]);
    expect(
      database
        .prepare(
          "SELECT json_extract(evidence_bundle_json, '$.mode') AS mode, candidate_count AS candidateCount, selected_count AS selectedCount FROM retrieval_runs WHERE id = ?",
        )
        .get(created.id),
    ).toEqual({
      mode: result.mode,
      candidateCount: 2,
      selectedCount: 1,
    });

    database
      .prepare("UPDATE memories SET content = ? WHERE id = ?")
      .run("The live memory was changed after retrieval.", MEMORY_ID);
    const frozen = repository.getReplayInput(created.id);
    expect(frozen?.memories[0]?.content).toBe(
      "The user plans a Kyoto trip in autumn.",
    );
    expect(frozen === undefined ? undefined : evaluate(frozen)).toEqual(result);

    expect(() =>
      database
        .prepare(
          "UPDATE retrieval_runs SET rendered_prompt_fragment = ? WHERE id = ?",
        )
        .run("tampered", created.id),
    ).toThrow(/immutable/iu);
    expect(() =>
      database
        .prepare("DELETE FROM retrieval_runs WHERE id = ?")
        .run(created.id),
    ).toThrow(/immutable/iu);
  });

  it("lists same-timestamp runs in insertion order with the newest first", () => {
    const input = replayInput();
    const result = evaluate(input);
    const first = repository.create(
      createRunInput("retrieval_run_z_first", input, result),
    );
    const second = repository.create(
      createRunInput("retrieval_run_a_second", input, result),
    );

    expect(repository.listByAgent(AGENT_ID, 2).map((run) => run.id)).toEqual([
      second.id,
      first.id,
    ]);
  });

  it("rejects result evidence that was not frozen in the replay input", () => {
    const input = replayInput();
    const result = evaluate(input);
    if (result.abstained) throw new Error("Expected selected recall evidence");
    const base = createRunInput("retrieval_run_forged_result", input, result);
    const forgedEvidenceId = "evidence_forged_result";
    const forgedResult = MemoryRecallResultSchema.parse({
      ...result,
      selectedEvidenceIds: [forgedEvidenceId],
      evidenceBundle: {
        ...result.evidenceBundle,
        evidence: [
          {
            ...result.evidenceBundle.evidence[0]!,
            evidence: {
              ...result.evidenceBundle.evidence[0]!.evidence,
              id: forgedEvidenceId,
              quote: "A forged user quotation.",
            },
          },
        ],
      },
    });

    expect(() =>
      repository.create({
        ...base,
        result: forgedResult,
      }),
    ).toThrow(/must exist in the frozen replay input/iu);
  });

  it("rejects mutated or non-selected evidence from a frozen replay pool", () => {
    const input = replayInput();
    const result = evaluate(input);
    if (result.abstained) throw new Error("Expected selected recall evidence");
    const base = createRunInput("retrieval_run_bound_result", input, result);
    const selectedItem = result.evidenceBundle.evidence[0]!;
    const mutatedResult = MemoryRecallResultSchema.parse({
      ...result,
      evidenceBundle: {
        ...result.evidenceBundle,
        evidence: [
          {
            ...selectedItem,
            evidence: {
              ...selectedItem.evidence,
              quote: "The same evidence id with altered source content.",
            },
          },
        ],
      },
    });
    expect(() =>
      repository.create({
        ...base,
        result: mutatedResult,
      }),
    ).toThrow(/exactly match frozen evidence/iu);

    const excludedEvidence = {
      ...selectedItem.evidence,
      id: "evidence_retrieval_excluded",
      memoryId: EXCLUDED_MEMORY_ID,
    };
    const inputWithExcludedEvidence: RetrievalReplayInput = {
      ...input,
      evidence: [...input.evidence, excludedEvidence],
    };
    const excludedMemory = input.memories.find(
      (memory) => memory.id === EXCLUDED_MEMORY_ID,
    )!;
    const nonSelectedResult = MemoryRecallResultSchema.parse({
      ...result,
      selectedMemoryIds: [...result.selectedMemoryIds, EXCLUDED_MEMORY_ID],
      selectedEvidenceIds: [...result.selectedEvidenceIds, excludedEvidence.id],
      evidenceBundle: {
        ...result.evidenceBundle,
        evidence: [
          selectedItem,
          {
            ...selectedItem,
            memoryId: excludedMemory.id,
            memoryContent: excludedMemory.content,
            memoryKind: excludedMemory.kind,
            namespace: excludedMemory.namespace,
            certainty: excludedMemory.certainty,
            attribution: excludedMemory.attribution,
            stability: excludedMemory.stability,
            evidence: excludedEvidence,
          },
        ],
      },
    });
    expect(() =>
      repository.create({
        ...createRunInput(
          "retrieval_run_non_selected_result",
          inputWithExcludedEvidence,
          result,
        ),
        result: nonSelectedResult,
      }),
    ).toThrow(/selected candidate/iu);
  });

  it("persists date-digest runs after the immutable table migration", () => {
    const baseInput = replayInput();
    const input: RetrievalReplayInput = {
      ...baseInput,
      strategyVersion: "continuity_hierarchy_v1",
      hierarchy: {
        finalTier: "date_digest",
        candidateTiers: baseInput.memories.map((memory) => ({
          memoryId: memory.id,
          tier: "date_digest" as const,
        })),
        temporalResolution: {
          kind: "resolved",
          expression: "yesterday",
          fromUtc: "2026-08-19T16:00:00.000Z",
          toUtc: "2026-08-20T16:00:00.000Z",
        },
      },
    };
    const evaluated = evaluate(input);
    if (evaluated.abstained) throw new Error("Expected recall evidence");
    const result = MemoryRecallResultSchema.parse({
      ...evaluated,
      mode: "date_digest",
      evidenceBundle: {
        ...evaluated.evidenceBundle,
        mode: "date_digest",
      },
    });

    const created = repository.create(
      createRunInput("retrieval_run_date_digest", input, result),
    );

    expect(
      database
        .prepare("SELECT mode FROM retrieval_runs WHERE id = ?")
        .get(created.id),
    ).toEqual({ mode: "date_digest" });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM schema_migrations WHERE name = ?",
        )
        .get("014_retrieval_run_date_digest.sql"),
    ).toEqual({ count: 1 });
    expect(repository.findById(created.id)).toEqual(created);
  });

  it("rejects incomplete stages and secret-bearing config snapshots", () => {
    const input = replayInput();
    const result = evaluate(input);
    const base = createRunInput("retrieval_run_invalid", input, result);

    expect(() =>
      repository.create({
        ...base,
        stages: base.stages.slice(0, -1),
      }),
    ).toThrow(/complete|length/iu);
    expect(() =>
      repository.create({
        ...base,
        configSnapshot: {
          ...base.configSnapshot,
          provider: { apiKey: "must-not-be-persisted" },
        },
      }),
    ).toThrow(/secrets/iu);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM retrieval_runs").get(),
    ).toEqual({ count: 0 });
  });

  it("validates selected explicit-fact audit mappings against frozen replay inputs", () => {
    const base = replayInput();
    const explicitFactMemory = {
      ...base.memories[0]!,
      content:
        "用户喝不加糖的红茶，不喜欢被替点甜的。用户的钴蓝色铁盒标签写着“1998 / 潮声”。",
      tags: ["红茶", "铁盒", "标签"],
      stability: "stable" as const,
    };
    const explicitFactEvidence = {
      ...base.evidence[0]!,
      quote: EXPLICIT_FACT_SOURCE,
    };
    const input = {
      ...base,
      query: { ...base.query, query: EXPLICIT_FACT_QUERY },
      memories: [explicitFactMemory],
      evidence: [explicitFactEvidence],
      selectorAuditInput: {
        memories: [explicitFactMemory],
        evidence: [explicitFactEvidence],
        candidateTiers: [
          { memoryId: MEMORY_ID, tier: "basic_memory" as const },
        ],
      },
      strategyVersion: "continuity_hierarchy_v1" as const,
      hierarchy: {
        finalTier: "basic_memory" as const,
        candidateTiers: [
          { memoryId: MEMORY_ID, tier: "basic_memory" as const },
        ],
        selectorAudit: {
          policy: "explicit_fact_checklist_v1" as const,
          expectedFacetCount: 2,
          outcome: "selected" as const,
          scanLimit: 500,
          scanTruncated: false,
          replayEvidenceIds: [EVIDENCE_ID],
          attempts: [
            emptyEventFactAttempt(),
            {
              tier: "basic_memory" as const,
              outcome: "selected" as const,
              scannedCandidateCount: 1,
              facets: [
                selectorFacet(0, "beverage_preference"),
                selectorFacet(1, "entity_inscription"),
              ],
            },
          ],
        },
      },
    };

    expect(RetrievalReplayInputSchema.parse(input)).toEqual(input);
    const lexicallyLaterEvidence = {
      ...explicitFactEvidence,
      id: "evidence_z_retrieval_selected",
    };
    const greedyReplay = RetrievalReplayInputSchema.parse({
      ...input,
      evidence: [lexicallyLaterEvidence],
      selectorAuditInput: {
        ...input.selectorAuditInput,
        evidence: [explicitFactEvidence, lexicallyLaterEvidence],
      },
      hierarchy: {
        ...input.hierarchy,
        selectorAudit: {
          ...input.hierarchy.selectorAudit,
          replayEvidenceIds: [lexicallyLaterEvidence.id],
          attempts: input.hierarchy.selectorAudit.attempts.map((attempt) => ({
            ...attempt,
            facets: attempt.facets.map((facet) => ({
              ...facet,
              candidates: facet.candidates.map((candidate) => ({
                ...candidate,
                evidence: [
                  ...candidate.evidence,
                  {
                    evidenceId: lexicallyLaterEvidence.id,
                    decision: "accepted" as const,
                    reasonCode: "fact_evidence_accepted" as const,
                  },
                ],
              })),
            })),
          })),
        },
      },
    });
    const nonMinimalEvidenceResult = evaluate(greedyReplay);
    expect(nonMinimalEvidenceResult.abstained).toBe(false);
    expect(() =>
      repository.create(
        createRunInput(
          "retrieval_run_non_minimal_fact_evidence",
          greedyReplay,
          nonMinimalEvidenceResult,
        ),
      ),
    ).toThrow(/exactly cover every audited facet/iu);
    expect(() =>
      RetrievalReplayInputSchema.parse({
        ...input,
        hierarchy: {
          ...input.hierarchy,
          selectorAudit: {
            ...input.hierarchy.selectorAudit,
            attempts: input.hierarchy.selectorAudit.attempts.map((attempt) => ({
              ...attempt,
              facets: attempt.facets.map((facet, index) =>
                index === 0
                  ? {
                      ...facet,
                      request: {
                        kind: "beverage_preference" as const,
                        selector: {
                          scope: "family" as const,
                          family: "coffee" as const,
                        },
                      },
                    }
                  : facet,
              ),
            })),
          },
        },
      }),
    ).toThrow(/frozen replay query/iu);
    const semanticallyDifferentMemories = input.memories.map((memory) => ({
      ...memory,
      content: "用户把相片收在木盒里，也会喝加糖咖啡。",
    }));
    expect(() =>
      RetrievalReplayInputSchema.parse({
        ...input,
        memories: semanticallyDifferentMemories,
        selectorAuditInput: {
          ...input.selectorAuditInput,
          memories: semanticallyDifferentMemories,
        },
      }),
    ).toThrow(/value decisions.*frozen memory content/iu);
    const semanticallyDifferentEvidence = input.evidence.map((evidence) => ({
      ...evidence,
      quote: "我喝加糖咖啡。我的木盒标签写着“A-7”。",
    }));
    expect(() =>
      RetrievalReplayInputSchema.parse({
        ...input,
        evidence: semanticallyDifferentEvidence,
        selectorAuditInput: {
          ...input.selectorAuditInput,
          evidence: semanticallyDifferentEvidence,
        },
      }),
    ).toThrow(/accepted fact evidence.*canonical frozen value/iu);
    expect(() =>
      RetrievalReplayInputSchema.parse({
        ...input,
        selectorAuditInput: {
          memories: [],
          evidence: [],
          candidateTiers: [],
        },
      }),
    ).toThrow(/frozen audit memories|frozen input memory/iu);
    expect(() =>
      RetrievalReplayInputSchema.parse({
        ...input,
        selectorAuditInput: {
          ...input.selectorAuditInput,
          memories: input.selectorAuditInput.memories.map((memory) => ({
            ...memory,
            content: "The same id now claims a forged, conflicting fact.",
          })),
        },
      }),
    ).toThrow(/replay and selector memories must be identical/iu);
    expect(() =>
      RetrievalReplayInputSchema.parse({
        ...input,
        selectorAuditInput: {
          ...input.selectorAuditInput,
          evidence: input.selectorAuditInput.evidence.map((evidence) => ({
            ...evidence,
            quote: "A forged source under the same evidence id.",
          })),
        },
      }),
    ).toThrow(/replay and selector evidence must be identical/iu);
    expect(() =>
      RetrievalReplayInputSchema.parse({
        ...input,
        selectorAuditInput: {
          ...input.selectorAuditInput,
          candidateTiers: input.selectorAuditInput.candidateTiers.map(
            (candidate) => ({ ...candidate, tier: "event_card" as const }),
          ),
        },
      }),
    ).toThrow(/same hierarchy tier|frozen attempt tier/iu);
    expect(() =>
      RetrievalReplayInputSchema.parse({
        ...input,
        hierarchy: {
          ...input.hierarchy,
          selectorAudit: {
            ...input.hierarchy.selectorAudit,
            attempts: [
              input.hierarchy.selectorAudit.attempts[0],
              {
                ...input.hierarchy.selectorAudit.attempts[1],
                facets: [
                  {
                    ...input.hierarchy.selectorAudit.attempts[1]!.facets[0],
                    candidates: [
                      {
                        ...input.hierarchy.selectorAudit.attempts[1]!.facets[0]!
                          .candidates[0],
                        memoryId: "memory_tampered_selector",
                      },
                    ],
                  },
                  input.hierarchy.selectorAudit.attempts[1]!.facets[1],
                ],
              },
            ],
          },
        },
      }),
    ).toThrow(/audit candidates.*frozen audit memories/iu);

    const rejectedFacets =
      input.hierarchy.selectorAudit.attempts[1]!.facets.map((facet) => ({
        ...facet,
        candidates: facet.candidates.map((candidate) => ({
          ...candidate,
          decision: "rejected" as const,
          reasonCode: "fact_candidate_provisional_winner",
        })),
      }));
    const rejected = {
      ...input,
      hierarchy: {
        ...input.hierarchy,
        finalTier: "none" as const,
        abstentionReason: "requested_fact_below_caller_threshold",
        abstentionScore: 0,
        selectorAudit: {
          ...input.hierarchy.selectorAudit,
          outcome: "below_threshold" as const,
          attempts: [
            input.hierarchy.selectorAudit.attempts[0]!,
            {
              ...input.hierarchy.selectorAudit.attempts[1]!,
              outcome: "below_threshold" as const,
              facets: rejectedFacets,
            },
          ],
        },
      },
    };
    expect(RetrievalReplayInputSchema.parse(rejected)).toEqual(rejected);
    expect(() =>
      RetrievalReplayInputSchema.parse({
        ...rejected,
        memories: [],
        evidence: [],
        hierarchy: {
          ...rejected.hierarchy,
          candidateTiers: [],
          selectorAudit: {
            ...rejected.hierarchy.selectorAudit,
            replayEvidenceIds: [],
          },
        },
      }),
    ).toThrow(/exactly match its Basic diagnostic candidate pool/iu);
    expect(() =>
      RetrievalReplayInputSchema.parse({
        ...rejected,
        evidence: [],
      }),
    ).toThrow(/producer-selected audit evidence/iu);
    expect(() =>
      RetrievalReplayInputSchema.parse({
        ...rejected,
        hierarchy: {
          ...rejected.hierarchy,
          abstentionReason: "requested_fact_evidence_capacity_insufficient",
          selectorAudit: {
            ...rejected.hierarchy.selectorAudit,
            outcome: "capacity_insufficient",
            attempts: rejected.hierarchy.selectorAudit.attempts.map(
              (attempt) =>
                attempt.tier === "basic_memory"
                  ? { ...attempt, outcome: "capacity_insufficient" as const }
                  : attempt,
            ),
          },
        },
      }),
    ).toThrow(/capacity outcomes.*frozen provisional evidence coverage/iu);
    const queryWithoutCallerThreshold = { ...rejected.query };
    delete queryWithoutCallerThreshold.minimumScore;
    expect(() =>
      RetrievalReplayInputSchema.parse({
        ...rejected,
        query: queryWithoutCallerThreshold,
      }),
    ).toThrow(/caller-threshold rejection.*explicit query minimum score/iu);
    expect(() =>
      RetrievalReplayInputSchema.parse({
        ...rejected,
        memories: [base.memories[1]!],
        evidence: [],
        hierarchy: {
          ...rejected.hierarchy,
          candidateTiers: [
            {
              memoryId: EXCLUDED_MEMORY_ID,
              tier: "basic_memory" as const,
            },
          ],
        },
      }),
    ).toThrow(/replay fact memories must come from frozen selector inputs/iu);
    expect(() =>
      RetrievalReplayInputSchema.parse({
        ...rejected,
        selectorAuditInput: {
          ...rejected.selectorAuditInput,
          memories: rejected.selectorAuditInput.memories.map((memory) => ({
            ...memory,
            stability: "stable" as const,
          })),
        },
        hierarchy: {
          ...rejected.hierarchy,
          selectorAudit: {
            ...rejected.hierarchy.selectorAudit,
            attempts: rejected.hierarchy.selectorAudit.attempts.map(
              (attempt) => ({
                ...attempt,
                facets: attempt.facets.map((facet) => ({
                  ...facet,
                  candidates: facet.candidates.map((candidate) => ({
                    ...candidate,
                    reasonCode: "fact_candidate_future" as const,
                    valueGroupId: undefined,
                    evidence: [],
                  })),
                })),
              }),
            ),
          },
        },
      }),
    ).toThrow(/eligibility reasons must match the frozen memory state/iu);
    expect(() =>
      RetrievalReplayInputSchema.parse({
        ...input,
        hierarchy: {
          ...input.hierarchy,
          finalTier: "event_card",
          candidateTiers: input.hierarchy.candidateTiers.map((item) => ({
            ...item,
            tier: "event_card" as const,
          })),
          selectorAudit: {
            ...input.hierarchy.selectorAudit,
            attempts: [emptyEventFactAttempt()],
          },
        },
      }),
    ).toThrow(/both hierarchy tiers/iu);
    expect(() =>
      RetrievalReplayInputSchema.parse({
        ...rejected,
        hierarchy: {
          ...rejected.hierarchy,
          abstentionReason: "requested_fact_facets_conflicted",
        },
      }),
    ).toThrow(/outcome.*abstention reason/iu);
    expect(() =>
      RetrievalReplayInputSchema.parse({
        ...rejected,
        hierarchy: {
          ...rejected.hierarchy,
          abstentionReason: "requested_fact_facets_incomplete",
          selectorAudit: {
            ...rejected.hierarchy.selectorAudit,
            outcome: "incomplete",
          },
        },
      }),
    ).toThrow(/strongest rejected attempt/iu);
    expect(() =>
      RetrievalReplayInputSchema.parse({
        ...rejected,
        hierarchy: {
          ...rejected.hierarchy,
          abstentionReason: "requested_fact_scan_truncated",
          selectorAudit: {
            ...rejected.hierarchy.selectorAudit,
            outcome: "scan_truncated",
            scanTruncated: true,
          },
        },
      }),
    ).toThrow(/truncated attempt/iu);

    const mismatchedResult = MemoryRecallResultSchema.parse({
      mode: "none",
      selectedMemoryIds: [],
      selectedEvidenceIds: [],
      score: 0,
      abstained: true,
      abstentionReason: "requested_fact_facets_incomplete",
    });
    expect(() =>
      repository.create(
        createRunInput(
          "retrieval_run_mismatched_hierarchy",
          RetrievalReplayInputSchema.parse(rejected),
          mismatchedResult,
        ),
      ),
    ).toThrow(/frozen hierarchy replay/iu);

    const excludedEvidence = {
      ...explicitFactEvidence,
      id: "evidence_retrieval_excluded",
      memoryId: EXCLUDED_MEMORY_ID,
    };
    const auditedCandidate = (
      memoryId: string,
      evidenceId: string,
      selected: boolean,
    ) => ({
      memoryId,
      decision: selected ? ("selected" as const) : ("rejected" as const),
      reasonCode: selected
        ? "fact_candidate_selected"
        : "fact_candidate_lower_ranked",
      valueGroupId: "value_1",
      evidence: [
        {
          evidenceId,
          decision: "accepted" as const,
          reasonCode: "fact_evidence_accepted",
        },
      ],
    });
    const explicitPoolMemories = base.memories.map((memory, index) => ({
      ...explicitFactMemory,
      id: memory.id,
      dedupeKey: `memory:explicit-fact:${index}`,
      tags: memory.id === MEMORY_ID ? ["饮料", "偏好"] : ["标签", "标记"],
      stability: "stable" as const,
    }));
    const partialSelectorInput = RetrievalReplayInputSchema.parse({
      ...base,
      query: input.query,
      memories: explicitPoolMemories,
      evidence: [explicitFactEvidence, excludedEvidence],
      strategyVersion: "continuity_hierarchy_v1",
      selectorAuditInput: {
        memories: explicitPoolMemories,
        evidence: [explicitFactEvidence, excludedEvidence],
        candidateTiers: explicitPoolMemories.map((memory) => ({
          memoryId: memory.id,
          tier: "basic_memory" as const,
        })),
      },
      hierarchy: {
        finalTier: "basic_memory",
        candidateTiers: explicitPoolMemories.map((memory) => ({
          memoryId: memory.id,
          tier: "basic_memory" as const,
        })),
        selectorAudit: {
          policy: "explicit_fact_checklist_v1",
          expectedFacetCount: 2,
          outcome: "selected",
          scanLimit: 500,
          scanTruncated: false,
          replayEvidenceIds: [EVIDENCE_ID, excludedEvidence.id],
          attempts: [
            emptyEventFactAttempt(),
            {
              tier: "basic_memory",
              outcome: "selected",
              scannedCandidateCount: 2,
              facets: [
                {
                  index: 0,
                  kind: "beverage_preference",
                  request: factFacetRequest("beverage_preference"),
                  outcome: "selected",
                  candidates: [
                    auditedCandidate(MEMORY_ID, EVIDENCE_ID, true),
                    auditedCandidate(
                      EXCLUDED_MEMORY_ID,
                      excludedEvidence.id,
                      false,
                    ),
                  ],
                },
                {
                  index: 1,
                  kind: "entity_inscription",
                  request: factFacetRequest("entity_inscription"),
                  outcome: "selected",
                  candidates: [
                    auditedCandidate(MEMORY_ID, EVIDENCE_ID, false),
                    auditedCandidate(
                      EXCLUDED_MEMORY_ID,
                      excludedEvidence.id,
                      true,
                    ),
                  ],
                },
              ],
            },
          ],
        },
      },
    });
    const equalRankMemories = partialSelectorInput.memories.map((memory) => ({
      ...memory,
      tags: ["饮料", "偏好", "标签"],
    }));
    expect(() =>
      RetrievalReplayInputSchema.parse({
        ...partialSelectorInput,
        memories: equalRankMemories,
        selectorAuditInput: {
          ...partialSelectorInput.selectorAuditInput,
          memories: equalRankMemories,
        },
      }),
    ).toThrow(/deterministic facet ranking/iu);
    const conflictingMemories = partialSelectorInput.memories.map((memory) =>
      memory.id === EXCLUDED_MEMORY_ID
        ? {
            ...memory,
            content:
              "用户喝加糖的红茶。用户的钴蓝色铁盒标签写着“1998 / 潮声”。",
          }
        : memory,
    );
    const conflictingEvidence = partialSelectorInput.evidence.map((evidence) =>
      evidence.memoryId === EXCLUDED_MEMORY_ID
        ? {
            ...evidence,
            quote: "我喝加糖的红茶。我的钴蓝色铁盒标签写着“1998 / 潮声”。",
          }
        : evidence,
    );
    const basicAttempt =
      partialSelectorInput.hierarchy?.selectorAudit?.attempts.find(
        (attempt) => attempt.tier === "basic_memory",
      );
    if (basicAttempt === undefined) {
      throw new Error("Expected a Basic explicit-fact attempt");
    }
    const conflictedBasicAttempt = {
      ...basicAttempt,
      outcome: "conflicted" as const,
      facets: basicAttempt.facets.map((facet, facetIndex) => ({
        ...facet,
        outcome: facetIndex === 0 ? ("conflicted" as const) : facet.outcome,
        candidates: facet.candidates.map((candidate) => ({
          ...candidate,
          decision: "rejected" as const,
          reasonCode:
            facetIndex === 0
              ? ("fact_candidate_value_conflict" as const)
              : ("fact_candidate_lower_ranked" as const),
          valueGroupId:
            facetIndex === 0
              ? candidate.memoryId === EXCLUDED_MEMORY_ID
                ? "value_1"
                : "value_2"
              : "value_1",
        })),
      })),
    };
    const conflictedReplay = RetrievalReplayInputSchema.parse({
      ...partialSelectorInput,
      memories: conflictingMemories,
      evidence: conflictingEvidence,
      selectorAuditInput: {
        ...partialSelectorInput.selectorAuditInput,
        memories: conflictingMemories,
        evidence: conflictingEvidence,
      },
      hierarchy: {
        ...partialSelectorInput.hierarchy,
        finalTier: "none",
        abstentionReason: "requested_fact_facets_conflicted",
        abstentionScore: 0,
        selectorAudit: {
          ...partialSelectorInput.hierarchy?.selectorAudit,
          outcome: "conflicted",
          replayEvidenceIds: conflictingEvidence.map((evidence) => evidence.id),
          attempts: [
            partialSelectorInput.hierarchy?.selectorAudit?.attempts[0],
            conflictedBasicAttempt,
          ],
        },
      },
    });
    expect(() =>
      RetrievalReplayInputSchema.parse({
        ...conflictedReplay,
        hierarchy: {
          ...conflictedReplay.hierarchy,
          selectorAudit: {
            ...conflictedReplay.hierarchy?.selectorAudit,
            attempts: conflictedReplay.hierarchy?.selectorAudit?.attempts.map(
              (attempt) =>
                attempt.tier !== "basic_memory"
                  ? attempt
                  : {
                      ...attempt,
                      facets: attempt.facets.map((facet, facetIndex) =>
                        facetIndex !== 0
                          ? facet
                          : {
                              ...facet,
                              candidates: facet.candidates.map((candidate) => ({
                                ...candidate,
                                valueGroupId:
                                  candidate.valueGroupId === "value_1"
                                    ? "value_2"
                                    : "value_1",
                              })),
                            },
                      ),
                    },
            ),
          },
        },
      }),
    ).toThrow(/deterministic canonical numbering/iu);
    const partialResult = evaluate(base);
    expect(() =>
      repository.create(
        createRunInput(
          "retrieval_run_partial_selector_result",
          partialSelectorInput,
          partialResult,
        ),
      ),
    ).toThrow(/selector audit memories|selector result evidence/iu);

    const decoyFinalTierInput = RetrievalReplayInputSchema.parse({
      ...base,
      strategyVersion: "continuity_hierarchy_v1",
      hierarchy: {
        finalTier: "basic_memory",
        candidateTiers: [
          { memoryId: MEMORY_ID, tier: "event_card" },
          { memoryId: EXCLUDED_MEMORY_ID, tier: "basic_memory" },
        ],
      },
    });
    expect(() =>
      repository.create(
        createRunInput(
          "retrieval_run_decoy_final_tier",
          decoyFinalTierInput,
          evaluate(base),
        ),
      ),
    ).toThrow(/selected result memory.*final hierarchy tier/iu);
  });

  it("rejects internally inconsistent explicit-fact selector audits", () => {
    const eventSelected = {
      tier: "event_card" as const,
      outcome: "selected" as const,
      scannedCandidateCount: 1,
      facets: [
        selectorFacet(0, "beverage_preference"),
        selectorFacet(1, "entity_inscription"),
      ],
    };
    const basicConsistent = {
      tier: "basic_memory" as const,
      outcome: "consistent_not_selected" as const,
      scannedCandidateCount: 1,
      facets: eventSelected.facets.map((facet) => ({
        ...facet,
        candidates: facet.candidates.map((candidate) => ({
          ...candidate,
          decision: "rejected" as const,
          reasonCode: "fact_candidate_same_value_shadowed_by_event_card",
        })),
      })),
    };
    const valid = {
      policy: "explicit_fact_checklist_v1" as const,
      expectedFacetCount: 2,
      outcome: "selected" as const,
      scanLimit: 500,
      scanTruncated: false,
      attempts: [eventSelected, basicConsistent],
    };
    expect(ExplicitFactSelectorAuditSchema.parse(valid)).toEqual(valid);

    const eventCapacity = {
      ...eventSelected,
      outcome: "capacity_insufficient" as const,
      facets: eventSelected.facets.map((facet) => ({
        ...facet,
        candidates: facet.candidates.map((candidate) => ({
          ...candidate,
          decision: "rejected" as const,
          reasonCode: "fact_candidate_provisional_winner" as const,
        })),
      })),
    };
    const basicCompleteNotSelected = {
      ...basicConsistent,
      outcome: "complete_not_selected" as const,
      facets: basicConsistent.facets.map((facet) => ({
        ...facet,
        candidates: facet.candidates.map((candidate) => ({
          ...candidate,
          reasonCode:
            "fact_candidate_rejected_due_higher_tier_failure" as const,
        })),
      })),
    };
    const validCompleteBlocked = {
      ...valid,
      outcome: "capacity_insufficient" as const,
      attempts: [eventCapacity, basicCompleteNotSelected],
    };
    expect(ExplicitFactSelectorAuditSchema.parse(validCompleteBlocked)).toEqual(
      validCompleteBlocked,
    );
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...validCompleteBlocked,
        attempts: [
          eventCapacity,
          {
            ...basicCompleteNotSelected,
            facets: basicCompleteNotSelected.facets.map((facet, index) =>
              index === 0
                ? {
                    ...facet,
                    candidates: facet.candidates.map((candidate) => ({
                      ...candidate,
                      valueGroupId: "value_2",
                    })),
                  }
                : facet,
            ),
          },
        ],
      }),
    ).toThrow(/cross-tier value disagreement/iu);
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...validCompleteBlocked,
        attempts: [
          {
            ...eventCapacity,
            facets: eventCapacity.facets.map((facet) => ({
              ...facet,
              candidates: facet.candidates.map((candidate) => ({
                ...candidate,
                reasonCode: "fact_candidate_rejected_due_higher_tier_failure",
              })),
            })),
          },
          basicCompleteNotSelected,
        ],
      }),
    ).toThrow(/Only a complete blocked Basic attempt/iu);
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...validCompleteBlocked,
        attempts: [
          {
            ...eventCapacity,
            facets: eventCapacity.facets.map((facet) => ({
              ...facet,
              candidates: facet.candidates.map((candidate) => ({
                ...candidate,
                reasonCode: "fact_candidate_same_value_shadowed_by_event_card",
              })),
            })),
          },
          basicCompleteNotSelected,
        ],
      }),
    ).toThrow(/Only a consistency-only Basic attempt/iu);
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...validCompleteBlocked,
        attempts: [
          {
            ...eventCapacity,
            facets: eventCapacity.facets.map((facet) => ({
              ...facet,
              candidates: facet.candidates.map((candidate) => ({
                ...candidate,
                reasonCode: "fact_candidate_value_unparseable",
              })),
            })),
          },
          basicCompleteNotSelected,
        ],
      }),
    ).toThrow(
      /Only a matched fact-candidate decision may carry a value group/iu,
    );
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...validCompleteBlocked,
        attempts: [
          {
            ...eventCapacity,
            facets: eventCapacity.facets.map((facet) => ({
              ...facet,
              candidates: facet.candidates.map((candidate) => ({
                ...candidate,
                reasonCode: "fact_candidate_rejected_due_atomic_conflict",
              })),
            })),
          },
          basicCompleteNotSelected,
        ],
      }),
    ).toThrow(/Atomic-conflict rejections require a conflicted attempt/iu);
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...validCompleteBlocked,
        attempts: [
          eventCapacity,
          {
            ...basicCompleteNotSelected,
            facets: basicCompleteNotSelected.facets.map((facet) => ({
              ...facet,
              candidates: facet.candidates.map((candidate) => ({
                memoryId: candidate.memoryId,
                decision: candidate.decision,
                reasonCode: candidate.reasonCode,
                evidence: [],
              })),
            })),
          },
        ],
      }),
    ).toThrow(/matched fact-candidate decision|exactly one value group/iu);

    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...valid,
        attempts: [
          eventSelected,
          {
            ...basicConsistent,
            facets: basicConsistent.facets.map((facet, index) =>
              index === 0
                ? {
                    ...facet,
                    candidates: facet.candidates.map((candidate) => ({
                      ...candidate,
                      evidence: [],
                    })),
                  }
                : facet,
            ),
          },
        ],
      }),
    ).toThrow(
      /value group requires accepted evidence|matched fact-candidate/iu,
    );

    const validMissingCandidateAudit = {
      ...valid,
      outcome: "incomplete" as const,
      attempts: [
        {
          tier: "event_card" as const,
          outcome: "incomplete" as const,
          scannedCandidateCount: 1,
          facets: emptyEventFactAttempt().facets.map((facet) => ({
            ...facet,
            candidates: [
              {
                memoryId: MEMORY_ID,
                decision: "rejected" as const,
                reasonCode: "fact_candidate_future" as const,
                evidence: [],
              },
            ],
          })),
        },
        emptyBasicFactAttempt(),
      ],
    };
    expect(
      ExplicitFactSelectorAuditSchema.parse(validMissingCandidateAudit),
    ).toEqual(validMissingCandidateAudit);
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...validMissingCandidateAudit,
        attempts: [
          {
            ...validMissingCandidateAudit.attempts[0],
            facets: validMissingCandidateAudit.attempts[0]!.facets.map(
              (facet) => ({
                ...facet,
                candidates: facet.candidates.map((candidate) => ({
                  ...candidate,
                  reasonCode: "made_up_reason",
                })),
              }),
            ),
          },
          validMissingCandidateAudit.attempts[1],
        ],
      }),
    ).toThrow(/Invalid option|made_up_reason/iu);
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...validMissingCandidateAudit,
        attempts: [
          {
            ...validMissingCandidateAudit.attempts[0],
            facets: validMissingCandidateAudit.attempts[0]!.facets.map(
              (facet) => ({
                ...facet,
                candidates: facet.candidates.map((candidate) => ({
                  ...candidate,
                  reasonCode: "fact_candidate_evidence_scan_truncated",
                })),
              }),
            ),
          },
          validMissingCandidateAudit.attempts[1],
        ],
      }),
    ).toThrow(/belong only to a truncated Basic evidence scan/iu);

    const evidenceConflictWithoutSource = {
      ...validMissingCandidateAudit,
      outcome: "conflicted" as const,
      attempts: [
        {
          ...validMissingCandidateAudit.attempts[0],
          outcome: "conflicted" as const,
          facets: validMissingCandidateAudit.attempts[0]!.facets.map(
            (facet, index) =>
              index === 0
                ? {
                    ...facet,
                    outcome: "conflicted" as const,
                    candidates: facet.candidates.map((candidate) => ({
                      ...candidate,
                      reasonCode: "fact_candidate_evidence_conflicted" as const,
                    })),
                  }
                : facet,
          ),
        },
        validMissingCandidateAudit.attempts[1],
      ],
    };
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse(evidenceConflictWithoutSource),
    ).toThrow(/requires rejected conflicting source evidence/iu);
    const partiallyShadowedBasic = {
      ...basicConsistent,
      scannedCandidateCount: 2,
      facets: basicConsistent.facets.map((facet, facetIndex) => ({
        ...facet,
        candidates: [
          ...facet.candidates,
          {
            memoryId: "memory_partially_shadowed",
            decision: "rejected" as const,
            reasonCode: "fact_candidate_lower_ranked" as const,
            valueGroupId: "value_1",
            evidence: [
              {
                evidenceId: `evidence_partially_shadowed_${facetIndex}`,
                decision: "accepted" as const,
                reasonCode: "fact_evidence_accepted" as const,
              },
            ],
          },
        ],
      })),
    };
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...valid,
        attempts: [eventSelected, partiallyShadowedBasic],
      }),
    ).toThrow(/identify its Event-shadowed matches/iu);

    const atomicWithMissingFacet = {
      policy: "explicit_fact_checklist_v1" as const,
      expectedFacetCount: 3,
      outcome: "conflicted" as const,
      scanLimit: 500 as const,
      scanTruncated: false,
      attempts: [
        {
          tier: "event_card" as const,
          outcome: "conflicted" as const,
          scannedCandidateCount: 1,
          facets: [
            {
              index: 0,
              kind: "beverage_preference" as const,
              request: factFacetRequest("beverage_preference"),
              outcome: "conflicted" as const,
              candidates: [
                {
                  memoryId: MEMORY_ID,
                  decision: "rejected" as const,
                  reasonCode: "fact_candidate_evidence_conflicted" as const,
                  evidence: [
                    {
                      evidenceId: "evidence_atomic_conflict_source",
                      decision: "rejected" as const,
                      reasonCode: "fact_evidence_value_conflict" as const,
                    },
                  ],
                },
              ],
            },
            {
              index: 1,
              kind: "entity_inscription" as const,
              request: factFacetRequest("entity_inscription"),
              outcome: "selected" as const,
              candidates: [
                {
                  memoryId: MEMORY_ID,
                  decision: "rejected" as const,
                  reasonCode:
                    "fact_candidate_rejected_due_atomic_conflict" as const,
                  valueGroupId: "value_1",
                  evidence: [
                    {
                      evidenceId: EVIDENCE_ID,
                      decision: "accepted" as const,
                      reasonCode: "fact_evidence_accepted" as const,
                    },
                  ],
                },
              ],
            },
            {
              index: 2,
              kind: "entity_inscription" as const,
              request: { kind: "entity_inscription" as const, entity: "相册" },
              outcome: "missing" as const,
              candidates: [
                {
                  memoryId: MEMORY_ID,
                  decision: "rejected" as const,
                  reasonCode: "fact_candidate_value_unparseable" as const,
                  evidence: [],
                },
              ],
            },
          ],
        },
        {
          tier: "basic_memory" as const,
          outcome: "incomplete" as const,
          scannedCandidateCount: 0,
          facets: [
            {
              index: 0,
              kind: "beverage_preference" as const,
              request: factFacetRequest("beverage_preference"),
              outcome: "missing" as const,
              candidates: [],
            },
            {
              index: 1,
              kind: "entity_inscription" as const,
              request: factFacetRequest("entity_inscription"),
              outcome: "missing" as const,
              candidates: [],
            },
            {
              index: 2,
              kind: "entity_inscription" as const,
              request: { kind: "entity_inscription" as const, entity: "相册" },
              outcome: "missing" as const,
              candidates: [],
            },
          ],
        },
      ],
    };
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse(atomicWithMissingFacet),
    ).toThrow(/Atomic-conflict rejections require a conflicted attempt/iu);

    const hiddenCrossTierConflict = {
      ...valid,
      outcome: "conflicted" as const,
      attempts: [
        {
          tier: "event_card" as const,
          outcome: "conflicted" as const,
          scannedCandidateCount: 1,
          facets: [
            {
              index: 0,
              kind: "beverage_preference" as const,
              request: factFacetRequest("beverage_preference"),
              outcome: "conflicted" as const,
              candidates: [
                {
                  memoryId: MEMORY_ID,
                  decision: "rejected" as const,
                  reasonCode: "fact_candidate_evidence_conflicted" as const,
                  evidence: [
                    {
                      evidenceId: "evidence_hidden_conflict_source",
                      decision: "rejected" as const,
                      reasonCode: "fact_evidence_value_conflict" as const,
                    },
                  ],
                },
              ],
            },
            {
              ...selectorFacet(1, "entity_inscription"),
              candidates: selectorFacet(1, "entity_inscription").candidates.map(
                (candidate) => ({
                  ...candidate,
                  decision: "rejected" as const,
                  reasonCode: "fact_candidate_lower_ranked" as const,
                }),
              ),
            },
          ],
        },
        {
          tier: "basic_memory" as const,
          outcome: "incomplete" as const,
          scannedCandidateCount: 1,
          facets: [
            {
              index: 0,
              kind: "beverage_preference" as const,
              request: factFacetRequest("beverage_preference"),
              outcome: "missing" as const,
              candidates: [
                {
                  memoryId: EXCLUDED_MEMORY_ID,
                  decision: "rejected" as const,
                  reasonCode: "fact_candidate_value_unparseable" as const,
                  evidence: [],
                },
              ],
            },
            {
              ...selectorFacet(1, "entity_inscription"),
              candidates: selectorFacet(1, "entity_inscription").candidates.map(
                (candidate) => ({
                  ...candidate,
                  memoryId: EXCLUDED_MEMORY_ID,
                  decision: "rejected" as const,
                  reasonCode: "fact_candidate_lower_ranked" as const,
                  valueGroupId: "value_2",
                }),
              ),
            },
          ],
        },
      ],
    };
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse(hiddenCrossTierConflict),
    ).toThrow(/Cross-tier value disagreement must propagate/iu);

    const valueConflictAttempt = {
      tier: "event_card" as const,
      outcome: "conflicted" as const,
      scannedCandidateCount: 2,
      facets: eventSelected.facets.map((facet, facetIndex) => ({
        ...facet,
        outcome: "conflicted" as const,
        candidates: [
          {
            ...facet.candidates[0]!,
            decision: "rejected" as const,
            reasonCode: "fact_candidate_value_conflict" as const,
          },
          {
            memoryId: EXCLUDED_MEMORY_ID,
            decision: "rejected" as const,
            reasonCode: "fact_candidate_value_conflict" as const,
            valueGroupId: "value_2",
            evidence: [
              {
                evidenceId: `evidence_second_value_${facetIndex}`,
                decision: "accepted" as const,
                reasonCode: "fact_evidence_accepted" as const,
              },
            ],
          },
        ],
      })),
    };
    const validValueConflict = {
      ...valid,
      outcome: "conflicted" as const,
      attempts: [valueConflictAttempt, emptyBasicFactAttempt()],
    };
    expect(ExplicitFactSelectorAuditSchema.parse(validValueConflict)).toEqual(
      validValueConflict,
    );
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...validValueConflict,
        attempts: [
          {
            ...valueConflictAttempt,
            facets: valueConflictAttempt.facets.map((facet, facetIndex) =>
              facetIndex === 0
                ? {
                    ...facet,
                    candidates: facet.candidates.map((candidate, index) =>
                      index === 1
                        ? {
                            ...candidate,
                            reasonCode: "fact_candidate_lower_ranked" as const,
                          }
                        : candidate,
                    ),
                  }
                : facet,
            ),
          },
          emptyBasicFactAttempt(),
        ],
      }),
    ).toThrow(/every matched candidate.*value-conflict/iu);

    const unpropagatedIntrinsicConflict = {
      ...valid,
      outcome: "conflicted" as const,
      attempts: [
        {
          tier: "event_card" as const,
          outcome: "conflicted" as const,
          scannedCandidateCount: 1,
          facets: [
            {
              index: 0,
              kind: "beverage_preference" as const,
              request: factFacetRequest("beverage_preference"),
              outcome: "conflicted" as const,
              candidates: [
                {
                  memoryId: MEMORY_ID,
                  decision: "rejected" as const,
                  reasonCode: "fact_candidate_evidence_conflicted" as const,
                  evidence: [
                    {
                      evidenceId: "evidence_intrinsic_conflict",
                      decision: "rejected" as const,
                      reasonCode: "fact_evidence_value_conflict" as const,
                    },
                  ],
                },
              ],
            },
            {
              index: 1,
              kind: "entity_inscription" as const,
              request: factFacetRequest("entity_inscription"),
              outcome: "missing" as const,
              candidates: [
                {
                  memoryId: MEMORY_ID,
                  decision: "rejected" as const,
                  reasonCode: "fact_candidate_value_unparseable" as const,
                  evidence: [],
                },
              ],
            },
          ],
        },
        {
          tier: "basic_memory" as const,
          outcome: "incomplete" as const,
          scannedCandidateCount: 1,
          facets: [
            {
              ...selectorFacet(0, "beverage_preference"),
              candidates: selectorFacet(
                0,
                "beverage_preference",
              ).candidates.map((candidate) => ({
                ...candidate,
                memoryId: EXCLUDED_MEMORY_ID,
                decision: "rejected" as const,
                reasonCode: "fact_candidate_lower_ranked" as const,
              })),
            },
            {
              index: 1,
              kind: "entity_inscription" as const,
              request: factFacetRequest("entity_inscription"),
              outcome: "missing" as const,
              candidates: [
                {
                  memoryId: EXCLUDED_MEMORY_ID,
                  decision: "rejected" as const,
                  reasonCode: "fact_candidate_value_unparseable" as const,
                  evidence: [],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse(unpropagatedIntrinsicConflict),
    ).toThrow(/intrinsic fact conflicts must propagate/iu);
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...valid,
        attempts: [
          {
            ...eventSelected,
            facets: eventSelected.facets.map((facet) => ({
              ...facet,
              candidates: facet.candidates.map((candidate) => ({
                ...candidate,
                evidence: [
                  ...candidate.evidence,
                  {
                    evidenceId: "evidence_conflicting_source",
                    decision: "rejected" as const,
                    reasonCode: "fact_evidence_value_conflict" as const,
                  },
                ],
              })),
            })),
          },
          basicConsistent,
        ],
      }),
    ).toThrow(/Conflicting source evidence must propagate/iu);
    const unverifiedWithAcceptedEvidence = {
      memoryId: "memory_unverified_with_accepted_evidence",
      decision: "rejected" as const,
      reasonCode: "fact_candidate_evidence_not_verified" as const,
      evidence: [
        {
          evidenceId: "evidence_impossibly_accepted",
          decision: "accepted" as const,
          reasonCode: "fact_evidence_accepted" as const,
        },
      ],
    };
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...valid,
        attempts: [
          {
            ...eventSelected,
            scannedCandidateCount: 2,
            facets: eventSelected.facets.map((facet) => ({
              ...facet,
              candidates: [...facet.candidates, unverifiedWithAcceptedEvidence],
            })),
          },
          basicConsistent,
        ],
      }),
    ).toThrow(
      /unverified-evidence candidate cannot contain accepted evidence/iu,
    );

    const evidenceTruncatedBasic = {
      tier: "basic_memory" as const,
      outcome: "scan_truncated" as const,
      scannedCandidateCount: 1,
      scanLimit: 100,
      scanUnit: "evidence_per_memory" as const,
      truncatedMemoryIds: [MEMORY_ID],
      facets: emptyBasicFactAttempt().facets.map((facet) => ({
        ...facet,
        candidates: [
          {
            memoryId: MEMORY_ID,
            decision: "rejected" as const,
            reasonCode: "fact_candidate_evidence_scan_truncated" as const,
            evidence: [],
          },
        ],
      })),
    };
    const validEvidenceScan = {
      ...valid,
      outcome: "scan_truncated" as const,
      scanTruncated: true,
      attempts: [emptyEventFactAttempt(), evidenceTruncatedBasic],
    };
    expect(ExplicitFactSelectorAuditSchema.parse(validEvidenceScan)).toEqual(
      validEvidenceScan,
    );
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...validEvidenceScan,
        attempts: [
          validEvidenceScan.attempts[0],
          {
            ...evidenceTruncatedBasic,
            facets: evidenceTruncatedBasic.facets.map((facet) => ({
              ...facet,
              candidates: facet.candidates.map((candidate) => ({
                ...candidate,
                reasonCode: "fact_candidate_future",
              })),
            })),
          },
        ],
      }),
    ).toThrow(/mark every culprit as uninspected/iu);
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...validEvidenceScan,
        attempts: [
          validEvidenceScan.attempts[0],
          { ...evidenceTruncatedBasic, scanLimit: 1 },
        ],
      }),
    ).toThrow(/per-memory evidence scans must use the v1 safety limit/iu);
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...validEvidenceScan,
        attempts: [{ ...evidenceTruncatedBasic, tier: "event_card" }],
      }),
    ).toThrow(/Event scans use candidate-pool limits/iu);

    const eventCandidatePoolScan = {
      tier: "event_card" as const,
      outcome: "scan_truncated" as const,
      scannedCandidateCount: 500,
      scanLimit: 500,
      scanUnit: "candidate_pool" as const,
      scanWitnessMemoryId: "memory_event_scan_overflow",
      facets: emptyEventFactAttempt().facets,
    };
    const validEventScan = {
      ...valid,
      outcome: "scan_truncated" as const,
      scanTruncated: true,
      attempts: [eventCandidatePoolScan],
    };
    expect(ExplicitFactSelectorAuditSchema.parse(validEventScan)).toEqual(
      validEventScan,
    );
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...validEventScan,
        attempts: [
          {
            ...eventCandidatePoolScan,
            scanWitnessMemoryId: undefined,
          },
        ],
      }),
    ).toThrow(/requires one overflow witness/iu);
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...validEventScan,
        attempts: [eventCandidatePoolScan, emptyBasicFactAttempt()],
      }),
    ).toThrow(/cannot be followed by a completed Basic attempt/iu);
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...validEventScan,
        attempts: [
          {
            ...eventCandidatePoolScan,
            scannedCandidateCount: 499,
            scanLimit: 499,
          },
        ],
      }),
    ).toThrow(/selector safety limit/iu);

    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...valid,
        attempts: [eventSelected],
      }),
    ).toThrow(/both hierarchy tiers/iu);
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...valid,
        attempts: [
          eventSelected,
          {
            tier: "basic_memory",
            outcome: "scan_truncated",
            scannedCandidateCount: 1,
            scanLimit: 1,
            scanUnit: "candidate_pool",
            scanWitnessMemoryId: "memory_basic_scan_overflow_invalid",
            facets: emptyEventFactAttempt().facets,
          },
        ],
      }),
    ).toThrow(/cannot hide/iu);
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...valid,
        attempts: [
          eventSelected,
          {
            ...basicConsistent,
            facets: basicConsistent.facets.map((facet, index) =>
              index === 0
                ? {
                    ...facet,
                    candidates: facet.candidates.map((candidate) => ({
                      ...candidate,
                      valueGroupId: "value_2",
                    })),
                  }
                : facet,
            ),
          },
        ],
      }),
    ).toThrow(/match every EventCard value group/iu);
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...valid,
        attempts: [
          eventSelected,
          {
            ...basicConsistent,
            facets: basicConsistent.facets.map((facet, index) =>
              index === 0
                ? { ...facet, kind: "entity_inscription" as const }
                : facet,
            ),
          },
        ],
      }),
    ).toThrow(/preserve facet identity/iu);
    const mismatchedIncompleteFallback = {
      ...basicConsistent,
      outcome: "incomplete" as const,
      facets: basicConsistent.facets.map((facet, index) =>
        index === 0
          ? {
              ...facet,
              candidates: facet.candidates.map((candidate) => ({
                ...candidate,
                valueGroupId: "value_2",
                reasonCode: "fact_candidate_lower_ranked" as const,
              })),
            }
          : {
              ...facet,
              outcome: "missing" as const,
              candidates: facet.candidates.map((candidate) => ({
                memoryId: candidate.memoryId,
                decision: "rejected" as const,
                reasonCode: "fact_candidate_value_unparseable" as const,
                evidence: [],
              })),
            },
      ),
    };
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...valid,
        attempts: [eventSelected, mismatchedIncompleteFallback],
      }),
    ).toThrow(/cross-tier value disagreement|matched fallback facet/iu);
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...valid,
        outcome: "conflicted",
        attempts: [
          {
            ...eventSelected,
            outcome: "conflicted",
            facets: eventSelected.facets.map((facet) => ({
              ...facet,
              outcome: "conflicted",
              candidates: facet.candidates.map((candidate) => ({
                ...candidate,
                decision: "rejected",
                reasonCode: "fact_candidate_value_conflict",
              })),
            })),
          },
          emptyBasicFactAttempt(),
        ],
      }),
    ).toThrow(/requires two values/iu);
    const hiddenBasicConflict = {
      tier: "basic_memory" as const,
      outcome: "incomplete" as const,
      scannedCandidateCount: 1,
      facets: [
        {
          index: 0,
          kind: "beverage_preference" as const,
          request: factFacetRequest("beverage_preference"),
          outcome: "conflicted" as const,
          candidates: [
            {
              memoryId: MEMORY_ID,
              decision: "rejected" as const,
              reasonCode: "fact_candidate_value_conflict",
              valueGroupId: "value_2",
              evidence: [
                {
                  evidenceId: EVIDENCE_ID,
                  decision: "accepted" as const,
                  reasonCode: "fact_evidence_accepted",
                },
              ],
            },
          ],
        },
        {
          index: 1,
          kind: "entity_inscription" as const,
          request: factFacetRequest("entity_inscription"),
          outcome: "missing" as const,
          candidates: [
            {
              memoryId: MEMORY_ID,
              decision: "rejected" as const,
              reasonCode: "fact_candidate_value_unparseable",
              evidence: [],
            },
          ],
        },
      ],
    };
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...valid,
        attempts: [eventSelected, hiddenBasicConflict],
      }),
    ).toThrow(/conflicted fact facet requires a conflicted attempt/iu);

    const blockedEvent = {
      ...eventSelected,
      outcome: "incomplete" as const,
      facets: eventSelected.facets.map((facet) => ({
        ...facet,
        candidates: facet.candidates.map((candidate) => ({
          ...candidate,
          decision: "rejected" as const,
          reasonCode: "fact_candidate_rejected_due_scan_truncation",
        })),
      })),
    };
    const truncatedBasic = {
      tier: "basic_memory" as const,
      outcome: "scan_truncated" as const,
      scannedCandidateCount: 500,
      scanLimit: 500,
      scanUnit: "candidate_pool" as const,
      scanWitnessMemoryId: "memory_basic_scan_overflow",
      facets: emptyBasicFactAttempt().facets,
    };
    const validBlockedByScan = {
      ...valid,
      outcome: "scan_truncated" as const,
      scanTruncated: true,
      attempts: [blockedEvent, truncatedBasic],
    };
    expect(ExplicitFactSelectorAuditSchema.parse(validBlockedByScan)).toEqual(
      validBlockedByScan,
    );
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...valid,
        attempts: [eventSelected, { ...blockedEvent, tier: "basic_memory" }],
      }),
    ).toThrow(/following truncated Basic scan/iu);
    expect(() =>
      ExplicitFactSelectorAuditSchema.parse({
        ...validBlockedByScan,
        attempts: [
          {
            ...blockedEvent,
            facets: blockedEvent.facets.map((facet, index) =>
              index === 0
                ? facet
                : {
                    ...facet,
                    candidates: facet.candidates.map((candidate) => ({
                      ...candidate,
                      reasonCode: "fact_candidate_lower_ranked",
                    })),
                  },
            ),
          },
          truncatedBasic,
        ],
      }),
    ).toThrow(/missing or scan-blocked facet set/iu);
  });
});

function emptyEventFactAttempt() {
  return {
    tier: "event_card" as const,
    outcome: "incomplete" as const,
    scannedCandidateCount: 0,
    facets: [
      {
        index: 0,
        kind: "beverage_preference" as const,
        request: factFacetRequest("beverage_preference"),
        outcome: "missing" as const,
        candidates: [],
      },
      {
        index: 1,
        kind: "entity_inscription" as const,
        request: factFacetRequest("entity_inscription"),
        outcome: "missing" as const,
        candidates: [],
      },
    ],
  };
}

function emptyBasicFactAttempt() {
  return {
    ...emptyEventFactAttempt(),
    tier: "basic_memory" as const,
  };
}

function selectorFacet(
  index: number,
  kind: "beverage_preference" | "entity_inscription",
) {
  return {
    index,
    kind,
    request: factFacetRequest(kind),
    outcome: "selected" as const,
    candidates: [
      {
        memoryId: MEMORY_ID,
        decision: "selected" as const,
        reasonCode: "fact_candidate_selected",
        valueGroupId: "value_1",
        evidence: [
          {
            evidenceId: EVIDENCE_ID,
            decision: "accepted" as const,
            reasonCode: "fact_evidence_accepted",
          },
        ],
      },
    ],
  };
}

function factFacetRequest(kind: "beverage_preference" | "entity_inscription") {
  return kind === "beverage_preference"
    ? {
        kind,
        selector: { scope: "family" as const, family: "tea" as const },
      }
    : { kind, entity: "铁盒" };
}

function createRunInput(
  id: string,
  inputSnapshot: RetrievalReplayInput,
  result: MemoryRecallResult,
): CreateRetrievalRunInput {
  return {
    id,
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    sourceMessageId: MESSAGE_ID,
    inputSnapshot,
    stages: stages(inputSnapshot, result),
    candidates: candidates(inputSnapshot, result),
    result,
    configSnapshot: {
      strategy: {
        name: "keyword_evidence_v1",
        candidateLimit: inputSnapshot.candidateLimit,
        maxEvidence: inputSnapshot.maxEvidence,
        minimumScore: inputSnapshot.minimumScore,
      },
      scoreWeights: {
        lexical: 0.34,
        tag: 0.14,
        importance: 0.16,
        recency: 0.1,
        temporal: 0.16,
        namespace: 0.1,
      },
    },
    renderedPromptFragment:
      "Retrieved evidence:\n- The user plans a Kyoto trip in autumn.",
    createdAtUtc: NOW,
  };
}

function stages(
  input: RetrievalReplayInput,
  result: MemoryRecallResult,
): RetrievalRunStage[] {
  const snapshots: JsonValue[] = [
    { query: jsonSnapshot(input.query) },
    { timeRange: jsonSnapshot(input.query.timeRange ?? null) },
    { namespaces: input.query.namespaces ?? [] },
    { memoryIds: input.memories.map((memory) => memory.id) },
    { evidenceIds: input.evidence.map((evidence) => evidence.id) },
    {
      minimumScore: input.minimumScore,
      scoreKinds: [
        "lexical",
        "semantic",
        "temporal",
        "importance",
        "relationship",
      ],
    },
    {
      selectedMemoryIds: result.selectedMemoryIds,
      abstained: result.abstained,
    },
    { rendered: true },
  ];
  return RETRIEVAL_RUN_STAGE_NAMES.map((name, ordinal) => ({
    name,
    ordinal,
    status: "completed",
    ...(name === "candidate_generation"
      ? { inputCount: input.memories.length }
      : {}),
    ...(name === "selection"
      ? { outputCount: result.selectedMemoryIds.length }
      : {}),
    durationMs: ordinal / 10,
    snapshot: snapshots[ordinal] ?? null,
  }));
}

function candidates(
  input: RetrievalReplayInput,
  result: MemoryRecallResult,
): RetrievalRunCandidate[] {
  if (result.abstained) return [];
  const selectedById = new Map(
    result.evidenceBundle.evidence.map((item) => [item.memoryId, item]),
  );
  return input.memories.map((memory) => {
    const selected = selectedById.get(memory.id);
    if (selected !== undefined) {
      return {
        memoryId: memory.id,
        namespace: selected.namespace,
        evidenceIds: [selected.evidence.id],
        score: selected.score,
        scoreBreakdown: selected.scoreBreakdown,
        semanticScore: null,
        relationshipScore: 0,
        decision: "selected",
        reasonCode: "top_ranked",
        selectionRank: result.selectedMemoryIds.indexOf(memory.id) + 1,
      };
    }
    return {
      memoryId: memory.id,
      namespace: memory.namespace ?? "runtime_simulation",
      evidenceIds: [],
      score: 0.08,
      scoreBreakdown: zeroBreakdown(),
      semanticScore: null,
      relationshipScore: 0,
      decision: "excluded",
      reasonCode: "below_threshold",
      reasonSummary: "The candidate did not meet the configured threshold.",
    };
  });
}

function replayInput(): RetrievalReplayInput {
  return {
    agentId: AGENT_ID,
    query: {
      query: "What did I say about my Kyoto trip?",
      namespaces: ["user_model"],
      minimumScore: 0.1,
    },
    nowUtc: NOW,
    memories: [
      selectedMemory(),
      {
        ...selectedMemory(),
        id: EXCLUDED_MEMORY_ID,
        content: "The user likes plain tea.",
        tags: ["tea"],
        dedupeKey: "memory:tea",
      },
    ],
    evidence: [
      {
        id: EVIDENCE_ID,
        memoryId: MEMORY_ID,
        sourceType: "message",
        sourceId: MESSAGE_ID,
        quote: "I plan to visit Kyoto this autumn.",
        recordedAtUtc: NOW,
      },
    ],
    minimumScore: 0.1,
    maxEvidence: 3,
    candidateLimit: 200,
  };
}

function selectedMemory(): Memory {
  return {
    id: MEMORY_ID,
    agentId: AGENT_ID,
    kind: "semantic",
    content: "The user plans a Kyoto trip in autumn.",
    importance: 0.8,
    confidence: 1,
    tags: ["kyoto", "trip"],
    sourceMessageIds: [],
    sourceActivityEventIds: [],
    origin: "runtime_simulation",
    namespace: "user_model",
    certainty: "explicit",
    attribution: "user_explicit",
    stability: "situational",
    status: "active",
    dedupeKey: "memory:kyoto-trip",
    createdAtUtc: NOW,
    updatedAtUtc: NOW,
  };
}

function evaluate(input: RetrievalReplayInput): MemoryRecallResult {
  return recallMemory({
    query: input.query,
    memories: input.memories,
    evidence: input.evidence,
    nowUtc: input.nowUtc,
    minimumScore: input.minimumScore,
    maxEvidence: input.maxEvidence,
  });
}

function zeroBreakdown(): {
  lexical: number;
  tag: number;
  importance: number;
  recency: number;
  temporal: number;
  namespace: number;
} {
  return {
    lexical: 0,
    tag: 0,
    importance: 0,
    recency: 0,
    temporal: 0,
    namespace: 0,
  };
}

function jsonSnapshot(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function seedFoundation(database: Database): void {
  database
    .prepare(
      "INSERT INTO characters(id, current_version, status, tier, name, source_type, created_at_utc, updated_at_utc) VALUES (?, 1, 'published', 'daily', 'Retrieval Run', 'original', ?, ?)",
    )
    .run(AGENT_ID, NOW, NOW);
  database
    .prepare(
      "INSERT INTO sessions(id, agent_id, title, created_at_utc, updated_at_utc) VALUES (?, ?, 'Retrieval Run', ?, ?)",
    )
    .run(SESSION_ID, AGENT_ID, NOW, NOW);
  database
    .prepare(
      "INSERT INTO messages(id, session_id, agent_id, role, content, message_kind, created_at_utc) VALUES (?, ?, ?, 'user', 'I plan to visit Kyoto this autumn.', 'user', ?)",
    )
    .run(MESSAGE_ID, SESSION_ID, AGENT_ID, NOW);
  const memory = selectedMemory();
  database
    .prepare(
      "INSERT INTO memories(id, agent_id, type, content, tags_json, importance, confidence, created_at_utc, memory_json, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      memory.id,
      memory.agentId,
      memory.kind,
      memory.content,
      JSON.stringify(memory.tags),
      memory.importance,
      memory.confidence,
      memory.createdAtUtc,
      JSON.stringify(memory),
      memory.status,
    );
}
