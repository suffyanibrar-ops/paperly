import { describe, expect, it } from "vitest";
import {
  describePageQuery,
  isEveryPage,
  pageQueryChips,
  pagesToQuery,
  parsePageQuery,
  validatePageQuery,
} from "@/lib/pageQuery";

describe("page query engine", () => {
  it("treats empty and all as every page", () => {
    expect(parsePageQuery("", 4)).toEqual([1, 2, 3, 4]);
    expect(parsePageQuery("all", 4)).toEqual([1, 2, 3, 4]);
    expect(parsePageQuery("ALL", 2)).toEqual([1, 2]);
  });

  it("parses plain lists and ranges", () => {
    expect(parsePageQuery("1-3, 5", 6)).toEqual([1, 2, 3, 5]);
    expect(parsePageQuery("3,1,2", 3)).toEqual([3, 1, 2]);
    expect(parsePageQuery("2-4", 6)).toEqual([2, 3, 4]);
  });

  it("de-duplicates while preserving first-seen order", () => {
    expect(parsePageQuery("1,1-2,2,1", 4)).toEqual([1, 2]);
  });

  it("supports odd and even", () => {
    expect(parsePageQuery("odd", 5)).toEqual([1, 3, 5]);
    expect(parsePageQuery("even", 5)).toEqual([2, 4]);
  });

  it("supports last, last-N and open ranges", () => {
    expect(parsePageQuery("last", 10)).toEqual([10]);
    expect(parsePageQuery("last-3", 10)).toEqual([8, 9, 10]);
    expect(parsePageQuery("last-3", 2)).toEqual([1, 2]);
    expect(parsePageQuery("8-", 10)).toEqual([8, 9, 10]);
    expect(parsePageQuery("-2", 5)).toEqual([1, 2]);
  });

  it("supports comparisons and steps", () => {
    expect(parsePageQuery(">2", 5)).toEqual([3, 4, 5]);
    expect(parsePageQuery("<3", 5)).toEqual([1, 2]);
    expect(parsePageQuery("1-5:2", 10)).toEqual([1, 3, 5]);
    expect(parsePageQuery("6-2:2", 10)).toEqual([6, 4, 2]);
  });

  it("rejects out-of-range and malformed input with helpful copy", () => {
    expect(() => parsePageQuery("7", 3)).toThrow(/doesn’t exist/);
    expect(() => parsePageQuery("1-9", 3)).toThrow(/outside this PDF/);
    expect(() => parsePageQuery("banana", 3)).toThrow(/isn’t a valid page/);
    expect(() => parsePageQuery("1-3:0", 3)).toThrow(/step of 1 or more/);
    expect(() => parsePageQuery(">9", 3)).toThrow(/no pages after/);
    expect(() => parsePageQuery("", 0)).toThrow(/no pages to select/);
  });

  it("describes selections accurately", () => {
    expect(describePageQuery([1, 2, 3], 3)).toBe("All 3 pages");
    expect(describePageQuery([2], 3)).toBe("Page 2");
    expect(describePageQuery([1, 3], 3)).toBe("All 2 odd pages");
    expect(describePageQuery([2], 4)).toBe("Page 2");
    expect(describePageQuery([1, 2], 4)).toBe("Pages 1, 2");
    expect(describePageQuery([1, 2, 3, 4, 6], 10)).toBe("5 selected pages");
    expect(describePageQuery([], 10)).toBe("No pages selected");
  });

  it("round-trips page lists into compact queries", () => {
    expect(pagesToQuery([1, 2, 3], 3)).toBe("all");
    expect(pagesToQuery([1, 2, 3, 5], 8)).toBe("1-3, 5");
    expect(pagesToQuery([1, 3], 4)).toBe("1, 3");
    expect(pagesToQuery([], 4)).toBe("");
    expect(pagesToQuery([1, 2], 2)).toBe("all");
  });

  it("exposes non-throwing validation and chips", () => {
    expect(validatePageQuery("1-3", 3)).toBeNull();
    expect(validatePageQuery("9", 3)).toMatch(/doesn’t exist/);
    expect(pageQueryChips(5).map((chip) => chip.label)).toContain("Odd");
    expect(pageQueryChips(3).map((chip) => chip.label)).not.toContain("Last 3");
    expect(isEveryPage([1, 2, 3], 3)).toBe(true);
    expect(isEveryPage([1, 2], 3)).toBe(false);
  });
});
