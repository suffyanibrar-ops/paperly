import {
  Check,
  Copy,
  Download,
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
import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import {
  PDFDocument,
  baseName,
  downloadBlob,
  downloadBytes,
  embedFonts,
  formatBytes,
  hexToRgb,
  openPdfJs,
  renderPdfPage,
  parseRanges,
  readFileBytes,
  rgb,
  sanitizeName,
  uniqueInOrder,
  wrapText,
  type FontPack,
} from "@/lib/pdf";
import { detectColumns, extractDocument, linesToParagraphs, type ExtractedPage } from "@/lib/extract";
import { useInitialFiles, usePdfFile, usePdfThumbs } from "@/lib/usePdf";
import { copyText } from "@/lib/router";
import { assertZipSafe, friendlyProcessingError, validateUpload } from "@/lib/security";
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
} from "@/components/ui";
import { DownloadPanel, RangeField, SinglePdfInput } from "@/components/toolParts";
import { cn } from "@/utils/cn";

/* ================================================================== *
 * PDF → WORD
 * ================================================================== */
export function PdfToWordTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [range, setRange] = useState("");
  const [structured, setStructured] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [result, setResult] = useState<{ blob: Blob; name: string; chars: number; pages: number } | null>(null);

  const convert = async () => {
    if (!pdf.bytes || !pdf.file) return;
    setBusy(true);
    setError("");
    setWarning("");
    setResult(null);
    try {
      const pages = uniqueInOrder(parseRanges(range, pdf.pageCount));
      const extracted = await extractDocument(pdf.bytes, {
        pages,
        onProgress: (done, total) => setProgress(Math.round((done / total) * 75)),
      });
      const chars = extracted.text.replace(/\s/g, "").length;
      if (chars < 10) {
        throw new Error("No text layer found. This PDF is probably a scan — there’s nothing to convert without OCR.");
      }
      if (chars < pages.length * 25) {
        setWarning("Very little text was found. Some pages may be scanned images without a text layer.");
      }
      setProgress(82);
      const children: Paragraph[] = [];
      extracted.pages.forEach((page, pageIndex) => {
        if (pageIndex > 0) children.push(new Paragraph({ pageBreakBefore: true, children: [] }));
        const blocks = structured ? linesToParagraphs(page.lines) : page.lines.map((l) => l.text);
        if (!blocks.length) {
          children.push(new Paragraph({ children: [new TextRun({ text: `Page ${page.page}`, bold: true })] }));
        }
        blocks.forEach((block) => {
          const titleLike = pageIndex === 0 && block.length < 90 && block === blocks[0] && !/[.!?]$/.test(block);
          children.push(
            new Paragraph({
              heading: titleLike ? HeadingLevel.HEADING_1 : undefined,
              spacing: { after: titleLike ? 240 : 140, line: 300 },
              alignment: AlignmentType.LEFT,
              children: [
                new TextRun({
                  text: block,
                  size: titleLike ? 34 : 22,
                  font: "Calibri",
                  bold: titleLike,
                }),
              ],
            }),
          );
        });
      });
      const doc = new Document({
        creator: "Paperly",
        title: baseName(pdf.file.name),
        description: "Converted from PDF with Paperly",
        sections: [
          {
            properties: { page: { margin: { top: 900, bottom: 900, left: 900, right: 900 } } },
            children,
          },
        ],
      });
      const blob = await Packer.toBlob(doc);
      setProgress(100);
      setResult({
        blob,
        name: `${sanitizeName(baseName(pdf.file.name))}.docx`,
        chars,
        pages: extracted.pages.length,
      });
    } catch (err) {
      setError(friendlyProcessingError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A text-based PDF" />
      {pdf.bytes && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <RangeField value={range} onChange={setRange} total={pdf.pageCount} label="Pages to convert" hint="Leave empty for the whole document." />
            <div>
              <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink/70">Text handling</p>
              <Segmented
                value={structured ? "flow" : "lines"}
                onChange={(v) => setStructured(v === "flow")}
                size="sm"
                options={[
                  { value: "flow", label: "Flowing paragraphs" },
                  { value: "lines", label: "Keep line breaks" },
                ]}
              />
              <p className="mt-1.5 text-[11.5px] text-muted">Flowing paragraphs read better and edit more naturally in Word.</p>
            </div>
          </div>
          {error && <Alert tone="error">{error}</Alert>}
          {warning && <Alert tone="warning">{warning}</Alert>}
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={convert} loading={busy}>
              <FileType className="h-4 w-4" /> Convert to Word
            </Button>
            <span className="flex items-center gap-1 text-[11.5px] text-muted">
              <FileText className="h-3.5 w-3.5" /> Creates a real .docx file
            </span>
          </div>
          {busy && <Progress value={progress} label="Reading the text layer and building your document…" />}
        </>
      )}
      {result && (
        <DownloadPanel
          title="Your Word document is ready"
          filename={result.name}
          size={result.blob.size}
          pages={result.pages}
          onDownload={() => downloadBlob(result.blob, result.name)}
          description={`${result.chars.toLocaleString()} characters extracted · ${result.pages} page${result.pages === 1 ? "" : "s"} · editable text, no images`}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * PDF → EXCEL
 * ================================================================== */
export function PdfToExcelTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [mode, setMode] = useState<"columns" | "lines">("columns");
  const [range, setRange] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; rows: number; sheets: number } | null>(null);
  const [preview, setPreview] = useState<string[][]>([]);

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
    if (mode === "lines") return page.lines.map((line) => [line.text]);
    const columns = detectColumns(page.lines);
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

  const convert = async () => {
    if (!pdf.bytes || !pdf.file) return;
    setBusy(true);
    setError("");
    setWarning("");
    setResult(null);
    setPreview([]);
    try {
      const pages = uniqueInOrder(parseRanges(range, pdf.pageCount));
      const extracted = await extractDocument(pdf.bytes, {
        pages,
        onProgress: (done, total) => setProgress(Math.round((done / total) * 60)),
      });
      if (extracted.text.trim().length < 5) throw new Error("No text layer found. Scanned tables need OCR before conversion.");
      const wb = XLSX.utils.book_new();
      let totalRows = 0;
      extracted.pages.forEach((page, index) => {
        const rows = pageToRows(page);
        if (!rows.length) rows.push(["(no selectable text on this page)"]);
        if (index === 0) setPreview(rows.slice(0, 6).map((row) => row.slice(0, 8).map(String)));
        totalRows += rows.length;
        const ws = XLSX.utils.aoa_to_sheet(rows);
        ws["!cols"] = (rows[0] ?? []).map((_, ci) => {
          const longest = Math.max(...rows.map((r) => String(r[ci] ?? "").length), 6);
          return { wch: Math.min(48, Math.max(9, longest + 2)) };
        });
        XLSX.utils.book_append_sheet(wb, ws, `Page ${page.page}`.slice(0, 31));
        setProgress(60 + Math.round(((index + 1) / extracted.pages.length) * 30));
      });
      if (mode === "lines") setWarning("One row per text line was used. Switch to “Detect columns” for structured tables.");
      const out = XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
      setProgress(100);
      setResult({
        bytes: new Uint8Array(out),
        name: `${sanitizeName(baseName(pdf.file.name))}.xlsx`,
        rows: totalRows,
        sheets: extracted.pages.length,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF with tables or text" />
      {pdf.bytes && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink/70">Table detection</p>
              <Segmented
                value={mode}
                onChange={setMode}
                size="sm"
                options={[
                  { value: "columns", label: "Detect columns" },
                  { value: "lines", label: "Rows of text" },
                ]}
              />
            </div>
            <RangeField value={range} onChange={setRange} total={pdf.pageCount} label="Pages" hint="Leave empty for all pages." />
          </div>
          {error && <Alert tone="error">{error}</Alert>}
          {warning && <Alert tone="warning">{warning}</Alert>}
          <div className="flex items-center gap-2 border-t border-line pt-4">
            <Button onClick={convert} loading={busy}>
              <FileSpreadsheet className="h-4 w-4" /> Convert to Excel
            </Button>
            <span className="text-[11.5px] text-muted">One sheet per page · numbers kept numeric</span>
          </div>
          {busy && <Progress value={progress} label="Finding rows and columns…" />}
        </>
      )}
      {result && (
        <>
          <DownloadPanel
          bytes={result.bytes}
            title="Your spreadsheet is ready"
            filename={result.name}
            size={result.bytes.byteLength}
            pages={result.sheets}
            onDownload={() => downloadBytes(result.bytes, result.name, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
            description={`${result.rows} rows across ${result.sheets} sheet${result.sheets === 1 ? "" : "s"} · ${formatBytes(result.bytes.byteLength)}`}
          />
          {preview.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-line">
              <p className="border-b border-line bg-bone-deep/50 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/75">
                First page preview
              </p>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[11.5px]">
                  <tbody>
                    {preview.map((row, ri) => (
                      <tr key={ri} className={ri === 0 ? "bg-lime/15 font-medium" : "odd:bg-bone/40"}>
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
        </>
      )}
    </div>
  );
}

/* ================================================================== *
 * PDF → POWERPOINT
 * ================================================================== */
export function PdfToPptTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [range, setRange] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ blob: Blob; name: string; slides: number } | null>(null);

  const convert = async () => {
    if (!pdf.bytes || !pdf.file) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const pages = uniqueInOrder(parseRanges(range, pdf.pageCount));
      if (pages.length > 80) throw new Error("This tool handles up to 80 slides per run. Split the PDF for larger decks.");
      const doc = await openPdfJs(pdf.bytes);
      const pptx = new pptxgen();
      pptx.layout = "LAYOUT_16x9";
      pptx.author = "Paperly";
      pptx.subject = baseName(pdf.file.name);
      pptx.title = baseName(pdf.file.name);
      pptx.company = "Paperly";
      const margin = 0.14;
      for (let i = 0; i < pages.length; i++) {
        const rendered = await renderPdfPage(doc, pages[i], { scale: 1.8, type: "image/jpeg", quality: 0.86 });
        const slide = pptx.addSlide();
        slide.background = { color: "FFFFFF" };
        const imgRatio = rendered.width / rendered.height;
        const boxW = 10 - margin * 2;
        const boxH = 5.625 - margin * 2;
        let w = boxW;
        let h = w / imgRatio;
        if (h > boxH) {
          h = boxH;
          w = h * imgRatio;
        }
        slide.addImage({ data: rendered.dataUrl, x: (10 - w) / 2, y: (5.625 - h) / 2, w, h });
        slide.addText(`${pages[i]}`, {
          x: 9.3,
          y: 5.28,
          w: 0.5,
          h: 0.22,
          fontSize: 8,
          color: "9AA39D",
          align: "right",
        });
        setProgress(((i + 1) / pages.length) * 92);
      }
      await doc.destroy();
      const blob = (await pptx.write({ outputType: "blob" })) as Blob;
      setProgress(100);
      setResult({ blob, name: `${sanitizeName(baseName(pdf.file.name))}.pptx`, slides: pages.length });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to turn into slides" />
      {pdf.bytes && (
        <RangeField value={range} onChange={setRange} total={pdf.pageCount} label="Pages to include" hint="Leave empty for every page. Each page becomes one 16:9 slide." />
      )}
      {error && <Alert tone="error">{error}</Alert>}
      {pdf.bytes && (
        <>
          <div className="border-t border-line pt-4">
            <Button onClick={convert} loading={busy}>
              <Presentation className="h-4 w-4" /> Convert to PowerPoint
            </Button>
          </div>
          {busy && <Progress value={progress} label="Rendering pages and building slides…" />}
        </>
      )}
      {result && (
        <DownloadPanel
          title={`${result.slides} slides ready`}
          filename={result.name}
          size={result.blob.size}
          pages={result.slides}
          onDownload={() => downloadBlob(result.blob, result.name)}
          description="16:9 slides · page images at high resolution · opens in PowerPoint, Keynote and Google Slides"
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * WORD → PDF
 * ================================================================== */
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function paragraphInfo(p: Element) {
  let text = "";
  for (const node of Array.from(p.getElementsByTagNameNS(W_NS, "t"))) text += node.textContent ?? "";
  const styleNode = p.getElementsByTagNameNS(W_NS, "pStyle")[0];
  const style = styleNode?.getAttributeNS(W_NS, "val") ?? styleNode?.getAttribute("w:val") ?? "";
  const isList = p.getElementsByTagNameNS(W_NS, "numPr").length > 0;
  return { text: text.replace(/\s+/g, " ").trim(), style, isList };
}

interface DocBlock {
  type: "paragraph" | "table";
  text?: string;
  style?: string;
  isList?: boolean;
  rows?: string[][];
}

async function parseDocx(bytes: ArrayBuffer): Promise<DocBlock[]> {
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
  const blocks: DocBlock[] = [];
  for (const child of Array.from(body.children)) {
    if (child.localName === "p") {
      const info = paragraphInfo(child);
      if (info.text) blocks.push({ type: "paragraph", ...info });
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

function drawLines(c: Cursor, lines: string[], opts: { size: number; font: string; color?: string; indent?: number; lineHeight: number; x?: number }) {
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

async function renderDocxToPdf(blocks: DocBlock[], size: "a4" | "letter", pageNumbers: boolean): Promise<{ bytes: Uint8Array; pages: number }> {
  const dims: [number, number] = size === "a4" ? [595.28, 841.89] : [612, 792];
  const doc = await PDFDocument.create();
  const fonts = await embedFonts(doc);
  const cursor: Cursor = {
    doc,
    page: null,
    fonts,
    width: dims[0],
    height: dims[1],
    margin: 58,
    y: dims[1] - 58,
    pages: 0,
  };
  newPage(cursor);
  const maxWidth = cursor.width - cursor.margin * 2;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === "paragraph") {
      const style = block.style ?? "";
      const headingMatch = /^(Heading|heading)([1-6])/.exec(style);
      const isTitle = /^Title$/i.test(style);
      const level = headingMatch ? Number(headingMatch[2]) : 0;
      if (isTitle || level === 1) {
        cursor.y -= 10;
        const lines = wrapText(block.text ?? "", { font: fonts.bold, size: 22, color: "#12211a", maxWidth });
        drawLines(cursor, lines, { size: 22, font: "bold", color: "#12211a", lineHeight: 28 });
        cursor.y -= 6;
      } else if (level >= 2) {
        cursor.y -= 6;
        const hsize = level === 2 ? 16 : 13.5;
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
      } else {
        const lines = wrapText(block.text ?? "", { font: fonts.regular, size: 10.8, color: "#232d27", maxWidth });
        drawLines(cursor, lines, { size: 10.8, font: "regular", lineHeight: 15.5 });
        cursor.y -= 7;
      }
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

  if (pageNumbers && cursor.pages > 1) {
    doc.getPages().forEach((page, i) => {
      const label = `${i + 1} / ${cursor.pages}`;
      const w = fonts.regular.widthOfTextAtSize(label, 8);
      page.drawText(label, { x: (cursor.width - w) / 2, y: 26, size: 8, font: fonts.regular, color: rgb(0.55, 0.58, 0.55) });
    });
  }
  return { bytes: await doc.save(), pages: cursor.pages };
}

export function WordToPdfTool() {
  const initial = useInitialFiles().filter((f) => /\.docx$/i.test(f.name));
  const [file, setFile] = useState<File | null>(initial[0] ?? null);
  const [size, setSize] = useState<"a4" | "letter">("a4");
  const [numbering, setNumbering] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [stats, setStats] = useState<{ paragraphs: number; tables: number } | null>(null);
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; pages: number } | null>(null);

  const convert = async () => {
    if (!file) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      if (!/\.docx$/i.test(file.name)) {
        throw new Error("Please use a .docx file. Older .doc files need to be re-saved as .docx in Word first.");
      }
      setProgress(15);
      const blocks = await parseDocx(await readFileBytes(file));
      if (!blocks.length) throw new Error("This document appears to be empty.");
      setStats({
        paragraphs: blocks.filter((b) => b.type === "paragraph").length,
        tables: blocks.filter((b) => b.type === "table").length,
      });
      setProgress(45);
      const { bytes, pages } = await renderDocxToPdf(blocks, size, numbering);
      setProgress(100);
      setResult({ bytes, name: `${sanitizeName(baseName(file.name))}.pdf`, pages });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {!file ? (
        <FileDrop accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" acceptLabel=".docx documents" onFiles={(f) => setFile(f[0])} />
      ) : (
        <FileRow file={file} onRemove={() => { setFile(null); setResult(null); }} size={formatBytes(file.size)} />
      )}
      {file && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Page size">
              <Select value={size} onChange={(e) => setSize(e.target.value as "a4" | "letter")}>
                <option value="a4">A4</option>
                <option value="letter">US Letter</option>
              </Select>
            </Field>
            <div className="pt-5">
              <Switch checked={numbering} onChange={setNumbering} label="Add page numbers" description="Bottom center, starting from page 2" />
            </div>
          </div>
          {stats && (
            <p className="text-[11.5px] text-muted">
              Found {stats.paragraphs} paragraphs and {stats.tables} table{stats.tables === 1 ? "" : "s"}.
            </p>
          )}
          {error && <Alert tone="error">{error}</Alert>}
          <div className="flex items-center gap-2 border-t border-line pt-4">
            <Button onClick={convert} loading={busy}>
              <FileText className="h-4 w-4" /> Convert to PDF
            </Button>
            <span className="text-[11.5px] text-muted">DOCX is parsed locally</span>
          </div>
          {busy && <Progress value={progress} label="Laying out your document…" />}
        </>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Your Word document is now a PDF"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`Headings, paragraphs, lists and tables preserved · ${result.pages} page${result.pages === 1 ? "" : "s"}`}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * EXCEL → PDF
 * ================================================================== */
function renderSheet(out: PDFDocument, fonts: FontPack, sheetName: string, matrix: (string | number)[][], orientation: "portrait" | "landscape") {
  const clean = matrix.map((r) => r.map((c) => (c == null ? "" : String(c)))).filter((r) => r.some((c) => c.trim() !== ""));
  if (!clean.length) return 0;
  const page: [number, number] = orientation === "landscape" ? [841.89, 595.28] : [595.28, 841.89];
  const margin = 32;
  const contentW = page[0] - margin * 2;
  const colCount = Math.max(...clean.map((r) => r.length));
  const weights = Array.from({ length: colCount }, (_, ci) =>
    Math.min(38, Math.max(7, ...clean.map((r) => (r[ci] ?? "").length))),
  );
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => (w / totalWeight) * contentW);
  const fontSize = colCount > 9 ? 7 : colCount > 6 ? 7.8 : 8.6;
  const lineHeight = fontSize + 3.2;
  const headerRows = 1;
  let pageNum = 1;

  const startPage = (continued: boolean) => {
    const p = out.addPage([page[0], page[1]]);
    p.drawRectangle({ x: 0, y: page[1] - 4, width: page[0], height: 4, color: hexToRgb("#d9f26c") });
    p.drawText(continued ? `${sheetName} (continued)` : sheetName, {
      x: margin,
      y: page[1] - 34,
      size: 14,
      font: fonts.bold,
      color: hexToRgb("#12211a"),
    });
    p.drawText("Paperly · local conversion", { x: page[0] - margin - 90, y: page[1] - 30, size: 7, font: fonts.regular, color: rgb(0.56, 0.6, 0.57) });
    p.drawText(`Page ${pageNum}`, { x: page[0] - margin - 34, y: 16, size: 7, font: fonts.regular, color: rgb(0.56, 0.6, 0.57) });
    return { p, y: page[1] - 52 };
  };

  let current = startPage(false);
  pageNum++;

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
      current.p.drawRectangle({ x, y: top - rowH, width: widths[ci], height: rowH, borderColor: rgb(0.8, 0.82, 0.76), borderWidth: 0.5 });
      x += widths[ci];
    }
    current.y = top - rowH;
  };

  const heightsFor = (row: string[]) =>
    Array.from({ length: colCount }, (_, ci) =>
      wrapText(row[ci] ?? "", { font: fonts.regular, size: fontSize, color: "#000", maxWidth: Math.max(12, widths[ci] - 7) }),
    );

  drawHeader();
  for (let rowIndex = headerRows; rowIndex < clean.length; rowIndex++) {
    const row = clean[rowIndex];
    const cellLines = heightsFor(row);
    const rowH = Math.max(...cellLines.map((l) => l.length), 1) * lineHeight + 6;
    if (current.y - rowH < margin + 14) {
      current = startPage(true);
      pageNum++;
      drawHeader();
    }
    const top = current.y;
    if ((rowIndex - headerRows) % 2 === 1) {
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
      current.p.drawRectangle({ x, y: top - rowH, width: widths[ci], height: rowH, borderColor: rgb(0.85, 0.86, 0.81), borderWidth: 0.45 });
      x += widths[ci];
    }
    current.y -= rowH;
  }
  return pageNum;
}

export function ExcelToPdfTool() {
  const initial = useInitialFiles().filter((f) => /\.(xlsx|xls|csv)$/i.test(f.name));
  const [file, setFile] = useState<File | null>(initial[0] ?? null);
  const [workbook, setWorkbook] = useState<XLSX.WorkBook | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [orientation, setOrientation] = useState<"auto" | "portrait" | "landscape">("auto");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; pages: number; sheets: number } | null>(null);

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

  const convert = async () => {
    if (!file || !workbook) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      if (!selected.length) throw new Error("Select at least one sheet.");
      const doc = await PDFDocument.create();
      const fonts = await embedFonts(doc);
      let pages = 0;
      for (let i = 0; i < selected.length; i++) {
        const ws = workbook.Sheets[selected[i]];
        if (!ws) continue;
        const matrix = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1, defval: "", raw: false }) as (string | number)[][];
        const cols = Math.max(0, ...matrix.map((r) => r.length));
        const mode = orientation === "auto" ? (cols > 5 ? "landscape" : "portrait") : orientation;
        pages += renderSheet(doc, fonts, selected[i], matrix, mode);
        setProgress(((i + 1) / selected.length) * 95);
      }
      if (!doc.getPageCount()) throw new Error("The selected sheets contain no printable rows.");
      const bytes = await doc.save();
      setProgress(100);
      setResult({ bytes, name: `${sanitizeName(baseName(file.name))}.pdf`, pages, sheets: selected.length });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {!file ? (
        <FileDrop accept=".xlsx,.xls,.csv" acceptLabel="Excel or CSV files" onFiles={(f) => setFile(f[0])} />
      ) : (
        <FileRow file={file} onRemove={() => { setFile(null); setResult(null); }} size={formatBytes(file.size)} />
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
              <Segmented
                value={orientation}
                onChange={setOrientation}
                size="sm"
                options={[
                  { value: "auto", label: "Auto" },
                  { value: "portrait", label: "Portrait" },
                  { value: "landscape", label: "Landscape" },
                ]}
              />
            </Field>
            <div className="rounded-xl border border-line bg-bone-deep/35 px-3.5 py-2.5 text-[11.5px] leading-relaxed text-ink/70">
              Column widths and row heights adjust automatically. Long tables continue onto new pages with headers repeated.
            </div>
          </div>
          {error && <Alert tone="error">{error}</Alert>}
          <div className="border-t border-line pt-4">
            <Button onClick={convert} loading={busy}>
              <FileSpreadsheet className="h-4 w-4" /> Convert to PDF
            </Button>
          </div>
          {busy && <Progress value={progress} label="Laying out sheets…" />}
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
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${result.sheets} sheet${result.sheets === 1 ? "" : "s"} · ${result.pages} pages · headers repeat across page breaks`}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * POWERPOINT → PDF
 * ================================================================== */
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";

async function parsePptx(bytes: ArrayBuffer): Promise<{ title: string; paragraphs: string[] }[]> {
  await assertZipSafe(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }), "pptx");
  const zip = await JSZip.loadAsync(bytes);
  const entryFiles = Object.keys(zip.files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p));
  if (!entryFiles.length) throw new Error("No slides were found in this presentation. Make sure it’s a .pptx file.");
  if (entryFiles.length > 400) throw new Error("This deck has more than 400 slides. Split it before converting.");
  return parseSlides(zip, entryFiles);
}

async function parseSlides(zip: JSZip, entryFiles: string[]): Promise<{ title: string; paragraphs: string[] }[]> {
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
  const result: { title: string; paragraphs: string[] }[] = [];
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
    result.push({ title: paragraphs[0] ?? `Slide ${result.length + 1}`, paragraphs: paragraphs.slice(1) });
  }
  return result;
}

export function PptToPdfTool() {
  const initial = useInitialFiles().filter((f) => /\.pptx$/i.test(f.name));
  const [file, setFile] = useState<File | null>(initial[0] ?? null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; pages: number; slides: number } | null>(null);
  const [notes, setNotes] = useState<{ slide: number; paragraphs: number }[]>([]);

  const convert = async () => {
    if (!file) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      if (!/\.pptx$/i.test(file.name)) throw new Error("Please use a .pptx file. Older .ppt files must be re-saved as .pptx in PowerPoint.");
      const slides = await parsePptx(await readFileBytes(file));
      if (!slides.length) throw new Error("No readable slides were found.");
      setNotes(slides.map((s, i) => ({ slide: i + 1, paragraphs: s.paragraphs.length })));
      const doc = await PDFDocument.create();
      const fonts = await embedFonts(doc);
      const W = 960;
      const H = 540;
      const margin = 52;
      for (let i = 0; i < slides.length; i++) {
        const slide = slides[i];
        const page = doc.addPage([W, H]);
        page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: hexToRgb("#d9f26c") });
        page.drawText(String(i + 1).padStart(2, "0"), { x: W - margin - 20, y: 24, size: 9, font: fonts.regular, color: rgb(0.6, 0.63, 0.6) });
        let y = H - 74;
        const titleLines = wrapText(slide.title, { font: fonts.bold, size: 25, color: "#12211a", maxWidth: W - margin * 2 });
        titleLines.forEach((line) => {
          page.drawText(line, { x: margin, y, size: 25, font: fonts.bold, color: hexToRgb("#12211a"), maxWidth: W - margin * 2 });
          y -= 31;
        });
        y -= 8;
        page.drawRectangle({ x: margin, y, width: 46, height: 3, color: hexToRgb("#1c4c3b") });
        y -= 26;
        for (const para of slide.paragraphs) {
          const lines = wrapText(para, { font: fonts.regular, size: 13.5, color: "#33413a", maxWidth: W - margin * 2 - 22 });
          if (y - lines.length * 20 < 34) break;
          page.drawCircle({ x: margin + 5, y: y + 4, size: 2.2, color: hexToRgb("#1c4c3b") });
          lines.forEach((line) => {
            page.drawText(line, { x: margin + 18, y, size: 13.5, font: fonts.regular, color: hexToRgb("#33413a"), maxWidth: W - margin * 2 - 22 });
            y -= 20;
          });
          y -= 6;
        }
        setProgress(((i + 1) / slides.length) * 95);
      }
      const bytes = await doc.save();
      setProgress(100);
      setResult({ bytes, name: `${sanitizeName(baseName(file.name))}.pdf`, pages: doc.getPageCount(), slides: slides.length });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {!file ? (
        <FileDrop accept=".pptx" acceptLabel=".pptx presentations" onFiles={(f) => setFile(f[0])} />
      ) : (
        <FileRow file={file} onRemove={() => { setFile(null); setResult(null); setNotes([]); }} size={formatBytes(file.size)} />
      )}
      {file && (
        <>
          <Alert tone="info" title="Text-faithful conversion">
            Slide titles and bullet text are laid out cleanly on landscape pages. Theme graphics, images and animations are simplified. For a
            pixel-perfect deck, use PowerPoint’s own “Export as PDF”.
          </Alert>
          {notes.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {notes.slice(0, 12).map((n) => (
                <Badge key={n.slide}>
                  Slide {n.slide}: {n.paragraphs} text blocks
                </Badge>
              ))}
            </div>
          )}
          {error && <Alert tone="error">{error}</Alert>}
          <div className="border-t border-line pt-4">
            <Button onClick={convert} loading={busy}>
              <Presentation className="h-4 w-4" /> Convert to PDF
            </Button>
          </div>
          {busy && <Progress value={progress} label="Turning slides into pages…" />}
        </>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Your deck is now a PDF"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${result.slides} slides · one landscape page per slide · selectable text`}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * EXTRACT TEXT
 * ================================================================== */
export function ExtractTextTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [range, setRange] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  const { thumbs } = usePdfThumbs(pdf.bytes, { width: 120, quality: 0.6, max: 12 });

  const extract = async () => {
    if (!pdf.bytes || !pdf.file) return;
    setBusy(true);
    setError("");
    setText("");
    try {
      const pages = uniqueInOrder(parseRanges(range, pdf.pageCount));
      const result = await extractDocument(pdf.bytes, {
        pages,
        onProgress: (done, total) => setProgress(Math.round((done / total) * 100)),
      });
      if (!result.text.trim()) {
        throw new Error("No text layer found. This looks like a scanned PDF — the pages are images, so there’s no text to extract.");
      }
      setText(
        result.pages
          .map((p) => `— Page ${p.page} —\n${p.text}`)
          .join("\n\n"),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    if (!text) return;
    downloadBytes(new Uint8Array(new TextEncoder().encode(text)), `${sanitizeName(baseName(pdf.file?.name ?? "document"))}.txt`, "text/plain");
  };

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A text-based PDF" />
      {pdf.bytes && (
        <div className="grid gap-4 sm:grid-cols-[1fr_200px]">
          <div className="space-y-4">
            <RangeField value={range} onChange={setRange} total={pdf.pageCount} label="Pages to extract" hint="Leave empty for all pages." />
            {error && <Alert tone="error">{error}</Alert>}
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
              <Button onClick={extract} loading={busy}>
                <TextCursorInput className="h-4 w-4" /> Extract text
              </Button>
              {text && (
                <>
                  <Button variant="outline" onClick={async () => { setCopied(await copyText(text)); setTimeout(() => setCopied(false), 1800); }}>
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? "Copied" : "Copy all"}
                  </Button>
                  <Button variant="outline" onClick={download}>
                    <Download className="h-4 w-4" /> .txt
                  </Button>
                </>
              )}
            </div>
            {busy && <Progress value={progress} label="Reading the text layer…" />}
            {text && (
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/75">Extracted text</p>
                  <span className="text-[11px] text-muted">{text.length.toLocaleString()} characters</span>
                </div>
                <TextArea value={text} readOnly rows={12} className="font-mono text-[12px]" />
              </div>
            )}
          </div>
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/75">Pages</p>
            <div className="grid grid-cols-3 gap-1.5">
              {thumbs.map((t) => (
                <div key={t.page} className="overflow-hidden rounded border border-line bg-white">
                  <img src={t.dataUrl} alt={`Page ${t.page}`} className="w-full" />
                </div>
              ))}
            </div>
            {pdf.pageCount > 12 && <p className="mt-1.5 text-[10.5px] text-muted">+{pdf.pageCount - 12} more pages</p>}
          </div>
        </div>
      )}
      {!text && !busy && pdf.bytes && (
        <p className="flex items-center gap-1.5 text-[11.5px] text-muted">
          <FileType className="h-3.5 w-3.5" /> Text is read from the PDF’s own text layer. Nothing is uploaded.
        </p>
      )}
    </div>
  );
}
