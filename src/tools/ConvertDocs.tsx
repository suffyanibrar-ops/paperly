import {
  Check,
  Copy,
  FileSpreadsheet,
  FileText,
  FileType,
  Presentation,
  TextCursorInput,
} from "lucide-react";
import { useEffect, useState } from "react";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import pptxgen from "pptxgenjs";
import { AlignmentType, Document, HeadingLevel, ImageRun, Packer, Paragraph, TextRun } from "docx";
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber } from "@cantoo/pdf-lib";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  PDFDocument,
  baseName,
  dataUrlToBytes,
  embedFonts,
  formatBytes,
  hexToRgb,
  openPdfJs,
  renderPdfPage,
  readFileBytes,
  rgb,
  sanitizeName,
  wrapText,
  type FontPack,
} from "@/lib/pdf";
import { detectColumns, extractDocument, linesToParagraphs, type ExtractedPage } from "@/lib/extract";
import { buildWordBlocks } from "@/lib/wordLayout";
import { tableToCsv } from "@/lib/tables";
import { useInitialFiles, usePdfFile, usePdfThumbs } from "@/lib/usePdf";
import { copyText } from "@/lib/router";
import { assertZipSafe, friendlyProcessingError, validateUpload } from "@/lib/security";
import { describeJobTime, useJob } from "@/lib/job";
import { useDownloadShortcut, usePrimaryShortcut } from "@/lib/hotkeys";
import { useToolPreferences } from "@/lib/prefs";
import { downloadOutput } from "@/lib/output";
import { describePageQuery, parsePageQuery } from "@/lib/pageQuery";
import { SAMPLE } from "@/lib/sample";
import {
  Alert,
  Badge,
  Button,
  Field,
  FileDrop,
  FileRow,
  Progress,
  Segmented,
  Select,
  Switch,
  TextArea,
  TextInput,
} from "@/components/ui";
import { DownloadPanel, RangeField, SinglePdfInput } from "@/components/toolParts";
import { AdvancedOptions, OptionNote, OptionsGrid } from "@/components/AdvancedOptions";
import { cn } from "@/utils/cn";

/* ================================================================== *
 * Shared conversion helpers
 * ================================================================== */
const PAPER_POINTS = {
  a4: [595.28, 841.89],
  letter: [612, 792],
  legal: [612, 1008],
  a5: [419.53, 595.28],
} as const;
type PaperKey = keyof typeof PAPER_POINTS;
const PAPER_LABEL: Record<PaperKey, string> = { a4: "A4", letter: "US Letter", legal: "US Legal", a5: "A5" };

/** Fires the OCR tool when a PDF has no text layer, without silently OCR-ing. */
function OcrLink() {
  return (
    <a href="/ocr-pdf" className="font-semibold underline">
      Open OCR PDF
    </a>
  );
}

interface ShortcutHintProps {
  run: string;
  download?: string;
}

function ShortcutHint({ run, download }: ShortcutHintProps) {
  return (
    <span className="text-[11px] text-muted">
      {run}
      {download ? ` · ${download}` : ""}
    </span>
  );
}

/* ================================================================== *
 * PDF → WORD
 * ================================================================== */
interface PageImage {
  dataUrl: string;
  width: number;
  height: number;
}

interface ObjectStore {
  get: (id: string, callback?: (data: unknown) => void) => unknown;
  has: (id: string) => boolean;
}

/** Raster images decoded by PDF.js are either ImageBitmaps or raw pixel buffers. */
function imageObjectToDataUrl(value: unknown): PageImage | null {
  if (!value || typeof value !== "object") return null;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return null;
  if (typeof ImageBitmap !== "undefined" && value instanceof ImageBitmap) {
    if (!value.width || !value.height) return null;
    canvas.width = value.width;
    canvas.height = value.height;
    context.drawImage(value, 0, 0);
  } else {
    const raw = value as { data?: Uint8Array | Uint8ClampedArray; width?: number; height?: number; kind?: number };
    const width = Number(raw.width ?? 0);
    const height = Number(raw.height ?? 0);
    if (!raw.data || !width || !height || raw.kind === 1) return null;
    canvas.width = width;
    canvas.height = height;
    if (raw.data.length === width * height * 4) {
      context.putImageData(new ImageData(new Uint8ClampedArray(raw.data), width, height), 0, 0);
    } else if (raw.data.length === width * height * 3) {
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let pixel = 0, source = 0; pixel < width * height; pixel += 1, source += 3) {
        rgba[pixel * 4] = raw.data[source];
        rgba[pixel * 4 + 1] = raw.data[source + 1];
        rgba[pixel * 4 + 2] = raw.data[source + 2];
        rgba[pixel * 4 + 3] = 255;
      }
      context.putImageData(new ImageData(rgba, width, height), 0, 0);
    } else {
      return null;
    }
  }
  // Decorative rules and bullets are not worth the document size.
  if (canvas.width < 40 || canvas.height < 40) return null;
  const dataUrl = canvas.toDataURL("image/png");
  const width = canvas.width;
  const height = canvas.height;
  canvas.width = 1;
  canvas.height = 1;
  return { dataUrl, width, height };
}

function resolveObject(store: ObjectStore, name: string): Promise<PageImage | null> {
  return new Promise((resolve) => {
    if (!store.has(name)) {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value: PageImage | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(null), 1500);
    try {
      store.get(name, (data: unknown) => {
        window.clearTimeout(timer);
        try {
          finish(imageObjectToDataUrl(data));
        } catch {
          finish(null);
        }
      });
    } catch {
      window.clearTimeout(timer);
      finish(null);
    }
  });
}

/** Pictures drawn on one page, in paint order. Never throws. */
async function readPageImages(doc: PDFDocumentProxy, pageNumber: number, limit = 4): Promise<PageImage[]> {
  const page = await doc.getPage(pageNumber);
  try {
    const opList = await page.getOperatorList();
    const names: string[] = [];
    const inline: PageImage[] = [];
    for (let i = 0; i < opList.fnArray.length && names.length + inline.length < limit; i += 1) {
      const fn = opList.fnArray[i];
      const args = opList.argsArray[i] as unknown[] | undefined;
      if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
        const name = args?.[0];
        if (typeof name === "string" && !names.includes(name)) names.push(name);
      } else if (fn === OPS.paintInlineImageXObject && args?.[0]) {
        // Inline images arrive with their pixels, so no object lookup is needed.
        const decoded = imageObjectToDataUrl(args[0]);
        if (decoded) inline.push(decoded);
      }
    }
    if (!names.length) return inline.slice(0, limit);
    // One tiny render forces PDF.js to decode this page's images into `page.objs`,
    // which is what makes the pixels readable through the public object store.
    try {
      const viewport = page.getViewport({ scale: 0.12 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const context = canvas.getContext("2d");
      if (context) await page.render({ canvasContext: context, viewport, canvas } as never).promise;
      canvas.width = 1;
      canvas.height = 1;
    } catch {
      /* A page that cannot render simply yields no pictures. */
    }
    const store = page.objs as unknown as ObjectStore;
    const found: PageImage[] = [...inline];
    for (const name of names) {
      if (found.length >= limit) break;
      const image = await resolveObject(store, name);
      if (image) found.push(image);
    }
    return found.slice(0, limit);
  } catch {
    return [];
  } finally {
    page.cleanup();
  }
}

interface WordResult {
  bytes: Uint8Array;
  name: string;
  chars: number;
  pages: number;
  images: number;
  sparsePages: number[];
}

export function PdfToWordTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const opts = useToolPreferences("pdf-to-word", {
    layout: "flow" as "flow" | "positioned",
    includeImages: true,
    pageBreaks: true,
    headingDetection: true,
  });
  const [range, setRange] = useState("");
  const [result, setResult] = useState<WordResult | null>(null);
  const job = useJob<WordResult>();
  const canRun = Boolean(pdf.bytes && pdf.file) && !job.busy;

  const convert = () => {
    if (!pdf.bytes || !pdf.file) return;
    const bytes = pdf.bytes;
    const sourceName = pdf.file.name;
    const total = pdf.pageCount;
    void (async () => {
      const output = await job.run(async (reporter) => {
        const pages = parsePageQuery(range, total);
        reporter.report(2, "Reading the text layer…", describePageQuery(pages, total));
        const extracted = await extractDocument(bytes, {
          pages,
          onProgress: (done, count) => {
            reporter.throwIfCancelled();
            reporter.report(2 + (done / Math.max(1, count)) * 58, `Reading page ${done} of ${count}…`, describePageQuery(pages, total));
          },
        });
        reporter.throwIfCancelled();
        const characters = extracted.text.replace(/\s/g, "").length;
        if (characters < 10) {
          throw new Error(
            "No text layer found on the selected pages. This PDF is a scan, so there is nothing to convert without OCR — run OCR PDF first, then convert it.",
          );
        }
        const sparsePages = extracted.pages.filter((page) => page.text.replace(/\s/g, "").length < 25).map((page) => page.page);

        const pageImages = new Map<number, PageImage[]>();
        if (opts.value.includeImages) {
          reporter.report(62, "Collecting pictures…");
          const doc = await openPdfJs(bytes);
          try {
            for (let i = 0; i < extracted.pages.length; i += 1) {
              reporter.throwIfCancelled();
              const pageNumber = extracted.pages[i].page;
              const found = await readPageImages(doc, pageNumber, 4);
              if (found.length) pageImages.set(pageNumber, found);
              reporter.report(62 + ((i + 1) / Math.max(1, extracted.pages.length)) * 20, `Collecting pictures from page ${pageNumber}…`);
            }
          } finally {
            await doc.destroy();
          }
        }
        reporter.throwIfCancelled();
        reporter.report(86, "Building the Word document…");

        const children: Paragraph[] = [];
        let imageCount = 0;
        const pushImage = (image: PageImage) => {
          const maxWidth = 460;
          const scale = Math.min(1, maxWidth / image.width);
          children.push(
            new Paragraph({
              spacing: { before: 120, after: 160 },
              alignment: AlignmentType.CENTER,
              children: [
                new ImageRun({
                  type: "png",
                  data: dataUrlToBytes(image.dataUrl),
                  transformation: { width: Math.round(image.width * scale), height: Math.round(image.height * scale) },
                }),
              ],
            }),
          );
          imageCount += 1;
        };

        extracted.pages.forEach((page, pageIndex) => {
          if (pageIndex > 0 && opts.value.pageBreaks) {
            children.push(new Paragraph({ pageBreakBefore: true, children: [] }));
          }
          if (opts.value.layout === "positioned" && page.lines.length) {
            const left = Math.min(...page.lines.map((line) => line.x));
            page.lines.forEach((line) => {
              const indent = Math.max(0, Math.round((line.x - left) * 20));
              const halfPoints = Math.min(32, Math.max(14, Math.round((line.height || 10) * 2)));
              children.push(
                new Paragraph({
                  indent: { left: indent },
                  spacing: { after: 20, line: Math.round(Math.max(10, line.height || 10) * 1.32 * 20) },
                  alignment: AlignmentType.LEFT,
                  children: [new TextRun({ text: line.text, size: halfPoints, font: "Calibri" })],
                }),
              );
            });
          } else {
            const blocks = buildWordBlocks(page);
            blocks.forEach((block) => {
              const isHeading = opts.value.headingDetection && block.kind === "heading";
              const heading =
                isHeading && block.level === 1
                  ? HeadingLevel.HEADING_1
                  : isHeading && block.level === 2
                    ? HeadingLevel.HEADING_2
                    : isHeading
                      ? HeadingLevel.HEADING_3
                      : undefined;
              const alignment =
                block.align === "center" ? AlignmentType.CENTER : block.align === "right" ? AlignmentType.RIGHT : AlignmentType.LEFT;
              const size = Math.round(Math.min(72, Math.max(7, block.fontSize)) * 2);
              children.push(
                new Paragraph({
                  heading,
                  bullet: block.kind === "bullet" ? { level: 0 } : undefined,
                  indent: { left: Math.round(block.indent * 20) },
                  spacing: {
                    after: isHeading ? 240 : 120,
                    line: Math.round(Math.max(12, block.fontSize * 1.5) * 20),
                  },
                  alignment,
                  children: [
                    new TextRun({
                      text: block.text,
                      size,
                      font: "Calibri",
                      bold: isHeading || block.bold,
                    }),
                  ],
                }),
              );
            });
          }
          for (const image of pageImages.get(page.page) ?? []) pushImage(image);
        });

        if (!children.length) {
          throw new Error("These pages produced no text. Try a different page range or run OCR PDF first.");
        }

        const doc = new Document({
          creator: "Paperly",
          title: baseName(sourceName),
          description: "Converted from PDF with Paperly",
          sections: [
            {
              properties: { page: { margin: { top: 900, bottom: 900, left: 900, right: 900 } } },
              children,
            },
          ],
        });
        const blob = await Packer.toBlob(doc);
        reporter.report(100, "Done");
        return {
          bytes: new Uint8Array(await blob.arrayBuffer()),
          name: `${sanitizeName(baseName(sourceName))}.docx`,
          chars: characters,
          pages: extracted.pages.length,
          images: imageCount,
          sparsePages,
        };
      });
      if (output) setResult(output);
    })();
  };

  // A new document must never show the previous file's result.
  useEffect(() => {
    setResult(null);
  }, [pdf.bytes]);

  usePrimaryShortcut(convert, canRun);
  useDownloadShortcut(
    () => {
      if (!result) return;
      downloadOutput(
        result.bytes,
        result.name,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
    },
    Boolean(result),
  );

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A text-based PDF" />
      {pdf.bytes && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <RangeField
              value={range}
              onChange={setRange}
              total={pdf.pageCount}
              label="Pages to convert"
              hint="Leave empty for the whole document."
            />
            <div>
              <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink/70">Text layout</p>
              <Segmented<"flow" | "positioned">
                value={opts.value.layout}
                onChange={(value) => opts.set("layout", value)}
                size="sm"
                options={[
                  { value: "flow", label: "Flowing paragraphs" },
                  { value: "positioned", label: "Positioned lines" },
                ]}
              />
              <p className="mt-1.5 text-[11.5px] text-muted">
                {opts.value.layout === "flow"
                  ? "Flowing paragraphs read better and edit more naturally in Word."
                  : "Positioned lines keep each line where it started — better for forms and tables."}
              </p>
            </div>
          </div>
          <AdvancedOptions
            scope="pdf-to-word"
            badge="3 controls"
            description="Pictures, page breaks, heading detection"
            onReset={opts.reset}
          >
            <OptionsGrid>
              <Switch
                label="Include images"
                checked={opts.value.includeImages}
                onChange={(value) => opts.set("includeImages", value)}
                description="Embeds the pictures drawn on each page as PNG. Adds size but keeps logos and charts."
              />
              <Switch
                label="Start every page on a new page"
                checked={opts.value.pageBreaks}
                onChange={(value) => opts.set("pageBreaks", value)}
                description="Adds a page break between PDF pages so pagination survives."
              />
              <Switch
                label="Detect headings"
                checked={opts.value.headingDetection}
                onChange={(value) => opts.set("headingDetection", value)}
                description="Turns the first short line into a Word Heading 1 so the navigation pane works."
              />
            </OptionsGrid>
            <div className="mt-3">
              <OptionNote>
                Text always stays selectable and editable. Scanned pages have no text layer — this tool never runs OCR on its own.
              </OptionNote>
            </div>
          </AdvancedOptions>
          {job.failed && (
            <Alert tone="error">
              {job.error} {/OCR|scan/i.test(job.error) && <OcrLink />}
            </Alert>
          )}
          {job.status === "cancelled" && <Alert tone="info">Cancelled — nothing was downloaded. Your previous result is unchanged.</Alert>}
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={convert} loading={job.busy} disabled={!canRun}>
              <FileType className="h-4 w-4" /> Convert to Word
            </Button>
            {job.busy && (
              <Button variant="ghost" onClick={job.cancel}>
                Cancel
              </Button>
            )}
            <ShortcutHint run="⌘/Ctrl + Enter to convert" download={result ? "⌘/Ctrl + S to download" : undefined} />
          </div>
          {job.busy && (
            <Progress
              value={job.percent ?? undefined}
              label={job.label}
              detail={describeJobTime(job)}
              etaMs={job.etaMs}
            />
          )}
        </>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Your Word document is ready"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          mime="application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onDownload={() =>
            downloadOutput(
              result.bytes,
              result.name,
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
          }
          description={`${result.chars.toLocaleString()} characters · ${result.pages} page${
            result.pages === 1 ? "" : "s"
          } · ${result.images} picture${result.images === 1 ? "" : "s"} · editable text`}
          facts={[
            { label: "Layout", value: opts.value.layout === "flow" ? "Flowing" : "Positioned" },
            { label: "Images", value: result.images ? String(result.images) : "None" },
          ]}
        />
      )}
      {result && result.sparsePages.length > 0 && (
        <Alert tone="warning" title="Some pages had almost no text">
          Page{result.sparsePages.length === 1 ? "" : "s"} {result.sparsePages.slice(0, 8).join(", ")}
          {result.sparsePages.length > 8 ? ` and ${result.sparsePages.length - 8} more` : ""} may be scans without a text layer.{" "}
          <OcrLink /> to make them searchable, then convert again.
        </Alert>
      )}
    </div>
  );
}

/* ================================================================== *
 * PDF → EXCEL
 * ================================================================== */
type ColumnSensitivity = "tight" | "balanced" | "loose";
type ExcelLayout = "per-page" | "single";
type ExcelOutput = "xlsx" | "csv";

const COLUMN_TOLERANCE: Record<ColumnSensitivity, number> = { tight: 5, balanced: 9, loose: 14 };
const COLUMN_LABEL: Record<ColumnSensitivity, string> = {
  tight: "Tight — only aligned columns",
  balanced: "Balanced (recommended)",
  loose: "Loose — catch drifting columns",
};

interface ExcelResult {
  bytes: Uint8Array;
  name: string;
  rows: number;
  sheets: number;
  output: ExcelOutput;
  pages: number;
}

export function PdfToExcelTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const opts = useToolPreferences("pdf-to-excel", {
    mode: "columns" as "columns" | "lines",
    sensitivity: "balanced" as ColumnSensitivity,
    headerRow: true,
    layout: "per-page" as ExcelLayout,
    output: "xlsx" as ExcelOutput,
  });
  const [range, setRange] = useState("");
  const [result, setResult] = useState<ExcelResult | null>(null);
  const [preview, setPreview] = useState<{ page: number; rows: string[][] } | null>(null);
  const job = useJob<ExcelResult>();
  const canRun = Boolean(pdf.bytes && pdf.file) && !job.busy;

  const asNumber = (raw: string): string | number => {
    const trimmed = raw.trim();
    if (/^-?\$\s?[\d,]+(\.\d{1,4})?$/.test(trimmed)) {
      const n = Number(trimmed.replace(/[$\s,]/g, ""));
      if (Number.isFinite(n)) return n;
    }
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?%?$/.test(trimmed) || /^-?\d+(\.\d+)?%$/.test(trimmed)) {
      const n = Number(trimmed.replace(/[,%]/g, ""));
      if (Number.isFinite(n)) return trimmed.endsWith("%") ? n / 100 : n;
    }
    if (/^-?\d+(\.\d+)?$/.test(trimmed) && trimmed.length < 12) return Number(trimmed);
    return trimmed;
  };

  const pageToRows = (page: ExtractedPage): (string | number)[][] => {
    if (opts.value.mode === "lines") return page.lines.map((line) => [line.text]);
    const columns = detectColumns(page.lines, COLUMN_TOLERANCE[opts.value.sensitivity]);
    if (columns.length < 2) return page.lines.map((line) => [line.text]);
    return page.lines.map((line) => {
      const cells: string[] = new Array(columns.length).fill("");
      for (const item of line.items) {
        // Belong to the last column that starts at or before this item.
        let column = 0;
        columns.forEach((edge, ci) => {
          if (item.x + 2 >= edge) column = ci;
        });
        cells[column] = `${cells[column]} ${item.str}`.trim();
      }
      return cells.map(asNumber);
    });
  };

  const convert = () => {
    if (!pdf.bytes || !pdf.file) return;
    const bytes = pdf.bytes;
    const sourceName = pdf.file.name;
    const total = pdf.pageCount;
    void (async () => {
      const output = await job.run(async (reporter) => {
        const pages = parsePageQuery(range, total);
        reporter.report(2, "Reading the text layer…", describePageQuery(pages, total));
        const extracted = await extractDocument(bytes, {
          pages,
          onProgress: (done, count) => {
            reporter.throwIfCancelled();
            reporter.report(2 + (done / Math.max(1, count)) * 58, `Reading page ${done} of ${count}…`);
          },
        });
        reporter.throwIfCancelled();
        if (extracted.text.trim().length < 5) {
          throw new Error("No text layer found. Scanned tables need OCR before they can become a spreadsheet — run OCR PDF first.");
        }
        reporter.report(64, "Laying out rows and columns…");

        const sheets = extracted.pages.map((page) => ({ page: page.page, rows: pageToRows(page) }));
        const totalRows = sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0);
        const first = sheets.find((sheet) => sheet.rows.length);
        if (first) {
          setPreview({ page: first.page, rows: first.rows.slice(0, 6).map((row) => row.slice(0, 8).map(String)) });
        } else {
          setPreview(null);
        }

        const stem = sanitizeName(baseName(sourceName));
        if (opts.value.output === "csv") {
          const csvFor = (rows: (string | number)[][]) => tableToCsv(rows.map((row) => row.map((cell) => String(cell))));
          if (sheets.length === 1) {
            const csvBytes = new TextEncoder().encode(csvFor(sheets[0].rows));
            reporter.report(100, "Done");
            return {
              bytes: csvBytes,
              name: `${stem}.csv`,
              rows: totalRows,
              sheets: 1,
              output: "csv" as const,
              pages: extracted.pages.length,
            };
          }
          const zip = new JSZip();
          sheets.forEach((sheet, index) => {
            zip.file(`${stem}-p${String(sheet.page).padStart(2, "0")}.csv`, csvFor(sheet.rows));
            reporter.report(64 + ((index + 1) / sheets.length) * 30, `Writing page ${sheet.page}…`);
          });
          const zipBytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
          reporter.report(100, "Done");
          return {
            bytes: zipBytes,
            name: `${stem}-csv-pages.zip`,
            rows: totalRows,
            sheets: sheets.length,
            output: "csv" as const,
            pages: extracted.pages.length,
          };
        }

        const wb = XLSX.utils.book_new();
        if (opts.value.layout === "single") {
          const combined = sheets.flatMap((sheet) => sheet.rows);
          if (!combined.length) combined.push(["(no selectable text on these pages)"]);
          const ws = XLSX.utils.aoa_to_sheet(combined);
          ws["!cols"] = (combined[0] ?? []).map((_, ci) => {
            const longest = Math.max(...combined.map((row) => String(row[ci] ?? "").length), 6);
            return { wch: Math.min(48, Math.max(9, longest + 2)) };
          });
          if (opts.value.headerRow) applyHeaderRow(ws, combined);
          XLSX.utils.book_append_sheet(wb, ws, "Tables".slice(0, 31));
        } else {
          sheets.forEach((sheet, index) => {
            const rows = sheet.rows.length ? sheet.rows : [["(no selectable text on this page)"]];
            const ws = XLSX.utils.aoa_to_sheet(rows);
            ws["!cols"] = (rows[0] ?? []).map((_, ci) => {
              const longest = Math.max(...rows.map((row) => String(row[ci] ?? "").length), 6);
              return { wch: Math.min(48, Math.max(9, longest + 2)) };
            });
            if (opts.value.headerRow) applyHeaderRow(ws, rows);
            XLSX.utils.book_append_sheet(wb, ws, `Page ${sheet.page}`.slice(0, 31));
            reporter.report(64 + ((index + 1) / sheets.length) * 30, `Writing sheet for page ${sheet.page}…`);
          });
        }
        const out = XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
        reporter.report(100, "Done");
        return {
          bytes: new Uint8Array(out),
          name: `${stem}.xlsx`,
          rows: totalRows,
          sheets: opts.value.layout === "single" ? 1 : sheets.length,
          output: "xlsx" as const,
          pages: extracted.pages.length,
        };
      });
      if (output) setResult(output);
    })();
  };

  useEffect(() => {
    setResult(null);
    setPreview(null);
  }, [pdf.bytes]);

  usePrimaryShortcut(convert, canRun);
  useDownloadShortcut(
    () => {
      if (!result) return;
      downloadOutput(result.bytes, result.name);
    },
    Boolean(result),
  );

  const summarySheets = opts.value.layout === "single" ? 1 : Math.max(1, parseSafe(range, pdf.pageCount));
  const summary = [
    opts.value.mode === "columns"
      ? `Columns detected (${opts.value.sensitivity})`
      : "One row per text line",
    opts.value.headerRow && opts.value.mode === "columns" ? "first row treated as a header" : "no header row",
    opts.value.layout === "single" ? "all pages on one sheet" : `${summarySheets} sheet${summarySheets === 1 ? "" : "s"}, one per page`,
    opts.value.output === "xlsx" ? "Excel .xlsx" : "CSV",
  ].join(" · ");

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF with tables or text" />
      {pdf.bytes && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink/70">Table detection</p>
              <Segmented<"columns" | "lines">
                value={opts.value.mode}
                onChange={(value) => opts.set("mode", value)}
                size="sm"
                options={[
                  { value: "columns", label: "Detect columns" },
                  { value: "lines", label: "Rows of text" },
                ]}
              />
              <p className="mt-1.5 text-[11.5px] text-muted">
                {opts.value.mode === "columns"
                  ? "Each column starts where its text starts, so numbers stay in their own cells."
                  : "Every line becomes one row of a single column — good for logs and lists."}
              </p>
            </div>
            <RangeField value={range} onChange={setRange} total={pdf.pageCount} label="Pages" hint="Leave empty for all pages." />
          </div>
          <AdvancedOptions
            scope="pdf-to-excel"
            badge="4 controls"
            description="Sensitivity, header row, sheet layout, output"
            onReset={opts.reset}
          >
            <OptionsGrid>
              <Field label="Column sensitivity" hint="Controls how far apart two text starts may be and still share a column.">
                <Select
                  value={opts.value.sensitivity}
                  onChange={(event) => opts.set("sensitivity", event.target.value as ColumnSensitivity)}
                  disabled={opts.value.mode === "lines"}
                >
                  {(Object.keys(COLUMN_LABEL) as ColumnSensitivity[]).map((key) => (
                    <option key={key} value={key}>
                      {COLUMN_LABEL[key]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Sheet layout">
                <Select value={opts.value.layout} onChange={(event) => opts.set("layout", event.target.value as ExcelLayout)}>
                  <option value="per-page">One sheet per page</option>
                  <option value="single">All pages on one sheet</option>
                </Select>
              </Field>
              <Field label="Output">
                <Select value={opts.value.output} onChange={(event) => opts.set("output", event.target.value as ExcelOutput)}>
                  <option value="xlsx">Excel .xlsx</option>
                  <option value="csv">CSV files (ZIP when several pages)</option>
                </Select>
              </Field>
              <div className="pt-5">
                <Switch
                  label="First row is a header"
                  checked={opts.value.headerRow}
                  onChange={(value) => opts.set("headerRow", value)}
                  description={
                    opts.value.output === "xlsx"
                      ? "Adds a filter to the first row so columns can be sorted in Excel."
                      : "Only affects .xlsx output."
                  }
                />
              </div>
            </OptionsGrid>
            <div className="mt-3">
              <OptionNote>
                Numbers stay numeric, so totals and sorting work. One row per detected line keeps the original reading order.
              </OptionNote>
            </div>
          </AdvancedOptions>
          <p className="rounded-xl border border-line bg-bone-deep/35 px-3.5 py-2.5 text-[11.5px] leading-relaxed text-ink/70">
            <span className="font-semibold text-ink/80">This run will produce:</span> {summary}
          </p>
          {job.failed && (
            <Alert tone="error">
              {job.error} {/OCR|scan/i.test(job.error) && <OcrLink />}
            </Alert>
          )}
          {job.status === "cancelled" && <Alert tone="info">Cancelled — nothing was downloaded. Your previous result is unchanged.</Alert>}
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={convert} loading={job.busy} disabled={!canRun}>
              <FileSpreadsheet className="h-4 w-4" /> Convert to Excel
            </Button>
            {job.busy && (
              <Button variant="ghost" onClick={job.cancel}>
                Cancel
              </Button>
            )}
            <span className="text-[11.5px] text-muted">Numbers kept numeric · nothing uploaded</span>
          </div>
          {job.busy && (
            <Progress value={job.percent ?? undefined} label={job.label} detail={describeJobTime(job)} etaMs={job.etaMs} />
          )}
        </>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Your spreadsheet is ready"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          mime={
            result.output === "xlsx"
              ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              : result.name.endsWith(".zip")
                ? "application/zip"
                : "text/csv"
          }
          onDownload={() => downloadOutput(result.bytes, result.name)}
          description={`${result.rows} rows across ${result.sheets} sheet${result.sheets === 1 ? "" : "s"} · ${formatBytes(
            result.bytes.byteLength,
          )}`}
          facts={[
            { label: "Output", value: result.output === "xlsx" ? "Excel" : "CSV" },
            { label: "Sensitivity", value: opts.value.sensitivity },
          ]}
        />
      )}
      {preview && preview.rows.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-line">
          <p className="border-b border-line bg-bone-deep/50 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/75">
            Preview · page {preview.page}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11.5px]">
              <tbody>
                {preview.rows.map((row, ri) => (
                  <tr key={ri} className={ri === 0 && opts.value.headerRow ? "bg-lime/15 font-medium" : "odd:bg-bone/40"}>
                    {row.map((cell, ci) => (
                      <td key={ci} className="max-w-[220px] truncate border-b border-line/70 px-2.5 py-1.5 text-ink/75">
                        {cell || <span className="text-ink/20">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function applyHeaderRow(ws: XLSX.WorkSheet, rows: (string | number)[][]) {
  const columns = Math.max(1, rows[0]?.length ?? 1);
  ws["!autofilter"] = {
    ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, rows.length - 1), c: columns - 1 } }),
  };
}

function parseSafe(input: string, total: number): number {
  try {
    return parsePageQuery(input, total).length;
  } catch {
    return total;
  }
}

/* ================================================================== *
 * PDF → POWERPOINT
 * ================================================================== */
type SlideLayout = "16x9" | "4x3";
type SlideQuality = "draft" | "standard" | "sharp";

const SLIDE_QUALITY: Record<SlideQuality, { scale: number; quality: number; label: string }> = {
  draft: { scale: 1.3, quality: 0.72, label: "Draft · smallest deck" },
  standard: { scale: 1.8, quality: 0.86, label: "Standard (recommended)" },
  sharp: { scale: 2.4, quality: 0.94, label: "Sharp · large, best on projectors" },
};

interface PptResult {
  bytes: Uint8Array;
  name: string;
  slides: number;
  layout: SlideLayout;
  notes: boolean;
}

export function PdfToPptTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const opts = useToolPreferences("pdf-to-ppt", {
    layout: "16x9" as SlideLayout,
    quality: "standard" as SlideQuality,
    pageNumbers: true,
    notes: false,
  });
  const [range, setRange] = useState("");
  const [result, setResult] = useState<PptResult | null>(null);
  const job = useJob<PptResult>();
  const canRun = Boolean(pdf.bytes && pdf.file) && !job.busy;

  const convert = () => {
    if (!pdf.bytes || !pdf.file) return;
    const bytes = pdf.bytes;
    const sourceName = pdf.file.name;
    const total = pdf.pageCount;
    void (async () => {
      const output = await job.run(async (reporter) => {
        const pages = parsePageQuery(range, total);
        if (pages.length > 80) throw new Error("This tool handles up to 80 slides per run. Split the PDF for larger decks.");
        let pageText = new Map<number, string>();
        if (opts.value.notes) {
          reporter.report(2, "Reading the text for speaker notes…");
          const extracted = await extractDocument(bytes, {
            pages,
            onProgress: (done, count) => {
              reporter.throwIfCancelled();
              reporter.report(2 + (done / Math.max(1, count)) * 18, `Reading page ${done} of ${count}…`);
            },
          });
          pageText = new Map(extracted.pages.map((page) => [page.page, page.text.replace(/\s+/g, " ").trim()]));
        }
        reporter.throwIfCancelled();
        const doc = await openPdfJs(bytes);
        try {
          const pptx = new pptxgen();
          pptx.layout = opts.value.layout === "16x9" ? "LAYOUT_16x9" : "LAYOUT_4x3";
          pptx.author = "Paperly";
          pptx.subject = baseName(sourceName);
          pptx.title = baseName(sourceName);
          pptx.company = "Paperly";
          const boxW = 10;
          const boxH = opts.value.layout === "16x9" ? 5.625 : 7.5;
          const quality = SLIDE_QUALITY[opts.value.quality];
          const margin = 0.14;
          for (let i = 0; i < pages.length; i += 1) {
            reporter.throwIfCancelled();
            const rendered = await renderPdfPage(doc, pages[i], {
              scale: quality.scale,
              type: "image/jpeg",
              quality: quality.quality,
            });
            const slide = pptx.addSlide();
            slide.background = { color: "FFFFFF" };
            const imgRatio = rendered.width / rendered.height;
            let w = boxW - margin * 2;
            let h = w / imgRatio;
            if (h > boxH - margin * 2) {
              h = boxH - margin * 2;
              w = h * imgRatio;
            }
            slide.addImage({ data: rendered.dataUrl, x: (boxW - w) / 2, y: (boxH - h) / 2, w, h });
            if (opts.value.pageNumbers) {
              slide.addText(`${pages[i]}`, {
                x: boxW - 0.7,
                y: boxH - 0.34,
                w: 0.5,
                h: 0.22,
                fontSize: 8,
                color: "9AA39D",
                align: "right",
              });
            }
            if (opts.value.notes) {
              const text = pageText.get(pages[i]) ?? "";
              if (text) slide.addNotes(text);
            }
            reporter.report(20 + ((i + 1) / pages.length) * 75, `Rendering slide ${i + 1} of ${pages.length}…`);
          }
          const blob = (await pptx.write({ outputType: "blob" })) as Blob;
          reporter.report(100, "Done");
          return {
            bytes: new Uint8Array(await blob.arrayBuffer()),
            name: `${sanitizeName(baseName(sourceName))}.pptx`,
            slides: pages.length,
            layout: opts.value.layout,
            notes: opts.value.notes,
          };
        } finally {
          await doc.destroy();
        }
      });
      if (output) setResult(output);
    })();
  };

  useEffect(() => {
    setResult(null);
  }, [pdf.bytes]);

  usePrimaryShortcut(convert, canRun);
  useDownloadShortcut(
    () => {
      if (!result) return;
      downloadOutput(result.bytes, result.name, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    },
    Boolean(result),
  );

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to turn into slides" />
      {pdf.bytes && (
        <>
          <RangeField
            value={range}
            onChange={setRange}
            total={pdf.pageCount}
            label="Pages to include"
            hint="Leave empty for every page. Each page becomes one slide."
          />
          <AdvancedOptions
            scope="pdf-to-ppt"
            badge="3 controls"
            description="Slide size, image quality, notes"
            onReset={opts.reset}
          >
            <OptionsGrid>
              <Field label="Slide size">
                <Select value={opts.value.layout} onChange={(event) => opts.set("layout", event.target.value as SlideLayout)}>
                  <option value="16x9">16:9 widescreen</option>
                  <option value="4x3">4:3 classic</option>
                </Select>
              </Field>
              <Field label="Page image quality" hint={SLIDE_QUALITY[opts.value.quality].label}>
                <Select value={opts.value.quality} onChange={(event) => opts.set("quality", event.target.value as SlideQuality)}>
                  {(Object.keys(SLIDE_QUALITY) as SlideQuality[]).map((key) => (
                    <option key={key} value={key}>
                      {key === "draft" ? "Draft" : key === "standard" ? "Standard" : "Sharp"}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="pt-5">
                <Switch
                  label="Slide numbers"
                  checked={opts.value.pageNumbers}
                  onChange={(value) => opts.set("pageNumbers", value)}
                  description="Adds the source page number in the bottom corner."
                />
              </div>
              <div className="pt-5">
                <Switch
                  label="Include speaker notes"
                  checked={opts.value.notes}
                  onChange={(value) => opts.set("notes", value)}
                  description="Puts each page's text into the slide notes — slower, but handy for presenting."
                />
              </div>
            </OptionsGrid>
            <div className="mt-3">
              <OptionNote>
                Every slide carries the page as a high-quality image, so the deck looks exactly like the PDF everywhere.
              </OptionNote>
            </div>
          </AdvancedOptions>
          {job.failed && <Alert tone="error">{job.error}</Alert>}
          {job.status === "cancelled" && <Alert tone="info">Cancelled — nothing was downloaded. Your previous result is unchanged.</Alert>}
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={convert} loading={job.busy} disabled={!canRun}>
              <Presentation className="h-4 w-4" /> Convert to PowerPoint
            </Button>
            {job.busy && (
              <Button variant="ghost" onClick={job.cancel}>
                Cancel
              </Button>
            )}
            <ShortcutHint run="⌘/Ctrl + Enter to convert" download={result ? "⌘/Ctrl + S to download" : undefined} />
          </div>
          {job.busy && (
            <Progress value={job.percent ?? undefined} label={job.label} detail={describeJobTime(job)} etaMs={job.etaMs} />
          )}
        </>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title={`${result.slides} slides ready`}
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.slides}
          mime="application/vnd.openxmlformats-officedocument.presentationml.presentation"
          onDownload={() =>
            downloadOutput(
              result.bytes,
              result.name,
              "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            )
          }
          description={`${result.layout === "16x9" ? "16:9" : "4:3"} slides · ${
            SLIDE_QUALITY[opts.value.quality].label.split(" · ")[0].toLowerCase()
          } page images${result.notes ? " · speaker notes" : ""} · opens in PowerPoint, Keynote and Google Slides`}
          facts={[
            { label: "Size", value: result.layout === "16x9" ? "16:9" : "4:3" },
            { label: "Notes", value: result.notes ? "Included" : "None" },
          ]}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * WORD → PDF
 * ================================================================== */
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";

function paragraphInfo(p: Element) {
  let text = "";
  for (const node of Array.from(p.getElementsByTagNameNS(W_NS, "t"))) text += node.textContent ?? "";
  const styleNode = p.getElementsByTagNameNS(W_NS, "pStyle")[0];
  const style = styleNode?.getAttributeNS(W_NS, "val") ?? styleNode?.getAttribute("w:val") ?? "";
  const isList = p.getElementsByTagNameNS(W_NS, "numPr").length > 0;
  return { text: text.replace(/\s+/g, " ").trim(), style, isList };
}

interface DocImage {
  kind: "png" | "jpg";
  bytes: Uint8Array;
}

interface DocBlock {
  type: "paragraph" | "table";
  text?: string;
  style?: string;
  isList?: boolean;
  rows?: string[][];
  images?: DocImage[];
}

async function parseDocx(bytes: ArrayBuffer, withImages: boolean): Promise<DocBlock[]> {
  // Validate the ZIP directory before JSZip decompresses anything.
  await assertZipSafe(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "docx");
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file("word/document.xml");
  if (!file) throw new Error("This .docx file is missing its document content. Re-save it in Word and try again.");
  const xml = await file.async("text");
  if (xml.length > 40_000_000) throw new Error("This document’s XML is too large to lay out safely in a browser.");
  const dom = new DOMParser().parseFromString(xml, "application/xml");
  if (dom.getElementsByTagName("parsererror").length) throw new Error("This .docx file looks damaged and couldn’t be read.");
  const body = dom.getElementsByTagNameNS(W_NS, "body")[0];
  if (!body) throw new Error("No readable document body was found.");

  const relTargets = new Map<string, string>();
  if (withImages) {
    const relsFile = zip.file("word/_rels/document.xml.rels");
    if (relsFile) {
      const relsDom = new DOMParser().parseFromString(await relsFile.async("text"), "application/xml");
      for (const rel of Array.from(relsDom.getElementsByTagName("Relationship"))) {
        const id = rel.getAttribute("Id");
        const target = rel.getAttribute("Target");
        if (id && target && /media\//i.test(target)) relTargets.set(id, normalizePart("word/document.xml", target));
      }
    }
  }

  const readImages = async (p: Element): Promise<DocImage[]> => {
    if (!withImages || !relTargets.size) return [];
    const out: DocImage[] = [];
    for (const blip of Array.from(p.getElementsByTagNameNS(A_NS, "blip"))) {
      const embed = blip.getAttributeNS(R_NS, "embed") ?? blip.getAttribute("r:embed") ?? "";
      const path = relTargets.get(embed);
      if (!path) continue;
      const media = zip.file(path);
      if (!media) continue;
      const ext = path.split(".").pop()?.toLowerCase() ?? "";
      const kind: DocImage["kind"] | null = ext === "png" ? "png" : ext === "jpg" || ext === "jpeg" ? "jpg" : null;
      if (!kind) continue;
      out.push({ kind, bytes: await media.async("uint8array") });
      if (out.length >= 6) break;
    }
    return out;
  };

  const blocks: DocBlock[] = [];
  for (const child of Array.from(body.children)) {
    if (child.localName === "p") {
      const info = paragraphInfo(child);
      const images = await readImages(child);
      if (info.text || images.length) blocks.push({ type: "paragraph", ...info, images });
    } else if (child.localName === "tbl") {
      const rows: string[][] = [];
      for (const tr of Array.from(child.children).filter((c) => c.localName === "tr")) {
        const cells: string[] = [];
        for (const tc of Array.from(tr.children).filter((c) => c.localName === "tc")) {
          const texts = Array.from(tc.getElementsByTagNameNS(W_NS, "p"))
            .map((p) => paragraphInfo(p).text)
            .filter(Boolean);
          cells.push(texts.join(" "));
        }
        if (cells.length) rows.push(cells);
      }
      if (rows.length) blocks.push({ type: "table", rows });
    }
  }
  return blocks;
}

/** Resolve an OPC part target against the part that referenced it. */
function normalizePart(fromPart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const base = fromPart.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") base.pop();
    else if (segment !== "." && segment !== "") base.push(segment);
  }
  return base.join("/");
}

interface Cursor {
  doc: PDFDocument;
  page: ReturnType<PDFDocument["addPage"]> | null;
  fonts: FontPack;
  width: number;
  height: number;
  margin: number;
  y: number;
  pages: number;
}

function newPage(c: Cursor) {
  c.page = c.doc.addPage([c.width, c.height]);
  c.y = c.height - c.margin;
  c.pages++;
}

function ensureSpace(c: Cursor, needed: number) {
  if (!c.page) newPage(c);
  if (c.y - needed < c.margin + 26) newPage(c);
}

function drawLines(
  c: Cursor,
  lines: string[],
  opts: { size: number; font: string; color?: string; indent?: number; lineHeight: number; x?: number },
) {
  for (const line of lines) {
    ensureSpace(c, opts.lineHeight);
    c.page!.drawText(line || " ", {
      x: c.margin + (opts.indent ?? 0),
      y: c.y - opts.size,
      size: opts.size,
      font:
        opts.font === "bold"
          ? c.fonts.bold
          : opts.font === "italic"
            ? c.fonts.italic
            : c.fonts.regular,
      color: hexToRgb(opts.color ?? "#1b241f"),
    });
    c.y -= opts.lineHeight;
  }
}

type PageOrientation = "portrait" | "landscape";
type MarginPreset = "narrow" | "normal" | "wide";

const MARGIN_POINTS: Record<MarginPreset, number> = { narrow: 36, normal: 58, wide: 84 };
/** Spreadsheets need far less paper margin than running text. */
const SHEET_MARGIN: Record<MarginPreset, number> = { narrow: 20, normal: 32, wide: 48 };

interface DocxLayoutOptions {
  size: PaperKey;
  orientation: PageOrientation;
  margins: MarginPreset;
  includeImages: boolean;
}

interface HeadingMark {
  title: string;
  pageIndex: number;
}

async function renderDocxToPdf(
  blocks: DocBlock[],
  options: DocxLayoutOptions,
): Promise<{ doc: PDFDocument; headings: HeadingMark[]; fonts: FontPack }> {
  const [shortSide, longSide] = PAPER_POINTS[options.size];
  const dims: [number, number] = options.orientation === "landscape" ? [longSide, shortSide] : [shortSide, longSide];
  const margin = MARGIN_POINTS[options.margins];
  const doc = await PDFDocument.create();
  const fonts = await embedFonts(doc);
  const cursor: Cursor = {
    doc,
    page: null,
    fonts,
    width: dims[0],
    height: dims[1],
    margin,
    y: dims[1] - margin,
    pages: 0,
  };
  newPage(cursor);
  const maxWidth = cursor.width - cursor.margin * 2;
  const headings: HeadingMark[] = [];

  const drawImages = async (images: DocImage[] | undefined) => {
    if (!options.includeImages || !images?.length) return;
    for (const image of images) {
      try {
        const embedded = image.kind === "png" ? await doc.embedPng(image.bytes) : await doc.embedJpg(image.bytes);
        const scale = Math.min(1, maxWidth / embedded.width, (cursor.height * 0.5) / embedded.height);
        const w = embedded.width * scale;
        const h = embedded.height * scale;
        ensureSpace(cursor, h + 12);
        cursor.page!.drawImage(embedded, { x: cursor.margin + (maxWidth - w) / 2, y: cursor.y - h, width: w, height: h });
        cursor.y -= h + 12;
      } catch {
        /* An unsupported image must never stop the text from converting. */
      }
    }
  };

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === "paragraph") {
      const style = block.style ?? "";
      const headingMatch = /^(Heading|heading)([1-6])/.exec(style);
      const isTitle = /^Title$/i.test(style);
      const level = headingMatch ? Number(headingMatch[2]) : 0;
      if (isTitle || level === 1) {
        cursor.y -= 10;
        if (block.text) headings.push({ title: block.text, pageIndex: cursor.pages - 1 });
        const lines = wrapText(block.text ?? "", { font: fonts.bold, size: 22, color: "#12211a", maxWidth });
        drawLines(cursor, lines, { size: 22, font: "bold", color: "#12211a", lineHeight: 28 });
        cursor.y -= 6;
      } else if (level >= 2) {
        cursor.y -= 6;
        const hsize = level === 2 ? 16 : 13.5;
        if (block.text) headings.push({ title: block.text, pageIndex: cursor.pages - 1 });
        const lines = wrapText(block.text ?? "", { font: fonts.bold, size: hsize, color: "#1c4c3b", maxWidth });
        drawLines(cursor, lines, { size: hsize, font: "bold", color: "#1c4c3b", lineHeight: hsize + 5 });
        cursor.y -= 4;
      } else if (block.isList) {
        const lines = wrapText(block.text ?? "", { font: fonts.regular, size: 10.5, color: "#232d27", maxWidth: maxWidth - 18 });
        ensureSpace(cursor, lines.length * 15 + 4);
        lines.forEach((line, idx) => {
          if (idx === 0) {
            cursor.page!.drawText("•", { x: cursor.margin + 4, y: cursor.y - 10.5, size: 10.5, font: fonts.bold, color: hexToRgb("#1c4c3b") });
          }
          drawLines(cursor, [line], { size: 10.5, font: "regular", lineHeight: 15, indent: 18 });
        });
        cursor.y -= 2;
      } else if (block.text) {
        const lines = wrapText(block.text, { font: fonts.regular, size: 10.8, color: "#232d27", maxWidth });
        drawLines(cursor, lines, { size: 10.8, font: "regular", lineHeight: 15.5 });
        cursor.y -= 7;
      }
      await drawImages(block.images);
    } else if (block.type === "table" && block.rows) {
      const colCount = Math.max(...block.rows.map((r) => r.length), 1);
      const colWidth = maxWidth / colCount;
      const cellPad = 4;
      const fontSize = colCount > 6 ? 7.5 : 8.5;
      for (let r = 0; r < block.rows.length; r++) {
        const cells = block.rows[r];
        const wrapped = cells.map((cell) =>
          wrapText(cell || " ", { font: fonts.regular, size: fontSize, color: "#232d27", maxWidth: colWidth - cellPad * 2 }),
        );
        const rowHeight = Math.max(...wrapped.map((w) => w.length), 1) * (fontSize + 3) + cellPad * 2;
        ensureSpace(cursor, rowHeight + 4);
        const top = cursor.y;
        if (r === 0) {
          cursor.page!.drawRectangle({ x: cursor.margin, y: top - rowHeight, width: maxWidth, height: rowHeight, color: rgb(0.94, 0.95, 0.92) });
        }
        for (let cIdx = 0; cIdx < colCount; cIdx++) {
          const x = cursor.margin + cIdx * colWidth;
          cursor.page!.drawRectangle({
            x,
            y: top - rowHeight,
            width: colWidth,
            height: rowHeight,
            borderColor: rgb(0.82, 0.83, 0.79),
            borderWidth: 0.6,
          });
          const lines = wrapped[cIdx] ?? [];
          lines.forEach((line, li) => {
            cursor.page!.drawText(line, {
              x: x + cellPad,
              y: top - cellPad - fontSize - li * (fontSize + 3) - 1,
              size: fontSize,
              font: r === 0 ? fonts.bold : fonts.regular,
              color: hexToRgb("#232d27"),
            });
          });
        }
        cursor.y -= rowHeight;
      }
      cursor.y -= 10;
    }

    if (cursor.pages > 180) throw new Error("This document is longer than 180 pages. Convert a shorter section or use a desktop converter.");
  }
  return { doc, headings, fonts };
}

/** Real PDF outline entries so headings appear in the reader's sidebar. */
function addBookmarks(doc: PDFDocument, marks: HeadingMark[]) {
  const pages = doc.getPages();
  const items = marks
    .map((mark) => ({ title: mark.title.trim().slice(0, 120), page: pages[mark.pageIndex] }))
    .filter((item) => Boolean(item.page) && Boolean(item.title));
  if (!items.length) return;
  const unique: typeof items = [];
  for (const item of items) {
    if (unique.some((seen) => seen.title === item.title && seen.page === item.page)) continue;
    unique.push(item);
  }
  const { context } = doc;
  const outlinesRef = context.nextRef();
  const refs = unique.map((item) => {
    const dict = PDFDict.withContext(context);
    dict.set(PDFName.of("Title"), PDFHexString.fromText(item.title));
    dict.set(PDFName.of("Parent"), outlinesRef);
    const dest = PDFArray.withContext(context);
    dest.push(item.page.ref);
    dest.push(PDFName.of("XYZ"));
    dest.push(PDFNumber.of(0));
    dest.push(PDFNumber.of(item.page.getHeight()));
    dest.push(PDFNumber.of(0));
    dict.set(PDFName.of("Dest"), dest);
    return context.register(dict);
  });
  const root = PDFDict.withContext(context);
  root.set(PDFName.of("Type"), PDFName.of("Outlines"));
  root.set(PDFName.of("First"), refs[0]);
  root.set(PDFName.of("Last"), refs[refs.length - 1]);
  root.set(PDFName.of("Count"), PDFNumber.of(refs.length));
  context.assign(outlinesRef, root);
  refs.forEach((ref, index) => {
    const dict = context.lookup(ref);
    if (dict instanceof PDFDict) {
      if (index > 0) dict.set(PDFName.of("Prev"), refs[index - 1]);
      if (index < refs.length - 1) dict.set(PDFName.of("Next"), refs[index + 1]);
    }
  });
  doc.catalog.set(PDFName.of("Outlines"), outlinesRef);
  doc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
}

function stampPageNumbers(doc: PDFDocument, fonts: FontPack) {
  const pages = doc.getPages();
  if (pages.length < 2) return;
  pages.forEach((page, index) => {
    const label = `${index + 1} / ${pages.length}`;
    const w = fonts.regular.widthOfTextAtSize(label, 8);
    page.drawText(label, {
      x: (page.getWidth() - w) / 2,
      y: 26,
      size: 8,
      font: fonts.regular,
      color: rgb(0.55, 0.58, 0.55),
    });
  });
}

interface WordPdfResult {
  bytes: Uint8Array;
  name: string;
  pages: number;
  paragraphs: number;
  tables: number;
  images: number;
  bookmarks: number;
}

export function WordToPdfTool() {
  const initial = useInitialFiles().filter((f) => /\.docx$/i.test(f.name));
  const [file, setFile] = useState<File | null>(initial[0] ?? null);
  const opts = useToolPreferences("word-to-pdf", {
    size: "a4" as PaperKey,
    orientation: "portrait" as PageOrientation,
    margins: "normal" as MarginPreset,
    includeImages: true,
    bookmarks: true,
    pageNumbers: true,
  });
  const [keep, setKeep] = useState("");
  const [result, setResult] = useState<WordPdfResult | null>(null);
  const job = useJob<WordPdfResult>();
  const canRun = Boolean(file) && !job.busy;

  const convert = () => {
    if (!file) return;
    const source = file;
    void (async () => {
      const output = await job.run(async (reporter) => {
        if (!/\.docx$/i.test(source.name)) {
          throw new Error("Please use a .docx file. Older .doc files need to be re-saved as .docx in Word first.");
        }
        reporter.report(10, "Unpacking the document…");
        const blocks = await parseDocx(await readFileBytes(source), opts.value.includeImages);
        if (!blocks.length) throw new Error("This document appears to be empty.");
        reporter.throwIfCancelled();
        const counts = {
          paragraphs: blocks.filter((block) => block.type === "paragraph").length,
          tables: blocks.filter((block) => block.type === "table").length,
          images: blocks.reduce((sum, block) => sum + (block.images?.length ?? 0), 0),
        };
        reporter.report(30, "Laying out headings, lists and tables…");
        const rendered = await renderDocxToPdf(blocks, {
          size: opts.value.size,
          orientation: opts.value.orientation,
          margins: opts.value.margins,
          includeImages: opts.value.includeImages,
        });
        reporter.throwIfCancelled();

        let doc = rendered.doc;
        let headings = rendered.headings;
        const fonts = rendered.fonts;
        let pages = doc.getPageCount();
        if (keep.trim()) {
          const wanted = parsePageQuery(keep, pages);
          if (wanted.length !== pages) {
            reporter.report(82, `Keeping ${wanted.length} of ${pages} pages…`);
            const subset = await PDFDocument.create();
            const copied = await subset.copyPages(
              doc,
              wanted.map((page) => page - 1),
            );
            copied.forEach((page) => subset.addPage(page));
            const keepIndexes = new Set(wanted.map((page) => page - 1));
            const remapped = new Map<number, number>();
            [...keepIndexes]
              .sort((a, b) => a - b)
              .forEach((original, position) => remapped.set(original, position));
            headings = headings
              .filter((mark) => keepIndexes.has(mark.pageIndex))
              .map((mark) => ({ title: mark.title, pageIndex: remapped.get(mark.pageIndex) ?? 0 }));
            doc = subset;
            pages = doc.getPageCount();
          }
        }
        if (opts.value.pageNumbers) stampPageNumbers(doc, doc === rendered.doc ? fonts : await embedFonts(doc));
        if (opts.value.bookmarks) addBookmarks(doc, headings);
        reporter.report(94, "Writing the PDF…");
        const bytes = await doc.save();
        reporter.report(100, "Done");
        return {
          bytes,
          name: `${sanitizeName(baseName(source.name))}.pdf`,
          pages,
          paragraphs: counts.paragraphs,
          tables: counts.tables,
          images: opts.value.includeImages ? counts.images : 0,
          bookmarks: opts.value.bookmarks ? headings.length : 0,
        };
      });
      if (output) setResult(output);
    })();
  };

  usePrimaryShortcut(convert, canRun);
  useDownloadShortcut(
    () => {
      if (!result) return;
      downloadOutput(result.bytes, result.name, "application/pdf");
    },
    Boolean(result),
  );

  return (
    <div className="space-y-5">
      {!file ? (
        <FileDrop
          accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          acceptLabel=".docx documents"
          onFiles={(files) => {
            setFile(files[0]);
            setResult(null);
          }}
          hint="Only .docx is supported — re-save older .doc files in Word first."
        />
      ) : (
        <FileRow
          file={file}
          onRemove={() => {
            setFile(null);
            setResult(null);
          }}
          size={formatBytes(file.size)}
        />
      )}
      {file && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Page size">
              <Select value={opts.value.size} onChange={(event) => opts.set("size", event.target.value as PaperKey)}>
                {(Object.keys(PAPER_LABEL) as PaperKey[]).map((key) => (
                  <option key={key} value={key}>
                    {PAPER_LABEL[key]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Orientation">
              <Segmented<PageOrientation>
                value={opts.value.orientation}
                onChange={(value) => opts.set("orientation", value)}
                size="sm"
                options={[
                  { value: "portrait", label: "Portrait" },
                  { value: "landscape", label: "Landscape" },
                ]}
              />
            </Field>
          </div>
          <AdvancedOptions scope="word-to-pdf" badge="4 controls" description="Margins, images, bookmarks, page numbers" onReset={opts.reset}>
            <OptionsGrid>
              <Field label="Margins" hint={`${MARGIN_POINTS[opts.value.margins]} points on every side`}>
                <Select value={opts.value.margins} onChange={(event) => opts.set("margins", event.target.value as MarginPreset)}>
                  <option value="narrow">Narrow</option>
                  <option value="normal">Normal</option>
                  <option value="wide">Wide</option>
                </Select>
              </Field>
              <Field label="Pages to keep" hint="Applies to the PDF pages this conversion produces. Leave empty for all.">
                <TextInput value={keep} onChange={(event) => setKeep(event.target.value)} placeholder="All pages" autoComplete="off" />
              </Field>
              <Switch
                label="Include images"
                checked={opts.value.includeImages}
                onChange={(value) => opts.set("includeImages", value)}
                description="Places PNG and JPEG pictures from the document, scaled to fit the page."
              />
              <Switch
                label="Headings become bookmarks"
                checked={opts.value.bookmarks}
                onChange={(value) => opts.set("bookmarks", value)}
                description="Adds a PDF outline entry for every heading so readers can jump between sections."
              />
              <Switch
                label="Add page numbers"
                checked={opts.value.pageNumbers}
                onChange={(value) => opts.set("pageNumbers", value)}
                description="Bottom centre, page N of M."
              />
            </OptionsGrid>
            <div className="mt-3">
              <OptionNote>DOCX is unpacked and typeset on this device. Nothing is uploaded.</OptionNote>
            </div>
          </AdvancedOptions>
          {job.failed && <Alert tone="error">{job.error}</Alert>}
          {job.status === "cancelled" && <Alert tone="info">Cancelled — nothing was downloaded. Your previous result is unchanged.</Alert>}
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={convert} loading={job.busy} disabled={!canRun}>
              <FileText className="h-4 w-4" /> Convert to PDF
            </Button>
            {job.busy && (
              <Button variant="ghost" onClick={job.cancel}>
                Cancel
              </Button>
            )}
            <ShortcutHint run="⌘/Ctrl + Enter to convert" download={result ? "⌘/Ctrl + S to download" : undefined} />
          </div>
          {job.busy && (
            <Progress value={job.percent ?? undefined} label={job.label} detail={describeJobTime(job)} etaMs={job.etaMs} />
          )}
        </>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Your Word document is now a PDF"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          mime="application/pdf"
          onDownload={() => downloadOutput(result.bytes, result.name, "application/pdf")}
          description={`Headings, paragraphs, lists and tables preserved · ${result.pages} page${
            result.pages === 1 ? "" : "s"
          } · ${result.tables} table${result.tables === 1 ? "" : "s"}${result.images ? ` · ${result.images} image${result.images === 1 ? "" : "s"}` : ""}`}
          facts={[
            { label: "Size", value: PAPER_LABEL[opts.value.size] },
            { label: "Layout", value: opts.value.orientation === "portrait" ? "Portrait" : "Landscape" },
            ...(result.bookmarks ? [{ label: "Bookmarks", value: String(result.bookmarks) }] : []),
          ]}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * EXCEL → PDF
 * ================================================================== */
interface SheetStyle {
  pageSize: PaperKey;
  orientation: "portrait" | "landscape";
  margin: number;
  gridlines: boolean;
  headerFooter: boolean;
  repeatHeader: boolean;
  fitToContent: boolean;
}

function renderSheet(
  out: PDFDocument,
  fonts: FontPack,
  sheetName: string,
  matrix: (string | number)[][],
  style: SheetStyle,
): number {
  const clean = matrix.map((r) => r.map((c) => (c == null ? "" : String(c)))).filter((r) => r.some((c) => c.trim() !== ""));
  if (!clean.length) return 0;
  const [shortSide, longSide] = PAPER_POINTS[style.pageSize];
  const page: [number, number] = style.orientation === "landscape" ? [longSide, shortSide] : [shortSide, longSide];
  const margin = style.margin;
  const contentW = page[0] - margin * 2;
  const colCount = Math.max(...clean.map((r) => r.length));
  const widths = style.fitToContent
    ? (() => {
        const weights = Array.from({ length: colCount }, (_, ci) =>
          Math.min(38, Math.max(7, ...clean.map((r) => (r[ci] ?? "").length))),
        );
        const totalWeight = weights.reduce((a, b) => a + b, 0);
        return weights.map((w) => (w / totalWeight) * contentW);
      })()
    : Array.from({ length: colCount }, () => contentW / colCount);
  const fontSize = colCount > 9 ? 7 : colCount > 6 ? 7.8 : 8.6;
  const lineHeight = fontSize + 3.2;
  const headerRows = 1;
  let pageNum = 1;

  const startPage = (continued: boolean) => {
    const p = out.addPage([page[0], page[1]]);
    if (style.headerFooter) {
      p.drawRectangle({ x: 0, y: page[1] - 4, width: page[0], height: 4, color: hexToRgb("#d9f26c") });
      p.drawText(continued ? `${sheetName} (continued)` : sheetName, {
        x: margin,
        y: page[1] - 34,
        size: 14,
        font: fonts.bold,
        color: hexToRgb("#12211a"),
      });
      p.drawText("Paperly · local conversion", {
        x: page[0] - margin - 90,
        y: page[1] - 30,
        size: 7,
        font: fonts.regular,
        color: rgb(0.56, 0.6, 0.57),
      });
      p.drawText(`Page ${pageNum}`, { x: page[0] - margin - 34, y: 16, size: 7, font: fonts.regular, color: rgb(0.56, 0.6, 0.57) });
    }
    return { p, y: page[1] - (style.headerFooter ? 52 : 20) };
  };

  let current = startPage(false);
  pageNum++;

  const heightsFor = (row: string[]) =>
    Array.from({ length: colCount }, (_, ci) =>
      wrapText(row[ci] ?? "", { font: fonts.regular, size: fontSize, color: "#000", maxWidth: Math.max(12, widths[ci] - 7) }),
    );

  const drawHeader = () => {
    const header = clean[0];
    const cellLines = heightsFor(header);
    const rowH = Math.max(...cellLines.map((l) => l.length), 1) * lineHeight + 7;
    if (current.y - rowH < margin + 18) {
      current = startPage(true);
      pageNum++;
    }
    const top = current.y;
    current.p.drawRectangle({ x: margin, y: top - rowH, width: contentW, height: rowH, color: rgb(0.92, 0.94, 0.89) });
    let x = margin;
    for (let ci = 0; ci < colCount; ci++) {
      const lines = cellLines[ci];
      lines.forEach((line, li) => {
        current.p.drawText(line, {
          x: x + 3,
          y: top - 4 - fontSize - li * lineHeight,
          size: fontSize,
          font: fonts.bold,
          color: hexToRgb("#1c3a2c"),
          maxWidth: widths[ci] - 6,
        });
      });
      if (style.gridlines) {
        current.p.drawRectangle({ x, y: top - rowH, width: widths[ci], height: rowH, borderColor: rgb(0.8, 0.82, 0.76), borderWidth: 0.5 });
      }
      x += widths[ci];
    }
    current.y = top - rowH;
  };

  drawHeader();
  for (let rowIndex = headerRows; rowIndex < clean.length; rowIndex++) {
    const row = clean[rowIndex];
    const cellLines = heightsFor(row);
    const rowH = Math.max(...cellLines.map((l) => l.length), 1) * lineHeight + 6;
    if (current.y - rowH < margin + 14) {
      current = startPage(true);
      pageNum++;
      if (style.repeatHeader) drawHeader();
    }
    const top = current.y;
    if (style.gridlines && (rowIndex - headerRows) % 2 === 1) {
      current.p.drawRectangle({ x: margin, y: top - rowH, width: contentW, height: rowH, color: rgb(0.976, 0.973, 0.958) });
    }
    let x = margin;
    for (let ci = 0; ci < colCount; ci++) {
      const numeric = /^-?[\d.,]+%?$/.test((row[ci] ?? "").trim());
      cellLines[ci].forEach((line, li) => {
        current.p.drawText(line, {
          x: numeric ? x + widths[ci] - 4 - fonts.regular.widthOfTextAtSize(line, fontSize) : x + 3,
          y: top - 3 - fontSize - li * lineHeight,
          size: fontSize,
          font: fonts.regular,
          color: hexToRgb("#26332c"),
          maxWidth: widths[ci] - 6,
        });
      });
      if (style.gridlines) {
        current.p.drawRectangle({ x, y: top - rowH, width: widths[ci], height: rowH, borderColor: rgb(0.85, 0.86, 0.81), borderWidth: 0.45 });
      }
      x += widths[ci];
    }
    current.y -= rowH;
  }
  return pageNum;
}

interface SheetPdfResult {
  bytes: Uint8Array;
  name: string;
  pages: number;
  sheets: number;
}

export function ExcelToPdfTool() {
  const initial = useInitialFiles().filter((f) => /\.(xlsx|xls|csv)$/i.test(f.name));
  const [file, setFile] = useState<File | null>(initial[0] ?? null);
  const opts = useToolPreferences("excel-to-pdf", {
    orientation: "auto" as "auto" | "portrait" | "landscape",
    pageSize: "a4" as PaperKey,
    margins: "normal" as MarginPreset,
    fitToContent: true,
    gridlines: true,
    headerFooter: true,
    repeatHeader: true,
  });
  const [workbook, setWorkbook] = useState<XLSX.WorkBook | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [result, setResult] = useState<SheetPdfResult | null>(null);
  const job = useJob<SheetPdfResult>();
  const canRun = Boolean(file && workbook) && !job.busy;

  useEffect(() => {
    if (!file) {
      setWorkbook(null);
      setSelected([]);
      return;
    }
    let alive = true;
    (async () => {
      try {
        await validateUpload(file, ".xlsx,.xls,.csv");
        const buffer = await readFileBytes(file);
        // Formula evaluation, HTML export and VBA are disabled: values are read only.
        const wb = XLSX.read(new Uint8Array(buffer), {
          type: "array",
          cellDates: true,
          cellFormula: false,
          cellHTML: false,
          cellNF: false,
          bookVBA: false,
          bookFiles: false,
          sheetRows: 20_000,
          dense: false,
        });
        if (wb.SheetNames.length > 30) throw new Error("This workbook has more than 30 sheets. Split it before converting.");
        if (!alive) return;
        setWorkbook(wb);
        setSelected(wb.SheetNames.slice(0, 6));
        setError("");
      } catch (err) {
        if (alive) setError(friendlyProcessingError(err, "This spreadsheet couldn’t be read. Try re-saving it as .xlsx or .csv."));
      }
    })();
    return () => {
      alive = false;
    };
  }, [file]);

  const convert = () => {
    if (!file || !workbook) return;
    const book = workbook;
    const source = file;
    void (async () => {
      const output = await job.run(async (reporter) => {
        if (!selected.length) throw new Error("Select at least one sheet.");
        const doc = await PDFDocument.create();
        const fonts = await embedFonts(doc);
        let pages = 0;
        for (let i = 0; i < selected.length; i++) {
          reporter.throwIfCancelled();
          const ws = book.Sheets[selected[i]];
          if (!ws) continue;
          const matrix = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1, defval: "", raw: false }) as (string | number)[][];
          const cols = Math.max(0, ...matrix.map((r) => r.length));
          const mode = opts.value.orientation === "auto" ? (cols > 5 ? "landscape" : "portrait") : opts.value.orientation;
          pages += renderSheet(doc, fonts, selected[i], matrix, {
            pageSize: opts.value.pageSize,
            orientation: mode,
            margin: SHEET_MARGIN[opts.value.margins],
            gridlines: opts.value.gridlines,
            headerFooter: opts.value.headerFooter,
            repeatHeader: opts.value.repeatHeader,
            fitToContent: opts.value.fitToContent,
          });
          reporter.report(((i + 1) / selected.length) * 95, `Laying out sheet ${i + 1} of ${selected.length}…`, selected[i]);
        }
        if (!doc.getPageCount()) throw new Error("The selected sheets contain no printable rows.");
        const bytes = await doc.save();
        reporter.report(100, "Done");
        return { bytes, name: `${sanitizeName(baseName(source.name))}.pdf`, pages, sheets: selected.length };
      });
      if (output) setResult(output);
    })();
  };

  usePrimaryShortcut(convert, canRun);
  useDownloadShortcut(
    () => {
      if (!result) return;
      downloadOutput(result.bytes, result.name, "application/pdf");
    },
    Boolean(result),
  );

  return (
    <div className="space-y-5">
      {!file ? (
        <FileDrop
          accept=".xlsx,.xls,.csv"
          acceptLabel="Excel or CSV files"
          onFiles={(files) => {
            setFile(files[0]);
            setResult(null);
          }}
          sample={SAMPLE.csv}
        />
      ) : (
        <FileRow
          file={file}
          onRemove={() => {
            setFile(null);
            setResult(null);
          }}
          size={formatBytes(file.size)}
        />
      )}
      {file && workbook && (
        <>
          <div>
            <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink/70">Sheets to convert</p>
            <div className="flex flex-wrap gap-2">
              {workbook.SheetNames.map((name) => {
                const active = selected.includes(name);
                return (
                  <button
                    key={name}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setSelected(active ? selected.filter((s) => s !== name) : [...selected, name]);
                      setResult(null);
                    }}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[12px] font-medium transition-colors",
                      active ? "border-forest bg-forest text-paper" : "border-line bg-paper text-ink/70 hover:border-forest/30",
                    )}
                  >
                    {active && <Check className="h-3 w-3" />} {name}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Page orientation">
              <Segmented<"auto" | "portrait" | "landscape">
                value={opts.value.orientation}
                onChange={(value) => opts.set("orientation", value)}
                size="sm"
                options={[
                  { value: "auto", label: "Auto" },
                  { value: "portrait", label: "Portrait" },
                  { value: "landscape", label: "Landscape" },
                ]}
              />
            </Field>
            <p className="rounded-xl border border-line bg-bone-deep/35 px-3.5 py-2.5 text-[11.5px] leading-relaxed text-ink/70">
              Column widths and row heights adjust automatically. Long tables continue onto new pages
              {opts.value.repeatHeader ? " with headers repeated" : ""}.
            </p>
          </div>
          <AdvancedOptions scope="excel-to-pdf" badge="6 controls" description="Paper, margins, grid and header" onReset={opts.reset}>
            <OptionsGrid>
              <Field label="Page size">
                <Select value={opts.value.pageSize} onChange={(event) => opts.set("pageSize", event.target.value as PaperKey)}>
                  <option value="a4">A4</option>
                  <option value="letter">US Letter</option>
                  <option value="legal">US Legal</option>
                </Select>
              </Field>
              <Field label="Margins">
                <Select value={opts.value.margins} onChange={(event) => opts.set("margins", event.target.value as MarginPreset)}>
                  <option value="narrow">Narrow</option>
                  <option value="normal">Normal</option>
                  <option value="wide">Wide</option>
                </Select>
              </Field>
              <Switch
                label="Fit columns to the page"
                checked={opts.value.fitToContent}
                onChange={(value) => opts.set("fitToContent", value)}
                description="Gives each column a share of the page that follows its content. Turn off for equal-width columns."
              />
              <Switch
                label="Show gridlines"
                checked={opts.value.gridlines}
                onChange={(value) => opts.set("gridlines", value)}
                description="Draws cell borders and alternating row shading."
              />
              <Switch
                label="Sheet name and page numbers"
                checked={opts.value.headerFooter}
                onChange={(value) => opts.set("headerFooter", value)}
                description="Prints the sheet name above the table and the page number below it."
              />
              <Switch
                label="Repeat the header row"
                checked={opts.value.repeatHeader}
                onChange={(value) => opts.set("repeatHeader", value)}
                description="Repeats the first row at the top of every continuation page."
              />
            </OptionsGrid>
            <div className="mt-3">
              <OptionNote>Formulas are never evaluated — the values stored in the file are what get printed.</OptionNote>
            </div>
          </AdvancedOptions>
          {job.failed && <Alert tone="error">{job.error}</Alert>}
          {job.status === "cancelled" && <Alert tone="info">Cancelled — nothing was downloaded. Your previous result is unchanged.</Alert>}
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={convert} loading={job.busy} disabled={!canRun}>
              <FileSpreadsheet className="h-4 w-4" /> Convert to PDF
            </Button>
            {job.busy && (
              <Button variant="ghost" onClick={job.cancel}>
                Cancel
              </Button>
            )}
            <span className="text-[11.5px] text-muted">
              {selected.length} of {workbook.SheetNames.length} sheet{workbook.SheetNames.length === 1 ? "" : "s"} selected
            </span>
          </div>
          {job.busy && (
            <Progress value={job.percent ?? undefined} label={job.label} detail={describeJobTime(job)} etaMs={job.etaMs} />
          )}
        </>
      )}
      {file && !workbook && !error && <Progress label="Reading your workbook…" />}
      {error && <Alert tone="error">{error}</Alert>}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Your workbook is now a PDF"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          mime="application/pdf"
          onDownload={() => downloadOutput(result.bytes, result.name, "application/pdf")}
          description={`${result.sheets} sheet${result.sheets === 1 ? "" : "s"} · ${result.pages} pages${
            opts.value.repeatHeader ? " · headers repeat across page breaks" : ""
          }`}
          facts={[
            { label: "Paper", value: PAPER_LABEL[opts.value.pageSize] },
            { label: "Margins", value: opts.value.margins },
          ]}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * POWERPOINT → PDF
 * ================================================================== */
interface ParsedSlide {
  title: string;
  paragraphs: string[];
  notes: string;
  background?: string;
}

async function readSlideRels(zip: JSZip, slidePath: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const relPath = `${slidePath.slice(0, slidePath.lastIndexOf("/"))}/_rels/${slidePath.slice(slidePath.lastIndexOf("/") + 1)}.rels`;
  const file = zip.file(relPath);
  if (!file) return map;
  try {
    const dom = new DOMParser().parseFromString(await file.async("text"), "application/xml");
    for (const rel of Array.from(dom.getElementsByTagName("Relationship"))) {
      const id = rel.getAttribute("Id");
      const target = rel.getAttribute("Target");
      const type = rel.getAttribute("Type") ?? "";
      if (!id || !target) continue;
      if (/\/notesSlide$/.test(type) || /media\//i.test(target)) map.set(id, normalizePart(slidePath, target));
    }
  } catch {
    /* a broken relationship part must not stop the conversion */
  }
  return map;
}

async function parsePptx(bytes: ArrayBuffer): Promise<ParsedSlide[]> {
  await assertZipSafe(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }), "pptx");
  const zip = await JSZip.loadAsync(bytes);
  const entryFiles = Object.keys(zip.files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p));
  if (!entryFiles.length) throw new Error("No slides were found in this presentation. Make sure it’s a .pptx file.");
  if (entryFiles.length > 400) throw new Error("This deck has more than 400 slides. Split it before converting.");
  return parseSlides(zip, entryFiles);
}

async function parseSlides(zip: JSZip, entryFiles: string[]): Promise<ParsedSlide[]> {
  let ordered: string[] = entryFiles.sort((a, b) => {
    const na = Number(a.match(/(\d+)/g)?.pop() ?? 0);
    const nb = Number(b.match(/(\d+)/g)?.pop() ?? 0);
    return na - nb;
  });
  const presFile = zip.file("ppt/presentation.xml");
  const relsFile = zip.file("ppt/_rels/presentation.xml.rels");
  if (presFile && relsFile) {
    try {
      const [presXml, relsXml] = await Promise.all([presFile.async("text"), relsFile.async("text")]);
      const presDom = new DOMParser().parseFromString(presXml, "application/xml");
      const relsDom = new DOMParser().parseFromString(relsXml, "application/xml");
      const targetById = new Map<string, string>();
      for (const rel of Array.from(relsDom.getElementsByTagName("Relationship"))) {
        const id = rel.getAttribute("Id");
        const target = rel.getAttribute("Target");
        if (id && target) targetById.set(id, target);
      }
      const ids = Array.from(presDom.getElementsByTagName("p:sldId"));
      const paths = ids
        .map((el) => targetById.get(el.getAttribute("r:id") ?? "") ?? "")
        .filter(Boolean)
        .map((target) => (target.startsWith("/") ? target.slice(1) : `ppt/${target.replace(/^\.\//, "")}`));
      const resolved = paths.filter((p) => zip.file(p));
      if (resolved.length) ordered = resolved;
    } catch {
      /* keep numeric order */
    }
  }
  const result: ParsedSlide[] = [];
  for (const path of ordered) {
    const xml = await zip.file(path)!.async("text");
    const dom = new DOMParser().parseFromString(xml, "application/xml");
    const paragraphs = Array.from(dom.getElementsByTagNameNS(A_NS, "p"))
      .map((p) =>
        Array.from(p.getElementsByTagNameNS(A_NS, "t"))
          .map((t) => t.textContent ?? "")
          .join("")
          .trim(),
      )
      .filter(Boolean);
    const rels = await readSlideRels(zip, path);
    const background = await (async () => {
      const bg = dom.getElementsByTagName("p:bg")[0];
      if (!bg) return undefined;
      const blip = bg.getElementsByTagNameNS(A_NS, "blip")[0];
      const embed = blip?.getAttributeNS(R_NS, "embed") ?? blip?.getAttribute("r:embed") ?? "";
      return rels.get(embed);
    })();
    const notes = await (async () => {
      for (const target of rels.values()) {
        if (!/notesSlide\d*\.xml$/.test(target)) continue;
        const notesFile = zip.file(target);
        if (!notesFile) continue;
        try {
          const notesDom = new DOMParser().parseFromString(await notesFile.async("text"), "application/xml");
          return Array.from(notesDom.getElementsByTagNameNS(A_NS, "p"))
            .map((p) =>
              Array.from(p.getElementsByTagNameNS(A_NS, "t"))
                .map((t) => t.textContent ?? "")
                .join("")
                .trim(),
            )
            .filter(Boolean)
            .join(" ");
        } catch {
          return "";
        }
      }
      return "";
    })();
    result.push({ title: paragraphs[0] ?? `Slide ${result.length + 1}`, paragraphs: paragraphs.slice(1), notes, background });
  }
  return result;
}

type SlideSize = "16x9" | "4x3";

interface PptPdfResult {
  bytes: Uint8Array;
  name: string;
  pages: number;
  slides: number;
  notes: number;
  backgrounds: number;
}

export function PptToPdfTool() {
  const initial = useInitialFiles().filter((f) => /\.pptx$/i.test(f.name));
  const [file, setFile] = useState<File | null>(initial[0] ?? null);
  const opts = useToolPreferences("ppt-to-pdf", {
    size: "16x9" as SlideSize,
    notes: true,
    backgrounds: true,
  });
  const [range, setRange] = useState("");
  const [result, setResult] = useState<PptPdfResult | null>(null);
  const [notes, setNotes] = useState<{ slide: number; paragraphs: number }[]>([]);
  const job = useJob<PptPdfResult>();
  const canRun = Boolean(file) && !job.busy;

  const convert = () => {
    if (!file) return;
    const source = file;
    void (async () => {
      const output = await job.run(async (reporter) => {
        if (!/\.pptx$/i.test(source.name)) throw new Error("Please use a .pptx file. Older .ppt files must be re-saved as .pptx in PowerPoint.");
        const bytes = await readFileBytes(source);
        reporter.report(10, "Reading slides…");
        const slides = await parsePptx(bytes);
        if (!slides.length) throw new Error("No readable slides were found.");
        setNotes(slides.map((slide, index) => ({ slide: index + 1, paragraphs: slide.paragraphs.length })));
        const wanted = range.trim() ? parsePageQuery(range, slides.length) : slides.map((_, index) => index + 1);
        const chosen = wanted.map((page) => ({ page, slide: slides[page - 1] })).filter((entry) => Boolean(entry.slide));

        const archive = opts.value.backgrounds ? await JSZip.loadAsync(bytes) : null;
        const doc = await PDFDocument.create();
        const fonts = await embedFonts(doc);
        const W = 960;
        const H = opts.value.size === "16x9" ? 540 : 720;
        const margin = 52;
        let backgrounds = 0;
        for (let i = 0; i < chosen.length; i += 1) {
          reporter.throwIfCancelled();
          const { page: pageNumber, slide } = chosen[i];
          const page = doc.addPage([W, H]);
          if (archive && slide.background) {
            const media = archive.file(slide.background);
            if (media) {
              try {
                const data = await media.async("uint8array");
                const image = isPngBytes(data) ? await doc.embedPng(data) : await doc.embedJpg(data);
                const scale = Math.max(W / image.width, H / image.height);
                page.drawImage(image, {
                  x: (W - image.width * scale) / 2,
                  y: (H - image.height * scale) / 2,
                  width: image.width * scale,
                  height: image.height * scale,
                });
                // Keep the text readable on top of busy artwork.
                page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(1, 1, 1), opacity: 0.84 });
                backgrounds += 1;
              } catch {
                /* skip an unusable background image */
              }
            }
          }
          page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: hexToRgb("#d9f26c") });
          page.drawText(String(pageNumber).padStart(2, "0"), {
            x: W - margin - 20,
            y: 24,
            size: 9,
            font: fonts.regular,
            color: rgb(0.6, 0.63, 0.6),
          });
          let y = H - 74;
          const titleLines = wrapText(slide.title, { font: fonts.bold, size: 25, color: "#12211a", maxWidth: W - margin * 2 });
          titleLines.forEach((line) => {
            page.drawText(line, { x: margin, y, size: 25, font: fonts.bold, color: hexToRgb("#12211a"), maxWidth: W - margin * 2 });
            y -= 31;
          });
          y -= 8;
          page.drawRectangle({ x: margin, y, width: 46, height: 3, color: hexToRgb("#1c4c3b") });
          y -= 26;
          const notesRoom = opts.value.notes && slide.notes ? 96 : 0;
          for (const paragraph of slide.paragraphs) {
            const lines = wrapText(paragraph, { font: fonts.regular, size: 13.5, color: "#33413a", maxWidth: W - margin * 2 - 22 });
            if (y - lines.length * 20 < 34 + notesRoom) break;
            page.drawCircle({ x: margin + 5, y: y + 4, size: 2.2, color: hexToRgb("#1c4c3b") });
            lines.forEach((line) => {
              page.drawText(line, { x: margin + 18, y, size: 13.5, font: fonts.regular, color: hexToRgb("#33413a"), maxWidth: W - margin * 2 - 22 });
              y -= 20;
            });
            y -= 6;
          }
          if (notesRoom) {
            page.drawRectangle({ x: margin, y: notesRoom, width: W - margin * 2, height: 0.7, color: rgb(0.85, 0.87, 0.84) });
            page.drawText("Speaker notes", { x: margin, y: notesRoom - 14, size: 8, font: fonts.bold, color: rgb(0.42, 0.46, 0.43) });
            const noteLines = wrapText(slide.notes, { font: fonts.regular, size: 9, color: "#4a5a51", maxWidth: W - margin * 2 });
            noteLines.slice(0, 4).forEach((line, index) => {
              page.drawText(line, { x: margin, y: notesRoom - 28 - index * 13, size: 9, font: fonts.regular, color: hexToRgb("#4a5a51") });
            });
          }
          reporter.report(15 + ((i + 1) / chosen.length) * 80, `Turning slide ${i + 1} of ${chosen.length} into a page…`);
        }
        if (!doc.getPageCount()) throw new Error("The selected slides produced no pages.");
        const pdfBytes = await doc.save();
        reporter.report(100, "Done");
        return {
          bytes: pdfBytes,
          name: `${sanitizeName(baseName(source.name))}.pdf`,
          pages: doc.getPageCount(),
          slides: chosen.length,
          notes: opts.value.notes ? chosen.filter((entry) => entry.slide.notes).length : 0,
          backgrounds,
        };
      });
      if (output) setResult(output);
    })();
  };

  usePrimaryShortcut(convert, canRun);
  useDownloadShortcut(
    () => {
      if (!result) return;
      downloadOutput(result.bytes, result.name, "application/pdf");
    },
    Boolean(result),
  );

  return (
    <div className="space-y-5">
      {!file ? (
        <FileDrop
          accept=".pptx"
          acceptLabel=".pptx presentations"
          onFiles={(files) => {
            setFile(files[0]);
            setResult(null);
          }}
          hint="Only .pptx is supported — re-save older .ppt decks in PowerPoint first."
        />
      ) : (
        <FileRow
          file={file}
          onRemove={() => {
            setFile(null);
            setResult(null);
            setNotes([]);
          }}
          size={formatBytes(file.size)}
        />
      )}
      {file && (
        <>
          <Alert tone="info" title="Text-faithful conversion">
            Slide titles and bullet text are laid out cleanly on landscape pages. Theme graphics and animations are simplified. For a
            pixel-perfect deck, use PowerPoint’s own “Export as PDF”.
          </Alert>
          <Field label="Slides to convert" hint="Leave empty for every slide. Slide order is preserved.">
            <TextInput value={range} onChange={(event) => setRange(event.target.value)} placeholder="All slides" autoComplete="off" />
          </Field>
          <AdvancedOptions scope="ppt-to-pdf" badge="3 controls" description="Slide size, notes, backgrounds" onReset={opts.reset}>
            <OptionsGrid>
              <Field label="Slide size">
                <Select value={opts.value.size} onChange={(event) => opts.set("size", event.target.value as SlideSize)}>
                  <option value="16x9">16:9 widescreen</option>
                  <option value="4x3">4:3 classic</option>
                </Select>
              </Field>
              <Switch
                label="Include speaker notes"
                checked={opts.value.notes}
                onChange={(value) => opts.set("notes", value)}
                description="Prints each slide's notes at the bottom of its page."
              />
              <Switch
                label="Keep background images"
                checked={opts.value.backgrounds}
                onChange={(value) => opts.set("backgrounds", value)}
                description="Places the deck's background picture behind the text, lightened for readability."
              />
            </OptionsGrid>
            <div className="mt-3">
              <OptionNote>Everything is parsed in this tab. Presentation files are never uploaded.</OptionNote>
            </div>
          </AdvancedOptions>
          {notes.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {notes.slice(0, 12).map((n) => (
                <Badge key={n.slide}>
                  Slide {n.slide}: {n.paragraphs} text blocks
                </Badge>
              ))}
              {notes.length > 12 && <Badge tone="neutral">+{notes.length - 12} more slides</Badge>}
            </div>
          )}
          {job.failed && <Alert tone="error">{job.error}</Alert>}
          {job.status === "cancelled" && <Alert tone="info">Cancelled — nothing was downloaded. Your previous result is unchanged.</Alert>}
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={convert} loading={job.busy} disabled={!canRun}>
              <Presentation className="h-4 w-4" /> Convert to PDF
            </Button>
            {job.busy && (
              <Button variant="ghost" onClick={job.cancel}>
                Cancel
              </Button>
            )}
            <ShortcutHint run="⌘/Ctrl + Enter to convert" download={result ? "⌘/Ctrl + S to download" : undefined} />
          </div>
          {job.busy && (
            <Progress value={job.percent ?? undefined} label={job.label} detail={describeJobTime(job)} etaMs={job.etaMs} />
          )}
        </>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Your deck is now a PDF"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          mime="application/pdf"
          onDownload={() => downloadOutput(result.bytes, result.name, "application/pdf")}
          description={`${result.slides} slides · ${result.pages} pages · ${opts.value.size === "16x9" ? "16:9" : "4:3"} · selectable text${
            result.notes ? ` · ${result.notes} with notes` : ""
          }${result.backgrounds ? ` · ${result.backgrounds} background${result.backgrounds === 1 ? "" : "s"}` : ""}`}
          facts={[
            { label: "Slides", value: String(result.slides) },
            { label: "Notes", value: result.notes ? String(result.notes) : "None" },
          ]}
        />
      )}
    </div>
  );
}

function isPngBytes(bytes: Uint8Array): boolean {
  return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

/* ================================================================== *
 * EXTRACT TEXT
 * ================================================================== */
type TextMode = "markers" | "plain" | "json" | "zip";
type ReadingOrder = "lines" | "reflow";

interface TextResult {
  bytes: Uint8Array;
  name: string;
  mode: TextMode;
  pages: number;
  characters: number;
  preview: string;
  previewPage: number;
  entries: { name: string; characters: number }[];
}

function pageBody(page: ExtractedPage, order: ReadingOrder): string {
  return order === "reflow" ? linesToParagraphs(page.lines).join("\n\n") : page.text;
}

function assembleText(pages: ExtractedPage[], mode: TextMode, order: ReadingOrder, sourceName: string): string {
  if (mode === "json") {
    return JSON.stringify(
      {
        source: sourceName,
        generator: "Paperly PDF",
        pages: pages.map((page) => ({
          page: page.page,
          characters: pageBody(page, order).replace(/\s/g, "").length,
          text: pageBody(page, order),
        })),
      },
      null,
      2,
    );
  }
  if (mode === "plain") return pages.map((page) => pageBody(page, order)).join("\n\n");
  return pages.map((page) => `--- Page ${page.page} ---\n${pageBody(page, order)}`).join("\n\n");
}

export function ExtractTextTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const opts = useToolPreferences("extract-text", {
    mode: "markers" as TextMode,
    order: "lines" as ReadingOrder,
  });
  const [range, setRange] = useState("");
  const [result, setResult] = useState<TextResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyTextValue, setCopyTextValue] = useState("");
  const job = useJob<TextResult>();
  const { thumbs } = usePdfThumbs(pdf.bytes, { width: 120, quality: 0.6, max: 12 });
  const canRun = Boolean(pdf.bytes && pdf.file) && !job.busy;

  const extract = () => {
    if (!pdf.bytes || !pdf.file) return;
    const bytes = pdf.bytes;
    const sourceName = pdf.file.name;
    const total = pdf.pageCount;
    void (async () => {
      const output = await job.run(async (reporter) => {
        const pages = parsePageQuery(range, total);
        reporter.report(2, "Reading the text layer…", describePageQuery(pages, total));
        const extracted = await extractDocument(bytes, {
          pages,
          onProgress: (done, count) => {
            reporter.throwIfCancelled();
            reporter.report(2 + (done / Math.max(1, count)) * 90, `Reading page ${done} of ${count}…`);
          },
        });
        reporter.throwIfCancelled();
        if (!extracted.text.trim()) {
          throw new Error("No text layer found. This looks like a scanned PDF — the pages are images, so there’s no text to extract.");
        }
        const stem = sanitizeName(baseName(sourceName));
        const characters = extracted.pages.reduce((sum, page) => sum + pageBody(page, opts.value.order).length, 0);
        const previewPage = extracted.pages[0];
        reporter.report(95, "Writing the output…");

        if (opts.value.mode === "zip") {
          const zip = new JSZip();
          const entries = extracted.pages.map((page) => {
            const name = `${stem}-page-${String(page.page).padStart(2, "0")}.txt`;
            zip.file(name, pageBody(page, opts.value.order));
            return { name, characters: pageBody(page, opts.value.order).length };
          });
          const zipBytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
          reporter.report(100, "Done");
          return {
            bytes: zipBytes,
            name: `${stem}-text-pages.zip`,
            mode: "zip" as const,
            pages: extracted.pages.length,
            characters,
            preview: pageBody(previewPage, opts.value.order),
            previewPage: previewPage.page,
            entries,
          };
        }

        const text = assembleText(extracted.pages, opts.value.mode, opts.value.order, sourceName);
        const extension = opts.value.mode === "json" ? "json" : "txt";
        reporter.report(100, "Done");
        return {
          bytes: new TextEncoder().encode(text),
          name: `${stem}.${extension}`,
          mode: opts.value.mode,
          pages: extracted.pages.length,
          characters,
          preview: pageBody(previewPage, opts.value.order),
          previewPage: previewPage.page,
          entries: extracted.pages.map((page) => ({
            name: `Page ${page.page}`,
            characters: pageBody(page, opts.value.order).length,
          })),
        };
      });
      if (output) {
        setResult(output);
        if (output.mode !== "zip") setCopyTextValue(new TextDecoder().decode(output.bytes));
        else setCopyTextValue(output.entries.map((entry) => entry.name).join("\n"));
      }
    })();
  };

  const copyAll = async () => {
    if (!copyTextValue) return;
    setCopied(await copyText(copyTextValue));
    window.setTimeout(() => setCopied(false), 1800);
  };

  useEffect(() => {
    setResult(null);
    setCopyTextValue("");
  }, [pdf.bytes]);

  usePrimaryShortcut(extract, canRun);
  useDownloadShortcut(
    () => {
      if (!result) return;
      downloadOutput(result.bytes, result.name);
    },
    Boolean(result),
  );

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A text-based PDF" />
      {pdf.bytes && (
        <div className="grid gap-4 sm:grid-cols-[1fr_200px]">
          <div className="space-y-4">
            <RangeField value={range} onChange={setRange} total={pdf.pageCount} label="Pages to extract" hint="Leave empty for all pages." />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Output" hint="Page markers keep page numbers when you paste the text elsewhere.">
                <Select value={opts.value.mode} onChange={(event) => opts.set("mode", event.target.value as TextMode)}>
                  <option value="markers">Plain text with page markers</option>
                  <option value="plain">Plain text, no markers</option>
                  <option value="json">JSON with page numbers</option>
                  <option value="zip">One .txt file per page (ZIP)</option>
                </Select>
              </Field>
              <Field label="Reading order" hint="Reflow joins wrapped lines into paragraphs; lines keeps the original breaks.">
                <Select value={opts.value.order} onChange={(event) => opts.set("order", event.target.value as ReadingOrder)}>
                  <option value="lines">Keep original line breaks</option>
                  <option value="reflow">Reflow into paragraphs</option>
                </Select>
              </Field>
            </div>
            {job.failed && <Alert tone="error">{job.error}</Alert>}
            {job.status === "cancelled" && <Alert tone="info">Cancelled — nothing was downloaded. Your previous result is unchanged.</Alert>}
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
              <Button onClick={extract} loading={job.busy} disabled={!canRun}>
                <TextCursorInput className="h-4 w-4" /> Extract text
              </Button>
              {job.busy && (
                <Button variant="ghost" onClick={job.cancel}>
                  Cancel
                </Button>
              )}
              {result && result.mode !== "zip" && (
                <Button variant="outline" onClick={() => void copyAll()}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? "Copied" : "Copy all"}
                </Button>
              )}
              <ShortcutHint run="⌘/Ctrl + Enter to extract" download={result ? "⌘/Ctrl + S to download" : undefined} />
            </div>
            {job.busy && (
              <Progress value={job.percent ?? undefined} label={job.label} detail={describeJobTime(job)} etaMs={job.etaMs} />
            )}
            {result && (
              <div className="rounded-xl border border-line bg-bone-deep/25 p-3">
                <p className="mb-1.5 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/75">
                  <span>Preview · page {result.previewPage}</span>
                  <span className="font-normal normal-case tracking-normal text-muted">{result.mode === "json" ? "JSON" : result.mode === "zip" ? "per-page files" : "text"}</span>
                </p>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-paper px-3 py-2 font-mono text-[11.5px] leading-relaxed text-ink/80">
                  {result.preview.slice(0, 1200) || "(this page has no text)"}
                </pre>
              </div>
            )}
            {result && result.mode !== "zip" && (
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/75">Extracted text</p>
                  <span className="text-[11px] text-muted">{copyTextValue.length.toLocaleString()} characters</span>
                </div>
                <TextArea value={copyTextValue} readOnly rows={12} className="font-mono text-[12px]" />
              </div>
            )}
            {result && result.mode === "zip" && (
              <div className="rounded-xl border border-line">
                <p className="border-b border-line bg-bone-deep/50 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/75">
                  {result.entries.length} text file{result.entries.length === 1 ? "" : "s"}
                </p>
                <ul className="max-h-48 overflow-auto px-3 py-2 text-[11.5px] text-ink/75">
                  {result.entries.slice(0, 40).map((entry) => (
                    <li key={entry.name} className="flex justify-between gap-3 border-b border-line/50 py-1 last:border-0">
                      <span className="truncate font-mono">{entry.name}</span>
                      <span className="shrink-0 text-muted">{entry.characters.toLocaleString()} chars</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/75">Pages</p>
            <div className="grid grid-cols-3 gap-1.5">
              {thumbs.map((thumb) => (
                <div key={thumb.page} className="overflow-hidden rounded border border-line bg-white">
                  <img src={thumb.dataUrl} alt={`Page ${thumb.page}`} className="w-full" />
                </div>
              ))}
            </div>
            {pdf.pageCount > 12 && <p className="mt-1.5 text-[10.5px] text-muted">+{pdf.pageCount - 12} more pages</p>}
          </div>
        </div>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Extracted text is ready"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          mime={result.mode === "json" ? "application/json" : result.mode === "zip" ? "application/zip" : "text/plain"}
          onDownload={() => downloadOutput(result.bytes, result.name)}
          description={`${result.characters.toLocaleString()} characters from ${result.pages} page${
            result.pages === 1 ? "" : "s"
          } · ${result.entries.length} ${result.mode === "zip" ? "file" : "page"}${result.entries.length === 1 ? "" : "s"}`}
          facts={[
            { label: "Format", value: result.mode === "json" ? "JSON" : result.mode === "zip" ? "ZIP" : "Text" },
            { label: "Order", value: opts.value.order === "reflow" ? "Reflowed" : "Line breaks kept" },
          ]}
        />
      )}
      {!result && !job.busy && pdf.bytes && (
        <p className="flex items-center gap-1.5 text-[11.5px] text-muted">
          <FileType className="h-3.5 w-3.5" /> Text is read from the PDF’s own text layer. Nothing is uploaded.
        </p>
      )}
    </div>
  );
}
