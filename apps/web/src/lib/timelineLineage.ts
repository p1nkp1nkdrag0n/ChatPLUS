import type { TimelineEvent } from "../api/types";

export type TimelineLineageInput = Partial<
  Pick<
    TimelineEvent,
    | "sourceIntentId"
    | "scheduleItemId"
    | "activityEventId"
    | "memoryId"
    | "proactiveCandidateId"
    | "messageId"
  >
>;

export interface TimelineLineageNode {
  field: keyof TimelineLineageInput;
  label: string;
  id: string;
}

const LINEAGE_FIELDS = [
  { field: "sourceIntentId", label: "PersonalIntent" },
  { field: "scheduleItemId", label: "ScheduleItem" },
  { field: "activityEventId", label: "ActivityEvent" },
  { field: "memoryId", label: "Memory" },
  { field: "proactiveCandidateId", label: "ProactiveCandidate" },
  { field: "messageId", label: "Message" },
] as const satisfies ReadonlyArray<{
  field: keyof TimelineLineageInput;
  label: string;
}>;

export function buildTimelineLineage(
  input: TimelineLineageInput,
): TimelineLineageNode[] {
  const nodes: TimelineLineageNode[] = [];
  for (const { field, label } of LINEAGE_FIELDS) {
    const id = input[field];
    if (typeof id === "string" && id.length > 0) {
      nodes.push({ field, label, id });
    }
  }
  return nodes;
}
