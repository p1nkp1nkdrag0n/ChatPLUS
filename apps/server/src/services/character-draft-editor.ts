import { ApiError } from "../domain/errors.js";
import {
  characterDraftSchema,
  characterSpecSchema,
  type CharacterDraft,
  type CharacterSpec,
} from "../domain/schemas.js";

export type CharacterMutation =
  | { spec: unknown; expectedVersion?: number }
  | { patch: Record<string, unknown>; expectedVersion?: number }
  | {
      path: string;
      value?: unknown;
      remove?: boolean;
      expectedVersion?: number;
    }
  | Record<string, unknown>;

export function stripCharacterMetadata(spec: CharacterSpec): CharacterDraft {
  const draft = structuredClone(spec) as unknown as Record<string, unknown>;
  for (const field of [
    "id",
    "version",
    "status",
    "createdAtUtc",
    "updatedAtUtc",
  ]) {
    delete draft[field];
  }
  return characterDraftSchema.parse(draft);
}

export function applyCharacterMutation(
  current: CharacterDraft,
  mutation: CharacterMutation,
): CharacterDraft {
  if ("spec" in mutation) {
    const fullSpec = characterSpecSchema.safeParse(mutation.spec);
    return fullSpec.success
      ? stripCharacterMetadata(fullSpec.data)
      : characterDraftSchema.parse(mutation.spec);
  }
  if ("path" in mutation && typeof mutation.path === "string") {
    const clone = structuredClone(current) as unknown as Record<
      string,
      unknown
    >;
    setAtPath(clone, mutation.path, mutation.value, mutation.remove === true);
    return characterDraftSchema.parse(clone);
  }
  if ("patch" in mutation && isRecord(mutation.patch)) {
    return characterDraftSchema.parse(
      deepMerge(structuredClone(current), mutation.patch),
    );
  }
  const possibleSpec = { ...mutation };
  delete possibleSpec.expectedVersion;
  return characterDraftSchema.parse(possibleSpec);
}

export function getExpectedCharacterVersion(
  mutation: CharacterMutation,
): number | undefined {
  const value = mutation.expectedVersion;
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

export function protectLockedCharacterFields(
  before: CharacterDraft,
  after: CharacterDraft,
): void {
  for (const path of before.lockedPaths) {
    if (!after.lockedPaths.includes(path)) continue;
    if (
      JSON.stringify(getAtPath(before, path)) !==
      JSON.stringify(getAtPath(after, path))
    ) {
      throw new ApiError(
        409,
        "field_locked",
        `The character field is locked: ${path}`,
        { path },
      );
    }
  }
}

function setAtPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
  remove: boolean,
): void {
  if (!/^([A-Za-z][A-Za-z0-9_]*)(\.([A-Za-z][A-Za-z0-9_]*|\d+))*$/.test(path)) {
    throw new ApiError(
      400,
      "invalid_path",
      "The requested JSON path is invalid.",
      { path },
    );
  }
  const parts = path.split(".");
  let cursor: Record<string, unknown> | unknown[] = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]!;
    const nextValue: unknown = Array.isArray(cursor)
      ? cursor[Number(part)]
      : cursor[part];
    if (!isRecord(nextValue) && !Array.isArray(nextValue)) {
      throw new ApiError(
        400,
        "invalid_path",
        "The requested JSON path does not exist.",
        { path },
      );
    }
    cursor = nextValue;
  }
  const key = parts.at(-1)!;
  if (Array.isArray(cursor)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
      throw new ApiError(
        400,
        "invalid_path",
        "The requested array index is invalid.",
        { path },
      );
    }
    if (remove) cursor.splice(index, 1);
    else cursor[index] = value;
  } else if (remove) delete cursor[key];
  else cursor[key] = value;
}

function getAtPath(target: unknown, path: string): unknown {
  let value = target;
  for (const part of path.split(".")) {
    if (Array.isArray(value)) value = value[Number(part)];
    else if (isRecord(value)) value = value[part];
    else return undefined;
  }
  return value;
}

function deepMerge(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(patch)) {
    if (isRecord(value) && isRecord(target[key])) {
      target[key] = deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
