import type {
  KeepsakeKind,
  KeepsakeListQuery,
  KeepsakeSourceType,
  KeepsakeSummaryResponse,
  RelationshipArchiveEntry,
  RelationshipArchiveFilter,
  ShareRedaction,
} from "@personasim/contracts";

export const relationshipArchiveQueryKeys = {
  root: (agentId: string) => ["relationship-archive", agentId] as const,
  page: (agentId: string, filter: RelationshipArchiveFilter) =>
    ["relationship-archive", agentId, filter] as const,
  entry: (agentId: string, entryId: string) =>
    ["relationship-archive", agentId, "entry", entryId] as const,
  keepsakes: (
    agentId: string,
    input: Partial<
      Pick<KeepsakeListQuery, "cursor" | "kind" | "sourceType" | "period">
    > = {},
  ) =>
    [
      "keepsakes",
      agentId,
      input.cursor ?? "first",
      input.kind ?? "all",
      input.sourceType ?? "all",
      input.period ?? "all",
    ] as const,
  keepsake: (keepsakeId: string) => ["keepsake", keepsakeId] as const,
};

export const ARCHIVE_FILTERS: ReadonlyArray<{
  value: RelationshipArchiveFilter;
  label: string;
}> = [
  { value: "all", label: "全部" },
  { value: "correspondence", label: "信件" },
  { value: "turning_points", label: "重要时刻" },
  { value: "life", label: "生活" },
  { value: "keepsakes", label: "纪念物" },
];

export const KEEPSAKE_KIND_LABELS: Readonly<Record<KeepsakeKind, string>> = {
  postcard: "明信片",
  ticket_stub: "票根",
  polaroid: "拍立得",
  sketch: "速写",
  pressed_flower: "压花",
  recipe_or_note_card: "手写卡片",
};

export const SOURCE_TYPE_LABELS: Readonly<Record<KeepsakeSourceType, string>> =
  {
    life_outcome: "已确认的经历",
    relationship_milestone: "关系里程碑",
    reflection: "回顾与反思",
    letter: "已归档的信件",
  };

export interface ArchiveMonthGroup {
  key: string;
  label: string;
  items: RelationshipArchiveEntry[];
}

export function groupArchiveByMonth(
  entries: readonly RelationshipArchiveEntry[],
  locale = "zh-CN",
  timezone = "UTC",
): ArchiveMonthGroup[] {
  const formatter = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    timeZone: timezone,
  });
  const keyFormatter = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    timeZone: timezone,
  });
  const groups = new Map<string, ArchiveMonthGroup>();
  for (const entry of entries) {
    const date = new Date(entry.effectiveAtUtc);
    const parts = keyFormatter.formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value ?? "0000";
    const month = parts.find((part) => part.type === "month")?.value ?? "00";
    const key = `${year}-${month}`;
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(entry);
    } else {
      groups.set(key, {
        key,
        label: formatter.format(date),
        items: [entry],
      });
    }
  }
  return [...groups.values()];
}

export function formatArchiveDate(
  value: string,
  timezone = "UTC",
  includeTime = true,
): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    ...(includeTime
      ? { hour: "2-digit", minute: "2-digit", hour12: false }
      : {}),
    timeZone: timezone,
  }).format(new Date(value));
}

export function archiveEntryTypeLabel(entry: RelationshipArchiveEntry): string {
  switch (entry.entryType) {
    case "letter":
      return entry.direction === "user_to_agent" ? "寄出的信" : "收到的信";
    case "turning_point":
      return SOURCE_TYPE_LABELS[entry.sourceType];
    case "life":
      return entry.periodLabel;
    case "keepsake":
      return KEEPSAKE_KIND_LABELS[entry.keepsakeKind];
  }
}

const ARCHIVE_TITLE_PROJECTIONS: Readonly<Record<string, string>> = {
  "character.created": "初次建立这段关系",
  "character.published": "角色正式走入这段关系",
  "life.daily_context_created": "一天的生活开始展开",
  "life.thread_created": "一条生活线索开始",
};

export function archiveEntryDisplayTitle(
  entry: RelationshipArchiveEntry,
): string {
  return ARCHIVE_TITLE_PROJECTIONS[entry.title] ?? entry.title;
}

export function canUseLetterForExcerpt(
  entry: RelationshipArchiveEntry,
): boolean {
  return (
    entry.entryType === "letter" &&
    (entry.direction === "user_to_agent" || entry.status === "read")
  );
}

export interface RedactionSegment {
  text: string;
  redacted: boolean;
  label?: ShareRedaction["label"];
}

export function redactForPreview(
  excerpt: string,
  redactions: readonly ShareRedaction[],
): RedactionSegment[] {
  const segments: RedactionSegment[] = [];
  let cursor = 0;
  for (const redaction of redactions) {
    if (
      redaction.start < cursor ||
      redaction.start >= redaction.end ||
      redaction.end > excerpt.length
    ) {
      continue;
    }
    if (redaction.start > cursor) {
      segments.push({
        text: excerpt.slice(cursor, redaction.start),
        redacted: false,
      });
    }
    segments.push({
      text: "█".repeat(redaction.end - redaction.start),
      redacted: true,
      label: redaction.label,
    });
    cursor = redaction.end;
  }
  if (cursor < excerpt.length) {
    segments.push({ text: excerpt.slice(cursor), redacted: false });
  }
  return segments;
}

export function addRedaction(
  current: readonly ShareRedaction[],
  excerpt: string,
  start: number,
  end: number,
  label: ShareRedaction["label"],
): ShareRedaction[] {
  if (start < 0 || start >= end || end > excerpt.length) return [...current];
  const next = [...current, { start, end, label }].toSorted(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  for (let index = 1; index < next.length; index += 1) {
    const previous = next[index - 1];
    const candidate = next[index];
    if (previous && candidate && candidate.start < previous.end) {
      return [...current];
    }
  }
  return next;
}

export function safeShareLetters(
  entries: readonly RelationshipArchiveEntry[],
): RelationshipArchiveEntry[] {
  return entries.filter(canUseLetterForExcerpt);
}

export function shareEnvelopeLetters(
  entries: readonly RelationshipArchiveEntry[],
): RelationshipArchiveEntry[] {
  return entries.filter((entry) => entry.entryType === "letter");
}

export function selectRelationshipShareSources(
  entries: readonly RelationshipArchiveEntry[],
  selectedArchiveEntry: RelationshipArchiveEntry | undefined,
  selectedKeepsake: KeepsakeSummaryResponse | undefined,
): { letterId?: string; keepsakeId?: string } {
  const letter =
    selectedArchiveEntry?.entryType === "letter"
      ? selectedArchiveEntry
      : entries.find((entry) => entry.entryType === "letter");
  const keepsakeId =
    selectedArchiveEntry?.entryType === "keepsake"
      ? selectedArchiveEntry.keepsakeId
      : selectedKeepsake?.id;
  return {
    ...(letter?.entryType === "letter" ? { letterId: letter.letterId } : {}),
    ...(keepsakeId === undefined ? {} : { keepsakeId }),
  };
}
