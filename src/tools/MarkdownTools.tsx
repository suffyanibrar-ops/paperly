import { Check, Copy, Download, FileCode2, FileText, Sparkles, UploadCloud, Wand2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
  PDFDocument,
  StandardFonts,
  baseName,
  downloadBytes,
  formatBytes,
  hexToRgb,
  parseRanges,
  safePdfText,
  sanitizeName,
  uniqueInOrder,
  wrapText,
  type PDFFont,
} from "@/lib/pdf";
import { detectColumns, extractDocument } from "@/lib/extract";
import { useInitialFiles, usePdfFile } from "@/lib/usePdf";
import { copyText } from "@/lib/router";
import { LIMITS, friendlyProcessingError, validateUpload } from "@/lib/security";
import {
  Alert,
  Button,
  Field,
  Progress,
  Segmented,
  Select,
  Switch,
  inputClass,
} from "@/components/ui";
import { DownloadPanel, RangeField, SinglePdfInput } from "@/components/toolParts";
import { paperDimensions, type PaperKey } from "@/lib/layout";
import { cn } from "@/utils/cn";

/* ================================================================== *
 * MARKDOWN PARSING
 * ================================================================== */
interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  link?: boolean;
}

type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4; runs: Run[] }
  | { type: "paragraph"; runs: Run[] }
  | { type: "list"; ordered: boolean; start: number; items: { depth: number; runs: Run[] }[] }
  | { type: "code"; text: string }
  | { type: "quote"; runs: Run[] }
  | { type: "table"; rows: string[][] }
  | { type: "hr" }
  | { type: "pagebreak" };

function parseInline(source: string): Run[] {
  const text = source.replace(/<[^>]+>/g, "");
  const runs: Run[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) runs.push({ text: buffer });
    buffer = "";
  };
  for (let i = 0; i < text.length; ) {
    const rest = text.slice(i);
    const link = rest.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (link) {
      flush();
      runs.push({ text: link[1], link: true, italic: false });
      i += link[0].length;
      continue;
    }
    if (rest.startsWith("**") || rest.startsWith("__")) {
      const marker = rest.slice(0, 2);
      const end = text.indexOf(marker, i + 2);
      if (end > i) {
        flush();
        runs.push({ text: text.slice(i + 2, end), bold: true });
        i = end + 2;
        continue;
      }
    }
    if (rest.startsWith("~~")) {
      const end = text.indexOf("~~", i + 2);
      if (end > i) {
        flush();
        runs.push({ text: text.slice(i + 2, end), strike: true });
        i = end + 2;
        continue;
      }
    }
    if (rest.startsWith("*") || rest.startsWith("_")) {
      const marker = rest[0];
      const end = text.indexOf(marker, i + 1);
      if (end > i + 1) {
        flush();
        runs.push({ text: text.slice(i + 1, end), italic: true });
        i = end + 1;
        continue;
      }
    }
    if (rest.startsWith("`")) {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        flush();
        runs.push({ text: text.slice(i + 1, end), code: true });
        i = end + 1;
        continue;
      }
    }
    buffer += text[i];
    i++;
  }
  flush();
  return runs.length ? runs : [{ text: "" }];
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }
    if (/^\s*\\newpage\s*$/i.test(line) || /^\s*<!--\s*pagebreak\s*-->\s*$/i.test(line)) {
      blocks.push({ type: "pagebreak" });
      index++;
      continue;
    }
    if (/^```/.test(line.trim())) {
      const language = line.trim().slice(3).trim();
      const body: string[] = [];
      index++;
      while (index < lines.length && !/^```/.test(lines[index].trim())) body.push(lines[index++]);
      index++;
      blocks.push({ type: "code", text: (language ? `${language}\n` : "") + body.join("\n") });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      index++;
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length as 1 | 2 | 3 | 4, runs: parseInline(heading[2].trim()) });
      index++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ""));
      blocks.push({ type: "quote", runs: parseInline(quote.join(" ")) });
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const startMatch = line.match(/^\s*(\d+)[.)]/);
      const items: { depth: number; runs: Run[] }[] = [];
      while (index < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[index])) {
        const current = lines[index];
        const indent = current.match(/^\s*/)?.[0].length ?? 0;
        items.push({
          depth: Math.min(2, Math.floor(indent / 2)),
          runs: parseInline(current.replace(/^\s*([-*+]|\d+[.)])\s+/, "")),
        });
        index++;
      }
      blocks.push({ type: "list", ordered, start: startMatch ? Number(startMatch[1]) : 1, items });
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[index + 1])) {
      const rows: string[][] = [splitRow(line)];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(splitRow(lines[index]));
        index++;
      }
      blocks.push({ type: "table", rows });
      continue;
    }
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{1,4}\s|```|>\s?|\s*([-*+]|\d+[.)])\s+)/.test(lines[index]) &&
      !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[index])
    ) {
      paragraph.push(lines[index++]);
    }
    blocks.push({ type: "paragraph", runs: parseInline(paragraph.join(" ")) });
  }
  return blocks;
}

/* ================================================================== *
 * MARKDOWN → PDF
 * ================================================================== */
type Family = "Helvetica" | "Times" | "Courier";

const BUILT_IN_TEMPLATES: { id: string; name: string; description: string; markdown: string }[] = [
  {
    id: "blank",
    name: "Blank",
    description: "Start from scratch",
    markdown: "# Untitled document\n\nStart writing here. Use **Markdown** for headings, lists, tables and emphasis.\n",
  },
  {
    id: "report",
    name: "Project report",
    description: "Title page, summary, tables",
    markdown: `# Quarterly Delivery Report

**Prepared by:** Alex Morgan  
**Date:** March 2026

## Executive summary

This report summarises delivery across the quarter, the risks we closed and the work that carries into the next period. The programme shipped **on schedule** and within budget.

> A calm, factual summary helps decision-makers read the detail later.

## Highlights

- Delivered 12 of 12 planned workstreams
- Reduced processing time by 38%
- Closed all high-severity incidents within SLA
- Migrated 100% of documents to the new pipeline

## Metrics

| Metric | Target | Actual |
| --- | --- | --- |
| Workstreams delivered | 12 | 12 |
| Processing time | 40 min | 25 min |
| Security findings closed | 90% | 100% |

## Next steps

1. Complete the archive migration
2. Validate the rollback plan
3. Prepare the next-quarter plan

\\newpage

## Appendix

Supporting detail belongs on a fresh page. Keep paragraphs short, prefer active voice, and put every number in a table when comparing values.
`,
  },
  {
    id: "letter",
    name: "Formal letter",
    description: "Clean business correspondence",
    markdown: `# Morgan & Co.

12 Harbour Lane · Bristol BS1 4QA  
hello@morgan.example · +44 117 000 0000

\\newpage

Dear Ms Alvarez,

## Re: Document handling review

Thank you for inviting us to review your document workflows. We have examined the current process and identified three practical improvements.

1. Reduce unnecessary file transfers between systems.
2. Convert documents to PDF at the point of origin.
3. Retire the legacy archive by the end of the year.

The savings are likely to be significant, and the change can be delivered without interrupting day-to-day operations.

Yours sincerely,

**Alex Morgan**  
Director, Morgan & Co.
`,
  },
  {
    id: "notes",
    name: "Meeting notes",
    description: "Agenda, decisions, owners",
    markdown: `# Weekly delivery meeting

**When:** Thursday, 14:00  
**Where:** Room 4 / video call  
**Present:** Alex, Priya, Sam, Jordan

## Agenda

1. Delivery status
2. Open risks
3. Actions and owners

## Decisions

- Ship the document pipeline on **Thursday 21st**.
- Keep the legacy workflow available for one extra week.
- Move the review to 15:00 next week.

## Actions

| Action | Owner | Due |
| --- | --- | --- |
| Publish release notes | Priya | Thu |
| Verify backups | Sam | Wed |
| Update support guide | Jordan | Fri |

## Notes

The team agreed that further scope changes wait until after the launch. Risks are reviewed weekly.
`,
  },
];

export interface RenderedPdf {
  bytes: Uint8Array;
  pages: number;
  words: number;
}

export async function renderMarkdownToPdf(
  source: string,
  opts: {
    plainText: boolean;
    paper: PaperKey;
    orientation: "portrait" | "landscape";
    margin: number;
    size: number;
    lineHeight: number;
    family: Family;
    pageNumbers: boolean;
    accent: string;
  },
): Promise<RenderedPdf> {
  const blocks: Block[] = opts.plainText
    ? source.replace(/\r\n?/g, "\n").split("\n").map((line) => (line.trim() ? { type: "paragraph", runs: [{ text: line }] } : { type: "paragraph", runs: [{ text: "" }] }))
    : parseMarkdown(source);

  const dims = paperDimensions(opts.paper, opts.orientation);
  const doc = await PDFDocument.create();
  const familyMap: Record<Family, { regular: StandardFonts; bold: StandardFonts; italic: StandardFonts; boldItalic: StandardFonts }> = {
    Helvetica: { regular: StandardFonts.Helvetica, bold: StandardFonts.HelveticaBold, italic: StandardFonts.HelveticaOblique, boldItalic: StandardFonts.HelveticaBoldOblique },
    Times: { regular: StandardFonts.TimesRoman, bold: StandardFonts.TimesRomanBold, italic: StandardFonts.TimesRomanItalic, boldItalic: StandardFonts.TimesRomanBoldItalic },
    Courier: { regular: StandardFonts.Courier, bold: StandardFonts.CourierBold, italic: StandardFonts.CourierOblique, boldItalic: StandardFonts.CourierBoldOblique },
  };
  const family = familyMap[opts.family];
  const [regular, bold, italic, boldItalic, mono] = await Promise.all([
    doc.embedFont(family.regular),
    doc.embedFont(family.bold),
    doc.embedFont(family.italic),
    doc.embedFont(family.boldItalic),
    doc.embedFont(StandardFonts.Courier),
  ]);
  const fontFor = (run: Run): PDFFont => {
    if (run.code) return mono;
    if (run.bold && run.italic) return boldItalic;
    if (run.bold) return bold;
    if (run.italic) return italic;
    return regular;
  };
  const scale = opts.size / 11;
  const lineHeight = (size: number) => size * opts.lineHeight;
  const margin = opts.margin;
  const contentW = dims.w - margin * 2;
  let page: ReturnType<typeof doc.addPage> = doc.addPage([dims.w, dims.h]);
  let y = dims.h - margin;
  let pages = 1;
  let words = 0;

  const newPage = () => {
    page = doc.addPage([dims.w, dims.h]);
    y = dims.h - margin;
    pages++;
    return page;
  };
  const ensure = (height: number) => {
    if (y - height < margin) newPage();
  };

  /** Break inline runs into lines, preserving style per word. */
  const layoutRuns = (runs: Run[], maxWidth: number, size: number, indent = 0): { runs: Run[]; width: number }[] => {
    const words: Run[] = [];
    for (const run of runs) {
      const parts = run.text.split(/(\s+)/).filter((p) => p !== "");
      for (const part of parts) {
        if (/^\s+$/.test(part)) words.push({ text: " " });
        else words.push({ ...run, text: part });
      }
    }
    const lines: { runs: Run[]; width: number }[] = [];
    let current: Run[] = [];
    let width = 0;
    const push = () => {
      while (current.length && current[current.length - 1].text === " ") current.pop();
      lines.push({ runs: current, width });
      current = [];
      width = 0;
    };
    for (const word of words) {
      if (!word.text.trim()) {
        if (current.length) current.push({ text: " " });
        continue;
      }
      const wordWidth = fontFor(word).widthOfTextAtSize(safePdfText(word.text), size);
      if (width + wordWidth > maxWidth - indent && current.length) push();
      current.push({ ...word, text: safePdfText(word.text) });
      width += wordWidth;
    }
    if (current.length || !lines.length) push();
    return lines;
  };

  const drawLines = (
    lines: { runs: Run[]; width: number }[],
    optsLine: { size: number; indent?: number; color?: string; lead?: number; bullet?: (i: number) => string; strike?: boolean },
  ) => {
    lines.forEach((line, lineIndex) => {
      ensure(lineHeight(optsLine.size));
      const x = margin + (optsLine.indent ?? 0);
      if (optsLine.bullet && page) {
        const bullet = safePdfText(optsLine.bullet(lineIndex));
        if (bullet) {
          page.drawText(bullet, {
            x: margin + (optsLine.indent ?? 0) - 13,
            y: y - optsLine.size,
            size: optsLine.size,
            font: regular,
            color: hexToRgb("#4f7d67"),
          });
        }
      }
      let cursor = x;
      for (const run of line.runs) {
        if (!run.text) continue;
        const font = fontFor(run);
        page.drawText(run.text, {
          x: cursor,
          y: y - optsLine.size,
          size: optsLine.size,
          font,
          color: hexToRgb(run.link ? "#1c4c3b" : (optsLine.color ?? "#26312b")),
          opacity: 1,
        });
        const runWidth = font.widthOfTextAtSize(run.text, optsLine.size);
        if (run.link || run.strike) {
          page.drawLine({
            start: { x: cursor, y: y - optsLine.size - 1.5 },
            end: { x: cursor + runWidth, y: y - optsLine.size - 1.5 },
            thickness: 0.6,
            color: hexToRgb(run.link ? "#1c4c3b" : "#8b95a1"),
          });
        }
        cursor += runWidth;
      }
      y -= optsLine.lead ?? lineHeight(optsLine.size);
    });
  };

  for (const block of blocks) {
    if (block.type === "pagebreak") {
      newPage();
      continue;
    }
    if (block.type === "heading") {
      const headingSize = block.level === 1 ? 23 * scale : block.level === 2 ? 16.5 * scale : block.level === 3 ? 13 * scale : 11.6 * scale;
      const lines = layoutRuns(block.runs.map((r) => ({ ...r, bold: true })), contentW, headingSize);
      ensure(headingSize * 2 + lines.length * headingSize);
      if (block.level <= 2 && y < dims.h - margin - 4) y -= block.level === 1 ? 14 : 10;
      drawLines(lines, { size: headingSize, color: block.level <= 2 ? "#12211a" : "#1c4c3b", lead: headingSize * 1.28 });
      if (block.level === 1 && page) {
        page.drawLine({
          start: { x: margin, y: y + 5 },
          end: { x: margin + Math.min(contentW, 120), y: y + 5 },
          thickness: 2.4,
          color: hexToRgb(opts.accent),
        });
      }
      y -= block.level === 1 ? 12 : 7;
      continue;
    }
    if (block.type === "paragraph") {
      const isEmpty = block.runs.every((r) => !r.text.trim());
      if (isEmpty) {
        y -= lineHeight(opts.size) * 0.6;
        continue;
      }
      const lines = layoutRuns(block.runs, contentW, opts.size);
      words += block.runs.reduce((sum, r) => sum + r.text.split(/\s+/).filter(Boolean).length, 0);
      drawLines(lines, { size: opts.size });
      y -= opts.size * 0.55;
      continue;
    }
    if (block.type === "quote") {
      const lines = layoutRuns(block.runs.map((r) => ({ ...r, italic: true })), contentW - 18, opts.size);
      const top = y;
      drawLines(lines, { size: opts.size, indent: 18, color: "#4f5b53", lead: lineHeight(opts.size) * 1.05 });
      page.drawLine({
        start: { x: margin + 4, y: top + 2 },
        end: { x: margin + 4, y: y + 4 },
        thickness: 2,
        color: hexToRgb("#1c4c3b"),
        opacity: 0.45,
      });
      y -= opts.size * 0.5;
      continue;
    }
    if (block.type === "list") {
      const itemSize = opts.size;
      block.items.forEach((item, itemIndex) => {
        const indent = 14 + item.depth * 16;
        const marker = block.ordered ? `${block.start + itemIndex}.` : "•";
        const lines = layoutRuns(item.runs, contentW - indent, itemSize, indent);
        words += item.runs.reduce((sum, r) => sum + r.text.split(/\s+/).filter(Boolean).length, 0);
        drawLines(lines, {
          size: itemSize,
          indent,
          bullet: (lineIndex) => (lineIndex === 0 ? marker : ""),
          lead: lineHeight(itemSize) * 1.02,
        });
      });
      y -= opts.size * 0.45;
      continue;
    }
    if (block.type === "code") {
      const codeSize = Math.max(7.5, opts.size * 0.82);
      const lines = block.text.split("\n").flatMap((line) =>
        wrapText(line || " ", { font: mono, size: codeSize, color: "#24312a", maxWidth: contentW - 20 }).map((text) => ({ runs: [{ text, code: true }], width: 0 })),
      );
      const blockHeight = lines.length * lineHeight(codeSize) * 0.95 + 16;
      ensure(blockHeight);
      page.drawRectangle({
        x: margin,
        y: y - blockHeight + 4,
        width: contentW,
        height: blockHeight,
        color: hexToRgb("#f1eee4"),
        borderColor: hexToRgb("#e0dbcd"),
        borderWidth: 0.6,
      });
      y -= 6;
      drawLines(lines, { size: codeSize, indent: 10, lead: lineHeight(codeSize) * 0.95, color: "#24312a" });
      y -= 12;
      words += block.text.split(/\s+/).filter(Boolean).length;
      continue;
    }
    if (block.type === "hr") {
      ensure(14);
      page.drawLine({ start: { x: margin, y: y - 4 }, end: { x: margin + contentW, y: y - 4 }, thickness: 0.8, color: hexToRgb("#d9d4c6") });
      y -= 16;
      continue;
    }
    if (block.type === "table") {
      const cols = Math.max(...block.rows.map((r) => r.length), 1);
      const widths = Array.from({ length: cols }, (_, ci) => {
        const longest = Math.max(...block.rows.map((r) => (r[ci] ?? "").length), 4);
        return Math.min(240, Math.max(50, longest * opts.size * 0.5));
      });
      const total = widths.reduce((a, b) => a + b, 0) || 1;
      const scaleCols = widths.map((w) => (w / total) * contentW);
      const cellSize = Math.max(7.4, opts.size * 0.84);
      const pad = 5;
      const drawTableHeader = () => {
        const cells = block.rows[0] ?? [];
        const wrapped = cells.map((cell, ci) =>
          wrapText(cell || " ", { font: bold, size: cellSize, color: "#12211a", maxWidth: scaleCols[ci] - pad * 2 }),
        );
        const rowH = Math.max(...wrapped.map((w) => w.length), 1) * (cellSize + 3) + pad * 2;
        ensure(rowH + 8);
        const top = y;
        page.drawRectangle({ x: margin, y: top - rowH, width: contentW, height: rowH, color: hexToRgb("#e9e6da") });
        wrapped.forEach((lines, ci) => {
          const x = margin + scaleCols.slice(0, ci).reduce((a, b) => a + b, 0);
          lines.forEach((line, li) => {
            page.drawText(line, { x: x + pad, y: top - pad - cellSize - li * (cellSize + 3), size: cellSize, font: bold, color: hexToRgb("#12211a") });
          });
        });
        y -= rowH;
        return rowH;
      };
      drawTableHeader();
      for (let r = 1; r < block.rows.length; r++) {
        const cells = block.rows[r];
        const wrapped = Array.from({ length: cols }, (_, ci) =>
          wrapText(cells[ci] ?? " ", { font: regular, size: cellSize, color: "#26312b", maxWidth: scaleCols[ci] - pad * 2 }),
        );
        const rowH = Math.max(...wrapped.map((w) => w.length), 1) * (cellSize + 3) + pad * 2;
        if (y - rowH < margin + 6) {
          newPage();
          drawTableHeader();
        }
        const top = y;
        if (r % 2 === 0) {
          page.drawRectangle({ x: margin, y: top - rowH, width: contentW, height: rowH, color: hexToRgb("#f7f5ee") });
        }
        let x = margin;
        wrapped.forEach((lines, ci) => {
          page.drawRectangle({
            x,
            y: top - rowH,
            width: scaleCols[ci],
            height: rowH,
            borderColor: hexToRgb("#e0dbcd"),
            borderWidth: 0.5,
          });
          lines.forEach((line, li) => {
            page.drawText(line, { x: x + pad, y: top - pad - cellSize - li * (cellSize + 3), size: cellSize, font: regular, color: hexToRgb("#26312b") });
          });
          x += scaleCols[ci];
        });
        y -= rowH;
        words += cells.join(" ").split(/\s+/).filter(Boolean).length;
      }
      y -= 14;
      continue;
    }
  }

  if (opts.pageNumbers) {
    doc.getPages().forEach((p, index) => {
      const label = `${index + 1} / ${pages}`;
      const w = regular.widthOfTextAtSize(label, 8);
      p.drawText(label, {
        x: (dims.w - w) / 2,
        y: Math.max(14, margin / 2),
        size: 8,
        font: regular,
        color: hexToRgb("#8b918b"),
      });
    });
  }

  const bytes = await doc.save();
  return { bytes, pages: Math.max(pages, 1), words };
}

export function MarkdownToPdfTool() {
  const [markdown, setMarkdown] = useState(BUILT_IN_TEMPLATES[1].markdown);
  const [plainText, setPlainText] = useState(false);
  const [paper, setPaper] = useState<PaperKey>("a4");
  const [orientation, setOrientation] = useState<"portrait" | "landscape">("portrait");
  const [margin, setMargin] = useState(56);
  const [size, setSize] = useState(11);
  const [lineHeight, setLineHeight] = useState(1.5);
  const [family, setFamily] = useState<Family>("Helvetica");
  const [pageNumbers, setPageNumbers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; pages: number; words: number; name: string } | null>(null);

  const stats = useMemo(() => {
    const trimmed = markdown.trim();
    const words = trimmed ? trimmed.split(/\s+/).length : 0;
    return { words, chars: markdown.length, minutes: Math.max(1, Math.round(words / 220)) };
  }, [markdown]);

  const convert = async () => {
    setError("");
    setResult(null);
    if (!markdown.trim()) {
      setError("Write something first — or choose a template.");
      return;
    }
    setBusy(true);
    try {
      const rendered = await renderMarkdownToPdf(markdown, {
        plainText,
        paper,
        orientation,
        margin,
        size,
        lineHeight,
        family,
        pageNumbers,
        accent: "#d9f26c",
      });
      setResult({
        ...rendered,
        name: `${sanitizeName((markdown.match(/^#\s+(.+)$/m)?.[1] ?? "paperly-document").slice(0, 60))}.pdf`,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-ink/75">
          <Sparkles className="h-3 w-3" /> Templates
        </span>
        {BUILT_IN_TEMPLATES.map((template) => (
          <button
            key={template.id}
            type="button"
            onClick={() => {
              setMarkdown(template.markdown);
              setPlainText(false);
              setResult(null);
            }}
            title={template.description}
            className="rounded-full border border-line bg-paper px-3 py-1.5 text-[11.5px] font-medium text-ink/75 transition-colors hover:border-forest/35 hover:text-forest"
          >
            {template.name}
          </button>
        ))}
        <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-forest/20 bg-lime/25 px-3 py-1.5 text-[11.5px] font-medium text-forest transition-colors hover:bg-lime/40">
          <UploadCloud className="h-3 w-3" /> Import .md / .txt
          <input
            type="file"
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            className="sr-only"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              try {
                await validateUpload(file, ".md,.markdown,.txt,text/markdown,text/plain");
                const content = await file.text();
                setMarkdown(content.slice(0, LIMITS.htmlChars));
                setPlainText(/\.txt$/i.test(file.name));
                setError("");
                setResult(null);
              } catch (err) {
                setError(friendlyProcessingError(err, "That file couldn’t be imported."));
              }
            }}
          />
        </label>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label htmlFor="md-source" className="text-[12px] font-semibold uppercase tracking-[0.06em] text-ink/70">
              {plainText ? "Plain text" : "Markdown"}
            </label>
            <span className="text-[11px] text-muted">
              {stats.words.toLocaleString()} words · {stats.chars.toLocaleString()} chars · ≈ {stats.minutes} min read
            </span>
          </div>
          <textarea
            id="md-source"
            value={markdown}
            onChange={(e) => {
              setMarkdown(e.target.value);
              setResult(null);
            }}
            spellCheck
            className="h-[420px] w-full resize-y rounded-xl border border-line bg-paper px-4 py-3 font-mono text-[12.5px] leading-relaxed text-ink focus:border-forest/40 focus:outline-none focus:ring-2 focus:ring-forest/10"
            placeholder="# Your title&#10;&#10;Write **Markdown** here…"
          />
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-muted">
            Supports headings, <strong>bold</strong>, <em>italic</em>, inline code, code blocks, lists, quotes, tables, links and <code>\\newpage</code>.
            Drag the corner to resize.
          </p>
        </div>

        <aside className="space-y-3">
          <div className="rounded-xl border border-line bg-paper p-3.5">
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">Page setup</p>
            <div className="space-y-3">
              <Field label="Page size">
                <Select value={paper} onChange={(e) => setPaper(e.target.value as PaperKey)}>
                  <option value="a4">A4</option>
                  <option value="letter">US Letter</option>
                  <option value="legal">US Legal</option>
                  <option value="a5">A5</option>
                  <option value="a3">A3</option>
                </Select>
              </Field>
              <Field label="Orientation">
                <Segmented
                  value={orientation}
                  onChange={setOrientation}
                  size="sm"
                  options={[
                    { value: "portrait", label: "Portrait" },
                    { value: "landscape", label: "Landscape" },
                  ]}
                />
              </Field>
              <Field label="Typeface">
                <Select value={family} onChange={(e) => setFamily(e.target.value as Family)}>
                  <option value="Helvetica">Modern sans (Helvetica)</option>
                  <option value="Times">Classic serif (Times)</option>
                  <option value="Courier">Monospace (Courier)</option>
                </Select>
              </Field>
              <Field label="Margins" hint={`${Math.round((margin / 72) * 25.4)} mm`}>
                <input type="range" min={28} max={100} value={margin} aria-label="Page margin" onChange={(e) => setMargin(Number(e.target.value))} className="w-full accent-[#1c4c3b]" />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Font size">
                  <input type="number" min={7} max={20} step={0.5} value={size} aria-label="Font size in points" onChange={(e) => setSize(Math.max(7, Math.min(20, Number(e.target.value) || 11)))} className={cn(inputClass, "h-9 tabular-nums")} />
                </Field>
                <Field label="Line height">
                  <input type="number" min={1.1} max={2.4} step={0.05} value={lineHeight} aria-label="Line height multiplier" onChange={(e) => setLineHeight(Math.max(1.1, Math.min(2.4, Number(e.target.value) || 1.5)))} className={cn(inputClass, "h-9 tabular-nums")} />
                </Field>
              </div>
              <Switch checked={pageNumbers} onChange={setPageNumbers} label="Page numbers" />
              <Switch checked={plainText} onChange={(v) => { setPlainText(v); setResult(null); }} label="Treat as plain text" description="Don’t parse Markdown syntax" />
            </div>
          </div>
        </aside>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Button onClick={convert} loading={busy}>
          <FileText className="h-4 w-4" /> Create PDF
        </Button>
        <span className="text-[11.5px] text-muted">
          {stats.words.toLocaleString()} words · generated locally, no reflow surprises
        </span>
      </div>
      {busy && <Progress label="Laying out your document…" />}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Your document is ready"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${result.pages} page${result.pages === 1 ? "" : "s"} · ${formatBytes(result.bytes.byteLength)} · ${result.words.toLocaleString()} words typeset`}
        />
      )}
    </div>
  );
}

function splitCells(items: { str: string; x: number; width: number }[], columns: number[]): string[] {
  const cells = new Array(Math.max(columns.length, 1)).fill("") as string[];
  for (const item of items) {
    let column = 0;
    columns.forEach((edge, index) => {
      if (item.x + 2 >= edge) column = index;
    });
    cells[column] = `${cells[column]} ${item.str}`.trim();
  }
  return cells;
}

/* ================================================================== *
 * PDF → MARKDOWN
 * ================================================================== */
function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+.!|>-])/g, "\\$1").replace(/\\\./g, ".");
}

function isBullet(text: string) {
  return /^[•·▪◦‣●○–—]\s+/.test(text.trim());
}

function isNumbered(text: string) {
  return /^\d{1,2}[.)]\s+/.test(text.trim());
}

export function PdfToMarkdownTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [range, setRange] = useState("");
  const [detectTables, setDetectTables] = useState(true);
  const [pageMarkers, setPageMarkers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [copied, setCopied] = useState(false);
  const [stats, setStats] = useState<{ headings: number; tables: number; lists: number } | null>(null);

  const convert = async () => {
    if (!pdf.bytes || !pdf.file) return;
    setBusy(true);
    setError("");
    setMarkdown("");
    setStats(null);
    try {
      const pages = uniqueInOrder(parseRanges(range, pdf.pageCount));
      const extracted = await extractDocument(pdf.bytes, {
        pages,
        onProgress: (done, total) => setProgress((done / total) * 100),
      });
      if (!extracted.text.trim()) throw new Error("No text layer found. Scanned PDFs need OCR before they can become Markdown.");

      let headings = 0;
      let tables = 0;
      let lists = 0;
      const output: string[] = [];
      if (pdf.file) {
        output.push("---");
        output.push(`title: "${baseName(pdf.file.name).replace(/"/g, "'")}"`);
        output.push(`pages: ${extracted.pages.length}`);
        output.push(`converted: ${new Date().toISOString().slice(0, 10)}`);
        output.push("generator: Paperly");
        output.push("---\n");
      }

      extracted.pages.forEach((page) => {
        if (pageMarkers) output.push(`\n<!-- Page ${page.page} -->\n`);
        const heights = page.lines.map((l) => l.height).filter((h) => h > 0).sort((a, b) => a - b);
        const median = heights.length ? heights[Math.floor(heights.length / 2)] : 10;
        let lastWasList = false;
        let tableBuffer: string[][] = [];

        const flushTable = () => {
          if (tableBuffer.length >= 2 && tableBuffer[0].length >= 2) {
            const columns = Math.max(...tableBuffer.map((r) => r.length));
            const rows = tableBuffer.map((r) => Array.from({ length: columns }, (_, i) => (r[i] ?? "").replace(/\|/g, "\\|")));
            output.push(`| ${rows[0].join(" | ")} |`);
            output.push(`| ${rows[0].map(() => "---").join(" | ")} |`);
            rows.slice(1).forEach((row) => output.push(`| ${row.join(" | ")} |`));
            output.push("");
            tables++;
            lastWasList = false;
          } else if (tableBuffer.length) {
            tableBuffer.forEach((row) => output.push(row.filter(Boolean).join(" ")));
            output.push("");
          }
          tableBuffer = [];
        };

        page.lines.forEach((line, lineIndex) => {
          const text = line.text.trim();
          if (!text) return;

          if (detectTables) {
            const columns = detectColumns(page.lines);
            const cells = splitCells(line.items, columns);
            if (columns.length >= 2 && cells.filter(Boolean).length >= 2 && !isBullet(text) && !isNumbered(text)) {
              tableBuffer.push(cells);
              return;
            }
            if (tableBuffer.length) flushTable();
          }

          const big = line.height > median * 1.35;
          const huge = line.height > median * 1.75;
          const shortCaps = text.length < 80 && lineIndex < 6 && /^[A-Z0-9][A-Z0-9\s&:,.'()-]+$/.test(text) && /[A-Z]{3}/.test(text);

          if (big || shortCaps) {
            const level = huge || lineIndex === 0 ? 1 : 2;
            output.push(`${"#".repeat(level)} ${escapeMarkdown(text)}`);
            output.push("");
            headings++;
            lastWasList = false;
            return;
          }
          if (isBullet(text)) {
            output.push(`- ${escapeMarkdown(text.replace(/^[•·▪◦‣●○–—]\s+/, ""))}`);
            lists++;
            lastWasList = true;
            return;
          }
          if (isNumbered(text)) {
            output.push(text.replace(/^(\d{1,2})([.)])\s+/, "$1. "));
            lists++;
            lastWasList = true;
            return;
          }
          if (lastWasList) {
            output.push("");
            lastWasList = false;
          }
          output.push(escapeMarkdown(text));
          if (/[.!?:]["']?$/.test(text) && text.length < 140) output.push("");
        });
        if (tableBuffer.length) flushTable();
        output.push("");
      });

      setMarkdown(output.join("\n").replace(/\n{4,}/g, "\n\n\n").trim());
      setStats({ headings, tables, lists });
      setProgress(100);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    if (!markdown) return;
    downloadBytes(
      new Uint8Array(new TextEncoder().encode(markdown)),
      `${sanitizeName(baseName(pdf.file?.name ?? "document"))}.md`,
      "text/markdown",
    );
  };

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A text-based PDF" />
      {pdf.bytes && (
        <>
          <RangeField value={range} onChange={setRange} total={pdf.pageCount} label="Pages to convert" hint="Leave empty for all pages." />
          <div className="grid gap-2 sm:grid-cols-2">
            <Switch checked={detectTables} onChange={setDetectTables} label="Detect tables" description="Rebuild simple tables as Markdown tables" />
            <Switch checked={pageMarkers} onChange={setPageMarkers} label="Page markers" description="Add an HTML comment at each page start" />
          </div>
          {error && <Alert tone="error">{error}</Alert>}
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={convert} loading={busy}>
              <FileCode2 className="h-4 w-4" /> Convert to Markdown
            </Button>
            <span className="text-[11.5px] text-muted">Headings, lists and tables are inferred from the text layer.</span>
          </div>
          {busy && <Progress value={progress} label="Reading and structuring the document…" />}
        </>
      )}

      {markdown && (
        <>
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: "Headings", value: stats?.headings ?? 0 },
              { label: "Tables", value: stats?.tables ?? 0 },
              { label: "List items", value: stats?.lists ?? 0 },
            ].map((item) => (
              <div key={item.label} className="rounded-xl border border-line bg-paper px-3 py-2.5">
                <p className="text-[18px] font-semibold leading-none text-forest">{item.value}</p>
                <p className="mt-1 text-[10.5px] uppercase tracking-[0.07em] text-ink/75">{item.label}</p>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/75">Markdown output</p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  setCopied(await copyText(markdown));
                  setTimeout(() => setCopied(false), 1600);
                }}
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy"}
              </Button>
              <Button variant="outline" size="sm" onClick={download}>
                <Download className="h-3.5 w-3.5" /> .md
              </Button>
            </div>
          </div>
          <textarea
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            rows={14}
            spellCheck={false}
            className="w-full rounded-xl border border-line bg-paper px-3.5 py-2.5 font-mono text-[12px] leading-relaxed"
          />
          <p className="flex items-center gap-1.5 text-[11px] text-muted">
            <Wand2 className="h-3.5 w-3.5 text-forest" /> The output is editable — tune headings and table cells before you download.
          </p>
        </>
      )}

      {!pdf.bytes && (
        <div className="rounded-xl border border-dashed border-line bg-bone-deep/25 px-5 py-8 text-center">
          <FileCode2 className="mx-auto h-6 w-6 text-ink/70" />
          <p className="mt-2 text-[12.5px] font-medium">Markdown, ready for your docs or AI tools</p>
          <p className="mx-auto mt-1 max-w-md text-[11.5px] leading-relaxed text-muted">
            Add a text-based PDF to get structured Markdown with a YAML header, headings, lists and tables. Nothing is uploaded.
          </p>
        </div>
      )}
    </div>
  );
}
