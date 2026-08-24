import type { ContextPlan } from "@personasim/contracts";
import {
  buildContextPlan,
  type BuildContextPlanInput,
} from "@personasim/features";

import type { ValidatedTurnOutcome } from "./turn-execution-service.js";

export type ContextPlanServiceInput = Omit<
  BuildContextPlanInput,
  "route" | "validatedOutcomeFacts" | "observedTopics"
> & {
  outcome?: ValidatedTurnOutcome;
};

/** Aggregates server-grounded turn facts into deterministic prompt policy. */
export class ContextPlanService {
  build(input: ContextPlanServiceInput): ContextPlan {
    const { outcome, ...context } = input;
    return buildContextPlan({
      ...context,
      ...(outcome === undefined ? {} : { route: outcome.route }),
      ...(outcome === undefined
        ? {}
        : {
            observedTopics: outcome.observation.topics.map((topic) => ({
              key: topic.key,
              domain: topic.domain,
              confidence: topic.confidence,
              evidenceTexts: topic.evidenceQuotes.map((quote) => quote.text),
            })),
          }),
      ...(outcome === undefined
        ? {}
        : {
            validatedOutcomeFacts:
              outcome.replyDirectives.authoritativeFacts.map((fact) => ({
                text: fact.text,
              })),
          }),
    });
  }
}
