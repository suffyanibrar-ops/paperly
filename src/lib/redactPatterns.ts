/* ================================================================== *
 * Pattern matching for Find & Redact — pure, DOM-free helpers
 *
 * Everything in this module is a plain function operating on strings so it
 * can be unit-tested in Node without a canvas, a PDF, or React. The UI owns
 * page geometry and rasterisation; this module owns what counts as a match.
 * ================================================================== */

export type PatternId = "email" | "phone" | "ssn" | "credit-card" | "iban" | "date" | "custom";

/** A single regex hit inside one line of text. */
export interface MatchRange {
  /** Inclusive start offset into the searched text. */
  start: number;
  /** Exclusive end offset into the searched text. */
  end: number;
  /** The exact matched substring (`text.slice(start, end)`). */
  value: string;
}

export interface PatternOptions {
  /** Match case-sensitively. Off by default, so presets find `JANE@…` too. */
  caseSensitive?: boolean;
  /** Require a non-word character (or start/end of text) around the match. */
  wholeWord?: boolean;
  /** The user-supplied source when the `custom` preset is used. */
  customPattern?: string;
}

export interface PatternPreset {
  id: PatternId;
  /** Full label for lists and reports. */
  label: string;
  /** Compact label for chips. */
  shortLabel: string;
  /** One-line explanation of what it looks for. */
  description: string;
  /**
   * Regex source. Written with lower-case character classes only where case
   * should be optional — `buildRegex` adds the `i` flag unless the user asks
   * for case-sensitive matching. `null` for the custom preset.
   */
  pattern: string | null;
  /** A safe example value, used for hints only. */
  example: string;
  /**
   * Lower numbers win when two presets overlap on the same text (a card
   * number should not also be reported as a phone number).
   */
  priority: number;
  /** Extra structural checks (Luhn, IBAN mod-97, calendar validity …). */
  validate?: (value: string) => boolean;
}

export const MAX_CUSTOM_PATTERN_LENGTH = 500;

const digitsOf = (value: string) => (value ?? "").replace(/[\s-]/g, "");

/** Luhn (mod-10) checksum used by payment cards. Spaces and hyphens ignored. */
export function luhn(value: string): boolean {
  const digits = digitsOf(value);
  if (!/^\d{2,}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index--) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Validate a payment card: 13–19 digits that pass the Luhn checksum. */
export function isCardNumber(value: string): boolean {
  const digits = digitsOf(value);
  return /^\d{13,19}$/.test(digits) && luhn(digits);
}

/** Validate a US Social Security number in `AAA-GG-SSSS` form. */
export function isSsn(value: string): boolean {
  return /^(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}$/.test(value.trim());
}

export function isPhoneNumber(value: string): boolean {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

/** ISO 13616 IBAN validation (structural length + mod-97). */
export function isIban(value: string): boolean {
  const compact = (value ?? "").replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  if (compact.length < 15 || compact.length > 34) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const character of rearranged) {
    const code = character.charCodeAt(0);
    if (code >= 48 && code <= 57) {
      remainder = (remainder * 10 + (code - 48)) % 97;
    } else {
      for (const digit of String(code - 55).padStart(2, "0")) {
        remainder = (remainder * 10 + Number(digit)) % 97;
      }
    }
  }
  return remainder === 1;
}

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

/** Accept `YYYY-MM-DD` and the common `D/M/Y`, `M/D/Y`, `D.M.Y`, `D-M-Y` forms. */
export function isPlausibleDate(value: string): boolean {
  const text = value.trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
  }
  const parts = text.split(/[/.-]/).map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return false;
  const [first, second, third] = parts;
  const year = third < 100 ? 2000 + third : third;
  if (year < 1900 || year > 2100) return false;
  const monthFirst = first >= 1 && first <= 12 && second >= 1 && second <= daysInMonth(year, first);
  const dayFirst = second >= 1 && second <= 12 && first >= 1 && first <= daysInMonth(year, second);
  return monthFirst || dayFirst;
}

/* ------------------------------------------------------------------ *
 * Presets
 * ------------------------------------------------------------------ */
export const PATTERN_PRESETS: readonly PatternPreset[] = [
  {
    id: "credit-card",
    label: "Credit card numbers",
    shortLabel: "Cards",
    description: "13–19 digit card numbers, confirmed with the Luhn checksum.",
    pattern: "\\d(?:[ -]?\\d){12,18}",
    example: "4111 1111 1111 1111",
    priority: 10,
    validate: isCardNumber,
  },
  {
    id: "iban",
    label: "IBAN account numbers",
    shortLabel: "IBAN",
    description: "International bank account numbers, checked with the ISO mod-97 test.",
    pattern: "[a-z]{2}\\d{2}(?:[ ]?[a-z0-9]{4}){2,7}(?:[ ]?[a-z0-9]{1,3})?",
    example: "GB82 WEST 1234 5698 7654 32",
    priority: 20,
    validate: isIban,
  },
  {
    id: "email",
    label: "Email addresses",
    shortLabel: "Email",
    description: "Standard address form, including plus tags and sub-domains.",
    pattern: "[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}",
    example: "jane.doe@example.com",
    priority: 30,
  },
  {
    id: "ssn",
    label: "US Social Security numbers",
    shortLabel: "SSN",
    description: "Numbers in `AAA-GG-SSSS` form, excluding impossible ranges.",
    pattern: "\\d{3}-\\d{2}-\\d{4}",
    example: "123-45-6789",
    priority: 40,
    validate: isSsn,
  },
  {
    id: "phone",
    label: "Phone numbers",
    shortLabel: "Phone",
    description: "7–15 digit phone numbers with common separators and country prefixes.",
    pattern: "\\+?\\d[\\d\\s().-]{5,}\\d",
    example: "+1 (555) 010-2030",
    priority: 50,
    validate: isPhoneNumber,
  },
  {
    id: "date",
    label: "Dates",
    shortLabel: "Dates",
    description: "Calendar dates in ISO or `D/M/Y`-style numeric formats.",
    pattern: "(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4})",
    example: "2026-11-11",
    priority: 60,
    validate: isPlausibleDate,
  },
  {
    id: "custom",
    label: "Custom regular expression",
    shortLabel: "Custom",
    description: "Your own JavaScript regular expression, matched case-insensitively unless you say otherwise.",
    pattern: null,
    example: "EMP-\\d{6}",
    priority: 0,
  },
];

export const PRESET_BY_ID: Readonly<Record<PatternId, PatternPreset>> = Object.fromEntries(
  PATTERN_PRESETS.map((preset) => [preset.id, preset]),
) as Record<PatternId, PatternPreset>;

export function getPreset(id: string): PatternPreset | undefined {
  return (PRESET_BY_ID as Record<string, PatternPreset>)[id];
}

/** Human label for a preset id; unknown ids fall back to the raw id. */
export function presetLabel(id: string): string {
  return getPreset(id)?.label ?? id;
}

/* ------------------------------------------------------------------ *
 * Regex construction
 * ------------------------------------------------------------------ */
export const INVALID_PATTERN_MESSAGE =
  "That custom pattern isn’t a valid regular expression. Check the brackets, parentheses and backslashes, then try again.";

/**
 * Build the working regex for a preset. Always returns a global regex.
 * Throws a friendly, user-safe error for an empty or invalid custom pattern.
 */
export function buildRegex(presetId: PatternId | PatternPreset, options: PatternOptions = {}): RegExp {
  const preset = typeof presetId === "string" ? getPreset(presetId) : presetId;
  if (!preset) throw new Error(`Unknown pattern preset “${String(presetId)}”.`);

  let source = preset.pattern ?? "";
  if (preset.id === "custom") {
    source = (options.customPattern ?? "").trim();
    if (!source) throw new Error("Enter a custom regular expression to search for.");
    if (source.length > MAX_CUSTOM_PATTERN_LENGTH) {
      throw new Error(`That custom pattern is too long. Keep it under ${MAX_CUSTOM_PATTERN_LENGTH} characters.`);
    }
  }

  const body = options.wholeWord ? `(?<![\\w])(?:${source})(?![\\w])` : `(?:${source})`;
  const flags = `g${options.caseSensitive ? "" : "i"}`;
  try {
    return new RegExp(body, flags);
  } catch {
    throw new Error(INVALID_PATTERN_MESSAGE);
  }
}

/* ------------------------------------------------------------------ *
 * Matching
 * ------------------------------------------------------------------ */
const MAX_MATCHES_PER_TEXT = 5_000;

/** Whether the preset is willing to accept a raw regex hit. */
export function isValidPatternMatch(preset: PatternPreset, value: string): boolean {
  return preset.validate ? preset.validate(value) : true;
}

/**
 * Run a (global) regex over one string and return non-overlapping ranges.
 *
 * The scanner walks forward from the end of each match, so a pattern like
 * `/aba/` on `"ababa"` yields one hit, not two overlapping ones. Zero-length
 * matches are skipped rather than looping forever.
 */
export function findMatches(text: string, regex: RegExp): MatchRange[] {
  if (!text) return [];
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  const scanner = new RegExp(regex.source, flags);
  const matches: MatchRange[] = [];
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text)) !== null) {
    if (match[0].length === 0) {
      scanner.lastIndex += 1;
      continue;
    }
    matches.push({ start: match.index, end: match.index + match[0].length, value: match[0] });
    if (matches.length >= MAX_MATCHES_PER_TEXT) break;
  }
  return matches;
}

export interface OverlapCandidate {
  start: number;
  end: number;
  /** Lower numbers take precedence. Missing priority sorts last. */
  priority?: number;
}

/**
 * Keep a non-overlapping subset of candidate ranges. Priority wins first,
 * then the earlier start, then the longer match — so a Luhn-valid card number
 * survives even when a looser phone pattern covers the same digits.
 * The result is ordered by priority/inspection order; sort for display.
 */
export function resolveOverlaps<T extends OverlapCandidate>(candidates: readonly T[]): T[] {
  const ordered = [...candidates].sort(
    (a, b) =>
      (a.priority ?? 1_000) - (b.priority ?? 1_000) ||
      a.start - b.start ||
      b.end - b.start - (a.end - a.start),
  );
  const accepted: T[] = [];
  for (const candidate of ordered) {
    if (accepted.some((kept) => candidate.start < kept.end && kept.start < candidate.end)) continue;
    accepted.push(candidate);
  }
  return accepted;
}

/* ------------------------------------------------------------------ *
 * Aggregation + reports
 * ------------------------------------------------------------------ */
/** Count matches per preset id. Works with any object carrying `preset`. */
export function countByPattern(matches: ReadonlyArray<{ preset: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const match of matches) {
    const key = match.preset || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export interface RedactionReportInput {
  fileName?: string;
  totalPages: number;
  pagesScanned: number;
  /** 1-based page numbers that were flattened. */
  pagesAffected: readonly number[];
  matchesRemoved: number;
  /** Match counts keyed by preset id. */
  counts: Readonly<Record<string, number>>;
  /** Optional per-page totals; rendered in ascending page order. */
  pageCounts?: ReadonlyArray<{ page: number; count: number }>;
  generatedAt?: Date | string;
  /**
   * Matched values are never written unless the caller explicitly opts in.
   * The UI never does; the redaction report is safe to attach to a ticket.
   */
  includeValues?: boolean;
  values?: readonly string[];
}

const orderPresetIds = (ids: string[]): string[] => {
  const known = PATTERN_PRESETS.map((preset) => preset.id as string);
  return [...ids].sort((a, b) => {
    const orderA = known.indexOf(a);
    const orderB = known.indexOf(b);
    return (orderA === -1 ? 1_000 : orderA) - (orderB === -1 ? 1_000 : orderB) || a.localeCompare(b);
  });
};

/**
 * Build the plain-text redaction report. Contains counts only: filenames,
 * pages and pattern totals — never the sensitive strings themselves unless
 * `includeValues` is explicitly set.
 */
export function formatRedactionReport(input: RedactionReportInput): string {
  const generated = input.generatedAt instanceof Date ? input.generatedAt.toISOString() : (input.generatedAt ?? new Date().toISOString());
  const affected = [...new Set(input.pagesAffected)].sort((a, b) => a - b);
  const lines: string[] = [
    "Paperly PDF redaction report",
    `Generated: ${generated}`,
    `File: ${input.fileName ?? "(unnamed)"}`,
    `Pages scanned: ${input.pagesScanned} of ${input.totalPages}`,
    `Matches removed: ${input.matchesRemoved}`,
    `Pages affected: ${affected.length}${affected.length ? ` (pages ${affected.join(", ")})` : ""}`,
    "",
    "Matches by pattern:",
  ];

  const ids = orderPresetIds(Object.keys(input.counts));
  if (!ids.length) {
    lines.push("  (none)");
  } else {
    for (const id of ids) lines.push(`  ${presetLabel(id)}: ${input.counts[id]}`);
  }

  if (input.pageCounts?.length) {
    lines.push("", "Matches by page:");
    [...input.pageCounts]
      .filter((entry) => entry.count > 0)
      .sort((a, b) => a.page - b.page)
      .forEach((entry) => lines.push(`  Page ${entry.page}: ${entry.count}`));
  }

  lines.push("");
  if (input.includeValues && input.values?.length) {
    lines.push("Matched values (included at the operator’s explicit request):");
    input.values.forEach((value) => lines.push(`  - ${value}`));
  } else {
    lines.push("No matched values are included in this report.");
  }
  return lines.join("\n");
}
