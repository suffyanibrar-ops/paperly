import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFString,
  type PDFDocument,
} from "@cantoo/pdf-lib";
import type { PageGeometry, TextLine } from "@/lib/textGeometry";

/**
 * Everything the Structure tools need to read, edit, write and split a PDF
 * outline (bookmark tree).
 *
 * The pure helpers at the top are DOM-free and free of pdf-lib objects so they
 * can be unit-tested directly. The two low-level functions at the bottom —
 * `readOutline` and `writeOutline` — are the only places that touch pdf-lib's
 * object model. Both are written defensively: real-world outlines contain
 * dangling references, cyclic /Next chains, missing /Parent entries, named
 * destinations and outright garbage, and none of that may crash the tools.
 */

/* ================================================================== *
 * Types
 * ================================================================== */

/** One bookmark row as the editors work with it: a flat, level-tagged list. */
export interface OutlineEntry {
  /** UI-only identity. Never written into the PDF. */
  id: string;
  title: string;
  /** 1-based page number, or 0 when the bookmark has no resolvable target. */
  page: number;
  /** 1-based nesting depth. */
  level: number;
}

/** A nested bookmark, as read from (or written to) a PDF. */
export interface OutlineNode {
  title: string;
  /** 1-based page number, or 0 when the target could not be resolved. */
  page: number;
  children: OutlineNode[];
}

/** A contiguous page range that becomes one output file. */
export interface SplitRange {
  title: string;
  /** 1-based, inclusive. */
  startPage: number;
  /** 1-based, inclusive. */
  endPage: number;
  /** Number of pages in the range (`endPage - startPage + 1`). */
  pages: number;
  /** Outline level of the bookmark that opened the range (1 for front matter). */
  level: number;
  /** How many bookmark targets were merged into this range (same page). */
  bookmarkCount: number;
  isFrontMatter?: boolean;
}

export interface SplitOptions {
  /** Include bookmarks up to this nesting depth (default: 1, top level). */
  maxLevel?: number;
  /** Emit pages before the first bookmark as their own range (default: true). */
  includeFrontMatter?: boolean;
  /** Title used for the front-matter range (default: "Front matter"). */
  frontMatterTitle?: string;
}

export interface HeadingCandidate {
  title: string;
  /** 1-based page number. */
  page: number;
  /** 1..6, derived from the font-size ratio. */
  level: number;
  fontSize: number;
}

export interface DetectHeadingsOptions {
  /** Override the body-text size instead of deriving it from the page median. */
  bodySize?: number;
  /** Minimum `fontSize / bodySize` for a line to count as a heading (default 1.12). */
  minRatio?: number;
  /** Longest heading title to accept, in characters (default 110). */
  maxChars?: number;
  /** Deepest heading level to emit (default 3, capped at 6). */
  maxLevel?: number;
  /** Safety cap on the number of candidates (default 400). */
  maxCandidates?: number;
  /** Skip text repeated across pages — running heads and footers (default true). */
  excludeRunningHeads?: boolean;
}

/** Outline nesting deeper than this is collapsed to level 6. */
export const MAX_OUTLINE_LEVELS = 6;
/** Safety cap so a malicious / corrupted outline cannot freeze the tab. */
const MAX_OUTLINE_NODES = 10000;
/** Safety cap on nesting while reading. */
const MAX_OUTLINE_READ_DEPTH = 12;
/** Titles longer than this are truncated when read. */
const MAX_READ_TITLE_LENGTH = 300;
/** Titles longer than this are truncated when written. */
const MAX_WRITE_TITLE_LENGTH = 512;

export const HEADING_RATIO_THRESHOLDS: readonly number[] = [1.8, 1.5, 1.28, 1.12];

/* ================================================================== *
 * Pure helpers — flat entries
 * ================================================================== */

const clampLevel = (value: number): number => {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(MAX_OUTLINE_LEVELS, Math.round(value)));
};

/**
 * Depth-first flatten of a nested outline into level-tagged rows.
 * Ids are deterministic (`b0`, `b1`, …) so the same tree always produces the
 * same list — they exist only for React keys.
 */
export function flattenOutline(nodes: OutlineNode[]): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  let counter = 0;
  const walk = (list: OutlineNode[], level: number) => {
    if (!Array.isArray(list)) return;
    for (const node of list) {
      if (!node || typeof node !== "object") continue;
      entries.push({
        id: `b${counter++}`,
        title: typeof node.title === "string" ? node.title : "",
        page: Number.isFinite(node.page) ? Math.max(0, Math.round(node.page)) : 0,
        level: Math.min(level, MAX_OUTLINE_LEVELS),
      });
      const children = Array.isArray(node.children) ? node.children : [];
      if (children.length && level < MAX_OUTLINE_LEVELS) walk(children, level + 1);
    }
  };
  walk(nodes, 1);
  return entries;
}

/**
 * Force a flat list into a legal outline: first row level 1, no level jump of
 * more than one, positive levels, capped at {@link MAX_OUTLINE_LEVELS}.
 * This is what keeps every edit (delete a parent, drag a subtree) well formed.
 */
export function normalizeEntries(entries: OutlineEntry[]): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  let previous = 0;
  for (const entry of entries) {
    const level = Math.max(1, Math.min(clampLevel(entry.level), previous + 1, MAX_OUTLINE_LEVELS));
    out.push(level === entry.level ? entry : { ...entry, level });
    previous = level;
  }
  return out;
}

/**
 * Nest a flat, level-tagged list into a tree. Rows whose level is deeper than
 * their predecessor + 1 are promoted to the deepest legal level.
 */
export function entriesToTree(entries: OutlineEntry[]): OutlineNode[] {
  const root: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  for (const entry of normalizeEntries(entries)) {
    const node: OutlineNode = {
      title: entry.title.trim() || "Untitled bookmark",
      page: Number.isFinite(entry.page) ? Math.max(0, Math.round(entry.page)) : 0,
      children: [],
    };
    if (entry.level <= 1 || stack.length === 0) {
      root.push(node);
      stack.length = 1;
      stack[0] = node;
      continue;
    }
    const parent = stack[entry.level - 2];
    if (parent) parent.children.push(node);
    else root.push(node);
    stack.length = entry.level;
    stack[entry.level - 1] = node;
  }
  return root;
}

/** Total number of bookmarks in a nested tree. */
export function countOutlineNodes(nodes: OutlineNode[]): number {
  let count = 0;
  const walk = (list: OutlineNode[]) => {
    if (!Array.isArray(list)) return;
    for (const node of list) {
      count += 1;
      if (Array.isArray(node.children)) walk(node.children);
    }
  };
  walk(nodes);
  return count;
}

/** Deepest nesting level in a tree (0 for an empty outline). */
export function maxOutlineDepth(nodes: OutlineNode[]): number {
  let depth = 0;
  const walk = (list: OutlineNode[], level: number) => {
    if (!Array.isArray(list)) return;
    for (const node of list) {
      depth = Math.max(depth, level);
      if (Array.isArray(node.children)) walk(node.children, level + 1);
    }
  };
  walk(nodes, 1);
  return depth;
}

/* ------------------------------------------------------------------ *
 * Pure helpers — structural editing
 * ------------------------------------------------------------------ */

/** Index just past the last descendant of `entries[index]`. */
function blockEnd(entries: OutlineEntry[], index: number): number {
  const level = entries[index]?.level ?? 1;
  let end = index + 1;
  while (end < entries.length && entries[end].level > level) end += 1;
  return end;
}

function shiftBlock(entries: OutlineEntry[], index: number, delta: number): OutlineEntry[] {
  const end = blockEnd(entries, index);
  return entries.map((entry, current) =>
    current >= index && current < end ? { ...entry, level: clampLevel(entry.level + delta) } : entry,
  );
}

/** Remove one row. Orphaned children re-attach to the nearest visible ancestor. */
export function removeEntry(entries: OutlineEntry[], index: number): OutlineEntry[] {
  if (index < 0 || index >= entries.length) return entries;
  return normalizeEntries(entries.filter((_, current) => current !== index));
}

/** Insert a row and re-normalise the levels around it. */
export function insertEntry(entries: OutlineEntry[], index: number, entry: OutlineEntry): OutlineEntry[] {
  const at = Math.max(0, Math.min(entries.length, index));
  const next = [...entries.slice(0, at), entry, ...entries.slice(at)];
  return normalizeEntries(next);
}

/**
 * Swap a row (with its whole subtree) with its previous/next sibling.
 * Movement is sibling-scoped, so nesting never becomes invalid.
 */
export function moveEntry(entries: OutlineEntry[], index: number, direction: "up" | "down"): OutlineEntry[] {
  if (index < 0 || index >= entries.length || entries.length < 2) return entries;
  const level = entries[index].level;
  const end = blockEnd(entries, index);

  if (direction === "up") {
    let previous = index - 1;
    while (previous >= 0 && entries[previous].level > level) previous -= 1;
    if (previous < 0 || entries[previous].level !== level) return entries;
    return [...entries.slice(0, previous), ...entries.slice(index, end), ...entries.slice(previous, index), ...entries.slice(end)];
  }

  const next = end;
  if (next >= entries.length || entries[next].level !== level) return entries;
  const nextEnd = blockEnd(entries, next);
  return [...entries.slice(0, index), ...entries.slice(next, nextEnd), ...entries.slice(index, next), ...entries.slice(nextEnd)];
}

/** Nest a row under the row directly before it. No-op when that is impossible. */
export function indentEntry(entries: OutlineEntry[], index: number): OutlineEntry[] {
  if (index <= 0 || index >= entries.length) return entries;
  const level = entries[index].level;
  const previousLevel = entries[index - 1].level;
  if (level >= MAX_OUTLINE_LEVELS || previousLevel < level) return entries;
  return normalizeEntries(shiftBlock(entries, index, 1));
}

/** Lift a row (and its subtree) one level. No-op at the top level. */
export function outdentEntry(entries: OutlineEntry[], index: number): OutlineEntry[] {
  if (index < 0 || index >= entries.length || entries[index].level <= 1) return entries;
  return normalizeEntries(shiftBlock(entries, index, -1));
}

/* ================================================================== *
 * Pure helpers — split ranges
 * ================================================================== */

/**
 * Turn a flat outline into contiguous, non-overlapping page ranges in document
 * order:
 *
 * - bookmarks without a resolvable page are ignored;
 * - targets are clamped into `1..pageCount`;
 * - several bookmarks on the same page collapse into one range (the first title
 *   wins and the merge is reported through `bookmarkCount`);
 * - out-of-order targets are sorted by page, so ranges always move forward;
 * - pages before the first bookmark optionally become a "front matter" range.
 */
export function computeSplitRanges(entries: OutlineEntry[], pageCount: number, opts: SplitOptions = {}): SplitRange[] {
  const total = Number.isFinite(pageCount) ? Math.max(0, Math.floor(pageCount)) : 0;
  if (total < 1 || !Array.isArray(entries) || !entries.length) return [];
  const maxLevel = Math.max(1, Math.min(MAX_OUTLINE_LEVELS, Math.round(opts.maxLevel ?? 1)));
  const includeFrontMatter = opts.includeFrontMatter ?? true;

  const candidates = entries
    .filter((entry) => entry && Number.isFinite(entry.page) && entry.page >= 1 && entry.level <= maxLevel)
    .map((entry) => {
      const page = Math.min(total, Math.max(1, Math.round(entry.page)));
      return {
        title: entry.title.trim() || `Section ${page}`,
        page,
        level: Math.max(1, Math.min(MAX_OUTLINE_LEVELS, Math.round(entry.level) || 1)),
      };
    });

  if (!candidates.length) return [];

  // Stable sort keeps outline order for bookmarks that share a page.
  candidates.sort((a, b) => a.page - b.page);

  const starts: { title: string; page: number; level: number; bookmarkCount: number }[] = [];
  for (const candidate of candidates) {
    const current = starts[starts.length - 1];
    if (current && current.page === candidate.page) {
      current.bookmarkCount += 1;
      continue;
    }
    starts.push({ title: candidate.title, page: candidate.page, level: candidate.level, bookmarkCount: 1 });
  }

  const ranges: SplitRange[] = [];
  if (includeFrontMatter && starts[0].page > 1) {
    ranges.push({
      title: opts.frontMatterTitle?.trim() || "Front matter",
      startPage: 1,
      endPage: starts[0].page - 1,
      pages: starts[0].page - 1,
      level: 1,
      bookmarkCount: 0,
      isFrontMatter: true,
    });
  }
  starts.forEach((start, index) => {
    const endPage = index + 1 < starts.length ? starts[index + 1].page - 1 : total;
    if (endPage < start.page) return;
    ranges.push({
      title: start.title,
      startPage: start.page,
      endPage,
      pages: endPage - start.page + 1,
      level: start.level,
      bookmarkCount: start.bookmarkCount,
    });
  });
  return ranges;
}

/* ================================================================== *
 * Pure helpers — filenames
 * ================================================================== */

const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Turn a bookmark title into a safe cross-platform file base name (no
 * extension). Keeps Unicode letters, drops control characters, replaces the
 * characters Windows/Unix reject, and never returns something that could be
 * read as a path.
 */
export function sanitizeBookmarkTitle(title: string, fallback = "section"): string {
  const cleaned = String(title ?? "")
    .normalize("NFC")
    // control characters, including newlines and tabs
    .replace(/\p{Cc}+/gu, " ")
    // characters that are illegal in file names on common platforms
    .replace(/[\\/:*?"<>|]+/g, "-")
    // keep whitespace tidy
    .replace(/\s+/g, " ")
    .trim()
    // no leading/trailing dots, dashes or spaces (hidden files, Windows rules)
    .replace(/^[.\-\s]+/, "")
    .replace(/[.\-\s]+$/, "")
    .slice(0, 80)
    .replace(/[.\-\s]+$/, "")
    .trim();
  if (!cleaned) return fallback;
  const safe = RESERVED_WINDOWS_NAMES.test(cleaned) ? `${cleaned}-file` : cleaned;
  return safe || fallback;
}

/**
 * De-duplicate file base names case-insensitively: `Chapter`, `Chapter` and
 * `chapter-2` become `Chapter`, `Chapter-2`, `chapter-2-2` (the first two clash,
 * the third is already taken, so the counter keeps climbing).
 */
export function uniqueFileNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw) => {
    const base = String(raw ?? "").trim() || "section";
    let candidate = base;
    let counter = 2;
    while (used.has(candidate.toLowerCase())) {
      candidate = `${base}-${counter}`;
      counter += 1;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

/* ================================================================== *
 * Pure helpers — heading detection
 * ================================================================== */

const normalizeSpace = (value: string): string => String(value ?? "").replace(/\s+/g, " ").trim();

const median = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Map a font size relative to the body size to an outline level (0 = body text). */
export function headingLevelFromSizes(
  size: number,
  bodySize: number,
  thresholds: readonly number[] = HEADING_RATIO_THRESHOLDS,
): number {
  if (!Number.isFinite(size) || !Number.isFinite(bodySize) || size <= 0 || bodySize <= 0) return 0;
  const ratio = size / bodySize;
  for (let index = 0; index < thresholds.length; index += 1) {
    if (ratio >= thresholds[index] - 1e-9) return index + 1;
  }
  return 0;
}

/**
 * Heuristic table-of-contents generation from the text layer.
 *
 * The body size is the median line size across the document; anything at least
 * `minRatio` larger is a heading, with the level derived from how much larger it
 * is. Long lines (paragraphs) and short numeric lines (page numbers) are
 * rejected, and text repeated across pages (running heads) is skipped.
 */
export function detectHeadings(pages: PageGeometry[], opts: DetectHeadingsOptions = {}): HeadingCandidate[] {
  const usablePages = (Array.isArray(pages) ? pages : []).filter(
    (page): page is PageGeometry => Boolean(page) && Array.isArray(page.lines) && Number.isFinite(page.page),
  );
  if (!usablePages.length) return [];

  const minRatio = Number.isFinite(opts.minRatio) && (opts.minRatio as number) > 0 ? (opts.minRatio as number) : 1.12;
  const maxChars = Number.isFinite(opts.maxChars) && (opts.maxChars as number) > 0 ? Math.round(opts.maxChars as number) : 110;
  const maxLevel = Math.max(1, Math.min(MAX_OUTLINE_LEVELS, Math.round(opts.maxLevel ?? 3)));
  const maxCandidates = Math.max(1, Math.round(opts.maxCandidates ?? 400));
  const excludeRunningHeads = opts.excludeRunningHeads ?? true;

  const sizes: number[] = [];
  for (const page of usablePages) {
    for (const line of page.lines) {
      if (line && typeof line.text === "string" && line.text.trim() && Number.isFinite(line.fontSize) && line.fontSize > 0) {
        sizes.push(line.fontSize);
      }
    }
  }
  const bodySize = Number.isFinite(opts.bodySize) && (opts.bodySize as number) > 0 ? (opts.bodySize as number) : median(sizes);
  if (!(bodySize > 0)) return [];

  const seenOnPage = new Map<string, number>();
  for (const page of usablePages) {
    const unique = new Set<string>();
    for (const line of page.lines) {
      const key = normalizeSpace(line?.text ?? "").toLowerCase();
      if (!key || unique.has(key)) continue;
      unique.add(key);
      seenOnPage.set(key, (seenOnPage.get(key) ?? 0) + 1);
    }
  }
  const repeatedThreshold = Math.max(3, Math.ceil(usablePages.length * 0.4));

  const candidates: HeadingCandidate[] = [];
  const ordered = [...usablePages].sort((a, b) => a.page - b.page);
  for (const page of ordered) {
    for (const line of page.lines as TextLine[]) {
      if (candidates.length >= maxCandidates) break;
      const text = normalizeSpace(line?.text ?? "");
      if (text.length < 2 || text.length > maxChars) continue;
      if (!/\p{L}/u.test(text)) continue;
      if (/^(page\s*)?\d+(\s*(of|\/)\s*\d+)?$/i.test(text)) continue;
      const level = headingLevelFromSizes(line.fontSize, bodySize);
      if (level < 1 || level > maxLevel) continue;
      if (line.fontSize / bodySize < minRatio - 1e-9) continue;
      if (excludeRunningHeads && usablePages.length >= 3 && (seenOnPage.get(text.toLowerCase()) ?? 0) >= repeatedThreshold) continue;
      candidates.push({ title: text, page: page.page, level, fontSize: line.fontSize });
    }
  }
  return candidates;
}

/* ================================================================== *
 * pdf-lib reading
 * ================================================================== */

const OBJ_TITLE = PDFName.of("Title");
const OBJ_PARENT = PDFName.of("Parent");
const OBJ_NEXT = PDFName.of("Next");
const OBJ_PREV = PDFName.of("Prev");
const OBJ_FIRST = PDFName.of("First");
const OBJ_LAST = PDFName.of("Last");
const OBJ_COUNT = PDFName.of("Count");
const OBJ_DEST = PDFName.of("Dest");
const OBJ_D = PDFName.of("D");
const OBJ_A = PDFName.of("A");
const OBJ_S = PDFName.of("S");
const OBJ_OUTLINES = PDFName.of("Outlines");
const OBJ_NAMES = PDFName.of("Names");
const OBJ_DESTS = PDFName.of("Dests");
const OBJ_KIDS = PDFName.of("Kids");
const OBJ_TYPE = PDFName.of("Type");
const OBJ_PAGE_MODE = PDFName.of("PageMode");

function deref(doc: PDFDocument, value: PDFObject | undefined): PDFObject | undefined {
  if (!value) return undefined;
  try {
    return value instanceof PDFRef ? doc.context.lookup(value) : value;
  } catch {
    return undefined;
  }
}

function asDict(doc: PDFDocument, value: PDFObject | undefined): PDFDict | undefined {
  const resolved = deref(doc, value);
  return resolved instanceof PDFDict ? resolved : undefined;
}

function asArray(doc: PDFDocument, value: PDFObject | undefined): PDFArray | undefined {
  const resolved = deref(doc, value);
  return resolved instanceof PDFArray ? resolved : undefined;
}

/** Decode any PDF string-ish object into text. Never throws. */
function stringValue(value: PDFObject | undefined): string {
  try {
    if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
    if (value instanceof PDFName) return value.decodeText();
  } catch {
    /* fall through */
  }
  return "";
}

function cleanReadTitle(raw: string, fallback: string): string {
  const cleaned = normalizeSpace(raw.replace(/\p{Cc}+/gu, " "));
  if (!cleaned) return fallback;
  return cleaned.length > MAX_READ_TITLE_LENGTH ? `${cleaned.slice(0, MAX_READ_TITLE_LENGTH)}…` : cleaned;
}

/** Map `"obj gen R"` for every page to its 1-based page number. */
function buildPageMap(doc: PDFDocument): Map<string, number> {
  const map = new Map<string, number>();
  try {
    doc.getPages().forEach((page, index) => {
      if (page?.ref) map.set(page.ref.tag, index + 1);
    });
  } catch {
    /* a broken page tree still yields whatever we managed to map */
  }
  return map;
}

/** Compare a name-tree key (string or name) with a decoded destination name. */
function nameMatches(doc: PDFDocument, value: PDFObject | undefined, name: string): boolean {
  const decoded = stringValue(deref(doc, value));
  return decoded !== "" && decoded === name;
}

/**
 * Look a destination up in the catalog's name tree (`/Names /Dests`), handling
 * both `/Names` arrays and `/Kids` subtrees. Returns the raw destination value.
 */
function searchNameTree(doc: PDFDocument, node: PDFObject | undefined, name: string, depth = 0): PDFObject | undefined {
  if (depth > 8) return undefined;
  const dict = asDict(doc, node);
  if (!dict) return undefined;

  const names = asArray(doc, dict.get(OBJ_NAMES));
  if (names) {
    for (let index = 0; index + 1 < names.size(); index += 2) {
      const key = names.get(index);
      if (nameMatches(doc, key, name)) return names.get(index + 1);
    }
  }
  const kids = asArray(doc, dict.get(OBJ_KIDS));
  if (kids) {
    for (let index = 0; index < kids.size(); index += 1) {
      const found = searchNameTree(doc, kids.get(index), name, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/** Resolve a named destination through `/Names /Dests` or the legacy `/Dests` dict. */
function findNamedDestination(doc: PDFDocument, name: string): PDFObject | undefined {
  if (!name) return undefined;
  try {
    const namesDict = asDict(doc, doc.catalog.get(OBJ_NAMES));
    if (namesDict) {
      const found = searchNameTree(doc, namesDict.get(OBJ_DESTS), name);
      if (found) return found;
    }
  } catch {
    /* ignore and try the legacy dictionary */
  }
  try {
    const legacy = asDict(doc, doc.catalog.get(OBJ_DESTS));
    if (legacy) {
      for (const key of legacy.keys()) {
        if (nameMatches(doc, key, name)) return legacy.get(key);
      }
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * Resolve a `/Dest` value to a 1-based page number, or 0 when it cannot be
 * resolved. Supports explicit arrays, named destinations, and destination
 * dictionaries with `/D`.
 */
function resolveDestinationPage(
  doc: PDFDocument,
  value: PDFObject | undefined,
  pageMap: Map<string, number>,
  depth = 0,
): number {
  if (!value || depth > 6) return 0;
  const resolved = deref(doc, value);
  if (!resolved) return 0;

  if (resolved instanceof PDFArray) {
    if (resolved.size() === 0) return 0;
    const first = resolved.get(0);
    if (first instanceof PDFRef) return pageMap.get(first.tag) ?? 0;
    if (first instanceof PDFString || first instanceof PDFHexString || first instanceof PDFName) {
      // Non-standard but seen in the wild: the name of a destination wrapped in
      // a one-element array.
      return resolveDestinationPage(doc, findNamedDestination(doc, stringValue(first)), pageMap, depth + 1);
    }
    if (first instanceof PDFNumber) {
      const page = Math.round(first.asNumber());
      return Number.isFinite(page) && page > 0 ? page : 0;
    }
    // Some writers wrap the page number in an indirect object.
    const indirect = deref(doc, first);
    if (indirect instanceof PDFNumber) {
      const page = Math.round(indirect.asNumber());
      return Number.isFinite(page) && page > 0 ? page : 0;
    }
    if (indirect instanceof PDFRef) return pageMap.get(indirect.tag) ?? 0;
    return 0;
  }

  if (resolved instanceof PDFDict) {
    const inner = resolved.get(OBJ_D) ?? resolved.get(OBJ_DEST);
    if (inner) return resolveDestinationPage(doc, inner, pageMap, depth + 1);
    return 0;
  }

  const name = stringValue(resolved);
  if (name) return resolveDestinationPage(doc, findNamedDestination(doc, name), pageMap, depth + 1);
  return 0;
}

/** Page for one outline item: `/Dest` first, then a `/GoTo` action. */
function resolveItemPage(doc: PDFDocument, item: PDFDict, pageMap: Map<string, number>): number {
  const direct = resolveDestinationPage(doc, item.get(OBJ_DEST), pageMap);
  if (direct > 0) return direct;
  const action = asDict(doc, item.get(OBJ_A));
  if (!action) return 0;
  const kind = stringValue(deref(doc, action.get(OBJ_S)));
  if (kind !== "GoTo" && kind !== "GoToR") return 0;
  return resolveDestinationPage(doc, action.get(OBJ_D), pageMap);
}

interface ReadState {
  pages: Map<string, number>;
  pageCount: number;
  visited: Set<string>;
  nodes: number;
  truncated: boolean;
}

function readSiblings(doc: PDFDocument, first: PDFObject | undefined, depth: number, state: ReadState): OutlineNode[] {
  const nodes: OutlineNode[] = [];
  let current: PDFObject | undefined = first;
  let guard = 0;

  while (current && guard < MAX_OUTLINE_NODES) {
    guard += 1;
    const ref = current instanceof PDFRef ? current : undefined;
    if (ref) {
      if (state.visited.has(ref.tag)) break; // cyclic /Next chain
      state.visited.add(ref.tag);
    }
    const item = asDict(doc, current);
    if (!item) break;
    if (state.nodes >= MAX_OUTLINE_NODES) {
      state.truncated = true;
      break;
    }
    state.nodes += 1;

    let title = "Untitled bookmark";
    let page: number;
    try {
      title = cleanReadTitle(stringValue(deref(doc, item.get(OBJ_TITLE))), "Untitled bookmark");
    } catch {
      /* keep the fallback */
    }
    try {
      page = resolveItemPage(doc, item, state.pages);
      if (page > state.pageCount) page = state.pageCount;
    } catch {
      page = 0;
    }

    let children: OutlineNode[] = [];
    if (depth < MAX_OUTLINE_READ_DEPTH) {
      try {
        children = readSiblings(doc, item.get(OBJ_FIRST), depth + 1, state);
      } catch {
        children = [];
      }
    }
    nodes.push({ title, page, children });

    try {
      current = item.get(OBJ_NEXT);
    } catch {
      current = undefined;
    }
  }
  return nodes;
}

export interface OutlineReadResult {
  nodes: OutlineNode[];
  /** True when the safety cap kicked in and the tree is incomplete. */
  truncated: boolean;
  /** Number of bookmarks actually read. */
  nodeCount: number;
}

/**
 * Read the document outline as a nested tree plus metadata about the read.
 * Returns an empty tree for documents with no outline (and for outlines so
 * damaged that no item could be read) — this function never throws.
 *
 * `truncated` is important for editors: when it is true, saving the tree would
 * silently drop the bookmarks beyond {@link MAX_OUTLINE_NODES}, so the UI warns
 * instead of pretending the read was complete.
 */
export function readOutlineWithMeta(doc: PDFDocument): OutlineReadResult {
  try {
    if (!doc?.catalog) return { nodes: [], truncated: false, nodeCount: 0 };
    const root = asDict(doc, doc.catalog.get(OBJ_OUTLINES));
    if (!root) return { nodes: [], truncated: false, nodeCount: 0 };
    const state: ReadState = {
      pages: buildPageMap(doc),
      pageCount: Math.max(0, doc.getPageCount()),
      visited: new Set<string>(),
      nodes: 0,
      truncated: false,
    };
    const first = root.get(OBJ_FIRST);
    const nodes = readSiblings(doc, first, 1, state);
    return { nodes, truncated: state.truncated, nodeCount: countOutlineNodes(nodes) };
  } catch {
    return { nodes: [], truncated: false, nodeCount: 0 };
  }
}

/** Read the outline tree only. Never throws. */
export function readOutline(doc: PDFDocument): OutlineNode[] {
  return readOutlineWithMeta(doc).nodes;
}

/* ================================================================== *
 * pdf-lib writing
 * ================================================================== */

export interface OutlineWriteResult {
  /** Number of bookmark items written (0 when the outline was cleared). */
  nodeCount: number;
  /** True when a fresh `/Outlines` tree and `/PageMode /UseOutlines` were set. */
  outlineWritten: boolean;
}

function cleanWriteTitle(raw: string, fallback: string): string {
  const cleaned = String(raw ?? "")
    .normalize("NFC")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const title = cleaned || fallback;
  return title.length > MAX_WRITE_TITLE_LENGTH ? title.slice(0, MAX_WRITE_TITLE_LENGTH) : title;
}

function writeDest(doc: PDFDocument, pageNumber: number): PDFArray | undefined {
  const pageCount = doc.getPageCount();
  if (!Number.isFinite(pageNumber) || pageNumber <= 0 || pageCount < 1) return undefined;
  const safePage = Math.min(pageCount, Math.max(1, Math.round(pageNumber)));
  let ref: PDFRef;
  try {
    ref = doc.getPage(safePage - 1).ref;
  } catch {
    return undefined;
  }
  const dest = PDFArray.withContext(doc.context);
  dest.push(ref);
  dest.push(PDFName.of("XYZ"));
  dest.push(PDFNull);
  dest.push(PDFNull);
  dest.push(PDFNull);
  return dest;
}

/**
 * Replace the document outline with `entries` (a flat, level-tagged list).
 *
 * The tree is rebuilt from scratch with indirect `/Outlines` and item
 * dictionaries — `First`/`Last`/`Count` for children, `Prev`/`Next`/`Parent` for
 * navigation, `/Title` as a UTF-16 hex string (so non-Latin titles survive) and
 * `/Dest` as `[page /XYZ null null null]`. The catalog then points at the new
 * tree and opens with `/PageMode /UseOutlines`.
 *
 * The rest of the document is untouched: pdf-lib re-serializes every parsed
 * object, so pages, content streams, fonts and images come through unchanged,
 * and the catalog simply stops pointing at the old tree. Old outline objects
 * may therefore survive as unreferenced objects — invisible in every reader,
 * and only a few kilobytes on disk for a typical document.
 *
 * Callers should reload the saved bytes and re-read the outline to verify the
 * result before offering it for download.
 */
export function writeOutline(doc: PDFDocument, entries: OutlineEntry[]): OutlineWriteResult {
  const { context, catalog } = doc;

  // Clearing: unlink the tree and drop the viewer mode we own.
  if (!entries.length) {
    catalog.delete(OBJ_OUTLINES);
    const pageMode = catalog.get(OBJ_PAGE_MODE);
    if (pageMode instanceof PDFName && pageMode.decodeText() === "UseOutlines") catalog.delete(OBJ_PAGE_MODE);
    return { nodeCount: 0, outlineWritten: false };
  }

  const tree = entriesToTree(entries);
  const outlinesRef = context.nextRef();
  const outlines = PDFDict.withContext(context);
  outlines.set(OBJ_TYPE, PDFName.of("Outlines"));
  context.assign(outlinesRef, outlines);

  const writeSiblings = (siblings: OutlineNode[], parentRef: PDFRef, depth: number): { first?: PDFRef; last?: PDFRef; count: number } => {
    let first: PDFRef | undefined;
    let last: PDFRef | undefined;
    let previous: { ref: PDFRef; dict: PDFDict } | undefined;
    let count = 0;

    for (const node of siblings) {
      const ref = context.nextRef();
      const dict = PDFDict.withContext(context);
      context.assign(ref, dict);

      dict.set(OBJ_TITLE, PDFHexString.fromText(cleanWriteTitle(node.title, "Untitled bookmark")));
      dict.set(OBJ_PARENT, parentRef);
      const dest = writeDest(doc, node.page);
      if (dest) dict.set(OBJ_DEST, dest);

      let descendants = 0;
      if (Array.isArray(node.children) && node.children.length && depth < MAX_OUTLINE_LEVELS) {
        const child = writeSiblings(node.children, ref, depth + 1);
        if (child.first && child.last) {
          dict.set(OBJ_FIRST, child.first);
          dict.set(OBJ_LAST, child.last);
          dict.set(OBJ_COUNT, PDFNumber.of(child.count));
          descendants = child.count;
        }
      }

      if (previous) {
        previous.dict.set(OBJ_NEXT, ref);
        dict.set(OBJ_PREV, previous.ref);
      } else {
        first = ref;
      }
      last = ref;
      previous = { ref, dict };
      count += 1 + descendants;
    }

    return { first, last, count };
  };

  const top = writeSiblings(tree, outlinesRef, 1);
  const nodeCount = countOutlineNodes(tree);
  if (top.first && top.last) {
    outlines.set(OBJ_FIRST, top.first);
    outlines.set(OBJ_LAST, top.last);
    outlines.set(OBJ_COUNT, PDFNumber.of(nodeCount));
  }

  catalog.set(OBJ_OUTLINES, outlinesRef);
  catalog.set(OBJ_PAGE_MODE, PDFName.of("UseOutlines"));
  return { nodeCount, outlineWritten: true };
}
