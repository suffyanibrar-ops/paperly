/**
 * Table detection and CSV export helpers.
 *
 * Everything here is DOM-free and synchronous so it can be unit tested without
 * a browser. The input is the geometry produced by `extractDocumentGeometry`
 * (`PageGeometry` / `TextLine` from `@/lib/textGeometry`); the output is a
 * plain grid of strings that can be previewed or serialised as RFC-4180 CSV.
 *
 * The heuristics are deliberately conservative: a page of running prose must
 * never turn into a "table", so columns need support from several rows and a
 * grid must pass `validateTable` before it is offered for export.
 */

import type { PageGeometry, TextLine, TextBox } from "@/lib/textGeometry";

/** Pages scanned in one pass. Larger documents should be split first. */
export const TABLE_PAGE_CAP = 300;
/** Tables offered in one pass. Keeps previews and ZIPs responsive. */
export const TABLE_COUNT_CAP = 120;

/* ================================================================== *
 * Types
 * ================================================================== */

export interface Table {
  /** Normalised cell text; every row has `columnCount` cells. */
  rows: string[][];
  rowCount: number;
  columnCount: number;
  /** 0–1 share of non-empty cells. Low values usually mean a bad detection. */
  fillRatio: number;
  /** Rows that were shorter than the widest row and had to be padded. */
  raggedRows: number;
}

export interface TableRegion {
  /** 1-based page number. */
  page: number;
  /** The source lines of this table, top-to-bottom. */
  lines: TextLine[];
  /** Bounding box in PDF points. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0-based position of this table on its page, top-to-bottom. */
  index: number;
}

export interface ExtractedTable {
  /** Stable page-scoped id such as `p3-t2`. */
  id: string;
  /** 1-based page number. */
  page: number;
  /** 0-based position of this table on its page. */
  index: number;
  /** Detected column start edges, PDF points. */
  columns: number[];
  /** Bounding box in PDF points. */
  region: { x: number; y: number; width: number; height: number };
  table: Table;
}

export interface PageTables {
  page: number;
  tables: ExtractedTable[];
  /** Regions that looked tabular but failed validation. */
  rejectedRegions: number;
}

export interface ColumnOptions {
  /** Max distance between item starts that still counts as one column. */
  tolerance?: number;
  /** Absolute minimum number of rows that must support a column. */
  minSupport?: number;
  /** Share of evidence rows that must support a column. */
  minSupportRatio?: number;
  /** Horizontal gap between two detected column starts. */
  minColumnGap?: number;
  /** Max columns kept, highest support first. */
  maxColumns?: number;
  /** Minimum items on a line before it is used as column evidence. */
  evidenceItems?: number;
  /** Gap in points that separates two cells (word spaces are smaller). */
  minCellGap?: number;
  /**
   * Right-aligned values start at different x positions but end on the same
   * edge. Starts further apart than this are never treated as one column.
   */
  variantSpan?: number;
  /** How closely the right edges must match to merge alignment variants. */
  variantEndTolerance?: number;
}

export interface RegionOptions {
  /** Multiplier over the typical line gap that starts a new table. */
  regionGapRatio?: number;
  /** Absolute vertical gap in points that starts a new table. */
  minRegionGap?: number;
  /** Font-size multiplier for the table-splitting gap. */
  regionFontRatio?: number;
  /** Minimum rows in a region before it can be a table. */
  minRows?: number;
  /** Minimum items on a line for it to count as a table row. */
  minRowItems?: number;
}

export interface TableValidationOptions {
  minRows?: number;
  minColumns?: number;
  minFillRatio?: number;
  /** Share of rows that must contain at least two filled cells. */
  minFilledRowRatio?: number;
  maxColumns?: number;
}

export interface TableDetectionOptions extends ColumnOptions, RegionOptions {
  /** Join a wrapped line back into the previous row's cell (default true). */
  mergeWrappedLines?: boolean;
  validation?: TableValidationOptions;
}

export interface TableValidation {
  ok: boolean;
  /** Human-readable reasons the grid was rejected. */
  reasons: string[];
  filledRows: number;
  filledRowRatio: number;
}

/* ================================================================== *
 * Small numeric helpers
 * ================================================================== */

function compareNumbers(a: number, b: number): number {
  return a - b;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort(compareNumbers);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function roundPoints(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
}

/* ================================================================== *
 * Column detection
 * ================================================================== */

interface StartCluster {
  /** Sum of the item starts in this cluster (used for the average). */
  startSum: number;
  /** Every start in the cluster, kept only to know how many there are. */
  startCount: number;
  /** Right edges of the items that started in this cluster. */
  ends: number[];
  /** Evidence rows that have an item starting in this cluster. */
  rows: Set<number>;
}

function clusterEdge(cluster: StartCluster): number {
  return cluster.startSum / Math.max(1, cluster.startCount);
}

function mergeCluster(target: StartCluster, source: StartCluster) {
  target.startSum += source.startSum;
  target.startCount += source.startCount;
  target.ends.push(...source.ends);
  for (const row of source.rows) target.rows.add(row);
}

/**
 * Detect column start edges from the x positions where cells begin.
 *
 * A cell start is an item that begins a line or follows a real gap (word
 * spaces are roughly 0.25 × the font size; columns are further apart). Starts
 * are clustered with a small tolerance so sub-point jitter doesn't split one
 * column into several, then sparse clusters are dropped, near-duplicates are
 * merged, and right-aligned variants (same right edge, different left edge)
 * are folded back into a single column.
 *
 * Returns sorted left edges, or an empty array when the lines don't really
 * contain columns (for example, ordinary prose).
 */
export function detectColumnEdges(lines: TextLine[], options: ColumnOptions = {}): number[] {
  const tolerance = Math.max(0.5, options.tolerance ?? 6);
  const evidenceItems = Math.max(2, options.evidenceItems ?? 2);
  const minCellGap = Math.max(1, options.minCellGap ?? 5);

  const evidence = lines.filter((line) => line.text.trim().length > 0 && line.items.length >= evidenceItems);
  if (evidence.length < 2) return [];

  const points: { x: number; end: number; row: number }[] = [];
  evidence.forEach((line, row) => {
    const items = [...line.items].filter((item) => item.str.trim().length > 0).sort((a, b) => a.x - b.x);
    items.forEach((item, itemIndex) => {
      if (!Number.isFinite(item.x)) return;
      if (itemIndex > 0) {
        const previous = items[itemIndex - 1];
        const gap = item.x - (previous.x + previous.width);
        if (gap < minCellGap) return;
      }
      points.push({ x: item.x, end: item.x + Math.max(0, item.width), row });
    });
  });
  if (points.length < 2) return [];

  points.sort((a, b) => a.x - b.x);
  const clusters: StartCluster[] = [];
  for (const point of points) {
    const last = clusters[clusters.length - 1];
    if (last && point.x - clusterEdge(last) <= tolerance) {
      last.startSum += point.x;
      last.startCount += 1;
      last.ends.push(point.end);
      last.rows.add(point.row);
    } else {
      clusters.push({ startSum: point.x, startCount: 1, ends: [point.end], rows: new Set([point.row]) });
    }
  }

  // A column needs several rows of support, not one stray heading.
  const minSupport = Math.max(2, options.minSupport ?? 0, Math.ceil(evidence.length * (options.minSupportRatio ?? 0.2)));
  let kept = clusters.filter((cluster) => cluster.rows.size >= minSupport);
  if (kept.length < 2) {
    // Small or irregular tables: keep the best-supported clusters, but never
    // invent a column from a single item (that would turn prose into a grid).
    kept = [...clusters]
      .filter((cluster) => cluster.rows.size >= 2)
      .sort((a, b) => b.rows.size - a.rows.size || clusterEdge(a) - clusterEdge(b))
      .slice(0, options.maxColumns ?? 16);
  }
  if (kept.length < 2) return [];

  kept.sort((a, b) => clusterEdge(a) - clusterEdge(b));

  // Real columns are separated by a visible gap; anything closer is one column.
  const minColumnGap = Math.max(2, options.minColumnGap ?? 10);
  const merged: StartCluster[] = [];
  for (const cluster of kept) {
    const last = merged[merged.length - 1];
    if (last && clusterEdge(cluster) - clusterEdge(last) < minColumnGap) mergeCluster(last, cluster);
    else merged.push({ ...cluster, ends: [...cluster.ends], rows: new Set(cluster.rows) });
  }

  // Right-aligned values ("2.50", "54.00", "323.97") all end on the same edge
  // but start at different x positions. Their rows are disjoint, so fold them
  // into one column instead of exporting phantom columns.
  const variantSpan = options.variantSpan ?? 72;
  const variantEndTolerance = options.variantEndTolerance ?? 12;
  let changed = true;
  while (changed && merged.length > 1) {
    changed = false;
    for (let index = 0; index < merged.length - 1; index++) {
      const first = merged[index];
      const second = merged[index + 1];
      if (clusterEdge(second) - clusterEdge(first) > variantSpan) continue;
      let disjoint = true;
      for (const row of first.rows) {
        if (second.rows.has(row)) {
          disjoint = false;
          break;
        }
      }
      if (!disjoint) continue;
      if (Math.abs(median(first.ends) - median(second.ends)) > variantEndTolerance) continue;
      mergeCluster(first, second);
      merged.splice(index + 1, 1);
      changed = true;
      break;
    }
  }
  if (merged.length < 2) return [];

  const maxColumns = Math.max(2, options.maxColumns ?? 16);
  const strongest = [...merged].sort((a, b) => b.rows.size - a.rows.size).slice(0, maxColumns);
  return strongest.map(clusterEdge).sort(compareNumbers).map(roundPoints);
}

/* ================================================================== *
 * Row assembly
 * ================================================================== */

function segmentText(items: TextBox[]): string {
  let text = "";
  let previous: TextBox | null = null;
  for (const item of items) {
    const value = item.str;
    if (previous) {
      const gap = item.x - (previous.x + previous.width);
      const previousFont = previous.fontSize || 10;
      const font = item.fontSize || 10;
      const needsSpace =
        gap > Math.max(0.8, Math.min(previousFont, font) * 0.12) && !/\s$/.test(text) && !/^\s/.test(value);
      if (needsSpace) text += " ";
    }
    text += value;
    previous = item;
  }
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Split a line into cells for the given column start edges.
 *
 * Items are first grouped into contiguous runs (a run is split where the gap
 * is wide enough to be a cell boundary), so a cell whose text is encoded as
 * several items stays intact. Each run is then assigned to the nearest column
 * using midpoint boundaries between adjacent edges, which absorbs the small
 * left-edge jitter of real PDFs.
 */
export function rowsToCells(line: TextLine, columns: number[], options: { minCellGap?: number } = {}): string[] {
  const items = [...line.items].filter((item) => item.str.trim().length > 0 && Number.isFinite(item.x)).sort((a, b) => a.x - b.x);
  if (!columns.length) return [segmentText(items)];
  if (!items.length) return Array.from({ length: columns.length }, () => "");

  const minCellGap = Math.max(1, options.minCellGap ?? 5);
  const runs: TextBox[][] = [];
  let run: TextBox[] = [];
  for (const item of items) {
    const previous = run[run.length - 1];
    if (previous) {
      const gap = item.x - (previous.x + previous.width);
      const font = Math.max(4, Math.min(previous.fontSize || 10, item.fontSize || 10));
      if (gap >= Math.max(minCellGap, font * 0.5)) {
        runs.push(run);
        run = [];
      }
    }
    run.push(item);
  }
  if (run.length) runs.push(run);

  const boundaries = columns.slice(1).map((edge, index) => (columns[index] + edge) / 2);
  const cells = Array.from({ length: columns.length }, () => "");
  for (const segment of runs) {
    const start = segment[0].x;
    let column = 0;
    while (column < boundaries.length && start >= boundaries[column]) column += 1;
    const text = segmentText(segment);
    cells[column] = cells[column] ? `${cells[column]} ${text}`.trim() : text;
  }
  return cells.map((cell) => cell.replace(/\s+/g, " ").trim());
}

function normaliseCell(cell: string | null | undefined): string {
  return String(cell ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Turn a raw grid into a rectangular table: normalise cells, drop fully empty
 * rows, pad short rows and compute the fill ratio used by `validateTable`.
 */
export function assembleTable(grid: string[][]): Table {
  const normalised = grid.map((row) => row.map(normaliseCell)).filter((row) => row.some((cell) => cell !== ""));
  const columnCount = normalised.reduce((widest, row) => Math.max(widest, row.length), 0);
  const rows = normalised.map((row) =>
    row.length === columnCount ? row : [...row, ...Array.from({ length: columnCount - row.length }, () => "")],
  );
  const rowCount = rows.length;
  const nonEmpty = rows.reduce((total, row) => total + row.filter((cell) => cell !== "").length, 0);
  const fillRatio = rowCount > 0 && columnCount > 0 ? nonEmpty / (rowCount * columnCount) : 0;
  const raggedRows = normalised.filter((row) => row.length !== columnCount).length;
  return { rows, rowCount, columnCount, fillRatio, raggedRows };
}

/**
 * Reject grids that are too small, too empty or too ragged to be honest
 * exports. Prose that happens to align in two columns usually fails the fill
 * or filled-row checks because most lines don't fill the grid.
 */
export function validateTable(table: Table, options: TableValidationOptions = {}): TableValidation {
  const minRows = Math.max(1, options.minRows ?? 2);
  const minColumns = Math.max(1, options.minColumns ?? 2);
  const maxColumns = Math.max(2, options.maxColumns ?? 24);
  const minFillRatio = options.minFillRatio ?? 0.45;
  const minFilledRowRatio = options.minFilledRowRatio ?? 0.6;
  const reasons: string[] = [];

  if (table.rowCount < minRows) reasons.push(`Needs at least ${minRows} rows (found ${table.rowCount}).`);
  if (table.columnCount < minColumns) reasons.push(`Needs at least ${minColumns} columns (found ${table.columnCount}).`);
  if (table.columnCount > maxColumns) reasons.push(`Found ${table.columnCount} columns, more than the ${maxColumns} this tool handles.`);
  if (table.fillRatio < minFillRatio) {
    reasons.push(`Too many empty cells (${Math.round(table.fillRatio * 100)}% filled).`);
  }
  const filledRows = table.rows.filter((row) => row.filter((cell) => cell !== "").length >= 2).length;
  const filledRowRatio = table.rowCount > 0 ? filledRows / table.rowCount : 0;
  if (filledRowRatio < minFilledRowRatio) {
    reasons.push(`Only ${Math.round(filledRowRatio * 100)}% of rows contain more than one cell.`);
  }
  return { ok: reasons.length === 0, reasons, filledRows, filledRowRatio };
}

/* ================================================================== *
 * Region detection
 * ================================================================== */

/**
 * Split a block on heading-only rows and trim sparse leading/trailing rows.
 *
 * A sparse row only counts as a heading when it is separated from the table
 * rows by more than the page's normal line spacing — otherwise it is a
 * wrapped cell continuation and must stay inside the table.
 */
function splitBlock(block: TextLine[], minRowItems = 2, typicalGap = 0): TextLine[][] {
  const headingGap = Math.max(typicalGap * 1.15, 0);
  const segments: TextLine[][] = [];
  let segment: TextLine[] = [];
  for (let index = 0; index < block.length; index++) {
    const line = block[index];
    const sparse = line.items.length < minRowItems;
    const previousDense = index > 0 && block[index - 1].items.length >= minRowItems;
    const nextDense = index < block.length - 1 && block[index + 1].items.length >= minRowItems;
    const gapAbove = index > 0 ? block[index - 1].y - line.y : 0;
    const gapBelow = index < block.length - 1 ? line.y - block[index + 1].y : 0;
    const separated = gapAbove > headingGap || gapBelow > headingGap;
    if (sparse && separated && previousDense && nextDense) {
      if (segment.length) segments.push(segment);
      segment = [];
      continue;
    }
    segment.push(line);
  }
  if (segment.length) segments.push(segment);

  return segments
    .map((candidate) => {
      let start = 0;
      let end = candidate.length;
      while (start < end && candidate[start].items.length < minRowItems) start += 1;
      while (end > start && candidate[end - 1].items.length < minRowItems) end -= 1;
      return candidate.slice(start, end);
    })
    .filter((candidate) => candidate.length >= 2);
}

function buildRegion(lines: TextLine[], page: number, index: number): TableRegion | null {
  if (lines.length < 2) return null;
  let left = Infinity;
  let right = -Infinity;
  let bottom = Infinity;
  let top = -Infinity;
  for (const line of lines) {
    left = Math.min(left, line.x);
    bottom = Math.min(bottom, line.bottom);
    top = Math.max(top, line.top);
    for (const item of line.items) right = Math.max(right, item.x + item.width);
  }
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return {
    page,
    lines: [...lines],
    x: roundPoints(left),
    y: roundPoints(bottom),
    width: roundPoints(Math.max(0, right - left)),
    height: roundPoints(Math.max(0, top - bottom)),
    index,
  };
}

/**
 * Find candidate table regions on a page.
 *
 * Lines are split where the vertical gap is clearly bigger than the page's
 * typical line spacing, then on heading-only rows inside a block. Sparse
 * leading/trailing lines (titles, captions, page numbers) are dropped before
 * a region is returned. The result still needs column detection and
 * validation — this only narrows down where tables can live.
 */
export function findTableRegions(page: PageGeometry, options: RegionOptions = {}): TableRegion[] {
  const minRows = Math.max(2, options.minRows ?? 2);
  const minRowItems = Math.max(2, options.minRowItems ?? 2);
  const ordered = [...page.lines].filter((line) => line.text.trim().length > 0).sort((a, b) => b.y - a.y);
  if (ordered.length < minRows) return [];

  const gaps: number[] = [];
  for (let index = 1; index < ordered.length; index++) {
    const gap = ordered[index - 1].y - ordered[index].y;
    if (gap > 0.5) gaps.push(gap);
  }
  const typicalGap = median(gaps) || median(ordered.map((line) => line.fontSize)) * 1.4 || 14;
  const font = median(ordered.map((line) => line.fontSize).filter((size) => size > 0)) || 10;
  const splitGap = Math.max(
    options.minRegionGap ?? 6,
    typicalGap * (options.regionGapRatio ?? 1.9),
    font * (options.regionFontRatio ?? 1.8),
  );

  const regions: TableRegion[] = [];
  let block: TextLine[] = [];
  const flush = () => {
    for (const segment of splitBlock(block, minRowItems, typicalGap)) {
      const region = buildRegion(segment, page.page, regions.length);
      if (region && region.lines.length >= minRows) regions.push(region);
    }
    block = [];
  };
  for (let index = 0; index < ordered.length; index++) {
    if (index > 0 && ordered[index - 1].y - ordered[index].y > splitGap) flush();
    block.push(ordered[index]);
  }
  flush();
  return regions;
}


/* ================================================================== *
 * Page analysis
 * ================================================================== */

/**
 * Detect the tables on one page: find regions, detect columns, assemble rows
 * (optionally re-joining wrapped lines) and validate the result.
 */
export function detectPageTables(page: PageGeometry, options: TableDetectionOptions = {}): PageTables {
  const mergeWrapped = options.mergeWrappedLines !== false;
  const regions = findTableRegions(page, options);
  const tables: ExtractedTable[] = [];
  let rejectedRegions = 0;

  for (const region of regions) {
    const columns = detectColumnEdges(region.lines, options);
    if (columns.length < 2) {
      rejectedRegions += 1;
      continue;
    }

    const grid: string[][] = [];
    let previousLine: TextLine | null = null;
    let previousCells: string[] | null = null;
    let previousFilled = 0;

    for (const line of region.lines) {
      const cells = rowsToCells(line, columns, { minCellGap: options.minCellGap });
      const filled = cells.map((cell, index) => ({ cell, index })).filter((entry) => entry.cell !== "");

      // Wrapped cell text continues on the next visual line: it has a single
      // filled cell that lines up with a cell in the previous row and sits on
      // normal row spacing. Continuations in a later column are the reliable
      // case (a new row usually starts in the first column), so they get a
      // slightly wider spacing allowance.
      if (mergeWrapped && previousCells && previousLine && filled.length === 1) {
        const { cell, index } = filled[0];
        const gap = previousLine.y - line.y;
        const font = Math.max(previousLine.fontSize, line.fontSize);
        const limit = font * (index > 0 ? 1.8 : 1.2);
        if (previousFilled >= 2 && previousCells[index] !== "" && gap > 0 && gap <= limit) {
          const existing = previousCells[index];
          previousCells[index] = existing.endsWith("-") ? `${existing.slice(0, -1)}${cell}` : `${existing} ${cell}`;
          // Keep following continuation lines attached to the same row.
          previousLine = line;
          continue;
        }
      }

      grid.push(cells);
      previousLine = line;
      previousCells = cells;
      previousFilled = filled.length;
    }

    const table = assembleTable(grid);
    if (!validateTable(table, options.validation).ok) {
      rejectedRegions += 1;
      continue;
    }
    tables.push({
      id: `p${page.page}-t${tables.length + 1}`,
      page: page.page,
      index: tables.length,
      columns,
      region: { x: region.x, y: region.y, width: region.width, height: region.height },
      table,
    });
  }

  return { page: page.page, tables, rejectedRegions };
}

/* ================================================================== *
 * CSV serialisation (RFC 4180)
 * ================================================================== */

export interface CsvOptions {
  /** Field separator, default `,`. */
  delimiter?: string;
  /** Quote character, default `"`. */
  quote?: string;
  /** Line ending, default CRLF as required by RFC 4180. */
  lineEnding?: string;
  /** Quote every field, not just the ones that need it. */
  quoteAll?: boolean;
  /** Prefix the output with a UTF-8 BOM (helps Excel detect the encoding). */
  bom?: boolean;
}

function escapeCsvField(value: string, delimiter: string, quote: string, quoteAll: boolean): string {
  const text = value ?? "";
  const needsQuotes =
    quoteAll ||
    (delimiter.length > 0 && text.includes(delimiter)) ||
    text.includes(quote) ||
    /[\r\n]/.test(text);
  if (!needsQuotes) return text;
  return `${quote}${text.split(quote).join(quote + quote)}${quote}`;
}

/**
 * Serialise a table (or a raw grid) as RFC-4180 CSV.
 *
 * Fields containing the delimiter, a quote or a line break are quoted and
 * inner quotes are doubled; records are separated by CRLF and the final record
 * also ends with CRLF, as RFC 4180 allows.
 */
export function tableToCsv(table: Table | string[][], options: CsvOptions = {}): string {
  const delimiter = options.delimiter ?? ",";
  const quote = options.quote ?? '"';
  const lineEnding = options.lineEnding ?? "\r\n";
  if (!delimiter.length) throw new Error("CSV delimiter can’t be empty.");
  if (quote.length !== 1) throw new Error("CSV quote character must be exactly one character.");

  const rows = Array.isArray(table) ? table : table.rows;
  const lines = rows.map((row) =>
    row.map((cell) => escapeCsvField(cell, delimiter, quote, options.quoteAll === true)).join(delimiter),
  );
  const body = lines.length ? `${lines.join(lineEnding)}${lineEnding}` : "";
  return options.bom ? `\uFEFF${body}` : body;
}

/* ================================================================== *
 * ZIP entries
 * ================================================================== */

export interface CsvTableRef {
  table: Table;
  /** 1-based page number. */
  page: number;
  /** 0-based table index on the page; falls back to the array position. */
  index?: number;
}

export interface CsvZipEntry {
  name: string;
  data: string;
}

export interface CsvZipOptions extends CsvOptions {
  /** File stem prefix; defaults to `page-03-table-02`. */
  baseName?: string;
  /** Optional folder inside the archive. */
  folder?: string;
}

function safeFilePart(value: string, fallback = "tables"): string {
  return (
    value
      .split("")
      .filter((character) => character.charCodeAt(0) >= 32)
      .join("")
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .replace(/^[.\s-]+|[.\s-]+$/g, "")
      .slice(0, 90) || fallback
  );
}

function padNumber(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Build uniquely named CSV entries for a ZIP download.
 *
 * Names are `page-03-table-02.csv` by default, or `<baseName>-p03-t02.csv`.
 * Duplicate page/table pairs are suffixed `-2`, `-3`, … so no entry overwrites
 * another inside the archive.
 */
export function tablesToZipEntries(tables: CsvTableRef[], options: CsvZipOptions = {}): CsvZipEntry[] {
  const baseName = options.baseName ? safeFilePart(options.baseName) : "";
  const folder = options.folder ? safeFilePart(options.folder) : "";
  const used = new Map<string, number>();

  return tables.map((entry, position) => {
    const page = Math.max(1, Math.round(Number(entry.page) || 1));
    const index = Math.max(0, Math.round(Number(entry.index ?? position) || 0));
    const stem = baseName
      ? `${baseName}-p${padNumber(page)}-t${padNumber(index + 1)}`
      : `page-${padNumber(page)}-table-${padNumber(index + 1)}`;
    const seen = (used.get(stem.toLowerCase()) ?? 0) + 1;
    used.set(stem.toLowerCase(), seen);
    const uniqueStem = seen === 1 ? stem : `${stem}-${seen}`;
    return {
      name: folder ? `${folder}/${uniqueStem}.csv` : `${uniqueStem}.csv`,
      data: tableToCsv(entry.table, options),
    };
  });
}
