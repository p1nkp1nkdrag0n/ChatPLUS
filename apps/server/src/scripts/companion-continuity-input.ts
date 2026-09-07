import { readFile } from "node:fs/promises";

import { OriginalCharacterInputSchema } from "@personasim/contracts";
import { z } from "zod";

import { sha256Text } from "./companion-long-run-v2-artifacts.js";

export const ContinuityScenarioSchema = z
  .object({
    version: z.literal("companion-continuity-real-v1-proposal"),
    simulatedStart: z
      .string()
      .refine((value) => Number.isFinite(Date.parse(value))),
    timezone: z.string(),
    characterInput: OriginalCharacterInputSchema,
    steps: z
      .array(
        z
          .object({
            turn: z.number().int().positive(),
            sessionKey: z.string().min(1),
            simulatedDay: z.number().int().nonnegative(),
            minuteInSession: z.number().int().nonnegative(),
            kind: z.enum(["interaction", "probe"]),
            userText: z.string().min(1),
            clientMessageIdTemplate: z.string().min(1),
          })
          .strict(),
      )
      .length(120),
    driverOnlyActions: z.array(
      z
        .object({
          afterTurn: z.number().int().min(1).max(120),
          action: z.enum([
            "dispatch_letter_via_existing_product_helper",
            "close_process_then_advance_offline_to_D18",
            "create_consistent_backup_for_value_probe_siblings",
            "final_consistent_backup_and_independent_review",
          ]),
          body: z.string().optional(),
          note: z.string().optional(),
        })
        .strict(),
    ),
  })
  .superRefine((scenario, ctx) => {
    const ids = new Set<string>();
    let previousTime = -1;
    for (const [index, step] of scenario.steps.entries()) {
      const time = step.simulatedDay * 1440 + step.minuteInSession;
      if (
        step.turn !== index + 1 ||
        ids.has(step.clientMessageIdTemplate) ||
        !step.clientMessageIdTemplate.includes("{runId}") ||
        time < previousTime
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Invalid scenario ordering or idempotency identity",
          path: ["steps", index],
        });
      }
      previousTime = time;
      ids.add(step.clientMessageIdTemplate);
    }
  });
export type ContinuityScenario = z.infer<typeof ContinuityScenarioSchema>;

/** The oracle is returned only as an opaque audit artifact. No oracle-derived
 * field is accepted by the runtime driver or the character API input builder.
 */
export async function loadContinuityInputs(
  publicPath: string,
  oraclePath: string,
) {
  const [publicText, oracleText] = await Promise.all([
    readFile(publicPath, "utf8"),
    readFile(oraclePath, "utf8"),
  ]);
  const scenario = ContinuityScenarioSchema.parse(JSON.parse(publicText));
  const oracle = z
    .object({
      artifactKind: z.literal("private_oracle_not_for_character_or_simulator"),
      version: z.string(),
      publicScenarioSha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .parse(JSON.parse(oracleText));
  const publicSha256 = sha256Text(publicText);
  if (
    oracle.publicScenarioSha256 !== publicSha256 ||
    oracle.version !== scenario.version
  )
    throw new Error("continuity_scenario_oracle_mismatch");
  return {
    scenario,
    publicText,
    oracleText,
    publicSha256,
    oracleSha256: sha256Text(oracleText),
  };
}

export function continuityMessageInput(
  scenario: ContinuityScenario,
  turn: number,
  runId: string,
  agentId: string,
) {
  const step = scenario.steps[turn - 1];
  if (step?.turn !== turn) throw new Error("continuity_unknown_turn");
  return {
    agentId,
    clientMessageId: step.clientMessageIdTemplate.replaceAll("{runId}", runId),
    text: step.userText,
  };
}
