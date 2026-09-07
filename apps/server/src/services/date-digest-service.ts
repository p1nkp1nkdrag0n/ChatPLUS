import {
  buildDateDigest,
  resolveTemporalQuery,
  type DateDigest,
  type TemporalAnchorLike,
  type TemporalQueryResolution,
} from "@personasim/features";

import type { ContinuityMemoryRepository } from "./continuity-memory-repository.js";

export interface DateDigestQueryResult {
  resolution: TemporalQueryResolution;
  digest?: DateDigest;
}

export class DateDigestService {
  constructor(private readonly repository: ContinuityMemoryRepository) {}

  build(input: {
    agentId: string;
    fromUtc: string;
    toUtc: string;
    maxItems?: number;
    nowUtc?: string;
    suppressedMemoryIds?: readonly string[];
  }): DateDigest | undefined {
    const facts = this.repository.listDateDigestFacts(input);
    return buildDateDigest({
      fromUtc: input.fromUtc,
      toUtc: input.toUtc,
      facts,
      ...(input.maxItems === undefined ? {} : { maxItems: input.maxItems }),
    });
  }

  query(input: {
    agentId: string;
    text: string;
    nowUtc: string;
    timezone: string;
    anchors?: readonly TemporalAnchorLike[];
    maxItems?: number;
    suppressedMemoryIds?: readonly string[];
  }): DateDigestQueryResult {
    const resolution = resolveTemporalQuery({
      text: input.text,
      nowUtc: input.nowUtc,
      timezone: input.timezone,
      ...(input.anchors === undefined ? {} : { anchors: input.anchors }),
    });
    if (resolution.kind !== "resolved") return { resolution };
    const digest = this.build({
      agentId: input.agentId,
      fromUtc: resolution.fromUtc,
      toUtc: resolution.toUtc,
      nowUtc: input.nowUtc,
      suppressedMemoryIds: input.suppressedMemoryIds ?? [],
      ...(input.maxItems === undefined ? {} : { maxItems: input.maxItems }),
    });
    return {
      resolution,
      ...(digest === undefined ? {} : { digest }),
    };
  }
}
