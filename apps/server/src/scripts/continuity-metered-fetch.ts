import { appendFileSync, existsSync, readFileSync } from "node:fs";

import { redactLongRunArtifact } from "./companion-long-run-v2-artifacts.js";

export interface ContinuityRequestBudget {
  maxPhysicalRequests: number;
  /** Conservative reservation units: serialized UTF-8 request bytes + max_tokens.
   * This is an admission limit, not a provider bill or a claimed exact tokenizer.
   */
  maxReservedTokenUnits: number;
}

export function createContinuityMeteredFetch(input: {
  ledgerPath: string;
  budget: ContinuityRequestBudget;
  fetch?: typeof fetch;
  secrets?: string[];
  context?: () => unknown;
}): typeof fetch {
  const rows = existsSync(input.ledgerPath)
    ? readFileSync(input.ledgerPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as { stage: string; reservedTokenUnits?: number },
        )
    : [];
  let attempts = rows.filter((row) => row.stage === "reserved").length;
  let units = rows.reduce(
    (sum, row) =>
      sum + (row.stage === "reserved" ? (row.reservedTokenUnits ?? 0) : 0),
    0,
  );
  const append = (value: unknown): void => {
    appendFileSync(
      input.ledgerPath,
      `${JSON.stringify(redactLongRunArtifact(value, input.secrets))}\n`,
    );
  };
  const transport = input.fetch ?? globalThis.fetch;
  return async (url, init) => {
    if (typeof init?.body !== "string")
      throw new Error("continuity_unmetered_request_body");
    const request = JSON.parse(init.body) as { max_tokens?: number };
    if (!Number.isSafeInteger(request.max_tokens) || request.max_tokens! <= 0)
      throw new Error("continuity_missing_output_cap");
    const reservation =
      Buffer.byteLength(init.body, "utf8") + request.max_tokens!;
    if (
      attempts >= input.budget.maxPhysicalRequests ||
      units + reservation > input.budget.maxReservedTokenUnits
    ) {
      append({
        stage: "blocked",
        context: input.context?.(),
        reason: "physical_request_budget_reached",
        attempts,
        units,
      });
      throw new Error("physical_request_budget_reached");
    }
    const attempt = ++attempts;
    units += reservation;
    // Persist before dispatch, so a crash or unknown timeout is never free on resume.
    append({
      stage: "reserved",
      attempt,
      reservedTokenUnits: reservation,
      context: input.context?.(),
      request,
      atUtc: new Date().toISOString(),
    });
    const start = performance.now();
    try {
      const response = await transport(url, init);
      const body: unknown = await response
        .clone()
        .json()
        .catch(() => null);
      append({
        stage: "responded",
        attempt,
        context: input.context?.(),
        status: response.status,
        response: body,
        latencyMs: performance.now() - start,
      });
      return response;
    } catch (error) {
      append({
        stage: "transport_failed",
        attempt,
        context: input.context?.(),
        error: error instanceof Error ? error.message : String(error),
        latencyMs: performance.now() - start,
        usage: "unknown",
      });
      throw error;
    }
  };
}
