import type {
  Letter,
  LetterGenerationRunStatus,
  LetterStatus,
  TemporalTaskStatus,
} from "@personasim/contracts";

export type CorrespondenceStateMachineEntity =
  "letter" | "letter_generation_run" | "temporal_task";

export type CorrespondenceStateMachineErrorCode =
  | "invalid_letter_status_transition"
  | "invalid_generation_run_status_transition"
  | "invalid_temporal_task_status_transition"
  | "immutable_letter_field";

export class CorrespondenceStateMachineError extends Error {
  constructor(
    readonly code: CorrespondenceStateMachineErrorCode,
    readonly entity: CorrespondenceStateMachineEntity,
    message: string,
    readonly details: Readonly<{
      from?: string;
      to?: string;
      field?: keyof Letter;
    }> = {},
  ) {
    super(message);
    this.name = "CorrespondenceStateMachineError";
  }
}

const LETTER_STATUS_TRANSITIONS = {
  draft: ["sealed", "in_transit", "cancelled"],
  sealed: ["in_transit"],
  in_transit: ["delivered_unread"],
  delivered_unread: ["read"],
  read: [],
  cancelled: [],
} as const satisfies Readonly<Record<LetterStatus, readonly LetterStatus[]>>;

const GENERATION_RUN_STATUS_TRANSITIONS = {
  pending: ["generating", "failed", "discarded"],
  generating: ["retryable", "committed", "failed", "discarded"],
  retryable: ["generating", "failed", "discarded"],
  committed: [],
  failed: [],
  discarded: [],
} as const satisfies Readonly<
  Record<LetterGenerationRunStatus, readonly LetterGenerationRunStatus[]>
>;

const TEMPORAL_TASK_STATUS_TRANSITIONS = {
  pending: ["claimed", "dead_letter"],
  claimed: ["completed", "retryable", "dead_letter"],
  completed: [],
  retryable: ["claimed", "dead_letter"],
  dead_letter: [],
} as const satisfies Readonly<
  Record<TemporalTaskStatus, readonly TemporalTaskStatus[]>
>;

export function allowedLetterStatusTransitions(
  status: LetterStatus,
): readonly LetterStatus[] {
  return LETTER_STATUS_TRANSITIONS[status];
}

export function canTransitionLetterStatus(
  from: LetterStatus,
  to: LetterStatus,
): boolean {
  return (LETTER_STATUS_TRANSITIONS[from] as readonly LetterStatus[]).includes(
    to,
  );
}

export function assertLetterStatusTransition(
  from: LetterStatus,
  to: LetterStatus,
): void {
  if (canTransitionLetterStatus(from, to)) return;
  throw new CorrespondenceStateMachineError(
    "invalid_letter_status_transition",
    "letter",
    `Cannot transition letter from ${from} to ${to}`,
    { from, to },
  );
}

export function transitionLetterStatus(
  from: LetterStatus,
  to: LetterStatus,
): LetterStatus {
  assertLetterStatusTransition(from, to);
  return to;
}

export function allowedLetterGenerationRunStatusTransitions(
  status: LetterGenerationRunStatus,
): readonly LetterGenerationRunStatus[] {
  return GENERATION_RUN_STATUS_TRANSITIONS[status];
}

export function canTransitionLetterGenerationRunStatus(
  from: LetterGenerationRunStatus,
  to: LetterGenerationRunStatus,
): boolean {
  return (
    GENERATION_RUN_STATUS_TRANSITIONS[
      from
    ] as readonly LetterGenerationRunStatus[]
  ).includes(to);
}

export function assertLetterGenerationRunStatusTransition(
  from: LetterGenerationRunStatus,
  to: LetterGenerationRunStatus,
): void {
  if (canTransitionLetterGenerationRunStatus(from, to)) return;
  throw new CorrespondenceStateMachineError(
    "invalid_generation_run_status_transition",
    "letter_generation_run",
    `Cannot transition letter generation run from ${from} to ${to}`,
    { from, to },
  );
}

export function transitionLetterGenerationRunStatus(
  from: LetterGenerationRunStatus,
  to: LetterGenerationRunStatus,
): LetterGenerationRunStatus {
  assertLetterGenerationRunStatusTransition(from, to);
  return to;
}

export function allowedTemporalTaskStatusTransitions(
  status: TemporalTaskStatus,
): readonly TemporalTaskStatus[] {
  return TEMPORAL_TASK_STATUS_TRANSITIONS[status];
}

export function canTransitionTemporalTaskStatus(
  from: TemporalTaskStatus,
  to: TemporalTaskStatus,
): boolean {
  return (
    TEMPORAL_TASK_STATUS_TRANSITIONS[from] as readonly TemporalTaskStatus[]
  ).includes(to);
}

export function assertTemporalTaskStatusTransition(
  from: TemporalTaskStatus,
  to: TemporalTaskStatus,
): void {
  if (canTransitionTemporalTaskStatus(from, to)) return;
  throw new CorrespondenceStateMachineError(
    "invalid_temporal_task_status_transition",
    "temporal_task",
    `Cannot transition temporal task from ${from} to ${to}`,
    { from, to },
  );
}

export function transitionTemporalTaskStatus(
  from: TemporalTaskStatus,
  to: TemporalTaskStatus,
): TemporalTaskStatus {
  assertTemporalTaskStatusTransition(from, to);
  return to;
}

const ALWAYS_IMMUTABLE_LETTER_FIELDS = [
  "id",
  "threadId",
  "agentId",
  "replyToLetterId",
  "direction",
  "createdAtUtc",
] as const satisfies readonly (keyof Letter)[];

const SEALED_IMMUTABLE_LETTER_FIELDS = [
  "subject",
  "body",
  "contentHash",
  "transitPolicyVersion",
  "transitTimezone",
  "dispatchedAtUtc",
  "arrivalDueAtUtc",
  "effectiveAuthorTimeUtc",
] as const satisfies readonly (keyof Letter)[];

const FIRST_WRITE_AUDIT_FIELDS = [
  "deliveredEffectiveAtUtc",
  "processedAtUtc",
  "readAtUtc",
  "openedAtUtc",
] as const satisfies readonly (keyof Letter)[];

/**
 * Guards a partial aggregate update without mutating either input. Draft
 * content may change, while identity fields never change and the content plus
 * transport envelope becomes immutable as soon as the current state is not a
 * draft. Lifecycle audit timestamps are first-write facts and cannot later be
 * changed or cleared.
 */
export function assertLetterUpdateAllowed(
  current: Readonly<Letter>,
  changes: Readonly<Partial<Letter>>,
): void {
  for (const field of ALWAYS_IMMUTABLE_LETTER_FIELDS) {
    assertUnchanged(current, changes, field);
  }

  if (changes.status !== undefined && changes.status !== current.status) {
    assertLetterStatusTransition(current.status, changes.status);
  }

  if (current.status !== "draft") {
    for (const field of SEALED_IMMUTABLE_LETTER_FIELDS) {
      assertUnchanged(current, changes, field);
    }
  }

  for (const field of FIRST_WRITE_AUDIT_FIELDS) {
    assertAuditFieldWriteAllowed(current, changes, field);
  }
}

function assertAuditFieldWriteAllowed(
  current: Readonly<Letter>,
  changes: Readonly<Partial<Letter>>,
  field: (typeof FIRST_WRITE_AUDIT_FIELDS)[number],
): void {
  if (!(field in changes) || Object.is(changes[field], current[field])) return;

  const firstDeliveryWrite =
    (field === "deliveredEffectiveAtUtc" || field === "processedAtUtc") &&
    current[field] === undefined &&
    current.status === "in_transit" &&
    changes.status === "delivered_unread" &&
    changes.deliveredEffectiveAtUtc !== undefined &&
    changes.processedAtUtc !== undefined;
  const firstIncomingRead =
    field === "readAtUtc" &&
    current[field] === undefined &&
    current.direction === "user_to_agent" &&
    current.status === "delivered_unread" &&
    changes.status === "read" &&
    changes.readAtUtc !== undefined &&
    changes.openedAtUtc === undefined;
  const firstReplyOpen =
    field === "openedAtUtc" &&
    current[field] === undefined &&
    current.direction === "agent_to_user" &&
    current.status === "delivered_unread" &&
    changes.status === "read" &&
    changes.openedAtUtc !== undefined &&
    changes.readAtUtc === undefined;

  if (firstDeliveryWrite || firstIncomingRead || firstReplyOpen) return;
  throw new CorrespondenceStateMachineError(
    "immutable_letter_field",
    "letter",
    `Letter audit field ${field} may only be written once by its lifecycle transition`,
    { from: current.status, field },
  );
}

function assertUnchanged<K extends keyof Letter>(
  current: Readonly<Letter>,
  changes: Readonly<Partial<Letter>>,
  field: K,
): void {
  if (!(field in changes) || Object.is(changes[field], current[field])) return;
  throw new CorrespondenceStateMachineError(
    "immutable_letter_field",
    "letter",
    `Letter field ${field} is immutable in status ${current.status}`,
    { from: current.status, field },
  );
}

export const correspondenceStateMachine = Object.freeze({
  letter: Object.freeze(LETTER_STATUS_TRANSITIONS),
  generationRun: Object.freeze(GENERATION_RUN_STATUS_TRANSITIONS),
  temporalTask: Object.freeze(TEMPORAL_TASK_STATUS_TRANSITIONS),
});
