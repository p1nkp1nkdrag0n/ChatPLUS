import {
  CalendarEntryDraftSchema,
  CalendarEntrySchema,
  CalendarSourceSchema,
  type CalendarEntry,
  type CalendarEntryDraft,
  type CalendarPromptItem,
  type CalendarScope,
  type CalendarSource,
} from "@personasim/contracts";
import {
  buildCalendarDedupeKey,
  selectCalendarPromptContext,
  type CalendarDateRange,
} from "@personasim/features";

import { ApiError, notFound } from "../domain/errors.js";
import { createEntityId } from "../domain/id.js";
import type { Clock } from "../runtime/clock.js";
import type {
  CalendarRepository,
  CalendarEntryListInput,
} from "../repositories/calendar-repository.js";

export interface CreateCalendarEntryInput {
  agentId?: string;
  draft: CalendarEntryDraft;
  source?: CalendarSource;
}

export interface UpdateCalendarEntryInput {
  agentId?: string;
  entryId: string;
  expectedRevision: number;
  draft: CalendarEntryDraft;
}

export interface ArchiveCalendarEntryInput {
  agentId?: string;
  entryId: string;
  expectedRevision: number;
}

export interface CalendarPromptContextInput {
  agentId: string;
  query: string;
  dateRange?: CalendarDateRange;
  explicitDateQuery: boolean;
  scopes?: readonly CalendarScope[];
  limit?: number;
}

export class CalendarService {
  constructor(
    private readonly repository: CalendarRepository,
    private readonly clock: Clock,
  ) {}

  create(input: CreateCalendarEntryInput): CalendarEntry {
    const draft = CalendarEntryDraftSchema.parse(input.draft);
    const source = CalendarSourceSchema.parse(input.source ?? "manual");
    const nowUtc = this.clock.nowUtc();
    const entry = CalendarEntrySchema.parse({
      id: createEntityId("calendar"),
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...draft,
      source,
      status: "active",
      dedupeKey: calendarDedupeKey(input.agentId, draft),
      revision: 0,
      createdAtUtc: nowUtc,
      updatedAtUtc: nowUtc,
    });
    return this.repository.insert(entry);
  }

  get(entryId: string, agentId?: string): CalendarEntry {
    const entry = this.repository.findById(entryId);
    if (entry === undefined || !isVisible(entry, agentId)) {
      throw notFound("Calendar entry");
    }
    return entry;
  }

  list(input: CalendarEntryListInput = {}): CalendarEntry[] {
    return this.repository.listVisible(input);
  }

  update(input: UpdateCalendarEntryInput): CalendarEntry {
    const current = this.get(input.entryId, input.agentId);
    assertOwned(current, input.agentId);
    const draft = CalendarEntryDraftSchema.parse(input.draft);
    const updated = CalendarEntrySchema.parse({
      ...current,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...draft,
      dedupeKey: calendarDedupeKey(input.agentId, draft),
      revision: input.expectedRevision + 1,
      updatedAtUtc: this.clock.nowUtc(),
    });
    if (!this.repository.compareAndSet(updated, input.expectedRevision)) {
      throw staleCalendarEntry();
    }
    return updated;
  }

  archive(input: ArchiveCalendarEntryInput): CalendarEntry {
    const current = this.get(input.entryId, input.agentId);
    assertOwned(current, input.agentId);
    if (current.revision !== input.expectedRevision) {
      throw staleCalendarEntry();
    }
    if (current.status === "archived") return current;
    const archived = CalendarEntrySchema.parse({
      ...current,
      status: "archived",
      revision: input.expectedRevision + 1,
      updatedAtUtc: this.clock.nowUtc(),
    });
    if (!this.repository.compareAndSet(archived, input.expectedRevision)) {
      throw staleCalendarEntry();
    }
    return archived;
  }

  selectPromptContext(input: CalendarPromptContextInput): CalendarPromptItem[] {
    const entries = this.repository.listVisible({
      agentId: input.agentId,
      status: "active",
      ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
      ...(input.dateRange === undefined
        ? {}
        : {
            startLocalDateInclusive: input.dateRange.startLocalDateInclusive,
            endLocalDateExclusive: input.dateRange.endLocalDateExclusive,
          }),
      limit: 500,
    });
    return selectCalendarPromptContext({
      entries,
      agentId: input.agentId,
      query: input.query,
      ...(input.dateRange === undefined ? {} : { dateRange: input.dateRange }),
      explicitDateQuery: input.explicitDateQuery,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
  }
}

function calendarDedupeKey(
  agentId: string | undefined,
  draft: CalendarEntryDraft,
): string {
  return buildCalendarDedupeKey({
    ...(agentId === undefined ? {} : { agentId }),
    scope: draft.scope,
    title: draft.title,
    localDate: draft.localDate,
    recurrence: draft.recurrence,
  });
}

function isVisible(entry: CalendarEntry, agentId: string | undefined): boolean {
  return entry.scope === "public_system" || entry.agentId === agentId;
}

function assertOwned(entry: CalendarEntry, agentId: string | undefined): void {
  if (entry.agentId !== agentId) {
    throw notFound("Calendar entry");
  }
}

function staleCalendarEntry(): ApiError {
  return new ApiError(
    409,
    "calendar_revision_conflict",
    "Calendar entry revision is stale.",
  );
}
