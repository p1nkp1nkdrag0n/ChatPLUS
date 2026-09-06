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
  const budget = { ...input.budget };
  if (
    !Number.isSafeInteger(budget.maxPhysicalRequests) ||
    budget.maxPhysicalRequests <= 0 ||
    !Number.isSafeInteger(budget.maxReservedTokenUnits) ||
    budget.maxReservedTokenUnits <= 0
  )
    throw new Error("continuity_invalid_request_budget");
  const readUsage = (): { attempts: number; units: number } => {
    let attempts = 0;
    let units = 0;
    if (!existsSync(input.ledgerPath)) return { attempts, units };
    for (const line of readFileSync(input.ledgerPath, "utf8")
      .split("\n")
      .filter(Boolean)) {
      const row = JSON.parse(line) as {
        stage: string;
        attempt?: number;
        reservedTokenUnits?: number;
      };
      if (row.stage !== "reserved") continue;
      if (
        row.attempt !== attempts + 1 ||
        !Number.isSafeInteger(row.reservedTokenUnits) ||
        row.reservedTokenUnits! <= 0 ||
        !Number.isSafeInteger(units + row.reservedTokenUnits!)
      )
        throw new Error("continuity_invalid_request_ledger");
      attempts += 1;
      units += row.reservedTokenUnits!;
    }
    return { attempts, units };
  };
  let observedUsage = readUsage();
  const append = (value: unknown): void => {
    appendFileSync(
      input.ledgerPath,
      `${JSON.stringify(redactLongRunArtifact(value, input.secrets))}\n`,
    );
  };
  const transport = input.fetch ?? globalThis.fetch;
  return async (url, init) => {
    const context = input.context?.();
    if (typeof init?.body !== "string")
      throw new Error("continuity_unmetered_request_body");
    const request = JSON.parse(init.body) as { max_tokens?: number };
    if (!Number.isSafeInteger(request.max_tokens) || request.max_tokens! <= 0)
      throw new Error("continuity_missing_output_cap");
    const reservation =
      Buffer.byteLength(init.body, "utf8") + request.max_tokens!;
    if (!Number.isSafeInteger(reservation))
      throw new Error("continuity_invalid_request_reservation");
    // All providers in one process share the same ledger. Read, admit and append
    // are synchronous, so parallel wrappers cannot reserve against stale counters.
    const { attempts, units } = readUsage();
    if (attempts < observedUsage.attempts || units < observedUsage.units)
      throw new Error("continuity_request_ledger_regressed");
    observedUsage = { attempts, units };
    if (
      attempts >= budget.maxPhysicalRequests ||
      reservation > budget.maxReservedTokenUnits - units
    ) {
      append({
        stage: "blocked",
        context,
        reason: "physical_request_budget_reached",
        attempts,
        units,
      });
      throw new Error("physical_request_budget_reached");
    }
    const attempt = attempts + 1;
    // Persist before dispatch, so a crash or unknown timeout is never free on resume.
    append({
      stage: "reserved",
      attempt,
      reservedTokenUnits: reservation,
      context,
      request,
      atUtc: new Date().toISOString(),
    });
    observedUsage = { attempts: attempt, units: units + reservation };
    const start = performance.now();
    try {
      const response = await transport(url, init);
      const responseText = await response.clone().text();
      let body: unknown = responseText;
      let responseFormat = "text";
      try {
        body = JSON.parse(responseText) as unknown;
        responseFormat = "json";
      } catch {
        // Gateways can return plain-text or HTML errors. Retain that evidence.
      }
      append({
        stage: "responded",
        attempt,
        context,
        status: response.status,
        response: body,
        responseFormat,
        usage:
          body !== null && typeof body === "object" && "usage" in body
            ? (body.usage ?? "unknown")
            : "unknown",
        latencyMs: performance.now() - start,
      });
      return response;
    } catch (error) {
      append({
        stage: "transport_failed",
        attempt,
        context,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: performance.now() - start,
        usage: "unknown",
      });
      throw error;
    }
  };
}
