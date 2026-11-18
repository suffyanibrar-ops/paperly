import type { PDFDocumentProxy } from "pdfjs-dist";
import { MAX_PDF_PAGES, openPdfJs } from "@/lib/pdf";
import { groupIntoLines, type PageGeometry, type TextBox } from "@/lib/textGeometry";

export * from "@/lib/textGeometry";

interface RawTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName?: string;
}

function toTextBox(raw: unknown): TextBox | null {
  const item = raw as Partial<RawTextItem> | null;
  if (!item || typeof item.str !== "string" || !item.str.trim()) return null;
  const transform = Array.isArray(item.transform) ? item.transform : [];
  const x = Number(transform[4]);
  const y = Number(transform[5]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const rawHeight = Math.abs(Number(item.height) || 0);
  const rawSize = Math.abs(Number(transform[3]) || 0) || Math.abs(Number(transform[0]) || 0);
  const fontSize = rawSize || rawHeight || 10;
  return {
    str: item.str,
    x,
    y,
    width: Math.max(0, Number(item.width) || 0),
    height: rawHeight || fontSize,
    fontSize,
    fontName: typeof item.fontName === "string" ? item.fontName : "",
  };
}

/** Read the text geometry of a single page. */
export async function extractPageGeometry(doc: PDFDocumentProxy, pageNumber: number): Promise<PageGeometry> {
  const page = await doc.getPage(pageNumber);
  try {
    const viewport = page.getViewport({ scale: 1, rotation: 0 });
    const content = await page.getTextContent();
    const items = (content.items as unknown[]).map(toTextBox).filter((item): item is TextBox => item !== null);
    return {
      page: pageNumber,
      width: viewport.width,
      height: viewport.height,
      rotation: page.rotate ?? 0,
      items,
      lines: groupIntoLines(items),
    };
  } finally {
    page.cleanup();
  }
}

/**
 * Read the text geometry for a whole document (or a subset of pages).
 * Bounded by the same page cap as the rest of the app.
 */
export async function extractDocumentGeometry(
  bytes: ArrayBuffer | Uint8Array,
  opts: { pages?: number[]; maxPages?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ pages: PageGeometry[]; totalPages: number }> {
  const doc = await openPdfJs(bytes, undefined, { maxPages: opts.maxPages ?? MAX_PDF_PAGES });
  try {
    const selected = (opts.pages?.length ? opts.pages : Array.from({ length: doc.numPages }, (_, index) => index + 1)).filter(
      (page) => page >= 1 && page <= doc.numPages,
    );
    const pages: PageGeometry[] = [];
    for (let index = 0; index < selected.length; index++) {
      pages.push(await extractPageGeometry(doc, selected[index]));
      opts.onProgress?.(index + 1, selected.length);
    }
    return { pages, totalPages: doc.numPages };
  } finally {
    await doc.destroy();
  }
}
