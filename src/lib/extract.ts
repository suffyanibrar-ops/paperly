import type { PDFDocumentProxy } from "pdfjs-dist";

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}
import { openPdfJs, parseRanges, uniqueInOrder } from "@/lib/pdf";

export interface LineItem {
  str: string;
  x: number;
  width: number;
}

export interface ExtractedLine {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  items: LineItem[];
}

export interface ExtractedPage {
  page: number;
  width: number;
  height: number;
  lines: ExtractedLine[];
  text: string;
}

function isTextItem(item: unknown): item is TextItem {
  return Boolean(item && typeof (item as { str?: unknown }).str === "string");
}

export async function extractPage(doc: PDFDocumentProxy, pageNumber: number): Promise<ExtractedPage> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items = (content.items as unknown[]).filter(isTextItem).filter((i) => i.str.replace(/\s/g, "").length > 0);

  const rows: { y: number; height: number; items: TextItem[] }[] = [];
  for (const item of items) {
    const x = item.transform[4] as number;
    const y = item.transform[5] as number;
    const height = Math.abs(item.height || item.transform[3] || 10);
    void x;
    const row = rows.find((r) => Math.abs(r.y - y) <= Math.max(2.5, height * 0.42));
    if (row) row.items.push(item);
    else rows.push({ y, height, items: [item] });
  }
  rows.sort((a, b) => b.y - a.y);

  const lines: ExtractedLine[] = rows.map((row) => {
    const sorted = row.items.sort((a, b) => (a.transform[4] as number) - (b.transform[4] as number));
    let text = "";
    let prev: TextItem | null = null;
    const lineItems: LineItem[] = [];
    for (const item of sorted) {
      const x = item.transform[4] as number;
      lineItems.push({ str: item.str, x, width: item.width });
      if (prev) {
        const gap = x - ((prev.transform[4] as number) + prev.width);
        const needsSpace = gap > Math.max(0.8, (prev.height || 10) * 0.12) && !/\s$/.test(text) && !/^\s/.test(item.str);
        if (needsSpace) text += " ";
      }
      text += item.str;
      prev = item;
    }
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const x = first.transform[4] as number;
    const width = last.transform[4] + last.width - x;
    return {
      text: text.replace(/\s+/g, " ").trim(),
      x,
      y: row.y,
      width,
      height: row.height,
      items: lineItems,
    };
  });

  return {
    page: pageNumber,
    width: viewport.width,
    height: viewport.height,
    lines: lines.filter((l) => l.text.length > 0),
    text: lines.map((l) => l.text).join("\n"),
  };
}

export async function extractDocument(
  bytes: ArrayBuffer,
  opts: { pages?: number[]; startPage?: number; endPage?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ pages: ExtractedPage[]; text: string; totalPages: number }> {
  const doc = await openPdfJs(bytes);
  const total = doc.numPages;
  let selected: number[];
  if (opts.pages?.length) selected = opts.pages;
  else if (opts.startPage || opts.endPage) {
    selected = parseRanges(`${opts.startPage ?? 1}-${opts.endPage ?? total}`, total);
  } else selected = Array.from({ length: total }, (_, i) => i + 1);
  selected = uniqueInOrder(selected);
  const pages: ExtractedPage[] = [];
  for (let i = 0; i < selected.length; i++) {
    pages.push(await extractPage(doc, selected[i]));
    opts.onProgress?.(i + 1, selected.length);
  }
  const text = pages.map((p) => p.text).join("\n\n");
  await doc.destroy();
  return { pages, text, totalPages: total };
}

/** Group extracted lines into paragraphs based on vertical gaps and trailing punctuation. */
export function linesToParagraphs(lines: ExtractedLine[]): string[] {
  const paragraphs: string[] = [];
  let current = "";
  let prev: ExtractedLine | null = null;
  for (const line of lines) {
    if (!line.text) continue;
    const gap = prev ? prev.y - line.y : 0;
    const startsNewBlock = prev ? gap > (prev.height || 11) * 1.65 : false;
    const indented = prev ? line.x - prev.x > 14 : false;
    const endsSentence = /[.!?:;”"']$/.test(current);
    const isShortHeading = line.text.length < 80 && /^([A-Z0-9][^.]*)$/.test(line.text) && !prev;
    if (!current) current = line.text;
    else if (startsNewBlock || (endsSentence && gap > (prev?.height ?? 11) * 0.6) || indented || (isShortHeading && current)) {
      paragraphs.push(current);
      current = line.text;
    } else if (current.endsWith("-") && !current.endsWith(" -")) {
      current = current.slice(0, -1) + line.text;
    } else {
      current += ` ${line.text}`;
    }
    prev = line;
  }
  if (current) paragraphs.push(current);
  return paragraphs;
}

/** Detect table columns from item start positions, ignoring sparse/header noise. */
export function detectColumns(lines: ExtractedLine[], tolerance = 9): number[] {
  // Column evidence should come from rows that actually contain several cells.
  const candidates = lines.filter((l) => l.items.length >= 2);
  const source = candidates.length >= 2 ? candidates : lines;
  const starts = source.flatMap((l) => l.items.map((i) => i.x)).sort((a, b) => a - b);
  if (!starts.length) return [0];

  // Cluster item starts that are within a few points of each other.
  const clusters: { edge: number; count: number }[] = [];
  for (const x of starts) {
    const last = clusters[clusters.length - 1];
    if (last && x - last.edge <= tolerance) {
      last.edge = (last.edge * last.count + x) / (last.count + 1);
      last.count++;
    } else {
      clusters.push({ edge: x, count: 1 });
    }
  }

  // A column needs at least two rows of support, or 20% of the table rows.
  const minSupport = Math.max(2, Math.ceil(source.length * 0.18));
  let edges = clusters.filter((c) => c.count >= minSupport).map((c) => c.edge);
  if (edges.length < 2) edges = clusters.slice(0, 12).map((c) => c.edge);
  if (!edges.length) return [0];

  // Merge edges that are too close to be separate columns.
  const merged: number[] = [];
  for (const edge of edges.sort((a, b) => a - b)) {
    if (!merged.length || edge - merged[merged.length - 1] > 16) merged.push(edge);
  }
  return merged.slice(0, 16);
}
