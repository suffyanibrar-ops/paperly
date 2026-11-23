import { Check, Copy, Download, FileSpreadsheet, Table2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { Alert, Badge, Button, EmptyHint, Field, Progress, Select, Switch } from "@/components/ui";
import { DownloadPanel, RangeField, SinglePdfInput } from "@/components/toolParts";
import { AdvancedOptions, OptionNote, OptionsGrid } from "@/components/AdvancedOptions";
import { copyText } from "@/lib/router";
import { baseName, describePages, downloadBytes, sanitizeName, zipAndDownload } from "@/lib/pdf";
import { describeJobTime, useJob } from "@/lib/job";
import { useDownloadShortcut, usePrimaryShortcut } from "@/lib/hotkeys";
import { useToolPreferences } from "@/lib/prefs";
import { downloadOutput } from "@/lib/output";
import { describePageQuery, parsePageQuery } from "@/lib/pageQuery";
import { friendlyProcessingError } from "@/lib/security";
import {
  TABLE_COUNT_CAP,
  TABLE_PAGE_CAP,
  detectPageTables,
  tableToCsv,
  tablesToZipEntries,
  type ExtractedTable,
  type Table,
  type TableDetectionOptions,
} from "@/lib/tables";
import { extractDocumentGeometry, type PageGeometry } from "@/lib/textItems";
import { useInitialFiles, usePdfFile } from "@/lib/usePdf";
import { cn } from "@/utils/cn";

type Sensitivity = "balanced" | "sensitive" | "strict";
type TableOutput = "csv" | "xlsx" | "json";

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

const OUTPUT_LABEL: Record<TableOutput, string> = { csv: "CSV", xlsx: "XLSX", json: "JSON" };
const OUTPUT_MIME: Record<TableOutput, string> = {
  csv: "text/csv;charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  json: "application/json",
};

const PREVIEW_ROWS = 40;
const PREVIEW_ROWS_LIMIT = 200;

interface ScanResult {
  tables: ExtractedTable[];
  rotatedPages: number[];
  rejectedRegions: number;
  capped: boolean;
}

interface Artifact {
  bytes: Uint8Array;
  name: string;
  mime: string;
}

function rotateList(pages: number[]): string {
  return pages.length > 10 ? `${pages.slice(0, 10).join(", ")} and ${pages.length - 10} more` : pages.join(", ");
}

/** Header row → named records; otherwise plain arrays. */
function tableRecords(table: Table): Record<string, string>[] {
  const [header, ...body] = table.rows;
  const keys = (header ?? []).map((cell, index) => {
    const cleaned = cell.trim();
    return cleaned || `Column ${index + 1}`;
  });
  const used = new Map<string, number>();
  const uniqueKeys = keys.map((key) => {
    const seen = (used.get(key) ?? 0) + 1;
    used.set(key, seen);
    return seen === 1 ? key : `${key} (${seen})`;
  });
  return body.map((row) => Object.fromEntries(uniqueKeys.map((key, index) => [key, row[index] ?? ""])));
}

function tableJson(table: Table, headerRow: boolean): unknown {
  return headerRow ? tableRecords(table) : table.rows;
}

function tableJsonText(table: Table, headerRow: boolean): string {
  return JSON.stringify(tableJson(table, headerRow), null, 2);
}

function sheetFromRows(rows: string[][], headerRow: boolean): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const columns = Math.max(1, rows[0]?.length ?? 1);
  ws["!cols"] = Array.from({ length: columns }, (_, ci) => {
    const longest = Math.max(...rows.map((row) => (row[ci] ?? "").length), 6);
    return { wch: Math.min(48, Math.max(9, longest + 2)) };
  });
  if (headerRow) {
    ws["!autofilter"] = {
      ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, rows.length - 1), c: columns - 1 } }),
    };
  }
  return ws;
}

function writeWorkbook(sheets: { name: string; rows: string[][] }[], headerRow: boolean): Uint8Array {
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  sheets.forEach((sheet, index) => {
    const base = (sheet.name || `Table ${index + 1}`).slice(0, 28);
    let name = base || `Table ${index + 1}`;
    let suffix = 2;
    while (used.has(name.toLowerCase())) {
      name = `${base.slice(0, 26)} ${suffix++}`;
    }
    used.add(name.toLowerCase());
    XLSX.utils.book_append_sheet(wb, sheetFromRows(sheet.rows, headerRow), name);
  });
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  return new Uint8Array(out);
}

/** The combined "all selected tables" file that DownloadPanel offers. */
async function buildArtifact(
  tables: ExtractedTable[],
  format: TableOutput,
  headerRow: boolean,
  quoteAll: boolean,
  stem: string,
): Promise<Artifact> {
  if (format === "csv") {
    const entries = tablesToZipEntries(
      tables.map((table) => ({ table: table.table, page: table.page, index: table.index })),
      { baseName: stem, quoteAll },
    );
    const zip = new JSZip();
    entries.forEach((entry) => zip.file(entry.name, entry.data));
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    return { bytes, name: `${stem}-tables.zip`, mime: "application/zip" };
  }
  if (format === "json") {
    const payload = {
      source: stem,
      generator: "Paperly PDF",
      headerRow,
      tables: tables.map((table) => ({ page: table.page, table: table.index + 1, rows: tableJson(table.table, headerRow) })),
    };
    return {
      bytes: new TextEncoder().encode(JSON.stringify(payload, null, 2)),
      name: `${stem}-tables.json`,
      mime: OUTPUT_MIME.json,
    };
  }
  return {
    bytes: writeWorkbook(
      tables.map((table) => ({ name: `P${table.page} T${table.index + 1}`, rows: table.table.rows })),
      headerRow,
    ),
    name: `${stem}-tables.xlsx`,
    mime: OUTPUT_MIME.xlsx,
  };
}

export function TablesToCsvTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const opts = useToolPreferences("tables-to-csv", {
    sensitivity: "balanced" as Sensitivity,
    mergeWrapped: true,
    format: "csv" as TableOutput,
    headerRow: true,
    quoteAll: false,
  });
  const [range, setRange] = useState("");
  const [notice, setNotice] = useState("");
  const [pages, setPages] = useState<PageGeometry[] | null>(null);
  const [scannedLabel, setScannedLabel] = useState("");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const job = useJob<null>();
  const runRef = useRef(0);

  const options = useMemo<TableDetectionOptions>(
    () => ({ ...DETECTION[opts.value.sensitivity], mergeWrappedLines: opts.value.mergeWrapped }),
    [opts.value.sensitivity, opts.value.mergeWrapped],
  );

  // Results belong to one file; a new file must never show stale tables.
  useEffect(() => {
    runRef.current += 1;
    job.reset();
    setPages(null);
    setScannedLabel("");
    setNotice("");
    setExcluded(new Set());
    setExpanded(new Set());
    setCopiedId(null);
    setArtifact(null);
    // `job.reset` is stable; only a new document should clear the scan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const format = opts.value.format;

  // The combined output is rebuilt whenever the selection or format changes.
  useEffect(() => {
    let alive = true;
    if (!included.length) {
      setArtifact(null);
      return () => {
        alive = false;
      };
    }
    (async () => {
      try {
        const built = await buildArtifact(included, format, opts.value.headerRow, opts.value.quoteAll, documentName);
        if (alive) setArtifact(built);
      } catch {
        if (alive) setArtifact(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [included, format, opts.value.headerRow, opts.value.quoteAll, documentName]);

  const extract = () => {
    if (!pdf.bytes || !pdf.file) return;
    const bytes = pdf.bytes;
    const total = pdf.pageCount;
    const run = runRef.current + 1;
    runRef.current = run;
    // The previous scan stays on screen until this one succeeds, so a cancel
    // never destroys a result the visitor already had.
    setScannedLabel("");
    setNotice("");
    setExcluded(new Set());
    setExpanded(new Set());
    setCopiedId(null);
    setArtifact(null);
    void (async () => {
      await job.run(async (reporter) => {
        const selected = parsePageQuery(range, total);
        const toScan = selected.slice(0, TABLE_PAGE_CAP);
        if (selected.length > TABLE_PAGE_CAP) {
          setNotice(
            `This run reads the first ${TABLE_PAGE_CAP} selected pages to keep the tab responsive. Split the PDF if the tables continue after that.`,
          );
        }
        reporter.report(2, "Reading the text layer…", describePageQuery(toScan, total));
        const geometry = await extractDocumentGeometry(bytes, {
          pages: toScan,
          onProgress: (done, count) => {
            reporter.throwIfCancelled();
            reporter.report(2 + (done / Math.max(1, count)) * 94, `Reading page ${done} of ${count}…`);
          },
        });
        const characters = geometry.pages.reduce(
          (sum, page) => sum + page.lines.reduce((count, line) => count + line.text.replace(/\s/g, "").length, 0),
          0,
        );
        if (characters < 20) {
          throw new Error(
            "No text layer found on the selected pages. Scanned pages need OCR first — run OCR PDF, then come back to extract its tables.",
          );
        }
        if (run !== runRef.current) return null;
        reporter.report(100, "Done");
        setScannedLabel(describePages(toScan, geometry.totalPages));
        setPages(geometry.pages);
        return null;
      });
    })();
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

  const fileFor = (table: ExtractedTable, extension: TableOutput) =>
    `${documentName}-p${table.page}-t${table.index + 1}.${extension}`;

  const tableBytes = (table: ExtractedTable): Uint8Array => {
    if (format === "json") return new TextEncoder().encode(tableJsonText(table.table, opts.value.headerRow));
    if (format === "xlsx") {
      return writeWorkbook([{ name: `Page ${table.page} T${table.index + 1}`, rows: table.table.rows }], opts.value.headerRow);
    }
    return new TextEncoder().encode(tableToCsv(table.table, { quoteAll: opts.value.quoteAll }));
  };

  const downloadTable = (table: ExtractedTable) => {
    downloadBytes(tableBytes(table), fileFor(table, format), OUTPUT_MIME[format]);
  };

  const copyTable = async (table: ExtractedTable) => {
    const copied = await copyText(
      format === "json" ? tableJsonText(table.table, opts.value.headerRow) : tableToCsv(table.table, { quoteAll: opts.value.quoteAll }),
    );
    if (!copied) return;
    setCopiedId(table.id);
    window.setTimeout(() => setCopiedId((current) => (current === table.id ? null : current)), 1800);
  };

  const downloadAll = async () => {
    if (!included.length) return;
    try {
      const entries = tablesToZipEntries(
        included.map((table) => ({ table: table.table, page: table.page, index: table.index })),
        { baseName: documentName, quoteAll: opts.value.quoteAll },
      );
      await zipAndDownload(
        entries.map((entry) => ({ name: entry.name, data: new Blob([entry.data], { type: "text/csv;charset=utf-8" }) })),
        `${documentName}-tables.zip`,
      );
    } catch (err) {
      setNotice(friendlyProcessingError(err, "Couldn’t build the ZIP archive. Try downloading the tables one by one."));
    }
  };

  const hasResult = Boolean(scan && scan.tables.length > 0);
  const canRun = Boolean(pdf.bytes) && !job.busy;

  usePrimaryShortcut(extract, canRun);
  useDownloadShortcut(
    () => {
      if (artifact) downloadOutput(artifact.bytes, artifact.name, artifact.mime);
      else if (included.length) void downloadAll();
    },
    Boolean(included.length),
  );

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
            <Field label="Detection level" hint="Strict only keeps clean, well-filled grids. Sensitive finds tables with gaps and missing cells.">
              <Select value={opts.value.sensitivity} onChange={(event) => opts.set("sensitivity", event.target.value as Sensitivity)}>
                <option value="balanced">Balanced (recommended)</option>
                <option value="sensitive">Sensitive — catch loose tables</option>
                <option value="strict">Strict — only clean tables</option>
              </Select>
            </Field>
          </div>
          <Switch
            checked={opts.value.mergeWrapped}
            onChange={(value) => opts.set("mergeWrapped", value)}
            label="Join wrapped cell lines"
            description="Re-joins a continuation line into the cell above, instead of turning it into a row with empty cells."
          />
          <AdvancedOptions scope="tables-to-csv" badge="3 controls" description="Output file, header row, quoting" onReset={opts.reset}>
            <OptionsGrid>
              <Field label="Output format" hint="CSV downloads one file per table; the combined download is a ZIP.">
                <Select value={format} onChange={(event) => opts.set("format", event.target.value as TableOutput)}>
                  <option value="csv">CSV — RFC 4180</option>
                  <option value="xlsx">Excel .xlsx</option>
                  <option value="json">JSON</option>
                </Select>
              </Field>
              <div className="pt-5">
                <Switch
                  label="First row is a header"
                  checked={opts.value.headerRow}
                  onChange={(value) => opts.set("headerRow", value)}
                  description="JSON uses it for field names and Excel gets a filter. CSV always keeps the row as it is."
                />
              </div>
              <div className="pt-5">
                <Switch
                  label="Quote every CSV field"
                  checked={opts.value.quoteAll}
                  onChange={(value) => opts.set("quoteAll", value)}
                  description="Wraps each cell in quotes. Off keeps the usual RFC 4180 quoting."
                />
              </div>
            </OptionsGrid>
            <div className="mt-3">
              <OptionNote>
                Detection never invents cells: only blocks with at least two rows and two columns that are mostly filled become
                tables.
              </OptionNote>
            </div>
          </AdvancedOptions>
          {notice && <Alert tone="warning">{notice}</Alert>}
          {job.failed && (
            <Alert tone="error">
              {job.error}{" "}
              {/OCR|scan/i.test(job.error) && (
                <a href="/ocr-pdf" className="font-semibold underline">
                  Open OCR PDF
                </a>
              )}
            </Alert>
          )}
          {job.status === "cancelled" && <Alert tone="info">Cancelled — nothing was downloaded. Your previous scan is unchanged.</Alert>}
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={extract} loading={job.busy} disabled={!canRun}>
              <Table2 className="h-4 w-4" /> Extract tables
            </Button>
            {job.busy && (
              <Button variant="ghost" onClick={job.cancel}>
                Cancel
              </Button>
            )}
            <span className="text-[11.5px] text-muted">Reads the real text layer · nothing is uploaded</span>
          </div>
          {job.busy && (
            <Progress value={job.percent ?? undefined} label={job.label} detail={describeJobTime(job)} etaMs={job.etaMs} />
          )}

          {scan && !job.busy && (
            <>
              {scan.rotatedPages.length > 0 && (
                <Alert tone="warning" title="Rotated pages were skipped">
                  Page{scan.rotatedPages.length === 1 ? "" : "s"} {rotateList(scan.rotatedPages)} are rotated, so column order
                  is unreliable. Use{" "}
                  <a href="/rotate" className="font-semibold underline">
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
                    <Badge tone="neutral">{format === "csv" ? "RFC 4180 · UTF-8" : format === "xlsx" ? "Excel workbook" : "JSON"}</Badge>
                    <div className="ml-auto flex flex-wrap items-center gap-1.5">
                      <Button size="sm" variant="outline" onClick={() => setExcluded(new Set())} disabled={!excluded.size}>
                        Select all
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setExcluded(new Set(scan.tables.map((table) => table.id)))}
                        disabled={!included.length}
                      >
                        Clear selection
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
                        <div key={table.id} className={cn("overflow-hidden rounded-xl border border-line", !isIncluded && "bg-bone-deep/20")}>
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
                              {format !== "xlsx" && (
                                <Button variant="soft" size="sm" onClick={() => void copyTable(table)}>
                                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                                  {copied ? "Copied" : `Copy ${OUTPUT_LABEL[format]}`}
                                </Button>
                              )}
                              <Button variant="outline" size="sm" onClick={() => downloadTable(table)}>
                                <Download className="h-3.5 w-3.5" /> {OUTPUT_LABEL[format]}
                              </Button>
                            </div>
                          </div>
                          <div className="overflow-x-auto">
                            <table className="w-full border-collapse text-[11.5px]">
                              <tbody>
                                {previewRows.map((row, rowIndex) => (
                                  <tr key={rowIndex} className={rowIndex === 0 && opts.value.headerRow ? "bg-lime/15 font-medium" : "odd:bg-bone/40"}>
                                    {row.map((cell, cellIndex) => (
                                      <td key={cellIndex} className="max-w-[280px] truncate border-b border-line/70 px-2.5 py-1.5 text-ink/80">
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
                                {table.table.rowCount > PREVIEW_ROWS_LIMIT ? ` · the download contains every row` : ""}
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

                  {artifact && (
                    <DownloadPanel
                      bytes={artifact.bytes}
                      title={`${included.length} table${included.length === 1 ? "" : "s"} ready`}
                      filename={artifact.name}
                      size={artifact.bytes.byteLength}
                      mime={artifact.mime}
                      handoffIds={[]}
                      onDownload={() => downloadOutput(artifact.bytes, artifact.name, artifact.mime)}
                      description={`${includedRows.toLocaleString()} rows · ${OUTPUT_LABEL[format]} · ${
                        format === "csv" ? "one file per table, zipped" : "one combined file"
                      }${scannedLabel ? ` · ${scannedLabel}` : ""}`}
                      facts={[
                        { label: "Format", value: OUTPUT_LABEL[format] },
                        { label: "Header row", value: opts.value.headerRow ? "Yes" : "No" },
                      ]}
                    />
                  )}

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
                    <a href="/ocr-pdf" className="font-semibold text-forest underline">
                      OCR PDF
                    </a>{" "}
                    first. You can also try{" "}
                    <a href="/pdf-to-excel" className="font-semibold text-forest underline">
                      PDF to Excel
                    </a>{" "}
                    or{" "}
                    <a href="/extract-text" className="font-semibold text-forest underline">
                      Extract text
                    </a>{" "}
                    for loosely structured pages.
                  </EmptyHint>
                  {scan.rejectedRegions > 0 && (
                    <p className="text-[11.5px] text-muted">
                      {scan.rejectedRegions} aligned block{scan.rejectedRegions === 1 ? "" : "s"} looked like a table but had too
                      many empty cells — try the Sensitive detection level.
                    </p>
                  )}
                </>
              )}
            </>
          )}

          {!scan && !job.busy && !job.failed && (
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
