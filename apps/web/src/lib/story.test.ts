import { describe, expect, it } from "vitest";
import { storyFrame } from "./story";

describe("Dearvale scroll story", () => {
  it("keeps opening and first conversation on the same mountain", () => {
    expect(storyFrame(0.9)).toMatchObject({ currentScene: 0, nextScene: 0 });
    expect(storyFrame(1)).toMatchObject({ current: 1, currentScene: 0 });
    expect(storyFrame(2)).toMatchObject({ current: 2, currentScene: 1 });
  });
  it("holds a readable scene before blending and supports reverse scrolling", () => {
    expect(storyFrame(2.6).mix).toBe(0);
    expect(storyFrame(2.825).mix).toBeCloseTo(0.5);
    expect(storyFrame(2.7).mix).toBeLessThan(storyFrame(2.9).mix);
  });
  it("clamps elastic scroll and renders the final night scene", () => {
    expect(storyFrame(-10).current).toBe(0);
    expect(storyFrame(Number.NaN).current).toBe(0);
    expect(storyFrame(8)).toMatchObject({
      current: 5,
      next: 5,
      currentScene: 4,
    });
  });
  it("uses discrete transitions with reduced motion", () => {
    expect(storyFrame(2.7, true).mix).toBe(0);
    expect(storyFrame(2.9, true).mix).toBe(1);
  });
});
