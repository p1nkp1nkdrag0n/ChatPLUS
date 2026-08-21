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
  if (value.length <= maximumCharacters) return value;
  if (maximumCharacters === 1) return ".";
  return value.slice(0, maximumCharacters - 3) + "...";
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

    for (const segment of this.list()) {
      const rendered = this.#renderSegment(segment, context);
      if (rendered.content === null || rendered.content.trim() === "") {
        empty.push({ segment, cacheHit: rendered.cacheHit });
        continue;
      }
      const normalized = rendered.content.trim();
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

    const required = candidates.filter(({ segment }) => segment.required);
    const optional = candidates
      .filter(({ segment }) => !segment.required)
      .sort(compareOptionalPriority);
    fitRequiredCandidates(required, maximumTokens);

    const selected = [...required];
    const dropped = new Set<string>();
    for (const candidate of optional) {
      if (maximumTokens === undefined) {
        selected.push(candidate);
        continue;
      }
      if (assemblyTokens([...selected, candidate]) <= maximumTokens) {
        selected.push(candidate);
        continue;
      }
      const fitted = fitOptionalCandidate(selected, candidate, maximumTokens);
      if (fitted) selected.push(candidate);
      else dropped.add(candidate.segment.id);
    }

    const ordered = selected.sort(compareCandidateIds);
    const system = joinPlacement(ordered, "system");
    const prompt = joinPlacement(ordered, "prompt");
    const selectedIds = new Set(ordered.map(({ segment }) => segment.id));
    const traces = buildTrace(candidates, empty, selectedIds, dropped);

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
  if (!Number.isInteger(segment.tokenBudget) || segment.tokenBudget < 1) {
    throw new PromptSegmentRegistryError(
      "invalid_segment",
      'Prompt segment "' +
        segment.id +
        '" must have a positive integer token budget.',
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
      .filter((candidate) => candidate.content.length > 1)
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
    largest.content = largest.content.slice(
      0,
      Math.max(1, largest.content.length - Math.max(1, excess * 4)),
    );
    largest.globallyTruncated = true;
  }
}

function fitOptionalCandidate<TContext extends PromptContext>(
  selected: readonly Candidate<TContext>[],
  candidate: Candidate<TContext>,
  maximumTokens: number,
): boolean {
  let low = 1;
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
    candidate.content = candidate.content.slice(0, best);
    candidate.globallyTruncated = true;
  }
  return true;
}

function buildTrace<TContext extends PromptContext>(
  candidates: readonly Candidate<TContext>[],
  empty: readonly EmptyCandidate<TContext>[],
  selectedIds: ReadonlySet<string>,
  droppedIds: ReadonlySet<string>,
): PromptSegmentTrace[] {
  const traceById = new Map<string, PromptSegmentTrace>();
  for (const candidate of candidates) {
    const included = selectedIds.has(candidate.segment.id);
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
      ...(included
        ? {}
        : {
            reason: droppedIds.has(candidate.segment.id)
              ? ("global_budget" as const)
              : ("required_budget_too_small" as const),
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
    .sort(compareCandidateIds)
    .map((candidate) => candidate.content)
    .join("\n");
}

function compareSegmentIds<TContext extends PromptContext>(
  left: PromptSegment<TContext>,
  right: PromptSegment<TContext>,
): number {
  return left.id.localeCompare(right.id);
}

function compareCandidateIds<TContext extends PromptContext>(
  left: Candidate<TContext>,
  right: Candidate<TContext>,
): number {
  return left.segment.id.localeCompare(right.segment.id);
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
