import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ConversationContextPlanSchema } from "@personasim/contracts";
import { z } from "zod";
import { buildConversationQualityMetrics } from "./conversation-quality-metrics.js";

const CorpusSchema = z
  .object({
    turns: z.array(
      z
        .object({
          turnId: z.string().trim().min(1),
          userText: z.string(),
          assistantText: z.string().min(1),
          assistantChunks: z.array(z.string().min(1)).min(1).optional(),
          frozenPlan: ConversationContextPlanSchema.pick({
            questionIntent: true,
            questionIntentReason: true,
            adviceRequested: true,
            detailedAnalysisRequested: true,
          }).optional(),
        })
        .strict(),
    ),
    trackedPhrases: z.array(z.string()).optional(),
    protectedPhrases: z.array(z.string()).optional(),
  })
  .strict();

/** Read-only analysis of supplied final replies. No provider or app is started. */
export function conversationQualityReport(
  corpus: unknown,
): ReturnType<typeof buildConversationQualityMetrics> {
  const parsed = CorpusSchema.parse(corpus);
  return buildConversationQualityMetrics({
    turns: parsed.turns.map(({ assistantChunks, frozenPlan, ...turn }) => ({
      ...turn,
      ...(assistantChunks === undefined ? {} : { assistantChunks }),
      ...(frozenPlan === undefined ? {} : { frozenPlan }),
    })),
    ...(parsed.trackedPhrases === undefined
      ? {}
      : { trackedPhrases: parsed.trackedPhrases }),
    ...(parsed.protectedPhrases === undefined
      ? {}
      : { protectedPhrases: parsed.protectedPhrases }),
  });
}

async function main() {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || extra.length)
    throw new Error(
      "Usage: pnpm exec tsx apps/server/src/scripts/conversation-quality-report.ts corpus.json [new-report.json]",
    );
  const corpus: unknown = JSON.parse(await readFile(resolve(input), "utf8"));
  const report =
    JSON.stringify(conversationQualityReport(corpus), null, 2) + "\n";
  if (output) await writeFile(resolve(output), report, { flag: "wx" });
  else process.stdout.write(report);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
