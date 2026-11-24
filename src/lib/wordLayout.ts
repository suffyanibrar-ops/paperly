import type { ExtractedLine, ExtractedPage } from "@/lib/extract";

/**
 * Geometry-based Word layout reconstruction.
 *
 * This is deliberately conservative: headings need a real size jump (or an
 * all-caps short title), paragraphs need a vertical gap, and alignment needs a
 * stable centre/right edge. It never turns prose into tables — PDF → Excel is
 * the table-specific pipeline.
 */
export type WordBlockKind = "heading" | "paragraph" | "bullet";
export type WordAlign = "left" | "center" | "right";
export type WordHeadingLevel = 1 | 2 | 3;

export interface WordBlock {
  kind: WordBlockKind;
  text: string;
  /** Only for headings. */
  level: WordHeadingLevel;
  /** Points on the source page. */
  fontSize: number;
  bold: boolean;
  /** Left indent in points, relative to the page's left text edge. */
  indent: number;
  align: WordAlign;
}

const BULLET = /^[•▪◦‣·●*-]\s+/;
const NUMBERED = /^(\d{1,3})[.)]\s+/;

function median(values: number[]): number {
  if (!values.length) return 11;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function alignmentFor(line: ExtractedLine, page: ExtractedPage, left: number): WordAlign {
  const width = Math.max(1, page.width);
  const centre = line.x + line.width / 2;
  if (line.width < width * 0.7 && line.x > left + width * 0.06 && Math.abs(centre - width / 2) < width * 0.075) return "center";
  if (line.width < width * 0.62 && line.x + line.width > width * 0.86) return "right";
  return "left";
}

function headingLevel(line: ExtractedLine, bodySize: number): WordHeadingLevel | null {
  if (line.text.length > 130) return null;
  const ratio = line.fontSize / Math.max(1, bodySize);
  const caps = line.text.length < 80 && line.text === line.text.toUpperCase() && /[A-Z]/.test(line.text);
  if (ratio >= 1.7) return 1;
  if (ratio >= 1.38) return 2;
  if (ratio >= 1.18 || caps) return 3;
  return null;
}

export function buildWordBlocks(page: ExtractedPage): WordBlock[] {
  const lines = page.lines.filter((line) => line.text.trim().length > 0);
  if (!lines.length) return [];
  const bodySize = median(lines.map((line) => line.fontSize || line.height || 11));
  const left = Math.min(...lines.map((line) => line.x));
  const blocks: WordBlock[] = [];

  let current: WordBlock | null = null;
  let previous: ExtractedLine | null = null;

  const flush = () => {
    if (current) blocks.push(current);
    current = null;
  };

  const start = (line: ExtractedLine, text: string, kind: WordBlockKind, level: WordHeadingLevel = 3): WordBlock => ({
    kind,
    text,
    level,
    fontSize: line.fontSize || line.height || bodySize,
    bold: kind === "heading" || /(bold|black|heavy|semibold)/i.test(line.fontName),
    indent: Math.max(0, Math.round(line.x - left)),
    align: alignmentFor(line, page, left),
  });

  for (const line of lines) {
    const text = line.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const level = headingLevel(line, bodySize);
    if (level) {
      flush();
      blocks.push(start(line, text, "heading", level));
      previous = line;
      continue;
    }

    const bullet = BULLET.test(text);
    const numbered = NUMBERED.test(text);
    if (bullet || numbered) {
      flush();
      // Numbered text keeps its marker because Word numbering definitions are
      // document-global; bullets use a real Word bullet list. Keep the block
      // open so a wrapped continuation line can join it.
      current = start(line, bullet ? text.replace(BULLET, "") : text, bullet ? "bullet" : "paragraph");
      previous = line;
      continue;
    }

    const gap = previous ? previous.y - line.y : 0;
    const indent = Math.max(0, Math.round(line.x - left));
    const align = alignmentFor(line, page, left);
    const styleJump = line.fontSize > bodySize * 1.18;
    const startsNew = !current || gap > (previous?.fontSize ?? bodySize) * 1.55 || indent > (current?.indent ?? 0) + 14 || align !== current.align || styleJump;

    if (startsNew) {
      flush();
      current = start(line, text, "paragraph");
    } else if (current) {
      if (current.text.endsWith("-") && !current.text.endsWith(" -")) current.text = current.text.slice(0, -1) + text;
      else current.text += ` ${text}`;
      current.bold = current.bold || /(bold|black|heavy|semibold)/i.test(line.fontName);
    }
    previous = line;
  }
  flush();
  return blocks;
}
