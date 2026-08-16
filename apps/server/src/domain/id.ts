import { nanoid } from "nanoid";

/**
 * Canonical contract identifiers must begin with an ASCII letter or digit.
 * Prefixing nanoid output keeps its entropy while satisfying that invariant.
 */
export function createEntityId(prefix = "id"): string {
  return `${prefix}_${nanoid()}`;
}
