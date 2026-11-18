import { describe, expect, it } from "vitest";
import {
  INVALID_PATTERN_MESSAGE,
  MAX_CUSTOM_PATTERN_LENGTH,
  PATTERN_PRESETS,
  buildRegex,
  countByPattern,
  findMatches,
  formatRedactionReport,
  isCardNumber,
  isIban,
  isPlausibleDate,
  isSsn,
  luhn,
  presetLabel,
  resolveOverlaps,
} from "@/lib/redactPatterns";

const cardPreset = PATTERN_PRESETS.find((preset) => preset.id === "credit-card")!;

describe("buildRegex", () => {
  it("always returns a global regex", () => {
    expect(buildRegex("email").flags).toContain("g");
    for (const preset of PATTERN_PRESETS) {
      if (preset.id === "custom") continue;
      expect(buildRegex(preset).flags).toContain("g");
    }
  });

  it("matches case-insensitively by default and respects the case-sensitive option", () => {
    const text = "JANE.DOE@EXAMPLE.COM";
    expect(findMatches(text, buildRegex("email"))).toHaveLength(1);
    expect(findMatches(text, buildRegex("email", { caseSensitive: true }))).toHaveLength(0);
  });

  it("honours whole-word matching", () => {
    // Without the boundary, the SSN pattern happily matches the tail of a longer number.
    const glued = "ref 9123-45-6789 today";
    expect(findMatches(glued, buildRegex("ssn"))).toHaveLength(1);
    expect(findMatches(glued, buildRegex("ssn", { wholeWord: true }))).toHaveLength(0);
    expect(findMatches("ref 123-45-6789 today", buildRegex("ssn", { wholeWord: true }))).toHaveLength(1);
    // Email addresses still match when surrounded by punctuation/whitespace.
    expect(findMatches("contact jane.doe@example.com, today", buildRegex("email", { wholeWord: true }))).toHaveLength(1);
  });

  it("builds custom patterns and rejects invalid ones with a friendly message", () => {
    const regex = buildRegex("custom", { customPattern: "EMP-\\d{6}" });
    expect(findMatches("ID EMP-123456 ok", regex)).toHaveLength(1);
    expect(findMatches("id emp-123456 ok", buildRegex("custom", { customPattern: "EMP-\\d{6}", caseSensitive: true }))).toHaveLength(0);

    expect(() => buildRegex("custom", { customPattern: "(unclosed" })).toThrow(INVALID_PATTERN_MESSAGE);
    expect(() => buildRegex("custom", { customPattern: "" })).toThrow(/Enter a custom regular expression/);
    expect(() =>
      buildRegex("custom", { customPattern: "a".repeat(MAX_CUSTOM_PATTERN_LENGTH + 1) }),
    ).toThrow(/too long/);
  });

  it("never throws for a built-in preset", () => {
    for (const preset of PATTERN_PRESETS) {
      if (preset.id === "custom") continue;
      expect(() => buildRegex(preset.id)).not.toThrow();
    }
  });
});

describe("findMatches", () => {
  it("returns non-overlapping ranges in reading order", () => {
    const matches = findMatches("aaaa", /aa/g);
    expect(matches).toEqual([
      { start: 0, end: 2, value: "aa" },
      { start: 2, end: 4, value: "aa" },
    ]);
  });

  it("does not report overlapping hits from a repeated pattern", () => {
    const matches = findMatches("ababa", /aba/g);
    expect(matches).toEqual([{ start: 0, end: 3, value: "aba" }]);
    for (let index = 1; index < matches.length; index++) {
      expect(matches[index].start).toBeGreaterThanOrEqual(matches[index - 1].end);
    }
  });

  it("skips zero-length matches instead of looping", () => {
    expect(findMatches("abc", /x*/g)).toEqual([]);
    expect(findMatches("abc", /^/g)).toEqual([]);
    expect(findMatches("a1b22", /\d*/g).map((match) => match.value)).toEqual(["1", "22"]);
  });

  it("reports the exact substring and offsets", () => {
    const [match] = findMatches("mail jane.doe@example.com now", buildRegex("email"));
    expect(match.value).toBe("jane.doe@example.com");
    expect("mail jane.doe@example.com now".slice(match.start, match.end)).toBe(match.value);
  });

  it("returns nothing for empty text", () => {
    expect(findMatches("", buildRegex("email"))).toEqual([]);
  });
});

describe("luhn", () => {
  it("accepts valid card numbers, with or without separators", () => {
    expect(luhn("4111111111111111")).toBe(true);
    expect(luhn("4111 1111 1111 1111")).toBe(true);
    expect(luhn("4111-1111-1111-1111")).toBe(true);
    expect(luhn("5555555555554444")).toBe(true);
  });

  it("rejects invalid numbers and non-digit input", () => {
    expect(luhn("4111111111111112")).toBe(false);
    expect(luhn("123")).toBe(false);
    expect(luhn("not-a-card")).toBe(false);
    expect(luhn("")).toBe(false);
  });

  it("is used by the credit-card preset validator", () => {
    expect(cardPreset.validate?.("4111 1111 1111 1111")).toBe(true);
    expect(cardPreset.validate?.("4111 1111 1111 1112")).toBe(false);

    const raw = findMatches("Card 4111 1111 1111 1111 and 4111 1111 1111 1112.", buildRegex("credit-card"));
    const valid = raw.filter((match) => cardPreset.validate?.(match.value));
    expect(raw).toHaveLength(2);
    expect(valid).toHaveLength(1);
    expect(valid[0].value).toContain("1111");
  });
});

describe("preset validators", () => {
  it("checks SSN structure", () => {
    expect(isSsn("123-45-6789")).toBe(true);
    expect(isSsn("000-45-6789")).toBe(false);
    expect(isSsn("666-45-6789")).toBe(false);
    expect(isSsn("900-45-6789")).toBe(false);
    expect(isSsn("123456789")).toBe(false);
  });

  it("checks IBAN structure and the mod-97 checksum", () => {
    expect(isIban("GB82 WEST 1234 5698 7654 32")).toBe(true);
    expect(isIban("GB00 WEST 1234 5698 7654 32")).toBe(false);
    expect(isIban("not-an-iban")).toBe(false);
  });

  it("checks calendar dates while allowing day-first and month-first forms", () => {
    expect(isPlausibleDate("2026-11-11")).toBe(true);
    expect(isPlausibleDate("2026-13-01")).toBe(false);
    expect(isPlausibleDate("31/12/2026")).toBe(true);
    expect(isPlausibleDate("31/02/2026")).toBe(false);
    expect(isPlausibleDate("12/25/2026")).toBe(true);
    expect(isPlausibleDate("nope")).toBe(false);
  });

  it("detects card numbers only for 13–19 Luhn-valid digits", () => {
    expect(isCardNumber("4111 1111 1111 1111")).toBe(true);
    expect(isCardNumber("4111 1111 1111")).toBe(false);
    expect(isCardNumber("4111 1111 1111 1112")).toBe(false);
  });
});

describe("resolveOverlaps", () => {
  it("keeps the higher-priority candidate when two patterns cover the same text", () => {
    const phone = { start: 0, end: 10, preset: "phone", priority: 50 };
    const card = { start: 2, end: 9, preset: "credit-card", priority: 10 };
    expect(resolveOverlaps([phone, card])).toEqual([card]);
  });

  it("keeps disjoint candidates and orders by priority then position", () => {
    const accepted = resolveOverlaps([
      { start: 20, end: 25, preset: "date", priority: 60 },
      { start: 0, end: 5, preset: "email", priority: 30 },
    ]);
    expect(accepted.map((candidate) => candidate.preset)).toEqual(["email", "date"]);
  });

  it("drops a range that is fully covered by an earlier-range candidate", () => {
    const accepted = resolveOverlaps([
      { start: 4, end: 8, preset: "inner", priority: 10 },
      { start: 0, end: 12, preset: "outer", priority: 20 },
    ]);
    expect(accepted.map((candidate) => candidate.preset)).toEqual(["inner"]);
  });
});

describe("countByPattern", () => {
  it("counts matches per preset", () => {
    expect(countByPattern([{ preset: "email" }, { preset: "email" }, { preset: "ssn" }])).toEqual({ email: 2, ssn: 1 });
  });

  it("returns an empty object when there is nothing to count", () => {
    expect(countByPattern([])).toEqual({});
  });
});

describe("formatRedactionReport", () => {
  const input = {
    fileName: "contract.pdf",
    totalPages: 10,
    pagesScanned: 8,
    pagesAffected: [3, 1, 3],
    matchesRemoved: 3,
    counts: { email: 2, "credit-card": 1 },
    pageCounts: [
      { page: 3, count: 1 },
      { page: 1, count: 2 },
    ],
    generatedAt: new Date("2026-01-02T03:04:05.000Z"),
    values: ["jane.doe@example.com", "4111 1111 1111 1111"],
  };

  it("summarises counts, pages and patterns", () => {
    const report = formatRedactionReport(input);
    expect(report).toContain("Paperly PDF redaction report");
    expect(report).toContain("Generated: 2026-01-02T03:04:05.000Z");
    expect(report).toContain("File: contract.pdf");
    expect(report).toContain("Pages scanned: 8 of 10");
    expect(report).toContain("Matches removed: 3");
    expect(report).toContain("Pages affected: 2 (pages 1, 3)");
    expect(report).toContain("Email addresses: 2");
    expect(report).toContain("Credit card numbers: 1");
    expect(report).toContain("Page 1: 2");
    expect(report).toContain("Page 3: 1");
  });

  it("never prints sensitive values by default", () => {
    const report = formatRedactionReport(input);
    expect(report).not.toContain("jane.doe@example.com");
    expect(report).not.toContain("4111 1111 1111 1111");
    expect(report).toContain("No matched values are included in this report.");
  });

  it("prints values only when explicitly requested", () => {
    const report = formatRedactionReport({ ...input, includeValues: true });
    expect(report).toContain("jane.doe@example.com");
    expect(report).toContain("included at the operator’s explicit request");
  });

  it("handles a report with no matches", () => {
    const report = formatRedactionReport({ totalPages: 2, pagesScanned: 2, pagesAffected: [], matchesRemoved: 0, counts: {} });
    expect(report).toContain("Matches removed: 0");
    expect(report).toContain("Pages affected: 0");
    expect(report).toContain("(none)");
    expect(report).toContain("File: (unnamed)");
  });

  it("labels known presets and falls back to the raw id", () => {
    expect(presetLabel("email")).toBe("Email addresses");
    expect(presetLabel("something-else")).toBe("something-else");
  });
});
