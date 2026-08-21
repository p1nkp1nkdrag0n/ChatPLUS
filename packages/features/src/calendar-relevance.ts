import type {
  CalendarEntry,
  CalendarPromptItem,
  CalendarScope,
} from "@personasim/contracts";

export interface CalendarDateRange {
  startLocalDateInclusive: string;
  endLocalDateExclusive: string;
}

export interface SelectCalendarPromptContextInput {
  entries: readonly CalendarEntry[];
  agentId: string;
  query: string;
  dateRange?: CalendarDateRange;
  explicitDateQuery: boolean;
  limit?: number;
}

export function buildCalendarDedupeKey(input: {
  agentId?: string;
  scope: CalendarScope;
  title: string;
  localDate: string;
  recurrence: "none" | "yearly";
}): string {
  return [
    input.scope,
    input.agentId ?? "public",
    input.recurrence,
    input.localDate,
    normalizeText(input.title),
  ].join(":");
}

export function selectCalendarPromptContext(
  input: SelectCalendarPromptContextInput,
): CalendarPromptItem[] {
  const limit = Math.max(0, Math.min(input.limit ?? 8, 20));
  if (limit === 0) return [];
  const query = normalizeText(input.query);

  const selected = input.entries
    .filter((entry) => entry.status === "active")
    .filter(
      (entry) => entry.agentId === undefined || entry.agentId === input.agentId,
    )
    .map((entry) => {
      const occurrenceDate = resolveOccurrenceDate(entry, input.dateRange);
      const dateRelevant = occurrenceDate !== undefined;
      const lexicalRelevant = calendarLexicalMatch(entry, query);
      const relevant =
        entry.scope === "user_private"
          ? lexicalRelevant || (input.explicitDateQuery && dateRelevant)
          : lexicalRelevant || dateRelevant;
      return relevant
        ? {
            entry,
            localDate: occurrenceDate ?? entry.localDate,
          }
        : undefined;
    })
    .filter(
      (
        item,
      ): item is {
        entry: CalendarEntry;
        localDate: string;
      } => item !== undefined,
    )
    .sort((left, right) => {
      const date = left.localDate.localeCompare(right.localDate);
      if (date !== 0) return date;
      const scope =
        scopePriority(left.entry.scope) - scopePriority(right.entry.scope);
      if (scope !== 0) return scope;
      return left.entry.title.localeCompare(right.entry.title);
    })
    .slice(0, limit);

  return selected.map(({ entry, localDate }, index) => ({
    ref: "calendar_" + (index + 1),
    scope: entry.scope,
    label: renderLabel(entry),
    localDate,
    allDay: entry.allDay,
  }));
}

function calendarLexicalMatch(entry: CalendarEntry, query: string): boolean {
  if (query === "") return false;
  const candidates = [entry.title, entry.description ?? ""]
    .flatMap(searchTerms)
    .filter((term) => term.length >= 2);
  return candidates.some((term) => query.includes(term));
}

function searchTerms(value: string): string[] {
  const normalized = normalizeText(value);
  const terms = normalized.split(/[^\p{Letter}\p{Number}]+/u).filter(Boolean);
  const hanSequences = normalized.match(/\p{Script=Han}+/gu) ?? [];
  for (const sequence of hanSequences) {
    terms.push(sequence);
    for (let index = 0; index < sequence.length - 1; index += 1) {
      terms.push(sequence.slice(index, index + 2));
    }
  }
  return [...new Set(terms)];
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

function resolveOccurrenceDate(
  entry: CalendarEntry,
  range: CalendarDateRange | undefined,
): string | undefined {
  if (range === undefined) return undefined;
  if (range.startLocalDateInclusive >= range.endLocalDateExclusive) {
    throw new TypeError("Calendar date range must be increasing");
  }
  if (entry.recurrence === "none") {
    return entry.localDate >= range.startLocalDateInclusive &&
      entry.localDate < range.endLocalDateExclusive
      ? entry.localDate
      : undefined;
  }

  const monthDay = entry.localDate.slice(5);
  const startYear = Number(range.startLocalDateInclusive.slice(0, 4));
  const endYear = Number(range.endLocalDateExclusive.slice(0, 4));
  for (let year = startYear; year <= endYear; year += 1) {
    const candidate = String(year).padStart(4, "0") + "-" + monthDay;
    if (
      candidate >= range.startLocalDateInclusive &&
      candidate < range.endLocalDateExclusive
    ) {
      return candidate;
    }
  }
  return undefined;
}

function renderLabel(entry: CalendarEntry): string {
  const time = entry.allDay
    ? "all-day"
    : entry.startLocalTime +
      (entry.endLocalTime === undefined ? "" : "-" + entry.endLocalTime);
  return [time, entry.title, entry.description]
    .filter((value): value is string => value !== undefined)
    .join(" | ")
    .slice(0, 500);
}

function scopePriority(scope: CalendarScope): number {
  if (scope === "public_system") return 0;
  if (scope === "character_world") return 1;
  return 2;
}
