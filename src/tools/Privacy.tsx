import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFContext,
  type PDFObject,
} from "@cantoo/pdf-lib";
import { Check, Download, EyeOff, FileSearch, FileText, Redo2, Search, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  baseName,
  dataUrlToBytes,
  degrees,
  downloadBytes,
  openPdfJs,
  openPdfLib,
  renderPdfPage,
  sanitizeName,
} from "@/lib/pdf";
import { friendlyProcessingError } from "@/lib/security";
import {
  PATTERN_PRESETS,
  buildRegex,
  countByPattern,
  findMatches,
  formatRedactionReport,
  presetLabel,
  resolveOverlaps,
  type PatternId,
  type PatternPreset,
} from "@/lib/redactPatterns";
import { boxToNormalized, charRangeBox, extractDocumentGeometry, type NormalizedBox, type TextLine } from "@/lib/textItems";
import { useInitialFiles, usePdfFile } from "@/lib/usePdf";
import { Alert, Badge, Button, ColorInput, Field, Progress, Select, Switch, inputClass } from "@/components/ui";
import { DownloadPanel, SinglePdfInput } from "@/components/toolParts";
import { cn } from "@/utils/cn";

/* ================================================================== *
 * Shared limits
 * ================================================================== */
const MAX_SCAN_PAGES = 300;
const MAX_MATCHES = 5_000;
const PREVIEW_WIDTH = 900;

const uploadPixelsToDpi = (dpi: number) => dpi / 72;

/* ================================================================== *
 * FIND & REDACT — pattern-based true redaction
 * ================================================================== */
interface DetectedMatch {
  id: string;
  page: number;
  preset: PatternId;
  label: string;
  value: string;
  /** Full line the match was found in, used for the context snippet. */
  lineText: string;
  startInLine: number;
  endInLine: number;
  /** 0–1 box against the unrotated page render. */
  box: NormalizedBox;
}

interface RedactResult {
  bytes: Uint8Array;
  name: string;
  sourceName: string;
  totalPages: number;
  scannedPages: number;
  redactedPages: number[];
  matchesRemoved: number;
  counts: Record<string, number>;
  pageCounts: { page: number; count: number }[];
}

/** Draw filled rectangles into the rendered page image. */
async function burnBoxesIntoImage(dataUrl: string, boxes: NormalizedBox[], color: string): Promise<string> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close?.();
    throw new Error("Your browser couldn’t prepare the redacted page image (canvas unavailable).");
  }
  context.drawImage(bitmap, 0, 0);
  context.fillStyle = color;
  for (const box of boxes) {
    context.fillRect(
      Math.round(box.x * canvas.width),
      Math.round(box.y * canvas.height),
      Math.max(1, Math.round(box.w * canvas.width)),
      Math.max(1, Math.round(box.h * canvas.height)),
    );
  }
  bitmap.close?.();
  const burned = canvas.toDataURL("image/jpeg", 0.92);
  canvas.width = 1;
  canvas.height = 1;
  return burned;
}

const defaultPresetToggles = (): Record<PatternId, boolean> => ({
  "credit-card": true,
  iban: true,
  email: true,
  ssn: true,
  phone: true,
  date: false,
  custom: false,
});

const snippetFor = (match: DetectedMatch, radius = 34) => {
  const line = match.lineText;
  const from = Math.max(0, match.startInLine - radius);
  const to = Math.min(line.length, match.endInLine + radius);
  return {
    before: `${from > 0 ? "…" : ""}${line.slice(from, match.startInLine)}`,
    after: `${line.slice(match.endInLine, to)}${to < line.length ? "…" : ""}`,
  };
};

function MatchSnippet({ match }: { match: DetectedMatch }) {
  const { before, after } = snippetFor(match);
  return (
    <span className="break-words font-mono text-[11px] leading-relaxed text-ink/70">
      {before}
      <mark className="rounded bg-lime/70 px-0.5 font-semibold text-ink">{match.value}</mark>
      {after}
    </span>
  );
}

export function FindRedactTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [enabledPresets, setEnabledPresets] = useState<Record<PatternId, boolean>>(defaultPresetToggles);
  const [customPattern, setCustomPattern] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [minLength, setMinLength] = useState(4);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [matches, setMatches] = useState<DetectedMatch[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanned, setScanned] = useState(false);
  const [scanNotes, setScanNotes] = useState<string[]>([]);
  const [previewPage, setPreviewPage] = useState(1);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [color, setColor] = useState("#000000");
  const [dpi, setDpi] = useState(150);
  const [busy, setBusy] = useState(false);
  const [applyProgress, setApplyProgress] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<RedactResult | null>(null);

  const pageLimit = Math.min(pdf.pageCount || 0, MAX_SCAN_PAGES);
  const customError = useMemo(() => {
    if (!enabledPresets.custom || !customPattern.trim()) return "";
    try {
      buildRegex("custom", { caseSensitive, wholeWord, customPattern });
      return "";
    } catch (err) {
      return (err as Error).message;
    }
  }, [enabledPresets.custom, customPattern, caseSensitive, wholeWord]);

  const pageGroups = useMemo(() => {
    const groups = new Map<number, DetectedMatch[]>();
    for (const match of matches) {
      const list = groups.get(match.page) ?? [];
      list.push(match);
      groups.set(match.page, list);
    }
    return [...groups.entries()]
      .map(([page, list]) => ({ page, matches: [...list].sort((a, b) => a.startInLine - b.startInLine) }))
      .sort((a, b) => a.page - b.page);
  }, [matches]);

  const countsByPattern = useMemo(() => countByPattern(matches), [matches]);
  const previewMatches = matches.filter((match) => match.page === previewPage);

  // A new file invalidates every previous scan and result.
  useEffect(() => {
    setMatches([]);
    setSelected(new Set());
    setScanned(false);
    setScanNotes([]);
    setPreview(null);
    setPreviewPage(1);
    setResult(null);
    setError("");
    setScanProgress(0);
    setApplyProgress(0);
  }, [pdf.bytes]);

  // Render the current preview page (unrotated, exactly like the burned image).
  useEffect(() => {
    if (!pdf.bytes || !scanned) {
      setPreview(null);
      return;
    }
    let alive = true;
    const bytes = pdf.bytes;
    setPreviewBusy(true);
    (async () => {
      const doc = await openPdfJs(bytes);
      try {
        const rendered = await renderPdfPage(doc, previewPage, { targetWidth: PREVIEW_WIDTH, quality: 0.86, rotation: 0 });
        if (alive) setPreview(rendered.dataUrl);
      } finally {
        await doc.destroy();
      }
    })()
      .catch(() => {
        if (alive) setPreview(null);
      })
      .finally(() => {
        if (alive) setPreviewBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [pdf.bytes, previewPage, scanned]);

  const togglePreset = (id: PatternId) => setEnabledPresets((previous) => ({ ...previous, [id]: !previous[id] }));

  const toggleMatch = (id: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const scan = async () => {
    if (!pdf.bytes || !pdf.file || scanning || busy) return;
    const activePresets: PatternPreset[] = PATTERN_PRESETS.filter(
      (preset) => preset.id !== "custom" && enabledPresets[preset.id],
    );
    const customPreset = PATTERN_PRESETS.find((preset) => preset.id === "custom");
    if (enabledPresets.custom && customPreset) activePresets.push(customPreset);
    if (!activePresets.length) {
      setError("Choose at least one pattern to look for.");
      return;
    }

    let scanners: { preset: PatternPreset; regex: RegExp }[];
    try {
      scanners = activePresets.map((preset) => ({
        preset,
        regex: buildRegex(preset.id, { caseSensitive, wholeWord, customPattern }),
      }));
    } catch (err) {
      setError((err as Error).message);
      return;
    }

    setScanning(true);
    setError("");
    setResult(null);
    setMatches([]);
    setSelected(new Set());
    setScanned(false);
    setScanNotes([]);
    setScanProgress(0);

    const notes: string[] = [];
    try {
      const pages = Array.from({ length: pageLimit }, (_, index) => index + 1);
      if (pdf.pageCount > MAX_SCAN_PAGES) {
        notes.push(
          `This PDF has ${pdf.pageCount} pages. Pattern scanning is capped at ${MAX_SCAN_PAGES} pages per run to keep your browser responsive, so only the first ${MAX_SCAN_PAGES} pages were searched. Split the file to cover the rest.`,
        );
      }
      const geometry = await extractDocumentGeometry(pdf.bytes, {
        pages,
        onProgress: (done, total) => setScanProgress((done / Math.max(1, total)) * 70),
      });

      const found: DetectedMatch[] = [];
      let truncated = false;
      let textCharacters = 0;
      for (let pageIndex = 0; pageIndex < geometry.pages.length && !truncated; pageIndex++) {
        const page = geometry.pages[pageIndex];
        for (const line of page.lines) {
          textCharacters += line.text.length;
          if (!line.text) continue;
          const candidates: { start: number; end: number; preset: PatternPreset }[] = [];
          for (const { preset, regex } of scanners) {
            for (const hit of findMatches(line.text, regex)) {
              if (hit.value.length < minLength) continue;
              if (!preset.validate || preset.validate(hit.value)) {
                candidates.push({ start: hit.start, end: hit.end, preset });
              }
            }
          }
          const accepted = resolveOverlaps(
            candidates.map((candidate) => ({ ...candidate, priority: candidate.preset.priority })),
          ).sort((a, b) => a.start - b.start);
          for (const hit of accepted) {
            const box = charRangeBox(line as TextLine, hit.start, hit.end);
            if (!box) continue;
            found.push({
              id: `match-${found.length}`,
              page: page.page,
              preset: hit.preset.id,
              label: hit.preset.label,
              value: line.text.slice(hit.start, hit.end),
              lineText: line.text,
              startInLine: hit.start,
              endInLine: hit.end,
              box: boxToNormalized(box, page.width, page.height),
            });
            if (found.length >= MAX_MATCHES) {
              truncated = true;
              break;
            }
          }
          if (truncated) break;
        }
        setScanProgress(70 + ((pageIndex + 1) / Math.max(1, geometry.pages.length)) * 30);
      }

      if (truncated) {
        notes.push(
          `Stopped after ${MAX_MATCHES.toLocaleString()} matches to keep the list manageable. Narrow the patterns, raise the minimum length, or scan fewer pages to see the rest.`,
        );
      }
      if (textCharacters === 0) {
        notes.push(
          "No text layer was found on the scanned pages. This looks like a scanned document — run OCR PDF first, then search it here.",
        );
      }
      setMatches(found);
      setSelected(new Set(found.map((match) => match.id)));
      setScanNotes(notes);
      setScanned(true);
      setPreviewPage(found[0]?.page ?? 1);
      setScanProgress(100);
    } catch (err) {
      setError(friendlyProcessingError(err, "We couldn’t search this PDF. Try again with fewer pages."));
    } finally {
      setScanning(false);
    }
  };

  const applyRedactions = async () => {
    if (!pdf.bytes || !pdf.file || busy) return;
    const chosen = matches.filter((match) => selected.has(match.id));
    if (!chosen.length) {
      setError("Select at least one match to redact.");
      return;
    }
    setBusy(true);
    setError("");
    setResult(null);
    setApplyProgress(0);

    const boxesByPage = new Map<number, NormalizedBox[]>();
    const countsByPage = new Map<number, number>();
    for (const match of chosen) {
      const list = boxesByPage.get(match.page) ?? [];
      list.push(match.box);
      boxesByPage.set(match.page, list);
      countsByPage.set(match.page, (countsByPage.get(match.page) ?? 0) + 1);
    }

    try {
      const source = await openPdfLib(pdf.bytes);
      const output = await PDFDocument.create();
      const pdfjsDocument = await openPdfJs(pdf.bytes);
      try {
        const sourcePages = source.getPages();
        for (let index = 0; index < sourcePages.length; index++) {
          const boxes = boxesByPage.get(index + 1);
          if (boxes?.length) {
            const original = sourcePages[index];
            const { width, height } = original.getSize();
            const rendered = await renderPdfPage(pdfjsDocument, index + 1, {
              scale: uploadPixelsToDpi(dpi),
              type: "image/jpeg",
              quality: 0.92,
              rotation: 0,
            });
            const burned = await burnBoxesIntoImage(rendered.dataUrl, boxes, color);
            const page = output.addPage([width, height]);
            const rotation = original.getRotation().angle;
            if (rotation) page.setRotation(degrees(rotation));
            const image = await output.embedJpg(dataUrlToBytes(burned));
            page.drawImage(image, { x: 0, y: 0, width, height });
          } else {
            const [copied] = await output.copyPages(source, [index]);
            output.addPage(copied);
          }
          setApplyProgress(((index + 1) / sourcePages.length) * 92);
        }

        const bytes = await output.save();
        // Self-verify: the rebuilt file must load and keep every page before we offer it.
        const verified = await openPdfLib(bytes);
        if (verified.getPageCount() !== sourcePages.length) {
          throw new Error(
            "The rebuilt PDF didn’t keep every page, so nothing was offered for download. Try a different output resolution and apply again.",
          );
        }

        const counts = countByPattern(chosen);
        const pageCounts = [...countsByPage.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([page, count]) => ({ page, count }));
        setResult({
          bytes,
          name: `${sanitizeName(baseName(pdf.file.name))}-redacted.pdf`,
          sourceName: pdf.file.name,
          totalPages: pdf.pageCount,
          scannedPages: pageLimit,
          redactedPages: [...boxesByPage.keys()].sort((a, b) => a - b),
          matchesRemoved: chosen.length,
          counts,
          pageCounts,
        });
        setApplyProgress(100);
      } finally {
        await pdfjsDocument.destroy();
      }
    } catch (err) {
      setError(friendlyProcessingError(err, "We couldn’t redact this PDF. Try a lower output resolution."));
    } finally {
      setBusy(false);
    }
  };

  const downloadRedactionReport = () => {
    if (!result) return;
    const report = formatRedactionReport({
      fileName: result.sourceName,
      totalPages: result.totalPages,
      pagesScanned: result.scannedPages,
      pagesAffected: result.redactedPages,
      matchesRemoved: result.matchesRemoved,
      counts: result.counts,
      pageCounts: result.pageCounts,
      generatedAt: new Date(),
    });
    downloadBytes(
      new Uint8Array(new TextEncoder().encode(report)),
      `${sanitizeName(baseName(result.sourceName))}-redaction-report.txt`,
      "text/plain",
    );
  };

  const selectedCount = selected.size;

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to search for sensitive data" />

      {pdf.bytes && (
        <>
          <div className="rounded-xl border border-clay/20 bg-clay/[0.05] p-3.5">
            <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[#b14425]">
              <EyeOff className="h-4 w-4" /> Real redaction, not black rectangles drawn on top
            </p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-ink/70">
              Selected pages are rebuilt as images with the match boxes burned into the pixels, so the text underneath is genuinely gone. Pages with no
              selected matches are copied unchanged and keep their selectable text. Nothing is uploaded — the search and the rebuild happen in this tab.
            </p>
          </div>

          <div className="rounded-xl border border-line bg-paper p-3.5">
            <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">
              <Search className="h-3.5 w-3.5 text-forest" /> What to look for
            </p>
            <div className="flex flex-wrap gap-1.5">
              {PATTERN_PRESETS.map((preset) => {
                const active = enabledPresets[preset.id];
                return (
                  <button
                    key={preset.id}
                    type="button"
                    aria-pressed={active}
                    title={preset.description}
                    onClick={() => togglePreset(preset.id)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors",
                      active
                        ? "border-forest bg-forest text-paper"
                        : "border-line bg-paper text-ink/70 hover:border-forest/30 hover:bg-bone-deep/40",
                    )}
                  >
                    {active && <Check className="h-3 w-3" />}
                    {preset.shortLabel}
                  </button>
                );
              })}
            </div>

            {enabledPresets.custom && (
              <div className="mt-3">
                <Field
                  label="Custom regular expression"
                  htmlFor="custom-redact-pattern"
                  hint="JavaScript syntax, e.g. EMP-\\d{6}. Case-insensitive unless you choose otherwise."
                >
                  <input
                    id="custom-redact-pattern"
                    value={customPattern}
                    onChange={(event) => setCustomPattern(event.target.value)}
                    placeholder="EMP-\\d{6}"
                    className={inputClass}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
                {customError && <p className="mt-1 text-[11.5px] font-medium text-clay-ink">{customError}</p>}
              </div>
            )}

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <Switch
                checked={caseSensitive}
                onChange={setCaseSensitive}
                label="Case sensitive"
                description="Off by default so JANE@EXAMPLE.COM is still found."
              />
              <Switch
                checked={wholeWord}
                onChange={setWholeWord}
                label="Whole words only"
                description="Skips matches glued to surrounding letters."
              />
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <Field label="Minimum match length" hint="Shorter hits are ignored to reduce noise.">
                <Select value={minLength} onChange={(event) => setMinLength(Number(event.target.value))}>
                  {[3, 4, 6, 8, 10, 12, 16].map((value) => (
                    <option key={value} value={value}>
                      {value} characters
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex items-end">
                <Button onClick={scan} loading={scanning} disabled={Boolean(customError) || scanning || busy}>
                  <Search className="h-4 w-4" /> Find matches
                </Button>
              </div>
            </div>
          </div>

          {pdf.pageCount > MAX_SCAN_PAGES && (
            <Alert tone="warning" title="Large document">
              This PDF has {pdf.pageCount} pages. Pattern scanning is capped at {MAX_SCAN_PAGES} pages per run, so only the first {MAX_SCAN_PAGES}{" "}
              pages will be searched. Split the file to redact the rest.
            </Alert>
          )}

          {scanning && <Progress value={scanProgress} label="Reading the text layer and matching patterns…" />}
          {error && <Alert tone="error">{error}</Alert>}

          {scanned && !matches.length && (
            <Alert tone="info" title="No matches found">
              Nothing matched the selected patterns on the pages that were searched. Scanned pages have no text layer to search — OCR them first, or use
              Redact PDF and drag boxes manually.
            </Alert>
          )}

          {scanNotes.map((note) => (
            <Alert key={note} tone="warning">
              {note}
            </Alert>
          ))}

          {scanned && matches.length > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="clay">
                  {matches.length.toLocaleString()} match{matches.length === 1 ? "" : "es"}
                </Badge>
                <Badge tone="forest">{selectedCount} selected</Badge>
                {Object.entries(countsByPattern).map(([presetId, count]) => (
                  <span key={presetId} className="inline-flex items-center gap-1 rounded-full border border-line bg-bone px-2.5 py-1 text-[11px] font-medium text-ink/70">
                    {presetLabel(presetId)}
                    <span className="font-semibold tabular-nums text-ink">{count}</span>
                  </span>
                ))}
              </div>

              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
                <div className="min-w-0">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-bone-deep/40 px-2.5 py-1.5">
                    <p className="text-[11.5px] font-medium text-ink/70">
                      {pageGroups.length} page{pageGroups.length === 1 ? "" : "s"} with matches · open a page to preview the boxes
                    </p>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setSelected(new Set(matches.map((match) => match.id)))}>
                        Select all
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())} disabled={!selectedCount}>
                        Clear
                      </Button>
                    </div>
                  </div>

                  <div className="max-h-[520px] space-y-3 overflow-y-auto rounded-xl border border-line bg-bone-deep/20 p-2 scrollbar-thin">
                    {pageGroups.map((group) => (
                      <div key={group.page} className="overflow-hidden rounded-lg border border-line bg-paper">
                        <button
                          type="button"
                          onClick={() => setPreviewPage(group.page)}
                          className={cn(
                            "flex w-full items-center justify-between gap-2 border-b border-line px-3 py-2 text-left transition-colors",
                            previewPage === group.page ? "bg-lime/25" : "bg-bone-deep/40 hover:bg-bone-deep/60",
                          )}
                        >
                          <span className="flex items-center gap-1.5 text-[12px] font-semibold">
                            <FileSearch className="h-3.5 w-3.5 text-forest" /> Page {group.page}
                          </span>
                          <span className="text-[10.5px] font-medium text-muted">
                            {group.matches.length} match{group.matches.length === 1 ? "" : "es"}
                          </span>
                        </button>
                        <ul className="divide-y divide-line/70">
                          {group.matches.map((match) => (
                            <li key={match.id} className="flex items-start gap-2.5 px-3 py-2">
                              <input
                                type="checkbox"
                                className="mt-0.5 h-4 w-4 shrink-0 accent-forest"
                                checked={selected.has(match.id)}
                                onChange={() => toggleMatch(match.id)}
                                aria-label={`Include ${match.label} on page ${match.page}`}
                              />
                              <label className="min-w-0 flex-1 cursor-pointer" onClick={() => setPreviewPage(match.page)}>
                                <span className="mb-0.5 flex items-center gap-1.5">
                                  <span className="rounded border border-clay/20 bg-clay/[0.07] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.06em] text-clay-ink">
                                    {match.label}
                                  </span>
                                </span>
                                <MatchSnippet match={match} />
                              </label>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>

                  <div className="mt-3 rounded-xl border border-line bg-paper p-3.5">
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">Redaction output</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Box colour">
                        <ColorInput value={color} onChange={setColor} label="Redaction box colour" />
                      </Field>
                      <Field label="Output resolution" hint="Higher keeps legible text around the redactions; files get larger.">
                        <Select value={dpi} onChange={(event) => setDpi(Number(event.target.value))}>
                          <option value={110}>Standard · 110 DPI</option>
                          <option value={150}>High · 150 DPI</option>
                          <option value={220}>Print · 220 DPI</option>
                          <option value={300}>Maximum · 300 DPI</option>
                        </Select>
                      </Field>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button onClick={applyRedactions} loading={busy} disabled={!selectedCount || busy || scanning}>
                        <EyeOff className="h-4 w-4" /> Apply {selectedCount} redaction{selectedCount === 1 ? "" : "s"}
                      </Button>
                      <span className="text-[11.5px] text-muted">
                        {pageGroups.filter((group) => group.matches.some((match) => selected.has(match.id))).length} page
                        {pageGroups.filter((group) => group.matches.some((match) => selected.has(match.id))).length === 1 ? "" : "s"} will be flattened
                      </span>
                    </div>
                    {busy && <div className="mt-3"><Progress value={applyProgress} label="Rasterising pages and burning the boxes into the image…" /></div>}
                  </div>
                </div>

                <aside className="min-w-0">
                  <div className="rounded-xl border border-line bg-paper p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">Page preview</p>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={previewPage <= 1}
                          onClick={() => setPreviewPage((page) => Math.max(1, page - 1))}
                          aria-label="Previous page"
                        >
                          <Redo2 className="h-3.5 w-3.5 -scale-x-100" />
                        </Button>
                        <span className="min-w-[58px] text-center text-[11px] font-medium tabular-nums text-ink/70">
                          {previewPage} / {pdf.pageCount}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={previewPage >= pdf.pageCount}
                          onClick={() => setPreviewPage((page) => Math.min(pdf.pageCount, page + 1))}
                          aria-label="Next page"
                        >
                          <Redo2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    <div className="relative w-full overflow-hidden rounded-sm border border-line bg-white pdf-page-shadow">
                      {preview ? (
                        <>
                          <img src={preview} alt={`Preview of page ${previewPage}`} className="pointer-events-none block w-full" draggable={false} />
                          {previewMatches.map((match) => (
                            <span
                              key={match.id}
                              className={cn(
                                "pointer-events-none absolute border",
                                selected.has(match.id) ? "border-clay bg-clay/35" : "border-clay/60 bg-clay/10",
                              )}
                              style={{
                                left: `${match.box.x * 100}%`,
                                top: `${match.box.y * 100}%`,
                                width: `${match.box.w * 100}%`,
                                height: `${match.box.h * 100}%`,
                              }}
                            />
                          ))}
                        </>
                      ) : (
                        <div className="flex aspect-[3/4] items-center justify-center text-[12px] text-ink/70">
                          {previewBusy ? "Rendering page…" : "No preview"}
                        </div>
                      )}
                    </div>
                    <p className="mt-2 text-[11px] leading-relaxed text-muted">
                      Filled boxes are selected for burning; faint boxes are matches you deselected. The exported page is flattened — the highlights are only
                      a preview.
                    </p>
                  </div>

                  <div className="mt-3 rounded-xl border border-forest/15 bg-lime/20 p-3 text-[11.5px] leading-relaxed text-forest">
                    <p className="flex items-center gap-1.5 font-semibold">
                      <ShieldCheck className="h-3.5 w-3.5" /> Verify before sharing
                    </p>
                    <p className="mt-1">
                      Open the download and try to select the redacted text: flattened pages have no extractable text at all. Always keep the unredacted original
                      in a safe place.
                    </p>
                  </div>
                </aside>
              </div>
            </>
          )}

          {result && (
            <div className="space-y-3">
              <DownloadPanel
                bytes={result.bytes}
                title="Redactions applied"
                filename={result.name}
                size={result.bytes.byteLength}
                pages={result.totalPages}
                onDownload={() => downloadBytes(result.bytes, result.name)}
                description={`${result.redactedPages.length} page${result.redactedPages.length === 1 ? "" : "s"} flattened · ${result.matchesRemoved} match${
                  result.matchesRemoved === 1 ? "" : "es"
                } permanently removed · ${result.totalPages - result.redactedPages.length} page${
                  result.totalPages - result.redactedPages.length === 1 ? "" : "s"
                } kept with selectable text`}
              />
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-paper p-3">
                <Button variant="outline" size="sm" onClick={downloadRedactionReport}>
                  <Download className="h-3.5 w-3.5" /> Download redaction report (.txt)
                </Button>
                <span className="text-[11.5px] text-muted">Counts by pattern and page — never the matched values.</span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ================================================================== *
 * SANITIZE PDF — low-level removal of metadata and active content
 * ================================================================== */
type SanitizeGroupId =
  | "scripts"
  | "attachments"
  | "metadata"
  | "annotations"
  | "forms"
  | "layers"
  | "thumbnails"
  | "signatures";

interface SanitizeGroupSpec {
  id: SanitizeGroupId;
  label: string;
  description: string;
}

const SANITIZE_GROUPS: readonly SanitizeGroupSpec[] = [
  {
    id: "scripts",
    label: "JavaScript & automatic actions",
    description: "OpenAction, additional-actions dictionaries (AA), document JavaScript and AcroForm actions.",
  },
  {
    id: "attachments",
    label: "Embedded files & attachments",
    description: "Files attached inside the PDF, found through the EmbeddedFiles name tree.",
  },
  {
    id: "metadata",
    label: "Document metadata",
    description: "Info dictionary entries (title, author, producer…) and the XMP metadata packet.",
  },
  {
    id: "annotations",
    label: "Annotations & comments",
    description: "Sticky notes, markups, links and other annotations drawn on pages.",
  },
  {
    id: "forms",
    label: "Form fields (AcroForm)",
    description: "Field definitions, their values, widget annotations and XFA data.",
  },
  {
    id: "layers",
    label: "Optional content (hidden layers)",
    description: "Layer definitions and the default visibility configuration.",
  },
  {
    id: "thumbnails",
    label: "Page thumbnails",
    description: "Embedded preview images attached to page objects.",
  },
  {
    id: "signatures",
    label: "Signature fields",
    description: "Signature fields, their signature dictionaries and catalog signature permissions.",
  },
];

type SanitizeOptions = Record<SanitizeGroupId, boolean>;

const DEFAULT_SANITIZE_OPTIONS: SanitizeOptions = {
  scripts: true,
  attachments: true,
  metadata: true,
  annotations: true,
  forms: true,
  layers: true,
  thumbnails: true,
  signatures: true,
};

interface SanitizeFinding {
  id: SanitizeGroupId;
  label: string;
  found: number;
  removed: number;
  details: string[];
}

interface SanitizeResult {
  bytes: Uint8Array;
  name: string;
  sourceName: string;
  totalPages: number;
  findings: SanitizeFinding[];
  foundTotal: number;
  removedTotal: number;
}

interface FormInventoryEntry {
  ref: PDFRef;
  name: string;
  type: string;
}

const EMPTY_SKIP_KEYS: ReadonlySet<string> = new Set();
const ANNOTATION_SKIP_KEYS: ReadonlySet<string> = new Set(["/P", "/Parent", "/Resources"]);

function lookupDict(context: PDFContext, object: PDFObject | undefined): PDFDict | undefined {
  if (object instanceof PDFDict) return object;
  if (object instanceof PDFRef) {
    const resolved = context.lookup(object);
    return resolved instanceof PDFDict ? resolved : undefined;
  }
  return undefined;
}

function lookupArray(context: PDFContext, object: PDFObject | undefined): PDFArray | undefined {
  if (object instanceof PDFArray) return object;
  if (object instanceof PDFRef) {
    const resolved = context.lookup(object);
    return resolved instanceof PDFArray ? resolved : undefined;
  }
  return undefined;
}

function decodePdfText(object: PDFObject | undefined): string {
  if (object instanceof PDFString || object instanceof PDFHexString) {
    try {
      return object.decodeText();
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * Collect every indirect object reachable from `object`, including the root
 * ref itself. `skipKeys` keeps us from following links to pages (which must
 * never be deleted) or shared resource dictionaries.
 */
function collectGraphRefs(
  context: PDFContext,
  object: PDFObject | undefined,
  output: PDFRef[] = [],
  seen = new Set<number>(),
  depth = 0,
  skipKeys: ReadonlySet<string> = EMPTY_SKIP_KEYS,
): PDFRef[] {
  if (!object || depth > 12) return output;
  if (object instanceof PDFRef) {
    if (seen.has(object.objectNumber)) return output;
    seen.add(object.objectNumber);
    output.push(object);
    collectGraphRefs(context, context.lookup(object), output, seen, depth + 1, skipKeys);
    return output;
  }
  if (object instanceof PDFDict) {
    for (const [key, value] of object.entries()) {
      if (skipKeys.has(key.asString())) continue;
      collectGraphRefs(context, value, output, seen, depth + 1, skipKeys);
    }
  } else if (object instanceof PDFArray) {
    for (const value of object.asArray()) collectGraphRefs(context, value, output, seen, depth + 1, skipKeys);
  } else if (object instanceof PDFStream) {
    collectGraphRefs(context, object.dict, output, seen, depth + 1, skipKeys);
  }
  return output;
}

function deleteGraph(context: PDFContext, object: PDFObject | undefined, skipKeys: ReadonlySet<string> = EMPTY_SKIP_KEYS): void {
  for (const ref of collectGraphRefs(context, object, [], new Set(), 0, skipKeys)) context.delete(ref);
}

function annotationSubtype(context: PDFContext, object: PDFObject | undefined): string {
  const dict = lookupDict(context, object);
  const subtype = dict?.get(PDFName.of("Subtype"));
  return subtype instanceof PDFName ? subtype.asString() : "";
}

function isWidget(context: PDFContext, object: PDFObject | undefined): boolean {
  return annotationSubtype(context, object) === "/Widget";
}

function countNameTree(context: PDFContext, node: PDFObject | undefined, depth = 0): number {
  const dict = lookupDict(context, node);
  if (!dict || depth > 8) return 0;
  let count = 0;
  const pairs = lookupArray(context, dict.get(PDFName.of("Names")));
  if (pairs) count += Math.floor(pairs.size() / 2);
  const kids = lookupArray(context, dict.get(PDFName.of("Kids")));
  if (kids) {
    for (let index = 0; index < kids.size(); index++) count += countNameTree(context, kids.get(index), depth + 1);
  }
  return count;
}

function collectNameTree(
  context: PDFContext,
  node: PDFObject | undefined,
  names: string[],
  refs: PDFRef[],
  depth = 0,
): number {
  const dict = lookupDict(context, node);
  if (!dict || depth > 8) return 0;
  let count = 0;
  const pairs = lookupArray(context, dict.get(PDFName.of("Names")));
  if (pairs) {
    for (let index = 0; index + 1 < pairs.size(); index += 2) {
      count += 1;
      const name = decodePdfText(pairs.get(index));
      if (name) names.push(name);
      const value = pairs.get(index + 1);
      if (value instanceof PDFRef) refs.push(value);
      const filespec = lookupDict(context, value);
      const embedded = filespec ? lookupDict(context, filespec.get(PDFName.of("EF"))) : undefined;
      if (embedded) {
        for (const key of ["F", "UF"]) {
          const streamRef = embedded.get(PDFName.of(key));
          if (streamRef instanceof PDFRef) refs.push(streamRef);
        }
      }
    }
  }
  const kids = lookupArray(context, dict.get(PDFName.of("Kids")));
  if (kids) {
    for (let index = 0; index < kids.size(); index++) count += collectNameTree(context, kids.get(index), names, refs, depth + 1);
  }
  return count;
}

function inventoryForm(doc: PDFDocument, acroDict: PDFDict | undefined): FormInventoryEntry[] {
  const entries: FormInventoryEntry[] = [];
  try {
    const form = doc.catalog.getAcroForm();
    if (form) {
      for (const [field, ref] of form.getFields()) {
        let name = "";
        let type = "";
        try {
          name = field.getFullyQualifiedName() ?? "";
        } catch {
          name = "";
        }
        try {
          const fieldType = field.getInheritableAttribute(PDFName.of("FT"));
          type = fieldType instanceof PDFName ? fieldType.asString() : "";
        } catch {
          type = "";
        }
        entries.push({ ref, name, type });
      }
    }
  } catch {
    /* malformed form: fall back to the raw Fields array below */
  }
  if (!entries.length && acroDict) {
    const fields = lookupArray(doc.context, acroDict.get(PDFName.of("Fields")));
    if (fields) {
      for (let index = 0; index < fields.size(); index++) {
        const item = fields.get(index);
        if (!(item instanceof PDFRef)) continue;
        const dict = lookupDict(doc.context, item);
        entries.push({
          ref: item,
          name: decodePdfText(dict?.get(PDFName.of("T"))),
          type: (() => {
            const fieldType = dict?.get(PDFName.of("FT"));
            return fieldType instanceof PDFName ? fieldType.asString() : "";
          })(),
        });
      }
    }
  }
  return entries;
}

const detailLine = (details: string[], line: string) => {
  if (line.trim()) details.push(line);
};

/**
 * Remove the selected document-level structures, save, then reload the saved
 * bytes and confirm every selected structure is genuinely absent.
 */
async function sanitizePdf(
  bytes: ArrayBuffer | Uint8Array,
  options: SanitizeOptions,
  onProgress: (value: number) => void,
): Promise<Omit<SanitizeResult, "name" | "sourceName">> {
  const pause = async (value: number) => {
    onProgress(value);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const doc = await openPdfLib(bytes);
  const context = doc.context;
  const catalog = doc.catalog;

  await pause(8);

  // Inventory everything before the first deletion.
  const acroDict = catalog.AcroForm();
  const formEntries = inventoryForm(doc, acroDict);
  const signatureEntries = formEntries.filter((entry) => entry.type === "/Sig");
  const fieldRefs = formEntries.map((entry) => entry.ref);
  const signatureRefs = signatureEntries.map((entry) => entry.ref);
  const namesObject = catalog.get(PDFName.of("Names"));
  const namesDict = catalog.Names();
  let namesDetached = false;
  const detachNamesIfEmpty = () => {
    if (namesDetached || !namesDict || namesDict.keys().length > 0) return;
    catalog.delete(PDFName.of("Names"));
    deleteGraph(context, namesObject);
    namesDetached = true;
  };

  let annotationCount = 0;
  let widgetCount = 0;
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    annotationCount += annots.size();
    for (let index = 0; index < annots.size(); index++) {
      if (isWidget(context, annots.get(index))) widgetCount += 1;
    }
  }

  const findings: SanitizeFinding[] = [];
  const addFinding = (id: SanitizeGroupId, found: number, removed: number, details: string[]) => {
    findings.push({ id, label: SANITIZE_GROUPS.find((group) => group.id === id)!.label, found, removed, details });
  };

  /* ----------------------------- scripts ----------------------------- */
  const scriptDetails: string[] = [];
  const jsTree = namesDict?.get(PDFName.of("JavaScript"));
  const jsCount = jsTree ? countNameTree(context, jsTree) : 0;
  const catalogOpenAction = catalog.get(PDFName.of("OpenAction"));
  const catalogActions = catalog.get(PDFName.of("AA"));
  const acroActions = acroDict?.get(PDFName.of("AA"));
  const pagesWithActions: { page: number; value: PDFObject | undefined }[] = [];
  for (let index = 0; index < doc.getPages().length; index++) {
    const page = doc.getPages()[index];
    if (page.node.has(PDFName.of("AA"))) pagesWithActions.push({ page: index + 1, value: page.node.get(PDFName.of("AA")) });
  }
  const scriptsFound =
    (jsCount ? jsCount : 0) +
    (catalogOpenAction !== undefined ? 1 : 0) +
    (catalogActions !== undefined ? 1 : 0) +
    (acroActions !== undefined ? 1 : 0) +
    pagesWithActions.length;
  if (jsCount) detailLine(scriptDetails, `${jsCount} document JavaScript action${jsCount === 1 ? "" : "s"}`);
  if (catalogOpenAction !== undefined) detailLine(scriptDetails, "Catalog open action");
  if (catalogActions !== undefined) detailLine(scriptDetails, "Catalog additional-actions dictionary (AA)");
  if (acroActions !== undefined) detailLine(scriptDetails, "AcroForm additional-actions dictionary");
  if (pagesWithActions.length) {
    detailLine(scriptDetails, `${pagesWithActions.length} page${pagesWithActions.length === 1 ? "" : "s"} with additional actions`);
  }
  if (options.scripts && scriptsFound) {
    catalog.delete(PDFName.of("OpenAction"));
    deleteGraph(context, catalogOpenAction);
    catalog.delete(PDFName.of("AA"));
    deleteGraph(context, catalogActions);
    if (acroDict) {
      acroDict.delete(PDFName.of("AA"));
      deleteGraph(context, acroActions);
    }
    if (namesDict && jsTree !== undefined) {
      namesDict.delete(PDFName.of("JavaScript"));
      deleteGraph(context, jsTree);
      detachNamesIfEmpty();
    }
    for (const entry of pagesWithActions) {
      const page = doc.getPages()[entry.page - 1];
      page.node.delete(PDFName.of("AA"));
      deleteGraph(context, entry.value);
    }
  }
  addFinding("scripts", scriptsFound, options.scripts ? scriptsFound : 0, scriptDetails);
  await pause(20);

  /* --------------------------- attachments --------------------------- */
  const attachmentNames: string[] = [];
  const attachmentRefs: PDFRef[] = [];
  const embeddedRoot = namesDict?.get(PDFName.of("EmbeddedFiles"));
  if (embeddedRoot instanceof PDFRef) attachmentRefs.push(embeddedRoot);
  const attachmentCount = embeddedRoot ? collectNameTree(context, embeddedRoot, attachmentNames, attachmentRefs) : 0;
  const attachmentDetails: string[] = [];
  if (attachmentCount) {
    detailLine(
      attachmentDetails,
      `${attachmentCount} embedded file${attachmentCount === 1 ? "" : "s"}${attachmentNames.length ? `: ${attachmentNames.slice(0, 8).join(", ")}${attachmentNames.length > 8 ? "…" : ""}` : ""}`,
    );
  }
  if (options.attachments && attachmentCount) {
    namesDict?.delete(PDFName.of("EmbeddedFiles"));
    detachNamesIfEmpty();
    for (const ref of attachmentRefs) deleteGraph(context, ref);
  }
  addFinding("attachments", attachmentCount, options.attachments ? attachmentCount : 0, attachmentDetails);
  await pause(30);

  /* ---------------------------- metadata ----------------------------- */
  const infoObject = context.trailerInfo.Info;
  const infoDict = lookupDict(context, infoObject);
  const infoKeys = infoDict ? infoDict.keys().map((key) => key.asString().replace(/^\//, "")) : [];
  const xmpObject = catalog.get(PDFName.of("Metadata"));
  const metadataFound = (infoKeys.length ? 1 : 0) + (xmpObject !== undefined ? 1 : 0);
  const metadataDetails: string[] = [];
  if (infoKeys.length) {
    detailLine(metadataDetails, `Info dictionary keys: ${infoKeys.slice(0, 12).join(", ")}${infoKeys.length > 12 ? "…" : ""}`);
  }
  if (xmpObject !== undefined) detailLine(metadataDetails, "XMP metadata packet");
  if (options.metadata && metadataFound) {
    if (infoObject !== undefined) {
      if (infoDict) for (const key of infoDict.keys()) infoDict.delete(key);
      delete context.trailerInfo.Info;
      deleteGraph(context, infoObject);
    }
    if (xmpObject !== undefined) {
      catalog.delete(PDFName.of("Metadata"));
      deleteGraph(context, xmpObject);
    }
  }
  addFinding("metadata", metadataFound, options.metadata ? metadataFound : 0, metadataDetails);
  await pause(40);

  /* --------------------------- signatures ---------------------------- */
  const signatureDetails: string[] = [];
  if (signatureRefs.length) {
    const names = signatureEntries.map((entry) => entry.name).filter(Boolean).slice(0, 8);
    detailLine(
      signatureDetails,
      `${signatureRefs.length} signature field${signatureRefs.length === 1 ? "" : "s"}${names.length ? `: ${names.join(", ")}` : ""}`,
    );
  }
  const permsObject = catalog.get(PDFName.of("Perms"));
  if (permsObject !== undefined) detailLine(signatureDetails, "Catalog signature permissions dictionary (/Perms)");
  const signaturesFound = signatureRefs.length + (permsObject !== undefined ? 1 : 0);
  if (options.signatures && signaturesFound) {
    if (permsObject !== undefined) {
      catalog.delete(PDFName.of("Perms"));
      deleteGraph(context, permsObject);
    }
    if (!options.forms && acroDict && signatureRefs.length) {
      const fields = lookupArray(context, acroDict.get(PDFName.of("Fields")));
      if (fields) {
        const wanted = new Set(signatureRefs.map((ref) => ref.objectNumber));
        for (let index = fields.size() - 1; index >= 0; index--) {
          const item = fields.get(index);
          if (item instanceof PDFRef && wanted.has(item.objectNumber)) fields.remove(index);
        }
      }
      for (const ref of signatureRefs) {
        const fieldDict = lookupDict(context, ref);
        const value = fieldDict?.get(PDFName.of("V"));
        deleteGraph(context, ref, ANNOTATION_SKIP_KEYS);
        if (value instanceof PDFRef) deleteGraph(context, value);
        for (const page of doc.getPages()) {
          const annots = page.node.Annots();
          if (!annots) continue;
          for (let index = annots.size() - 1; index >= 0; index--) {
            const item = annots.get(index);
            if (item instanceof PDFRef && item.objectNumber === ref.objectNumber) annots.remove(index);
          }
          if (annots.size() === 0) page.node.delete(PDFName.of("Annots"));
        }
      }
    }
  }
  addFinding("signatures", signaturesFound, options.signatures ? signaturesFound : 0, signatureDetails);
  await pause(50);

  /* ------------------------------ forms ------------------------------ */
  const formDetails: string[] = [];
  if (formEntries.length) {
    const names = formEntries.map((entry) => entry.name).filter(Boolean).slice(0, 8);
    detailLine(formDetails, `${formEntries.length} interactive field${formEntries.length === 1 ? "" : "s"}${names.length ? `: ${names.join(", ")}` : ""}`);
  }
  if (acroDict?.has(PDFName.of("XFA"))) detailLine(formDetails, "XFA form data");
  if (widgetCount) detailLine(formDetails, `${widgetCount} form widget annotation${widgetCount === 1 ? "" : "s"}`);
  const formsFound = Math.max(formEntries.length, acroDict ? 1 : 0);
  let widgetsRemoved = 0;
  if (options.forms && formsFound) {
    for (const page of doc.getPages()) {
      const annots = page.node.Annots();
      if (!annots) continue;
      for (let index = annots.size() - 1; index >= 0; index--) {
        const item = annots.get(index);
        if (!isWidget(context, item)) continue;
        deleteGraph(context, item, ANNOTATION_SKIP_KEYS);
        annots.remove(index);
        widgetsRemoved += 1;
      }
      if (annots.size() === 0) page.node.delete(PDFName.of("Annots"));
    }
    for (const ref of fieldRefs) deleteGraph(context, ref, ANNOTATION_SKIP_KEYS);
    const acroObject = catalog.get(PDFName.of("AcroForm"));
    catalog.delete(PDFName.of("AcroForm"));
    // Only drop the AcroForm dictionary itself: its default resources can share
    // font objects with the pages, so a deep sweep here could break page text.
    if (acroObject instanceof PDFRef) context.delete(acroObject);
    if (widgetsRemoved) {
      detailLine(formDetails, `${widgetsRemoved} widget annotation${widgetsRemoved === 1 ? "" : "s"} removed from pages`);
    }
  }
  addFinding("forms", formsFound, options.forms ? formsFound : 0, formDetails);
  await pause(60);

  /* --------------------------- annotations --------------------------- */
  const annotationDetails: string[] = [];
  if (annotationCount) {
    const nonWidget = annotationCount - widgetCount;
    detailLine(annotationDetails, `${annotationCount} annotation${annotationCount === 1 ? "" : "s"} (${nonWidget} comment/link/markup, ${widgetCount} form widget)`);
    if (!options.forms) detailLine(annotationDetails, "Form widget annotations are kept because form-field removal is off.");
  }
  let annotationsRemoved = 0;
  if (options.annotations && annotationCount) {
    for (const page of doc.getPages()) {
      const annots = page.node.Annots();
      if (!annots) continue;
      for (let index = annots.size() - 1; index >= 0; index--) {
        const item = annots.get(index);
        if (!options.forms && isWidget(context, item)) continue;
        deleteGraph(context, item, ANNOTATION_SKIP_KEYS);
        annots.remove(index);
        annotationsRemoved += 1;
      }
      if (annots.size() === 0) page.node.delete(PDFName.of("Annots"));
    }
  }
  addFinding("annotations", annotationCount, annotationsRemoved, annotationDetails);
  await pause(70);

  /* ------------------------------ layers ----------------------------- */
  const layerDetails: string[] = [];
  const ocProperties = catalog.get(PDFName.of("OCProperties"));
  let ocgCount = 0;
  if (ocProperties) {
    const ocDict = lookupDict(context, ocProperties);
    const ocgs = ocDict ? lookupArray(context, ocDict.get(PDFName.of("OCGs"))) : undefined;
    ocgCount = ocgs?.size() ?? 0;
    if (ocgCount) detailLine(layerDetails, `${ocgCount} optional content group${ocgCount === 1 ? "" : "s"} (hidden layers)`);
    else detailLine(layerDetails, "Optional-content configuration (/OCProperties)");
  }
  const layersFound = ocgCount || (ocProperties !== undefined ? 1 : 0);
  if (options.layers && layersFound) {
    catalog.delete(PDFName.of("OCProperties"));
    // The OCG dictionaries themselves stay registered: page content streams can
    // reference them through /Properties, and deleting them would corrupt pages.
    if (ocProperties instanceof PDFRef) context.delete(ocProperties);
  }
  addFinding("layers", layersFound, options.layers ? layersFound : 0, layerDetails);
  await pause(78);

  /* ---------------------------- thumbnails --------------------------- */
  const thumbnails: PDFObject[] = [];
  for (const page of doc.getPages()) {
    const thumb = page.node.get(PDFName.of("Thumb"));
    if (thumb === undefined) continue;
    thumbnails.push(thumb);
    page.node.delete(PDFName.of("Thumb"));
  }
  if (options.thumbnails) for (const thumb of thumbnails) deleteGraph(context, thumb);
  addFinding(
    "thumbnails",
    thumbnails.length,
    options.thumbnails ? thumbnails.length : 0,
    thumbnails.length ? [`${thumbnails.length} page thumbnail${thumbnails.length === 1 ? "" : "s"}`] : [],
  );
  await pause(84);

  const saved = await doc.save();
  await pause(92);

  const problems = await verifySanitized(saved, options);
  if (problems.length) {
    throw new Error(
      `The sanitized copy didn’t pass verification: ${problems.slice(0, 4).join(", ")}${problems.length > 4 ? "…" : ""}. Nothing was offered for download.`,
    );
  }
  await pause(100);

  const foundTotal = findings.reduce((sum, finding) => sum + finding.found, 0);
  const removedTotal = findings.reduce((sum, finding) => sum + finding.removed, 0);
  return { bytes: saved, totalPages: doc.getPageCount(), findings, foundTotal, removedTotal };
}

/** Reload the saved bytes and confirm each selected structure is absent. */
async function verifySanitized(bytes: Uint8Array, options: SanitizeOptions): Promise<string[]> {
  const doc = await openPdfLib(bytes);
  const context = doc.context;
  const catalog = doc.catalog;
  const issues: string[] = [];

  if (options.scripts) {
    if (catalog.has(PDFName.of("OpenAction"))) issues.push("a catalog open action");
    if (catalog.has(PDFName.of("AA"))) issues.push("catalog additional actions");
    if (catalog.Names()?.has(PDFName.of("JavaScript"))) issues.push("document JavaScript");
    if (catalog.AcroForm()?.has(PDFName.of("AA"))) issues.push("AcroForm additional actions");
    if (doc.getPages().some((page) => page.node.has(PDFName.of("AA")))) issues.push("page additional actions");
  }

  if (options.attachments) {
    if (catalog.Names()?.has(PDFName.of("EmbeddedFiles"))) issues.push("an embedded-file name tree");
    for (const [, object] of context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFDict)) continue;
      const type = object.get(PDFName.of("Type"));
      if (type instanceof PDFName && type.asString() === "/EmbeddedFile") {
        issues.push("embedded file data");
        break;
      }
    }
  }

  if (options.metadata) {
    if (catalog.get(PDFName.of("Metadata")) !== undefined) issues.push("XMP metadata");
    if (context.trailerInfo.Info !== undefined) issues.push("an Info dictionary");
  }

  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (options.annotations && options.forms) {
      if (annots && annots.size() > 0) {
        issues.push("page annotations");
        break;
      }
      continue;
    }
    if (!annots || annots.size() === 0) continue;
    for (let index = 0; index < annots.size(); index++) {
      const item = annots.get(index);
      if (options.annotations && !isWidget(context, item)) {
        issues.push("page annotations");
        break;
      }
      if (options.forms && isWidget(context, item)) {
        issues.push("form widgets");
        break;
      }
    }
    if (issues.includes("page annotations") || issues.includes("form widgets")) break;
  }

  if (options.forms && catalog.AcroForm() !== undefined) issues.push("an AcroForm");
  if (options.layers && catalog.get(PDFName.of("OCProperties")) !== undefined) issues.push("optional-content layers");
  if (options.thumbnails && doc.getPages().some((page) => page.node.has(PDFName.of("Thumb")))) issues.push("page thumbnails");

  if (options.signatures) {
    if (catalog.get(PDFName.of("Perms")) !== undefined) issues.push("signature permissions");
    const acroDict = catalog.AcroForm();
    const fields = acroDict ? lookupArray(context, acroDict.get(PDFName.of("Fields"))) : undefined;
    if (fields) {
      for (let index = 0; index < fields.size(); index++) {
        const dict = lookupDict(context, fields.get(index));
        const fieldType = dict?.get(PDFName.of("FT"));
        if (fieldType instanceof PDFName && fieldType.asString() === "/Sig") {
          issues.push("signature fields");
          break;
        }
      }
    }
  }

  return [...new Set(issues)];
}

function formatSanitizeReport(result: SanitizeResult): string {
  const lines = [
    "Paperly PDF sanitization report",
    `Generated: ${new Date().toISOString()}`,
    `File: ${result.sourceName}`,
    `Pages: ${result.totalPages}`,
    `Structures found: ${result.foundTotal}`,
    `Structures removed: ${result.removedTotal}`,
    "Verification: the saved copy was reloaded and every selected structure was confirmed absent.",
    "",
    "Details:",
  ];
  for (const finding of result.findings) {
    lines.push(`- ${finding.label}: found ${finding.found}, removed ${finding.removed}`);
    for (const detail of finding.details) lines.push(`    ${detail}`);
  }
  lines.push(
    "",
    "This report lists counts and structure names only. Document content, field values and metadata values are not included.",
    "Sanitizing removes known metadata and active content; it is not a formal certification or a substitute for a legal review.",
  );
  return lines.join("\n");
}

export function SanitizeTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [options, setOptions] = useState<SanitizeOptions>(DEFAULT_SANITIZE_OPTIONS);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<SanitizeResult | null>(null);

  useEffect(() => {
    setResult(null);
    setError("");
    setProgress(0);
  }, [pdf.bytes]);

  const setOption = (id: SanitizeGroupId, value: boolean) => setOptions((previous) => ({ ...previous, [id]: value }));
  const enabledCount = SANITIZE_GROUPS.filter((group) => options[group.id]).length;

  const sanitize = async () => {
    if (!pdf.bytes || !pdf.file || busy) return;
    if (enabledCount === 0) {
      setError("Choose at least one structure to remove.");
      return;
    }
    setBusy(true);
    setError("");
    setResult(null);
    setProgress(0);
    try {
      const outcome = await sanitizePdf(pdf.bytes, options, setProgress);
      setResult({
        ...outcome,
        name: `${sanitizeName(baseName(pdf.file.name))}-sanitized.pdf`,
        sourceName: pdf.file.name,
      });
    } catch (err) {
      setError(friendlyProcessingError(err, "We couldn’t sanitize this PDF. Try again with a different copy."));
    } finally {
      setBusy(false);
    }
  };

  const downloadSanitizeReport = () => {
    if (!result) return;
    downloadBytes(
      new Uint8Array(new TextEncoder().encode(formatSanitizeReport(result))),
      `${sanitizeName(baseName(result.sourceName))}-sanitization-report.txt`,
      "text/plain",
    );
  };

  const presentCount = result?.findings.filter((finding) => finding.found > 0).length ?? 0;

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to sanitize" />

      {pdf.bytes && (
        <>
          <div className="rounded-xl border border-forest/15 bg-lime/20 p-3.5">
            <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-forest">
              <ShieldCheck className="h-4 w-4" /> Clean the document, then verify the copy
            </p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-forest/90">
              Paperly removes the structures you choose with pdf-lib’s low-level object API, saves a new copy, then reopens it and checks that every selected
              structure is actually gone. This strips known metadata and active content — it is <strong>not</strong> a certification, a redaction of page
              content, or a guarantee against every possible carrier. Sensitive page content should be redacted separately.
            </p>
          </div>

          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">What to remove</p>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setOptions(Object.fromEntries(SANITIZE_GROUPS.map((group) => [group.id, true])) as SanitizeOptions)}
                >
                  Enable all
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setOptions(Object.fromEntries(SANITIZE_GROUPS.map((group) => [group.id, false])) as SanitizeOptions)}
                >
                  Disable all
                </Button>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {SANITIZE_GROUPS.map((group) => (
                <Switch
                  key={group.id}
                  checked={options[group.id]}
                  onChange={(value) => setOption(group.id, value)}
                  label={group.label}
                  description={group.description}
                />
              ))}
            </div>
          </div>

          <Alert tone="warning" title="Signatures can’t survive this">
            Removing signature fields, or any structure a signature covers, invalidates existing digital signatures. Paperly cannot verify signatures before or
            after sanitizing, and the saved copy will not carry a valid signature.
          </Alert>

          <Alert tone="info">
            Optional-content layers are a visibility feature, not encryption: removing the layer configuration can make previously hidden content visible. It does
            not delete the underlying page content — use Find &amp; Redact or Redact PDF for that.
          </Alert>

          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <Button onClick={sanitize} loading={busy} disabled={busy || enabledCount === 0}>
              <Trash2 className="h-4 w-4" /> Remove {enabledCount} selected structure{enabledCount === 1 ? "" : "s"}
            </Button>
            <span className="text-[11.5px] text-muted">Saves a new copy — your original file is untouched.</span>
          </div>
          {busy && <Progress value={progress} label="Removing structures, saving the copy and verifying it…" />}
          {error && <Alert tone="error">{error}</Alert>}

          {result && (
            <div className="space-y-3">
              <DownloadPanel
                bytes={result.bytes}
                title="Sanitized copy ready and verified"
                filename={result.name}
                size={result.bytes.byteLength}
                pages={result.totalPages}
                onDownload={() => downloadBytes(result.bytes, result.name)}
                description={`${result.removedTotal} structure${result.removedTotal === 1 ? "" : "s"} removed across ${presentCount} categor${
                  presentCount === 1 ? "y" : "ies"
                } · the saved copy was reloaded and checked before download`}
              />

              <div className="overflow-hidden rounded-xl border border-line bg-paper">
                <div className="flex items-center justify-between border-b border-line bg-bone-deep/40 px-3.5 py-2">
                  <p className="flex items-center gap-1.5 text-[12px] font-semibold">
                    <FileSearch className="h-3.5 w-3.5 text-forest" /> What Paperly found and removed
                  </p>
                  <Badge tone="forest">
                    <Check className="h-3 w-3" /> Verified
                  </Badge>
                </div>
                <ul className="divide-y divide-line/70">
                  {result.findings.map((finding) => (
                    <li key={finding.id} className="px-3.5 py-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-[12px] font-medium text-ink">{finding.label}</p>
                        <div className="flex items-center gap-1.5">
                          {finding.found === 0 ? (
                            <span className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-muted">Not present</span>
                          ) : (
                            <>
                              <Badge tone="neutral">{finding.found} found</Badge>
                              <Badge tone={finding.removed > 0 ? "forest" : "clay"}>
                                {finding.removed > 0 ? `${finding.removed} removed` : "kept (off)"}
                              </Badge>
                            </>
                          )}
                        </div>
                      </div>
                      {finding.details.length > 0 && (
                        <ul className="mt-1 space-y-0.5 pl-1">
                          {finding.details.map((detail) => (
                            <li key={detail} className="text-[11px] leading-relaxed text-muted">
                              · {detail}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-paper p-3">
                <Button variant="outline" size="sm" onClick={downloadSanitizeReport}>
                  <Download className="h-3.5 w-3.5" /> Download sanitization report (.txt)
                </Button>
                <span className="text-[11.5px] text-muted">Counts and structure names only — no document content or values.</span>
              </div>

              <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted">
                <FileText className="mt-px h-3.5 w-3.5 shrink-0 text-forest" />
                The verification step reopens the saved bytes with the same parser, which proves the structures are unreachable through the document catalog and
                page tree. Retained page content, images and unreferenced objects are outside this check — redact sensitive page content separately.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
