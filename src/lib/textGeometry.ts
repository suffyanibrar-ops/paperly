
/**
 * Text geometry primitives shared by the tools that need to locate text on the
 * page (pattern redaction, table extraction, bookmark generation, inspection).
 *
 * Coordinates are PDF user-space points with the origin at the bottom-left of
 * the *unrotated* page. That matches what `page.getTextContent()` returns for
 * every `/Rotate` value, and it keeps the mapping to a `rotation: 0` render
 * exact: a page rendered unrotated and then re-rotated on export shows the
 * same geometry the matcher saw.
 */


export interface TextBox {
  /** The text exactly as the PDF encodes it. */
  str: string;
  /** Left edge, PDF points. */
  x: number;
  /** Baseline, PDF points (grows upwards). */
  y: number;
  /** Advance width, PDF points. */
  width: number;
  /** Glyph height, PDF points. */
  height: number;
  /** Effective font size in points. */
  fontSize: number;
  /** PDF.js font id (e.g. `g_d0_f1`), useful for grouping styles. */
  fontName: string;
}

export interface LineSpan {
  /** Inclusive start offset into `TextLine.text`. */
  start: number;
  /** Exclusive end offset into `TextLine.text`. */
  end: number;
  item: TextBox;
}

export interface TextLine {
  text: string;
  /** Left edge of the line, PDF points. */
  x: number;
  /** Baseline of the line, PDF points. */
  y: number;
  /** Baseline of the lowest item on the line. */
  bottom: number;
  /** Top edge of the tallest item on the line. */
  top: number;
  width: number;
  height: number;
  fontSize: number;
  items: TextBox[];
  spans: LineSpan[];
}

export interface PageGeometry {
  /** 1-based page number. */
  page: number;
  /** Unrotated page width in points. */
  width: number;
  /** Unrotated page height in points. */
  height: number;
  /** `/Rotate` value in degrees (0, 90, 180, 270). */
  rotation: number;
  items: TextBox[];
  /** Convenience: `items` grouped into reading-order lines. */
  lines: TextLine[];
}

export interface NormalizedBox {
  /** 0–1 from the left of an unrotated render. */
  x: number;
  /** 0–1 from the top of an unrotated render. */
  y: number;
  /** 0–1 fraction of the render width. */
  w: number;
  /** 0–1 fraction of the render height. */
  h: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));


/**
 * Group text items into visual lines using baseline proximity.
 * Items are returned top-to-bottom; each line is ordered left-to-right.
 */
export function groupIntoLines(items: TextBox[], baseTolerance = 2.5): TextLine[] {
  const rows: { y: number; height: number; items: TextBox[] }[] = [];
  for (const item of items) {
    if (!item.str) continue;
    const row = rows.find(
      (candidate) =>
        Math.abs(candidate.y - item.y) <=
        Math.max(baseTolerance, Math.min(candidate.height, item.height) * 0.45),
    );
    if (row) row.items.push(item);
    else rows.push({ y: item.y, height: item.height, items: [item] });
  }
  rows.sort((a, b) => b.y - a.y);

  const lines: TextLine[] = [];
  for (const row of rows) {
    const sorted = [...row.items].sort((a, b) => a.x - b.x || a.y - b.y);
    let text = "";
    let prev: TextBox | null = null;
    const spans: LineSpan[] = [];
    for (const item of sorted) {
      if (prev) {
        const gap = item.x - (prev.x + prev.width);
        const needsSpace =
          gap > Math.max(0.8, Math.min(prev.fontSize, item.fontSize) * 0.12) &&
          !/\s$/.test(text) &&
          !/^\s/.test(item.str);
        if (needsSpace) text += " ";
      }
      const start = text.length;
      text += item.str;
      spans.push({ start, end: text.length, item });
      prev = item;
    }

    // Trim outer whitespace while keeping the character-offset map valid.
    const lead = text.length - text.trimStart().length;
    const trail = text.trimEnd().length;
    const trimmed = text.slice(lead, trail);
    const trimmedSpans = spans
      .map((span) => ({
        start: Math.max(0, Math.min(trimmed.length, span.start - lead)),
        end: Math.max(0, Math.min(trimmed.length, span.end - lead)),
        item: span.item,
      }))
      .filter((span) => span.end > span.start);

    const left = Math.min(...sorted.map((item) => item.x));
    const right = Math.max(...sorted.map((item) => item.x + item.width));
    const bottom = Math.min(...sorted.map((item) => item.y));
    const top = Math.max(...sorted.map((item) => item.y + item.height));
    const fontSize = Math.max(...sorted.map((item) => item.fontSize));
    lines.push({
      text: trimmed,
      x: left,
      y: row.y,
      bottom,
      top,
      width: Math.max(0, right - left),
      height: Math.max(0, top - bottom),
      fontSize,
      items: sorted,
      spans: trimmedSpans,
    });
  }
  return lines;
}

/** Bounding box of one or more items in PDF user space. */
export function unionBox(items: TextBox[]): { x: number; y: number; width: number; height: number } | null {
  if (!items.length) return null;
  let left = Infinity;
  let right = -Infinity;
  let bottom = Infinity;
  let top = -Infinity;
  for (const item of items) {
    left = Math.min(left, item.x);
    right = Math.max(right, item.x + item.width);
    bottom = Math.min(bottom, item.y);
    top = Math.max(top, item.y + item.height);
  }
  return { x: left, y: bottom, width: Math.max(0, right - left), height: Math.max(0, top - bottom) };
}

/**
 * Bounding box of the characters `[start, end)` of a line. Returns a single
 * union box: a matched phrase that wraps a couple of items on the same line is
 * covered completely, including the whitespace between the words.
 */
export function charRangeBox(
  line: TextLine,
  start: number,
  end: number,
): { x: number; y: number; width: number; height: number } | null {
  const from = Math.max(0, Math.min(start, end));
  const to = Math.min(line.text.length, Math.max(start, end));
  if (to <= from) return null;
  const hit = line.spans.filter((span) => span.end > from && span.start < to).map((span) => span.item);
  return unionBox(hit);
}

/**
 * Convert a PDF user-space box into 0–1 coordinates of an unrotated render
 * (origin top-left), which is what a canvas overlay or a burned image needs.
 */
export function boxToNormalized(
  box: { x: number; y: number; width: number; height: number },
  pageWidth: number,
  pageHeight: number,
): NormalizedBox {
  const width = Math.max(1, pageWidth);
  const height = Math.max(1, pageHeight);
  const x = clamp01(box.x / width);
  const topY = clamp01((height - (box.y + Math.max(0, box.height))) / height);
  const w = clamp01((box.x + Math.max(0, box.width)) / width) - x;
  const h = clamp01((height - box.y) / height) - topY;
  return { x, y: topY, w: Math.max(w, 0), h: Math.max(h, 0) };
}
