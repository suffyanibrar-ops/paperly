import { Check, Copy, Download, FileSpreadsheet, Table2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, EmptyHint, Field, Progress, Select, Switch } from "@/components/ui";
import { RangeField, SinglePdfInput } from "@/components/toolParts";
import { copyText } from "@/lib/router";
import { baseName, describePages, downloadBytes, parseRanges, sanitizeName, uniqueInOrder, zipAndDownload } from "@/lib/pdf";
import { friendlyProcessingError } from "@/lib/security";
import {
  TABLE_COUNT_CAP,
  TABLE_PAGE_CAP,
  detectPageTables,
  tableToCsv,
  tablesToZipEntries,
  type ExtractedTable,
  type TableDetectionOptions,
} from "@/lib/tables";
import { extractDocumentGeometry, type PageGeometry } from "@/lib/textItems";
import { useInitialFiles, usePdfFile } from "@/lib/usePdf";
import { cn } from "@/utils/cn";

type Sensitivity = "balanced" | "sensitive" | "strict";

const DETECTION: Record<Sensitivity, TableDetectionOptions> = {
  balanced: {},
  sensitive: {
    tolerance: 7,
    minSupportRatio: 0.15,
    regionGapRatio: 1.5,
    regionFontRatio: 1.6,
    validation: { minFillRatio: 0.35, minFilledRowRatio: 0.5 },
  },
  strict: {
    tolerance: 4,
    minSupportRatio: 0.35,
    regionGapRatio: 2.1,
    regionFontRatio: 2,
    validation: { minFillRatio: 0.6, minFilledRowRatio: 0.75 },
  },
};

const PREVIEW_ROWS = 40;
const PREVIEW_ROWS_LIMIT = 200;

interface ScanResult {
  tables: ExtractedTable[];
  rotatedPages: number[];
  rejectedRegions: number;
  capped: boolean;
}

function rotateList(pages: number[]): string {
  return pages.length > 10 ? `${pages.slice(0, 10).join(", ")} and ${pages.length - 10} more` : pages.join(", ");
}

export function TablesToCsvTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [range, setRange] = useState("");
  const [sensitivity, setSensitivity] = useState<Sensitivity>("balanced");
  const [mergeWrapped, setMergeWrapped] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pages, setPages] = useState<PageGeometry[] | null>(null);
  const [scannedLabel, setScannedLabel] = useState("");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const runRef = useRef(0);

  const options = useMemo<TableDetectionOptions>(
    () => ({ ...DETECTION[sensitivity], mergeWrappedLines: mergeWrapped }),
    [sensitivity, mergeWrapped],
  );

  // Results belong to one file; a new file must never show stale tables.
  useEffect(() => {
    runRef.current += 1;
    setPages(null);
    setScannedLabel("");
    setNotice("");
    setError("");
    setBusy(false);
    setProgress(0);
    setExcluded(new Set());
    setExpanded(new Set());
    setCopiedId(null);
  }, [pdf.bytes]);

  const scan = useMemo<ScanResult | null>(() => {
    if (!pages) return null;
    const tables: ExtractedTable[] = [];
    const rotatedPages: number[] = [];
    let rejectedRegions = 0;
    let capped = false;
    for (const page of pages) {
      if (Math.abs(page.rotation) % 360 !== 0) {
        rotatedPages.push(page.page);
        continue;
      }
      const result = detectPageTables(page, options);
      rejectedRegions += result.rejectedRegions;
      for (const table of result.tables) {
        if (tables.length >= TABLE_COUNT_CAP) {
          capped = true;
          break;
        }
        tables.push(table);
      }
      if (capped) break;
    }
    return { tables, rotatedPages, rejectedRegions, capped };
  }, [pages, options]);

  const included = useMemo(() => (scan ? scan.tables.filter((table) => !excluded.has(table.id)) : []), [scan, excluded]);
  const includedRows = useMemo(() => included.reduce((total, table) => total + table.table.rowCount, 0), [included]);
  const documentName = pdf.file ? sanitizeName(baseName(pdf.file.name)) : "document";

  const extract = async () => {
    if (!pdf.bytes || !pdf.file) return;
    const run = runRef.current + 1;
    runRef.current = run;
    setBusy(true);
    setProgress(0);
    setError("");
    setNotice("");
    setPages(null);
    setScannedLabel("");
    setExcluded(new Set());
    setExpanded(new Set());
    setCopiedId(null);
    try {
      const selected = uniqueInOrder(parseRanges(range, pdf.pageCount));
      const toScan = selected.slice(0, TABLE_PAGE_CAP);
      if (selected.length > TABLE_PAGE_CAP) {
        setNotice(
          `This run reads the first ${TABLE_PAGE_CAP} selected pages to keep the tab responsive. Split the PDF if the tables continue after that.`,
        );
      }
      const geometry = await extractDocumentGeometry(pdf.bytes, {
        pages: toScan,
        onProgress: (done, total) => setProgress(Math.round((done / Math.max(1, total)) * 90)),
      });
      if (run !== runRef.current) return;
      const characters = geometry.pages.reduce(
        (total, page) => total + page.lines.reduce((count, line) => count + line.text.replace(/\s/g, "").length, 0),
        0,
      );
      if (characters < 20) {
        throw new Error(
          "No text layer found on the selected pages. Scanned pages need OCR first — run OCR PDF, then come back to extract its tables.",
        );
      }
      setProgress(100);
      setScannedLabel(describePages(toScan, geometry.totalPages));
      setPages(geometry.pages);
    } catch (err) {
      if (run === runRef.current) setError(friendlyProcessingError(err));
    } finally {
      if (run === runRef.current) setBusy(false);
    }
  };

  const toggleIncluded = (id: string) => {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleExpanded = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const fileFor = (table: ExtractedTable) => `${documentName}-p${table.page}-t${table.index + 1}.csv`;

  const downloadCsv = (table: ExtractedTable) => {
    downloadBytes(new TextEncoder().encode(tableToCsv(table.table)), fileFor(table), "text/csv;charset=utf-8");
  };

  const copyCsv = async (table: ExtractedTable) => {
    const copied = await copyText(tableToCsv(table.table));
    if (!copied) return;
    setCopiedId(table.id);
    window.setTimeout(() => setCopiedId((current) => (current === table.id ? null : current)), 1800);
  };

  const downloadAll = async () => {
    if (!included.length) return;
    try {
      const entries = tablesToZipEntries(
        included.map((table) => ({ table: table.table, page: table.page, index: table.index })),
        { baseName: documentName },
      );
      await zipAndDownload(
        entries.map((entry) => ({ name: entry.name, data: new Blob([entry.data], { type: "text/csv;charset=utf-8" }) })),
        `${documentName}-tables.zip`,
      );
    } catch (err) {
      setError(friendlyProcessingError(err, "Couldn’t build the ZIP archive. Try downloading the tables one by one."));
    }
  };

  const hasResult = Boolean(scan && scan.tables.length > 0);

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF with tables" />
      {pdf.bytes && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <RangeField
              value={range}
              onChange={setRange}
              total={pdf.pageCount}
              label="Pages to scan"
              hint={`Leave empty for every page. Up to ${TABLE_PAGE_CAP} pages per run — press Extract to apply a change.`}
            />
            <Field
              label="Detection level"
              hint="Strict only keeps clean, well-filled grids. Sensitive finds tables with gaps and missing cells."
            >
              <Select value={sensitivity} onChange={(event) => setSensitivity(event.target.value as Sensitivity)}>
                <option value="balanced">Balanced (recommended)</option>
                <option value="sensitive">Sensitive — catch loose tables</option>
                <option value="strict">Strict — only clean tables</option>
              </Select>
            </Field>
          </div>
          <Switch
            checked={mergeWrapped}
            onChange={setMergeWrapped}
            label="Join wrapped cell lines"
            description="Re-joins a continuation line into the cell above, instead of turning it into a row with empty cells."
          />
          {notice && <Alert tone="warning">{notice}</Alert>}
          {error && (
            <Alert tone="error">
              {error}{" "}
              {/OCR|scan/i.test(error) && (
                <a href="#/tool/ocr" className="font-semibold underline">
                  Open OCR PDF
                </a>
              )}
            </Alert>
          )}
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={extract} loading={busy}>
              <Table2 className="h-4 w-4" /> Extract tables
            </Button>
            <span className="text-[11.5px] text-muted">Reads the real text layer · nothing is uploaded</span>
          </div>
          {busy && <Progress value={progress} label="Reading the text layer and detecting columns…" />}

          {scan && !busy && (
            <>
              {scan.rotatedPages.length > 0 && (
                <Alert tone="warning" title="Rotated pages were skipped">
                  Page{scan.rotatedPages.length === 1 ? "" : "s"} {rotateList(scan.rotatedPages)} are rotated, so column order
                  is unreliable. Use{" "}
                  <a href="#/tool/rotate" className="font-semibold underline">
                    Rotate PDF
                  </a>{" "}
                  to straighten them, then scan again.
                </Alert>
              )}
              {scan.capped && (
                <Alert tone="warning" title={`Stopped at ${TABLE_COUNT_CAP} tables`}>
                  This pass found more tables than the preview handles. Split the PDF into smaller parts to export everything.
                </Alert>
              )}

              {hasResult ? (
                <>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-bone-deep/35 px-3.5 py-2.5">
                    <FileSpreadsheet className="h-4 w-4 shrink-0 text-forest" />
                    <p className="text-[12.5px] font-semibold">
                      {included.length} of {scan.tables.length} tables selected
                    </p>
                    <span className="text-[11.5px] text-muted">
                      {includedRows.toLocaleString()} rows{scannedLabel ? ` · ${scannedLabel}` : ""}
                    </span>
                    <Badge tone="neutral">RFC 4180 · UTF-8</Badge>
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                      <Button size="sm" onClick={downloadAll} disabled={!included.length}>
                        <Download className="h-4 w-4" /> Download all (ZIP)
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-4">
                    {scan.tables.map((table) => {
                      const isIncluded = !excluded.has(table.id);
                      const isExpanded = expanded.has(table.id);
                      const limit = isExpanded ? Math.min(table.table.rowCount, PREVIEW_ROWS_LIMIT) : PREVIEW_ROWS;
                      const previewRows = table.table.rows.slice(0, limit);
                      const copied = copiedId === table.id;
                      return (
                        <div
                          key={table.id}
                          className={cn("overflow-hidden rounded-xl border border-line", !isIncluded && "bg-bone-deep/20")}
                        >
                          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-bone-deep/45 px-3 py-2.5">
                            <label className="flex cursor-pointer items-center gap-2">
                              <input
                                type="checkbox"
                                checked={isIncluded}
                                onChange={() => toggleIncluded(table.id)}
                                aria-label={`Export page ${table.page} table ${table.index + 1}`}
                                className="h-4 w-4 cursor-pointer rounded border-line accent-forest"
                              />
                              <span className="text-[12.5px] font-semibold">
                                Page {table.page} · Table {table.index + 1}
                              </span>
                            </label>
                            <Badge tone="forest">
                              {table.table.rowCount} × {table.table.columnCount}
                            </Badge>
                            <Badge tone={table.table.fillRatio >= 0.7 ? "neutral" : "clay"}>
                              {Math.round(table.table.fillRatio * 100)}% filled
                            </Badge>
                            {table.table.raggedRows > 0 && (
                              <Badge tone="clay">
                                {table.table.raggedRows} padded row{table.table.raggedRows === 1 ? "" : "s"}
                              </Badge>
                            )}
                            <div className="ml-auto flex items-center gap-1.5">
                              <Button variant="soft" size="sm" onClick={() => copyCsv(table)}>
                                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                                {copied ? "Copied" : "Copy CSV"}
                              </Button>
                              <Button variant="outline" size="sm" onClick={() => downloadCsv(table)}>
                                <Download className="h-3.5 w-3.5" /> CSV
                              </Button>
                            </div>
                          </div>
                          <div className="overflow-x-auto">
                            <table className="w-full border-collapse text-[11.5px]">
                              <tbody>
                                {previewRows.map((row, rowIndex) => (
                                  <tr key={rowIndex} className={rowIndex === 0 ? "bg-lime/15 font-medium" : "odd:bg-bone/40"}>
                                    {row.map((cell, cellIndex) => (
                                      <td
                                        key={cellIndex}
                                        className="max-w-[280px] truncate border-b border-line/70 px-2.5 py-1.5 text-ink/80"
                                      >
                                        {cell || <span className="text-ink/20">—</span>}
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          {table.table.rowCount > PREVIEW_ROWS && (
                            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-2">
                              <span className="text-[11px] text-muted">
                                Showing {previewRows.length} of {table.table.rowCount.toLocaleString()} rows
                                {table.table.rowCount > PREVIEW_ROWS_LIMIT
                                  ? ` · the CSV contains every row`
                                  : ""}
                              </span>
                              <Button variant="ghost" size="sm" onClick={() => toggleExpanded(table.id)}>
                                {isExpanded ? "Show fewer rows" : "Show more"}
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  <Alert tone="info" title="Check the preview before you export">
                    <ul className="list-disc space-y-0.5 pl-4">
                      <li>Tables come from the PDF text layer, so scanned pages must be OCR’d first.</li>
                      <li>Merged cells are flattened and wrapped cells may be joined or left on their own row.</li>
                      <li>Right-aligned numbers and unusual text encodings can shift a value by one column.</li>
                      <li>Rotated pages are skipped, and the text-layer reading order is not always the visual order.</li>
                    </ul>
                  </Alert>
                </>
              ) : (
                <>
                  <Alert tone="info" title="No tables found on these pages">
                    The text layer was read, but no block passed the table checks (at least 2 rows × 2 columns, mostly
                    filled). Running text, single-column layouts and images are skipped on purpose — nothing is invented.
                  </Alert>
                  <EmptyHint>
                    Scanned pages have no text layer: run{" "}
                    <a href="#/tool/ocr" className="font-semibold text-forest underline">
                      OCR PDF
                    </a>{" "}
                    first. You can also try{" "}
                    <a href="#/tool/pdf-to-excel" className="font-semibold text-forest underline">
                      PDF to Excel
                    </a>{" "}
                    or{" "}
                    <a href="#/tool/extract-text" className="font-semibold text-forest underline">
                      Extract text
                    </a>{" "}
                    for loosely structured pages.
                  </EmptyHint>
                  {scan.rejectedRegions > 0 && (
                    <p className="text-[11.5px] text-muted">
                      {scan.rejectedRegions} aligned block{scan.rejectedRegions === 1 ? "" : "s"} looked like a table but
                      had too many empty cells — try the Sensitive detection level.
                    </p>
                  )}
                </>
              )}
            </>
          )}

          {!scan && !busy && !error && (
            <EmptyHint>
              Choose pages and press <span className="font-semibold text-ink/80">Extract tables</span>. Columns are detected
              from where each cell starts, then checked against the rows below them. Only real, mostly-filled grids are
              offered for export.
            </EmptyHint>
          )}
        </>
      )}
    </div>
  );
}
