import { describe, expect, it } from "vitest";

import {
  rankPersonalIntents,
  type PersonalIntentLike,
  type SelfPlanningStateLike,
} from "./self-planning.js";
import type { ActivityAffinities } from "./activity-affinity.js";

const state: SelfPlanningStateLike = {
  moodValence: 0,
  energy: 0.1,
  stress: 0.9,
  socialBattery: 0.4,
  focus: 0.2,
};

function candidate(
  id: string,
  category: PersonalIntentLike["category"],
  freshness: number,
): PersonalIntentLike {
  return {
    id,
    agentId: "agent-1",
    activity: id,
    category,
    desiredDurationMinutes: 60,
    priority: 0.5,
    freshness,
    status: "pending",
    specVersion: 1,
  };
}

function affinities(exercise: number, selfCare: number): ActivityAffinities {
  return {
    categoryScores: {
      sleep: 0.5,
      work: 0.5,
      study: 0.5,
      meal: 0.5,
      exercise,
      social: 0.5,
      travel: 0.5,
      leisure: 0.5,
      self_care: selfCare,
      errand: 0.5,
      other: 0.5,
    },
    nightOwlBias: 0.05,
  };
}

describe("personal intent ranking precedence", () => {
  it("uses freshness before affinity", () => {
    const ranked = rankPersonalIntents(
      [
        candidate("affine", "exercise", 0.4),
        candidate("fresh", "self_care", 0.8),
      ],
      affinities(1, 0.1),
      state,
    );

    expect(ranked.map((entry) => entry.intent.id)).toEqual(["fresh", "affine"]);
  });

  it("uses affinity before state compatibility", () => {
    const ranked = rankPersonalIntents(
      [
        candidate("state-compatible", "self_care", 0.5),
        candidate("affine", "exercise", 0.5),
      ],
      affinities(0.9, 0.2),
      state,
    );

    expect(ranked.map((entry) => entry.intent.id)).toEqual([
      "affine",
      "state-compatible",
    ]);
  });
});
