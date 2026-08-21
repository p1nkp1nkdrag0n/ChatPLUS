export type DateDigestFactKind =
  | "activity_event"
  | "shared_memory"
  | "user_event"
  | "schedule_item"
  | "runtime_context";

export interface DateDigestFactLike {
  sourceType: string;
  sourceId: string;
  kind: DateDigestFactKind;
  content: string;
  temporalStatus:
    "planned" | "in_progress" | "occurred" | "cancelled" | "unknown";
  occurredStartAtUtc?: string;
  occurredEndAtUtc?: string;
  reliability: "reliable" | "reported" | "inferred";
  sourceEvidenceIds: readonly string[];
}

export interface DateDigestItem {
  sourceType: string;
  sourceId: string;
  kind: "activity_event" | "shared_memory" | "user_event";
  content: string;
  occurredStartAtUtc: string;
  occurredEndAtUtc?: string;
  sourceEvidenceIds: string[];
}

export interface DateDigest {
  fromUtc: string;
  toUtc: string;
  items: DateDigestItem[];
  sourceEvidenceIds: string[];
}

function overlapsRange(
  fact: DateDigestFactLike,
  fromMs: number,
  toMs: number,
): boolean {
  if (fact.occurredStartAtUtc === undefined) return false;
  const start = Date.parse(fact.occurredStartAtUtc);
  if (!Number.isFinite(start)) return false;
  if (fact.occurredEndAtUtc === undefined) {
    return start >= fromMs && start < toMs;
  }
  const end = Date.parse(fact.occurredEndAtUtc);
  return Number.isFinite(end) && start < toMs && end > fromMs;
}

function isReliableDigestFact(
  fact: DateDigestFactLike,
): fact is DateDigestFactLike & {
  kind: "activity_event" | "shared_memory" | "user_event";
  occurredStartAtUtc: string;
} {
  if (fact.temporalStatus !== "occurred") return false;
  if (
    fact.kind === "schedule_item" ||
    fact.kind === "runtime_context" ||
    fact.reliability === "inferred"
  ) {
    return false;
  }
  if (fact.kind === "activity_event") {
    return (
      fact.reliability === "reliable" && fact.occurredStartAtUtc !== undefined
    );
  }
  return (
    (fact.kind === "shared_memory" || fact.kind === "user_event") &&
    fact.sourceEvidenceIds.length > 0 &&
    fact.occurredStartAtUtc !== undefined
  );
}

export function buildDateDigest(input: {
  fromUtc: string;
  toUtc: string;
  facts: readonly DateDigestFactLike[];
  maxItems?: number;
}): DateDigest | undefined {
  const fromMs = Date.parse(input.fromUtc);
  const toMs = Date.parse(input.toUtc);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    throw new TypeError("Date digest requires a chronological UTC range");
  }
  const maxItems = Math.max(1, Math.min(100, input.maxItems ?? 20));
  const seen = new Set<string>();
  const items: DateDigestItem[] = [];
  for (const fact of [...input.facts].sort((left, right) =>
    (left.occurredStartAtUtc ?? "").localeCompare(
      right.occurredStartAtUtc ?? "",
    ),
  )) {
    if (!isReliableDigestFact(fact) || !overlapsRange(fact, fromMs, toMs)) {
      continue;
    }
    const key = `${fact.sourceType}:\u0000${fact.sourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      sourceType: fact.sourceType,
      sourceId: fact.sourceId,
      kind: fact.kind,
      content: fact.content.trim(),
      occurredStartAtUtc: fact.occurredStartAtUtc,
      ...(fact.occurredEndAtUtc === undefined
        ? {}
        : { occurredEndAtUtc: fact.occurredEndAtUtc }),
      sourceEvidenceIds: [...new Set(fact.sourceEvidenceIds)],
    });
    if (items.length >= maxItems) break;
  }
  if (items.length === 0) return undefined;
  return {
    fromUtc: input.fromUtc,
    toUtc: input.toUtc,
    items,
    sourceEvidenceIds: [
      ...new Set(items.flatMap((item) => item.sourceEvidenceIds)),
    ],
  };
}
