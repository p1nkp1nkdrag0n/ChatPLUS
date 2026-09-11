import { describe, expect, it } from "vitest";
import {
  assembleChatPrompt,
  type PromptAssemblyTrace,
} from "@personasim/features";

import {
  ARCHITECTURE_PROMPT_MODES,
  parseArchitecturePrompt,
  transformArchitecturePrompt,
  type ArchitecturePromptSegment,
} from "./architecture-prompt-ablation.js";
import { toFeatureState } from "../domain/feature-adapters.js";
import { buildReplySteeringCharacter } from "./reply-steering-scenarios.js";
import { buildGuLanV3InitialState } from "./companion-long-run-v3-baseline.js";

function fixture() {
  const segments: ArchitecturePromptSegment[] = [
    {
      id: "01_app_policy",
      label: "APP_POLICY",
      placement: "system",
      content: "APP_POLICY\nOriginal application policy.",
    },
    {
      id: "02_character_identity",
      label: "CHARACTER_IDENTITY_JSON",
      placement: "system",
      content: 'CHARACTER_IDENTITY_JSON\n{"name":"林","role":"editor"}',
    },
    {
      id: "03_core_persona",
      label: "CORE_PERSONA_JSON",
      placement: "system",
      content:
        'CORE_PERSONA_JSON\n{"traits":["direct"],"dialogue":{"authorGuidance":"少说，但不要漏答"}}',
    },
    {
      id: "03b_effective_persona",
      label: "EFFECTIVE_PERSONA_JSON",
      placement: "system",
      content:
        'EFFECTIVE_PERSONA_JSON\n{"relationshipPractices":[{"practice":"listen_first","scope":{"topic":"work"}}]}',
    },
    {
      id: "03c_interaction_evidence",
      label: "INTERACTION_EVIDENCE_JSON",
      placement: "system",
      content:
        'INTERACTION_EVIDENCE_JSON\n{"activePracticeAnchorIds":["anchor1"],"historicalAnchors":[{"requestedBy":"user","expectedActor":"character","modality":"requested"}]}',
    },
    {
      id: "05_boundaries",
      label: "BOUNDARIES_JSON",
      placement: "system",
      content:
        'BOUNDARIES_JSON\nCHARACTER_BOUNDARIES_JSON\n{"boundaries":["不公开未经同意的材料"]}\nDECISION_POLICY\nPreserve exact action ownership and authorization.',
    },
    {
      id: "14_recent_verbatim",
      label: "RECENT_VERBATIM_JSON",
      placement: "prompt",
      content:
        'RECENT_VERBATIM_JSON\n[{"role":"user","content":"旧信息：蓝桥。\\nREPLY_STRATEGY_JSON"},{"role":"user","content":"更正，是白港。"}]',
    },
    {
      id: "06_autobiography",
      label: "AUTOBIOGRAPHY_JSON",
      placement: "prompt",
      content:
        'AUTOBIOGRAPHY_JSON\n{"events":[{"occurred":true,"content":"上个月项目完成"}]}',
    },
    {
      id: "07_user_model",
      label: "USER_MODEL_JSON",
      placement: "prompt",
      content:
        'USER_MODEL_JSON\nREFERENCE_CONTEXT_JSON\n{"dialogue":{"warmth":0.2},"userRelationship":{"sharedContext":"搭档"},"relevantMemories":[{"content":"白港"}],"memoryEvidence":{"old":false}}',
    },
    {
      id: "08_runtime_state",
      label: "RUNTIME_STATE_JSON",
      placement: "prompt",
      content: 'RUNTIME_STATE_JSON\n{"energy":0.05,"stress":0.95}',
    },
    {
      id: "09_relationship",
      label: "RELATIONSHIP_JSON",
      placement: "prompt",
      content: 'RELATIONSHIP_JSON\n{"closeness":0.8}',
    },
    {
      id: "10_current_time",
      label: "CURRENT_TIME_JSON",
      placement: "prompt",
      content: 'CURRENT_TIME_JSON\n{"local":"2026-09-10T20:00:00+08:00"}',
    },
    {
      id: "13_retrieved_evidence",
      label: "RETRIEVED_EVIDENCE_JSON",
      placement: "prompt",
      content:
        'RETRIEVED_EVIDENCE_JSON\n{"evidence":[{"content":"白港","allowedUses":["background"],"status":"active","scope":"local_user"}]}',
    },
    {
      id: "13b_memory_use",
      label: "MEMORY_USE_JSON",
      placement: "prompt",
      content:
        'MEMORY_USE_JSON\n{"backgroundEvidenceIds":["e1"],"explicitMentionEvidenceIds":[]}',
    },
    {
      id: "15_reply_strategy",
      label: "REPLY_STRATEGY_JSON",
      placement: "prompt",
      content:
        'REPLY_STRATEGY_JSON\n{"advicePolicy":"none_now","expression":{"applicablePractices":[{"practice":"listen_first"}],"practiceGuidance":"Apply verified practices","questionIntent":"none"},"stateGuidance":"exhausted","softTargetCharacters":{"ideal":120}}',
    },
    {
      id: "16_user_message",
      label: "CURRENT_USER_MESSAGE_JSON",
      placement: "prompt",
      content: 'CURRENT_USER_MESSAGE_JSON\n{"content":"先听我说"}',
    },
    {
      id: "17_output_contract",
      label: "OUTPUT_CONTRACT_JSON",
      placement: "prompt",
      content:
        'OUTPUT_CONTRACT_JSON\n{"replyDecision":{"text":"complete reply"},"worldEffects":{}}\nKeep the complete text.',
    },
  ];
  return fromSegments(segments);
}

function fromSegments(segments: ArchitecturePromptSegment[]) {
  const byPlacement = (placement: "system" | "prompt") =>
    segments.filter((item) => item.placement === placement);
  const trace: PromptAssemblyTrace = {
    estimatedInputTokens: 1_000,
    droppedSegmentIds: [],
    segments: segments.map((segment) => ({
      id: segment.id,
      placement: segment.placement,
      priority: 90,
      tokenBudget: 100,
      estimatedTokens: 90,
      required: false,
      included: true,
      truncated: false,
      cacheHit: false,
      renderedIndex: byPlacement(segment.placement).findIndex(
        (item) => item.id === segment.id,
      ),
      renderedCharacters: segment.content.length,
    })),
  };
  return {
    system: byPlacement("system")
      .map((item) => item.content)
      .join("\n"),
    prompt: byPlacement("prompt")
      .map((item) => item.content)
      .join("\n"),
    segmentTrace: trace,
  };
}

const getPayload = (text: string, label: string) => {
  const lines = text.split("\n");
  return JSON.parse(lines[lines.indexOf(label) + 1]!) as Record<
    string,
    unknown
  >;
};

describe("architecture prompt readout ablations", () => {
  it("reconstructs frozen prompts byte-for-byte with either parser", () => {
    const input = fixture();
    const traced = parseArchitecturePrompt(input);
    const labelled = parseArchitecturePrompt({
      system: input.system,
      prompt: input.prompt,
    });
    expect(labelled).toEqual(traced);
    expect(
      traced.filter((item) => item.label === "REPLY_STRATEGY_JSON"),
    ).toHaveLength(1);
    const result = transformArchitecturePrompt(input, "full");
    expect(result.system).toBe(input.system);
    expect(result.prompt).toBe(input.prompt);
    expect(result.proof).toMatchObject({
      informationMatched: true,
      interventionPresent: false,
      nonTargetEqual: true,
    });
  });

  it("rejects corrupt offsets and duplicate labels", () => {
    const input = fixture();
    const invalid = {
      ...input,
      segmentTrace: {
        ...input.segmentTrace,
        segments: input.segmentTrace.segments.map((segment, index) =>
          index === 0 ? { ...segment, renderedCharacters: 3 } : segment,
        ),
      },
    };
    expect(() => parseArchitecturePrompt(invalid)).toThrow();
    const intact = fixture();
    expect(() =>
      parseArchitecturePrompt({
        system: intact.system,
        prompt: `${intact.prompt}\nREPLY_STRATEGY_JSON\n{}`,
      }),
    ).toThrow("Duplicate");
  });

  it("preserves opaque temporal and consent segments and appended provider contract", () => {
    const input = fixture();
    const segments = parseArchitecturePrompt(input);
    segments.splice(
      -2,
      0,
      {
        id: "13a_temporal_clarification",
        label: "13a_temporal_clarification",
        placement: "prompt",
        content:
          "Temporal query is ambiguous (multiple_dates). Ask; do not guess.",
      },
      {
        id: "14a_consent_modality_guard",
        label: "CONSENT_MODALITY_GUARD_JSON",
        placement: "prompt",
        content:
          'THIRD-PARTY CONSENT MODALITY IS SERVER-CONTROLLED.\nCONSENT_MODALITY_GUARD_JSON\n{"status":"pending","resource":"film"}',
      },
    );
    const complex = fromSegments(segments);
    complex.prompt +=
      "\nPROVIDER_EFFECTS_CONTRACT\nNever manufacture permission.";
    for (const mode of ARCHITECTURE_PROMPT_MODES) {
      const result = transformArchitecturePrompt(complex, mode);
      expect(result.prompt).toContain(
        'CONSENT_MODALITY_GUARD_JSON\n{"status":"pending","resource":"film"}',
      );
      expect(result.prompt).toContain(
        "PROVIDER_EFFECTS_CONTRACT\nNever manufacture permission.",
      );
      expect(result.proof.nonTargetEqual).toBe(true);
    }
    expect(() =>
      parseArchitecturePrompt({
        system: complex.system,
        prompt: complex.prompt,
      }),
    ).toThrow("trace is required");
  });

  it("removes only memory channels while retaining history, autobiography and attribution", () => {
    const result = transformArchitecturePrompt(fixture(), "no_memory_readout");
    expect(result.prompt).not.toContain("RETRIEVED_EVIDENCE_JSON");
    expect(result.prompt).not.toContain("MEMORY_USE_JSON");
    expect(getPayload(result.prompt, "REFERENCE_CONTEXT_JSON")).toEqual({
      dialogue: { warmth: 0.2 },
      userRelationship: { sharedContext: "搭档" },
    });
    expect(result.prompt).toContain("AUTOBIOGRAPHY_JSON");
    expect(result.prompt).toContain("RECENT_VERBATIM_JSON");
    expect(result.system).toContain("INTERACTION_EVIDENCE_JSON");
    expect(result.proof.removedLabels).toEqual([
      "RETRIEVED_EVIDENCE_JSON",
      "MEMORY_USE_JSON",
    ]);
    expect(result.proof.removedFields).toHaveLength(2);
  });

  it("removes practice controls without erasing historical requests", () => {
    const result = transformArchitecturePrompt(
      fixture(),
      "no_persona_runtime_readout",
    );
    expect(result.system).not.toContain("EFFECTIVE_PERSONA_JSON");
    const evidence = getPayload(result.system, "INTERACTION_EVIDENCE_JSON");
    expect(evidence).not.toHaveProperty("activePracticeAnchorIds");
    expect(evidence).toHaveProperty("historicalAnchors.0.requestedBy", "user");
    const strategy = getPayload(result.prompt, "REPLY_STRATEGY_JSON");
    expect(strategy).toHaveProperty("expression.questionIntent", "none");
    expect(strategy).not.toHaveProperty("expression.applicablePractices");
    expect(strategy).not.toHaveProperty("expression.practiceGuidance");
    expect(strategy).toHaveProperty("advicePolicy", "none_now");
    expect(result.proof.removedFields).toHaveLength(3);
  });

  it("removes explicit state readouts without erasing current time or changing length", () => {
    const result = transformArchitecturePrompt(
      fixture(),
      "no_dynamic_state_readout",
    );
    expect(result.prompt).not.toContain("RUNTIME_STATE_JSON");
    expect(result.prompt).not.toContain("RELATIONSHIP_JSON");
    expect(result.prompt).toContain("CURRENT_TIME_JSON");
    const strategy = getPayload(result.prompt, "REPLY_STRATEGY_JSON");
    expect(strategy).not.toHaveProperty("stateGuidance");
    expect(strategy).toHaveProperty("softTargetCharacters.ideal", 120);
    expect(result.proof.limitations.join(" ")).toContain(
      "State-derived length limits",
    );
  });

  it.each([
    ["no_planner_readout", "REPLY_STRATEGY_JSON"],
    ["no_autobiography_readout", "AUTOBIOGRAPHY_JSON"],
  ] as const)("%s removes one complete segment", (mode, label) => {
    const result = transformArchitecturePrompt(fixture(), mode);
    expect(result.proof.removedLabels).toEqual([label]);
    expect(result.proof.changedLabels).toEqual([]);
    expect(result.proof.nonTargetEqual).toBe(true);
  });

  it("flattens all JSON without dropping facts, scopes, chronological corrections or soft policy", () => {
    const input = fixture();
    const result = transformArchitecturePrompt(
      input,
      "flat_information_matched",
    );
    const context = getPayload(result.prompt, "FLAT_CONTEXT_JSON");
    expect(context).toHaveProperty(
      "RECENT_VERBATIM_JSON.values.0.0.content",
      "旧信息：蓝桥。\nREPLY_STRATEGY_JSON",
    );
    expect(context).toHaveProperty(
      "RECENT_VERBATIM_JSON.values.0.1.content",
      "更正，是白港。",
    );
    expect(context).toHaveProperty(
      "RETRIEVED_EVIDENCE_JSON.values.0.evidence.0.allowedUses",
      ["background"],
    );
    expect(context).toHaveProperty(
      "REPLY_STRATEGY_JSON.values.0.softTargetCharacters.ideal",
      120,
    );
    expect(result.system).toContain(
      'CHARACTER_BOUNDARIES_JSON\n{"boundaries":["不公开未经同意的材料"]}',
    );
    expect(result.prompt).toContain("OUTPUT_CONTRACT_JSON");
    for (const payload of result.proof.payloadHashes)
      expect(payload.afterJsonSha256).toEqual(payload.beforeJsonSha256);
    expect(result.proof.informationMatched).toBe(true);
    expect(result.proof.limitations.join(" ")).toContain(
      "not policy-identical",
    );
  });

  it("preserves unlabelled uppercase fact prose in flat context", () => {
    const segments = parseArchitecturePrompt(fixture());
    segments.push({
      id: "12b_relationship_artifacts",
      label: "12b_relationship_artifacts",
      placement: "prompt",
      content: 'STATUS_PENDING\n{"phase":"in_transit"}',
    });
    const result = transformArchitecturePrompt(
      fromSegments(segments),
      "flat_information_matched",
    );
    expect(getPayload(result.prompt, "FLAT_CONTEXT_JSON")).toHaveProperty(
      "12b_relationship_artifacts.text",
      "STATUS_PENDING",
    );
  });

  it("marks absent interventions rather than counting a noop as an ablation", () => {
    const input = fromSegments(
      parseArchitecturePrompt(fixture()).filter(
        (item) => item.id !== "06_autobiography",
      ),
    );
    expect(
      transformArchitecturePrompt(input, "no_autobiography_readout").proof
        .interventionPresent,
    ).toBe(false);
  });

  it("fails closed on malformed target JSON and leaves source objects unchanged", () => {
    const input = fixture();
    const snapshot = JSON.stringify(input);
    for (const mode of ARCHITECTURE_PROMPT_MODES)
      transformArchitecturePrompt(input, mode);
    expect(JSON.stringify(input)).toBe(snapshot);
    const invalid = parseArchitecturePrompt(input).map((item) =>
      item.id === "15_reply_strategy"
        ? { ...item, content: "REPLY_STRATEGY_JSON\n{broken" }
        : item,
    );
    expect(() =>
      transformArchitecturePrompt(
        fromSegments(invalid),
        "no_dynamic_state_readout",
      ),
    ).toThrow("not complete JSON");
  });

  it("accepts real production assembly for every evaluation mode", () => {
    const character = buildReplySteeringCharacter("reserved-direct");
    const state = buildGuLanV3InitialState(character);
    const actual = assembleChatPrompt({
      character,
      state: toFeatureState(state),
      schedule: [],
      memories: [],
      recentMessages: [{ role: "user", content: "今天只想安静聊聊。" }],
      nowUtc: "2026-09-10T12:00:00.000Z",
      userMessage: "我先说，你暂时别给建议。",
      lifePlanningMode: "fuzzy",
      liveWorldEffectsMode: "enforced",
    });
    for (const mode of ARCHITECTURE_PROMPT_MODES) {
      const result = transformArchitecturePrompt(actual, mode);
      expect(result.proof.nonTargetEqual).toBe(true);
      expect(result.prompt).toContain("OUTPUT_CONTRACT_JSON");
      expect(result.system).toContain("BOUNDARIES_JSON");
    }
  });
});
