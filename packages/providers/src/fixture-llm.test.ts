import { ActivityEnrichmentBatchSchema } from "@personasim/contracts";
import { describe, expect, it } from "vitest";

import { createFixtureLlmProvider } from "./fixture-llm.js";

describe("Fixture LLM activity enrichment", () => {
  it("returns one validated enrichment for every input event", async () => {
    const provider = createFixtureLlmProvider();
    const response = await provider.generate({
      purpose: "enrich_activity",
      payload: {
        events: [
          {
            eventId: "event-1",
            summary: "完成旅行",
            category: "travel",
            importance: 0.9,
          },
          {
            eventId: "event-2",
            summary: "完成学习任务",
            category: "study",
            importance: 0.7,
          },
        ],
      },
      seed: "batch-test",
    });

    const batch = ActivityEnrichmentBatchSchema.parse(response.data);
    expect(batch.events.map((event) => event.eventId)).toEqual([
      "event-1",
      "event-2",
    ]);
    expect(batch.events[0]?.memoryCandidates[0]?.type).toBe("activity_outcome");
  });
});
