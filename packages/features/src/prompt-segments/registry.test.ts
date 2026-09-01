import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PROMPT_SEGMENT_IDS,
  createCalendarContextPromptSegment,
  createDefaultPromptSegments,
  createFollowUpContextPromptSegment,
} from "./default-segments.js";
import { estimatePromptTokens, PromptSegmentRegistry } from "./registry.js";
import {
  PromptSegmentRegistryError,
  type PromptContext,
  type PromptSegment,
} from "./types.js";

type TestContext = PromptContext & { readonly value?: string };

function segment(input: {
  id: string;
  content: string;
  priority?: number;
  tokenBudget?: number;
  required?: boolean;
  placement?: "system" | "prompt";
  globalOverflowPolicy?: "truncate" | "drop";
}): PromptSegment<TestContext> {
  return {
    id: input.id,
    placement: input.placement ?? "prompt",
    priority: input.priority ?? 1,
    tokenBudget: input.tokenBudget ?? 100,
    required: input.required ?? false,
    cacheable: false,
    ...(input.globalOverflowPolicy === undefined
      ? {}
      : { globalOverflowPolicy: input.globalOverflowPolicy }),
    render: () => input.content,
  };
}

describe("PromptSegmentRegistry", () => {
  it("emits selected segments in stable id order rather than priority order", () => {
    const registry = new PromptSegmentRegistry<TestContext>([
      segment({ id: "03_third", content: "third", priority: 100 }),
      segment({ id: "01_first", content: "first", priority: 1 }),
      segment({ id: "02_second", content: "second", priority: 50 }),
    ]);

    expect(registry.render({}).prompt).toBe("first\nsecond\nthird");
    expect(registry.list().map((item) => item.id)).toEqual([
      "01_first",
      "02_second",
      "03_third",
    ]);
  });

  it("rejects duplicate ids and supports an idempotent unregister disposer", () => {
    const registry = new PromptSegmentRegistry<TestContext>();
    const first = segment({ id: "01_first", content: "first" });
    const dispose = registry.register(first);

    let duplicate: unknown;
    try {
      registry.register(first);
    } catch (error) {
      duplicate = error;
    }
    expect(duplicate).toBeInstanceOf(PromptSegmentRegistryError);
    expect((duplicate as PromptSegmentRegistryError).code).toBe(
      "duplicate_segment_id",
    );

    dispose();
    dispose();
    expect(registry.list()).toEqual([]);
    expect(() => registry.register(first)).not.toThrow();
  });

  it("keeps registry instances and their caches composition-local", () => {
    const render = vi.fn(() => "cached");
    const cached: PromptSegment<TestContext> = {
      ...segment({ id: "01_cached", content: "unused" }),
      cacheable: true,
      cacheKey: () => "character:1",
      render,
    };
    const first = new PromptSegmentRegistry([cached]);
    const second = new PromptSegmentRegistry([cached]);

    first.render({});
    first.render({});
    second.render({});

    expect(render).toHaveBeenCalledTimes(2);
  });

  it("retains required segments and admits optional segments by priority within the global budget", () => {
    const registry = new PromptSegmentRegistry<TestContext>([
      segment({
        id: "01_required",
        content: "R".repeat(16),
        required: true,
        priority: 0,
        tokenBudget: 4,
      }),
      segment({
        id: "02_low",
        content: "L".repeat(16),
        priority: 1,
        tokenBudget: 4,
      }),
      segment({
        id: "03_high",
        content: "H".repeat(16),
        priority: 100,
        tokenBudget: 4,
      }),
    ]);

    const result = registry.render({}, { maxInputTokens: 8 });
    expect(result.prompt).toContain("R".repeat(16));
    expect(result.prompt).toContain("H");
    expect(result.prompt).not.toContain("L");
    expect(result.trace.estimatedInputTokens).toBeLessThanOrEqual(8);
    expect(
      result.trace.segments.find((item) => item.id === "01_required")?.included,
    ).toBe(true);
  });

  it("drops opt-in structured segments under global pressure while preserving truncate by default", () => {
    const createRegistry = (globalOverflowPolicy?: "truncate" | "drop") =>
      new PromptSegmentRegistry<TestContext>([
        segment({
          id: "01_required",
          content: "R".repeat(16),
          required: true,
          tokenBudget: 4,
        }),
        segment({
          id: "02_structured",
          content: 'STRUCTURED_JSON\n{"items":[1,2,3,4,5,6]}',
          tokenBudget: 100,
          ...(globalOverflowPolicy === undefined
            ? {}
            : { globalOverflowPolicy }),
        }),
      ]);

    const truncated = createRegistry().render({}, { maxInputTokens: 13 });
    expect(truncated.prompt).toContain("STRUCTURED_JSON");
    expect(() => {
      JSON.parse(truncated.prompt.split("STRUCTURED_JSON\n")[1]!);
    }).not.toThrow();
    expect(
      truncated.trace.segments.find((item) => item.id === "02_structured"),
    ).toMatchObject({ included: true, truncated: true });

    const dropped = createRegistry("drop").render({}, { maxInputTokens: 8 });
    expect(dropped.prompt).toBe("R".repeat(16));
    expect(dropped.trace.droppedSegmentIds).toContain("02_structured");
    expect(
      dropped.trace.segments.find((item) => item.id === "02_structured"),
    ).toMatchObject({
      included: false,
      truncated: false,
      reason: "global_budget",
    });
  });

  it("enforces each segment token budget before the global budget", () => {
    const registry = new PromptSegmentRegistry<TestContext>([
      segment({
        id: "01_bounded",
        content: "x".repeat(1_000),
        tokenBudget: 10,
      }),
    ]);
    const result = registry.render({});
    expect(estimatePromptTokens(result.prompt)).toBeLessThanOrEqual(10);
    expect(result.trace.segments[0]).toMatchObject({
      estimatedTokens: 10,
      truncated: true,
    });
  });

  it("compacts labeled JSON structurally instead of slicing it mid-token", () => {
    const registry = new PromptSegmentRegistry<TestContext>([
      segment({
        id: "01_structured",
        content: `CORE_PERSONA_JSON\n${JSON.stringify({
          traits: Array.from({ length: 10 }, (_, index) => ({
            name: `trait-${index}`,
            description: "x".repeat(1_000),
          })),
          dialogue: { hardRule: "each reply includes a translation" },
          relationship: { privateBehavior: "more open in private" },
        })}`,
        tokenBudget: 180,
        required: true,
      }),
    ]);

    const result = registry.render({});
    const serialized = result.prompt.split("CORE_PERSONA_JSON\n")[1]!;
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    expect(parsed).toHaveProperty("dialogue");
    expect(parsed).toHaveProperty("relationship");
    expect(result.trace.segments[0]).toMatchObject({ truncated: true });
  });

  it("drops an atomic optional segment when its own token budget is exceeded", () => {
    const registry = new PromptSegmentRegistry<TestContext>([
      segment({
        id: "01_atomic_json",
        content: `STRUCTURED_JSON\n${JSON.stringify({ value: "x".repeat(200) })}`,
        tokenBudget: 10,
        globalOverflowPolicy: "drop",
      }),
    ]);

    const result = registry.render({});

    expect(result.prompt).toBe("");
    expect(result.trace.droppedSegmentIds).toEqual(["01_atomic_json"]);
    expect(result.trace.segments[0]).toMatchObject({
      included: false,
      truncated: false,
      reason: "segment_budget",
    });
  });

  it("caches only cacheable segments with a safe non-null key", () => {
    const cachedRender = vi.fn(() => "cached");
    const nullKeyRender = vi.fn(() => "null-key");
    const unsafeKeyRender = vi.fn(() => "unsafe-key");
    const dynamicRender = vi.fn(() => "dynamic");
    const registry = new PromptSegmentRegistry<TestContext>([
      {
        ...segment({ id: "01_cached", content: "unused" }),
        cacheable: true,
        cacheKey: () => "character:1",
        render: cachedRender,
      },
      {
        ...segment({ id: "02_null", content: "unused" }),
        cacheable: true,
        cacheKey: () => null,
        render: nullKeyRender,
      },
      {
        ...segment({ id: "03_unsafe", content: "unused" }),
        cacheable: true,
        cacheKey: () => "private value with spaces",
        render: unsafeKeyRender,
      },
      {
        ...segment({ id: "04_dynamic", content: "unused" }),
        cacheable: false,
        cacheKey: () => "character:1",
        render: dynamicRender,
      },
    ]);

    registry.render({ value: "first" });
    const second = registry.render({ value: "second" });

    expect(cachedRender).toHaveBeenCalledTimes(1);
    expect(nullKeyRender).toHaveBeenCalledTimes(2);
    expect(unsafeKeyRender).toHaveBeenCalledTimes(2);
    expect(dynamicRender).toHaveBeenCalledTimes(2);
    expect(
      second.trace.segments.find((item) => item.id === "01_cached")?.cacheHit,
    ).toBe(true);
  });

  it("keeps the trace content-free", () => {
    const secret = "TRACE_MUST_NOT_STORE_THIS_CONTENT";
    const registry = new PromptSegmentRegistry<TestContext>([
      segment({ id: "01_secret", content: secret }),
    ]);
    const result = registry.render({});
    expect(result.prompt).toContain(secret);
    expect(JSON.stringify(result.trace)).not.toContain(secret);
    expect(Object.keys(result.trace.segments[0] ?? {})).not.toContain(
      "content",
    );
  });
});

describe("default prompt segments", () => {
  it("defines exactly the plan's 17 stable ids", () => {
    const defaults = createDefaultPromptSegments();
    expect(defaults.map((item) => item.id)).toEqual(DEFAULT_PROMPT_SEGMENT_IDS);
    expect(new Set(defaults.map((item) => item.id)).size).toBe(17);
    expect(
      defaults.find((item) => item.id === "12_future_schedule")
        ?.globalOverflowPolicy,
    ).toBe("drop");
    expect(
      defaults
        .filter((item) => item.id !== "12_future_schedule")
        .every((item) => item.globalOverflowPolicy === undefined),
    ).toBe(true);
  });

  it("marks runtime, user, evidence, calendar, and follow-up content as uncacheable", () => {
    const defaults = createDefaultPromptSegments();
    const dynamicIds = [
      "07_user_model",
      "08_runtime_state",
      "09_relationship",
      "10_current_time",
      "11_current_activity",
      "12_future_schedule",
      "13_retrieved_evidence",
      "14_recent_verbatim",
      "15_reply_strategy",
      "16_user_message",
      "17_output_contract",
    ];
    for (const id of dynamicIds) {
      expect(defaults.find((item) => item.id === id)?.cacheable).toBe(false);
    }
    expect(createCalendarContextPromptSegment().cacheable).toBe(false);
    expect(createFollowUpContextPromptSegment().cacheable).toBe(false);
  });

  it("hard-bounds a context containing ten thousand messages", () => {
    const registry = new PromptSegmentRegistry(createDefaultPromptSegments());
    const recentVerbatim = Array.from({ length: 10_000 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: "message-" + index + "-" + "x".repeat(200),
    }));
    const result = registry.render(
      {
        appPolicyCacheKey: "policy:v1",
        characterCacheKey: "character:1",
        characterIdentity: { name: "Lin" },
        corePersona: { traits: ["steady"] },
        boundaries: ["stay truthful"],
        currentTime: "2026-08-21T00:00:00.000Z",
        recentVerbatim,
        replyStrategy: { deliveryMode: "single_block" },
        userMessage: "Hello",
        outputContract: { text: "string" },
      },
      { maxInputTokens: 1_024 },
    );

    expect(result.trace.estimatedInputTokens).toBeLessThanOrEqual(1_024);
    expect(
      estimatePromptTokens(result.system) + estimatePromptTokens(result.prompt),
    ).toBeLessThanOrEqual(1_024);
    expect(JSON.stringify(result.trace)).not.toContain("message-9999");
  });
});
