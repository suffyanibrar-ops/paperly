import {
  ArrowLeftRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Copy,
  Download,
  EyeOff,
  FileSearch,
  Layers,
  ScanSearch,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  PDFDocument,
  baseName,
  dataUrlToBytes,
  degrees,
  formatBytes,
  getPageDimensions,
  openPdfJs,
  openPdfLib,
  readFileBytes,
  renderPdfPage,
  sanitizeName,
} from "@/lib/pdf";
import type { PDFDocumentProxy } from "@/lib/pdf";
import { extractDocument } from "@/lib/extract";
import {
  PATTERN_PRESETS,
  buildRegex,
  findMatches,
  resolveOverlaps,
  type PatternId,
  type PatternPreset,
} from "@/lib/redactPatterns";
import { boxToNormalized, charRangeBox, extractDocumentGeometry, type NormalizedBox, type TextLine } from "@/lib/textItems";
import { useInitialFiles, usePdfFile } from "@/lib/usePdf";
import { useToolPreferences } from "@/lib/prefs";
import { describeJobTime, useJob } from "@/lib/job";
import { useDownloadShortcut, usePrimaryShortcut } from "@/lib/hotkeys";
import { copyOutput, downloadOutput } from "@/lib/output";
import { parsePageQuery } from "@/lib/pageQuery";
import { Alert, Badge, Button, ColorInput, Field, FileDrop, FileRow, Progress, Segmented, Select, Switch } from "@/components/ui";
import { DownloadPanel, RangeField, SinglePdfInput } from "@/components/toolParts";
import { AdvancedOptions, OptionsGrid, OptionNote } from "@/components/AdvancedOptions";
import { cn } from "@/utils/cn";

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const maskValue = (value: string) => (value.length <= 2 ? "•••" : `${value.slice(0, 1)}•••${value.slice(-1)}`);
const asArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/* ================================================================== *
 * REDACT PDF — true redaction by rasterizing affected pages
 * ================================================================== */
interface Rect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DetectedMatch {
  id: string;
  page: number;
  /** 1-based page number for display. */
  label: string;
  value: string;
  lineText: string;
  startInLine: number;
  endInLine: number;
  box: NormalizedBox;
}

type RedactMode = "blackout" | "remove";

interface VerifyFailure {
  page: number;
  label: string;
  masked: string;
}

interface VerifyReport {
  ran: boolean;
  note: string;
  checked: number;
  failures: VerifyFailure[];
  boxPages: number;
  boxFailures: number[];
}

interface RedactResult {
  bytes: Uint8Array;
  name: string;
  pages: number;
  redactedPages: number;
  areas: number;
  verify: VerifyReport;
}

/** Average the colours just outside a box so "remove text" can erase without a bar. */
function sampleBackground(data: Uint8ClampedArray, width: number, height: number, rect: { x: number; y: number; w: number; h: number }): string {
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  const sample = (px: number, py: number) => {
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const offset = (py * width + px) * 4;
    red += data[offset];
    green += data[offset + 1];
    blue += data[offset + 2];
    count += 1;
  };
  const stepX = Math.max(1, Math.floor(rect.w / 28));
  const stepY = Math.max(1, Math.floor(rect.h / 28));
  const pad = 3;
  for (let x = rect.x; x < rect.x + rect.w; x += stepX) {
    sample(x, rect.y - pad);
    sample(x, rect.y + rect.h + pad);
  }
  for (let y = rect.y; y < rect.y + rect.h; y += stepY) {
    sample(rect.x - pad, y);
    sample(rect.x + rect.w + pad, y);
  }
  if (!count) return "#ffffff";
  return `rgb(${Math.round(red / count)}, ${Math.round(green / count)}, ${Math.round(blue / count)})`;
}

async function burnRedactions(
  dataUrl: string,
  boxes: NormalizedBox[],
  options: { mode: RedactMode; color: string },
): Promise<{ dataUrl: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const pixels = options.mode === "remove" ? ctx.getImageData(0, 0, canvas.width, canvas.height).data : null;
  bitmap.close?.();
  for (const box of boxes) {
    const rect = {
      x: Math.round(box.x * canvas.width),
      y: Math.round(box.y * canvas.height),
      w: Math.max(1, Math.round(box.w * canvas.width)),
      h: Math.max(1, Math.round(box.h * canvas.height)),
    };
    ctx.fillStyle = options.mode === "blackout" ? options.color : sampleBackground(pixels!, canvas.width, canvas.height, rect);
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }
  return { dataUrl: canvas.toDataURL("image/jpeg", 0.92), width: canvas.width, height: canvas.height };
}

const snippetFor = (match: DetectedMatch, radius = 34) => {
  const line = match.lineText;
  const from = Math.max(0, match.startInLine - radius);
  const to = Math.min(line.length, match.endInLine + radius);
  return {
    before: `${from > 0 ? "…" : ""}${line.slice(from, match.startInLine)}`,
    after: `${line.slice(match.endInLine, to)}${to < line.length ? "…" : ""}`,
  };
};

const SEARCH_PRESETS = PATTERN_PRESETS.filter((preset) => preset.id !== "custom");

export function RedactTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const prefs = useToolPreferences("redact", {
    mode: "blackout" as RedactMode,
    color: "#000000",
    dpi: 150,
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    preset: "email" as PatternId | "none",
  });
  const [pageIndex, setPageIndex] = useState(0);
  const [dims, setDims] = useState<{ width: number; height: number }[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [rects, setRects] = useState<Record<number, Rect[]>>({});
  const [draft, setDraft] = useState<Rect | null>(null);
  const [term, setTerm] = useState("");
  const [range, setRange] = useState("");
  const [matches, setMatches] = useState<DetectedMatch[]>([]);
  const [selectedMatches, setSelectedMatches] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [scanNote, setScanNote] = useState("");
  const surfaceRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const scanJob = useJob<DetectedMatch[]>();
  const applyJob = useJob<RedactResult>();
  const result = applyJob.result;

  const pageRects = rects[pageIndex] ?? [];
  const totalRects = Object.values(rects).reduce((sum, list) => sum + list.length, 0);
  const pageMatches = matches.filter((match) => match.page === pageIndex + 1);
  const selectedMatchList = matches.filter((match) => selectedMatches.has(match.id));
  const totalAreas = totalRects + selectedMatchList.length;
  const pageLabel = pdf.pageCount ? `${pageIndex + 1} / ${pdf.pageCount}` : "1 / 1";

  useEffect(() => {
    if (!pdf.bytes) {
      setDims([]);
      return;
    }
    const bytes = pdf.bytes;
    getPageDimensions(bytes).then(setDims).catch(() => undefined);
  }, [pdf.bytes]);

  useEffect(() => {
    if (!pdf.bytes) {
      setPreview(null);
      return;
    }
    let alive = true;
    const bytes = pdf.bytes;
    (async () => {
      const doc = await openPdfJs(bytes);
      const rendered = await renderPdfPage(doc, pageIndex + 1, { targetWidth: 1000, quality: 0.9, rotation: 0 });
      await doc.destroy();
      if (alive) setPreview(rendered.dataUrl);
    })().catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [pdf.bytes, pageIndex]);

  // A new document invalidates every mark, scan and result.
  useEffect(() => {
    setRects({});
    setMatches([]);
    setSelectedMatches(new Set());
    setTerm("");
    setScanNote("");
    scanJob.reset();
    applyJob.reset();
    setError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf.bytes]);

  const norm = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = surfaceRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!surfaceRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = norm(e);
    startRef.current = p;
    setDraft({ id: "draft", x: p.x, y: p.y, w: 0, h: 0 });
  };

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!startRef.current) return;
    const p = norm(e);
    const start = startRef.current;
    setDraft({
      id: "draft",
      x: Math.min(start.x, p.x),
      y: Math.min(start.y, p.y),
      w: Math.abs(p.x - start.x),
      h: Math.abs(p.y - start.y),
    });
  };

  const onUp = () => {
    if (draft && draft.w > 0.008 && draft.h > 0.008) {
      setRects((prev) => ({ ...prev, [pageIndex]: [...(prev[pageIndex] ?? []), { ...draft, id: uid() }] }));
      applyJob.reset();
    }
    setDraft(null);
    startRef.current = null;
  };

  const buildScanners = (): { label: string; regex: RegExp; preset: PatternPreset | null }[] => {
    const scanners: { label: string; regex: RegExp; preset: PatternPreset | null }[] = [];
    const preset = prefs.value.preset === "none" ? null : PATTERN_PRESETS.find((item) => item.id === prefs.value.preset) ?? null;
    if (preset) {
      scanners.push({
        label: preset.label,
        regex: buildRegex(preset, { caseSensitive: prefs.value.caseSensitive, wholeWord: prefs.value.wholeWord }),
        preset,
      });
    }
    if (term.trim()) {
      scanners.push({
        label: "Your search",
        regex: buildRegex("custom", {
          caseSensitive: prefs.value.caseSensitive,
          wholeWord: prefs.value.wholeWord,
          customPattern: prefs.value.regex ? term : escapeRegExp(term),
        }),
        preset: null,
      });
    }
    return scanners;
  };

  const scan = async () => {
    const source = pdf.bytes;
    if (!source) return;
    let scanners: { label: string; regex: RegExp; preset: PatternPreset | null }[];
    try {
      scanners = buildScanners();
      if (!scanners.length) {
        setError("Choose a pattern or type the text you want to find.");
        return;
      }
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    let pages: number[];
    try {
      pages = parsePageQuery(range, pdf.pageCount);
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    setError("");
    setScanNote("");
    setMatches([]);
    setSelectedMatches(new Set());
    await scanJob.run(async ({ report, throwIfCancelled }) => {
      const geometry = await extractDocumentGeometry(source, {
        pages,
        onProgress: (done, total) => report((done / Math.max(1, total)) * 45, `Reading page ${done} of ${total}…`),
      });
      const found: DetectedMatch[] = [];
      for (let index = 0; index < geometry.pages.length; index++) {
        throwIfCancelled();
        const page = geometry.pages[index];
        for (const line of page.lines) {
          if (!line.text) continue;
          const candidates: { start: number; end: number; label: string; preset: PatternPreset | null }[] = [];
          for (const scanner of scanners) {
            for (const hit of findMatches(line.text, scanner.regex)) {
              if (hit.value.length < 2) continue;
              if (scanner.preset?.validate && !scanner.preset.validate(hit.value)) continue;
              candidates.push({ start: hit.start, end: hit.end, label: scanner.label, preset: scanner.preset });
            }
          }
          const accepted = resolveOverlaps(
            candidates.map((candidate) => ({ ...candidate, priority: candidate.preset?.priority ?? 5 })),
          ).sort((left, right) => left.start - right.start);
          for (const hit of accepted) {
            const box = charRangeBox(line as TextLine, hit.start, hit.end);
            if (!box) continue;
            found.push({
              id: `match-${found.length}`,
              page: page.page,
              label: hit.label,
              value: line.text.slice(hit.start, hit.end),
              lineText: line.text,
              startInLine: hit.start,
              endInLine: hit.end,
              box: boxToNormalized(box, page.width, page.height),
            });
          }
        }
        report(45 + ((index + 1) / Math.max(1, geometry.pages.length)) * 55, `Scanned ${index + 1} of ${geometry.pages.length} pages · ${found.length} match${found.length === 1 ? "" : "es"}`);
      }
      setMatches(found);
      setSelectedMatches(new Set(found.map((match) => match.id)));
      setScanNote(found.length ? "" : "No matches found on those pages. Check the spelling, or turn off whole-word matching.");
      return found;
    });
  };

  const applyRedactions = async () => {
    const source = pdf.bytes;
    const file = pdf.file;
    if (!source || !file) return;
    if (!totalAreas) {
      setError("Draw a box or select a match first.");
      return;
    }
    setError("");
    const marksByPage = new Map<number, NormalizedBox[]>();
    const push = (page: number, box: NormalizedBox) => {
      const list = marksByPage.get(page) ?? [];
      list.push(box);
      marksByPage.set(page, list);
    };
    Object.entries(rects).forEach(([page, list]) => list.forEach((rect) => push(Number(page) + 1, rect)));
    selectedMatchList.forEach((match) => push(match.page, match.box));
    const boxPageNumbers = Object.keys(rects)
      .filter((page) => (rects[Number(page)] ?? []).length > 0)
      .map((page) => Number(page) + 1);

    await applyJob.run(async ({ report, step, throwIfCancelled }) => {
      const src = await openPdfLib(source);
      const out = await PDFDocument.create();
      const doc = await openPdfJs(source);
      const allPages = src.getPages();
      const total = src.getPageCount();
      try {
        for (let index = 0; index < total; index++) {
          throwIfCancelled();
          const marks = marksByPage.get(index + 1) ?? [];
          if (marks.length) {
            const original = allPages[index];
            const { width, height } = original.getSize();
            // Render unrotated, then re-apply /Rotate so the page looks identical
            // to the source while the redaction boxes stay aligned with the preview.
            const rendered = await renderPdfPage(doc, index + 1, { scale: prefs.value.dpi / 72, type: "image/jpeg", quality: 0.92, rotation: 0 });
            const burned = await burnRedactions(rendered.dataUrl, marks, { mode: prefs.value.mode, color: prefs.value.color });
            const page = out.addPage([width, height]);
            const rotation = original.getRotation().angle;
            if (rotation) page.setRotation(degrees(rotation));
            const image = await out.embedJpg(dataUrlToBytes(burned.dataUrl));
            page.drawImage(image, { x: 0, y: 0, width, height });
          } else {
            const [copied] = await out.copyPages(src, [index]);
            out.addPage(copied);
          }
          step(index + 1, total, "Burning redactions into new page images…");
        }
      } finally {
        await doc.destroy();
      }
      const bytes = await out.save();
      const redactedPages = [...marksByPage.keys()].length;

      // Post-save verification: re-read the saved file and confirm the values are gone.
      report(94, "Verifying the saved file…");
      let verify: VerifyReport = {
        ran: false,
        note: "Verification didn’t run.",
        checked: 0,
        failures: [],
        boxPages: boxPageNumbers.length,
        boxFailures: [],
      };
      try {
        const affected = [...new Set([...selectedMatchList.map((match) => match.page), ...boxPageNumbers])].sort((a, b) => a - b);
        const verified = await extractDocument(asArrayBuffer(bytes), { pages: affected });
        const texts = new Map<number, string>();
        verified.pages.forEach((page) => texts.set(page.page, page.text));
        const failures: VerifyFailure[] = [];
        for (const match of selectedMatchList) {
          const text = texts.get(match.page) ?? "";
          const haystack = prefs.value.caseSensitive ? text : text.toLowerCase();
          const needle = prefs.value.caseSensitive ? match.value : match.value.toLowerCase();
          if (needle && haystack.includes(needle)) failures.push({ page: match.page, label: match.label, masked: maskValue(match.value) });
        }
        const boxFailures = boxPageNumbers.filter((page) => (texts.get(page) ?? "").replace(/\s/g, "").length > 0);
        verify = {
          ran: true,
          note: "",
          checked: selectedMatchList.length,
          failures,
          boxPages: boxPageNumbers.length,
          boxFailures,
        };
      } catch (err) {
        verify = {
          ...verify,
          note: `The saved file couldn’t be re-read for verification (${(err as Error).message}). Open it and check the marked pages before sharing.`,
        };
      }
      throwIfCancelled();
      return {
        bytes,
        name: `${sanitizeName(baseName(file.name))}-redacted.pdf`,
        pages: total,
        redactedPages,
        areas: totalAreas,
        verify,
      };
    });
  };

  const download = () => {
    if (result) downloadOutput(result.bytes, result.name);
  };

  usePrimaryShortcut(() => void applyRedactions(), Boolean(pdf.bytes) && totalAreas > 0 && !applyJob.busy);
  useDownloadShortcut(download, Boolean(result));

  const toggleMatch = (id: string) =>
    setSelectedMatches((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const verification = result?.verify;

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to redact" />
      {pdf.bytes && (
        <>
          <div className="rounded-xl border border-clay/20 bg-clay/[0.05] p-3.5">
            <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[#b14425]">
              <EyeOff className="h-4 w-4" /> Real redaction, not a black box drawn on top
            </p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-ink/70">
              Pages with redactions are rebuilt as images with the marked areas permanently burned in, so the covered text can’t be copied or
              extracted. Other pages stay untouched with their original, selectable text.
            </p>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_270px]">
            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-bone-deep/40 px-2 py-1.5">
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pageIndex === 0}
                    onClick={() => setPageIndex((i) => i - 1)}
                    aria-label="Previous page"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="min-w-[74px] text-center text-[11.5px] font-medium tabular-nums text-ink/70">{pageLabel}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pageIndex >= pdf.pageCount - 1}
                    onClick={() => setPageIndex((i) => i + 1)}
                    aria-label="Next page"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
                <p className="px-2 text-[11px] text-muted">Drag across the page to mark content for removal.</p>
              </div>

              <div className="rounded-xl border border-line bg-bone-deep/50 p-3 sm:p-5">
                <div className="mx-auto w-full max-w-[720px]">
                  <div
                    ref={surfaceRef}
                    onPointerDown={onDown}
                    onPointerMove={onMove}
                    onPointerUp={onUp}
                    className="relative w-full cursor-crosshair touch-none select-none overflow-hidden rounded-sm bg-white pdf-page-shadow"
                    style={{ aspectRatio: dims[pageIndex] ? `${dims[pageIndex].width} / ${dims[pageIndex].height}` : "3 / 4" }}
                  >
                    {preview ? (
                      <img src={preview} alt={`Page ${pageIndex + 1}`} className="pointer-events-none absolute inset-0 h-full w-full object-fill" draggable={false} />
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center text-[12px] text-ink/70">Rendering page…</div>
                    )}
                    {pageMatches.map((match) => (
                      <div
                        key={match.id}
                        aria-hidden
                        className={cn(
                          "pointer-events-none absolute border",
                          selectedMatches.has(match.id) ? "border-clay bg-clay/35" : "border-dashed border-forest/50 bg-forest/10",
                        )}
                        style={{ left: `${match.box.x * 100}%`, top: `${match.box.y * 100}%`, width: `${match.box.w * 100}%`, height: `${match.box.h * 100}%` }}
                      />
                    ))}
                    {pageRects.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        aria-label="Remove redaction box"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => {
                          setRects((prev) => ({ ...prev, [pageIndex]: (prev[pageIndex] ?? []).filter((x) => x.id !== r.id) }));
                          applyJob.reset();
                        }}
                        className="group absolute cursor-pointer border border-white/40"
                        style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%`, background: prefs.value.mode === "blackout" ? prefs.value.color : "rgba(120,120,120,0.35)" }}
                      >
                        <span className="absolute -right-2 -top-2 hidden h-4 w-4 items-center justify-center rounded-full bg-paper text-ink shadow group-hover:flex">
                          <X className="h-2.5 w-2.5" />
                        </span>
                      </button>
                    ))}
                    {draft && (
                      <div
                        className="pointer-events-none absolute border border-dashed border-clay bg-clay/25"
                        style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%` }}
                      />
                    )}
                  </div>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button onClick={() => void applyRedactions()} loading={applyJob.busy}>
                  <EyeOff className="h-4 w-4" /> Apply {totalAreas} redaction{totalAreas === 1 ? "" : "s"}
                </Button>
                {applyJob.busy && (
                  <Button variant="ghost" size="sm" onClick={applyJob.cancel}>
                    Cancel
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setRects((prev) => ({ ...prev, [pageIndex]: [] }));
                    applyJob.reset();
                  }}
                  disabled={!pageRects.length}
                >
                  Clear this page
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setRects({});
                    setMatches([]);
                    setSelectedMatches(new Set());
                    applyJob.reset();
                  }}
                  disabled={!totalRects && !matches.length}
                >
                  Clear all
                </Button>
                <span className="text-[11.5px] text-muted">
                  {totalRects} box{totalRects === 1 ? "" : "es"} · {selectedMatchList.length} of {matches.length} match
                  {matches.length === 1 ? "" : "es"} selected
                </span>
              </div>
              {applyJob.busy && (
                <div className="mt-3">
                  <Progress value={applyJob.percent ?? undefined} label={applyJob.label} detail={describeJobTime(applyJob)} etaMs={applyJob.etaMs} />
                </div>
              )}
              {applyJob.status === "cancelled" && <Alert tone="info" className="mt-3">Cancelled — nothing was downloaded. Your marks are still here.</Alert>}
              {error && <Alert tone="error" className="mt-3">{error}</Alert>}
              {applyJob.failed && <Alert tone="error" className="mt-3">{applyJob.error}</Alert>}

              {matches.length > 0 && (
                <div className="mt-4 overflow-hidden rounded-xl border border-line bg-paper">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-bone-deep/40 px-3 py-2">
                    <p className="flex items-center gap-1.5 text-[12px] font-semibold">
                      <Search className="h-3.5 w-3.5 text-forest" /> {matches.length} match{matches.length === 1 ? "" : "es"} found
                    </p>
                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSelectedMatches(new Set(matches.map((match) => match.id)))}
                        disabled={selectedMatches.size === matches.length}
                      >
                        Select all
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setSelectedMatches(new Set())} disabled={!selectedMatches.size}>
                        None
                      </Button>
                    </div>
                  </div>
                  <ul className="max-h-72 divide-y divide-line overflow-y-auto scrollbar-thin">
                    {matches.map((match) => {
                      const snippet = snippetFor(match);
                      const active = selectedMatches.has(match.id);
                      return (
                        <li key={match.id}>
                          <div className="flex items-start gap-2 px-3 py-1.5">
                            <button
                              type="button"
                              role="checkbox"
                              aria-checked={active}
                              aria-label={`Redact page ${match.page} match`}
                              onClick={() => toggleMatch(match.id)}
                              className={cn(
                                "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                                active ? "border-forest bg-forest text-paper" : "border-line bg-paper",
                              )}
                            >
                              {active && <Check className="h-2.5 w-2.5" />}
                            </button>
                            <span className="w-11 shrink-0 text-[10.5px] font-semibold tabular-nums text-ink/60">p.{match.page}</span>
                            <span className="min-w-0 flex-1 break-words font-mono text-[11px] leading-relaxed text-ink/70">
                              {snippet.before}
                              <mark className="rounded bg-lime/70 px-0.5 font-semibold text-ink">{match.value}</mark>
                              {snippet.after}
                            </span>
                            <span className="hidden shrink-0 text-[10px] text-muted sm:block">{match.label}</span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>

            <aside className="space-y-3">
              <div className="rounded-xl border border-line bg-paper p-3.5">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">Redaction style</p>
                <Segmented
                  value={prefs.value.mode}
                  onChange={(mode) => prefs.set("mode", mode)}
                  size="sm"
                  options={[
                    { value: "blackout", label: "Black box" },
                    { value: "remove", label: "Remove text" },
                  ]}
                />
                <p className="mt-1.5 text-[10.5px] leading-snug text-muted">
                  {prefs.value.mode === "blackout"
                    ? "Marked areas become solid bars. The page is rebuilt as an image, so nothing underneath survives."
                    : "Marked areas are filled with the page’s background colour: the content disappears without a visible bar, and the flattened page keeps no text layer."}
                </p>
                <p className="mt-2 rounded-lg border border-forest/15 bg-lime/20 px-2 py-1.5 text-[10px] font-medium leading-snug text-forest">
                  True burn is always on: every page with a redaction is rasterized, and the original text objects are never copied into the output.
                </p>
                <div className="mt-3 space-y-3">
                  {prefs.value.mode === "blackout" && (
                    <Field label="Box colour">
                      <ColorInput value={prefs.value.color} onChange={(color) => prefs.set("color", color)} label="Redaction colour" />
                    </Field>
                  )}
                  <Field label="Output resolution" hint="Higher keeps small text crisper; files get larger.">
                    <Select value={prefs.value.dpi} onChange={(e) => prefs.set("dpi", Number(e.target.value))}>
                      <option value={110}>Standard · 110 DPI</option>
                      <option value={150}>High · 150 DPI</option>
                      <option value={220}>Print · 220 DPI</option>
                      <option value={300}>Maximum · 300 DPI</option>
                    </Select>
                  </Field>
                </div>
              </div>

              <div className="rounded-xl border border-line bg-paper p-3.5">
                <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">
                  <ScanSearch className="h-3.5 w-3.5 text-forest" /> Find &amp; redact
                </p>
                <Field label="Text or pattern">
                  <input
                    value={term}
                    onChange={(e) => setTerm(e.target.value)}
                    placeholder="e.g. Acme Ltd"
                    className="h-12 w-full rounded-lg border border-line bg-paper px-2.5 text-[16px] focus:border-forest/50 focus:outline-none focus:ring-2 focus:ring-forest/10 sm:h-9 sm:text-[12.5px]"
                    maxLength={200}
                  />
                </Field>
                <div className="scrollbar-none mt-2 flex gap-1.5 overflow-x-auto pb-1 sm:flex-wrap">
                  {SEARCH_PRESETS.map((preset) => {
                    const label =
                      preset.id === "email"
                        ? "Emails"
                        : preset.id === "phone"
                          ? "Phone Numbers"
                          : preset.id === "ssn"
                            ? "SSN / IDs"
                            : preset.id === "credit-card"
                              ? "Credit Cards"
                              : preset.id === "date"
                                ? "Dates"
                                : preset.shortLabel;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        aria-pressed={prefs.value.preset === preset.id}
                        title={preset.description}
                        onClick={() => prefs.set("preset", prefs.value.preset === preset.id ? "none" : preset.id)}
                        className={cn(
                          "min-h-12 shrink-0 rounded-xl border px-3 text-[11.5px] font-semibold sm:min-h-0 sm:rounded-md sm:px-2 sm:py-1 sm:text-[10.5px]",
                          prefs.value.preset === preset.id ? "border-forest bg-forest text-paper" : "border-line bg-paper text-ink/65",
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-2 space-y-1.5">
                  <Switch checked={prefs.value.caseSensitive} onChange={(v) => prefs.set("caseSensitive", v)} label="Match case" />
                  <Switch checked={prefs.value.wholeWord} onChange={(v) => prefs.set("wholeWord", v)} label="Whole words only" />
                  <Switch
                    checked={prefs.value.regex}
                    onChange={(v) => prefs.set("regex", v)}
                    label="Regular expression"
                    description="Treat the field above as a JavaScript regex."
                  />
                </div>
                <div className="mt-2">
                  <RangeField value={range} onChange={setRange} total={pdf.pageCount} label="Pages to search" showAll />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => void scan()} loading={scanJob.busy}>
                    <Search className="h-3.5 w-3.5" /> Find matches
                  </Button>
                  {scanJob.busy && (
                    <Button variant="ghost" size="sm" onClick={scanJob.cancel}>
                      Cancel
                    </Button>
                  )}
                </div>
                {scanJob.busy && <Progress value={scanJob.percent ?? undefined} label={scanJob.label} detail={describeJobTime(scanJob)} />}
                {scanNote && <Alert tone="info" className="mt-2">{scanNote}</Alert>}
                {scanJob.failed && <Alert tone="error" className="mt-2">{scanJob.error}</Alert>}
                <OptionNote>Matches are listed below the page so you can deselect anything that should stay.</OptionNote>
              </div>

              <div className="rounded-xl border border-line bg-bone-deep/30 p-3 text-[11px] leading-relaxed text-muted">
                <p className="flex items-center gap-1.5 font-semibold text-ink/70">
                  <ShieldCheck className="h-3.5 w-3.5 text-forest" /> Verified after saving
                </p>
                <p className="mt-1">
                  Every run re-reads the saved file and checks that the redacted strings and flattened pages no longer contain text. If that check
                  can’t run, we say so instead of guessing.
                </p>
              </div>
            </aside>
          </div>
        </>
      )}

      {result && verification && (
        <div className="space-y-3">
          {!verification.ran ? (
            <Alert tone="warning" title="Verification couldn’t run">
              {verification.note}
            </Alert>
          ) : verification.failures.length === 0 && verification.boxFailures.length === 0 ? (
            <Alert tone="success" title="Verification passed">
              Re-read the saved file: {verification.checked ? `all ${verification.checked} redacted string${verification.checked === 1 ? "" : "s"}` : "no redacted strings"}{" "}
              no longer appear
              {verification.boxPages
                ? `, and the ${verification.boxPages} flattened page${verification.boxPages === 1 ? "" : "s"} contain no extractable text`
                : ""}
              .
            </Alert>
          ) : (
            <Alert tone="error" title="Verification found leftovers">
              {verification.failures.length > 0 && (
                <p>
                  {verification.failures.length} matched string{verification.failures.length === 1 ? "" : "s"} still appear in the saved file (pages{" "}
                  {[...new Set(verification.failures.map((failure) => failure.page))].join(", ")}:{" "}
                  {verification.failures
                    .slice(0, 4)
                    .map((failure) => `${failure.masked} on p.${failure.page}`)
                    .join(", ")}
                  ).
                </p>
              )}
              {verification.boxFailures.length > 0 && (
                <p>
                  Pages {verification.boxFailures.join(", ")} still contain extractable text. Do not share this file.
                </p>
              )}
            </Alert>
          )}
          <DownloadPanel
            bytes={result.bytes}
            title="Redactions applied"
            filename={result.name}
            size={result.bytes.byteLength}
            pages={result.pages}
            onDownload={download}
            description={`${result.redactedPages} page${result.redactedPages === 1 ? "" : "s"} flattened · ${result.areas} marked area${result.areas === 1 ? "" : "s"} permanently removed · other pages untouched`}
            facts={[
              { label: "Style", value: prefs.value.mode === "blackout" ? "Black box" : "Removed text" },
              { label: "Verified", value: verification.ran ? (verification.failures.length === 0 && verification.boxFailures.length === 0 ? "Passed" : "Failed") : "Not run" },
            ]}
          />
        </div>
      )}
    </div>
  );
}

/* ================================================================== *
 * COMPARE PDF — line-level text diff
 * ================================================================== */
type DiffKind = "same" | "added" | "removed";

interface DiffLine {
  kind: DiffKind;
  text: string;
}

interface PageDiff {
  page: number;
  lines: DiffLine[];
  added: number;
  removed: number;
  changed: number;
  matchPercent: number;
  leftLines: number;
  rightLines: number;
}

interface CompareSummary {
  added: number;
  removed: number;
  changed: number;
  changedPages: number;
  totalPages: number;
  matchPercent: number;
  leftPages: number;
  rightPages: number;
  ignoreWhitespace: boolean;
  ignoreCase: boolean;
}

type CompareMode = "inline" | "side-by-side" | "overlay";
type ReportFormat = "html" | "csv";

interface CompareResult {
  pages: PageDiff[];
  summary: CompareSummary;
  leftBytes: ArrayBuffer;
  rightBytes: ArrayBuffer;
  pageRange: string;
  ignoreWhitespace: boolean;
  ignoreCase: boolean;
}

interface Hunk {
  page: number;
  before: string[];
  changed: DiffLine[];
  after: string[];
}

function diffLines(left: string[], right: string[], normalize: (line: string) => string): DiffLine[] {
  const n = left.length;
  const m = right.length;
  const leftKeys = left.map(normalize);
  const rightKeys = right.map(normalize);
  if (n * m > 1_200_000) {
    // Very large pages: fall back to a set-based comparison to stay responsive.
    const rightSet = new Set(rightKeys);
    const leftSet = new Set(leftKeys);
    const out: DiffLine[] = [];
    left.forEach((line, index) => out.push({ kind: rightSet.has(leftKeys[index]) ? "same" : "removed", text: line }));
    right.forEach((line, index) => {
      if (!leftSet.has(rightKeys[index])) out.push({ kind: "added", text: line });
    });
    return out;
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = leftKeys[i] === rightKeys[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (leftKeys[i] === rightKeys[j]) {
      out.push({ kind: "same", text: left[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "removed", text: left[i++] });
    } else {
      out.push({ kind: "added", text: right[j++] });
    }
  }
  while (i < n) out.push({ kind: "removed", text: left[i++] });
  while (j < m) out.push({ kind: "added", text: right[j++] });
  return out;
}

/** Pair removed+added runs so "changed" is reported separately from pure adds/removes. */
function countChanges(lines: DiffLine[]): { added: number; removed: number; changed: number } {
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].kind === "removed") {
      removed += 1;
      if (lines[index + 1]?.kind === "added") {
        changed += 1;
        index += 1;
      }
    } else if (lines[index].kind === "added") {
      added += 1;
    }
  }
  return { added, removed, changed };
}

function firstHunks(pages: PageDiff[], limit = 6): Hunk[] {
  const hunks: Hunk[] = [];
  for (const page of pages) {
    let index = 0;
    while (index < page.lines.length && hunks.length < limit) {
      if (page.lines[index].kind === "same") {
        index += 1;
        continue;
      }
      const start = index;
      while (index < page.lines.length && page.lines[index].kind !== "same") index += 1;
      hunks.push({
        page: page.page,
        before: page.lines.slice(Math.max(0, start - 2), start).map((line) => line.text),
        changed: page.lines.slice(start, index),
        after: page.lines.slice(index, index + 2).map((line) => line.text),
      });
    }
    if (hunks.length >= limit) break;
  }
  return hunks;
}

const pageImageCache = new Map<string, string>();

/**
 * Parsing the same PDF once per page is wasteful, so the side-by-side and
 * overlay views share one open document per file (max two are kept).
 */
const compareDocCache = new Map<string, Promise<PDFDocumentProxy>>();
function openCompareDocument(key: string, bytes: ArrayBuffer): Promise<PDFDocumentProxy> {
  const cached = compareDocCache.get(key);
  if (cached) return cached;
  if (compareDocCache.size >= 2) compareDocCache.clear();
  const opened = openPdfJs(bytes);
  compareDocCache.set(key, opened);
  return opened;
}

function ComparePageImage({
  bytes,
  page,
  cacheKey,
  label,
  className,
}: {
  bytes: ArrayBuffer;
  page: number | null;
  cacheKey: string;
  label: string;
  className?: string;
}) {
  const key = `${cacheKey}:${page ?? 0}`;
  const [loaded, setLoaded] = useState<{ key: string; src: string } | null>(() => {
    const cached = page ? pageImageCache.get(key) : null;
    return cached ? { key, src: cached } : null;
  });
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const src = loaded?.key === key ? loaded.src : null;
  const failed = failedKey === key;
  useEffect(() => {
    if (!page || src) return;
    let alive = true;
    (async () => {
      const doc = await openCompareDocument(cacheKey, bytes);
      const rendered = await renderPdfPage(doc, page, { targetWidth: 520, type: "image/jpeg", quality: 0.82, rotation: 0 });
      if (!alive) return;
      if (pageImageCache.size > 60) pageImageCache.clear();
      pageImageCache.set(key, rendered.dataUrl);
      setLoaded({ key, src: rendered.dataUrl });
    })().catch(() => {
      if (alive) setFailedKey(key);
    });
    return () => {
      alive = false;
    };
  }, [bytes, page, key, src, cacheKey]);

  if (!page) {
    return (
      <div className={cn("flex aspect-[3/4] items-center justify-center rounded border border-dashed border-line bg-bone-deep/30 p-3 text-center text-[11px] text-muted", className)}>
        This page only exists in the other document.
      </div>
    );
  }
  if (failed) {
    return (
      <div className={cn("flex aspect-[3/4] items-center justify-center rounded border border-line bg-bone-deep/30 p-3 text-center text-[11px] text-muted", className)}>
        This page couldn’t be rendered.
      </div>
    );
  }
  if (!src) {
    return <div className={cn("flex aspect-[3/4] animate-pulse items-center justify-center rounded border border-line bg-bone-deep/40 text-[11px] text-ink/70", className)}>Rendering page…</div>;
  }
  return (
    <img src={src} alt={label} className={cn("w-full rounded border border-line bg-white object-contain", className)} loading="lazy" decoding="async" draggable={false} />
  );
}

/** Runs the report builder on the next click without letting a thrown error break the UI. */
const buildReportSafe = (build: () => void) => () => {
  try {
    build();
  } catch {
    /* the report is a convenience; the diff itself stays on screen */
  }
};

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const csvCell = (value: string) => `"${value.replace(/"/g, '""')}"`;

export function CompareTool() {
  const initialFiles = useInitialFiles().filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
  const [leftFile, setLeftFile] = useState<File | null>(initialFiles[0] ?? null);
  const [rightFile, setRightFile] = useState<File | null>(initialFiles[1] ?? null);
  const prefs = useToolPreferences("compare", {
    mode: "inline" as CompareMode,
    ignoreWhitespace: false,
    ignoreCase: false,
    showSame: false,
    reportFormat: "html" as ReportFormat,
    reportIncludeSame: false,
    overlayOpacity: 55,
  });
  const [range, setRange] = useState("");
  const [error, setError] = useState("");
  const [pageCounts, setPageCounts] = useState<{ left: number; right: number }>({ left: 0, right: 0 });
  const [report, setReport] = useState<{ bytes: Uint8Array; name: string; mime: string } | null>(null);
  const [copied, setCopied] = useState<"idle" | "ok" | "no">("idle");
  const [previous, setPrevious] = useState<CompareResult | null>(null);
  const [reportNames, setReportNames] = useState<{ left: string; right: string }>({ left: "", right: "" });
  const job = useJob<CompareResult>();
  // Keep the last finished comparison on screen while a new run is cancelled.
  const result = job.result ?? previous;
  const pages = result?.pages ?? null;
  const summary = result?.summary ?? null;
  const maxPages = Math.max(pageCounts.left, pageCounts.right);

  useEffect(() => {
    if (job.result) setPrevious(job.result);
  }, [job.result]);

  // Know both page counts up front so the range field validates live.
  useEffect(() => {
    if (!leftFile && !rightFile) {
      setPageCounts({ left: 0, right: 0 });
      return;
    }
    let alive = true;
    (async () => {
      const [left, right] = await Promise.all([
        leftFile ? readFileBytes(leftFile).then((bytes) => openPdfJs(bytes)).then((doc) => { const count = doc.numPages; void doc.destroy(); return count; }) : Promise.resolve(0),
        rightFile ? readFileBytes(rightFile).then((bytes) => openPdfJs(bytes)).then((doc) => { const count = doc.numPages; void doc.destroy(); return count; }) : Promise.resolve(0),
      ]).catch(() => [0, 0] as [number, number]);
      if (alive) setPageCounts({ left, right });
    })();
    return () => {
      alive = false;
    };
  }, [leftFile, rightFile]);

  const leftCacheKey = useMemo(
    () => `${leftFile?.name ?? "left"}:${leftFile?.size ?? 0}:${leftFile?.lastModified ?? 0}`,
    [leftFile],
  );
  const rightCacheKey = useMemo(
    () => `${rightFile?.name ?? "right"}:${rightFile?.size ?? 0}:${rightFile?.lastModified ?? 0}`,
    [rightFile],
  );

  const compare = async () => {
    if (!leftFile || !rightFile) {
      setError("Add both PDFs to compare.");
      return;
    }
    setError("");
    setReport(null);
    setCopied("idle");
    const leftName = leftFile.name;
    const rightName = rightFile.name;
    setReportNames({ left: leftName, right: rightName });
    const ignoreWhitespace = prefs.value.ignoreWhitespace;
    const ignoreCase = prefs.value.ignoreCase;
    await job.run(async ({ report: reportProgress, throwIfCancelled }) => {
      const leftBytes = await readFileBytes(leftFile);
      const rightBytes = await readFileBytes(rightFile);
      const [left, right] = await Promise.all([
        extractDocument(leftBytes, { onProgress: (done, total) => reportProgress((done / Math.max(1, total)) * 35, "Reading the original…") }),
        extractDocument(rightBytes, { onProgress: (done, total) => reportProgress(35 + (done / Math.max(1, total)) * 35, "Reading the revised copy…") }),
      ]);
      throwIfCancelled();
      const maxPages = Math.max(left.totalPages, right.totalPages);
      let selected: number[];
      try {
        selected = parsePageQuery(range, maxPages);
      } catch (err) {
        // Re-throw the parser's human message while keeping the original cause.
        const failure = new Error((err as Error).message);
        (failure as Error & { cause?: unknown }).cause = err;
        throw failure;
      }
      const normalize = (text: string) => {
        let out = text;
        if (ignoreWhitespace) out = out.replace(/\s+/g, " ").trim();
        if (ignoreCase) out = out.toLowerCase();
        return out;
      };
      const pageDiffs: PageDiff[] = [];
      for (let index = 0; index < selected.length; index++) {
        throwIfCancelled();
        const pageNumber = selected[index];
        const leftLines = left.pages[pageNumber - 1]?.lines.map((line) => line.text) ?? [];
        const rightLines = right.pages[pageNumber - 1]?.lines.map((line) => line.text) ?? [];
        const lines = diffLines(leftLines, rightLines, normalize);
        const counts = countChanges(lines);
        const same = lines.filter((line) => line.kind === "same").length;
        const denominator = Math.max(1, leftLines.length, rightLines.length);
        const blankPage = leftLines.length === 0 && rightLines.length === 0;
        pageDiffs.push({
          page: pageNumber,
          lines,
          added: lines.filter((line) => line.kind === "added").length,
          removed: lines.filter((line) => line.kind === "removed").length,
          changed: counts.changed,
          matchPercent: blankPage ? 100 : Math.round((same / denominator) * 100),
          leftLines: leftLines.length,
          rightLines: rightLines.length,
        });
        reportProgress(70 + ((index + 1) / Math.max(1, selected.length)) * 30, `Compared page ${pageNumber} of ${maxPages}…`);
      }
      const totalSame = pageDiffs.reduce((sum, page) => sum + page.lines.filter((line) => line.kind === "same").length, 0);
      const totalLines = pageDiffs.reduce((sum, page) => sum + Math.max(page.leftLines, page.rightLines), 0);
      const pageSummary: CompareSummary = {
        added: pageDiffs.reduce((sum, page) => sum + page.added, 0),
        removed: pageDiffs.reduce((sum, page) => sum + page.removed, 0),
        changed: pageDiffs.reduce((sum, page) => sum + page.changed, 0),
        changedPages: pageDiffs.filter((page) => page.added || page.removed).length,
        totalPages: selected.length,
        matchPercent: Math.round((totalSame / Math.max(1, totalLines)) * 100),
        leftPages: left.totalPages,
        rightPages: right.totalPages,
        ignoreWhitespace,
        ignoreCase,
      };
      return {
        pages: pageDiffs,
        summary: pageSummary,
        leftBytes,
        rightBytes,
        pageRange: range.trim(),
        ignoreWhitespace,
        ignoreCase,
      };
    });
  };

  useEffect(() => {
    setReport(null);
    setPrevious(null);
    pageImageCache.clear();
    compareDocCache.clear();
    job.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftFile, rightFile]);

  const summaryText = () => {
    if (!pages || !summary) return "";
    const lines = [
      "Paperly PDF comparison",
      `Original: ${reportNames.left || leftFile?.name || "(unnamed)"}`,
      `Revised:  ${reportNames.right || rightFile?.name || "(unnamed)"}`,
      `Pages compared: ${summary.totalPages}${result?.pageRange ? ` (range ${result.pageRange})` : ""}`,
      `Matching text: ${summary.matchPercent}%`,
      `Changed lines: ${summary.changed} · added: ${summary.added} · removed: ${summary.removed}`,
      `Pages that differ: ${summary.changedPages} of ${summary.totalPages}`,
      summary.ignoreWhitespace || summary.ignoreCase
        ? `Ignored: ${[summary.ignoreWhitespace ? "whitespace" : "", summary.ignoreCase ? "case" : ""].filter(Boolean).join(", ")}`
        : "Comparison is exact (case and spacing matter).",
    ];
    return lines.join("\n");
  };

  const exportReport = () => {
    if (!pages || !summary) return;
    const stamp = new Date().toISOString().slice(0, 10);
    if (prefs.value.reportFormat === "csv") {
      const rows: string[] = [["page", "kind", "match_percent", "text"].map(csvCell).join(",")];
      pages.forEach((page) => {
        page.lines.forEach((line) => {
          if (line.kind === "same" && !prefs.value.reportIncludeSame) return;
          rows.push([String(page.page), line.kind, String(page.matchPercent), line.text].map(csvCell).join(","));
        });
      });
      const bytes = new TextEncoder().encode(`${rows.join("\r\n")}\r\n`);
      setReport({ bytes, name: `paperly-compare-${stamp}.csv`, mime: "text/csv" });
      return;
    }
    const rows = pages
      .map((page) => {
        const body = page.lines
          .filter((line) => prefs.value.reportIncludeSame || line.kind !== "same")
          .map(
            (line) =>
              `<tr class="${line.kind}"><td>${line.kind === "added" ? "+" : line.kind === "removed" ? "−" : ""}</td><td><code>${escapeHtml(
                line.text,
              )}</code></td></tr>`,
          )
          .join("");
        return `<section><h2>Page ${page.page} <small>${page.matchPercent}% match · +${page.added} −${page.removed} · ${page.changed} changed</small></h2><table>${body}</table></section>`;
      })
      .join("");
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>Paperly comparison · ${escapeHtml(reportNames.left || "original")} vs ${escapeHtml(reportNames.right || "revised")}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 32px; background: #f7f5f0; color: #1d2a24; font: 14px/1.6 ui-sans-serif, system-ui, sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 24px 0 8px; }
  h2 small { font-weight: 400; color: #6b7a72; margin-left: 8px; }
  .summary { background: #fff; border: 1px solid #e2ded4; border-radius: 12px; padding: 16px 20px; }
  .summary dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 16px; margin: 12px 0 0; }
  .summary dt { color: #6b7a72; }
  .summary dd { margin: 0; font-weight: 600; }
  section { background: #fff; border: 1px solid #e2ded4; border-radius: 12px; padding: 12px 16px 16px; margin-top: 16px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 2px 6px; vertical-align: top; }
  td:first-child { width: 18px; text-align: center; color: #6b7a72; }
  code { white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; }
  tr.added { background: rgba(28,76,59,.08); }
  tr.removed { background: rgba(232,97,60,.08); }
</style></head>
<body>
  <h1>PDF comparison</h1>
  <div class="summary">
    <dl>
      <dt>Original</dt><dd>${escapeHtml(reportNames.left || "original.pdf")}</dd>
      <dt>Revised</dt><dd>${escapeHtml(reportNames.right || "revised.pdf")}</dd>
      <dt>Pages compared</dt><dd>${summary.totalPages}${result?.pageRange ? ` (${escapeHtml(result.pageRange)})` : ""}</dd>
      <dt>Matching text</dt><dd>${summary.matchPercent}%</dd>
      <dt>Added / removed / changed</dt><dd>${summary.added} / ${summary.removed} / ${summary.changed}</dd>
      <dt>Pages that differ</dt><dd>${summary.changedPages} of ${summary.totalPages}</dd>
      <dt>Ignored</dt><dd>${[summary.ignoreWhitespace ? "whitespace" : "", summary.ignoreCase ? "case" : ""].filter(Boolean).join(", ") || "nothing"}</dd>
    </dl>
  </div>
  ${rows || "<p>No text differences were found.</p>"}
  <p style="margin-top:24px;color:#6b7a72;font-size:12px">Generated locally by Paperly. The comparison uses each PDF’s text layer; layout, images and styling are not compared.</p>
</body></html>`;
    setReport({
      bytes: new TextEncoder().encode(html),
      name: `paperly-compare-${stamp}.html`,
      mime: "text/html",
    });
  };

  const copySummary = async () => {
    if (!pages || !summary) return;
    const ok = await copyOutput(new TextEncoder().encode(summaryText()), "text/plain");
    setCopied(ok ? "ok" : "no");
    window.setTimeout(() => setCopied("idle"), 2200);
  };

  const downloadReport = () => {
    if (!report) return;
    downloadOutput(report.bytes, report.name, report.mime);
  };

  usePrimaryShortcut(() => void compare(), Boolean(leftFile && rightFile) && !job.busy);
  useDownloadShortcut(downloadReport, Boolean(report));

  const visible = pages?.filter((page) => prefs.value.showSame || page.added || page.removed || page.changed) ?? [];
  const hunks = pages ? firstHunks(pages) : [];
  const overlayOpacity = prefs.value.overlayOpacity / 100;
  const inline = prefs.value.mode === "inline";

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        {[
          { label: "Original PDF", file: leftFile, set: setLeftFile, tone: "clay" as const },
          { label: "Revised PDF", file: rightFile, set: setRightFile, tone: "forest" as const },
        ].map((slot) => (
          <div key={slot.label}>
            <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">
              <span className={cn("h-1.5 w-1.5 rounded-full", slot.tone === "clay" ? "bg-clay" : "bg-forest")} /> {slot.label}
            </p>
            {slot.file ? (
              <FileRow file={slot.file} onRemove={() => slot.set(null)} size={formatBytes(slot.file.size)} />
            ) : (
              <FileDrop
                accept="application/pdf,.pdf"
                acceptLabel="A PDF file"
                compact
                onFiles={(files) => slot.set(files[0])}
              />
            )}
          </div>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/55">View</p>
          <Segmented
            value={prefs.value.mode}
            onChange={(mode) => prefs.set("mode", mode)}
            size="sm"
            options={[
              { value: "inline", label: "Inline diff", icon: <FileSearch className="h-3.5 w-3.5" /> },
              { value: "side-by-side", label: "Side by side", icon: <Columns2 className="h-3.5 w-3.5" /> },
              { value: "overlay", label: "Overlay", icon: <Layers className="h-3.5 w-3.5" /> },
            ]}
          />
        </div>
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/55">Compared text</p>
          <Switch checked={prefs.value.ignoreWhitespace} onChange={(v) => prefs.set("ignoreWhitespace", v)} label="Ignore whitespace" />
          <Switch checked={prefs.value.ignoreCase} onChange={(v) => prefs.set("ignoreCase", v)} label="Ignore capitalisation" />
        </div>
      </div>

      <RangeField
        value={range}
        onChange={setRange}
        total={maxPages}
        label="Pages to compare"
        hint="Leave empty to compare every page in both files."
      />

      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <Button onClick={() => void compare()} loading={job.busy} disabled={!leftFile || !rightFile}>
          <ArrowLeftRight className="h-4 w-4" /> Compare documents
        </Button>
        {job.busy && (
          <Button variant="ghost" size="sm" onClick={job.cancel}>
            Cancel
          </Button>
        )}
        {pages && (
          <Button variant="outline" onClick={() => prefs.set("showSame", !prefs.value.showSame)}>
            {prefs.value.showSame ? "Hide unchanged lines" : "Show unchanged lines"}
          </Button>
        )}
        <span className="text-[11.5px] text-muted">Compares the text layer, page by page. Nothing leaves this tab.</span>
      </div>
      {job.busy && <Progress value={job.percent ?? undefined} label={job.label} detail={describeJobTime(job)} etaMs={job.etaMs} />}
      {job.status === "cancelled" && (
        <Alert tone="info">Cancelled — nothing was downloaded{previous ? ", and the previous comparison is still shown below" : ""}.</Alert>
      )}
      {job.failed && <Alert tone="error">{job.error}</Alert>}

      {summary && pages && result && (
        <div className="space-y-4">
          <div className={cn("rounded-2xl border p-5", summary.added + summary.removed === 0 ? "border-forest/20 bg-lime/20" : "border-line bg-paper")}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-[16px] font-semibold">
                  {summary.added + summary.removed === 0 ? "The text is identical" : `${summary.changedPages} of ${summary.totalPages} pages differ`}
                </h3>
                <p className="mt-0.5 text-[12px] text-muted">
                  {summary.added} added line{summary.added === 1 ? "" : "s"} · {summary.removed} removed line{summary.removed === 1 ? "" : "s"} ·{" "}
                  {summary.changed} changed · {summary.matchPercent}% of the text matches
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="forest">+{summary.added}</Badge>
                <Badge tone="clay">−{summary.removed}</Badge>
                <Button variant="outline" size="sm" onClick={buildReportSafe(exportReport)}>
                  <Download className="h-3.5 w-3.5" /> Export diff report
                </Button>
                <Button variant="outline" size="sm" onClick={() => void copySummary()}>
                  <Copy className="h-3.5 w-3.5" /> {copied === "ok" ? "Copied" : copied === "no" ? "Copy blocked" : "Copy summary"}
                </Button>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {pages.map((page) => (
                <a
                  key={page.page}
                  href={`#diff-page-${page.page}`}
                  className={cn(
                    "rounded-md border px-2 py-1 text-[10.5px] font-semibold tabular-nums",
                    page.added || page.removed ? "border-clay/25 bg-clay/[0.07] text-clay-ink" : "border-line bg-bone text-ink/75",
                  )}
                  title={`Page ${page.page} · ${page.matchPercent}% match`}
                >
                  p.{page.page} · {page.matchPercent}%
                </a>
              ))}
            </div>
            {prefs.value.mode === "overlay" && (
              <label className="mt-3 flex items-center gap-3 text-[11.5px] font-medium text-ink/70">
                Overlay blend
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={prefs.value.overlayOpacity}
                  onChange={(e) => prefs.set("overlayOpacity", Number(e.target.value))}
                  className="w-40 accent-[#1c4c3b]"
                  aria-label="Overlay blend between the original and the revised page"
                />
                <span className="tabular-nums text-muted">{prefs.value.overlayOpacity}% revised</span>
              </label>
            )}
          </div>

          {hunks.length > 0 && (
            <div className="rounded-xl border border-line bg-paper p-4">
              <p className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold">
                <ScanSearch className="h-3.5 w-3.5 text-forest" /> First differences
              </p>
              <ul className="space-y-2">
                {hunks.map((hunk, index) => (
                  <li key={`${hunk.page}-${index}`} className="rounded-lg border border-line bg-bone-deep/25 px-2.5 py-2">
                    <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted">p.{hunk.page}</span>
                    <div className="mt-1 font-mono text-[11px] leading-relaxed">
                      {hunk.before.map((text, lineIndex) => (
                        <div key={`b-${lineIndex}`} className="truncate text-ink/50">
                          {text || " "}
                        </div>
                      ))}
                      {hunk.changed.map((line, lineIndex) => (
                        <div
                          key={`c-${lineIndex}`}
                          className={cn(
                            "truncate",
                            line.kind === "added" && "bg-lime/25 text-forest",
                            line.kind === "removed" && "bg-clay/[0.08] text-[#a64127]",
                          )}
                        >
                          <span className="mr-1 select-none">{line.kind === "added" ? "+" : "−"}</span>
                          {line.text || " "}
                        </div>
                      ))}
                      {hunk.after.map((text, lineIndex) => (
                        <div key={`a-${lineIndex}`} className="truncate text-ink/50">
                          {text || " "}
                        </div>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
              {hunks.length >= 6 && <p className="mt-2 text-[11px] text-muted">Showing the first differences only — export the report for the full list.</p>}
            </div>
          )}

          {visible.length === 0 && (
            <div className="rounded-xl border border-line bg-paper p-6 text-center text-[12.5px] text-muted">
              No differences found in the text layer. Layout-only changes (images, spacing) aren’t detected by this tool.
            </div>
          )}

          {inline ? (
            <div className="space-y-4">
              {visible.map((page) => (
                <div key={page.page} id={`diff-page-${page.page}`} className="overflow-hidden rounded-xl border border-line bg-paper">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-bone-deep/40 px-3.5 py-2">
                    <p className="flex items-center gap-1.5 text-[12px] font-semibold">
                      <FileSearch className="h-3.5 w-3.5 text-forest" /> Page {page.page}
                    </p>
                    <span className="text-[10.5px] font-medium text-muted">
                      {page.matchPercent}% match · <span className="text-forest">+{page.added}</span> ·{" "}
                      <span className="text-clay-ink">−{page.removed}</span> · {page.changed} changed
                    </span>
                  </div>
                  <div className="max-h-[340px] overflow-y-auto p-2 scrollbar-thin">
                    {page.lines
                      .filter((line) => prefs.value.showSame || line.kind !== "same")
                      .map((line, index) => (
                        <div
                          key={`${page.page}-${index}`}
                          className={cn(
                            "flex gap-2 rounded px-2 py-[3px] font-mono text-[11px] leading-relaxed",
                            line.kind === "added" && "bg-lime/25 text-forest",
                            line.kind === "removed" && "bg-clay/[0.08] text-[#a64127]",
                            line.kind === "same" && "text-ink/75",
                          )}
                        >
                          <span className="w-3 shrink-0 select-none text-center">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : ""}</span>
                          <span className="whitespace-pre-wrap break-words">{line.text || " "}</span>
                        </div>
                      ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-4">
              {visible.slice(0, 25).map((page) => (
                <div key={page.page} id={`diff-page-${page.page}`} className="overflow-hidden rounded-xl border border-line bg-paper">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-bone-deep/40 px-3.5 py-2">
                    <p className="flex items-center gap-1.5 text-[12px] font-semibold">
                      {prefs.value.mode === "overlay" ? <Layers className="h-3.5 w-3.5 text-forest" /> : <Columns2 className="h-3.5 w-3.5 text-forest" />} Page {page.page}
                    </p>
                    <span className="text-[10.5px] font-medium text-muted">
                      {page.matchPercent}% match · <span className="text-forest">+{page.added}</span> ·{" "}
                      <span className="text-clay-ink">−{page.removed}</span> · {page.changed} changed
                    </span>
                  </div>
                  <div className={cn("grid gap-2 p-3", prefs.value.mode === "side-by-side" && "sm:grid-cols-2")}>
                    <div>
                      <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-clay-ink">Original</p>
                      <div className="relative">
                        <ComparePageImage
                          bytes={result.leftBytes}
                          page={page.page <= summary.leftPages ? page.page : null}
                          cacheKey={leftCacheKey}
                          label={`Original page ${page.page}`}
                        />
                        {prefs.value.mode === "overlay" && (
                          <div className="absolute inset-0" style={{ opacity: overlayOpacity }}>
                            <ComparePageImage
                              bytes={result.rightBytes}
                              page={page.page <= summary.rightPages ? page.page : null}
                              cacheKey={rightCacheKey}
                              label={`Revised page ${page.page} overlay`}
                              className="h-full w-full object-fill"
                            />
                          </div>
                        )}
                      </div>
                    </div>
                    {prefs.value.mode === "side-by-side" && (
                      <div>
                        <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-forest">Revised</p>
                        <ComparePageImage
                          bytes={result.rightBytes}
                          page={page.page <= summary.rightPages ? page.page : null}
                          cacheKey={rightCacheKey}
                          label={`Revised page ${page.page}`}
                        />
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {visible.length > 25 && (
                <p className="text-[11.5px] text-muted">
                  Showing the first 25 changed pages of {visible.length}. Switch to the inline diff or export the report to review the rest.
                </p>
              )}
            </div>
          )}

          <p className="flex items-center gap-1.5 text-[11px] text-muted">
            <ShieldCheck className="h-3.5 w-3.5 text-forest" /> Each comparison is computed from the PDF text layer in this tab. Scanned pages have no
            text to compare.
          </p>

          <AdvancedOptions scope="compare-report" badge="2 controls" description="Diff report settings" onReset={prefs.reset}>
            <div className="space-y-3">
              <OptionsGrid>
                <Field label="Report format">
                  <Select value={prefs.value.reportFormat} onChange={(e) => prefs.set("reportFormat", e.target.value as ReportFormat)}>
                    <option value="html">HTML — readable, with colours</option>
                    <option value="csv">CSV — for spreadsheets</option>
                  </Select>
                </Field>
                <div className="flex items-end">
                  <Switch
                    checked={prefs.value.reportIncludeSame}
                    onChange={(v) => prefs.set("reportIncludeSame", v)}
                    label="Include unchanged lines"
                  />
                </div>
              </OptionsGrid>
              <Button variant="outline" size="sm" onClick={buildReportSafe(exportReport)}>
                <Download className="h-3.5 w-3.5" /> Build {prefs.value.reportFormat === "html" ? "HTML" : "CSV"} report
              </Button>
              <OptionNote>The report lists every changed line per page with counts and match percentages. It never leaves your device.</OptionNote>
            </div>
          </AdvancedOptions>

          {report && (
            <DownloadPanel
              bytes={report.bytes}
              title="Diff report is ready"
              filename={report.name}
              size={report.bytes.byteLength}
              onDownload={downloadReport}
              mime={report.mime}
              description={`${summary.totalPages} page${summary.totalPages === 1 ? "" : "s"} compared · ${summary.added + summary.removed} differing line${
                summary.added + summary.removed === 1 ? "" : "s"
              } · ${prefs.value.reportFormat.toUpperCase()} format`}
            />
          )}
        </div>
      )}
    </div>
  );
}
