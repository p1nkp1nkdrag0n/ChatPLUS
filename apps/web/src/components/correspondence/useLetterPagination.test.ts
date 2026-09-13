import { describe, expect, it } from "vitest";
import { countLetterPages } from "./useLetterPagination";

describe("letter pagination geometry", () => {
  it("does not add blank pages for an exact fit or rounded CSS pixel widths", () => {
    expect(countLetterPages(300, 300, 32)).toBe(1);
    expect(countLetterPages(965, 300.4, 32)).toBe(3);
    expect(countLetterPages(3648, 302.545, 32)).toBe(11);
  });

  it("counts overflow columns without assuming a trailing column gap", () => {
    expect(countLetterPages(632, 300, 32)).toBe(2);
    expect(countLetterPages(964, 300, 32)).toBe(3);
    expect(countLetterPages(1000, 300, 32)).toBe(4);
  });

  it("keeps an empty or temporarily hidden letter on its first page", () => {
    expect(countLetterPages(0, 0, 32)).toBe(1);
    expect(countLetterPages(0, 300, 32)).toBe(1);
  });
});
