import type { ZodType } from "zod";

export class StructuredOutputError extends Error {
  readonly code = "INVALID_STRUCTURED_OUTPUT";

  constructor(
    message: string,
    readonly issues: readonly string[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StructuredOutputError";
  }
}

function stripFence(value: string): string {
  const trimmed = value.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

function firstBalancedJson(value: string): string | undefined {
  const start = [...value].findIndex(
    (character) => character === "{" || character === "[",
  );
  if (start < 0) return undefined;

  const opening = value[start];
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === opening) {
      depth += 1;
    } else if (character === closing) {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return undefined;
}

export function parseJsonText(value: string): unknown {
  const stripped = stripFence(value);
  const candidate = firstBalancedJson(stripped) ?? stripped;
  try {
    return JSON.parse(candidate) as unknown;
  } catch (error) {
    throw new StructuredOutputError("The model did not return valid JSON", [], {
      cause: error,
    });
  }
}

export function parseStructuredOutput<T>(value: string, schema: ZodType<T>): T {
  const parsed = parseJsonText(value);
  const result = schema.safeParse(parsed);
  if (result.success) return result.data;

  const issues = result.error.issues.slice(0, 12).map((issue) => {
    const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
    return `${path}: ${issue.message}`;
  });
  throw new StructuredOutputError(
    "The model JSON did not match the requested schema",
    issues,
  );
}
