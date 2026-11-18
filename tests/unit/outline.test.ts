import { readFileSync } from "node:fs";
import JSZip from "jszip";
import path from "node:path";
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import {
  MAX_OUTLINE_LEVELS,
  computeSplitRanges,
  countOutlineNodes,
  detectHeadings,
  entriesToTree,
  flattenOutline,
  headingLevelFromSizes,
  indentEntry,
  insertEntry,
  maxOutlineDepth,
  moveEntry,
  normalizeEntries,
  outdentEntry,
  readOutline,
  removeEntry,
  sanitizeBookmarkTitle,
  uniqueFileNames,
  writeOutline,
  type OutlineEntry,
  type OutlineNode,
} from "@/lib/outline";
import type { PageGeometry, TextLine } from "@/lib/textGeometry";

/* ------------------------------------------------------------------ *
 * Test data
 * ------------------------------------------------------------------ */

function entry(id: string, title: string, page: number, level: number): OutlineEntry {
  return { id, title, page, level };
}

function tree(): OutlineNode[] {
  return [
    {
      title: "Introduction",
      page: 1,
      children: [
        { title: "Scope", page: 2, children: [] },
        { title: "Glossary", page: 3, children: [{ title: "Terms", page: 4, children: [] }] },
      ],
    },
    { title: "Methods", page: 5, children: [] },
  ];
}

function line(text: string, fontSize: number, y = 700): TextLine {
  return {
    text,
    x: 20,
    y,
    bottom: y,
    top: y + fontSize,
    width: text.length * fontSize * 0.5,
    height: fontSize,
    fontSize,
    items: [],
    spans: [],
  };
}

function page(number: number, lines: TextLine[]): PageGeometry {
  return { page: number, width: 595, height: 842, rotation: 0, items: [], lines };
}

function samplePdfPath(): string {
  return path.resolve(process.cwd(), "tests/fixtures/sample.pdf");
}

const fixtureBytes = (): Uint8Array => new Uint8Array(readFileSync(samplePdfPath()));

const NAME_PAGE_MODE = PDFName.of("PageMode");
const NAME_OUTLINES = PDFName.of("Outlines");

/* ------------------------------------------------------------------ *
 * flattenOutline
 * ------------------------------------------------------------------ */

describe("flattenOutline", () => {
  it("walks the tree depth-first and tags each row with its level", () => {
    const entries = flattenOutline(tree());
    expect(entries.map((item) => item.title)).toEqual(["Introduction", "Scope", "Glossary", "Terms", "Methods"]);
    expect(entries.map((item) => item.level)).toEqual([1, 2, 2, 3, 1]);
    expect(entries.map((item) => item.page)).toEqual([1, 2, 3, 4, 5]);
  });

  it("produces unique, deterministic ids", () => {
    const first = flattenOutline(tree());
    const second = flattenOutline(tree());
    expect(first.map((item) => item.id)).toEqual(second.map((item) => item.id));
    expect(new Set(first.map((item) => item.id)).size).toBe(first.length);
  });

  it("returns an empty list for an empty outline and skips malformed nodes", () => {
    expect(flattenOutline([])).toEqual([]);
    const malformed = [{ title: "Loose", page: 2, children: [] }, null] as unknown as OutlineNode[];
    expect(flattenOutline(malformed).map((item) => item.title)).toEqual(["Loose"]);
  });

  it("coerces unknown and non-finite targets to 0", () => {
    const entries = flattenOutline([
      { title: "Broken", page: Number.NaN, children: [] },
      { title: "Negative", page: -4, children: [] },
    ]);
    expect(entries.map((item) => item.page)).toEqual([0, 0]);
  });
});

/* ------------------------------------------------------------------ *
 * entriesToTree / normalization / counting
 * ------------------------------------------------------------------ */

describe("entriesToTree", () => {
  it("round-trips a flattened outline", () => {
    const entries = flattenOutline(tree());
    const rebuilt = entriesToTree(entries);
    expect(countOutlineNodes(rebuilt)).toBe(entries.length);
    expect(maxOutlineDepth(rebuilt)).toBe(3);
    expect(rebuilt[0].children[1].children[0].title).toBe("Terms");
  });

  it("repairs illegal level jumps instead of dropping rows", () => {
    const repaired = normalizeEntries([
      entry("1", "First", 1, 3),
      entry("2", "Second", 2, 5),
      entry("3", "Third", 3, 1),
      entry("4", "Fourth", 4, 9),
    ]);
    expect(repaired.map((item) => item.level)).toEqual([1, 2, 1, 2]);
  });

  it("caps nesting at the maximum supported level", () => {
    const entries = Array.from({ length: 10 }, (_, index) => entry(String(index), `Row ${index}`, index + 1, index + 1));
    const levels = normalizeEntries(entries).map((item) => item.level);
    expect(Math.max(...levels)).toBe(MAX_OUTLINE_LEVELS);
  });

  it("normalises a nested first row into a legal tree", () => {
    const nodes = entriesToTree([entry("1", "Nested first", 1, 4), entry("2", "Sibling", 2, 2)]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].children.map((child) => child.title)).toEqual(["Sibling"]);
  });
});

describe("countOutlineNodes / maxOutlineDepth", () => {
  it("counts every node and measures the deepest branch", () => {
    expect(countOutlineNodes(tree())).toBe(5);
    expect(maxOutlineDepth(tree())).toBe(3);
  });

  it("returns zero for an empty outline", () => {
    expect(countOutlineNodes([])).toBe(0);
    expect(maxOutlineDepth([])).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Structural editing
 * ------------------------------------------------------------------ */

describe("moveEntry", () => {
  it("reorders top-level chapters", () => {
    const entries = flattenOutline(tree());
    const moved = moveEntry(entries, 4, "up");
    expect(moved.map((item) => item.title)).toEqual(["Methods", "Introduction", "Scope", "Glossary", "Terms"]);
    expect(moved.map((item) => item.level)).toEqual([1, 1, 2, 2, 3]);
  });

  it("moves a nested block past its previous sibling without changing nesting", () => {
    const entries = flattenOutline(tree());
    const moved = moveEntry(entries, 2, "up");
    expect(moved.map((item) => item.title)).toEqual(["Introduction", "Glossary", "Terms", "Scope", "Methods"]);
    expect(moved.map((item) => item.level)).toEqual([1, 2, 3, 2, 1]);
  });

  it("moves a block with its subtree past the next sibling", () => {
    const entries = flattenOutline([
      { title: "A", page: 1, children: [] },
      {
        title: "B",
        page: 2,
        children: [{ title: "C", page: 3, children: [] }],
      },
      { title: "D", page: 4, children: [] },
    ]);
    const moved = moveEntry(entries, 1, "down");
    expect(moved.map((item) => item.title)).toEqual(["A", "D", "B", "C"]);
    expect(moved.map((item) => item.level)).toEqual([1, 1, 1, 2]);
  });

  it("is a no-op at the edges, for last children and with a single row", () => {
    const entries = flattenOutline(tree());
    expect(moveEntry(entries, 0, "up")).toEqual(entries);
    expect(moveEntry(entries, 2, "down")).toEqual(entries); // Glossary is the last child
    expect(moveEntry(entries, 4, "down")).toEqual(entries);
    const one = [entry("1", "Only", 1, 1)];
    expect(moveEntry(one, 0, "down")).toEqual(one);
    expect(moveEntry(one, 5, "up")).toEqual(one);
    expect(moveEntry([], 0, "up")).toEqual([]);
  });
});

describe("indentEntry / outdentEntry", () => {
  it("nests a row under its predecessor and lifts it back", () => {
    const entries = [entry("1", "A", 1, 1), entry("2", "B", 2, 1)];
    const indented = indentEntry(entries, 1);
    expect(indented.map((item) => item.level)).toEqual([1, 2]);
    expect(outdentEntry(indented, 1).map((item) => item.level)).toEqual([1, 1]);
  });

  it("shifts a whole subtree together", () => {
    const entries = flattenOutline(tree());
    const outdented = outdentEntry(entries, 2); // Glossary (level 2) + Terms (level 3)
    expect(outdented.map((item) => item.level)).toEqual([1, 2, 1, 2, 1]);
    expect(outdented.map((item) => item.title)).toEqual(["Introduction", "Scope", "Glossary", "Terms", "Methods"]);
  });

  it("refuses to indent the first row or outdent the top level", () => {
    const entries = [entry("1", "A", 1, 1), entry("2", "B", 2, 1)];
    expect(indentEntry(entries, 0)).toEqual(entries);
    expect(outdentEntry(entries, 0)).toEqual(entries);
  });

  it("cannot indent past the maximum level", () => {
    const deep = [entry("1", "A", 1, 1), entry("2", "B", 2, MAX_OUTLINE_LEVELS)];
    expect(indentEntry(deep, 1)).toEqual(deep);
  });
});

describe("removeEntry / insertEntry", () => {
  it("re-attaches orphaned children after their parent is deleted", () => {
    const entries = flattenOutline(tree());
    const withoutGlossary = removeEntry(entries, 2);
    expect(withoutGlossary.map((item) => item.title)).toEqual(["Introduction", "Scope", "Terms", "Methods"]);
    expect(withoutGlossary.map((item) => item.level)).toEqual([1, 2, 3, 1]);
  });

  it("inserts a nested row and re-normalises around it", () => {
    const entries = [entry("1", "A", 1, 1), entry("2", "B", 2, 1)];
    const inserted = insertEntry(entries, 1, entry("3", "Child", 7, 5));
    expect(inserted.map((item) => item.title)).toEqual(["A", "Child", "B"]);
    expect(inserted.map((item) => item.level)).toEqual([1, 2, 1]);
  });
});

/* ------------------------------------------------------------------ *
 * computeSplitRanges
 * ------------------------------------------------------------------ */

describe("computeSplitRanges", () => {
  it("splits on top-level bookmarks and covers the tail of the document", () => {
    const entries = [
      entry("1", "Chapter 1", 1, 1),
      entry("2", "Section 1.1", 2, 2),
      entry("3", "Chapter 2", 4, 1),
    ];
    const ranges = computeSplitRanges(entries, 6, { maxLevel: 1 });
    expect(ranges).toEqual([
      { title: "Chapter 1", startPage: 1, endPage: 3, pages: 3, level: 1, bookmarkCount: 1 },
      { title: "Chapter 2", startPage: 4, endPage: 6, pages: 3, level: 1, bookmarkCount: 1 },
    ]);
  });

  it("includes nested levels when asked", () => {
    const entries = [
      entry("1", "Chapter 1", 1, 1),
      entry("2", "Section 1.1", 2, 2),
      entry("3", "Chapter 2", 4, 1),
    ];
    const ranges = computeSplitRanges(entries, 5, { maxLevel: 2 });
    expect(ranges.map((range) => range.title)).toEqual(["Chapter 1", "Section 1.1", "Chapter 2"]);
    expect(ranges.map((range) => range.pages)).toEqual([1, 2, 2]);
  });

  it("adds front matter only when the first bookmark does not start on page 1", () => {
    const entries = [entry("1", "Chapter 1", 3, 1), entry("2", "Chapter 2", 5, 1)];
    const withFront = computeSplitRanges(entries, 7, { includeFrontMatter: true });
    expect(withFront[0]).toEqual({
      title: "Front matter",
      startPage: 1,
      endPage: 2,
      pages: 2,
      level: 1,
      bookmarkCount: 0,
      isFrontMatter: true,
    });
    expect(withFront.map((range) => range.startPage)).toEqual([1, 3, 5]);

    const withoutFront = computeSplitRanges(entries, 7, { includeFrontMatter: false });
    expect(withoutFront.map((range) => range.startPage)).toEqual([3, 5]);

    // No front matter when the outline already starts on page 1.
    expect(computeSplitRanges([entry("1", "One", 1, 1)], 3)[0].isFrontMatter).toBeUndefined();
  });

  it("merges bookmarks that share a page and reports the merge", () => {
    const entries = [
      entry("1", "Chapter 1", 1, 1),
      entry("2", "Chapter 2", 3, 1),
      entry("3", "Chapter 2 continued", 3, 1),
      entry("4", "Chapter 3", 5, 1),
    ];
    const ranges = computeSplitRanges(entries, 6, { maxLevel: 1 });
    expect(ranges.map((range) => `${range.startPage}-${range.endPage}`)).toEqual(["1-2", "3-4", "5-6"]);
    expect(ranges[1].bookmarkCount).toBe(2);
    expect(ranges[1].title).toBe("Chapter 2");
  });

  it("sorts out-of-order targets and ignores unknown destinations", () => {
    const entries = [
      entry("1", "Appendix", 9, 1),
      entry("2", "Chapter 1", 2, 1),
      entry("3", "Broken", 0, 1),
      entry("4", "Chapter 2", 5, 1),
    ];
    const ranges = computeSplitRanges(entries, 10, { includeFrontMatter: false });
    expect(ranges.map((range) => range.startPage)).toEqual([2, 5, 9]);
    expect(ranges.map((range) => range.endPage)).toEqual([4, 8, 10]);
  });

  it("clamps targets outside the document", () => {
    const ranges = computeSplitRanges([entry("1", "Too far", 99, 1), entry("2", "Negative", -3, 1)], 4, {
      includeFrontMatter: false,
    });
    expect(ranges).toHaveLength(1);
    expect(ranges[0].startPage).toBe(4);
    expect(ranges[0].endPage).toBe(4);
  });

  it("returns no ranges for empty outlines, empty documents and unknown-only outlines", () => {
    expect(computeSplitRanges([], 10)).toEqual([]);
    expect(computeSplitRanges([entry("1", "A", 1, 1)], 0)).toEqual([]);
    expect(computeSplitRanges([entry("1", "A", 0, 1)], 10)).toEqual([]);
  });

  it("produces contiguous, non-overlapping ranges that reach the last page", () => {
    const entries = [entry("1", "A", 2, 1), entry("2", "B", 4, 1), entry("3", "C", 4, 1), entry("4", "D", 7, 1)];
    const ranges = computeSplitRanges(entries, 9, { maxLevel: 1, includeFrontMatter: true });
    let expectedStart = 1;
    for (const range of ranges) {
      expect(range.startPage).toBe(expectedStart);
      expect(range.endPage).toBeGreaterThanOrEqual(range.startPage);
      expectedStart = range.endPage + 1;
    }
    expect(expectedStart).toBe(10);
  });

  it("falls back to a page-derived title for untitled bookmarks", () => {
    const ranges = computeSplitRanges([entry("1", "   ", 3, 1)], 3, { includeFrontMatter: false });
    expect(ranges[0].title).toBe("Section 3");
  });
});

/* ------------------------------------------------------------------ *
 * Filenames
 * ------------------------------------------------------------------ */

describe("sanitizeBookmarkTitle", () => {
  it("keeps readable titles and strips path separators", () => {
    expect(sanitizeBookmarkTitle("Chapter 1: Introduction")).toBe("Chapter 1- Introduction");
    expect(sanitizeBookmarkTitle('A/B\\C|D?E*F<G>H"I')).toBe("A-B-C-D-E-F-G-H-I");
  });

  it("removes control characters and collapses whitespace", () => {
    expect(sanitizeBookmarkTitle("Hello\n\t  world\u0000")).toBe("Hello world");
  });

  it("never returns empty strings or traversal-looking names", () => {
    expect(sanitizeBookmarkTitle("   ")).toBe("section");
    expect(sanitizeBookmarkTitle("", "front-matter")).toBe("front-matter");
    expect(sanitizeBookmarkTitle("..", "fallback")).toBe("fallback");
    expect(sanitizeBookmarkTitle("../../etc/passwd")).toBe("etc-passwd");
  });

  it("avoids Windows reserved device names", () => {
    expect(sanitizeBookmarkTitle("con")).toBe("con-file");
    expect(sanitizeBookmarkTitle("LPT9")).toBe("LPT9-file");
  });

  it("caps very long titles", () => {
    const long = sanitizeBookmarkTitle("x".repeat(300));
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long).toBe("x".repeat(80));
  });

  it("preserves unicode letters and digits", () => {
    expect(sanitizeBookmarkTitle("Überblick — Kapitel 2")).toBe("Überblick — Kapitel 2");
    expect(sanitizeBookmarkTitle("日本語の章")).toBe("日本語の章");
  });
});

describe("uniqueFileNames", () => {
  it("adds ascending suffixes to duplicates", () => {
    expect(uniqueFileNames(["Intro", "Intro", "Intro"])).toEqual(["Intro", "Intro-2", "Intro-3"]);
  });

  it("de-duplicates case-insensitively", () => {
    expect(uniqueFileNames(["Chapter", "chapter", "CHAPTER"])).toEqual(["Chapter", "chapter-2", "CHAPTER-3"]);
  });

  it("avoids colliding with a suffix that is already taken", () => {
    expect(uniqueFileNames(["Chapter", "chapter-2", "Chapter"])).toEqual(["Chapter", "chapter-2", "Chapter-3"]);
  });

  it("repairs empty names", () => {
    expect(uniqueFileNames(["", "  ", ""])).toEqual(["section", "section-2", "section-3"]);
  });
});

/* ------------------------------------------------------------------ *
 * Heading detection
 * ------------------------------------------------------------------ */

describe("headingLevelFromSizes", () => {
  it("maps size ratios to levels", () => {
    expect(headingLevelFromSizes(24, 12)).toBe(1);
    expect(headingLevelFromSizes(18, 12)).toBe(2);
    expect(headingLevelFromSizes(16, 12)).toBe(3);
    expect(headingLevelFromSizes(14, 12)).toBe(4);
    expect(headingLevelFromSizes(12.5, 12)).toBe(0);
  });

  it("is safe with degenerate inputs", () => {
    expect(headingLevelFromSizes(0, 12)).toBe(0);
    expect(headingLevelFromSizes(20, 0)).toBe(0);
    expect(headingLevelFromSizes(Number.NaN, 12)).toBe(0);
  });

  it("honours custom thresholds", () => {
    expect(headingLevelFromSizes(13, 12, [1.05])).toBe(1);
  });
});

describe("detectHeadings", () => {
  const body = "This is a fairly ordinary paragraph of body text that runs across the full measure of the page.";

  it("detects short, larger lines and ignores body text", () => {
    const pages = [
      page(1, [
        line("Annual Report 2024", 24, 780),
        line(body, 11, 740),
        line(body, 11, 720),
        line("Chapter 1", 17, 680),
        line(body, 11, 640),
      ]),
    ];
    const headings = detectHeadings(pages);
    expect(headings.map((item) => item.title)).toEqual(["Annual Report 2024", "Chapter 1"]);
    expect(headings.map((item) => item.level)).toEqual([1, 2]);
    expect(headings.every((item) => item.page === 1)).toBe(true);
  });

  it("rejects long lines even when they are larger than the body", () => {
    const pages = [
      page(1, [
        line(body, 11, 760),
        line(body, 11, 740),
        line(body, 11, 720),
        line(`${body} ${body}`, 24, 700),
        line("Real heading", 24, 660),
      ]),
    ];
    expect(detectHeadings(pages).map((item) => item.title)).toEqual(["Real heading"]);
  });

  it("ignores numeric page-number lines and symbol-only lines", () => {
    const pages = [
      page(1, [line(body, 11, 720), line("Page 3 of 12", 18, 700), line("12", 20, 680), line("— • —", 20, 660)]),
    ];
    expect(detectHeadings(pages)).toEqual([]);
  });

  it("skips running heads repeated across pages", () => {
    const makePage = (number: number, heading: string) =>
      page(number, [line("QUARTERLY REPORT", 16, 800), line(heading, 20, 740), line(body, 11, 700), line(body, 11, 680)]);
    const headings = detectHeadings([makePage(1, "Revenue"), makePage(2, "Costs"), makePage(3, "Outlook")]);
    expect(headings.map((item) => item.title)).toEqual(["Revenue", "Costs", "Outlook"]);
  });

  it("derives body size from the median across all pages", () => {
    const headings = detectHeadings([
      page(1, [line("Title", 28, 780), line(body, 10, 700)]),
      page(2, [line("Subtitle", 13, 780), line(body, 10, 700), line(body, 10, 680)]),
    ]);
    // Median of [28, 10, 13, 10, 10] is 10, so both larger lines qualify.
    expect(headings.map((item) => item.level)).toEqual([1, 3]);
  });

  it("respects maxLevel, maxCandidates, maxChars and a body-size override", () => {
    const pages = [
      page(1, [
        line("Heading one", 20, 800),
        line("Heading two", 20, 760),
        line("Heading three", 24, 720),
        line(body, 10, 680),
        line(body, 10, 660),
        line(body, 10, 640),
        line(body, 10, 620),
        line(body, 10, 600),
      ]),
    ];
    expect(detectHeadings(pages, { maxLevel: 1 })).toHaveLength(3);
    expect(detectHeadings(pages, { maxCandidates: 1 })).toHaveLength(1);
    expect(detectHeadings(pages, { maxChars: 10 })).toEqual([]);
    // Forcing a body size of 20 leaves no line large enough to be a heading.
    expect(detectHeadings(pages, { bodySize: 20 })).toEqual([]);
  });

  it("returns nothing for empty input", () => {
    expect(detectHeadings([])).toEqual([]);
    expect(detectHeadings([page(1, [])])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * pdf-lib integration: tolerant outline reading
 * ------------------------------------------------------------------ */

/** Attach a hand-built outline to a loaded fixture so we can probe odd PDFs. */
function attachOutlines(
  doc: PDFDocument,
  build: (helpers: { context: typeof doc.context; outlinesRef: ReturnType<typeof doc.context.nextRef>; outlines: PDFDict; addItem: (configure: (item: PDFDict) => void) => ReturnType<typeof doc.context.nextRef> }) => void,
): void {
  const context = doc.context;
  const outlinesRef = context.nextRef();
  const outlines = PDFDict.withContext(context);
  outlines.set(PDFName.of("Type"), PDFName.of("Outlines"));
  context.assign(outlinesRef, outlines);
  const itemRefs: ReturnType<typeof context.nextRef>[] = [];
  const addItem = (configure: (item: PDFDict) => void) => {
    const ref = context.nextRef();
    const item = PDFDict.withContext(context);
    item.set(PDFName.of("Title"), PDFHexString.fromText(`Item ${itemRefs.length + 1}`));
    item.set(PDFName.of("Parent"), outlinesRef);
    configure(item);
    context.assign(ref, item);
    itemRefs.push(ref);
    return ref;
  };
  build({ context, outlinesRef, outlines, addItem });
  if (itemRefs.length) {
    outlines.set(PDFName.of("First"), itemRefs[0]);
    outlines.set(PDFName.of("Last"), itemRefs[itemRefs.length - 1]);
    for (let index = 0; index < itemRefs.length - 1; index += 1) {
      const current = context.lookup(itemRefs[index], PDFDict);
      current.set(PDFName.of("Next"), itemRefs[index + 1]);
      const next = context.lookup(itemRefs[index + 1], PDFDict);
      next.set(PDFName.of("Prev"), itemRefs[index]);
    }
  }
  doc.catalog.set(PDFName.of("Outlines"), outlinesRef);
}

describe("readOutline tolerance", () => {
  it("resolves named destinations through /Names /Dests", async () => {
    const doc = await PDFDocument.load(fixtureBytes(), { updateMetadata: false });
    const sectionPage = doc.getPage(1).ref; // page 2
    const destArray = doc.context.obj([sectionPage, "Fit"]);
    doc.catalog.set(PDFName.of("Names"), doc.context.obj({ Dests: doc.context.obj({ Names: [PDFString.of("chapter-two"), destArray] }) }));
    attachOutlines(doc, ({ context, addItem }) => {
      addItem((item) => item.set(PDFName.of("Dest"), PDFString.of("chapter-two")));
      // Non-standard variant: the destination name wrapped in an array.
      addItem((item) => item.set(PDFName.of("Dest"), context.obj([PDFString.of("chapter-two")])));
    });

    const outline = readOutline(doc);
    expect(outline).toHaveLength(2);
    expect(outline.map((item) => item.page)).toEqual([2, 2]);
  });

  it("resolves /A /GoTo actions and legacy /Dests dictionaries", async () => {
    const doc = await PDFDocument.load(fixtureBytes(), { updateMetadata: false });
    const pageTwo = doc.getPage(1).ref;
    doc.catalog.set(PDFName.of("Dests"), doc.context.obj({ Legacy: doc.context.obj([pageTwo, "Fit"]) }));
    attachOutlines(doc, ({ context, addItem }) => {
      addItem((item) => item.set(PDFName.of("Dest"), PDFName.of("Legacy")));
      addItem((item) => item.set(PDFName.of("A"), context.obj({ S: "GoTo", D: context.obj([pageTwo, "Fit"]) })));
      addItem((item) => item.set(PDFName.of("A"), context.obj({ S: "URI", URI: PDFString.of("https://example.com") })));
      addItem((item) => item.set(PDFName.of("Dest"), context.obj([2, "Fit"])));
      addItem((item) => item.set(PDFName.of("Dest"), context.obj([doc.getPage(2).ref, "XYZ", null, null, null])));
    });

    const outline = readOutline(doc);
    // /Dest name → legacy dictionary, /GoTo action, URI action (no page), integer target, third page.
    expect(outline.map((item) => item.page)).toEqual([2, 2, 0, 2, 3]);
  });

  it("survives cyclic /Next chains and unreadable targets", async () => {
    const doc = await PDFDocument.load(fixtureBytes(), { updateMetadata: false });
    attachOutlines(doc, ({ context, addItem, outlines }) => {
      const first = addItem((item) => item.set(PDFName.of("Title"), PDFString.of("Loop")));
      const second = addItem(() => undefined);
      const firstDict = context.lookup(first, PDFDict);
      const secondDict = context.lookup(second, PDFDict);
      firstDict.set(PDFName.of("Next"), second);
      secondDict.set(PDFName.of("Next"), first); // cycle
      outlines.set(PDFName.of("Count"), context.obj(99));
    });

    const outline = readOutline(doc);
    expect(outline.map((item) => item.title)).toEqual(["Loop", "Item 2"]);
    // An item whose destination points at a non-page object degrades to "unknown".
    expect(outline.every((item) => item.page === 0)).toBe(true);
  });

  it("reads nested First/Next trees with the correct depth", async () => {
    const doc = await PDFDocument.load(fixtureBytes(), { updateMetadata: false });
    attachOutlines(doc, ({ context, addItem, outlines }) => {
      const parent = addItem(() => undefined);
      const childRef = context.nextRef();
      const child = PDFDict.withContext(context);
      child.set(PDFName.of("Title"), PDFString.of("Child"));
      child.set(PDFName.of("Parent"), parent);
      child.set(PDFName.of("Dest"), context.obj([doc.getPage(2).ref, "Fit"]));
      context.assign(childRef, child);
      const parentDict = context.lookup(parent, PDFDict);
      parentDict.set(PDFName.of("First"), childRef);
      parentDict.set(PDFName.of("Last"), childRef);
      parentDict.set(PDFName.of("Count"), context.obj(1));
      outlines.set(PDFName.of("Count"), context.obj(2));
    });

    const outline = readOutline(doc);
    expect(flattenOutline(outline).map((item) => `${item.level}:${item.title}`)).toEqual(["1:Item 1", "2:Child"]);
    expect(flattenOutline(outline)[1].page).toBe(3);
  });

  it("treats a document whose /Outlines entry is not a dictionary as empty", async () => {
    const doc = await PDFDocument.load(fixtureBytes(), { updateMetadata: false });
    doc.catalog.set(PDFName.of("Outlines"), PDFName.of("NotAnOutline"));
    expect(readOutline(doc)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * pdf-lib integration: read + write round-trip
 * ------------------------------------------------------------------ */

describe("outline read/write round-trip", () => {
  it("writes a nested outline that survives a reload", async () => {
    const doc = await PDFDocument.load(fixtureBytes(), { updateMetadata: false });
    expect(doc.getPageCount()).toBe(3);
    expect(readOutline(doc)).toEqual([]);

    const entries = [
      entry("a", "Cover", 1, 1),
      entry("b", "Chapter 1", 2, 1),
      entry("c", "Section 1.1", 3, 2),
      entry("d", "Résumé — 日本語", 3, 1),
      entry("e", "No target", 0, 1),
    ];
    const result = writeOutline(doc, entries);
    expect(result).toEqual({ nodeCount: 5, outlineWritten: true });

    const saved = await doc.save();
    const reopened = await PDFDocument.load(saved, { updateMetadata: false });
    const outline = readOutline(reopened);

    expect(countOutlineNodes(outline)).toBe(5);
    expect(flattenOutline(outline).map((item) => item.title)).toEqual([
      "Cover",
      "Chapter 1",
      "Section 1.1",
      "Résumé — 日本語",
      "No target",
    ]);
    expect(flattenOutline(outline).map((item) => item.level)).toEqual([1, 1, 2, 1, 1]);
    expect(flattenOutline(outline).map((item) => item.page)).toEqual([1, 2, 3, 3, 0]);
    // Page content is preserved.
    expect(reopened.getPageCount()).toBe(3);
    // The viewer opens with the outline visible.
    expect(reopened.catalog.get(NAME_PAGE_MODE)?.toString()).toBe("/UseOutlines");
    expect(reopened.catalog.get(NAME_OUTLINES)).toBeDefined();
  });

  it("rewrites an existing outline instead of appending to it", async () => {
    const doc = await PDFDocument.load(fixtureBytes(), { updateMetadata: false });
    writeOutline(doc, [entry("a", "First pass", 1, 1)]);
    const once = await doc.save();
    const reopened = await PDFDocument.load(once, { updateMetadata: false });
    expect(flattenOutline(readOutline(reopened)).map((item) => item.title)).toEqual(["First pass"]);

    writeOutline(reopened, [entry("b", "Second pass", 2, 1), entry("c", "Part two", 2, 2)]);
    const twice = await reopened.save();
    const finalDoc = await PDFDocument.load(twice, { updateMetadata: false });
    expect(flattenOutline(readOutline(finalDoc)).map((item) => item.title)).toEqual(["Second pass", "Part two"]);
  });

  it("clears an outline when every bookmark is removed", async () => {
    const doc = await PDFDocument.load(fixtureBytes(), { updateMetadata: false });
    writeOutline(doc, [entry("a", "Only one", 1, 1)]);
    const withOutline = await doc.save();
    const reopened = await PDFDocument.load(withOutline, { updateMetadata: false });
    expect(readOutline(reopened)).toHaveLength(1);

    const empty = writeOutline(reopened, []);
    expect(empty).toEqual({ nodeCount: 0, outlineWritten: false });
    const saved = await reopened.save();
    const finalDoc = await PDFDocument.load(saved, { updateMetadata: false });
    expect(readOutline(finalDoc)).toEqual([]);
    expect(finalDoc.catalog.get(NAME_OUTLINES)).toBeUndefined();
  });

  it("produces byte-identical output for identical input and entries (deterministic)", async () => {
    const build = async () => {
      const doc = await PDFDocument.load(fixtureBytes(), { updateMetadata: false });
      writeOutline(doc, [entry("a", "Alpha", 1, 1), entry("b", "Beta", 2, 2)]);
      return doc.save();
    };
    const first = await build();
    const second = await build();
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });

  it("tolerates documents without an outline", async () => {
    const doc = await PDFDocument.load(fixtureBytes(), { updateMetadata: false });
    expect(readOutline(doc)).toEqual([]);
    expect(readOutline(await PDFDocument.create())).toEqual([]);
  });

  it("splits into per-section documents that keep their pages", async () => {
    const source = await PDFDocument.load(fixtureBytes(), { updateMetadata: false });
    const ranges = computeSplitRanges(
      [entry("a", "Front", 1, 1), entry("b", "Middle", 2, 1), entry("c", "Back", 3, 1)],
      3,
      { includeFrontMatter: false },
    );
    expect(ranges.map((range) => range.pages)).toEqual([1, 1, 1]);

    const outputs = await Promise.all(
      ranges.map(async (range) => {
        const out = await PDFDocument.create({ updateMetadata: false });
        const indices = Array.from({ length: range.pages }, (_, offset) => range.startPage - 1 + offset);
        const copied = await out.copyPages(source, indices);
        copied.forEach((page) => out.addPage(page));
        return { name: range.title, bytes: await out.save() };
      }),
    );

    // The same ranges drive sanitised, de-duplicated file names.
    const base = uniqueFileNames(ranges.map((range) => sanitizeBookmarkTitle(range.title)));
    expect(base.map((name) => `${name}.pdf`)).toEqual(["Front.pdf", "Middle.pdf", "Back.pdf"]);

    // Deliver exactly what the tool delivers: a ZIP of the section PDFs.
    const zip = new JSZip();
    outputs.forEach((output, index) => zip.file(`${base[index]}.pdf`, output.bytes));
    const zipBytes = await zip.generateAsync({ type: "uint8array" });
    expect(new TextDecoder().decode(zipBytes.slice(0, 2))).toBe("PK");

    const reopenedZip = await JSZip.loadAsync(zipBytes);
    const names = Object.keys(reopenedZip.files).sort();
    expect(names).toEqual(["Back.pdf", "Front.pdf", "Middle.pdf"]);
    for (const name of names) {
      const entryBytes = await reopenedZip.files[name].async("uint8array");
      expect(new TextDecoder().decode(entryBytes.slice(0, 5))).toBe("%PDF-");
      const check = await PDFDocument.load(entryBytes, { updateMetadata: false });
      expect(check.getPageCount()).toBe(1);
    }
  });
});
