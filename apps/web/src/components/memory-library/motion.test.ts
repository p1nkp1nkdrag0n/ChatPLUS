import { describe, expect, it } from "vitest";
import { BookActionGate } from "./motion";

describe("book animation action gate", () => {
  it("makes the second stage a separate click and rejects rapid clicks during extraction", () => {
    const gate = new BookActionGate();
    const extracting = gate.begin()!;
    expect(gate.begin()).toBeUndefined();
    expect(gate.begin()).toBeUndefined();
    expect(gate.finish(extracting)).toBe(true);
    const opening = gate.begin()!;
    expect(opening).not.toBe(extracting);
    expect(gate.current(opening)).toBe(true);
  });

  it("does not let a cancelled animation commit a page or unlock a newer transition", () => {
    const gate = new BookActionGate();
    const flipping = gate.begin()!;
    gate.cancel();
    const returning = gate.begin()!;
    expect(gate.current(flipping)).toBe(false);
    expect(gate.finish(flipping)).toBe(false);
    expect(gate.begin()).toBeUndefined();
    expect(gate.finish(returning)).toBe(true);
    expect(gate.begin()).toBeDefined();
  });
});
