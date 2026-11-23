import { AlertTriangle, FileCode2, FileText, Image as ImageIcon, ListTree, Pencil, Sparkles, UploadCloud, Wand2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  PDFDocument,
  StandardFonts,
  baseName,
  downloadBytes,
  formatBytes,
  hexToRgb,
  openPdfJs,
  openPdfLib,
  parseRanges,
  safePdfText,
  sanitizeName,
  uniqueInOrder,
  wrapText,
  type PDFDocument as PDFDocumentType,
  type PDFFont,
} from "@/lib/pdf";
import { PDFDict, PDFName, PDFRawStream, PDFRef } from "@cantoo/pdf-lib";
import { detectColumns, extractPage, type ExtractedPage } from "@/lib/extract";
import { useInitialFiles, usePdfFile } from "@/lib/usePdf";
import { LIMITS, friendlyProcessingError, validateUpload } from "@/lib/security";
import { Alert, Button, Field, Progress, Segmented, Select, Switch, inputClass } from "@/components/ui";
import { DownloadPanel, RangeField, SinglePdfInput } from "@/components/toolParts";
import { AdvancedOptions, OptionNote, OptionsGrid, PresetChips } from "@/components/AdvancedOptions";
import { paperDimensions, type PaperKey } from "@/lib/layout";
import { cn } from "@/utils/cn";
import { useToolPreferences } from "@/lib/prefs";
import { JobCancelledError, describeJobTime, useJob } from "@/lib/job";
import { useDownloadShortcut, usePrimaryShortcut } from "@/lib/hotkeys";
import { downloadOutput } from "@/lib/output";

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
  /** Superscript, used for footnote references. */
  sup?: boolean;
  /** Syntax tone for a highlighted code token. */
  tone?: "keyword" | "string" | "comment" | "number";
}

type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4; runs: Run[] }
  | { type: "paragraph"; runs: Run[] }
  | { type: "list"; ordered: boolean; start: number; items: { depth: number; runs: Run[] }[] }
  | { type: "code"; text: string; language: string }
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
    const footnote = rest.match(/^\[\^([^\]]+)\]/);
    if (footnote) {
      flush();
      runs.push({ text: footnote[1], sup: true });
      i += footnote[0].length;
      continue;
    }
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
      const language = line.trim().slice(3).trim().toLowerCase();
      const body: string[] = [];
      index++;
      while (index < lines.length && !/^```/.test(lines[index].trim())) body.push(lines[index++]);
      index++;
      blocks.push({ type: "code", text: body.join("\n"), language });
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

function plainTextBlocks(source: string): Block[] {
  return source
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => ({ type: "paragraph" as const, runs: [{ text: line }] }));
}

/* ------------------------------------------------------------------ *
 * Frontmatter + footnotes
 * ------------------------------------------------------------------ */
export interface Frontmatter {
  title: string;
  author: string;
  date: string;
}

const EMPTY_FRONTMATTER: Frontmatter = { title: "", author: "", date: "" };

/** Split a leading YAML frontmatter block from the body. Never throws. */
export function splitFrontmatter(source: string): { meta: Frontmatter; body: string; present: boolean } {
  const text = source.replace(/^\uFEFF/, "");
  const match = text.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!match) return { meta: { ...EMPTY_FRONTMATTER }, body: source, present: false };
  const meta = { ...EMPTY_FRONTMATTER };
  for (const line of match[1].split("\n")) {
    const pair = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!pair) continue;
    const key = pair[1].toLowerCase();
    const value = pair[2].trim().replace(/^["']/, "").replace(/["']$/, "");
    if (key === "title" || key === "author" || key === "date") meta[key] = value;
  }
  return { meta, body: text.slice(match[0].length), present: true };
}

/** Write (or update) the three frontmatter fields in a Markdown document. */
export function upsertFrontmatter(source: string, meta: Frontmatter): string {
  const current = splitFrontmatter(source);
  const entries = (["title", "author", "date"] as const)
    .map((key) => ({ key, value: meta[key].trim() }))
    .filter((entry) => entry.value.length > 0);
  if (!entries.length) return current.present ? current.body.replace(/^\n+/, "") : source;
  const block = ["---", ...entries.map(({ key, value }) => `${key}: "${value.replace(/"/g, "'")}"`), "---", ""].join("\n");
  return `${block}${current.present ? current.body.replace(/^\n+/, "") : `\n${current.body}`}`;
}

interface Footnote {
  id: string;
  text: string;
}

/** Pull `[^id]: text` definitions out of the body and return the cleaned body. */
function extractFootnotes(source: string): { notes: Footnote[]; body: string } {
  const notes: Footnote[] = [];
  const kept: string[] = [];
  for (const line of source.replace(/\r\n?/g, "\n").split("\n")) {
    const definition = line.match(/^\s*\[\^([^\]]+)\]:\s*(.*)$/);
    if (definition) {
      notes.push({ id: definition[1], text: definition[2].trim() });
      continue;
    }
    kept.push(line);
  }
  return { notes, body: kept.join("\n") };
}

/* ------------------------------------------------------------------ *
 * Code highlighting
 * ------------------------------------------------------------------ */
const CODE_KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue",
  "class", "extends", "new", "this", "import", "from", "export", "default", "async", "await", "try", "catch", "finally",
  "throw", "typeof", "instanceof", "in", "of", "null", "undefined", "true", "false", "interface", "type", "enum", "implements",
  "public", "private", "protected", "readonly", "static", "void", "yield", "delete", "super", "as", "def", "elif", "None",
  "True", "False", "and", "or", "not", "lambda", "pass", "raise", "with", "select", "insert", "update", "delete", "where",
]);
const HASH_COMMENT_LANGUAGES = new Set(["py", "python", "sh", "bash", "shell", "yaml", "yml", "toml", "rb", "ruby", "ps1", "makefile"]);
const SLASH_COMMENT_LANGUAGES = new Set(["js", "jsx", "ts", "tsx", "javascript", "typescript", "c", "cpp", "cc", "h", "cs", "java", "go", "rust", "rs", "swift", "kt", "kotlin", "php", "scss", "less", "css", "json5"]);
const HIGHLIGHT_LANGUAGES = new Set([...HASH_COMMENT_LANGUAGES, ...SLASH_COMMENT_LANGUAGES]);

function highlightLine(line: string, language: string): Run[] {
  if (!HIGHLIGHT_LANGUAGES.has(language)) return [{ text: line || " " }];
  if (!line) return [{ text: " " }];
  const hashComments = HASH_COMMENT_LANGUAGES.has(language);
  const slashComments = SLASH_COMMENT_LANGUAGES.has(language);
  const tokenPattern = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/[^\n]*|#[^\n]*)|(\b\d[\d._a-fA-F]*\b)|([A-Za-z_$][\w$]*)|([\s\S])/g;
  const runs: Run[] = [];
  let match: RegExpExecArray | null;
  const push = (text: string, tone?: Run["tone"]) => {
    if (!text) return;
    const previous = runs[runs.length - 1];
    if (previous && previous.tone === tone) {
      previous.text += text;
      return;
    }
    runs.push({ text, tone });
  };
  while ((match = tokenPattern.exec(line)) !== null) {
    const token = match[0];
    if (match[1]) {
      push(token, "string");
      continue;
    }
    if (match[2]) {
      const isHash = token.startsWith("#");
      push(token, (isHash ? hashComments : slashComments) ? "comment" : undefined);
      continue;
    }
    if (match[3]) {
      push(token, "number");
      continue;
    }
    if (match[4]) {
      push(token, CODE_KEYWORDS.has(match[4]) ? "keyword" : undefined);
      continue;
    }
    push(token, undefined);
  }
  return runs.length ? runs : [{ text: line }];
}

const CODE_TONE_COLOR: Record<NonNullable<Run["tone"]>, string> = {
  keyword: "#7a3e9d",
  string: "#1f6b45",
  comment: "#8b918b",
  number: "#a05a2c",
};

/* ================================================================== *
 * MARKDOWN → PDF
 * ================================================================== */
type Family = "Helvetica" | "Times" | "Courier";

export interface MarkdownTheme {
  id: "serif" | "modern" | "compact";
  label: string;
  description: string;
  family: Family;
  size: number;
  lineHeight: number;
}

export const MARKDOWN_THEMES: MarkdownTheme[] = [
  {
    id: "serif",
    label: "Serif",
    description: "Times body text, generous leading — the classic report look.",
    family: "Times",
    size: 11.5,
    lineHeight: 1.55,
  },
  {
    id: "modern",
    label: "Modern",
    description: "Clean Helvetica at 11 pt — the everyday default for notes and decks.",
    family: "Helvetica",
    size: 11,
    lineHeight: 1.5,
  },
  {
    id: "compact",
    label: "Compact",
    description: "10 pt with tight leading — fits the most on each page.",
    family: "Helvetica",
    size: 10,
    lineHeight: 1.32,
  },
];

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
    markdown: `---
title: "Quarterly Delivery Report"
author: "Alex Morgan"
date: "March 2026"
---

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
    markdown: `---
title: "Morgan & Co."
date: "March 2026"
---

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
    markdown: `---
title: "Weekly delivery meeting"
date: "Thursday, 14:00"
---

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
  /** Number of headings typeset (and listed in a table of contents). */
  headings?: number;
  /** Frontmatter title, when the source declared one. */
  title?: string;
}

interface HeadingRef {
  title: string;
  level: number;
  page: number;
}

interface MarkdownRenderOptions {
  plainText: boolean;
  paper: PaperKey;
  orientation: "portrait" | "landscape";
  margin: number;
  size: number;
  lineHeight: number;
  family: Family;
  pageNumbers: boolean;
  accent: string;
  /** A deliberate title page built from the frontmatter. */
  titlePage?: boolean;
  /** Insert a generated table of contents after the title page. */
  toc?: boolean;
  /** Colourise code blocks for common languages. */
  codeHighlight?: boolean;
  /** Render `[^1]` references and a footnotes section. */
  footnotes?: boolean;
  /** Progress for the typesetting pass. */
  onProgress?: (done: number, total: number) => void;
  /** Cooperative cancellation, checked between blocks. */
  isCancelled?: () => boolean;
}

interface PassExtras {
  meta: Frontmatter;
  notes: Footnote[];
  tocEntries: HeadingRef[] | null;
}

function firstHeading(blocks: Block[]): string {
  for (const block of blocks) {
    if (block.type === "heading") {
      const text = block.runs.map((run) => run.text).join("").trim();
      if (text) return text;
    }
  }
  return "";
}

/** Usable pages the contents page needs; the renderer uses the same metrics. */
function estimateTocPages(count: number, opts: MarkdownRenderOptions): number {
  if (count < 1) return 0;
  const dims = paperDimensions(opts.paper, opts.orientation);
  const usable = dims.h - opts.margin * 2;
  const line = Math.max(9, opts.size * 0.92) * 1.75;
  const heading = opts.size * 2.4;
  const perPage = Math.max(1, Math.floor((usable - heading) / line));
  return Math.max(1, Math.ceil(count / perPage));
}

async function renderPass(
  blocks: Block[],
  opts: MarkdownRenderOptions,
  extras: PassExtras,
): Promise<{ doc: PDFDocumentType; pages: number; words: number; headings: HeadingRef[] }> {
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
  const headings: HeadingRef[] = [];

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
      const wordSize = word.sup ? size * 0.7 : size;
      const wordWidth = fontFor(word).widthOfTextAtSize(safePdfText(word.text), wordSize);
      if (width + wordWidth > maxWidth - indent && current.length) push();
      current.push({ ...word, text: safePdfText(word.text) });
      width += wordWidth;
    }
    if (current.length || !lines.length) push();
    return lines;
  };

  const drawLines = (
    lines: { runs: Run[]; width: number }[],
    optsLine: {
      size: number;
      indent?: number;
      color?: string;
      lead?: number;
      bullet?: (i: number) => string;
    },
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
        const runSize = run.sup ? optsLine.size * 0.7 : optsLine.size;
        const baseY = y - optsLine.size;
        if (run.sup) {
          page.drawText(run.text, {
            x: cursor,
            y: baseY + optsLine.size * 0.36,
            size: runSize,
            font,
            color: hexToRgb("#1c4c3b"),
          });
        } else {
          page.drawText(run.text, {
            x: cursor,
            y: baseY,
            size: runSize,
            font,
            color: hexToRgb(run.tone ? CODE_TONE_COLOR[run.tone] : run.link ? "#1c4c3b" : (optsLine.color ?? "#26312b")),
            opacity: 1,
          });
        }
        const runWidth = font.widthOfTextAtSize(run.text, runSize);
        if (run.link || run.strike) {
          page.drawLine({
            start: { x: cursor, y: baseY - 1.5 },
            end: { x: cursor + runWidth, y: baseY - 1.5 },
            thickness: 0.6,
            color: hexToRgb(run.link ? "#1c4c3b" : "#8b95a1"),
          });
        }
        cursor += runWidth;
      }
      y -= optsLine.lead ?? lineHeight(optsLine.size);
    });
  };

  /* --------------------------- title page --------------------------- */
  if (opts.titlePage) {
    const title = extras.meta.title.trim() || firstHeading(blocks) || "";
    if (title) {
      const titleSize = 27 * scale;
      const titleLines = layoutRuns([{ text: title, bold: true }], contentW, titleSize);
      const blockHeight = titleLines.length * titleSize * 1.28 + 70;
      y = dims.h * 0.62;
      ensure(blockHeight);
      const top = y;
      page.drawRectangle({ x: margin, y: top - 4, width: 72, height: 4.5, color: hexToRgb(opts.accent) });
      y = top - 20;
      drawLines(titleLines, { size: titleSize, color: "#12211a", lead: titleSize * 1.28 });
      if (extras.meta.author.trim()) {
        y -= 6;
        drawLines(layoutRuns([{ text: extras.meta.author }], contentW, opts.size * 1.05), { size: opts.size * 1.05, color: "#4f5b53" });
      }
      if (extras.meta.date.trim()) {
        y -= 2;
        drawLines(layoutRuns([{ text: extras.meta.date }], contentW, opts.size * 0.95), { size: opts.size * 0.95, color: "#6b766f" });
      }
      newPage();
    }
  }

  /* -------------------- table of contents --------------------------- */
  if (extras.tocEntries && extras.tocEntries.length) {
    const entrySize = Math.max(9, opts.size * 0.92);
    drawLines(layoutRuns([{ text: "Contents", bold: true }], contentW, 16 * scale), { size: 16 * scale, color: "#12211a", lead: 16 * scale * 1.3 });
    y -= 8;
    for (const entry of extras.tocEntries) {
      const line = entrySize * 1.75;
      ensure(line);
      const indent = (entry.level - 1) * 14;
      const numberLabel = String(entry.page);
      const numberWidth = regular.widthOfTextAtSize(numberLabel, entrySize);
      let label = safePdfText(entry.title);
      const maxLabelWidth = contentW - indent - numberWidth - 14;
      while (label.length > 1 && regular.widthOfTextAtSize(label, entrySize) > maxLabelWidth) label = label.slice(0, -1);
      page.drawText(label, { x: margin + indent, y: y - entrySize, size: entrySize, font: regular, color: hexToRgb("#26312b") });
      page.drawText(numberLabel, {
        x: margin + contentW - numberWidth,
        y: y - entrySize,
        size: entrySize,
        font: regular,
        color: hexToRgb("#4f7d67"),
      });
      const labelWidth = regular.widthOfTextAtSize(label, entrySize);
      const dotsStart = margin + indent + labelWidth + 6;
      const dotsEnd = margin + contentW - numberWidth - 6;
      if (dotsEnd > dotsStart) {
        page.drawLine({
          start: { x: dotsStart, y: y - entrySize * 0.36 },
          end: { x: dotsEnd, y: y - entrySize * 0.36 },
          thickness: 0.4,
          color: hexToRgb("#cfcabd"),
        });
      }
      y -= line;
    }
    if (y > margin + 1) newPage();
  }

  /* ---------------------------- content ----------------------------- */
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex];
    if (opts.isCancelled?.()) throw new JobCancelledError();
    opts.onProgress?.(blockIndex + 1, blocks.length);
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
      const title = block.runs.map((run) => run.text).join("").trim();
      if (title) headings.push({ title, level: block.level, page: pages });
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
      const sourceLines = block.text.split("\n");
      const codeLines = sourceLines.flatMap((line) => {
        const runs = opts.codeHighlight ? highlightLine(line || " ", block.language) : [{ text: line || " " }];
        // Wrap each highlighted source line on its own runs, keeping tones.
        const wrapped: { runs: Run[]; width: number }[] = [];
        let current: Run[] = [];
        let currentWidth = 0;
        const limit = contentW - 20;
        for (const run of runs) {
          const pieces = run.text.split(/(\s+)/).filter((piece) => piece !== "");
          for (const piece of pieces) {
            const text = safePdfText(piece);
            const pieceWidth = mono.widthOfTextAtSize(text, codeSize);
            if (currentWidth + pieceWidth > limit && current.length && piece.trim()) {
              wrapped.push({ runs: current, width: currentWidth });
              current = [];
              currentWidth = 0;
            }
            current.push({ ...run, text });
            currentWidth += pieceWidth;
          }
        }
        wrapped.push({ runs: current.length ? current : [{ text: " " }], width: currentWidth });
        return wrapped;
      });
      const blockHeight = codeLines.length * lineHeight(codeSize) * 0.95 + 16;
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
      drawLines(codeLines, { size: codeSize, indent: 10, lead: lineHeight(codeSize) * 0.95, color: "#24312a" });
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

  /* --------------------------- footnotes ---------------------------- */
  if (opts.footnotes !== false && extras.notes.length) {
    if (y < margin + 60) newPage();
    y -= 20;
    drawLines(layoutRuns([{ text: "Footnotes", bold: true }], contentW, 12 * scale), { size: 12 * scale, color: "#1c4c3b", lead: 12 * scale * 1.3 });
    y -= 4;
    const noteSize = Math.max(8, opts.size * 0.84);
    for (const note of extras.notes) {
      const lines = layoutRuns([{ text: `${note.id}. ${note.text}` }], contentW, noteSize);
      drawLines(lines, { size: noteSize, color: "#4f5b53", lead: lineHeight(noteSize) });
      y -= 4;
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

  const meta = extras.meta;
  if (meta.title.trim()) doc.setTitle(meta.title.trim());
  if (meta.author.trim()) doc.setAuthor(meta.author.trim());
  doc.setCreator("Paperly");
  doc.setProducer("Paperly · local Markdown typesetting");

  return { doc, pages: Math.max(pages, 1), words, headings };
}

export async function renderMarkdownToPdf(source: string, opts: MarkdownRenderOptions): Promise<RenderedPdf> {
  const frontmatter = splitFrontmatter(source);
  const withFootnotes = opts.footnotes !== false;
  const { notes, body: noteBody } = withFootnotes ? extractFootnotes(frontmatter.body) : { notes: [], body: frontmatter.body };
  const blocks: Block[] = opts.plainText ? plainTextBlocks(noteBody) : parseMarkdown(noteBody);

  const run = (tocEntries: HeadingRef[] | null, onProgress?: (done: number, total: number) => void) =>
    renderPass(blocks, { ...opts, onProgress }, { meta: frontmatter.meta, notes, tocEntries });

  if (opts.toc) {
    // First pass measures where each heading lands; the contents page is then
    // written with those page numbers plus the pages it occupies itself.
    const probe = await run(null);
    const entries = probe.headings.slice(0, 80);
    const tocPages = estimateTocPages(entries.length, opts);
    const final = await run(
      entries.map((entry) => ({ ...entry, page: entry.page + tocPages })),
      opts.onProgress,
    );
    const bytes = await final.doc.save();
    return {
      bytes,
      pages: final.pages,
      words: final.words,
      headings: final.headings.length,
      title: frontmatter.meta.title || firstHeading(blocks) || undefined,
    };
  }

  const single = await run(null, opts.onProgress);
  const bytes = await single.doc.save();
  return {
    bytes,
    pages: single.pages,
    words: single.words,
    headings: single.headings.length,
    title: frontmatter.meta.title || firstHeading(blocks) || undefined,
  };
}

/* ------------------------------------------------------------------ *
 * Live preview
 * ------------------------------------------------------------------ */
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function runsToHtml(runs: Run[]): string {
  return runs
    .map((run) => {
      let html = escapeHtml(run.text);
      if (run.code) html = `<code>${html}</code>`;
      if (run.tone) html = `<span class="tone-${run.tone}">${html}</span>`;
      if (run.bold) html = `<strong>${html}</strong>`;
      if (run.italic) html = `<em>${html}</em>`;
      if (run.strike) html = `<del>${html}</del>`;
      if (run.link) html = `<span class="md-link">${html}</span>`;
      if (run.sup) html = `<sup>${html}</sup>`;
      return html;
    })
    .join("");
}

const PREVIEW_CSS = `
.md-preview { font-size: 13px; line-height: 1.7; color: #26312b; }
.md-preview p { margin: 0 0 10px; }
.md-preview .h1 { font-size: 22px; font-weight: 700; color: #12211a; margin: 18px 0 8px; letter-spacing: -0.01em; }
.md-preview .h2 { font-size: 17px; font-weight: 700; color: #1c4c3b; margin: 16px 0 6px; }
.md-preview .h3 { font-size: 14.5px; font-weight: 600; color: #1c4c3b; margin: 14px 0 5px; }
.md-preview .h4 { font-size: 13px; font-weight: 600; color: #26312b; margin: 12px 0 4px; }
.md-preview ul, .md-preview ol { margin: 0 0 10px 20px; padding: 0; }
.md-preview li { margin: 0 0 4px; }
.md-preview code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: #f1eee4; padding: 1px 4px; border-radius: 4px; }
.md-preview pre { background: #f1eee4; border: 1px solid #e0dbcd; border-radius: 8px; padding: 10px 12px; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.55; color: #24312a; }
.md-preview pre code { background: none; padding: 0; }
.md-preview blockquote { margin: 10px 0; padding: 6px 12px; border-left: 3px solid #1c4c3b; background: #f7f5ee; color: #4f5b53; }
.md-preview table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 12px; }
.md-preview th, .md-preview td { border: 1px solid #e0dbcd; padding: 5px 7px; text-align: left; }
.md-preview th { background: #e9e6da; color: #12211a; }
.md-preview hr { border: 0; border-top: 1px solid #d9d4c6; margin: 14px 0; }
.md-preview .md-link { color: #1c4c3b; text-decoration: underline; }
.md-preview .md-pagebreak { margin: 14px 0; border-top: 1px dashed #b9b3a4; text-align: center; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; color: #8b918b; }
.md-preview .tone-keyword { color: #7a3e9d; }
.md-preview .tone-string { color: #1f6b45; }
.md-preview .tone-comment { color: #8b918b; font-style: italic; }
.md-preview .tone-number { color: #a05a2c; }
`;

function blocksToHtml(blocks: Block[], highlight: boolean): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "heading") {
      parts.push(`<div class="h${block.level}">${runsToHtml(block.runs)}</div>`);
      continue;
    }
    if (block.type === "paragraph") {
      const text = runsToHtml(block.runs);
      parts.push(text.trim() ? `<p>${text}</p>` : "");
      continue;
    }
    if (block.type === "list") {
      const tag = block.ordered ? "ol" : "ul";
      const items = block.items
        .map((item) => `<li style="margin-left:${item.depth * 14}px">${runsToHtml(item.runs)}</li>`)
        .join("");
      parts.push(`<${tag}>${items}</${tag}>`);
      continue;
    }
    if (block.type === "code") {
      const lines = block.text.split("\n").map((line) => {
        const runs = highlight ? highlightLine(line || " ", block.language) : [{ text: line || " " }];
        return runsToHtml(runs);
      });
      parts.push(`<pre><code>${lines.join("\n")}</code></pre>`);
      continue;
    }
    if (block.type === "quote") {
      parts.push(`<blockquote>${runsToHtml(block.runs)}</blockquote>`);
      continue;
    }
    if (block.type === "table") {
      const [head, ...rows] = block.rows;
      const headHtml = `<tr>${head.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr>`;
      const bodyHtml = rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("");
      parts.push(`<table><thead>${headHtml}</thead><tbody>${bodyHtml}</tbody></table>`);
      continue;
    }
    if (block.type === "hr") {
      parts.push("<hr />");
      continue;
    }
    if (block.type === "pagebreak") {
      parts.push(`<div class="md-pagebreak">Page break</div>`);
    }
  }
  return parts.join("\n");
}

/* ------------------------------------------------------------------ *
 * MARKDOWN → PDF tool
 * ------------------------------------------------------------------ */
const MARKDOWN_DEFAULTS = {
  paper: "a4" as PaperKey,
  orientation: "portrait" as "portrait" | "landscape",
  margin: 56,
  size: 11,
  lineHeight: 1.5,
  family: "Helvetica" as Family,
  pageNumbers: true,
  plainText: false,
  titlePage: false,
  toc: false,
  codeHighlight: true,
  footnotes: true,
  preview: false,
};

export function MarkdownToPdfTool() {
  const opts = useToolPreferences("markdown-to-pdf", MARKDOWN_DEFAULTS);
  const [markdown, setMarkdown] = useState(BUILT_IN_TEMPLATES[1].markdown);
  const [importError, setImportError] = useState("");
  const job = useJob<RenderedPdf & { name: string; theme: string }>();

  const stats = useMemo(() => {
    const trimmed = splitFrontmatter(markdown).body.trim();
    const words = trimmed ? trimmed.split(/\s+/).length : 0;
    return { words, chars: markdown.length, minutes: Math.max(1, Math.round(words / 220)) };
  }, [markdown]);

  const frontmatter = useMemo(() => splitFrontmatter(markdown), [markdown]);
  const previewBlocks = useMemo(() => {
    const { body } = frontmatter;
    if (opts.value.plainText) return plainTextBlocks(body);
    const { body: withoutNotes } = extractFootnotes(body);
    return parseMarkdown(withoutNotes);
  }, [frontmatter, opts.value.plainText]);
  const previewHtml = useMemo(() => blocksToHtml(previewBlocks, opts.value.codeHighlight), [previewBlocks, opts.value.codeHighlight]);

  const activeTheme = MARKDOWN_THEMES.find(
    (theme) =>
      theme.family === opts.value.family &&
      Math.abs(theme.size - opts.value.size) < 0.01 &&
      Math.abs(theme.lineHeight - opts.value.lineHeight) < 0.01,
  );

  const updateMarkdown = (next: string) => {
    setMarkdown(next);
    setImportError("");
    if (!job.busy) job.reset();
  };

  const setFrontmatterField = (key: keyof Frontmatter, value: string) => {
    updateMarkdown(upsertFrontmatter(markdown, { ...frontmatter.meta, [key]: value }));
  };

  const convert = () =>
    job.run(async (reporter) => {
      if (!markdown.trim()) throw new Error("Write something first — or choose a template.");
      reporter.report(6, "Parsing Markdown…");
      const rendered = await renderMarkdownToPdf(markdown, {
        plainText: opts.value.plainText,
        paper: opts.value.paper,
        orientation: opts.value.orientation,
        margin: opts.value.margin,
        size: opts.value.size,
        lineHeight: opts.value.lineHeight,
        family: opts.value.family,
        pageNumbers: opts.value.pageNumbers,
        accent: "#d9f26c",
        titlePage: opts.value.titlePage,
        toc: opts.value.toc,
        codeHighlight: opts.value.codeHighlight,
        footnotes: opts.value.footnotes,
        onProgress: (done, total) => reporter.report(8 + (done / Math.max(1, total)) * 84, `Typesetting block ${done} of ${Math.max(1, total)}…`),
        isCancelled: () => reporter.cancelled,
      });
      const stem = (frontmatter.meta.title.trim() || markdown.match(/^#\s+(.+)$/m)?.[1] || "paperly-document").trim();
      return { ...rendered, name: `${sanitizeName(stem.slice(0, 60))}.pdf`, theme: activeTheme?.label ?? "Custom" };
    });

  const result = job.result;
  usePrimaryShortcut(() => void convert(), Boolean(markdown.trim()) && !job.busy);
  useDownloadShortcut(
    () => {
      if (result) downloadOutput(result.bytes, result.name, "application/pdf");
    },
    Boolean(result),
  );

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
              updateMarkdown(template.markdown);
              opts.set("plainText", false);
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
                updateMarkdown(content.slice(0, LIMITS.htmlChars));
                opts.set("plainText", /\.txt$/i.test(file.name));
              } catch (err) {
                setImportError(friendlyProcessingError(err, "That file couldn’t be imported."));
              }
            }}
          />
        </label>
      </div>

      {importError && <Alert tone="error">{importError}</Alert>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div>
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <label htmlFor="md-source" className="text-[12px] font-semibold uppercase tracking-[0.06em] text-ink/70">
                {opts.value.plainText ? "Plain text" : "Markdown"}
              </label>
              <button
                type="button"
                aria-pressed={opts.value.preview}
                onClick={() => opts.set("preview", !opts.value.preview)}
                className={cn(
                  "inline-flex h-7 items-center gap-1 rounded-lg border px-2 text-[11px] font-medium transition-colors",
                  opts.value.preview ? "border-forest bg-forest text-paper" : "border-line bg-paper text-ink/70 hover:border-forest/35 hover:text-forest",
                )}
              >
                {opts.value.preview ? <Pencil className="h-3 w-3" /> : <ListTree className="h-3 w-3" />}
                {opts.value.preview ? "Back to editing" : "Live preview"}
              </button>
            </div>
            <span className="text-[11px] text-muted">
              {stats.words.toLocaleString()} words · {stats.chars.toLocaleString()} chars · ≈ {stats.minutes} min read
            </span>
          </div>
          {opts.value.preview ? (
            <div className="h-[420px] overflow-auto rounded-xl border border-line bg-white px-5 py-4 scrollbar-thin">
              <style dangerouslySetInnerHTML={{ __html: PREVIEW_CSS }} />
              <div className="md-preview" role="document" aria-label="Live Markdown preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
            </div>
          ) : (
            <textarea
              id="md-source"
              value={markdown}
              onChange={(e) => updateMarkdown(e.target.value)}
              spellCheck
              className="h-[420px] w-full resize-y rounded-xl border border-line bg-paper px-4 py-3 font-mono text-[12.5px] leading-relaxed text-ink focus:border-forest/40 focus:outline-none focus:ring-2 focus:ring-forest/10"
              placeholder="# Your title&#10;&#10;Write **Markdown** here…"
            />
          )}
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-muted">
            Supports headings, <strong>bold</strong>, <em>italic</em>, inline code, code blocks, lists, quotes, tables, links, footnotes
            (<code>[^1]</code>) and <code>\newpage</code>.
          </p>
        </div>

        <aside className="space-y-3">
          <div className="rounded-xl border border-line bg-paper p-3.5">
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">Page setup</p>
            <div className="space-y-3">
              <Field label="Page size">
                <Select value={opts.value.paper} onChange={(e) => opts.set("paper", e.target.value as PaperKey)}>
                  <option value="a4">A4</option>
                  <option value="letter">US Letter</option>
                  <option value="legal">US Legal</option>
                  <option value="a5">A5</option>
                  <option value="a3">A3</option>
                </Select>
              </Field>
              <Field label="Orientation">
                <Segmented
                  value={opts.value.orientation}
                  onChange={(value) => opts.set("orientation", value)}
                  size="sm"
                  options={[
                    { value: "portrait", label: "Portrait" },
                    { value: "landscape", label: "Landscape" },
                  ]}
                />
              </Field>
              <Field label="Typeface">
                <Select value={opts.value.family} onChange={(e) => opts.set("family", e.target.value as Family)}>
                  <option value="Helvetica">Modern sans (Helvetica)</option>
                  <option value="Times">Classic serif (Times)</option>
                  <option value="Courier">Monospace (Courier)</option>
                </Select>
              </Field>
              <Field label="Margins" hint={`${Math.round((opts.value.margin / 72) * 25.4)} mm`}>
                <input
                  type="range"
                  min={28}
                  max={100}
                  value={opts.value.margin}
                  aria-label="Page margin"
                  onChange={(e) => opts.set("margin", Number(e.target.value))}
                  className="w-full accent-[#1c4c3b]"
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Font size">
                  <input
                    type="number"
                    min={7}
                    max={20}
                    step={0.5}
                    value={opts.value.size}
                    aria-label="Font size in points"
                    onChange={(e) => opts.set("size", Math.max(7, Math.min(20, Number(e.target.value) || 11)))}
                    className={cn(inputClass, "h-9 tabular-nums")}
                  />
                </Field>
                <Field label="Line height">
                  <input
                    type="number"
                    min={1.1}
                    max={2.4}
                    step={0.05}
                    value={opts.value.lineHeight}
                    aria-label="Line height multiplier"
                    onChange={(e) => opts.set("lineHeight", Math.max(1.1, Math.min(2.4, Number(e.target.value) || 1.5)))}
                    className={cn(inputClass, "h-9 tabular-nums")}
                  />
                </Field>
              </div>
              <Switch checked={opts.value.pageNumbers} onChange={(value) => opts.set("pageNumbers", value)} label="Page numbers" />
            </div>
          </div>
        </aside>
      </div>

      <AdvancedOptions
        scope="markdown-to-pdf"
        badge="9 controls"
        description="Theme, title page, contents, code highlighting, footnotes, frontmatter"
        onReset={opts.reset}
      >
        <PresetChips
          label="Theme"
          value={activeTheme?.id ?? "custom"}
          presets={MARKDOWN_THEMES.map((theme) => ({ id: theme.id, label: theme.label, description: theme.description }))}
          onSelect={(preset) => {
            const theme = MARKDOWN_THEMES.find((entry) => entry.id === preset.id);
            if (!theme) return;
            opts.patch({ family: theme.family, size: theme.size, lineHeight: theme.lineHeight });
          }}
        />
        <div className="mt-4">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/55">Frontmatter</p>
          <OptionsGrid>
            <Field label="Title" hint="Written into the document and the PDF title">
              <input
                value={frontmatter.meta.title}
                placeholder="Document title"
                onChange={(e) => setFrontmatterField("title", e.target.value)}
                className={inputClass}
              />
            </Field>
            <Field label="Author">
              <input
                value={frontmatter.meta.author}
                placeholder="Author or team"
                onChange={(e) => setFrontmatterField("author", e.target.value)}
                className={inputClass}
              />
            </Field>
            <Field label="Date">
              <input
                value={frontmatter.meta.date}
                placeholder="March 2026"
                onChange={(e) => setFrontmatterField("date", e.target.value)}
                className={inputClass}
              />
            </Field>
          </OptionsGrid>
          <div className="mt-2">
            <Switch
              checked={opts.value.plainText}
              onChange={(value) => opts.set("plainText", value)}
              label="Treat as plain text"
              description="Skip Markdown parsing and typeset every line as a paragraph"
            />
          </div>
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-muted">
            These three fields are written into a YAML frontmatter block at the top of the document — the same block other tools read back.
          </p>
        </div>
        <div className="mt-3 space-y-2">
          <Switch
            checked={opts.value.titlePage}
            onChange={(value) => opts.set("titlePage", value)}
            label="Title page"
            description="A dedicated first page built from the frontmatter title, author and date"
          />
          <Switch
            checked={opts.value.toc}
            onChange={(value) => opts.set("toc", value)}
            label="Table of contents"
            description="A generated contents page with real page numbers"
          />
          <Switch
            checked={opts.value.codeHighlight}
            onChange={(value) => opts.set("codeHighlight", value)}
            label="Highlight code"
            description="Colours keywords, strings and comments in code blocks"
          />
          <Switch
            checked={opts.value.footnotes}
            onChange={(value) => opts.set("footnotes", value)}
            label="Footnotes"
            description="Renders [^1] references and a footnotes section"
          />
        </div>
        <div className="mt-3">
          <OptionNote>A contents page is laid out after the title page; page numbers account for it. Everything is typeset in this tab.</OptionNote>
        </div>
      </AdvancedOptions>

      {job.failed && <Alert tone="error">{job.error}</Alert>}
      {job.status === "cancelled" && <Alert tone="info">Cancelled — nothing was downloaded.</Alert>}
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Button onClick={() => void convert()} loading={job.busy}>
          <FileText className="h-4 w-4" /> Create PDF
        </Button>
        {job.busy && (
          <Button variant="ghost" onClick={job.cancel}>
            Cancel
          </Button>
        )}
        <span className="text-[11.5px] text-muted">
          {stats.words.toLocaleString()} words · generated locally, no reflow surprises · ⌘↵ to create
        </span>
      </div>
      {job.busy && (
        <Progress value={job.percent ?? undefined} label={job.label || "Laying out your document…"} etaMs={job.etaMs} detail={describeJobTime(job)} />
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Your document is ready"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          onDownload={() => downloadBytes(result.bytes, result.name)}
          facts={[
            { label: "Theme", value: result.theme },
            { label: "Headings", value: String(result.headings ?? 0) },
            { label: "Words", value: result.words.toLocaleString() },
          ]}
          description={`${result.pages} page${result.pages === 1 ? "" : "s"} · ${formatBytes(result.bytes.byteLength)} · ${result.words.toLocaleString()} words typeset${opts.value.toc ? " · contents page included" : ""}`}
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

type ImageMode = "none" | "marker" | "embedded";

interface PageImageInfo {
  total: number;
  embedded: { dataUrl: string; alt: string }[];
  skipped: number;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(index, index + chunk)));
  }
  return btoa(binary);
}

/**
 * Count (and optionally export) the JPEG images stored in each page's resource
 * dictionary. Images that are not already JPEG are counted but not re-encoded —
 * Paperly does not silently rasterise them here.
 */
async function scanPageImages(bytes: ArrayBuffer | Uint8Array, pages: number[], mode: ImageMode): Promise<Map<number, PageImageInfo>> {
  const out = new Map<number, PageImageInfo>();
  if (mode === "none") return out;
  const doc = await openPdfLib(bytes);
  let budget = 1_800_000;
  for (const pageNumber of pages) {
    const info: PageImageInfo = { total: 0, embedded: [], skipped: 0 };
    try {
      const resources = doc.getPage(pageNumber - 1).node.Resources();
      const xObjects = resources?.lookup(PDFName.of("XObject"));
      if (xObjects instanceof PDFDict) {
        for (const [, ref] of xObjects.entries()) {
          const stream = doc.context.lookup(ref as PDFRef);
          if (!(stream instanceof PDFRawStream)) continue;
          const subtype = stream.dict.lookup(PDFName.of("Subtype"));
          if (!(subtype instanceof PDFName) || subtype.asString() !== "/Image") continue;
          info.total += 1;
          if (mode !== "embedded") continue;
          const filter = stream.dict.lookup(PDFName.of("Filter"));
          const jpeg = filter instanceof PDFName && filter.asString() === "/DCTDecode";
          const contents = jpeg ? stream.getContents() : null;
          if (!contents || budget - contents.byteLength < 0) {
            info.skipped += 1;
            continue;
          }
          budget -= contents.byteLength;
          info.embedded.push({
            dataUrl: `data:image/jpeg;base64,${bytesToBase64(contents)}`,
            alt: `Embedded image from page ${pageNumber}`,
          });
        }
      }
    } catch {
      /* unusual resource trees simply report nothing */
    }
    if (info.total > 0) out.set(pageNumber, info);
  }
  return out;
}

const PDF_MARKDOWN_DEFAULTS = {
  headings: true,
  tables: true,
  links: true,
  images: "none" as ImageMode,
  pageMarkers: true,
  pageBreaks: false,
  frontmatter: true,
};

interface PdfMarkdownResult {
  markdown: string;
  stats: { headings: number; tables: number; lists: number; links: number; images: number; emptyPages: number[] };
  pages: number;
}

export function PdfToMarkdownTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const opts = useToolPreferences("pdf-to-markdown", PDF_MARKDOWN_DEFAULTS);
  const [range, setRange] = useState("");
  const job = useJob<PdfMarkdownResult>();
  const [markdown, setMarkdown] = useState("");

  const convert = () =>
    job.run(async (reporter) => {
      if (!pdf.bytes || !pdf.file) throw new Error("Add a PDF first.");
      const selection = uniqueInOrder(parseRanges(range, pdf.pageCount));
      if (!selection.length) throw new Error("Choose at least one page to convert.");
      reporter.report(3, "Opening the document…");
      const doc = await openPdfJs(pdf.bytes);
      const extracted: ExtractedPage[] = [];
      const linksByPage = new Map<number, string[]>();
      try {
        for (let index = 0; index < selection.length; index++) {
          if (reporter.cancelled) throw new JobCancelledError();
          const pageNumber = selection[index];
          extracted.push(await extractPage(doc, pageNumber));
          if (opts.value.links) {
            try {
              const proxy = await doc.getPage(pageNumber);
              const annotations = (await proxy.getAnnotations()) as { url?: string; unsafeUrl?: string }[];
              const urls = Array.from(
                new Set(
                  annotations
                    .map((annotation) =>
                      typeof annotation.url === "string" ? annotation.url : typeof annotation.unsafeUrl === "string" ? annotation.unsafeUrl : "",
                    )
                    .filter((url) => url.length > 0),
                ),
              );
              if (urls.length) linksByPage.set(pageNumber, urls.slice(0, 40));
            } catch {
              /* annotations are optional */
            }
          }
          reporter.step(index + 1, selection.length, `Reading page ${pageNumber}…`, `${index + 1} of ${selection.length}`);
        }
      } finally {
        await doc.destroy();
      }
      if (reporter.cancelled) throw new JobCancelledError();

      reporter.report(68, "Looking for embedded images…");
      let imagesByPage = new Map<number, PageImageInfo>();
      try {
        imagesByPage = await scanPageImages(pdf.bytes, selection, opts.value.images);
      } catch {
        imagesByPage = new Map<number, PageImageInfo>();
      }
      if (reporter.cancelled) throw new JobCancelledError();

      const emptyPages = extracted.filter((page) => !page.text.trim()).map((page) => page.page);
      if (emptyPages.length === extracted.length) {
        throw new Error(
          "No text layer was found on these pages. Scanned documents need OCR first — open OCR PDF, make a searchable copy, then convert that.",
        );
      }

      reporter.report(84, "Structuring the Markdown…");
      let headings = 0;
      let tables = 0;
      let lists = 0;
      let linkCount = 0;
      let imageCount = 0;
      const output: string[] = [];
      if (opts.value.frontmatter) {
        output.push("---");
        output.push(`title: "${baseName(pdf.file.name).replace(/"/g, "'")}"`);
        output.push(`pages: ${extracted.length}`);
        output.push(`converted: ${new Date().toISOString().slice(0, 10)}`);
        output.push("generator: Paperly");
        output.push("---\n");
      }

      extracted.forEach((page, pageIndex) => {
        if (opts.value.pageBreaks && pageIndex > 0) output.push("\n\\newpage\n");
        if (opts.value.pageMarkers) output.push(`\n<!-- Page ${page.page} -->\n`);
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

          if (opts.value.tables) {
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

          if (opts.value.headings && (big || shortCaps)) {
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

        const images = imagesByPage.get(page.page);
        if (images) {
          imageCount += images.total;
          if (opts.value.images === "embedded" && images.embedded.length) {
            images.embedded.forEach((image, index) => {
              output.push("");
              output.push(`![Page ${page.page} image ${index + 1}](${image.dataUrl})`);
            });
            output.push("");
          }
          if (opts.value.images !== "embedded" || images.skipped) {
            const shown = opts.value.images === "embedded" ? images.skipped : images.total;
            output.push(`<!-- ${shown} embedded image${shown === 1 ? "" : "s"} on page ${page.page}${opts.value.images === "embedded" ? " not exported" : ""} -->`);
            output.push("");
          }
        }

        const links = linksByPage.get(page.page);
        if (links && links.length) {
          linkCount += links.length;
          output.push(`**Links on page ${page.page}**`);
          output.push("");
          links.forEach((url) => output.push(`- ${url}`));
          output.push("");
        }
        output.push("");
      });

      const text = output.join("\n").replace(/\n{4,}/g, "\n\n\n").trim();
      reporter.report(98, "Finishing the Markdown…");
      return {
        markdown: text,
        pages: extracted.length,
        stats: { headings, tables, lists, links: linkCount, images: imageCount, emptyPages },
      };
    });

  const result = job.result;
  const downloadMarkdown = () => {
    if (!markdown) return;
    downloadBytes(new Uint8Array(new TextEncoder().encode(markdown)), `${sanitizeName(baseName(pdf.file?.name ?? "document"))}.md`, "text/markdown");
  };
  const markdownBytes = useMemo(() => (markdown ? new Uint8Array(new TextEncoder().encode(markdown)) : null), [markdown]);

  usePrimaryShortcut(() => void convert(), Boolean(pdf.bytes) && !job.busy);
  useDownloadShortcut(downloadMarkdown, Boolean(markdown));

  // Keep the editable output in sync with the finished run.
  useEffect(() => {
    if (result) setMarkdown(result.markdown);
  }, [result]);

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A text-based PDF" />
      {pdf.bytes && (
        <>
          <RangeField value={range} onChange={setRange} total={pdf.pageCount} label="Pages to convert" hint="Leave empty for all pages." />
          <div className="grid gap-2 sm:grid-cols-3">
            <Switch checked={opts.value.headings} onChange={(value) => opts.set("headings", value)} label="Detect headings" description="Large lines become # / ##" />
            <Switch checked={opts.value.tables} onChange={(value) => opts.set("tables", value)} label="Detect tables" description="Rebuild simple tables" />
            <Switch
              checked={opts.value.frontmatter}
              onChange={(value) => opts.set("frontmatter", value)}
              label="Frontmatter"
              description="YAML header with source details"
            />
          </div>
          <AdvancedOptions scope="pdf-to-markdown" badge="4 controls" description="Links, images, page markers and page breaks" onReset={opts.reset}>
            <OptionsGrid>
              <Field label="Images" hint="Paperly exports embedded JPEGs, or marks where they sit">
                <Select value={opts.value.images} onChange={(e) => opts.set("images", e.target.value as ImageMode)}>
                  <option value="none">Ignore images</option>
                  <option value="marker">Mark image positions</option>
                  <option value="embedded">Embed JPEG images</option>
                </Select>
              </Field>
            </OptionsGrid>
            <div className="mt-3 space-y-2">
              <Switch
                checked={opts.value.pageBreaks}
                onChange={(value) => opts.set("pageBreaks", value)}
                label="Page breaks"
                description="Inserts a page break so the layout round-trips"
              />
              <Switch
                checked={opts.value.links}
                onChange={(value) => opts.set("links", value)}
                label="Link targets"
                description="Lists the URLs behind link annotations, page by page"
              />
              <Switch
                checked={opts.value.pageMarkers}
                onChange={(value) => opts.set("pageMarkers", value)}
                label="Page markers"
                description="Adds an HTML comment at the start of each page"
              />
            </div>
            <div className="mt-3">
              <OptionNote>
                Images are only exported when the PDF already stores them as JPEG; other encodings are counted, not rasterised. Use PDF to JPG when you
                need every image as a file.
              </OptionNote>
            </div>
          </AdvancedOptions>
          {job.failed && <Alert tone="error">{job.error}</Alert>}
          {job.failed && /OCR|text layer/i.test(job.error) && (
            <p className="text-[11.5px]">
              <a href="/ocr-pdf" className="font-semibold text-forest underline">
                Open OCR PDF
              </a>{" "}
              to add a searchable text layer first.
            </p>
          )}
          {job.status === "cancelled" && <Alert tone="info">Cancelled — nothing was downloaded.</Alert>}
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={() => void convert()} loading={job.busy}>
              <FileCode2 className="h-4 w-4" /> Convert to Markdown
            </Button>
            {job.busy && (
              <Button variant="ghost" onClick={job.cancel}>
                Cancel
              </Button>
            )}
            <span className="text-[11.5px] text-muted">Headings, lists, tables and links are inferred from the text layer.</span>
          </div>
          {job.busy && (
            <Progress value={job.percent ?? undefined} label={job.label || "Reading and structuring the document…"} etaMs={job.etaMs} detail={describeJobTime(job)} />
          )}
        </>
      )}

      {result && result.stats.emptyPages.length > 0 && (
        <Alert tone="warning" title="Some pages have no text layer">
          Page{result.stats.emptyPages.length === 1 ? "" : "s"} {result.stats.emptyPages.slice(0, 12).join(", ")}
          {result.stats.emptyPages.length > 12 ? "…" : ""} contain{result.stats.emptyPages.length === 1 ? "s" : ""} no selectable text, so nothing was
          written for {result.stats.emptyPages.length === 1 ? "it" : "them"}. If those pages are scanned, run{" "}
          <a href="/ocr-pdf" className="font-semibold underline">
            OCR PDF
          </a>{" "}
          first — Paperly never OCRs silently.
        </Alert>
      )}

      {markdown && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: "Headings", value: result?.stats.headings ?? 0 },
              { label: "Tables", value: result?.stats.tables ?? 0 },
              { label: "List items", value: result?.stats.lists ?? 0 },
              { label: "Links", value: result?.stats.links ?? 0 },
            ].map((item) => (
              <div key={item.label} className="rounded-xl border border-line bg-paper px-3 py-2.5">
                <p className="text-[18px] font-semibold leading-none text-forest">{item.value}</p>
                <p className="mt-1 text-[10.5px] uppercase tracking-[0.07em] text-ink/75">{item.label}</p>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/75">Markdown output</p>
            <span className="flex items-center gap-1.5 text-[11px] text-muted">
              <ImageIcon className="h-3 w-3" />
              {result?.stats.images ?? 0} embedded image{(result?.stats.images ?? 0) === 1 ? "" : "s"} detected
            </span>
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
          {markdownBytes && (
            <DownloadPanel
              bytes={markdownBytes}
              title="Markdown ready"
              filename={`${sanitizeName(baseName(pdf.file?.name ?? "document"))}.md`}
              size={markdownBytes.byteLength}
              mime="text/markdown"
              onDownload={downloadMarkdown}
              handoffIds={[]}
              facts={[
                { label: "Pages", value: String(result?.pages ?? 0) },
                { label: "Words", value: String(markdown.trim().split(/\s+/).filter(Boolean).length) },
              ]}
              description={`${markdown.trim().split(/\s+/).filter(Boolean).length.toLocaleString()} words · ${formatBytes(markdownBytes.byteLength)} · structured from the text layer`}
            />
          )}
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
      {pdf.bytes && !markdown && !result && !job.busy && (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-forest" />
          Scanned pages have no text layer. If the conversion finds nothing, run OCR PDF first — Paperly will say so instead of guessing.
        </p>
      )}
    </div>
  );
}
