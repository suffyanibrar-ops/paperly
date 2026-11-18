import { Gauge, Hash, Wrench } from "lucide-react";
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, type PDFRef } from "@cantoo/pdf-lib";
import { useEffect, useState, type CSSProperties } from "react";
import {
  PDFDocument,
  StandardFonts,
  baseName,
  dataUrlToBytes,
  formatBytes,
  hexToRgb,
  openPdfJs,
  openPdfLib,
  readFileBytes,
  renderPdfPage,
  sanitizeName,
} from "@/lib/pdf";
import { useInitialFiles, usePdfFile, usePdfThumbs } from "@/lib/usePdf";
import {
  Alert,
  Button,
  ColorInput,
  Field,
  FileDrop,
  FileRow,
  Progress,
  Segmented,
  Switch,
  TextInput,
} from "@/components/ui";
import { DownloadPanel, RangeField, SinglePdfInput } from "@/components/toolParts";
import {
  AdvancedOptions,
  NumberField,
  OptionNote,
  OptionsGrid,
  PresetChips,
  SliderField,
} from "@/components/AdvancedOptions";
import { describeJobTime, JobCancelledError, useJob, type JobReporter } from "@/lib/job";
import { useToolPreferences } from "@/lib/prefs";
import { useDownloadShortcut, usePrimaryShortcut } from "@/lib/hotkeys";
import { describePageQuery, parsePageQuery } from "@/lib/pageQuery";
import { downloadOutput } from "@/lib/output";
import { SAMPLE } from "@/lib/sample";
import { cn } from "@/utils/cn";

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Monotonic progress reporter: a later stage can never move the bar back. */
function createAdvance(reporter: JobReporter) {
  let mark = 0;
  return (percent: number, label?: string, detail?: string) => {
    mark = Math.min(99, Math.max(mark, percent));
    reporter.report(mark, label, detail);
  };
}

/** Remove the document information dictionary and the XMP metadata packet. */
function stripDocumentMetadata(doc: PDFDocument) {
  delete doc.context.trailerInfo.Info;
  delete doc.context.trailerInfo.ID;
  doc.catalog.delete(PDFName.of("Metadata"));
  doc.catalog.delete(PDFName.of("PieceInfo"));
}

async function encodeJpegBytes(
  source: Blob,
  opts: { maxDimension: number; quality: number; grayscale?: boolean },
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const bitmap = await createImageBitmap(source);
  try {
    const longest = Math.max(1, bitmap.width, bitmap.height);
    const ratio = Math.min(1, opts.maxDimension / longest);
    const width = Math.max(1, Math.round(bitmap.width * ratio));
    const height = Math.max(1, Math.round(bitmap.height * ratio));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Your browser can’t re-encode images (canvas unavailable).");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    if (opts.grayscale) {
      const frame = context.getImageData(0, 0, width, height);
      const pixels = frame.data;
      for (let i = 0; i < pixels.length; i += 4) {
        // Rec. 601 luma: the same weighting every image editor uses.
        const grey = Math.round(0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]);
        pixels[i] = grey;
        pixels[i + 1] = grey;
        pixels[i + 2] = grey;
      }
      context.putImageData(frame, 0, 0);
    }
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", opts.quality));
    canvas.width = 1;
    canvas.height = 1;
    if (!blob) throw new Error("An embedded image couldn’t be re-encoded.");
    return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
  } finally {
    bitmap.close?.();
  }
}

/* ================================================================== *
 * COMPRESS
 * ================================================================== */
type CompressPreset = "screen" | "balanced" | "print" | "archive";

interface CompressPresetConfig {
  label: string;
  description: string;
  dpi: number;
  quality: number;
  /** Archive re-saves the structure without touching a single photo. */
  lossless?: boolean;
}

const COMPRESS_PRESETS: Record<CompressPreset, CompressPresetConfig> = {
  screen: { label: "Screen", description: "Smallest file · 96 DPI · photos softened for email and the web", dpi: 96, quality: 55 },
  balanced: { label: "Balanced", description: "Everyday sharing · 150 DPI · the default size/quality trade-off", dpi: 150, quality: 70 },
  print: { label: "Print", description: "Best quality · 300 DPI · keeps fine photo detail on paper", dpi: 300, quality: 85 },
  archive: { label: "Archive", description: "Lossless rebuild · no photo is re-encoded, structure only", dpi: 300, quality: 100, lossless: true },
};

const PRESET_ORDER: CompressPreset[] = ["screen", "balanced", "print", "archive"];

/** Photos are capped at the pixel width a page of this print resolution needs. */
function maxDimensionForDpi(dpi: number): number {
  return Math.max(320, Math.round(clampNumber(dpi, 72, 600) * 8.27));
}

type CompressPreferences = {
  preset: CompressPreset;
  dpi: number;
  quality: number;
  grayscale: boolean;
  stripMetadata: boolean;
  removeAnnotations: boolean;
  keepText: boolean;
};

interface CompressVariant {
  id: string;
  label: string;
  note: string;
  bytes: Uint8Array;
}

interface CompressAttempt {
  label: string;
  bytes: number;
}

interface CompressOutcome {
  variants: CompressVariant[];
  attempts: CompressAttempt[];
  originalSize: number;
  pages: number;
  preset: CompressPreset;
  dpi: number;
  quality: number;
  photos: number;
  grayscale: boolean;
  stripMetadata: boolean;
  removeAnnotations: boolean;
  keepText: boolean;
  targetBytes?: number;
  targetMet?: boolean;
}

export async function recompressImages(
  bytes: ArrayBuffer,
  opts: {
    quality: number;
    maxDimension: number;
    grayscale?: boolean;
    stripMetadata?: boolean;
    removeAnnotations?: boolean;
    /** Archive mode: rebuild the file structure and leave image data alone. */
    keepImages?: boolean;
    throwIfCancelled?: () => void;
  },
  onProgress: (value: number, detail?: string) => void,
): Promise<{ bytes: Uint8Array; changed: number }> {
  const doc = await openPdfLib(bytes);
  const context = doc.context;
  const seen = new Map<string, boolean>();
  let changed = 0;
  const pages = doc.getPages();
  if (opts.removeAnnotations) {
    for (const page of pages) page.node.delete(PDFName.of("Annots"));
  }
  if (opts.stripMetadata) stripDocumentMetadata(doc);
  opts.throwIfCancelled?.();
  if (opts.keepImages) {
    onProgress(60, "Rebuilding the file structure…");
  } else {
    for (let p = 0; p < pages.length; p++) {
      opts.throwIfCancelled?.();
      const resources = pages[p].node.Resources();
      const xObjects = resources?.lookup(PDFName.of("XObject"));
      if (xObjects instanceof PDFDict) {
        for (const [, ref] of xObjects.entries()) {
          const key = ref.toString();
          if (seen.has(key)) continue;
          seen.set(key, true);
          opts.throwIfCancelled?.();
          try {
            const stream = context.lookup(ref as PDFRef);
            if (!(stream instanceof PDFRawStream)) continue;
            const dict = stream.dict;
            const subtype = dict.lookup(PDFName.of("Subtype"));
            if (!(subtype instanceof PDFName) || subtype.asString() !== "/Image") continue;
            const filter = dict.lookup(PDFName.of("Filter"));
            if (!(filter instanceof PDFName) || filter.asString() !== "/DCTDecode") continue;
            if (dict.has(PDFName.of("SMask")) || dict.has(PDFName.of("Mask")) || dict.has(PDFName.of("ImageMask"))) continue;
            const colorSpace = dict.lookup(PDFName.of("ColorSpace"));
            if (!(colorSpace instanceof PDFName) || !["/DeviceRGB", "/DeviceGray"].includes(colorSpace.asString())) continue;
            const width = dict.lookup(PDFName.of("Width"), PDFNumber)?.asNumber();
            const height = dict.lookup(PDFName.of("Height"), PDFNumber)?.asNumber();
            if (!width || !height || width * height < 40_000) continue;
            const original = stream.getContents();
            const jpeg = await encodeJpegBytes(
              new Blob([original as unknown as BlobPart], { type: "image/jpeg" }),
              { maxDimension: opts.maxDimension, quality: opts.quality, grayscale: opts.grayscale },
            );
            if (jpeg.bytes.byteLength >= original.byteLength * 0.94) continue;
            const newDict = PDFDict.withContext(context);
            for (const [k, v] of dict.entries()) newDict.set(k, v);
            newDict.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
            newDict.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB"));
            newDict.set(PDFName.of("Width"), PDFNumber.of(jpeg.width));
            newDict.set(PDFName.of("Height"), PDFNumber.of(jpeg.height));
            newDict.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
            newDict.set(PDFName.of("Length"), PDFNumber.of(jpeg.bytes.byteLength));
            newDict.delete(PDFName.of("DecodeParms"));
            context.assign(ref as PDFRef, PDFRawStream.of(newDict, jpeg.bytes));
            changed++;
          } catch {
            /* leave unusual images untouched */
          }
        }
      }
      onProgress(
        Math.round(((p + 1) / Math.max(1, pages.length)) * 100),
        `Page ${p + 1} of ${pages.length} · ${changed} photo${changed === 1 ? "" : "s"} re-encoded`,
      );
    }
  }
  opts.throwIfCancelled?.();
  const saved = await doc.save({ useObjectStreams: true });
  onProgress(100, "Writing the compressed file…");
  return { bytes: saved, changed };
}

export async function flattenPdf(
  bytes: ArrayBuffer,
  opts: { targetWidth: number; quality: number; grayscale?: boolean; throwIfCancelled?: () => void },
  onProgress: (value: number, detail?: string) => void,
): Promise<Uint8Array> {
  const source = await openPdfJs(bytes);
  const out = await PDFDocument.create();
  try {
    for (let i = 1; i <= source.numPages; i++) {
      opts.throwIfCancelled?.();
      const rendered = await renderPdfPage(source, i, {
        targetWidth: opts.targetWidth,
        type: "image/jpeg",
        quality: opts.quality,
      });
      let jpeg = dataUrlToBytes(rendered.dataUrl);
      if (opts.grayscale) {
        const grey = await encodeJpegBytes(new Blob([jpeg as unknown as BlobPart], { type: "image/jpeg" }), {
          maxDimension: 20_000,
          quality: opts.quality,
          grayscale: true,
        });
        jpeg = grey.bytes;
      }
      const page = await source.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const pdfPage = out.addPage([viewport.width, viewport.height]);
      const image = await out.embedJpg(jpeg);
      pdfPage.drawImage(image, { x: 0, y: 0, width: viewport.width, height: viewport.height });
      onProgress(Math.round((i / Math.max(1, source.numPages)) * 100), `Page ${i} of ${source.numPages} rendered`);
    }
  } finally {
    await source.destroy();
  }
  return out.save({ useObjectStreams: true });
}

function compressSettingsLabel(outcome: CompressOutcome): string {
  if (COMPRESS_PRESETS[outcome.preset].lossless) return "Archive · lossless rebuild";
  return `${COMPRESS_PRESETS[outcome.preset].label} · ${outcome.dpi} DPI · JPEG ${outcome.quality}%`;
}

export function CompressTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const opts = useToolPreferences("compress", {
    preset: "balanced" as CompressPreset,
    dpi: 150,
    quality: 70,
    grayscale: false,
    stripMetadata: true,
    removeAnnotations: false,
    keepText: true,
  });
  const [targetMB, setTargetMB] = useState("");
  const [choiceId, setChoiceId] = useState("");
  const job = useJob<CompressOutcome>();

  const lossless = COMPRESS_PRESETS[opts.value.preset].lossless === true;
  const busy = job.busy;

  const change = (next: Partial<CompressPreferences>) => {
    opts.patch(next);
    if (!job.busy) job.reset();
  };

  // A new document means the previous report no longer applies.
  const { reset: resetJob } = job;
  const sourceFile = pdf.file;
  useEffect(() => {
    resetJob();
    setChoiceId("");
    setTargetMB("");
  }, [sourceFile, resetJob]);

  const run = () => {
    const source = pdf.bytes;
    const file = pdf.file;
    if (!source || !file || job.busy) return;
    const value = opts.value;
    const config = COMPRESS_PRESETS[value.preset];
    const dpi = config.lossless ? config.dpi : clampNumber(value.dpi, 72, 600);
    const quality = clampNumber(value.quality, 30, 100) / 100;
    const maxDimension = maxDimensionForDpi(dpi);
    const requestedMB = Number(targetMB);
    const targetBytes =
      !config.lossless && targetMB.trim() && Number.isFinite(requestedMB) && requestedMB > 0
        ? Math.round(requestedMB * 1024 * 1024)
        : undefined;
    const pageCount = pdf.pageCount;

    void job.run(async (reporter) => {
      const advance = createAdvance(reporter);
      const shared = {
        grayscale: value.grayscale,
        stripMetadata: value.stripMetadata,
        removeAnnotations: value.removeAnnotations,
        throwIfCancelled: () => reporter.throwIfCancelled(),
      };
      advance(2, config.lossless ? "Rebuilding the file structure…" : "Analysing embedded images…");
      const main = await recompressImages(
        source,
        { quality, maxDimension, keepImages: config.lossless, ...shared },
        (percent, detail) => {
          advance(
            2 + (percent / 100) * 46,
            config.lossless ? "Rebuilding the file structure…" : "Re-encoding photos, keeping text sharp…",
            detail,
          );
        },
      );
      const candidates: CompressVariant[] = [
        {
          id: "sharp",
          label: "Keep text sharp",
          note: config.lossless
            ? `No photo re-encoded · ${formatBytes(main.bytes.byteLength)}`
            : `${main.changed} photo${main.changed === 1 ? "" : "s"} re-encoded · ${formatBytes(main.bytes.byteLength)}`,
          bytes: main.bytes,
        },
      ];
      const attempts: CompressAttempt[] = [
        { label: config.lossless ? "Lossless rebuild" : `${dpi} DPI · JPEG ${Math.round(quality * 100)}%`, bytes: main.bytes.byteLength },
      ];
      const savings = 1 - main.bytes.byteLength / Math.max(1, file.size);
      const shouldFlatten = !config.lossless && (!value.keepText || (savings < 0.12 && pageCount <= 60));

      if (shouldFlatten) {
        advance(50, "Flattening pages for extra savings…");
        try {
          const flattened = await flattenPdf(
            source,
            { targetWidth: maxDimension, quality, grayscale: value.grayscale, throwIfCancelled: () => reporter.throwIfCancelled() },
            (percent) => advance(50 + (percent / 100) * 30, "Rendering pages to images…"),
          );
          reporter.throwIfCancelled();
          if (flattened.byteLength < main.bytes.byteLength) {
            candidates.push({
              id: "flatten",
              label: "Maximum shrink (flattened)",
              note: `Pages become images · ${formatBytes(flattened.byteLength)}`,
              bytes: flattened,
            });
          }
        } catch {
          // A failed flatten is never fatal: the sharp variant is already built.
          // Re-throw only when the user actually cancelled the job.
          reporter.throwIfCancelled();
        }
      }

      let variants: CompressVariant[];
      let targetMet: boolean | undefined;
      if (targetBytes) {
        const ladder = [
          { dpi: 110, quality: 0.45 },
          { dpi: 96, quality: 0.35 },
          { dpi: 72, quality: 0.26 },
        ];
        let index = 0;
        while (!candidates.some((variant) => variant.bytes.byteLength <= targetBytes) && index < ladder.length && pageCount <= 150) {
          const step = ladder[index];
          index += 1;
          const label = `${step.dpi} DPI · JPEG ${Math.round(step.quality * 100)}%`;
          advance(80 + index * 4, "Pushing harder to reach your target size…", `Attempt ${index} of ${ladder.length} · ${label}`);
          const attempt = await recompressImages(
            source,
            { quality: step.quality, maxDimension: maxDimensionForDpi(step.dpi), ...shared },
            () => undefined,
          );
          reporter.throwIfCancelled();
          attempts.push({ label, bytes: attempt.bytes.byteLength });
          candidates.push({
            id: `attempt-${index}`,
            label,
            note: formatBytes(attempt.bytes.byteLength),
            bytes: attempt.bytes,
          });
        }
        const fitting = [...candidates]
          .filter((variant) => variant.bytes.byteLength <= targetBytes)
          .sort((a, b) => a.bytes.byteLength - b.bytes.byteLength);
        const smallest = [...candidates].sort((a, b) => a.bytes.byteLength - b.bytes.byteLength)[0];
        const winner = fitting[0] ?? smallest ?? candidates[0];
        targetMet = winner.bytes.byteLength <= targetBytes;
        variants = [
          {
            id: "target",
            label: targetMet ? "Target reached" : "Smallest achievable",
            note: `${formatBytes(winner.bytes.byteLength)} · target ${formatBytes(targetBytes)}`,
            bytes: winner.bytes,
          },
        ];
      } else {
        variants = candidates.sort((a, b) => a.bytes.byteLength - b.bytes.byteLength);
      }

      advance(97, "Writing the report…");
      return {
        variants,
        attempts,
        originalSize: file.size,
        pages: pageCount,
        preset: value.preset,
        dpi,
        quality: Math.round(quality * 100),
        photos: main.changed,
        grayscale: value.grayscale,
        stripMetadata: value.stripMetadata,
        removeAnnotations: value.removeAnnotations,
        keepText: value.keepText,
        targetBytes,
        targetMet,
      };
    });
  };

  const outcome = job.result;
  const variants = outcome?.variants ?? [];
  const active = variants.find((variant) => variant.id === choiceId) ?? variants[0];
  const activeSize = active ? active.bytes.byteLength : 0;
  const savedPct = outcome ? Math.round((1 - activeSize / Math.max(1, outcome.originalSize)) * 100) : 0;
  const grew = Boolean(outcome) && activeSize > (outcome?.originalSize ?? 0);
  const fileName = `${sanitizeName(baseName(pdf.file?.name ?? "document"))}-compressed.pdf`;
  const title = !outcome
    ? "PDF compressed"
    : !grew && savedPct > 0
      ? `${savedPct}% smaller`
      : "Already highly optimized";

  const explanation = outcome
    ? [
        grew
          ? `The rebuilt copy is ${formatBytes(activeSize - outcome.originalSize)} larger than the original because this file was already tightly packed.`
          : savedPct > 0
            ? `Saving ${savedPct}% by rebuilding the file structure${
                COMPRESS_PRESETS[outcome.preset].lossless || outcome.photos === 0
                  ? " without re-encoding any photo"
                  : ` and re-encoding ${outcome.photos} photo${outcome.photos === 1 ? "" : "s"}`
              }.`
            : "This PDF is already efficient, so the rebuilt copy is about the same size.",
        outcome.keepText
          ? "Text, links and vectors stay selectable in every variant."
          : "You turned off “Keep text selectable”, so a flattened variant is offered when it saves more.",
        outcome.grayscale ? "Embedded photos were converted to grey." : "",
        outcome.stripMetadata ? "Title, author, keywords and XMP were removed." : "",
        outcome.removeAnnotations ? "Annotations, notes and form fields were removed." : "",
      ]
        .filter(Boolean)
        .join(" ")
    : "";

  usePrimaryShortcut(run, Boolean(pdf.bytes) && !busy);
  useDownloadShortcut(
    () => {
      if (active) downloadOutput(active.bytes, fileName, "application/pdf");
    },
    Boolean(active),
  );

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to compress" />

      {pdf.bytes && (
        <>
          <PresetChips
            label="Quality preset"
            value={opts.value.preset}
            presets={PRESET_ORDER.map((id) => ({
              id,
              label: COMPRESS_PRESETS[id].label,
              description: COMPRESS_PRESETS[id].description,
            }))}
            onSelect={(preset) => {
              const config = COMPRESS_PRESETS[preset.id];
              change({ preset: preset.id, dpi: config.dpi, quality: config.quality });
            }}
          />

          <Field
            label="Target size (optional)"
            hint={
              lossless
                ? "Archive rebuilds without re-encoding photos, so it can’t chase a size. Pick Screen, Balanced or Print for a target."
                : "Enter a size in MB and Paperly will keep pushing until the file fits — or return the smallest achievable result and tell you honestly."
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <TextInput
                type="number"
                min={0.05}
                step={0.05}
                inputMode="decimal"
                disabled={lossless}
                value={targetMB}
                placeholder={pdf.file ? `e.g. ${Math.max(0.1, Number((pdf.file.size / 1024 / 1024 / 2).toFixed(1)))}` : "e.g. 1.5"}
                onChange={(event) => {
                  setTargetMB(event.target.value);
                  if (!job.busy) job.reset();
                }}
                className="max-w-[180px]"
                aria-label="Target size in megabytes"
              />
              <span className="text-[12px] text-muted">MB</span>
              {pdf.file && (
                <span className="text-[11px] text-muted">
                  This file is {formatBytes(pdf.file.size)}
                  {lossless ? "" : ` · a realistic target is ${formatBytes(Math.max(1, Math.round(pdf.file.size / 2)))}`}
                </span>
              )}
            </div>
          </Field>

          <AdvancedOptions
            scope="compress"
            badge="6 controls"
            description="Resolution, photo quality, colour, metadata and annotations"
            onReset={opts.reset}
          >
            <div className="space-y-4">
              <OptionsGrid>
                <NumberField
                  label="Image resolution"
                  value={opts.value.dpi}
                  onChange={(dpi) => change({ dpi })}
                  min={72}
                  max={600}
                  step={1}
                  suffix="DPI"
                  disabled={lossless}
                  hint="Caps how many pixels each photo keeps. Screen ≈ 96, print ≈ 300."
                />
                <SliderField
                  label="JPEG quality"
                  value={opts.value.quality}
                  onChange={(quality) => change({ quality })}
                  min={30}
                  max={100}
                  format={(quality) => `${quality}%`}
                  disabled={lossless}
                  hint="Lower means smaller photos and softer detail."
                />
              </OptionsGrid>
              <OptionsGrid>
                <Switch
                  label="Grayscale photos"
                  checked={opts.value.grayscale}
                  onChange={(grayscale) => change({ grayscale })}
                  description="Converts embedded photos to grey. Text and vector colours only turn grey in the flattened variant."
                />
                <Switch
                  label="Strip metadata"
                  checked={opts.value.stripMetadata}
                  onChange={(stripMetadata) => change({ stripMetadata })}
                  description="Removes title, author, keywords and the XMP packet."
                />
                <Switch
                  label="Remove annotations"
                  checked={opts.value.removeAnnotations}
                  onChange={(removeAnnotations) => change({ removeAnnotations })}
                  description="Drops comments, sticky notes, links and form fields."
                />
                <Switch
                  label="Keep text selectable"
                  checked={opts.value.keepText}
                  onChange={(keepText) => change({ keepText })}
                  description="Off also builds a flattened copy so pages can shrink further."
                />
              </OptionsGrid>
              <OptionNote tone={opts.value.grayscale ? "warn" : "neutral"}>
                {opts.value.grayscale
                  ? "Grayscale only touches embedded photos. To grey out text and vector colour too, take the flattened variant — that rasterises each page, so text stops being selectable."
                  : "Resolution and JPEG quality override the preset’s defaults for this run. Re-encoding only touches photos that are actually larger than the setting."}
              </OptionNote>
              <Button variant="ghost" size="sm" type="button" onClick={opts.reset}>
                Reset options
              </Button>
            </div>
          </AdvancedOptions>

          <div className="rounded-xl border border-line bg-bone-deep/35 p-3.5 text-[12px] leading-relaxed text-ink/75">
            <p className="flex items-center gap-1.5 font-semibold text-forest">
              <Gauge className="h-3.5 w-3.5" /> Smarter than flattening everything
            </p>
            <p className="mt-1">
              Paperly rebuilds the PDF structure and re-encodes only oversized photos. Selectable text, links and vectors stay intact. If a
              file is already lean, we say so instead of handing you a bigger file.
            </p>
          </div>

          {job.failed && <Alert tone="error">{job.error}</Alert>}
          {job.status === "cancelled" && <Alert tone="info">Cancelled — nothing was downloaded.</Alert>}

          <div className="border-t border-line pt-4">
            <Button onClick={run} loading={job.busy}>
              <Gauge className="h-4 w-4" /> Compress PDF
            </Button>
          </div>

          {job.busy && (
            <div className="space-y-2">
              <Progress value={job.percent ?? undefined} label={job.label} detail={job.detail} etaMs={job.etaMs} />
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="ghost" size="sm" type="button" onClick={job.cancel}>
                  Cancel
                </Button>
                <span className="text-[11px] text-muted">{describeJobTime(job)}</span>
              </div>
            </div>
          )}
        </>
      )}

      {outcome && active && (
        <div className="space-y-3">
          <DownloadPanel
            bytes={active.bytes}
            filename={fileName}
            size={activeSize}
            pages={outcome.pages}
            originalSize={outcome.originalSize}
            mime="application/pdf"
            title={title}
            description={`${formatBytes(outcome.originalSize)} → ${formatBytes(activeSize)} · ${outcome.pages} page${
              outcome.pages === 1 ? "" : "s"
            } · ${compressSettingsLabel(outcome)}`}
            facts={[
              { label: "Preset", value: COMPRESS_PRESETS[outcome.preset].label },
              { label: "Resolution", value: `${outcome.dpi} DPI` },
              { label: "Photos", value: `${outcome.photos} re-encoded` },
              ...(outcome.grayscale ? [{ label: "Colour", value: "grey photos" }] : []),
              ...(outcome.targetBytes
                ? [{ label: "Target", value: outcome.targetMet ? `${formatBytes(outcome.targetBytes)} · reached` : `${formatBytes(outcome.targetBytes)} · missed` }]
                : []),
            ]}
            onDownload={() => downloadOutput(active.bytes, fileName, "application/pdf")}
            extra={
              <div className="mt-3 space-y-2">
                {variants.length > 1 && (
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-paper/75">Which version?</p>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      {variants.map((variant) => (
                        <button
                          key={variant.id}
                          type="button"
                          aria-pressed={variant.id === active.id}
                          onClick={() => setChoiceId(variant.id)}
                          className={cn(
                            "rounded-xl border p-2.5 text-left text-[11.5px] leading-snug transition-colors",
                            variant.id === active.id ? "border-lime bg-paper/10" : "border-paper/20 hover:bg-paper/5",
                          )}
                        >
                          <span className="block font-semibold text-paper">{variant.label}</span>
                          <span className="text-paper/60">{variant.note}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {outcome.attempts.length > 1 && (
                  <p className="rounded-xl border border-paper/15 bg-paper/[0.06] px-3 py-2 text-[11px] leading-relaxed text-paper/60">
                    <span className="font-semibold text-paper/80">Attempts: </span>
                    {outcome.attempts.map((attempt) => `${attempt.label} → ${formatBytes(attempt.bytes)}`).join(" · ")}
                  </p>
                )}
                <p className="text-[11px] leading-relaxed text-paper/60">{explanation}</p>
              </div>
            }
          />
          {grew && (
            <Alert tone="info" title="No meaningful reduction">
              This PDF is already optimized, so the rebuilt copy is {formatBytes(activeSize - (outcome?.originalSize ?? 0))} larger. Download it
              only if you need the rebuilt structure — nothing was lost either way.
            </Alert>
          )}
          {active.id === "flatten" && (
            <Alert tone="warning" title="Flattened output">
              Text becomes part of a page image, so it’s no longer selectable or searchable. Keep the sharp version if that matters.
            </Alert>
          )}
        </div>
      )}
    </div>
  );
}

/* ================================================================== *
 * REPAIR
 * ================================================================== */
type RepairMode = "safe" | "aggressive" | "pages";

type RepairPreferences = {
  mode: RepairMode;
  preserveMetadata: boolean;
  renderWidth: number;
};

const REPAIR_MODES: { value: RepairMode; label: string; hint: string }[] = [
  { value: "safe", label: "Safe rebuild", hint: "Rewrite the file structure, keep everything" },
  { value: "aggressive", label: "Aggressive salvage", hint: "Ignore invalid objects, rebuild the xref" },
  { value: "pages", label: "Pages only", hint: "Drop forms, attachments and scripts" },
];

interface RepairOutcome {
  bytes: Uint8Array;
  name: string;
  pages: number;
  method: string;
  objects: number;
  attachmentsRemoved: number;
  metadata: string;
  lost?: string;
}

function countAttachments(doc: PDFDocument): number {
  try {
    const names = doc.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
    const embedded = names?.lookupMaybe(PDFName.of("EmbeddedFiles"), PDFDict);
    const array = embedded?.lookupMaybe(PDFName.of("Names"), PDFArray);
    if (!array) return 0;
    return Math.floor(array.size() / 2);
  } catch {
    return 0;
  }
}

async function rebuildStructure(
  source: ArrayBuffer,
  opts: { preserveMetadata: boolean; plainXref: boolean },
): Promise<{ bytes: Uint8Array; pages: number; objects: number; attachments: number }> {
  const doc = await openPdfLib(source);
  const attachments = countAttachments(doc);
  const objects = Math.max(0, doc.context.largestObjectNumber);
  const pages = doc.getPageCount();
  if (!pages) throw new Error("The file has no readable pages.");
  if (!opts.preserveMetadata) stripDocumentMetadata(doc);
  const bytes = await doc.save({ useObjectStreams: !opts.plainXref });
  if (bytes.byteLength < 200) throw new Error("The rebuilt file came out empty.");
  // Verify the rebuild: a file that no longer opens is not a recovery.
  const check = await openPdfLib(bytes);
  if (check.getPageCount() !== pages) throw new Error("The rebuilt file lost pages.");
  return { bytes, pages, objects, attachments };
}

async function copyPagesIntoFreshPdf(
  source: ArrayBuffer,
  preserveMetadata: boolean,
): Promise<{ bytes: Uint8Array; pages: number; objects: number; attachments: number }> {
  const doc = await openPdfLib(source);
  const attachments = countAttachments(doc);
  const clean = await PDFDocument.create();
  const copies = await clean.copyPages(doc, doc.getPageIndices());
  copies.forEach((page) => clean.addPage(page));
  if (copies.length === 0) throw new Error("No page could be copied out of the file.");
  if (preserveMetadata) {
    const title = doc.getTitle();
    const author = doc.getAuthor();
    const subject = doc.getSubject();
    if (title) clean.setTitle(title);
    if (author) clean.setAuthor(author);
    if (subject) clean.setSubject(subject);
  }
  const bytes = await clean.save({ useObjectStreams: true });
  const check = await openPdfLib(bytes);
  if (check.getPageCount() !== copies.length) throw new Error("The salvaged file lost pages.");
  return { bytes, pages: copies.length, objects: Math.max(0, clean.context.largestObjectNumber), attachments };
}

interface RepairStrategySuccess {
  ok: true;
  outcome: RepairOutcome;
}

interface RepairStrategyFailure {
  ok: false;
  message: string;
}

/**
 * Run one recovery strategy and report its outcome instead of throwing, so the
 * caller can chain strategies without losing the friendly message.
 */
async function attemptRepairStrategy(step: () => Promise<RepairOutcome>): Promise<RepairStrategySuccess | RepairStrategyFailure> {
  try {
    return { ok: true, outcome: await step() };
  } catch (error) {
    if (error instanceof JobCancelledError) throw error;
    return { ok: false, message: (error as Error)?.message || "The rebuild didn’t produce a readable file." };
  }
}

export function RepairTool() {
  const initial = useInitialFiles().filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
  const [file, setFile] = useState<File | null>(initial[0] ?? null);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [damage, setDamage] = useState("");
  const [loading, setLoading] = useState(Boolean(initial[0]));
  const prefs = useToolPreferences("repair", {
    mode: "safe" as RepairMode,
    preserveMetadata: true,
    renderWidth: 1400,
  });
  const job = useJob<RepairOutcome>();

  const change = (next: Partial<RepairPreferences>) => {
    prefs.patch(next);
    if (!job.busy) job.reset();
  };

  useEffect(() => {
    if (!file) {
      setBytes(null);
      setPageCount(0);
      setDamage("");
      return;
    }
    let alive = true;
    setLoading(true);
    setDamage("");
    (async () => {
      const buffer = await readFileBytes(file);
      if (!alive) return;
      setBytes(buffer);
      try {
        const doc = await openPdfJs(buffer);
        if (!alive) return;
        setPageCount(doc.numPages);
        await doc.destroy();
      } catch (err) {
        if (!alive) return;
        setPageCount(0);
        setDamage(
          `${(err as Error)?.name === "PasswordException" ? "This file is encrypted. Repair can’t rebuild an encrypted document — unlock it first." : "The document structure looks damaged. Repair will try a structural rebuild, then a page-by-page recovery."}`,
        );
      }
    })()
      .catch((err) => alive && setDamage((err as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [file]);

  const run = () => {
    const source = bytes;
    const current = file;
    if (!source || !current || job.busy) return;
    const mode = prefs.value.mode;
    const preserveMetadata = prefs.value.preserveMetadata;
    const renderWidth = clampNumber(prefs.value.renderWidth, 800, 2400);
    const name = `${sanitizeName(baseName(current.name))}-repaired.pdf`;

    void job.run(async (reporter) => {
      const advance = createAdvance(reporter);
      const failures: string[] = [];
      const metadata = preserveMetadata ? "preserved" : "stripped";

      if (mode !== "pages") {
        advance(6, mode === "aggressive" ? "Salvaging every readable object…" : "Rebuilding the document structure…");
        const structural = await attemptRepairStrategy(async () => {
          const rebuilt = await rebuildStructure(source, {
            preserveMetadata,
            plainXref: mode === "aggressive",
          });
          reporter.throwIfCancelled();
          return {
            bytes: rebuilt.bytes,
            name,
            pages: rebuilt.pages,
            method: mode === "aggressive" ? "Aggressive salvage" : "Structure rebuilt",
            objects: rebuilt.objects,
            attachmentsRemoved: 0,
            metadata,
          };
        });
        if (structural.ok) {
          advance(96, "Verifying the rebuilt file…");
          return structural.outcome;
        }
        failures.push(structural.message);
        if (mode === "safe") {
          // Second load strategy: copy pages into a fresh document, which
          // regenerates the cross-reference table and drops broken objects.
          advance(22, "First rebuild failed — trying a page-copy strategy…");
          const salvaged = await attemptRepairStrategy(async () => {
            const copied = await copyPagesIntoFreshPdf(source, preserveMetadata);
            reporter.throwIfCancelled();
            return {
              bytes: copied.bytes,
              name,
              pages: copied.pages,
              method: "Page-copy salvage",
              objects: copied.objects,
              attachmentsRemoved: Math.max(0, copied.attachments),
              metadata,
              lost: "Attachments, forms, scripts and bookmarks don’t survive a page-copy salvage.",
            };
          });
          if (salvaged.ok) {
            advance(96, "Verifying the salvaged file…");
            return salvaged.outcome;
          }
          failures.push(salvaged.message);
          throw new Error(
            `We couldn’t rebuild this file. ${failures[failures.length - 1]} Try “Aggressive salvage”, or “Pages only” to keep the visible pages as images.`,
          );
        }
      }

      advance(28, "Reading the pages for a page-by-page recovery…");
      let sourceDoc: Awaited<ReturnType<typeof openPdfJs>>;
      try {
        sourceDoc = await openPdfJs(source);
      } catch {
        throw new Error(
          failures[0] ||
            "This file is too damaged to read any pages. If you have another copy, or the original source application, try re-exporting it.",
        );
      }
      if (sourceDoc.numPages > 80) {
        await sourceDoc.destroy();
        throw new Error("Page-by-page recovery is limited to 80 pages here. Try splitting the source file first.");
      }
      let attachments = 0;
      try {
        attachments = countAttachments(await openPdfLib(source));
      } catch {
        /* the source is too damaged to count attachments */
      }
      const out = await PDFDocument.create();
      for (let i = 1; i <= sourceDoc.numPages; i++) {
        reporter.throwIfCancelled();
        const rendered = await renderPdfPage(sourceDoc, i, { targetWidth: renderWidth, type: "image/jpeg", quality: 0.85 });
        const page = await sourceDoc.getPage(i);
        const viewport = page.getViewport({ scale: 1 });
        const pdfPage = out.addPage([viewport.width, viewport.height]);
        const image = await out.embedJpg(dataUrlToBytes(rendered.dataUrl));
        pdfPage.drawImage(image, { x: 0, y: 0, width: viewport.width, height: viewport.height });
        advance(28 + (i / Math.max(1, sourceDoc.numPages)) * 66, `Recovering page ${i} of ${sourceDoc.numPages}…`);
      }
      await sourceDoc.destroy();
      const outBytes = await out.save({ useObjectStreams: true });
      advance(98, "Verifying the recovered pages…");
      const check = await openPdfLib(outBytes);
      return {
        bytes: outBytes,
        name,
        pages: check.getPageCount(),
        method: "Page-by-page recovery",
        objects: Math.max(0, out.context.largestObjectNumber),
        attachmentsRemoved: attachments,
        metadata: "not carried over",
        lost: "Rebuilt pages are images: selectable text, links, forms and attachments are gone.",
      };
    });
  };

  const outcome = job.result;
  usePrimaryShortcut(run, Boolean(file && bytes) && !job.busy);
  useDownloadShortcut(
    () => {
      if (outcome) downloadOutput(outcome.bytes, outcome.name, "application/pdf");
    },
    Boolean(outcome),
  );

  return (
    <div className="space-y-5">
      {!file ? (
        <FileDrop
          accept="application/pdf,.pdf"
          acceptLabel="The damaged PDF"
          sample={SAMPLE.pdf}
          onFiles={(files) => {
            job.reset();
            setFile(files[0]);
          }}
        />
      ) : (
        <div className="space-y-2">
          <FileRow
            file={file}
            onRemove={() => {
              job.reset();
              setFile(null);
            }}
            size={loading ? "Reading…" : pageCount ? `${pageCount} pages · ${formatBytes(file.size)}` : formatBytes(file.size)}
          />
          {loading && <Progress label="Inspecting the document locally…" />}
          {!loading && damage && (
            <Alert tone="warning" title="Damage detected">
              {damage}
            </Alert>
          )}
          {!loading && !damage && (
            <Alert tone="success" title="File opens normally">
              This PDF loads cleanly. Repair can still rebuild its structure, which sometimes fixes slow or odd rendering in other readers.
            </Alert>
          )}
        </div>
      )}

      {file && bytes && (
        <>
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/55">Recovery mode</p>
            <Segmented
              value={prefs.value.mode}
              onChange={(mode) => change({ mode })}
              options={REPAIR_MODES.map((mode) => ({ value: mode.value, label: mode.label, hint: mode.hint }))}
            />
          </div>

          <div className="rounded-xl border border-line bg-bone-deep/35 p-3.5">
            <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-forest">
              <Wrench className="h-3.5 w-3.5" /> How recovery works
            </p>
            <ol className="mt-1.5 space-y-1 text-[11.5px] leading-relaxed text-ink/70">
              <li>1. Rebuild the PDF structure (keeps text, links and quality).</li>
              <li>2. If the structure is unusable, copy each readable page into a fresh document.</li>
              <li>3. As a last resort, render every readable page into a new PDF.</li>
            </ol>
          </div>

          <AdvancedOptions
            scope="repair"
            badge="2 controls"
            description="Page rendering and document metadata"
            onReset={prefs.reset}
          >
            <div className="space-y-4">
              <OptionsGrid>
                <NumberField
                  label="Page render width"
                  value={prefs.value.renderWidth}
                  onChange={(renderWidth) => change({ renderWidth })}
                  min={800}
                  max={2400}
                  step={100}
                  suffix="px"
                  hint="Only used by page-by-page recovery. Higher keeps more detail and makes a bigger file."
                />
                <Switch
                  label="Preserve metadata"
                  checked={prefs.value.preserveMetadata}
                  onChange={(preserveMetadata) => change({ preserveMetadata })}
                  description="Keeps title, author and subject when a rebuild can carry them over."
                />
              </OptionsGrid>
              <OptionNote tone="warn">
                Page-by-page recovery rasterises each page: selectable text, links, form fields and attachments are lost. A structural rebuild
                keeps all of them.
              </OptionNote>
            </div>
          </AdvancedOptions>

          {job.failed && <Alert tone="error">{job.error}</Alert>}
          {job.status === "cancelled" && <Alert tone="info">Cancelled — nothing was downloaded.</Alert>}

          <div className="border-t border-line pt-4">
            <Button onClick={run} loading={job.busy}>
              <Wrench className="h-4 w-4" /> Repair PDF
            </Button>
          </div>

          {job.busy && (
            <div className="space-y-2">
              <Progress value={job.percent ?? undefined} label={job.label} detail={job.detail} etaMs={job.etaMs} />
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="ghost" size="sm" type="button" onClick={job.cancel}>
                  Cancel
                </Button>
                <span className="text-[11px] text-muted">{describeJobTime(job)}</span>
              </div>
            </div>
          )}
        </>
      )}

      {outcome && (
        <>
          <DownloadPanel
            bytes={outcome.bytes}
            title="Document recovered"
            filename={outcome.name}
            size={outcome.bytes.byteLength}
            pages={outcome.pages}
            mime="application/pdf"
            onDownload={() => downloadOutput(outcome.bytes, outcome.name, "application/pdf")}
            description={`${outcome.method} · ${outcome.pages} readable pages · ${formatBytes(outcome.bytes.byteLength)}`}
            facts={[
              { label: "Method", value: outcome.method },
              { label: "Objects rebuilt", value: String(outcome.objects) },
              { label: "Metadata", value: outcome.metadata },
              {
                label: "Attachments",
                value: outcome.attachmentsRemoved ? `${outcome.attachmentsRemoved} removed` : "none",
              },
            ]}
          />
          {outcome.lost && <Alert tone="warning" title="What changed">{outcome.lost}</Alert>}
          <Alert tone="info" title="Some content may be unrecoverable">
            A rebuild can only preserve what is still readable in the file. Check a couple of pages after downloading — if something is
            missing, try another recovery mode on the original file.
          </Alert>
        </>
      )}
    </div>
  );
}

/* ================================================================== *
 * PAGE NUMBERS
 * ================================================================== */
type GridPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "middle-left"
  | "middle-center"
  | "middle-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

const POSITION_ROWS: GridPosition[][] = [
  ["top-left", "top-center", "top-right"],
  ["middle-left", "middle-center", "middle-right"],
  ["bottom-left", "bottom-center", "bottom-right"],
];

const POSITION_LABELS: Record<GridPosition, string> = {
  "top-left": "Top left",
  "top-center": "Top center",
  "top-right": "Top right",
  "middle-left": "Middle left",
  "middle-center": "Middle center",
  "middle-right": "Middle right",
  "bottom-left": "Bottom left",
  "bottom-center": "Bottom center",
  "bottom-right": "Bottom right",
};

const POSITIONS: GridPosition[] = POSITION_ROWS.flat();

type PageFormat = "plain" | "slash" | "page" | "of" | "dashes" | "custom";

const FORMAT_PRESETS: { id: PageFormat; label: string; description: string }[] = [
  { id: "slash", label: "1 / 3", description: "Number and document length — the default, unambiguous everywhere." },
  { id: "plain", label: "1", description: "Just the number. Best when the total changes often." },
  { id: "page", label: "Page 1", description: "“Page” in front of the number." },
  { id: "of", label: "Page 1 of 3", description: "The longest, clearest form." },
  { id: "dashes", label: "- 1 -", description: "Centred dashes, classic book styling." },
  { id: "custom", label: "Custom", description: "Use {page} and {pages} in any wording you need." },
];

const MM = 2.834645669;

/** The label for one page, using the selected format or the custom template. */
function pageLabel(format: PageFormat, template: string, page: number, pages: number): string {
  switch (format) {
    case "plain":
      return `${page}`;
    case "page":
      return `Page ${page}`;
    case "of":
      return `Page ${page} of ${pages}`;
    case "dashes":
      return `- ${page} -`;
    case "custom": {
      const rendered = template.replace(/\{page\}/gi, String(page)).replace(/\{pages\}/gi, String(pages));
      return rendered.trim() || `${page}`;
    }
    default:
      return `${page} / ${pages}`;
  }
}

type PageNumberPreferences = {
  format: PageFormat;
  template: string;
  position: GridPosition;
  start: number;
  size: number;
  margin: number;
  color: string;
  opacity: number;
  bold: boolean;
  skipFirst: boolean;
};

interface NumberResult {
  bytes: Uint8Array;
  name: string;
  pages: number;
  style: string;
  summary: string;
}

export function PageNumbersTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const { thumbs } = usePdfThumbs(pdf.bytes, { width: 380, quality: 0.8, max: 1 });
  const opts = useToolPreferences("page-numbers", {
    format: "slash" as PageFormat,
    template: "Page {page} of {pages}",
    position: "bottom-center" as GridPosition,
    start: 1,
    size: 10,
    margin: 12,
    color: "#25352c",
    opacity: 100,
    bold: false,
    skipFirst: false,
  });
  const [range, setRange] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<NumberResult | null>(null);

  const update = (next: Partial<PageNumberPreferences>) => {
    opts.patch(next);
    setResult(null);
  };

  // A different document invalidates both the range and the last result.
  const numberedFile = pdf.file;
  useEffect(() => {
    setResult(null);
    setRange("");
  }, [numberedFile]);

  const fontSize = clampNumber(opts.value.size, 6, 36);
  const marginMm = clampNumber(opts.value.margin, 0, 60);
  const opacity = clampNumber(opts.value.opacity, 10, 100) / 100;
  const startNumber = Math.max(0, Math.round(opts.value.start));
  const totalPages = startNumber + Math.max(0, pdf.pageCount - 1);

  const apply = async () => {
    const source = pdf.bytes;
    const current = pdf.file;
    if (!source || !current || busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const selected = parsePageQuery(range, pdf.pageCount);
      const targets = opts.value.skipFirst ? selected.filter((page) => page !== 1) : selected;
      if (!targets.length) {
        throw new Error("Every selected page is skipped. Turn off “Skip the first page” or select more pages.");
      }
      const doc = await openPdfLib(source);
      const font = await doc.embedFont(opts.value.bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
      const all = doc.getPages();
      const marginPt = marginMm * MM;
      targets.forEach((pageNumber) => {
        const page = all[pageNumber - 1];
        if (!page) return;
        const label = pageLabel(opts.value.format, opts.value.template, startNumber + pageNumber - 1, totalPages);
        const textWidth = font.widthOfTextAtSize(label, fontSize);
        const { width, height } = page.getSize();
        let x = (width - textWidth) / 2;
        if (opts.value.position.endsWith("left")) x = marginPt;
        if (opts.value.position.endsWith("right")) x = width - marginPt - textWidth;
        const y = opts.value.position.startsWith("top")
          ? height - marginPt - fontSize
          : opts.value.position.startsWith("bottom")
            ? marginPt
            : (height - fontSize) / 2;
        page.drawText(label, { x, y, size: fontSize, font, color: hexToRgb(opts.value.color), opacity });
      });
      const bytes = await doc.save();
      setResult({
        bytes,
        name: `${sanitizeName(baseName(current.name))}-numbered.pdf`,
        pages: targets.length,
        style: `${pageLabel(opts.value.format, opts.value.template, startNumber, totalPages)} · ${POSITION_LABELS[opts.value.position]} · ${fontSize} pt`,
        summary: describePageQuery(targets, pdf.pageCount),
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const previewNumber = pageLabel(opts.value.format, opts.value.template, startNumber, totalPages);
  const previewWidth = 260;
  const previewStyle: CSSProperties = {
    fontSize: `${Math.max(7, (fontSize / 612) * previewWidth * 1.5)}px`,
    color: opts.value.color,
    opacity,
    fontWeight: opts.value.bold ? 700 : 500,
    position: "absolute",
    left: opts.value.position.endsWith("left") ? `${(marginMm / 210) * 100}%` : opts.value.position.endsWith("right") ? "auto" : "50%",
    right: opts.value.position.endsWith("right") ? `${(marginMm / 210) * 100}%` : "auto",
    top: opts.value.position.startsWith("top")
      ? `${(marginMm / 297) * 100}%`
      : opts.value.position.startsWith("middle")
        ? "50%"
        : "auto",
    bottom: opts.value.position.startsWith("bottom") ? `${(marginMm / 297) * 100}%` : "auto",
    transform: `translate(${opts.value.position.endsWith("center") ? "-50%" : "0"}, ${
      opts.value.position.startsWith("middle") ? "-50%" : "0"
    })`,
    whiteSpace: "nowrap",
  };

  usePrimaryShortcut(() => void apply(), Boolean(pdf.bytes) && !busy);
  useDownloadShortcut(
    () => {
      if (result) downloadOutput(result.bytes, result.name, "application/pdf");
    },
    Boolean(result),
  );

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to number" />
      {pdf.bytes && (
        <>
          <div className="grid gap-5 md:grid-cols-[1fr_260px]">
            <div className="space-y-4">
              <PresetChips
                label="Format"
                value={opts.value.format}
                presets={FORMAT_PRESETS}
                onSelect={(preset) => update({ format: preset.id })}
              />

              {opts.value.format === "custom" && (
                <Field
                  label="Custom format"
                  hint="Use {page} for the page number and {pages} for the document length."
                >
                  <TextInput
                    value={opts.value.template}
                    onChange={(event) => update({ template: event.target.value })}
                    placeholder="Sheet {page} of {pages}"
                    spellCheck={false}
                    aria-label="Custom page-number format"
                    className="max-w-sm font-mono"
                  />
                </Field>
              )}

              <div className="flex flex-wrap items-start gap-4">
                <div>
                  <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/55">Position</p>
                  <div role="group" aria-label="Number position" className="inline-grid grid-cols-3 gap-1">
                    {POSITIONS.map((cell) => (
                      <button
                        key={cell}
                        type="button"
                        aria-label={POSITION_LABELS[cell]}
                        title={POSITION_LABELS[cell]}
                        aria-pressed={opts.value.position === cell}
                        onClick={() => update({ position: cell })}
                        className={cn(
                          "flex h-8 w-11 items-center justify-center rounded-md border transition-colors",
                          opts.value.position === cell
                            ? "border-forest bg-forest"
                            : "border-line bg-paper hover:border-forest/40",
                        )}
                      >
                        <span
                          className={cn(
                            "h-1.5 w-1.5 rounded-full",
                            opts.value.position === cell ? "bg-lime" : "bg-ink/25",
                          )}
                        />
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[11px] text-muted">{POSITION_LABELS[opts.value.position]}</p>
                </div>
              </div>

              <RangeField
                value={range}
                onChange={(next) => {
                  setRange(next);
                  setResult(null);
                }}
                total={pdf.pageCount}
                label="Pages to number"
                hint="Leave empty for all pages. Numbering always reflects the page’s position in the document."
              />
            </div>

            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/75">Live preview</p>
              <div className="surface overflow-hidden p-2.5">
                {thumbs[0] ? (
                  <div className="relative">
                    <img src={thumbs[0].dataUrl} alt="Page number preview" className="w-full" />
                    <span style={previewStyle}>{previewNumber}</span>
                  </div>
                ) : (
                  <div className="flex aspect-[3/4] animate-pulse items-center justify-center bg-bone-deep text-[11px] text-ink/70">
                    Rendering preview…
                  </div>
                )}
              </div>
              <p className="mt-2 text-[10.5px] leading-snug text-muted">Preview is approximate; final placement uses precise PDF points.</p>
            </div>
          </div>

          <AdvancedOptions
            scope="page-numbers"
            badge="7 controls"
            description="Numbering start, font, colour, opacity and margin"
            onReset={opts.reset}
          >
            <div className="space-y-4">
              <OptionsGrid>
                <NumberField
                  label="First number"
                  value={startNumber}
                  onChange={(start) => update({ start })}
                  min={0}
                  max={9999}
                  step={1}
                  hint="The number printed on the first numbered page."
                />
                <SliderField
                  label="Font size"
                  value={fontSize}
                  onChange={(size) => update({ size })}
                  min={7}
                  max={22}
                  format={(value) => `${value} pt`}
                />
                <SliderField
                  label="Margin from edge"
                  value={marginMm}
                  onChange={(margin) => update({ margin })}
                  min={4}
                  max={40}
                  format={(value) => `${value} mm`}
                />
                <SliderField
                  label="Opacity"
                  value={opts.value.opacity}
                  onChange={(value) => update({ opacity: value })}
                  min={10}
                  max={100}
                  format={(value) => `${value}%`}
                  hint="Faint numbers are less distracting on busy pages."
                />
                <Field label="Text colour">
                  <ColorInput value={opts.value.color} onChange={(color) => update({ color })} label="Page number colour" />
                </Field>
                <Switch
                  label="Bold numbers"
                  checked={opts.value.bold}
                  onChange={(bold) => update({ bold })}
                  description="Uses Helvetica Bold instead of Helvetica."
                />
                <Switch
                  label="Skip the first page"
                  checked={opts.value.skipFirst}
                  onChange={(skipFirst) => update({ skipFirst })}
                  description="Leaves page 1 unnumbered — common for covers."
                />
              </OptionsGrid>
              <OptionNote>
                Numbering always follows the page’s position in the document, so page 7 keeps the label for 7 even when only a few pages are
                selected.
              </OptionNote>
            </div>
          </AdvancedOptions>

          {error && <Alert tone="error">{error}</Alert>}
          <div className="border-t border-line pt-4">
            <Button onClick={() => void apply()} loading={busy}>
              <Hash className="h-4 w-4" /> Add page numbers
            </Button>
          </div>
          {busy && <Progress label="Writing the numbers into every page…" />}
        </>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Numbers added"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          mime="application/pdf"
          onDownload={() => downloadOutput(result.bytes, result.name, "application/pdf")}
          description={`${result.summary} numbered · ${result.style}`}
          facts={[
            { label: "Format", value: pageLabel(opts.value.format, opts.value.template, startNumber, totalPages) },
            { label: "Position", value: POSITION_LABELS[opts.value.position] },
            { label: "Size", value: `${fontSize} pt` },
          ]}
        />
      )}
    </div>
  );
}
