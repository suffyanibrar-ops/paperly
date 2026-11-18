import {
  Copy,
  FileDown,
  Grid2x2,
  Hash,
  LayoutTemplate,
  ListOrdered,
  Printer,
  Rows3,
  Scaling,
  Stamp,
} from "lucide-react";
import JSZip from "jszip";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames,
  PDFRef,
  PDFStream,
  PDFAnnotation,
} from "@cantoo/pdf-lib";
import {
  PDFDocument,
  StandardFonts,
  baseName,
  dataUrlToBytes,
  downloadBytes,
  formatBytes,
  degrees,
  hexToRgb,
  safePdfText,
  openPdfJs,
  openPdfLib,
  parseRanges,
  renderPdfPage,
  sanitizeName,
  uniqueInOrder,
  type PDFPage,
} from "@/lib/pdf";
import { useInitialFiles, usePdfFile } from "@/lib/usePdf";
import { friendlyProcessingError, validateUpload } from "@/lib/security";
import {
  Alert,
  Button,
  ColorInput,
  Field,
  Progress,
  Select,
  StepHeader,
  Switch,
  inputClass,
} from "@/components/ui";
import { DownloadPanel, RangeField, SinglePdfInput } from "@/components/toolParts";
import { AdvancedOptions, NumberField, OptionNote, OptionsGrid, SliderField } from "@/components/AdvancedOptions";
import {
  bookletSequence,
  drawSlots,
  layoutFont,
  paperDimensions,
  placeEmbeddedPage,
  replacePlaceholders,
  type PaperKey,
  type PlaceMode,
  type SlotTexts,
} from "@/lib/layout";
import { describeJobTime, useJob, type JobController, type JobReporter } from "@/lib/job";
import { useDownloadShortcut, usePrimaryShortcut } from "@/lib/hotkeys";
import { useToolPreferences } from "@/lib/prefs";
import { validatePageQuery } from "@/lib/pageQuery";
import { downloadOutput } from "@/lib/output";
import { cn } from "@/utils/cn";

const MM = 2.834645669;

/* ================================================================== *
 * Shared helpers
 * ================================================================== */

/** One cancellable runner: progress/ETA/cancel from the job, result kept apart. */
function useRunner<T>() {
  const job = useJob<T>();
  const [result, setResult] = useState<T | null>(null);
  const { run: startJob, reset: resetJob } = job;
  const run = useCallback(
    async (task: (reporter: JobReporter) => Promise<T>) => {
      const value = await startJob(task);
      if (value !== null) setResult(value);
      return value;
    },
    [startJob],
  );
  const clear = useCallback(() => {
    setResult(null);
    resetJob();
  }, [resetJob]);
  return { job, result, run, clear };
}

function JobProgress<T>({ job }: { job: JobController<T> }) {
  return <Progress value={job.percent ?? undefined} label={job.label} etaMs={job.etaMs} detail={describeJobTime(job)} />;
}

function JobError<T>({ job }: { job: JobController<T> }) {
  if (!job.failed) return null;
  return (
    <Alert tone="error" title="That didn’t work">
      {job.error}
    </Alert>
  );
}

function CancelledNote<T>({ job }: { job: JobController<T> }) {
  if (job.status !== "cancelled") return null;
  return <Alert tone="info">Cancelled — nothing was downloaded. Your file and options are still here.</Alert>;
}

function ModeGrid<T extends string>({
  value,
  onChange,
  options,
  label = "Mode",
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; hint?: string }[];
  label?: string;
}) {
  return (
    <div role="group" aria-label={label} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-xl border px-2.5 py-2 text-left transition-colors",
              active ? "border-forest bg-forest text-paper" : "border-line bg-paper text-ink/70 hover:border-forest/30",
            )}
          >
            <span className="block text-[12.5px] font-semibold leading-tight">{option.label}</span>
            {option.hint ? (
              <span className={cn("mt-0.5 block text-[10.5px] leading-snug", active ? "text-paper/70" : "text-muted")}>{option.hint}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/* ================================================================== *
 * RESIZE PDF
 * ================================================================== */
type ResizeMode = PlaceMode | "scale";

export function ResizeTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const prefs = useToolPreferences("resize", {
    paper: "a4" as PaperKey,
    orientation: "portrait" as "portrait" | "landscape",
    mode: "fit" as ResizeMode,
    scale: 90,
    margin: 0,
    matchOrientation: false,
    keepOutside: true,
    customW: 210,
    customH: 297,
  });
  const [range, setRange] = useState("");
  const [error, setError] = useState("");
  const { job, result, run, clear } = useRunner<{ bytes: Uint8Array; name: string; pages: number; resized: number }>();

  const custom = { w: prefs.value.customW * MM, h: prefs.value.customH * MM };
  const sheet = paperDimensions(prefs.value.paper, prefs.value.orientation, custom);
  const resizeMode = prefs.value.mode;

  useEffect(() => {
    clear();
    setError("");
  }, [pdf.bytes, clear]);

  const targetFor = (rotation: number, width: number, height: number) => {
    if (!prefs.value.matchOrientation) return sheet;
    const turned = Math.abs(rotation) % 180 === 90;
    const landscape = turned ? height > width : width > height;
    return landscape
      ? { w: Math.max(sheet.w, sheet.h), h: Math.min(sheet.w, sheet.h) }
      : { w: Math.min(sheet.w, sheet.h), h: Math.max(sheet.w, sheet.h) };
  };

  const apply = async () => {
    if (!pdf.bytes || !pdf.file) return;
    setError("");
    void run(async ({ step, throwIfCancelled }) => {
      const wanted = new Set(uniqueInOrder(parseRanges(range, pdf.pageCount)));
      const src = await openPdfLib(pdf.bytes as ArrayBuffer);
      const out = await PDFDocument.create();
      const sourcePages = src.getPages();
      const embedded = await out.embedPages(sourcePages);
      const pad = prefs.value.margin * MM;
      let resized = 0;
      for (let index = 0; index < sourcePages.length; index++) {
        throwIfCancelled();
        const pageNumber = index + 1;
        if (!wanted.has(pageNumber)) {
          if (prefs.value.keepOutside) {
            const [copied] = await out.copyPages(src, [index]);
            out.addPage(copied);
          }
          step(pageNumber, sourcePages.length, "Reflowing pages…", `${pageNumber} of ${sourcePages.length}`);
          continue;
        }
        const rotation = sourcePages[index].getRotation().angle;
        const target = targetFor(rotation, sourcePages[index].getWidth(), sourcePages[index].getHeight());
        const page = out.addPage([target.w, target.h]);
        if (resizeMode === "scale") {
          const turned = Math.abs(rotation) % 180 === 90;
          const visualW = turned ? embedded[index].height : embedded[index].width;
          const visualH = turned ? embedded[index].width : embedded[index].height;
          const scale = Math.max(10, Math.min(200, prefs.value.scale)) / 100;
          const drawW = visualW * scale;
          const drawH = visualH * scale;
          placeEmbeddedPage(
            page,
            embedded[index],
            { x: (target.w - drawW) / 2, y: (target.h - drawH) / 2, w: drawW, h: drawH },
            "stretch",
            { rotation },
          );
        } else {
          placeEmbeddedPage(
            page,
            embedded[index],
            { x: pad, y: pad, w: Math.max(10, target.w - pad * 2), h: Math.max(10, target.h - pad * 2) },
            resizeMode,
            { rotation },
          );
        }
        resized += 1;
        step(pageNumber, sourcePages.length, "Reflowing pages…", `${pageNumber} of ${sourcePages.length}`);
      }
      const bytes = await out.save();
      return {
        bytes,
        name: `${sanitizeName(baseName(pdf.file!.name))}-resized.pdf`,
        pages: out.getPageCount(),
        resized,
      };
    });
  };

  usePrimaryShortcut(apply, Boolean(pdf.bytes) && !job.busy);
  useDownloadShortcut(
    () => {
      if (result) downloadOutput(result.bytes, result.name, "application/pdf");
    },
    Boolean(result),
  );

  const mm = (points: number) => Math.round(points / MM);

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to resize" />
      {pdf.bytes && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="New page size">
              <Select
                value={prefs.value.paper}
                onChange={(event) => {
                  prefs.set("paper", event.target.value as PaperKey);
                  clear();
                }}
              >
                <option value="a4">A4 · 210 × 297 mm</option>
                <option value="letter">US Letter · 8.5 × 11 in</option>
                <option value="legal">US Legal · 8.5 × 14 in</option>
                <option value="a5">A5 · 148 × 210 mm</option>
                <option value="a3">A3 · 297 × 420 mm</option>
                <option value="tabloid">Tabloid · 11 × 17 in</option>
                <option value="custom">Custom size…</option>
              </Select>
            </Field>
            <Field label="Orientation">
              <Select
                value={prefs.value.orientation}
                onChange={(event) => {
                  prefs.set("orientation", event.target.value as "portrait" | "landscape");
                  clear();
                }}
                disabled={prefs.value.matchOrientation}
              >
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </Select>
            </Field>
            <Field label="Content scaling">
              <Select
                value={prefs.value.mode}
                onChange={(event) => {
                  prefs.set("mode", event.target.value as ResizeMode);
                  clear();
                }}
              >
                <option value="fit">Fit inside the page</option>
                <option value="fill">Fill the page (may crop)</option>
                <option value="stretch">Stretch to exact size</option>
                <option value="actual">Actual size, centred</option>
                <option value="scale">Scale by a percentage</option>
              </Select>
            </Field>
            <Field label="Margin" hint={`${prefs.value.margin} mm around the content`}>
              <input
                type="range"
                min={0}
                max={40}
                value={prefs.value.margin}
                disabled={prefs.value.mode === "scale"}
                onChange={(event) => {
                  prefs.set("margin", Number(event.target.value));
                  clear();
                }}
                className="mt-3 w-full accent-[#1c4c3b]"
              />
            </Field>
          </div>

          {prefs.value.mode === "scale" && (
            <SliderField
              label="Scale"
              value={prefs.value.scale}
              onChange={(value) => {
                prefs.set("scale", value);
                clear();
              }}
              min={10}
              max={200}
              step={5}
              format={(value) => `${value}%`}
              hint="100% keeps the original size. The page itself still becomes the selected paper size."
            />
          )}

          {prefs.value.paper === "custom" && (
            <div className="grid grid-cols-2 gap-3">
              <NumberField
                label="Width"
                value={prefs.value.customW}
                onChange={(value) => {
                  prefs.set("customW", value);
                  clear();
                }}
                min={50}
                max={2000}
                suffix="mm"
              />
              <NumberField
                label="Height"
                value={prefs.value.customH}
                onChange={(value) => {
                  prefs.set("customH", value);
                  clear();
                }}
                min={50}
                max={2000}
                suffix="mm"
              />
            </div>
          )}

          <RangeField
            value={range}
            onChange={(value) => {
              setRange(value);
              clear();
              setError("");
            }}
            total={pdf.pageCount}
            label="Pages to resize"
            hint="Pages outside the range stay at their original size."
          />

          <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
            <div className="rounded-xl border border-line bg-bone-deep/35 p-3 text-[11.5px] leading-relaxed text-ink/70">
              <p className="flex items-center gap-1.5 font-semibold text-forest">
                <Scaling className="h-3.5 w-3.5" /> {mm(sheet.w)} × {mm(sheet.h)} mm per page
              </p>
              <p className="mt-1">
                Pages are embedded as vectors, so text stays sharp and searchable. Rotated pages keep their orientation.
                Nothing is uploaded.
              </p>
              <p className="mt-1 text-[11px]">
                {prefs.value.matchOrientation
                  ? "Each page picks the orientation that matches its own shape."
                  : `${pdf.pageCount} page${pdf.pageCount === 1 ? "" : "s"} become ${
                      prefs.value.orientation === "portrait" ? "portrait" : "landscape"
                    } ${prefs.value.paper === "custom" ? "custom" : prefs.value.paper.toUpperCase()} pages.`}
              </p>
            </div>
            <div className="flex items-center justify-center rounded-xl border border-line bg-bone-deep/30 p-3">
              <div className="flex w-full items-center justify-center gap-2">
                <div className="flex flex-col items-center gap-1">
                  <div className="h-14 w-10 rounded border border-ink/25 bg-paper" />
                  <span className="text-[9.5px] text-muted">source</span>
                </div>
                <span className="text-[11px] text-ink/50">→</span>
                <div className="flex flex-col items-center gap-1">
                  <div
                    className="rounded border border-forest/40 bg-lime/30"
                    style={{
                      aspectRatio: `${sheet.w} / ${sheet.h}`,
                      height: sheet.h >= sheet.w ? 56 : undefined,
                      width: sheet.h >= sheet.w ? undefined : 56,
                    }}
                  />
                  <span className="text-[9.5px] text-forest">target</span>
                </div>
              </div>
            </div>
          </div>

          <AdvancedOptions scope="resize" badge="2 controls" description="Per-page orientation and range handling" onReset={prefs.reset}>
            <OptionsGrid>
              <Switch
                checked={prefs.value.matchOrientation}
                onChange={(value) => {
                  prefs.set("matchOrientation", value);
                  clear();
                }}
                label="Match each page’s orientation"
                description="Landscape pages stay landscape, portrait pages stay portrait."
              />
              <Switch
                checked={prefs.value.keepOutside}
                onChange={(value) => {
                  prefs.set("keepOutside", value);
                  clear();
                }}
                label="Keep pages outside the range untouched"
                description="Off: pages outside the range are left out of the result."
              />
            </OptionsGrid>
          </AdvancedOptions>

          {error && <Alert tone="error">{error}</Alert>}
          <JobError job={job} />
          <CancelledNote job={job} />

          <div className="flex flex-wrap items-center gap-2.5 border-t border-line pt-4">
            <Button onClick={apply} loading={job.busy}>
              <Scaling className="h-4 w-4" /> Resize PDF
            </Button>
            {job.busy && (
              <Button variant="ghost" onClick={job.cancel}>
                Cancel
              </Button>
            )}
            <span className="text-[11px] text-muted">⌘/Ctrl + Enter</span>
          </div>
          {job.busy && <JobProgress job={job} />}
        </>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Pages resized"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          originalSize={pdf.file?.size}
          mime="application/pdf"
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${result.resized} page${result.resized === 1 ? "" : "s"} fitted to ${mm(sheet.w)} × ${mm(sheet.h)} mm · ${result.pages} pages total`}
          facts={[{ label: "Layout", value: `${mm(sheet.w)} × ${mm(sheet.h)} mm` }]}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * N-UP & BOOKLET
 * ================================================================== */
type NUpMode = "2" | "4" | "6" | "9" | "booklet";

const NUP_MODES: { value: NUpMode; label: string; icon: typeof Rows3 }[] = [
  { value: "2", label: "2 per sheet", icon: Rows3 },
  { value: "4", label: "4 per sheet", icon: Grid2x2 },
  { value: "6", label: "6 per sheet", icon: LayoutTemplate },
  { value: "9", label: "9 per sheet", icon: Grid2x2 },
  { value: "booklet", label: "Booklet", icon: Printer },
];

function nupGrid(mode: NUpMode): { cols: number; rows: number } {
  if (mode === "2" || mode === "booklet") return { cols: 2, rows: 1 };
  if (mode === "4") return { cols: 2, rows: 2 };
  if (mode === "6") return { cols: 3, rows: 2 };
  return { cols: 3, rows: 3 };
}

export function NUpTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const prefs = useToolPreferences("n-up", {
    mode: "2" as NUpMode,
    paper: "a4" as PaperKey,
    orientation: "landscape" as "portrait" | "landscape",
    margin: 8,
    gap: 4,
    border: true,
    readingOrder: "column" as "column" | "row",
    numbers: false,
  });
  const [range, setRange] = useState("");
  const [error, setError] = useState("");
  const { job, result, run, clear } = useRunner<{ bytes: Uint8Array; name: string; sheets: number; source: number }>();

  const mode = prefs.value.mode;
  const perSheet = mode === "booklet" ? 2 : Number(mode);
  const grid = nupGrid(mode);
  const sheet = paperDimensions(prefs.value.paper, mode === "booklet" ? "landscape" : prefs.value.orientation);
  const planned = useMemo(() => {
    if (!pdf.pageCount) return { count: 0, sheets: 0 };
    try {
      const pages = uniqueInOrder(parseRanges(range, pdf.pageCount));
      return {
        count: pages.length,
        sheets: mode === "booklet" ? Math.ceil(Math.ceil(pages.length / 4) * 4 / 2) : Math.ceil(pages.length / perSheet),
      };
    } catch {
      return { count: 0, sheets: 0 };
    }
  }, [range, pdf.pageCount, mode, perSheet]);

  useEffect(() => {
    clear();
    setError("");
  }, [pdf.bytes, clear]);

  const apply = async () => {
    if (!pdf.bytes || !pdf.file) return;
    const problem = validatePageQuery(range, pdf.pageCount);
    if (problem) {
      setError(problem);
      return;
    }
    setError("");
    void run(async ({ step, throwIfCancelled }) => {
      const src = await openPdfLib(pdf.bytes as ArrayBuffer);
      const out = await PDFDocument.create();
      const allPages = src.getPages();
      const wanted = uniqueInOrder(parseRanges(range, pdf.pageCount));
      const sourceIndices = wanted.map((page) => page - 1);
      const embedded = await out.embedPages(sourceIndices.map((index) => allPages[index]));
      const rotations = sourceIndices.map((index) => allPages[index].getRotation().angle);
      const font = prefs.value.numbers ? await out.embedFont(StandardFonts.Helvetica) : null;
      const m = prefs.value.margin * MM;
      const g = prefs.value.gap * MM;
      const cols = mode === "booklet" ? 2 : grid.cols;
      const rows = grid.rows;
      const cellW = (sheet.w - m * 2 - g * (cols - 1)) / cols;
      const cellH = (sheet.h - m * 2 - g * (rows - 1)) / rows;

      const drawNumber = (page: ReturnType<PDFDocument["addPage"]>, box: { x: number; y: number; w: number; h: number }, label: string) => {
        if (!font) return;
        const size = 7;
        const width = font.widthOfTextAtSize(label, size);
        const y = box.y - size - 2 >= 4 ? box.y - size - 2 : box.y + 3;
        page.drawText(label, {
          x: box.x + (box.w - width) / 2,
          y,
          size,
          font,
          color: hexToRgb("#7c8a80"),
        });
      };

      if (mode === "booklet") {
        const sequence = bookletSequence(sourceIndices.length);
        const totalSheets = sequence.length / 2;
        for (let i = 0; i < sequence.length; i += 2) {
          throwIfCancelled();
          const page = out.addPage([sheet.w, sheet.h]);
          [sequence[i], sequence[i + 1]].forEach((slotPage, column) => {
            const box = { x: m + column * (cellW + g), y: m, w: cellW, h: cellH };
            if (!slotPage) return;
            const index = slotPage - 1;
            placeEmbeddedPage(page, embedded[index], box, "fit", {
              rotation: rotations[index],
              border: prefs.value.border,
              borderColor: "#d8d3c6",
            });
            drawNumber(page, box, String(wanted[index]));
          });
          step(i / 2 + 1, totalSheets, "Imposing pages onto sheets…", `sheet ${i / 2 + 1} of ${totalSheets}`);
        }
      } else {
        const totalSheets = Math.ceil(sourceIndices.length / perSheet);
        for (let sheetIndex = 0; sheetIndex < totalSheets; sheetIndex++) {
          throwIfCancelled();
          const page = out.addPage([sheet.w, sheet.h]);
          for (let slot = 0; slot < perSheet; slot++) {
            const localIndex =
              prefs.value.readingOrder === "column" ? (slot % rows) * cols + Math.floor(slot / rows) : slot;
            const index = sheetIndex * perSheet + localIndex;
            if (index >= sourceIndices.length) continue;
            const row = Math.floor(slot / cols);
            const col = slot % cols;
            const box = {
              x: m + col * (cellW + g),
              y: sheet.h - m - (row + 1) * cellH - row * g,
              w: cellW,
              h: cellH,
            };
            placeEmbeddedPage(page, embedded[index], box, "fit", {
              rotation: rotations[index],
              border: prefs.value.border,
              borderColor: "#d8d3c6",
            });
            drawNumber(page, box, String(wanted[index]));
          }
          step(sheetIndex + 1, totalSheets, "Imposing pages onto sheets…", `sheet ${sheetIndex + 1} of ${totalSheets}`);
        }
      }

      const bytes = await out.save();
      return {
        bytes,
        name: `${sanitizeName(baseName(pdf.file!.name))}-${mode === "booklet" ? "booklet" : `${mode}up`}.pdf`,
        sheets: out.getPageCount(),
        source: sourceIndices.length,
      };
    });
  };

  usePrimaryShortcut(apply, Boolean(pdf.bytes) && !job.busy);
  useDownloadShortcut(
    () => {
      if (result) downloadOutput(result.bytes, result.name, "application/pdf");
    },
    Boolean(result),
  );

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to impose" />
      {pdf.bytes && (
        <>
          <StepHeader step={2} title="Layout" hint={`${pdf.pageCount} source pages`} />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" role="group" aria-label="Pages per sheet">
            {NUP_MODES.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={mode === option.value}
                onClick={() => {
                  prefs.set("mode", option.value);
                  clear();
                }}
                className={cn(
                  "flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-[11.5px] font-medium transition-colors",
                  mode === option.value ? "border-forest bg-forest text-paper" : "border-line bg-paper text-ink/70 hover:border-forest/30",
                )}
              >
                <option.icon className="h-4 w-4" />
                {option.label}
              </button>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Sheet size">
              <Select
                value={prefs.value.paper}
                onChange={(event) => {
                  prefs.set("paper", event.target.value as PaperKey);
                  clear();
                }}
              >
                <option value="a4">A4</option>
                <option value="letter">US Letter</option>
                <option value="legal">US Legal</option>
                <option value="a3">A3</option>
              </Select>
            </Field>
            <Field label="Orientation" hint={mode === "booklet" ? "Booklets are always landscape" : undefined}>
              <Select
                value={mode === "booklet" ? "landscape" : prefs.value.orientation}
                onChange={(event) => {
                  prefs.set("orientation", event.target.value as "portrait" | "landscape");
                  clear();
                }}
                disabled={mode === "booklet"}
              >
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </Select>
            </Field>
            <Field label="Sheet margin" hint={`${prefs.value.margin} mm`}>
              <input
                type="range"
                min={0}
                max={30}
                value={prefs.value.margin}
                onChange={(event) => {
                  prefs.set("margin", Number(event.target.value));
                  clear();
                }}
                className="mt-3 w-full accent-[#1c4c3b]"
              />
            </Field>
            <Field label="Gap between pages" hint={`${prefs.value.gap} mm`}>
              <input
                type="range"
                min={0}
                max={20}
                value={prefs.value.gap}
                onChange={(event) => {
                  prefs.set("gap", Number(event.target.value));
                  clear();
                }}
                className="mt-3 w-full accent-[#1c4c3b]"
              />
            </Field>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <Switch
              checked={prefs.value.border}
              onChange={(value) => {
                prefs.set("border", value);
                clear();
              }}
              label="Draw page borders"
              description="Handy print guides"
            />
            {mode !== "booklet" && (
              <Field label="Reading order" hint="Where page 2 goes on the sheet">
                <Select
                  value={prefs.value.readingOrder}
                  onChange={(event) => {
                    prefs.set("readingOrder", event.target.value as "column" | "row");
                    clear();
                  }}
                >
                  <option value="column">Down each column</option>
                  <option value="row">Across each row</option>
                </Select>
              </Field>
            )}
          </div>

          <RangeField
            value={range}
            onChange={(value) => {
              setRange(value);
              clear();
              setError("");
            }}
            total={pdf.pageCount}
            label="Pages to impose"
            hint="Leave empty to use the whole document."
          />

          <div className="flex items-center justify-center rounded-xl border border-line bg-bone-deep/30 p-4">
            <div
              className="grid w-full max-w-[280px] gap-1.5 rounded border border-ink/15 bg-paper p-1.5 shadow-soft"
              style={{
                aspectRatio: `${sheet.w} / ${sheet.h}`,
                gridTemplateColumns: `repeat(${grid.cols}, minmax(0,1fr))`,
                gridTemplateRows: `repeat(${grid.rows}, minmax(0,1fr))`,
              }}
            >
              {Array.from({ length: grid.cols * grid.rows }).map((_, index) => (
                <div key={index} className="flex items-center justify-center rounded-sm bg-bone-deep text-[9px] font-semibold text-ink/75">
                  {index + 1}
                </div>
              ))}
            </div>
          </div>
          <p className="text-center text-[11px] text-muted">
            {mode === "booklet"
              ? "Saddle-stitch imposition with fronts and backs. Print double-sided, flip on the short edge, then fold."
              : `Output: ${planned.sheets} sheet${planned.sheets === 1 ? "" : "s"} at ${perSheet} pages each, from ${planned.count} selected page${planned.count === 1 ? "" : "s"}.`}
          </p>

          <AdvancedOptions scope="n-up" badge="1 control" description="Page labels under each panel" onReset={prefs.reset}>
            <OptionsGrid>
              <Switch
                checked={prefs.value.numbers}
                onChange={(value) => {
                  prefs.set("numbers", value);
                  clear();
                }}
                label="Print source page numbers"
                description="Small grey number under each panel, matching the original page."
              />
              <OptionNote>Panel borders and the gutter stay as print guides only — they are not part of the page content.</OptionNote>
            </OptionsGrid>
          </AdvancedOptions>

          {error && <Alert tone="error">{error}</Alert>}
          <JobError job={job} />
          <CancelledNote job={job} />

          <div className="border-t border-line pt-4">
            <Button onClick={apply} loading={job.busy}>
              <Grid2x2 className="h-4 w-4" /> {mode === "booklet" ? "Create booklet" : "Create N-up PDF"}
            </Button>
            {job.busy && (
              <Button variant="ghost" onClick={job.cancel} className="ml-2.5">
                Cancel
              </Button>
            )}
          </div>
          {job.busy && <JobProgress job={job} />}
        </>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title={mode === "booklet" ? "Booklet ready" : "N-up PDF ready"}
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.sheets}
          originalSize={pdf.file?.size}
          mime="application/pdf"
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${result.source} source pages → ${result.sheets} sheet${result.sheets === 1 ? "" : "s"} · vectors preserved`}
          facts={[{ label: "Layout", value: mode === "booklet" ? "Booklet" : `${perSheet}-up` }]}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * HEADERS & FOOTERS
 * ================================================================== */
const BLANK: SlotTexts = { left: "", center: "", right: "" };

type SlotKey = "header-left" | "header-center" | "header-right" | "footer-left" | "footer-center" | "footer-right";

export function HeadersFootersTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const prefs = useToolPreferences("headers-footers", {
    family: "Helvetica" as "Helvetica" | "Times" | "Courier",
    size: 8.5,
    color: "#5c6a61",
    margin: 14,
    rule: true,
    skipFirst: false,
  });
  const [header, setHeader] = useState<SlotTexts>({ left: "{title}", center: "", right: "{date}" });
  const [footer, setFooter] = useState<SlotTexts>({ left: "", center: "Page {page} of {total}", right: "" });
  const [activeSlot, setActiveSlot] = useState<SlotKey>("footer-center");
  const [range, setRange] = useState("");
  const [error, setError] = useState("");
  const { job, result, run, clear } = useRunner<{ bytes: Uint8Array; name: string; pages: number; skipped: number }>();

  useEffect(() => {
    clear();
    setError("");
  }, [pdf.bytes, clear]);

  const templates = [
    {
      name: "Report",
      header: { left: "{title}", center: "", right: "{date}" },
      footer: { left: "Confidential", center: "Page {page} of {total}", right: "" },
    },
    {
      name: "Contract",
      header: { left: "{filename}", center: "", right: "" },
      footer: { left: "", center: "Page {page} / {pages}", right: "{date}" },
    },
    {
      name: "Minimal",
      header: BLANK,
      footer: { left: "", center: "{page}", right: "" },
    },
  ];

  const TOKENS = ["{page}", "{pages}", "{total}", "{date}", "{title}", "{filename}"];

  const setSlot = (slot: "header" | "footer", align: "left" | "center" | "right", value: string) => {
    const next = slot === "header" ? { ...header, [align]: value } : { ...footer, [align]: value };
    if (slot === "header") setHeader(next);
    else setFooter(next);
    clear();
  };

  const insertToken = (token: string) => {
    const [section, align] = activeSlot.split("-") as ["header" | "footer", "left" | "center" | "right"];
    const current = section === "header" ? header[align] : footer[align];
    const spacer = current && !current.endsWith(" ") ? " " : "";
    setSlot(section, align, `${current}${spacer}${token}`);
  };

  const apply = async () => {
    if (!pdf.bytes || !pdf.file) return;
    const file = pdf.file;
    if (![header.left, header.center, header.right, footer.left, footer.center, footer.right].some((value) => value.trim())) {
      setError("Add at least one header or footer line.");
      return;
    }
    const problem = validatePageQuery(range, pdf.pageCount);
    if (problem) {
      setError(problem);
      return;
    }
    setError("");
    void run(async ({ step, throwIfCancelled }) => {
      const pages = uniqueInOrder(parseRanges(range, pdf.pageCount)).filter(
        (page) => !prefs.value.skipFirst || page !== 1,
      );
      if (!pages.length) throw new Error("Every selected page was skipped. Turn off “Skip the first page” or widen the range.");
      const doc = await openPdfLib(pdf.bytes as ArrayBuffer);
      const font = await layoutFont(doc, prefs.value.family);
      const all = doc.getPages();
      const title = doc.getTitle() || baseName(file.name);
      const date = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
      for (let index = 0; index < pages.length; index++) {
        throwIfCancelled();
        const pageNumber = pages[index];
        const page = all[pageNumber - 1];
        if (!page) continue;
        const vars = { page: pageNumber, total: pdf.pageCount, title, filename: file.name, date, bates: "" };
        const mapped = (slots: SlotTexts): SlotTexts => ({
          left: replacePlaceholders(slots.left.replace(/\{pages\}/gi, "{total}"), vars),
          center: replacePlaceholders(slots.center.replace(/\{pages\}/gi, "{total}"), vars),
          right: replacePlaceholders(slots.right.replace(/\{pages\}/gi, "{total}"), vars),
        });
        const base = {
          font,
          size: prefs.value.size,
          color: prefs.value.color,
          marginX: prefs.value.margin * MM,
          marginY: prefs.value.margin * MM,
          rule: prefs.value.rule,
          ruleColor: "#d9d4c6",
        };
        if (header.left || header.center || header.right) drawSlots(page, mapped(header), { ...base, atTop: true });
        if (footer.left || footer.center || footer.right) drawSlots(page, mapped(footer), { ...base, atTop: false });
        step(index + 1, pages.length, "Writing headers and footers…", `${index + 1} of ${pages.length}`);
      }
      const bytes = await doc.save();
      return {
        bytes,
        name: `${sanitizeName(baseName(file.name))}-headers-footers.pdf`,
        pages: pages.length,
        skipped: pdf.pageCount - pages.length,
      };
    });
  };

  usePrimaryShortcut(apply, Boolean(pdf.bytes) && !job.busy);
  useDownloadShortcut(
    () => {
      if (result) downloadOutput(result.bytes, result.name, "application/pdf");
    },
    Boolean(result),
  );

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF for headers & footers" />
      {pdf.bytes && (
        <>
          <div className="flex flex-wrap gap-1.5">
            <span className="mr-1 self-center text-[10.5px] font-semibold uppercase tracking-[0.09em] text-ink/75">Presets</span>
            {templates.map((template) => (
              <button
                key={template.name}
                type="button"
                onClick={() => {
                  setHeader(template.header);
                  setFooter(template.footer);
                  clear();
                }}
                className="rounded-full border border-line bg-paper px-3 py-1.5 text-[11.5px] font-medium text-ink/75 hover:border-forest/35 hover:text-forest"
              >
                {template.name}
              </button>
            ))}
          </div>

          {(["header", "footer"] as const).map((slot) => {
            const value = slot === "header" ? header : footer;
            return (
              <div key={slot} className="rounded-xl border border-line bg-paper p-3.5">
                <p className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">
                  <span>{slot}</span>
                  <span className="normal-case tracking-normal text-ink/70">left · center · right</span>
                </p>
                <div className="grid gap-2 sm:grid-cols-3">
                  {(["left", "center", "right"] as const).map((align) => (
                    <input
                      key={align}
                      value={value[align]}
                      onChange={(event) => setSlot(slot, align, event.target.value)}
                      onFocus={() => setActiveSlot(`${slot}-${align}` as SlotKey)}
                      placeholder={`${slot} ${align}`}
                      aria-label={`${slot} ${align}`}
                      className={cn(inputClass, activeSlot === `${slot}-${align}` && "border-forest/45 ring-2 ring-forest/10")}
                    />
                  ))}
                </div>
              </div>
            );
          })}

          <div className="rounded-xl border border-forest/12 bg-lime/15 p-2.5">
            <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-forest">
              <span className="font-semibold">Insert into {activeSlot.replace("-", " ")}:</span>
              {TOKENS.map((token) => (
                <button
                  key={token}
                  type="button"
                  onClick={() => insertToken(token)}
                  aria-label={`Insert ${token}`}
                  title={
                    token === "{page}"
                      ? "This page number"
                      : token === "{pages}" || token === "{total}"
                        ? "Total page count"
                        : token === "{date}"
                          ? "Today’s date"
                          : token === "{title}"
                            ? "The PDF’s title"
                            : "The source file name"
                  }
                  className="rounded border border-forest/20 bg-paper px-1.5 py-0.5 font-mono text-[10.5px] text-forest hover:bg-lime/40"
                >
                  {token}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[10.5px] leading-snug text-forest/90">
              Click a field above to choose where the next token goes. Text is written for real, so it prints and copies.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <RangeField
                value={range}
                onChange={(value) => {
                  setRange(value);
                  clear();
                  setError("");
                }}
                total={pdf.pageCount}
                label="Pages"
                hint="Leave empty for every page."
              />
            </div>
            <Switch
              checked={prefs.value.skipFirst}
              onChange={(value) => {
                prefs.set("skipFirst", value);
                clear();
              }}
              label="Different first page"
              description="Leaves page 1 clean — useful for covers and title sheets."
            />
          </div>

          <AdvancedOptions scope="headers-footers" badge="5 controls" description="Typography and position" onReset={prefs.reset}>
            <OptionsGrid>
              <Field label="Typeface">
                <Select
                  value={prefs.value.family}
                  onChange={(event) => {
                    prefs.set("family", event.target.value as "Helvetica" | "Times" | "Courier");
                    clear();
                  }}
                >
                  <option value="Helvetica">Sans (Helvetica)</option>
                  <option value="Times">Serif (Times)</option>
                  <option value="Courier">Mono (Courier)</option>
                </Select>
              </Field>
              <NumberField
                label="Font size"
                value={prefs.value.size}
                onChange={(value) => {
                  prefs.set("size", value);
                  clear();
                }}
                min={6}
                max={18}
                step={0.5}
                suffix="pt"
              />
              <Field label="Text colour">
                <ColorInput
                  value={prefs.value.color}
                  onChange={(value) => {
                    prefs.set("color", value);
                    clear();
                  }}
                  label="Header and footer text colour"
                />
              </Field>
              <NumberField
                label="Edge margin"
                value={prefs.value.margin}
                onChange={(value) => {
                  prefs.set("margin", value);
                  clear();
                }}
                min={6}
                max={35}
                suffix="mm"
              />
              <Switch
                checked={prefs.value.rule}
                onChange={(value) => {
                  prefs.set("rule", value);
                  clear();
                }}
                label="Subtle separator line"
                description="A hairline between the text and the page content."
              />
            </OptionsGrid>
          </AdvancedOptions>

          {error && <Alert tone="error">{error}</Alert>}
          <JobError job={job} />
          <CancelledNote job={job} />

          <div className="border-t border-line pt-4">
            <Button onClick={apply} loading={job.busy}>
              <Rows3 className="h-4 w-4" /> Add headers & footers
            </Button>
            {job.busy && (
              <Button variant="ghost" onClick={job.cancel} className="ml-2.5">
                Cancel
              </Button>
            )}
            <span className="ml-2.5 text-[11px] text-muted">Original text stays selectable</span>
          </div>
          {job.busy && <JobProgress job={job} />}
        </>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Headers and footers added"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          originalSize={pdf.file?.size}
          mime="application/pdf"
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${result.pages} page${result.pages === 1 ? "" : "s"} stamped${
            result.skipped ? ` · ${result.skipped} left untouched` : ""
          } · written as real text, not an image`}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * BATES NUMBERING
 * ================================================================== */
const BATES_POSITIONS = [
  { value: "bottom-right", label: "Bottom right" },
  { value: "bottom-center", label: "Bottom center" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "top-right", label: "Top right" },
  { value: "top-center", label: "Top center" },
  { value: "top-left", label: "Top left" },
] as const;

const BATES_PREFIXES = ["ABC-", "DEF-", "PLTF-", "DEFT-", "EX-", ""];

export function BatesTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const prefs = useToolPreferences("bates", {
    prefix: "ABC-",
    suffix: "",
    start: 1,
    digits: 6,
    increment: 1,
    position: "bottom-right" as (typeof BATES_POSITIONS)[number]["value"],
    size: 9,
    color: "#26312b",
    margin: 14,
    stamp: "CONFIDENTIAL",
    restartPerFile: false,
  });
  const [extraFiles, setExtraFiles] = useState<File[]>([]);
  const [range, setRange] = useState("");
  const [error, setError] = useState("");
  const { job, result, run, clear } = useRunner<{
    kind: "pdf" | "zip";
    bytes: Uint8Array;
    name: string;
    pages: number;
    first: string;
    last: string;
    files: number;
  }>();

  useEffect(() => {
    clear();
    setError("");
    setExtraFiles([]);
  }, [pdf.bytes, clear]);

  const label = (index: number) => {
    const value = prefs.value.start + index * prefs.value.increment;
    return `${prefs.value.prefix}${String(value).padStart(prefs.value.digits, "0")}${prefs.value.suffix}`;
  };
  const sample = label(0);

  const addFiles = async (candidates: File[]) => {
    const accepted: File[] = [];
    const problems: string[] = [];
    for (const candidate of candidates) {
      try {
        await validateUpload(candidate, "application/pdf,.pdf");
        accepted.push(candidate);
      } catch (err) {
        problems.push(friendlyProcessingError(err, `${candidate.name} couldn’t be added.`));
      }
    }
    setError(problems.join(" "));
    if (accepted.length) {
      setExtraFiles((current) => [...current, ...accepted]);
      clear();
    }
  };

  const apply = async () => {
    if (!pdf.bytes || !pdf.file) return;
    const file = pdf.file;
    const files = [file, ...extraFiles];
    setError("");
    void run(async ({ step, throwIfCancelled }) => {
      const built: { name: string; bytes: Uint8Array }[] = [];
      let counter = prefs.value.start;
      let stamped = 0;
      let firstLabel = "";
      let lastLabel = "";
      for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
        throwIfCancelled();
        if (prefs.value.restartPerFile) counter = prefs.value.start;
        const bytes = fileIndex === 0 ? (pdf.bytes as ArrayBuffer) : await files[fileIndex].arrayBuffer();
        const doc = await openPdfLib(bytes);
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const bold = await doc.embedFont(StandardFonts.HelveticaBold);
        const all = doc.getPages();
        const pages = uniqueInOrder(parseRanges(range, doc.getPageCount()));
        for (let index = 0; index < pages.length; index++) {
          throwIfCancelled();
          const page = all[pages[index] - 1];
          const value = counter;
          const text = `${prefs.value.prefix}${String(value).padStart(prefs.value.digits, "0")}${prefs.value.suffix}`;
          if (!firstLabel) firstLabel = text;
          lastLabel = text;
          const textWidth = font.widthOfTextAtSize(text, prefs.value.size);
          const { width, height } = page.getSize();
          const marginPt = prefs.value.margin * MM;
          let x = width - marginPt - textWidth;
          if (prefs.value.position.endsWith("left")) x = marginPt;
          if (prefs.value.position.endsWith("center")) x = (width - textWidth) / 2;
          const y = prefs.value.position.startsWith("top") ? height - marginPt - prefs.value.size : marginPt;
          page.drawText(text, { x, y, size: prefs.value.size, font, color: hexToRgb(prefs.value.color) });
          if (prefs.value.stamp.trim()) {
            const stampSize = Math.max(5, prefs.value.size * 0.68);
            const stampWidth = bold.widthOfTextAtSize(prefs.value.stamp, stampSize);
            const stampX = prefs.value.position.endsWith("left")
              ? marginPt
              : prefs.value.position.endsWith("center")
                ? (width - stampWidth) / 2
                : width - marginPt - stampWidth;
            const stampY = prefs.value.position.startsWith("top") ? y - prefs.value.size - 6 : y + prefs.value.size + 5;
            if (stampY > 4 && stampY < height - 6) {
              page.drawText(safePdfText(prefs.value.stamp), {
                x: stampX,
                y: stampY,
                size: stampSize,
                font: bold,
                color: hexToRgb("#a64127"),
                opacity: 0.85,
              });
            }
          }
          counter += prefs.value.increment;
          stamped += 1;
        }
        const stampName = `${sanitizeName(baseName(files[fileIndex].name))}-bates.pdf`;
        built.push({ name: built.some((entry) => entry.name === stampName) ? `${sanitizeName(baseName(files[fileIndex].name))}-bates-${fileIndex + 1}.pdf` : stampName, bytes: await doc.save() });
        step(fileIndex + 1, files.length, files.length > 1 ? `Stamping ${files[fileIndex].name}…` : "Stamping pages…", `${fileIndex + 1} of ${files.length} files`);
      }
      if (built.length === 1) {
        return {
          kind: "pdf" as const,
          bytes: built[0].bytes,
          name: built[0].name,
          pages: stamped,
          first: firstLabel,
          last: lastLabel,
          files: 1,
        };
      }
      const zip = new JSZip();
      built.forEach((entry) => zip.file(entry.name, entry.bytes));
      const zipBytes = await zip.generateAsync({ type: "uint8array" });
      return {
        kind: "zip" as const,
        bytes: zipBytes,
        name: `${sanitizeName(baseName(file.name))}-bates.zip`,
        pages: stamped,
        first: firstLabel,
        last: lastLabel,
        files: built.length,
      };
    });
  };

  usePrimaryShortcut(apply, Boolean(pdf.bytes) && !job.busy);
  useDownloadShortcut(
    () => {
      if (result) downloadOutput(result.bytes, result.name, result.kind === "zip" ? "application/zip" : "application/pdf");
    },
    Boolean(result),
  );

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to Bates-number" />
      {pdf.bytes && (
        <>
          <div className="space-y-2 rounded-xl border border-line bg-paper p-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink/60">Prefix</span>
              {BATES_PREFIXES.map((prefix) => (
                <button
                  key={prefix || "none"}
                  type="button"
                  aria-pressed={prefs.value.prefix === prefix}
                  onClick={() => {
                    prefs.set("prefix", prefix);
                    clear();
                  }}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors",
                    prefs.value.prefix === prefix
                      ? "border-forest bg-forest text-paper"
                      : "border-line bg-paper text-ink/70 hover:border-forest/35 hover:text-forest",
                  )}
                >
                  {prefix || "None"}
                </button>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Prefix" hint="Free text, up to 16 characters">
                <input
                  value={prefs.value.prefix}
                  onChange={(event) => {
                    prefs.set("prefix", event.target.value);
                    clear();
                  }}
                  className={inputClass}
                  maxLength={16}
                  placeholder="ABC-"
                />
              </Field>
              <Field label="Suffix">
                <input
                  value={prefs.value.suffix}
                  onChange={(event) => {
                    prefs.set("suffix", event.target.value);
                    clear();
                  }}
                  className={inputClass}
                  maxLength={16}
                  placeholder=""
                />
              </Field>
              <Field label="First number">
                <input
                  type="number"
                  min={0}
                  max={99999999}
                  value={prefs.value.start}
                  onChange={(event) => {
                    prefs.set("start", Math.max(0, Number(event.target.value) || 0));
                    clear();
                  }}
                  className={cn(inputClass, "tabular-nums")}
                />
              </Field>
              <Field label="Digits" hint={`${prefs.value.digits} digits, zero-padded`}>
                <Select
                  value={prefs.value.digits}
                  onChange={(event) => {
                    prefs.set("digits", Number(event.target.value));
                    clear();
                  }}
                >
                  {[3, 4, 5, 6, 7, 8, 9].map((digits) => (
                    <option key={digits} value={digits}>
                      {digits} digits
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Position">
              <Select
                value={prefs.value.position}
                onChange={(event) => {
                  prefs.set("position", event.target.value as (typeof BATES_POSITIONS)[number]["value"]);
                  clear();
                }}
              >
                {BATES_POSITIONS.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Secondary stamp (optional)" hint="Printed just above the number, in clay.">
              <input
                value={prefs.value.stamp}
                onChange={(event) => {
                  prefs.set("stamp", event.target.value);
                  clear();
                }}
                className={inputClass}
                placeholder="CONFIDENTIAL"
                maxLength={40}
              />
            </Field>
          </div>

          <RangeField
            value={range}
            onChange={(value) => {
              setRange(value);
              clear();
              setError("");
            }}
            total={pdf.pageCount}
            label="Pages to stamp"
            hint={
              extraFiles.length
                ? "The range applies to each file. Numbering continues across files unless you restart it."
                : "Numbering follows the order of selected pages."
            }
          />

          <div className="space-y-2 rounded-xl border border-line bg-paper p-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink/60">Additional files (optional)</p>
            <p className="text-[11.5px] leading-relaxed text-muted">
              Stamping a production? Add the rest of the files and the numbering continues through them — or restart per
              file with the advanced option.
            </p>
            {extraFiles.length > 0 && (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {extraFiles.map((file, index) => (
                  <li key={`${file.name}-${index}`} className="flex items-center justify-between gap-2 px-3 py-1.5">
                    <span className="min-w-0 truncate text-[12px]">{file.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      onClick={() => {
                        setExtraFiles(extraFiles.filter((_, position) => position !== index));
                        clear();
                      }}
                      className="text-[11px] text-clay-ink underline"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-paper px-3 py-2 text-[12px] font-medium text-ink/75 hover:border-forest/30">
              Add more PDFs
              <input
                type="file"
                accept="application/pdf,.pdf"
                multiple
                className="sr-only"
                onChange={async (event) => {
                  const picked = Array.from(event.target.files ?? []);
                  event.target.value = "";
                  await addFiles(picked);
                }}
              />
            </label>
          </div>

          <div className="flex items-center gap-3 rounded-xl border border-line bg-bone-deep/35 px-3.5 py-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-forest text-lime">
              <Stamp className="h-4 w-4" />
            </div>
            <div>
              <p className="text-[12.5px] font-semibold">{sample}</p>
              <p className="text-[10.5px] text-muted">
                Next number · increments by {prefs.value.increment} through selected pages
                {extraFiles.length ? ` · ${extraFiles.length + 1} files` : ""}
              </p>
            </div>
          </div>

          <AdvancedOptions scope="bates" badge="5 controls" description="Increment, restart and appearance" onReset={prefs.reset}>
            <OptionsGrid>
              <NumberField
                label="Increment"
                value={prefs.value.increment}
                onChange={(value) => {
                  prefs.set("increment", value);
                  clear();
                }}
                min={1}
                max={1000}
                suffix="per page"
              />
              <NumberField
                label="Font size"
                value={prefs.value.size}
                onChange={(value) => {
                  prefs.set("size", value);
                  clear();
                }}
                min={6}
                max={20}
                suffix="pt"
              />
              <NumberField
                label="Edge margin"
                value={prefs.value.margin}
                onChange={(value) => {
                  prefs.set("margin", value);
                  clear();
                }}
                min={6}
                max={40}
                suffix="mm"
              />
              <Field label="Number colour">
                <ColorInput
                  value={prefs.value.color}
                  onChange={(value) => {
                    prefs.set("color", value);
                    clear();
                  }}
                  label="Bates number colour"
                />
              </Field>
              <Switch
                checked={prefs.value.restartPerFile}
                onChange={(value) => {
                  prefs.set("restartPerFile", value);
                  clear();
                }}
                label="Restart numbering for each file"
                description="Off: one continuous sequence across every file added here."
              />
            </OptionsGrid>
            <OptionNote>
              The stamp is drawn on top of the page content. Nothing is re-rendered, so existing text stays searchable.
            </OptionNote>
          </AdvancedOptions>

          {error && <Alert tone="error">{error}</Alert>}
          <JobError job={job} />
          <CancelledNote job={job} />

          <div className="border-t border-line pt-4">
            <Button onClick={apply} loading={job.busy}>
              <ListOrdered className="h-4 w-4" /> Apply Bates numbering
            </Button>
            {job.busy && (
              <Button variant="ghost" onClick={job.cancel} className="ml-2.5">
                Cancel
              </Button>
            )}
          </div>
          {job.busy && <JobProgress job={job} />}
        </>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Bates numbering applied"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          originalSize={pdf.file?.size}
          mime={result.kind === "zip" ? "application/zip" : "application/pdf"}
          onDownload={() => downloadBytes(result.bytes, result.name, result.kind === "zip" ? "application/zip" : "application/pdf")}
          description={`${result.first} → ${result.last} · ${result.pages} page${result.pages === 1 ? "" : "s"} stamped${
            result.files > 1 ? ` across ${result.files} files` : ""
          }`}
          facts={[
            { label: "Sequence", value: `${result.first} … ${result.last}` },
            ...(result.files > 1 ? [{ label: "Files", value: String(result.files) }] : []),
          ]}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * FLATTEN PDF
 * ================================================================== */
type FlattenMode = "forms" | "annotations" | "both";

/** Interactive types that stay live unless the caller asks to flatten them. */
const KEEP_INTERACTIVE = new Set(["Link", "Popup"]);
/** Form widgets belong to the AcroForm — flattening them is form flattening. */
const NEVER_BAKE = new Set(["Widget"]);

function countAnnotations(doc: PDFDocument, page: PDFPage): number {
  const annots = page.node.Annots();
  if (!annots) return 0;
  let count = 0;
  for (let index = 0; index < annots.size(); index++) {
    const entry = annots.get(index);
    if (!(entry instanceof PDFRef)) continue;
    const dict = doc.context.lookup(entry);
    if (!(dict instanceof PDFDict)) continue;
    const subtype = dict.get(PDFName.of("Subtype"));
    const kind = subtype instanceof PDFName ? subtype.decodeText() : "";
    if (KEEP_INTERACTIVE.has(kind) || NEVER_BAKE.has(kind)) continue;
    count += 1;
  }
  return count;
}

interface BakeResult {
  baked: number;
  skipped: number;
}

/**
 * Paint every flattable annotation's normal appearance into the page content
 * stream, then drop the annotation. Vectors and text survive; nothing is
 * rasterized. Links and popups are left interactive on purpose.
 */
function bakeAnnotations(doc: PDFDocument, selected: Set<number>, flattenLinks: boolean): BakeResult {
  const result: BakeResult = { baked: 0, skipped: 0 };
  const pages = doc.getPages();
  selected.forEach((pageNumber) => {
    const page = pages[pageNumber - 1];
    if (!page) return;
    const annots = page.node.Annots();
    if (!annots) return;
    const refs: PDFRef[] = [];
    for (let index = 0; index < annots.size(); index++) {
      const entry = annots.get(index);
      if (entry instanceof PDFRef) refs.push(entry);
    }
    for (const ref of refs) {
      try {
        const raw = doc.context.lookup(ref);
        if (!(raw instanceof PDFDict)) {
          result.skipped += 1;
          continue;
        }
        const subtype = raw.get(PDFName.of("Subtype"));
        const kind = subtype instanceof PDFName ? subtype.decodeText() : "";
        if (NEVER_BAKE.has(kind)) continue;
        if (KEEP_INTERACTIVE.has(kind) && !flattenLinks) continue;
        const annot = PDFAnnotation.fromDict(raw);
        const rect = annot.getRectangle();
        if (rect.width <= 0.5 || rect.height <= 0.5) {
          result.skipped += 1;
          continue;
        }
        const ap = annot.AP();
        if (!ap) {
          result.skipped += 1;
          continue;
        }
        let node = ap.get(PDFName.of("N"));
        let resolved = node instanceof PDFRef ? doc.context.lookup(node) : node;
        // A state dictionary (checkboxes, radio buttons) maps state names to appearances.
        if (resolved instanceof PDFDict && !resolved.get(PDFName.of("BBox"))) {
          const state = annot.getAppearanceState();
          const stateKey = state ?? PDFName.of("On");
          const inner = resolved.get(stateKey) ?? resolved.get(PDFName.of("On"));
          if (!inner) {
            result.skipped += 1;
            continue;
          }
          resolved = inner instanceof PDFRef ? doc.context.lookup(inner) : inner;
          node = inner;
        }
        if (!(resolved instanceof PDFStream)) {
          result.skipped += 1;
          continue;
        }
        const bbox = resolved.dict.lookupMaybe(PDFName.of("BBox"), PDFArray);
        if (!bbox || bbox.size() !== 4) {
          result.skipped += 1;
          continue;
        }
        const corner = (index: number) => {
          const value = bbox.get(index);
          return value instanceof PDFNumber ? value.asNumber() : 0;
        };
        const boxW = corner(2) - corner(0);
        const boxH = corner(3) - corner(1);
        if (boxW <= 0 || boxH <= 0) {
          result.skipped += 1;
          continue;
        }
        let appearanceRef: PDFRef;
        if (resolved instanceof PDFRef) {
          appearanceRef = resolved;
        } else if (node instanceof PDFRef) {
          appearanceRef = node;
        } else {
          appearanceRef = doc.context.nextRef();
          doc.context.assign(appearanceRef, resolved);
        }
        const sx = rect.width / boxW;
        const sy = rect.height / boxH;
        const name = page.node.newXObject("PaperlyAnnot", appearanceRef);
        page.pushOperators(
          PDFOperator.of(PDFOperatorNames.PushGraphicsState),
          PDFOperator.of(PDFOperatorNames.ConcatTransformationMatrix, [
            PDFNumber.of(sx),
            PDFNumber.of(0),
            PDFNumber.of(0),
            PDFNumber.of(sy),
            PDFNumber.of(rect.x - corner(0) * sx),
            PDFNumber.of(rect.y - corner(1) * sy),
          ]),
          PDFOperator.of(PDFOperatorNames.DrawObject, [name]),
          PDFOperator.of(PDFOperatorNames.PopGraphicsState),
        );
        page.node.removeAnnot(ref);
        result.baked += 1;
      } catch {
        result.skipped += 1;
      }
    }
  });
  return result;
}

export function FlattenTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const prefs = useToolPreferences("flatten", {
    mode: "both" as FlattenMode,
    rasterize: false,
    dpi: 150,
    quality: 88,
    flattenLinks: false,
  });
  const [range, setRange] = useState("");
  const [counts, setCounts] = useState<{ fields: number; annotations: number } | null>(null);
  const [error, setError] = useState("");
  const { job, result, run, clear } = useRunner<{
    bytes: Uint8Array;
    name: string;
    pages: number;
    fields: number;
    annotations: number;
    skipped: number;
    rasterized: number;
    method: string;
  }>();

  useEffect(() => {
    setCounts(null);
    if (!pdf.bytes) return;
    let alive = true;
    (async () => {
      try {
        const doc = await openPdfLib(pdf.bytes as ArrayBuffer);
        let fields = 0;
        try {
          fields = doc.getForm().getFields().length;
        } catch {
          fields = 0;
        }
        let annotations = 0;
        doc.getPages().forEach((page) => {
          annotations += countAnnotations(doc, page);
        });
        if (alive) setCounts({ fields, annotations });
      } catch {
        if (alive) setCounts({ fields: 0, annotations: 0 });
      }
    })();
    return () => {
      alive = false;
    };
  }, [pdf.bytes]);

  useEffect(() => {
    clear();
    setError("");
  }, [pdf.bytes, clear]);

  const apply = async () => {
    if (!pdf.bytes || !pdf.file) return;
    const file = pdf.file;
    setError("");
    const mode = prefs.value.mode;
    void run(async ({ step, throwIfCancelled }) => {
      const pages = uniqueInOrder(parseRanges(range, pdf.pageCount));
      const selected = new Set(pages);
      let fields = 0;
      let annotations = 0;
      let skipped = 0;
      let rasterized = 0;
      let bytes: Uint8Array;
      let pageCount: number;
      if (prefs.value.rasterize) {
        const source = await openPdfJs(pdf.bytes as ArrayBuffer);
        const layout = await openPdfLib(pdf.bytes as ArrayBuffer);
        const layoutPages = layout.getPages();
        const out = await PDFDocument.create();
        for (let pageNumber = 1; pageNumber <= source.numPages; pageNumber++) {
          throwIfCancelled();
          if (!selected.has(pageNumber)) {
            const [copied] = await out.copyPages(layout, [pageNumber - 1]);
            out.addPage(copied);
          } else {
            const rendered = await renderPdfPage(source, pageNumber, {
              scale: prefs.value.dpi / 72,
              type: "image/jpeg",
              quality: prefs.value.quality / 100,
              rotation: 0,
            });
            const view = await source.getPage(pageNumber);
            const viewport = view.getViewport({ scale: 1 });
            const page = out.addPage([viewport.width, viewport.height]);
            const rotation = layoutPages[pageNumber - 1]?.getRotation().angle ?? 0;
            if (rotation) page.setRotation(degrees(rotation));
            const image = await out.embedJpg(dataUrlToBytes(rendered.dataUrl));
            page.drawImage(image, { x: 0, y: 0, width: viewport.width, height: viewport.height });
            rasterized += 1;
          }
          step(pageNumber, source.numPages, "Rasterizing pages…", `${pageNumber} of ${source.numPages}`);
        }
        await source.destroy();
        pageCount = out.getPageCount();
        bytes = await out.save();
      } else {
        const doc = await openPdfLib(pdf.bytes as ArrayBuffer);
        if (mode === "forms" || mode === "both") {
          try {
            fields = doc.getForm().getFields().length;
            doc.getForm().flatten();
          } catch {
            fields = 0;
          }
        }
        if (mode === "annotations" || mode === "both") {
          const baked = bakeAnnotations(doc, selected, prefs.value.flattenLinks);
          annotations = baked.baked;
          skipped = baked.skipped;
        }
        pageCount = doc.getPageCount();
        step(1, 1, "Flattening interactive content…", `${pages.length} pages scanned`);
        bytes = await doc.save();
      }
      const method = prefs.value.rasterize
        ? `Pages rasterized at ${prefs.value.dpi} DPI`
        : [fields ? `${fields} form field${fields === 1 ? "" : "s"}` : "", annotations ? `${annotations} annotation${annotations === 1 ? "" : "s"}` : ""]
            .filter(Boolean)
            .join(" and ") || "Nothing interactive found — the document was already flat";
      return {
        bytes,
        name: `${sanitizeName(baseName(file.name))}-flattened.pdf`,
        pages: pageCount,
        fields,
        annotations,
        skipped,
        rasterized,
        method,
      };
    });
  };

  usePrimaryShortcut(apply, Boolean(pdf.bytes) && !job.busy);
  useDownloadShortcut(
    () => {
      if (result) downloadOutput(result.bytes, result.name, "application/pdf");
    },
    Boolean(result),
  );

  const flatCopy = prefs.value.rasterize
    ? "Rasterized pages are images: text will no longer be selectable or searchable, and forms or annotations on those pages are baked into the image."
    : "Form fields and annotation appearances become page content. Text and vectors stay selectable.";

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to flatten" />
      {pdf.bytes && (
        <>
          <div>
            <StepHeader step={2} title="What should be flattened?" />
            <ModeGrid
              value={prefs.value.mode}
              onChange={(value) => {
                prefs.set("mode", value);
                clear();
              }}
              options={[
                { value: "both", label: "Forms and annotations", hint: "Everything interactive" },
                { value: "forms", label: "Forms only", hint: "Keeps annotations" },
                { value: "annotations", label: "Annotations only", hint: "Keeps form fields editable" },
              ]}
            />
          </div>

          <Switch
            checked={prefs.value.rasterize}
            onChange={(value) => {
              prefs.set("rasterize", value);
              clear();
            }}
            label="Rasterize the selected pages"
            description="Bakes the exact visual appearance into images. Makes the PDF unsearchable."
          />
          {prefs.value.rasterize && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Raster resolution" hint="Higher keeps small text crisp; files get larger.">
                <Select
                  value={prefs.value.dpi}
                  onChange={(event) => {
                    prefs.set("dpi", Number(event.target.value));
                    clear();
                  }}
                >
                  <option value={110}>Standard · 110 DPI</option>
                  <option value={150}>High · 150 DPI</option>
                  <option value={220}>Print · 220 DPI</option>
                  <option value={300}>Maximum · 300 DPI</option>
                </Select>
              </Field>
              <SliderField
                label="JPEG quality"
                value={prefs.value.quality}
                onChange={(value) => {
                  prefs.set("quality", value);
                  clear();
                }}
                min={40}
                max={100}
                format={(value) => `${value}%`}
              />
            </div>
          )}

          <RangeField
            value={range}
            onChange={(value) => {
              setRange(value);
              clear();
              setError("");
            }}
            total={pdf.pageCount}
            label="Pages to flatten"
            hint="Leave empty for the whole document."
          />

          <div className="rounded-xl border border-line bg-bone-deep/35 p-3.5">
            <p className="flex items-center gap-1.5 text-[12px] font-semibold text-forest">
              <FileDown className="h-3.5 w-3.5" /> What this does
            </p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-ink/70">
              {counts === null
                ? "Checking for interactive content…"
                : counts.fields === 0 && counts.annotations === 0
                  ? "No interactive form fields or annotations were found. You can still rasterize the pages to lock the visual appearance."
                  : [
                      counts.fields > 0
                        ? `${counts.fields} interactive form field${counts.fields === 1 ? "" : "s"}`
                        : "",
                      counts.annotations > 0
                        ? `${counts.annotations} annotation${counts.annotations === 1 ? "" : "s"}`
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" and ") + " found. Flattening makes their current appearance permanent."}
            </p>
            <p className={cn("mt-1.5 text-[11px] leading-relaxed", prefs.value.rasterize ? "text-amber-800" : "text-ink/60")}>{flatCopy}</p>
            {range.trim() && !prefs.value.rasterize && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-ink/60">
                Form fields live in one document-wide form, so “forms” flattens them on every page. The range limits
                annotation flattening and rasterization.
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-paper px-3.5 py-2.5 text-[11.5px] text-ink/70">
            <Hash className="h-3.5 w-3.5 text-forest" />
            <span>
              {prefs.value.mode === "forms"
                ? "Forms only"
                : prefs.value.mode === "annotations"
                  ? "Annotations only"
                  : "Forms and annotations"}
              {prefs.value.rasterize ? " · selected pages rasterized" : " · keeps text selectable"}
            </span>
          </div>

          <AdvancedOptions scope="flatten" badge="2 controls" description="Raster detail and link handling" onReset={prefs.reset}>
            <OptionsGrid>
              <Switch
                checked={prefs.value.flattenLinks}
                onChange={(value) => {
                  prefs.set("flattenLinks", value);
                  clear();
                }}
                label="Also flatten links and popups"
                description="Off keeps hyperlinks clickable. On removes them like any other annotation."
              />
              <OptionNote>
                Rasterizing is the only step that loses selectable text, and it is never applied unless you switch it on.
              </OptionNote>
            </OptionsGrid>
          </AdvancedOptions>

          {error && <Alert tone="error">{error}</Alert>}
          <JobError job={job} />
          <CancelledNote job={job} />

          <div className="border-t border-line pt-4">
            <Button onClick={apply} loading={job.busy}>
              <Copy className="h-4 w-4" /> Flatten PDF
            </Button>
            {job.busy && (
              <Button variant="ghost" onClick={job.cancel} className="ml-2.5">
                Cancel
              </Button>
            )}
          </div>
          {job.busy && <JobProgress job={job} />}
        </>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="PDF flattened"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          originalSize={pdf.file?.size}
          mime="application/pdf"
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${result.method} · ${result.pages} pages · ${formatBytes(result.bytes.byteLength)}`}
          facts={[
            ...(result.fields ? [{ label: "Form fields", value: String(result.fields) }] : []),
            ...(result.annotations ? [{ label: "Annotations", value: String(result.annotations) }] : []),
            ...(result.skipped ? [{ label: "Skipped", value: String(result.skipped) }] : []),
          ]}
        />
      )}
    </div>
  );
}
