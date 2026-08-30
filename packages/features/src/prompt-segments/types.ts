export type PromptSegmentPlacement = "system" | "prompt";
export type PromptSegmentGlobalOverflowPolicy = "truncate" | "drop";

/**
 * Prompt segments intentionally accept a structural context. The future server
 * composition can add bounded fields without coupling this pure feature layer
 * to a particular orchestration service.
 */
export interface PromptContext {
  readonly [key: string]: unknown;
}

export interface PromptSegment<TContext extends PromptContext = PromptContext> {
  readonly id: string;
  readonly placement: PromptSegmentPlacement;
  readonly priority: number;
  readonly tokenBudget: number;
  readonly required: boolean;
  readonly cacheable: boolean;
  /**
   * Defaults to truncate. `drop` keeps an optional structured segment atomic:
   * exceeding either its own token budget or the global input budget omits the
   * complete segment instead of slicing its payload.
   */
  readonly globalOverflowPolicy?: PromptSegmentGlobalOverflowPolicy;
  readonly cacheKey?: (context: TContext) => string | null;
  render(context: TContext): string | null;
}

export type PromptSegmentTraceReason =
  "empty" | "segment_budget" | "global_budget" | "required_budget_too_small";

export interface PromptSegmentTrace {
  readonly id: string;
  readonly placement: PromptSegmentPlacement;
  readonly priority: number;
  readonly tokenBudget: number;
  readonly estimatedTokens: number;
  readonly required: boolean;
  readonly included: boolean;
  readonly truncated: boolean;
  readonly cacheHit: boolean;
  readonly reason?: PromptSegmentTraceReason;
}

/** Contains only sizes and identifiers; rendered content is never retained. */
export interface PromptAssemblyTrace {
  readonly segments: readonly PromptSegmentTrace[];
  readonly droppedSegmentIds: readonly string[];
  readonly estimatedInputTokens: number;
}

export interface PromptAssemblyResult {
  readonly system: string;
  readonly prompt: string;
  readonly trace: PromptAssemblyTrace;
}

export interface PromptRenderOptions {
  readonly maxInputTokens?: number;
}

export type PromptSegmentRegistryErrorCode =
  | "duplicate_segment_id"
  | "invalid_segment"
  | "required_segments_exceed_budget";

export class PromptSegmentRegistryError extends Error {
  constructor(
    readonly code: PromptSegmentRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PromptSegmentRegistryError";
  }
}
