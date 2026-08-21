import { describe, expect, it } from "vitest";

import {
  ACTIVITY_CATEGORIES,
  deriveActivityAffinities,
} from "./activity-affinity.js";

describe("activity affinity derivation", () => {
  it("deterministically combines routines, goals, preferences and persona text", () => {
    const character = {
      identity: {
        workOrRole: "student",
        selfDescription: "I unwind with music and photography.",
      },
      routines: [
        {
          title: "Morning run",
          category: "exercise",
          recurrence: "weekdays",
          priority: 0.9,
        },
      ],
      persona: {
        goals: [
          {
            title: "Finish a marathon",
            description: "Train consistently.",
            priority: 0.95,
          },
        ],
        preferences: [
          {
            subject: "photography",
            preference: "late night stargazing photography",
            intensity: 0.9,
            conditions: ["clear sky"],
          },
        ],
        traits: [
          {
            name: "curious reader",
            description: "Enjoys books and research.",
            strength: 0.7,
            triggers: ["new book"],
          },
        ],
        values: [
          {
            name: "health",
            description: "Exercise and self care matter.",
            priority: 0.8,
          },
        ],
      },
      dialogue: {
        frequentPhrases: ["late night photos are worth the wait"],
      },
    };
    const before = JSON.stringify(character);

    const first = deriveActivityAffinities(character);
    const second = deriveActivityAffinities(character);

    expect(first).toEqual(second);
    expect(JSON.stringify(character)).toBe(before);
    expect(first.categoryScores.exercise).toBeGreaterThan(
      first.categoryScores.work,
    );
    expect(first.categoryScores.leisure).toBeGreaterThan(
      first.categoryScores.other,
    );
    expect(first.categoryScores.study).toBeGreaterThan(
      first.categoryScores.other,
    );
    expect(first.nightOwlBias).toBeGreaterThan(0.05);
    expect(first.nightOwlBias).toBeLessThanOrEqual(0.4);
  });

  it("returns a bounded score for every schedule category", () => {
    const affinities = deriveActivityAffinities({
      routines: [
        {
          title: "\u9605\u8bfb",
          category: "study",
          priority: 1,
        },
      ],
    });

    expect(Object.keys(affinities.categoryScores).sort()).toEqual(
      [...ACTIVITY_CATEGORIES].sort(),
    );
    for (const score of Object.values(affinities.categoryScores)) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
    expect(affinities.categoryScores.study).toBeGreaterThan(0.5);
  });
});
