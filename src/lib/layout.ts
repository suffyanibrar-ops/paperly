import { PDFDocument, degrees, rgb, StandardFonts, type PDFEmbeddedPage, type PDFFont } from "@cantoo/pdf-lib";
import { hexToRgb, safePdfText } from "@/lib/pdf";

/* ------------------------------------------------------------------ *
 * Paper & layout helpers shared by resize, N-up, booklet and archive
 * ------------------------------------------------------------------ */
export type PaperKey = "a4" | "letter" | "legal" | "a3" | "a5" | "tabloid" | "custom";

export const PAPER_SIZES: Record<Exclude<PaperKey, "custom">, { name: string; w: number; h: number }> = {
  a4: { name: "A4", w: 595.28, h: 841.89 },
  letter: { name: "US Letter", w: 612, h: 792 },
  legal: { name: "US Legal", w: 612, h: 1008 },
  a3: { name: "A3", w: 841.89, h: 1190.55 },
  a5: { name: "A5", w: 419.53, h: 595.28 },
  tabloid: { name: "Tabloid", w: 792, h: 1224 },
};

export function paperDimensions(key: PaperKey, orientation: "portrait" | "landscape", custom?: { w: number; h: number }) {
  const base = key === "custom" ? { w: custom?.w ?? 595.28, h: custom?.h ?? 841.89 } : PAPER_SIZES[key];
  return orientation === "landscape" ? { w: Math.max(base.w, base.h), h: Math.min(base.w, base.h) } : { w: Math.min(base.w, base.h), h: Math.max(base.w, base.h) };
}

export type PlaceMode = "fit" | "fill" | "stretch" | "actual";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Draw an embedded PDF page into a box, honouring the source page's /Rotate.
 * Uses a vector embed, so text and artwork stay sharp and searchable.
 */
export function placeEmbeddedPage(
  outPage: ReturnType<PDFDocument["addPage"]>,
  embedded: PDFEmbeddedPage,
  box: Box,
  mode: PlaceMode,
  opts: { rotation?: number; border?: boolean; borderColor?: string } = {},
) {
  const baseW = embedded.width;
  const baseH = embedded.height;
  const angle = (((opts.rotation ?? 0) % 360) + 360) % 360;
  const odd = angle === 90 || angle === 270;
  const visualW = odd ? baseH : baseW;
  const visualH = odd ? baseW : baseH;

  let scaleX: number;
  let scaleY: number;
  if (mode === "stretch") {
    scaleX = box.w / visualW;
    scaleY = box.h / visualH;
  } else if (mode === "actual") {
    scaleX = 1;
    scaleY = 1;
  } else {
    const sx = box.w / visualW;
    const sy = box.h / visualH;
    const s = mode === "fill" ? Math.max(sx, sy) : Math.min(sx, sy);
    scaleX = s;
    scaleY = s;
  }

  const drawW = baseW * scaleX;
  const drawH = baseH * scaleY;
  const rad = (angle * Math.PI) / 180;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const x = cx - (drawW / 2) * Math.cos(rad) + (drawH / 2) * Math.sin(rad);
  const y = cy - (drawW / 2) * Math.sin(rad) - (drawH / 2) * Math.cos(rad);

  outPage.drawPage(embedded, {
    x,
    y,
    width: drawW,
    height: drawH,
    rotate: degrees(angle),
  });

  if (opts.border) {
    outPage.drawRectangle({
      x: box.x,
      y: box.y,
      width: box.w,
      height: box.h,
      borderColor: hexToRgb(opts.borderColor ?? "#c9c4b6"),
      borderWidth: 0.7,
    });
  }
}

export async function embedDocumentPages(src: PDFDocument, out: PDFDocument): Promise<PDFEmbeddedPage[]> {
  return out.embedPages(src.getPages());
}

/** Fill an array of page numbers, adding nulls for blank booklet slots. */
export function bookletSequence(count: number): (number | null)[] {
  const padded = Math.ceil(count / 4) * 4;
  const sequence: (number | null)[] = [];
  // Saddle-stitch order for n=8: 8,1 · 2,7 · 6,3 · 4,5
  for (let side = 0; side < padded / 2; side++) {
    const outer = padded - side;
    const inner = side + 1;
    const pair = side % 2 === 0 ? [outer, inner] : [inner, outer];
    for (const pageNumber of pair) sequence.push(pageNumber >= 1 && pageNumber <= count ? pageNumber : null);
  }
  return sequence;
}

export interface SlotTexts {
  left: string;
  center: string;
  right: string;
}

export function replacePlaceholders(
  template: string,
  vars: { page: number; total: number; title: string; filename: string; date: string; bates: string },
): string {
  return template
    .replace(/\{page\}/gi, String(vars.page))
    .replace(/\{total\}/gi, String(vars.total))
    .replace(/\{title\}/gi, vars.title)
    .replace(/\{filename\}/gi, vars.filename)
    .replace(/\{date\}/gi, vars.date)
    .replace(/\{bates\}/gi, vars.bates);
}

export function drawSlots(
  page: ReturnType<PDFDocument["addPage"]>,
  slots: SlotTexts,
  opts: {
    font: PDFFont;
    size: number;
    color: string;
    marginX: number;
    marginY: number;
    atTop: boolean;
    rule?: boolean;
    ruleColor?: string;
  },
) {
  const width = page.getWidth();
  const height = page.getHeight();
  const y = opts.atTop ? height - opts.marginY - opts.size : opts.marginY;
  const entries: [keyof SlotTexts, string][] = [
    ["left", safePdfText(slots.left)],
    ["center", safePdfText(slots.center)],
    ["right", safePdfText(slots.right)],
  ];
  for (const [align, text] of entries) {
    if (!text.trim()) continue;
    const textWidth = opts.font.widthOfTextAtSize(text, opts.size);
    const x =
      align === "left" ? opts.marginX : align === "right" ? width - opts.marginX - textWidth : (width - textWidth) / 2;
    page.drawText(text, { x, y, size: opts.size, font: opts.font, color: hexToRgb(opts.color) });
  }
  if (opts.rule) {
    const ruleY = opts.atTop ? height - opts.marginY + 4 : opts.marginY + opts.size + 4;
    page.drawLine({
      start: { x: opts.marginX, y: ruleY },
      end: { x: width - opts.marginX, y: ruleY },
      thickness: 0.6,
      color: hexToRgb(opts.ruleColor ?? "#c9c4b6"),
    });
  }
}

export const DATE_VARS = () => new Date();

/** Small helper: font for a chosen family. */
export async function layoutFont(doc: PDFDocument, family: "Helvetica" | "Times" | "Courier", bold = false): Promise<PDFFont> {
  const map = {
    Helvetica: bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica,
    Times: bold ? StandardFonts.TimesRomanBold : StandardFonts.TimesRoman,
    Courier: bold ? StandardFonts.CourierBold : StandardFonts.Courier,
  };
  return doc.embedFont(map[family]);
}

export function rgbWhite() {
  return rgb(1, 1, 1);
}
