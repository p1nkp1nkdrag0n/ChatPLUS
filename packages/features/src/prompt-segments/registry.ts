import type {
  PromptAssemblyResult,
  PromptContext,
  PromptRenderOptions,
  PromptSegment,
  PromptSegmentTrace,
} from "./types.js";
import { PromptSegmentRegistryError } from "./types.js";

const SEGMENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,119}$/u;
const SAFE_CACHE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,239}$/u;

type Candidate<TContext extends PromptContext> = {
  readonly segment: PromptSegment<TContext>;
  content: string;
  readonly originallyTruncated: boolean;
  globallyTruncated: boolean;
  readonly cacheHit: boolean;
};

type EmptyCandidate<TContext extends PromptContext> = {
  readonly segment: PromptSegment<TContext>;
  readonly cacheHit: boolean;
};

export function estimatePromptTokens(value: string): number {
  return value.length === 0 ? 0 : Math.ceil(value.length / 4);
}

export function truncatePromptToTokenBudget(
  value: string,
  tokenBudget: number,
): string {
  if (tokenBudget <= 0 || value.length === 0) return "";
  const maximumCharacters = tokenBudget * 4;
  return truncatePromptToCharacterBudget(value, maximumCharacters);
}

function truncatePromptToCharacterBudget(
  value: string,
  maximumCharacters: number,
): string {
  if (maximumCharacters <= 0 || value.length === 0) return "";
  if (value.length <= maximumCharacters) return value;
  const structured = compactLabeledJson(value, maximumCharacters);
  if (typeof structured === "string") return structured;
  if (structured === null) {
    throw new PromptSegmentRegistryError(
      "required_segments_exceed_budget",
      "The prompt budget is too small to retain a valid structured segment.",
    );
  }
  if (maximumCharacters === 1) return ".";
  return value.slice(0, Math.max(0, maximumCharacters - 3)) + "...";
}

function compactLabeledJson(
  value: string,
  maximumCharacters: number,
): string | null | undefined {
  const referencePrefix = "USER_MODEL_JSON\n";
  if (value.startsWith(referencePrefix + "REFERENCE_CONTEXT_JSON\n")) {
    const nested = compactLabeledJson(
      value.slice(referencePrefix.length),
      maximumCharacters - referencePrefix.length,
    );
    return typeof nested === "string" ? referencePrefix + nested : nested;
  }
  const newline = value.indexOf("\n");
  if (newline <= 0) return undefined;
  const label = value.slice(0, newline);
  if (!/^[A-Z0-9_]+_JSON$/u.test(label)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice(newline + 1));
  } catch {
    return undefined;
  }
  if (label === "AUTOBIOGRAPHY_JSON") {
    return compactWholeAutobiography(label, parsed, maximumCharacters);
  }
  if (label === "CURRENT_USER_MESSAGE_JSON") return null;
  if (
    label === "RETRIEVED_EVIDENCE_JSON" ||
    label === "REFERENCE_CONTEXT_JSON" ||
    label === "RECENT_VERBATIM_JSON"
  ) {
    return compactWholeEvidence(label, parsed, maximumCharacters);
  }
  const configurations = [
    [2_000, 20],
    [1_000, 12],
    [600, 8],
    [360, 6],
    [240, 4],
    [160, 3],
    [100, 2],
    [60, 1],
    [32, 1],
  ] as const;
  for (const [maximumString, maximumArray] of configurations) {
    // Recent dialogue is chronological: discard its oldest messages first.
    // Other arrays (including nested message metadata) retain their existing
    // priority-first compaction semantics.
    const selected =
      label === "RECENT_VERBATIM_JSON" && Array.isArray(parsed)
        ? parsed.slice(-maximumArray)
        : parsed;
    const serialized = JSON.stringify(
      compactJsonValue(selected, maximumString, maximumArray),
    );
    const candidate = `${label}\n${serialized}`;
    if (candidate.length <= maximumCharacters) return candidate;
  }
  const marker = `${label}\n{"_truncated":true}`;
  return marker.length <= maximumCharacters ? marker : null;
}

function compactWholeEvidence(
  label: string,
  value: unknown,
  maximumCharacters: number,
): string | null {
  const render = (data: unknown) => `${label}\n${JSON.stringify(data)}`;
  if (Array.isArray(value)) {
    const selected: unknown[] = [];
    // Recent dialogue is chronological; retain only complete messages.
    for (const item of [...(value as unknown[])].reverse()) {
      if (render([item, ...selected]).length <= maximumCharacters)
        selected.unshift(item);
    }
    return render(selected).length <= maximumCharacters
      ? render(selected)
      : null;
  }
  const selected: Record<string, unknown> = { _truncated: true };
  if (render(selected).length > maximumCharacters) return null;
  if (typeof value !== "object" || value === null) return render(selected);
  const original = value as Record<string, unknown>;
  const keep = (key: string, item: unknown) => {
    if (render({ ...selected, [key]: item }).length <= maximumCharacters)
      selected[key] = item;
  };
  for (const [key, item] of Object.entries(original)) {
    if (Array.isArray(item)) {
      selected[key] = [];
      for (const record of item)
        keep(key, [...(selected[key] as unknown[]), record]);
      if (render(selected).length > maximumCharacters) delete selected[key];
    } else {
      // Nested evidence bundles are atomic here. Their dedicated segment can
      // still retain individual records without creating a contradictory copy.
      keep(key, item);
    }
  }
  return render(selected);
}

function compactWholeAutobiography(
  label: string,
  value: unknown,
  maximumCharacters: number,
): string | null {
  const retained: Record<string, unknown> = { _truncated: true };
  const render = (data: Record<string, unknown>) =>
    `${label}\n${JSON.stringify(data)}`;
  if (render(retained).length > maximumCharacters) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return render(retained);
  const original = value as Record<string, unknown>;
  const keep = (key: string, item: unknown) => {
    if (render({ ...retained, [key]: item }).length <= maximumCharacters)
      retained[key] = item;
  };
  for (const key of ["revision", "fromUtc", "throughUtc", "summaryFirstPerson"])
    if (original[key] !== undefined) keep(key, original[key]);

  // The snapshot lists are chronological. Try the newest whole report from
  // each category first, without splitting its quote, condition or negation.
  const lists = Object.entries(original).filter((entry) =>
    Array.isArray(entry[1]),
  ) as [string, unknown[]][];
  const longest = Math.max(0, ...lists.map(([, items]) => items.length));
  for (let offset = 1; offset <= longest; offset += 1) {
    for (const [key, items] of lists) {
      if (offset > items.length) continue;
      const selected = (retained[key] as unknown[] | undefined) ?? [];
      keep(key, [items[items.length - offset], ...selected]);
    }
  }
  return render(retained);
}

function compactJsonValue(
  value: unknown,
  maximumString: number,
  maximumArray: number,
): unknown {
  if (typeof value === "string") {
    if (value.length <= maximumString) return value;
    return value.slice(0, Math.max(1, maximumString - 1)) + "…";
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, maximumArray)
      .map((item) => compactJsonValue(item, maximumString, maximumArray));
  }
  if (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        compactJsonValue(item, maximumString, maximumArray),
      ]),
    );
  }
  return value;
}

function minimumPromptCharacters(value: string): number {
  const referencePrefix = "USER_MODEL_JSON\n";
  if (value.startsWith(referencePrefix + "REFERENCE_CONTEXT_JSON\n"))
    return (
      referencePrefix.length +
      minimumPromptCharacters(value.slice(referencePrefix.length))
    );
  const newline = value.indexOf("\n");
  if (newline <= 0) return 1;
  const label = value.slice(0, newline);
  if (label === "CURRENT_USER_MESSAGE_JSON") return value.length;
  if (!/^[A-Z0-9_]+_JSON$/u.test(label)) return 1;
  try {
    JSON.parse(value.slice(newline + 1));
    return `${label}\n{"_truncated":true}`.length;
  } catch {
    return 1;
  }
}

export class PromptSegmentRegistry<
  TContext extends PromptContext = PromptContext,
> {
  readonly #segments = new Map<string, PromptSegment<TContext>>();
  readonly #cache = new Map<string, string | null>();

  constructor(segments: readonly PromptSegment<TContext>[] = []) {
    for (const segment of segments) this.register(segment);
  }

  register(segment: PromptSegment<TContext>): () => void {
    validateSegment(segment);
    if (this.#segments.has(segment.id)) {
      throw new PromptSegmentRegistryError(
        "duplicate_segment_id",
        'Prompt segment "' + segment.id + '" is already registered.',
      );
    }
    this.#segments.set(segment.id, segment);
    let registered = true;
    return () => {
      if (!registered || this.#segments.get(segment.id) !== segment) return;
      registered = false;
      this.#segments.delete(segment.id);
      this.clearCache(segment.id);
    };
  }

  list(): readonly PromptSegment<TContext>[] {
    return [...this.#segments.values()].sort(compareSegmentIds);
  }

  clearCache(segmentId?: string): void {
    if (segmentId === undefined) {
      this.#cache.clear();
      return;
    }
    const prefix = segmentId + "\u0000";
    for (const key of this.#cache.keys()) {
      if (key.startsWith(prefix)) this.#cache.delete(key);
    }
  }

  render(
    context: TContext,
    options: PromptRenderOptions = {},
  ): PromptAssemblyResult {
    const maximumTokens = normalizeMaximumTokens(options.maxInputTokens);
    const candidates: Candidate<TContext>[] = [];
    const empty: EmptyCandidate<TContext>[] = [];
    const dropped = new Map<string, "segment_budget" | "global_budget">();

    for (const segment of this.list()) {
      const rendered = this.#renderSegment(segment, context);
      if (rendered.content === null || rendered.content.trim() === "") {
        empty.push({ segment, cacheHit: rendered.cacheHit });
        continue;
      }
      const normalized = rendered.content.trim();
      const exceedsSegmentBudget = normalized.length > segment.tokenBudget * 4;
      if (
        !segment.required &&
        segment.globalOverflowPolicy === "drop" &&
        exceedsSegmentBudget
      ) {
        candidates.push({
          segment,
          content: normalized,
          originallyTruncated: false,
          globallyTruncated: false,
          cacheHit: rendered.cacheHit,
        });
        dropped.set(segment.id, "segment_budget");
        continue;
      }
      const content = truncatePromptToTokenBudget(
        normalized,
        segment.tokenBudget,
      );
      candidates.push({
        segment,
        content,
        originallyTruncated: content !== normalized,
        globallyTruncated: false,
        cacheHit: rendered.cacheHit,
      });
    }

    const required = candidates.filter(
      ({ segment }) => segment.required && !dropped.has(segment.id),
    );
    const optional = candidates
      .filter(({ segment }) => !segment.required && !dropped.has(segment.id))
      .sort(compareOptionalPriority);
    fitRequiredCandidates(required, maximumTokens);

    const selected = [...required];
    for (const candidate of optional) {
      if (maximumTokens === undefined) {
        selected.push(candidate);
        continue;
      }
      if (assemblyTokens([...selected, candidate]) <= maximumTokens) {
        selected.push(candidate);
        continue;
      }
      if (candidate.segment.globalOverflowPolicy === "drop") {
        dropped.set(candidate.segment.id, "global_budget");
        continue;
      }
      const fitted = fitOptionalCandidate(selected, candidate, maximumTokens);
      if (fitted) selected.push(candidate);
      else dropped.set(candidate.segment.id, "global_budget");
    }

    const ordered = selected.sort(compareCandidateRenderOrder);
    const system = joinPlacement(ordered, "system");
    const prompt = joinPlacement(ordered, "prompt");
    const renderedIndexes = new Map<string, number>();
    for (const placement of ["system", "prompt"] as const) {
      ordered
        .filter(({ segment }) => segment.placement === placement)
        .forEach(({ segment }, index) =>
          renderedIndexes.set(segment.id, index),
        );
    }
    const traces = buildTrace(candidates, empty, renderedIndexes, dropped);

    return {
      system,
      prompt,
      trace: {
        segments: traces,
        droppedSegmentIds: traces
          .filter((trace) => !trace.included && trace.reason !== "empty")
          .map((trace) => trace.id),
        estimatedInputTokens:
          estimatePromptTokens(system) + estimatePromptTokens(prompt),
      },
    };
  }

  #renderSegment(
    segment: PromptSegment<TContext>,
    context: TContext,
  ): { content: string | null; cacheHit: boolean } {
    const cacheKey = safeCacheKey(segment, context);
    if (cacheKey === undefined) {
      return { content: segment.render(context), cacheHit: false };
    }
    const stored = this.#cache.get(cacheKey);
    if (stored !== undefined || this.#cache.has(cacheKey)) {
      return { content: stored ?? null, cacheHit: true };
    }
    const rendered = segment.render(context);
    const bounded =
      rendered === null
        ? null
        : !segment.required && segment.globalOverflowPolicy === "drop"
          ? rendered.trim()
          : truncatePromptToTokenBudget(rendered.trim(), segment.tokenBudget);
    this.#cache.set(cacheKey, bounded);
    return { content: bounded, cacheHit: false };
  }
}

function validateSegment<TContext extends PromptContext>(
  segment: PromptSegment<TContext>,
): void {
  if (!SEGMENT_ID_PATTERN.test(segment.id)) {
    throw new PromptSegmentRegistryError(
      "invalid_segment",
      'Invalid prompt segment id: "' + segment.id + '".',
    );
  }
  if (!Number.isFinite(segment.priority)) {
    throw new PromptSegmentRegistryError(
      "invalid_segment",
      'Prompt segment "' + segment.id + '" must have a finite priority.',
    );
  }
  if (
    segment.renderOrder !== undefined &&
    !Number.isFinite(segment.renderOrder)
  ) {
    throw new PromptSegmentRegistryError(
      "invalid_segment",
      'Prompt segment "' + segment.id + '" must have a finite render order.',
    );
  }
  if (!Number.isInteger(segment.tokenBudget) || segment.tokenBudget < 1) {
    throw new PromptSegmentRegistryError(
      "invalid_segment",
      'Prompt segment "' +
        segment.id +
        '" must have a positive integer token budget.',
    );
  }
  if (
    segment.globalOverflowPolicy !== undefined &&
    segment.globalOverflowPolicy !== "truncate" &&
    segment.globalOverflowPolicy !== "drop"
  ) {
    throw new PromptSegmentRegistryError(
      "invalid_segment",
      `Prompt segment "${segment.id}" has an invalid global overflow policy.`,
    );
  }
}

function normalizeMaximumTokens(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    throw new PromptSegmentRegistryError(
      "invalid_segment",
      "maxInputTokens must be a positive integer.",
    );
  }
  return value;
}

function safeCacheKey<TContext extends PromptContext>(
  segment: PromptSegment<TContext>,
  context: TContext,
): string | undefined {
  if (!segment.cacheable || segment.cacheKey === undefined) return undefined;
  const key = segment.cacheKey(context);
  if (key === null || !SAFE_CACHE_KEY_PATTERN.test(key)) return undefined;
  return segment.id + "\u0000" + key;
}

function fitRequiredCandidates<TContext extends PromptContext>(
  required: Candidate<TContext>[],
  maximumTokens: number | undefined,
): void {
  if (
    maximumTokens === undefined ||
    assemblyTokens(required) <= maximumTokens
  ) {
    return;
  }
  while (assemblyTokens(required) > maximumTokens) {
    const largest = [...required]
      .filter(
        (candidate) =>
          candidate.content.length > minimumPromptCharacters(candidate.content),
      )
      .sort(
        (left, right) =>
          right.content.length - left.content.length ||
          left.segment.id.localeCompare(right.segment.id),
      )[0];
    if (largest === undefined) {
      throw new PromptSegmentRegistryError(
        "required_segments_exceed_budget",
        "The global prompt budget is too small to retain every required segment.",
      );
    }
    const excess = assemblyTokens(required) - maximumTokens;
    const minimumCharacters = minimumPromptCharacters(largest.content);
    largest.content = truncatePromptToCharacterBudget(
      largest.content,
      Math.max(
        minimumCharacters,
        largest.content.length - Math.max(1, excess * 4),
      ),
    );
    largest.globallyTruncated = true;
  }
}

function fitOptionalCandidate<TContext extends PromptContext>(
  selected: readonly Candidate<TContext>[],
  candidate: Candidate<TContext>,
  maximumTokens: number,
): boolean {
  let low = minimumPromptCharacters(candidate.content);
  let high = candidate.content.length;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const original = candidate.content;
    candidate.content = original.slice(0, middle);
    const fits = assemblyTokens([...selected, candidate]) <= maximumTokens;
    candidate.content = original;
    if (fits) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best === 0) return false;
  if (best < candidate.content.length) {
    candidate.content = truncatePromptToCharacterBudget(
      candidate.content,
      best,
    );
    candidate.globallyTruncated = true;
  }
  return true;
}

function buildTrace<TContext extends PromptContext>(
  candidates: readonly Candidate<TContext>[],
  empty: readonly EmptyCandidate<TContext>[],
  renderedIndexes: ReadonlyMap<string, number>,
  droppedReasons: ReadonlyMap<string, "segment_budget" | "global_budget">,
): PromptSegmentTrace[] {
  const traceById = new Map<string, PromptSegmentTrace>();
  for (const candidate of candidates) {
    const renderedIndex = renderedIndexes.get(candidate.segment.id);
    const included = renderedIndex !== undefined;
    traceById.set(candidate.segment.id, {
      id: candidate.segment.id,
      placement: candidate.segment.placement,
      priority: candidate.segment.priority,
      tokenBudget: candidate.segment.tokenBudget,
      estimatedTokens: estimatePromptTokens(candidate.content),
      required: candidate.segment.required,
      included,
      truncated: candidate.originallyTruncated || candidate.globallyTruncated,
      cacheHit: candidate.cacheHit,
      localCacheHit: candidate.cacheHit,
      ...(included
        ? { renderedIndex, renderedCharacters: candidate.content.length }
        : {}),
      ...(included
        ? {}
        : {
            reason:
              droppedReasons.get(candidate.segment.id) ??
              ("required_budget_too_small" as const),
          }),
    });
  }
  for (const item of empty) {
    traceById.set(item.segment.id, {
      id: item.segment.id,
      placement: item.segment.placement,
      priority: item.segment.priority,
      tokenBudget: item.segment.tokenBudget,
      estimatedTokens: 0,
      required: item.segment.required,
      included: false,
      truncated: false,
      cacheHit: item.cacheHit,
      localCacheHit: item.cacheHit,
      reason: "empty",
    });
  }
  return [...traceById.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

function assemblyTokens<TContext extends PromptContext>(
  candidates: readonly Candidate<TContext>[],
): number {
  return (
    estimatePromptTokens(joinPlacement(candidates, "system")) +
    estimatePromptTokens(joinPlacement(candidates, "prompt"))
  );
}

function joinPlacement<TContext extends PromptContext>(
  candidates: readonly Candidate<TContext>[],
  placement: "system" | "prompt",
): string {
  return candidates
    .filter((candidate) => candidate.segment.placement === placement)
    .sort(compareCandidateRenderOrder)
    .map((candidate) => candidate.content)
    .join("\n");
}

function compareSegmentIds<TContext extends PromptContext>(
  left: PromptSegment<TContext>,
  right: PromptSegment<TContext>,
): number {
  return left.id.localeCompare(right.id);
}

function compareCandidateRenderOrder<TContext extends PromptContext>(
  left: Candidate<TContext>,
  right: Candidate<TContext>,
): number {
  return (
    (left.segment.renderOrder ?? 0) - (right.segment.renderOrder ?? 0) ||
    left.segment.id.localeCompare(right.segment.id)
  );
}

function compareOptionalPriority<TContext extends PromptContext>(
  left: Candidate<TContext>,
  right: Candidate<TContext>,
): number {
  return (
    right.segment.priority - left.segment.priority ||
    left.segment.id.localeCompare(right.segment.id)
  );
}
