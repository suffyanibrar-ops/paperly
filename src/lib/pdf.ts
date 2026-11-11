/// <reference types="vite/client" />
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from "@cantoo/pdf-lib";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import JSZip from "jszip";
import { fileExt } from "@/lib/format";


/** Attach the original error without relying on ES2022 ErrorOptions. */
function withCause(error: unknown, message: string): Error {
  const wrapped = new Error(message);
  try {
    Object.defineProperty(wrapped, "cause", { value: error, enumerable: false, configurable: true, writable: true });
  } catch {
    /* cause is diagnostic only */
  }
  return wrapped;
}

/* ------------------------------------------------------------------ *
 * PDF.js worker (inlined so the whole app remains a single file)
 * ------------------------------------------------------------------ */
const MAX_CANVAS_PIXELS = 40_000_000;
let workerBooted = false;
function bootWorker() {
  if (workerBooted || typeof window === "undefined") return;
  // The worker is shipped as a separate same-origin asset (see scripts/copy-worker.cjs).
  // If it cannot be fetched, PDF.js falls back to its fake worker automatically.
  pdfjs.GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}pdf.worker.min.mjs`;
  workerBooted = true;
}

const PDFJS_PARAMS = {
  isEvalSupported: false,
  useSystemFonts: true,
  disableFontFace: false,
} as const;

/** Always hand PDF.js a copy: it transfers (detaches) the passed buffer. */
export const MAX_PDF_PAGES = 1000;
export const MAX_CANVAS_PIXELS_PUBLIC = MAX_CANVAS_PIXELS;

export function pdfjsBytes(bytes: ArrayBuffer | Uint8Array): Uint8Array {
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return new Uint8Array(src.slice(0));
}

export interface ManagedPdfDocument extends PDFDocumentProxy {
  /**
   * PDF.js 6 moved teardown to the loading task. We expose the same `destroy()`
   * contract the rest of the app already uses so the worker, transport, caches
   * and WASM memory are genuinely released.
   */
  destroy: () => Promise<void>;
}

export async function openPdfJs(
  bytes: ArrayBuffer | Uint8Array,
  password?: string,
  options: { maxPages?: number } = {},
): Promise<ManagedPdfDocument> {
  bootWorker();
  const task = pdfjs.getDocument({
    ...PDFJS_PARAMS,
    data: pdfjsBytes(bytes),
    ...(password ? { password } : {}),
  });
  let doc: PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy().catch(() => undefined);
    throw withCause(err, readablePdfError(err));
  }
  if (options.maxPages && doc.numPages > options.maxPages) {
    await task.destroy().catch(() => undefined);
    throw new Error(
      `This PDF has ${doc.numPages.toLocaleString()} pages. Paperly processes up to ${options.maxPages.toLocaleString()} pages at once to keep your browser responsive — split it first.`,
    );
  }
  const managed = doc as ManagedPdfDocument;
  if (typeof (managed as unknown as { destroy?: unknown }).destroy !== "function") {
    Object.defineProperty(managed, "destroy", {
      value: async () => {
        try {
          await task.destroy();
        } catch {
          /* worker may already be gone */
        }
      },
      enumerable: false,
      configurable: true,
    });
  }
  return managed;
}

export function readablePdfError(err: unknown): string {
  const e = err as { name?: string; message?: string };
  if (e?.name === "PasswordException") {
    return "This PDF is password-protected. Enter its password, or use the Unlock PDF tool first.";
  }
  if (e?.name === "InvalidPDFException") {
    return "That file isn’t a valid PDF, or it’s damaged. Try the Repair PDF tool.";
  }
  const msg = e?.message || "Something went wrong while reading this PDF.";
  if (/password/i.test(msg)) {
    return "This PDF is password-protected. Enter its password, or use the Unlock PDF tool first.";
  }
  return msg;
}

/* ------------------------------------------------------------------ *
 * pdf-lib helpers
 * ------------------------------------------------------------------ */
export async function openPdfLib(
  bytes: ArrayBuffer | Uint8Array,
  password?: string,
): Promise<PDFDocument> {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    return await PDFDocument.load(data, {
      password,
      updateMetadata: false,
      throwOnInvalidObject: false,
    });
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (/encrypt|password/i.test(msg)) {
      throw withCause(
        err,
        password
          ? "That password didn’t work. Check it and try again."
          : "This PDF is protected. Use Unlock PDF to remove its password first.",
      );
    }
    throw withCause(err, "We couldn’t read this PDF. It may be damaged — try Repair PDF, or use a different file.");
  }
}

export async function getPageDimensions(
  bytes: ArrayBuffer | Uint8Array,
): Promise<{ width: number; height: number; rotation: number }[]> {
  const doc = await openPdfLib(bytes);
  return doc.getPages().map((p) => ({
    width: p.getWidth(),
    height: p.getHeight(),
    rotation: p.getRotation().angle,
  }));
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */
export interface RenderedPage {
  dataUrl: string;
  width: number;
  height: number;
}

export async function renderPdfPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  opts: {
    targetWidth?: number;
    scale?: number;
    type?: "image/jpeg" | "image/png";
    quality?: number;
    rotation?: number;
  } = {},
): Promise<RenderedPage> {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1, ...(opts.rotation !== undefined ? { rotation: opts.rotation } : {}) });
  let scale = opts.scale ?? Math.min(3, (opts.targetWidth ?? 640) / base.width);
  // Guard against huge canvases (A0 scans at 600 DPI can exceed browser limits).
  const requestedPixels = base.width * scale * base.height * scale;
  if (requestedPixels > MAX_CANVAS_PIXELS) {
    scale = Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height));
  }
  const viewport = page.getViewport({ scale, ...(opts.rotation !== undefined ? { rotation: opts.rotation } : {}) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  if (canvas.width * canvas.height > MAX_CANVAS_PIXELS) {
    page.cleanup();
    throw new Error("This page is too large to render safely. Try a lower resolution or crop the page first.");
  }
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Your browser can’t render PDF pages (canvas unavailable).");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  try {
    await page.render({ canvasContext: ctx, viewport, canvas } as never).promise;
  } finally {
    page.cleanup();
  }
  const dataUrl = canvas.toDataURL(opts.type ?? "image/jpeg", opts.quality ?? 0.86);
  const pixelWidth = canvas.width;
  const pixelHeight = canvas.height;
  // Release the backing store promptly; Safari holds large canvases otherwise.
  canvas.width = 1;
  canvas.height = 1;
  return { dataUrl, width: pixelWidth, height: pixelHeight };
}

export async function renderAllPages(
  bytes: ArrayBuffer | Uint8Array,
  opts: { targetWidth?: number; scale?: number; type?: "image/jpeg" | "image/png"; quality?: number } & {
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<RenderedPage[]> {
  const doc = await openPdfJs(bytes);
  const out: RenderedPage[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    out.push(await renderPdfPage(doc, i, opts));
    opts.onProgress?.(i, doc.numPages);
  }
  await doc.destroy();
  return out;
}

export async function imageToJpegDataUrl(
  src: Blob | string,
  maxDimension = 2600,
  quality = 0.86,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const bitmap =
    typeof src === "string" ? await createImageBitmap(await (await fetch(src)).blob()) : await createImageBitmap(src);
  const ratio = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
  canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return { dataUrl: canvas.toDataURL("image/jpeg", quality), width: canvas.width, height: canvas.height };
}

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1] ?? "";
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ------------------------------------------------------------------ *
 * Files & downloads
 * ------------------------------------------------------------------ */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  downloadUrl(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function downloadUrl(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function downloadBytes(bytes: Uint8Array | ArrayBuffer, filename: string, mime = "application/pdf") {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  downloadBlob(new Blob([data as unknown as BlobPart], { type: mime }), filename);
}

export async function zipAndDownload(
  entries: { name: string; data: Blob | Uint8Array | string }[],
  zipName: string,
) {
  const zip = new JSZip();
  for (const entry of entries) {
    if (entry.data instanceof Blob) zip.file(entry.name, entry.data);
    else if (typeof entry.data === "string" && entry.data.startsWith("data:")) {
      zip.file(entry.name, dataUrlToBytes(entry.data));
    } else zip.file(entry.name, entry.data as Uint8Array);
  }
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
  downloadBlob(blob, zipName);
}

export function readFileBytes(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error(`Couldn’t read ${file.name}. Please try again.`));
    reader.readAsArrayBuffer(file);
  });
}

// Pure string helpers are re-exported for the tool modules, which already load
// the PDF engines. Shell-level files import them from "@/lib/format" directly.
export { baseName, fileExt, formatBytes, sanitizeName } from "@/lib/format";

export function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

export function matchesAccept(file: File, accept: string): boolean {
  if (!accept || accept === "*") return true;
  const ext = `.${fileExt(file.name)}`;
  return accept
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .some((token) => {
      if (token.startsWith(".")) return ext === token;
      if (token.endsWith("/*")) return file.type.startsWith(token.replace("*", ""));
      return file.type === token;
    });
}

/* ------------------------------------------------------------------ *
 * Page ranges
 * ------------------------------------------------------------------ */
export type PageSelection = { kind: "all" } | { kind: "list"; pages: number[] };

export function parseRanges(input: string, total: number): number[] {
  const trimmed = input.trim();
  if (!trimmed || /^all$/i.test(trimmed)) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: number[] = [];
  for (const rawPart of trimmed.split(/[,;\s]+/).filter(Boolean)) {
    const part = rawPart.replace(/page/i, "").trim();
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/);
    if (m) {
      const start = m[1] ? Number(m[1]) : 1;
      const end = m[2] ? Number(m[2]) : total;
      if (start < 1 || end > total || start > end) {
        throw new Error(`“${rawPart}” is outside this PDF. It has ${total} page${total === 1 ? "" : "s"}.`);
      }
      for (let p = start; p <= end; p++) pages.push(p);
    } else if (/^\d+$/.test(part)) {
      const p = Number(part);
      if (p < 1 || p > total) {
        throw new Error(`Page ${p} doesn’t exist. This PDF has ${total} page${total === 1 ? "" : "s"}.`);
      }
      pages.push(p);
    } else {
      throw new Error(`“${rawPart}” isn’t a valid page. Try something like 1-3, 5, 8-10.`);
    }
  }
  if (!pages.length) throw new Error("Choose at least one page.");
  return pages;
}

/** Ordered, de-duplicated page indices (1-based) */
export function uniqueInOrder(pages: number[]): number[] {
  return [...new Set(pages)];
}

export function describePages(pages: number[], total: number): string {
  if (pages.length === total) return `All ${total} pages`;
  if (pages.length === 1) return "1 page";
  return `${pages.length} selected pages`;
}

/* ------------------------------------------------------------------ *
 * Fonts
 * ------------------------------------------------------------------ */
export interface FontPack {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
}

export async function embedFonts(doc: PDFDocument): Promise<FontPack> {
  const [regular, bold, italic, boldItalic] = await Promise.all([
    doc.embedFont(StandardFonts.Helvetica),
    doc.embedFont(StandardFonts.HelveticaBold),
    doc.embedFont(StandardFonts.HelveticaOblique),
    doc.embedFont(StandardFonts.HelveticaBoldOblique),
  ]);
  return { regular, bold, italic, boldItalic };
}

export interface TextStyle {
  font: PDFFont;
  size: number;
  color: string;
  lineHeight?: number;
  maxWidth: number;
}

/* Standard PDF fonts use WinAnsi encoding. Map common typography and drop
 * characters the encoding cannot represent, so drawing never throws. */
const WINANSI_EXTRA = new Set(Array.from("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ"));
const CHAR_MAP: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "‚": ",",
  "“": '"',
  "”": '"',
  "„": '"',
  "–": "-",
  "—": "-",
  "…": "...",
  "•": "•",
  "\u00a0": " ",
  "\u2009": " ",
  "\u202f": " ",
  "→": "->",
  "←": "<-",
  "≥": ">=",
  "≤": "<=",
  "≠": "!=",
  "×": "x",
  "✓": "v",
  "₹": "Rs.",
};

export function safePdfText(text: string): string {
  return Array.from(text ?? "")
    .map((ch) => CHAR_MAP[ch] ?? ch)
    .join("")
    .split("")
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return ch === "\n" || ch === "\t" || (code >= 32 && code <= 126) || (code >= 160 && code <= 255) || WINANSI_EXTRA.has(ch);
    })
    .join("");
}

/** Wrap text into lines that fit maxWidth. Handles long words + explicit newlines. */
export function wrapText(text: string, style: TextStyle): string[] {
  const lines: string[] = [];
  const paragraphs = safePdfText(text).replace(/\r\n?/g, "\n").split("\n");
  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) {
      lines.push("");
      continue;
    }
    const words = paragraph.split(/(\s+)/);
    let line = "";
    for (const word of words) {
      if (!word) continue;
      const next = line + word;
      if (style.font.widthOfTextAtSize(next, style.size) <= style.maxWidth || !line.trim()) {
        line = next;
      } else {
        lines.push(line.trimEnd());
        line = word.trimStart();
      }
      while (style.font.widthOfTextAtSize(line, style.size) > style.maxWidth && line.length > 1) {
        // hard-break unbreakable strings (URLs, long tokens)
        let cut = line.length - 1;
        while (cut > 1 && style.font.widthOfTextAtSize(line.slice(0, cut), style.size) > style.maxWidth) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    if (line.trim() || !lines.length) lines.push(line.trimEnd());
  }
  return lines.length ? lines : [""];
}

export function hexToRgb(hex: string) {
  const clean = hex.replace("#", "").trim();
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean.padEnd(6, "0");
  const num = Number.parseInt(full.slice(0, 6), 16);
  return rgb(((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255);
}

export { PDFDocument, StandardFonts, degrees, rgb };
export type { PDFDocumentProxy, PDFPageProxy, PDFFont, PDFPage };
