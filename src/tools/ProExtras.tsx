import {
  Check,
  Copy,
  Download,
  FileImage,
  FileOutput,
  FileText,
  Images,
  Quote,
  ScanText,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import JSZip from "jszip";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  decodePDFRawStream,
  type PDFRef,
} from "@cantoo/pdf-lib";
import {
  baseName,
  dataUrlToBytes,
  downloadBytes,
  formatBytes,
  openPdfLib,
  parseRanges,
  sanitizeName,
  uniqueInOrder,
} from "@/lib/pdf";
import { extractDocument } from "@/lib/extract";
import { useInitialFiles, usePdfFile } from "@/lib/usePdf";
import { copyText } from "@/lib/router";
import { Alert, Badge, Button, Field, Progress, Segmented, Switch } from "@/components/ui";
import { DownloadPanel, RangeField, SinglePdfInput } from "@/components/toolParts";
import { PagePicker } from "@/components/PagePicker";
import {
  AdvancedOptions,
  NumberField,
  OptionNote,
  OptionsGrid,
  PresetChips,
  SliderField,
} from "@/components/AdvancedOptions";
import { describeJobTime, useJob } from "@/lib/job";
import { useDownloadShortcut, usePrimaryShortcut } from "@/lib/hotkeys";
import { useToolPreferences } from "@/lib/prefs";
import { pagesToQuery } from "@/lib/pageQuery";
import { renderMarkdownToPdf } from "@/tools/MarkdownTools";
import { cn } from "@/utils/cn";

/** Keep an output-name suffix safe for every platform. */
const cleanSuffix = (raw: string): string =>
  raw
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

/* ================================================================== *
 * REMOVE PAGES
 * ================================================================== */
interface RemoveResult {
  bytes: Uint8Array;
  name: string;
  kept: number;
  removed: number;
}

export function RemovePagesTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const opts = useToolPreferences("remove-pages", { suffix: "-removed" });
  const job = useJob<RemoveResult>();
  const [range, setRange] = useState("");
  const [outputStem, setOutputStem] = useState("");
  const [error, setError] = useState("");

  const total = pdf.pageCount;

  useEffect(() => {
    setRange("");
    setOutputStem("");
    setError("");
    job.reset();
    // `job` is a stable controller; the document is the real dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf.bytes]);

  const removeSet = useMemo(() => {
    if (!total) return new Set<number>();
    try {
      return new Set(parseRanges(range, total));
    } catch {
      return new Set<number>();
    }
  }, [range, total]);

  const defaultStem = pdf.file
    ? `${sanitizeName(baseName(pdf.file.name))}${cleanSuffix(opts.value.suffix)}`
    : `paperly${cleanSuffix(opts.value.suffix) || "-removed"}`;
  const stem = outputStem.trim() ? sanitizeName(outputStem.trim()) : defaultStem;
  const kept = Math.max(0, total - removeSet.size);

  const apply = () => {
    const source = pdf.bytes;
    const file = pdf.file;
    if (!source || !file) return;
    setError("");
    const remove = (() => {
      try {
        return uniqueInOrder(parseRanges(range, total));
      } catch (err) {
        setError((err as Error).message);
        return null;
      }
    })();
    if (!remove) return;
    if (!remove.length) {
      setError("Choose at least one page to remove.");
      return;
    }
    if (remove.length >= total) {
      setError("You can’t remove every page. Leave at least one.");
      return;
    }
    const name = `${stem}.pdf`;
    void job.run(async ({ report, throwIfCancelled }) => {
      report(15, "Copying the pages you keep…");
      const src = await openPdfLib(source);
      const out = await PDFDocument.create();
      const keep = src.getPageIndices().filter((index) => !remove.includes(index + 1));
      const copied = await out.copyPages(src, keep);
      copied.forEach((page) => out.addPage(page));
      throwIfCancelled();
      report(85, "Saving the PDF…");
      const bytes = await out.save();
      return { bytes, name, kept: keep.length, removed: remove.length };
    });
  };

  const result = job.result;
  usePrimaryShortcut(apply, Boolean(pdf.bytes) && removeSet.size > 0 && !job.busy);
  useDownloadShortcut(() => {
    if (result) downloadBytes(result.bytes, result.name);
  }, Boolean(result));

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF with pages to remove" />
      {pdf.bytes && (
        <>
          <RangeField
            value={range}
            onChange={(value) => {
              setRange(value);
              setError("");
            }}
            total={total}
            label="Pages to remove"
            hint="Read only the pages you want gone — everything else is kept. The picker below stays in sync."
            showAll={false}
          />

          <PagePicker
            bytes={pdf.bytes}
            pageCount={total}
            selected={[...removeSet].sort((a, b) => a - b)}
            onChange={(pages) => {
              setRange(pagesToQuery(pages, total));
              setError("");
            }}
            label="Choose pages to remove"
            hint="shift-click for a run"
          />

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-bone-deep/35 px-3.5 py-2.5 text-[11.5px]">
            <span className="font-semibold text-clay-ink">
              {removeSet.size} page{removeSet.size === 1 ? "" : "s"} selected for removal
            </span>
            <span className="text-muted">
              {kept} of {total} page{total === 1 ? "" : "s"} will remain
            </span>
          </div>

          <Field label="Output file name" hint="Rename the download before saving it.">
            <input
              value={outputStem}
              onChange={(event) => setOutputStem(event.target.value)}
              placeholder={defaultStem}
              className="h-11 w-full rounded-xl border border-line bg-paper px-3.5 text-[14px] text-ink placeholder:text-ink/50 focus:border-forest/50 focus:outline-none focus:ring-2 focus:ring-forest/10"
              aria-label="Output file name"
              spellCheck={false}
            />
          </Field>

          <AdvancedOptions
            scope="remove-pages"
            badge="1 control"
            description="Remembered output naming"
            onReset={opts.reset}
          >
            <div className="space-y-3">
              <Field label="Suggested name suffix" hint={`Suggested file: ${stem}.pdf`}>
                <input
                  value={opts.value.suffix}
                  onChange={(event) => opts.set("suffix", event.target.value)}
                  placeholder="-removed"
                  maxLength={40}
                  spellCheck={false}
                  aria-label="Suggested name suffix"
                  className="h-11 w-full rounded-xl border border-line bg-paper px-3.5 text-[14px] text-ink placeholder:text-ink/50 focus:border-forest/50 focus:outline-none focus:ring-2 focus:ring-forest/10"
                />
              </Field>
              <OptionNote>
                Remembered for next time. The output file name above always wins when you type one.
              </OptionNote>
            </div>
          </AdvancedOptions>

          {error && <Alert tone="error">{error}</Alert>}
          {job.failed && <Alert tone="error">{job.error}</Alert>}
          {job.status === "cancelled" && <Alert tone="info">Cancelled — nothing was downloaded.</Alert>}
          {job.busy && <Progress value={job.percent ?? undefined} label={job.label} detail={describeJobTime(job)} />}

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={apply} loading={job.busy} disabled={!removeSet.size || job.busy}>
              <Trash2 className="h-4 w-4" />{" "}
              {removeSet.size
                ? `Remove ${removeSet.size} page${removeSet.size === 1 ? "" : "s"}`
                : "Remove pages"}
            </Button>
            {job.busy && (
              <Button variant="outline" onClick={job.cancel}>
                Cancel
              </Button>
            )}
            <Button variant="ghost" onClick={() => setRange("")} disabled={!removeSet.size}>
              Clear selection
            </Button>
          </div>
        </>
      )}
      {result && (
        <DownloadPanel
          title="Pages removed"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.kept}
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${result.removed} page${result.removed === 1 ? "" : "s"} removed · ${result.kept} kept · original quality`}
          bytes={result.bytes}
          facts={[
            { label: "Removed", value: `${result.removed}` },
            { label: "Kept", value: `${result.kept}` },
          ]}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * EXTRACT PAGES
 * ================================================================== */
type ExtractResult =
  | { kind: "pdf"; bytes: Uint8Array; name: string; pages: number }
  | { kind: "zip"; bytes: Uint8Array; entries: { name: string; bytes: Uint8Array }[]; name: string; pages: number };

export function ExtractPagesTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const job = useJob<ExtractResult>();
  const opts = useToolPreferences("extract-pages", { separate: false, suffix: "-extracted" });
  const [range, setRange] = useState("");
  const [picked, setPicked] = useState<number[] | null>(null);
  const [outputStem, setOutputStem] = useState("");
  const [error, setError] = useState("");

  const total = pdf.pageCount;

  useEffect(() => {
    setRange("");
    setPicked(null);
    setOutputStem("");
    setError("");
    job.reset();
    // `job` is a stable controller; the document is the real dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf.bytes]);

  const pages = useMemo(() => {
    if (!total) return [];
    if (picked) return picked;
    try {
      return uniqueInOrder(parseRanges(range, total));
    } catch {
      return [];
    }
  }, [picked, range, total]);

  const defaultStem = pdf.file
    ? `${sanitizeName(baseName(pdf.file.name))}${cleanSuffix(opts.value.suffix)}`
    : `paperly${cleanSuffix(opts.value.suffix)}`;
  const stem = outputStem.trim() ? sanitizeName(outputStem.trim()) : defaultStem;

  const apply = () => {
    const source = pdf.bytes;
    const file = pdf.file;
    if (!source || !file) return;
    setError("");
    if (!pages.length) {
      setError("Choose at least one page to extract.");
      return;
    }
    const separate = opts.value.separate;
    void job.run(async ({ report, throwIfCancelled }) => {
      report(10, "Opening the PDF…");
      const src = await openPdfLib(source);
      const base = stem;
      if (separate) {
        const entries: { name: string; bytes: Uint8Array }[] = [];
        for (let index = 0; index < pages.length; index += 1) {
          throwIfCancelled();
          const page = pages[index];
          const out = await PDFDocument.create();
          const [copied] = await out.copyPages(src, [page - 1]);
          out.addPage(copied);
          entries.push({
            name: `${base}-page-${String(page).padStart(2, "0")}.pdf`,
            bytes: await out.save(),
          });
          report(((index + 1) / pages.length) * 80, "Splitting pages…", `${index + 1} of ${pages.length}`);
        }
        const zip = new JSZip();
        entries.forEach((entry) => zip.file(entry.name, entry.bytes));
        report(90, "Packaging the ZIP…");
        const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
        return { kind: "zip" as const, bytes, entries, name: `${base}-pages.zip`, pages: pages.length };
      }
      const out = await PDFDocument.create();
      const copied = await out.copyPages(
        src,
        pages.map((page) => page - 1),
      );
      copied.forEach((page, index) => {
        out.addPage(page);
        if (index % 25 === 0) report(10 + (index / Math.max(1, pages.length)) * 75, "Copying pages…");
      });
      throwIfCancelled();
      report(90, "Saving the PDF…");
      const bytes = await out.save();
      return { kind: "pdf" as const, bytes, name: `${base}.pdf`, pages: pages.length };
    });
  };

  const result = job.result;
  usePrimaryShortcut(apply, Boolean(pdf.bytes) && pages.length > 0 && !job.busy);
  useDownloadShortcut(() => {
    if (!result) return;
    if (result.kind === "pdf") downloadBytes(result.bytes, result.name);
    else downloadBytes(result.bytes, result.name, "application/zip");
  }, Boolean(result));

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to extract pages from" />
      {pdf.bytes && (
        <>
          <RangeField
            value={range}
            onChange={(value) => {
              setRange(value);
              setPicked(null);
              setError("");
            }}
            total={total}
            label="Pages to extract"
            hint="Example: 1-3, 7, 10-12 — or odd, even, last, last-2, >10. Leave empty for all pages."
          />

          <PagePicker
            bytes={pdf.bytes}
            pageCount={total}
            selected={pages}
            onChange={(next) => {
              setPicked(next);
              setRange(pagesToQuery(next, total));
              setError("");
            }}
            label="Choose pages to extract"
            hint="shift-click for a run"
          />

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-bone-deep/35 px-3.5 py-2.5 text-[11.5px]">
            <span className="font-semibold text-forest">
              {pages.length} of {total} page{total === 1 ? "" : "s"} selected
            </span>
            <span className="text-muted">
              {opts.value.separate
                ? `Will produce ${pages.length} single-page PDF${pages.length === 1 ? "" : "s"} in a ZIP`
                : "Will produce one PDF"}
            </span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Output file name" hint="Base name for the download.">
              <input
                value={outputStem}
                onChange={(event) => setOutputStem(event.target.value)}
                placeholder={defaultStem}
                className="h-11 w-full rounded-xl border border-line bg-paper px-3.5 text-[14px] text-ink placeholder:text-ink/50 focus:border-forest/50 focus:outline-none focus:ring-2 focus:ring-forest/10"
                aria-label="Output file name"
                spellCheck={false}
              />
            </Field>
            <div className="flex items-end">
              <Switch
                checked={opts.value.separate}
                onChange={(value) => opts.set("separate", value)}
                label="One PDF per page"
                description="Packages each extracted page as its own PDF in a ZIP"
              />
            </div>
          </div>

          <AdvancedOptions
            scope="extract-pages"
            badge="1 control"
            description="Remembered output naming"
            onReset={opts.reset}
          >
            <div className="space-y-3">
              <Field label="Suggested name suffix" hint={`Suggested file: ${stem}.pdf`}>
                <input
                  value={opts.value.suffix}
                  onChange={(event) => opts.set("suffix", event.target.value)}
                  placeholder="-extracted"
                  maxLength={40}
                  spellCheck={false}
                  aria-label="Suggested name suffix"
                  className="h-11 w-full rounded-xl border border-line bg-paper px-3.5 text-[14px] text-ink placeholder:text-ink/50 focus:border-forest/50 focus:outline-none focus:ring-2 focus:ring-forest/10"
                />
              </Field>
              <OptionNote>
                Remembered for next time. The output file name above always wins when you type one.
              </OptionNote>
            </div>
          </AdvancedOptions>

          {error && <Alert tone="error">{error}</Alert>}
          {job.failed && <Alert tone="error">{job.error}</Alert>}
          {job.status === "cancelled" && <Alert tone="info">Cancelled — nothing was downloaded.</Alert>}
          {job.busy && <Progress value={job.percent ?? undefined} label={job.label} detail={describeJobTime(job)} />}

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={apply} loading={job.busy} disabled={!pages.length || job.busy}>
              <FileOutput className="h-4 w-4" /> Extract pages
            </Button>
            {job.busy && (
              <Button variant="outline" onClick={job.cancel}>
                Cancel
              </Button>
            )}
            <span className="text-[11.5px] text-muted">Original text, links and quality are kept.</span>
          </div>
        </>
      )}
      {result && (
        <DownloadPanel
          title={result.kind === "zip" ? `${result.entries.length} single-page PDFs ready` : "Pages extracted"}
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          onDownload={() => {
            if (result.kind === "pdf") downloadBytes(result.bytes, result.name);
            else downloadBytes(result.bytes, result.name, "application/zip");
          }}
          bytes={result.bytes}
          mime={result.kind === "zip" ? "application/zip" : "application/pdf"}
          description={`${result.pages} page${result.pages === 1 ? "" : "s"} copied with original text, links and quality`}
          extra={
            result.kind === "zip" ? (
              <div className="mt-2 max-h-36 overflow-y-auto rounded-lg border border-paper/15 bg-paper/[0.05] p-2 text-[11px] text-paper/70 scrollbar-thin">
                {result.entries.slice(0, 40).map((entry) => (
                  <p key={entry.name} className="flex items-center justify-between gap-2 py-0.5">
                    <span className="truncate">{entry.name}</span>
                    <span className="shrink-0 tabular-nums text-paper/75">{formatBytes(entry.bytes.byteLength)}</span>
                  </p>
                ))}
              </div>
            ) : undefined
          }
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * EXTRACT IMAGES
 * ================================================================== */
interface ExtractedImage {
  id: string;
  page: number;
  width: number;
  height: number;
  bytes: Uint8Array;
  size: number;
  extension: "jpg" | "png" | "jp2";
  preview: string | null;
  name: string;
}

type ImageFormat = "original" | "png" | "jpeg";

interface ImageExportPrefs extends Record<string, unknown> {
  minWidth: number;
  minHeight: number;
  format: ImageFormat;
  jpegQuality: number;
  deduplicate: boolean;
  flattenAlpha: boolean;
  packageZip: boolean;
}

interface ImageExportResult {
  kind: "single" | "zip" | "individual";
  bytes: Uint8Array | null;
  name: string;
  count: number;
  mime: string;
}

const IMAGE_MIME: Record<ExtractedImage["extension"], string> = {
  jpg: "image/jpeg",
  png: "image/png",
  jp2: "image/jp2",
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function bytesToPreview(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

/** Cheap content fingerprint so identical images are only listed once. */
function contentSignature(bytes: Uint8Array): string {
  let hash = 2166136261;
  const step = Math.max(1, Math.floor(bytes.length / 4096));
  for (let index = 0; index < bytes.length; index += step) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 16777619);
  }
  return `${bytes.length}:${(hash >>> 0).toString(16)}`;
}

function streamFilter(dict: PDFDict): string {
  const filter = dict.lookup(PDFName.of("Filter"));
  if (filter instanceof PDFName) return filter.asString();
  if (filter instanceof PDFArray) {
    const first = filter.get(0);
    if (first instanceof PDFName) return first.asString();
  }
  return "";
}

function colorComponents(dict: PDFDict, context: PDFDocument["context"]): number | null {
  const colorSpace = dict.lookup(PDFName.of("ColorSpace"));
  if (colorSpace instanceof PDFName) {
    const name = colorSpace.asString();
    if (name === "/DeviceRGB" || name === "/CalRGB") return 3;
    if (name === "/DeviceGray" || name === "/CalGray") return 1;
    if (name === "/DeviceCMYK") return 4;
    return null;
  }
  if (colorSpace instanceof PDFArray) {
    const first = colorSpace.get(0);
    if (first instanceof PDFName && first.asString() === "/ICCBased") {
      const icc = context.lookup(colorSpace.get(1) as PDFRef);
      if (icc instanceof PDFRawStream) {
        return icc.dict.lookup(PDFName.of("N"), PDFNumber)?.asNumber() ?? 3;
      }
    }
  }
  return null;
}

function rawToPngBytes(dict: PDFDict, stream: PDFRawStream, context: PDFDocument["context"]): Uint8Array | null {
  const width = dict.lookup(PDFName.of("Width"), PDFNumber)?.asNumber() ?? 0;
  const height = dict.lookup(PDFName.of("Height"), PDFNumber)?.asNumber() ?? 0;
  const bits = dict.lookup(PDFName.of("BitsPerComponent"), PDFNumber)?.asNumber() ?? 8;
  const components = colorComponents(dict, context);
  if (!width || !height || bits !== 8 || !components) return null;
  let decoded: Uint8Array;
  try {
    decoded = decodePDFRawStream(stream).decode() as Uint8Array;
  } catch {
    return null;
  }
  if (decoded.length < width * height * components) return null;

  let alpha: Uint8Array | null = null;
  const maskRef = dict.lookup(PDFName.of("SMask"));
  if (maskRef instanceof PDFRawStream) {
    try {
      const maskDict = maskRef.dict;
      const maskBits = maskDict.lookup(PDFName.of("BitsPerComponent"), PDFNumber)?.asNumber() ?? 8;
      if (maskBits === 8) {
        const mask = decodePDFRawStream(maskRef).decode() as Uint8Array;
        if (mask.length >= width * height) alpha = mask;
      }
    } catch {
      alpha = null;
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const imageData = ctx.createImageData(width, height);
  for (let index = 0, pointer = 0; index < width * height; index++, pointer += components) {
    let red: number;
    let green: number;
    let blue: number;
    if (components === 1) {
      red = green = blue = decoded[pointer];
    } else if (components === 4) {
      const c = decoded[pointer] / 255;
      const m = decoded[pointer + 1] / 255;
      const y = decoded[pointer + 2] / 255;
      const k = decoded[pointer + 3] / 255;
      red = 255 * (1 - c) * (1 - k);
      green = 255 * (1 - m) * (1 - k);
      blue = 255 * (1 - y) * (1 - k);
    } else {
      red = decoded[pointer];
      green = decoded[pointer + 1];
      blue = decoded[pointer + 2];
    }
    const offset = index * 4;
    imageData.data[offset] = red;
    imageData.data[offset + 1] = green;
    imageData.data[offset + 2] = blue;
    imageData.data[offset + 3] = alpha ? alpha[index] : 255;
  }
  ctx.putImageData(imageData, 0, 0);
  const dataUrl = canvas.toDataURL("image/png");
  return dataUrlToBytes(dataUrl);
}

/** Re-encode one extracted image, or pass the original bytes straight through. */
async function convertImage(
  image: ExtractedImage,
  format: ImageFormat,
  flattenAlpha: boolean,
  quality: number,
): Promise<{ name: string; bytes: Uint8Array; mime: string }> {
  if (format === "original") {
    return { name: image.name, bytes: image.bytes, mime: IMAGE_MIME[image.extension] };
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(
      new Blob([image.bytes as unknown as BlobPart], { type: IMAGE_MIME[image.extension] }),
    );
  } catch {
    throw new Error(
      `“${image.name}” uses an encoding this browser can’t re-encode. Keep the original format for that image.`,
    );
  }
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close?.();
    throw new Error("This browser can’t re-encode images.");
  }
  const keepAlpha = format === "png" && !flattenAlpha;
  if (!keepAlpha) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const base = image.name.replace(/\.[^.]+$/, "");
  if (format === "png") {
    return { name: `${base}.png`, bytes: dataUrlToBytes(canvas.toDataURL("image/png")), mime: "image/png" };
  }
  return {
    name: `${base}.jpg`,
    bytes: dataUrlToBytes(canvas.toDataURL("image/jpeg", Math.min(1, Math.max(0.4, quality / 100)))),
    mime: "image/jpeg",
  };
}

export function ExtractImagesTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const opts = useToolPreferences<ImageExportPrefs>("extract-images", {
    minWidth: 96,
    minHeight: 96,
    format: "original",
    jpegQuality: 88,
    deduplicate: true,
    flattenAlpha: true,
    packageZip: true,
  });
  const scanJob = useJob<ExtractedImage[]>();
  const exportJob = useJob<ImageExportResult>();
  const [range, setRange] = useState("");
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [images, setImages] = useState<ExtractedImage[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    setImages(null);
    setSelected(new Set());
    setPreview(null);
    setError("");
    setWarning("");
    scanJob.reset();
    exportJob.reset();
    // The jobs are stable controllers; the document is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf.bytes]);

  const total = pdf.pageCount;
  const searchPages = useMemo(() => {
    if (!total) return [];
    try {
      return uniqueInOrder(parseRanges(range, total));
    } catch {
      return [];
    }
  }, [range, total]);

  const scan = () => {
    const source = pdf.bytes;
    const file = pdf.file;
    if (!source || !file) return;
    setError("");
    setWarning("");
    setImages(null);
    setPreview(null);
    const pages = searchPages;
    if (!pages.length) {
      setError("That page range doesn’t match any page. Leave it empty to search the whole document.");
      return;
    }
    const minWidth = opts.value.minWidth;
    const minHeight = opts.value.minHeight;
    const deduplicate = opts.value.deduplicate;
    void scanJob.run(async ({ step, throwIfCancelled }) => {
      const doc = await openPdfLib(source);
      const context = doc.context;
      const pageList = doc.getPages();
      const seenResources = new Set<string>();
      const seenContent = new Set<string>();
      const output: ExtractedImage[] = [];
      const skipped: string[] = [];
      let counter = 0;

      for (let position = 0; position < pages.length; position += 1) {
        throwIfCancelled();
        const pageIndex = pages[position] - 1;
        const page = pageList[pageIndex];
        const resources = page?.node.Resources();
        const xObjects = resources?.lookup(PDFName.of("XObject"));
        if (xObjects instanceof PDFDict) {
          for (const [resourceName, ref] of xObjects.entries()) {
            if (!(ref instanceof Object) || !("objectNumber" in (ref as object))) continue;
            const key = ref.toString();
            if (seenResources.has(key)) continue;
            seenResources.add(key);
            const stream = context.lookup(ref as PDFRef);
            if (!(stream instanceof PDFRawStream)) continue;
            const dict = stream.dict;
            const subtype = dict.lookup(PDFName.of("Subtype"));
            if (!(subtype instanceof PDFName) || subtype.asString() !== "/Image") continue;
            const width = dict.lookup(PDFName.of("Width"), PDFNumber)?.asNumber() ?? 0;
            const height = dict.lookup(PDFName.of("Height"), PDFNumber)?.asNumber() ?? 0;
            if (width < minWidth || height < minHeight) continue;
            if (width * height > 40_000_000) {
              skipped.push(`${resourceName.asString().replace("/", "")} on page ${pageIndex + 1} (too large)`);
              continue;
            }
            const filter = streamFilter(dict);
            counter += 1;
            const label = `${sanitizeName(baseName(file.name))}-p${pageIndex + 1}-${String(counter).padStart(2, "0")}`;
            let candidate: ExtractedImage | null = null;
            if (filter === "/DCTDecode") {
              const bytes = stream.getContents();
              const previewUrl = bytes.length < 8_000_000 ? bytesToPreview(bytes, "image/jpeg") : null;
              candidate = {
                id: key,
                page: pageIndex + 1,
                width,
                height,
                bytes,
                size: bytes.byteLength,
                extension: "jpg",
                preview: previewUrl,
                name: `${label}.jpg`,
              };
            } else if (filter === "/JPXDecode") {
              const bytes = stream.getContents();
              candidate = {
                id: key,
                page: pageIndex + 1,
                width,
                height,
                bytes,
                size: bytes.byteLength,
                extension: "jp2",
                preview: null,
                name: `${label}.jp2`,
              };
            } else if (filter === "/FlateDecode" || filter === "") {
              const bytes = rawToPngBytes(dict, stream, context);
              if (!bytes) {
                skipped.push(`${resourceName.asString().replace("/", "")} on page ${pageIndex + 1} (unsupported colour format)`);
                continue;
              }
              candidate = {
                id: key,
                page: pageIndex + 1,
                width,
                height,
                bytes,
                size: bytes.byteLength,
                extension: "png",
                preview: bytesToPreview(bytes, "image/png"),
                name: `${label}.png`,
              };
            } else {
              skipped.push(`${resourceName.asString().replace("/", "")} on page ${pageIndex + 1} (${filter.replace("/", "")})`);
            }
            if (!candidate) continue;
            if (deduplicate) {
              const signature = contentSignature(candidate.bytes);
              if (seenContent.has(signature)) continue;
              seenContent.add(signature);
            }
            output.push(candidate);
            if (output.length >= 250) break;
          }
        }
        step(position + 1, pages.length, `Reading image streams… page ${position + 1} of ${pages.length}`);
        if (output.length >= 250) break;
      }

      output.sort((a, b) => b.width * b.height - a.width * a.height);
      setImages(output);
      setSelected(new Set(output.map((image) => image.id)));
      setPreview(output.find((image) => image.preview)?.preview ?? null);
      if (!output.length) {
        setWarning(
          "No extractable raster images were found with these filters. Try a smaller minimum size or a wider page range — vector artwork and text are not images.",
        );
      } else if (skipped.length) {
        setWarning(
          `${skipped.length} image${skipped.length === 1 ? "" : "s"} used an unsupported encoding and were skipped: ${skipped
            .slice(0, 3)
            .join(", ")}.`,
        );
      }
      return output;
    });
  };

  const chosen = images?.filter((image) => selected.has(image.id)) ?? [];
  const totalSize = chosen.reduce((sum, image) => sum + image.size, 0);

  const mimeFor = (image: ExtractedImage): string => IMAGE_MIME[image.extension];

  const exportImages = () => {
    if (!chosen.length) return;
    const format = opts.value.format;
    const flattenAlpha = opts.value.flattenAlpha;
    const quality = opts.value.jpegQuality;
    const packageZip = opts.value.packageZip;
    const base = sanitizeName(baseName(pdf.file?.name ?? "document"));
    setError("");
    void exportJob.run(async ({ report, throwIfCancelled }) => {
      const exported: { name: string; bytes: Uint8Array; mime: string }[] = [];
      for (let index = 0; index < chosen.length; index += 1) {
        throwIfCancelled();
        exported.push(await convertImage(chosen[index], format, flattenAlpha, quality));
        report(((index + 1) / chosen.length) * 85, "Preparing images…", `${index + 1} of ${chosen.length}`);
      }
      throwIfCancelled();
      // A single image is always handed over as the image itself.
      if (exported.length === 1) {
        const single = exported[0];
        downloadBytes(single.bytes, single.name, single.mime);
        return { kind: "single" as const, bytes: single.bytes, name: single.name, count: 1, mime: single.mime };
      }
      if (!packageZip) {
        exported.forEach((entry) => downloadBytes(entry.bytes, entry.name, entry.mime));
        return { kind: "individual" as const, bytes: null, name: "", count: exported.length, mime: "" };
      }
      report(90, "Packaging the ZIP…");
      const zip = new JSZip();
      exported.forEach((entry) => zip.file(entry.name, entry.bytes));
      const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
      const name = `${base}-images.zip`;
      downloadBytes(bytes, name, "application/zip");
      return { kind: "zip" as const, bytes, name, count: exported.length, mime: "application/zip" };
    });
  };

  const exportResult = exportJob.result;

  usePrimaryShortcut(scan, Boolean(pdf.bytes) && !scanJob.busy);
  useDownloadShortcut(() => void exportImages(), chosen.length > 0 && !exportJob.busy);

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF with images" />
      {pdf.bytes && (
        <>
          <RangeField
            value={range}
            onChange={(value) => {
              setRange(value);
              setImages(null);
              setWarning("");
            }}
            total={total}
            label="Pages to search"
            hint="Leave empty to scan every page."
          />

          <OptionsGrid>
            <NumberField
              label="Minimum width"
              value={opts.value.minWidth}
              onChange={(value) => opts.set("minWidth", value)}
              min={8}
              max={4000}
              suffix="px"
              hint="Filters out logos, bullets and decorative icons."
            />
            <NumberField
              label="Minimum height"
              value={opts.value.minHeight}
              onChange={(value) => opts.set("minHeight", value)}
              min={8}
              max={4000}
              suffix="px"
            />
          </OptionsGrid>

          <AdvancedOptions
            scope="extract-images"
            badge="5 controls"
            description="Format, quality, duplicates and packaging"
            onReset={opts.reset}
          >
            <div className="space-y-4">
              <Field label="Format preference">
                <Segmented
                  value={opts.value.format}
                  onChange={(value) => opts.set("format", value)}
                  size="sm"
                  options={[
                    { value: "original", label: "Original" },
                    { value: "png", label: "PNG" },
                    { value: "jpeg", label: "JPEG" },
                  ]}
                />
              </Field>
              <PresetChips
                label="Quick presets"
                value={opts.value.format}
                presets={[
                  { id: "original", label: "Lossless originals", description: "Byte-for-byte JPEGs; raw images rebuilt as PNG." },
                  { id: "png", label: "PNG for everything", description: "Re-encodes every image losslessly — larger files." },
                  { id: "jpeg", label: "Small JPEGs", description: "Re-encodes photos at the chosen quality." },
                ]}
                onSelect={(preset) => opts.set("format", preset.id as ImageFormat)}
              />
              <SliderField
                label="JPEG quality"
                value={opts.value.jpegQuality}
                onChange={(value) => opts.set("jpegQuality", value)}
                min={50}
                max={100}
                format={(value) => `${value}%`}
                disabled={opts.value.format !== "jpeg"}
              />
              <OptionsGrid>
                <Switch
                  checked={opts.value.deduplicate}
                  onChange={(value) => opts.set("deduplicate", value)}
                  label="Skip duplicate images"
                  description="Identical images used on several pages are listed once"
                />
                <Switch
                  checked={opts.value.flattenAlpha}
                  onChange={(value) => opts.set("flattenAlpha", value)}
                  label="Flatten transparency onto white"
                  description="Transparent PNGs get a white background instead of an alpha channel"
                />
                <div className="sm:col-span-2">
                  <Switch
                    checked={opts.value.packageZip}
                    onChange={(value) => opts.set("packageZip", value)}
                    label="Package as a ZIP"
                    description="Several images are delivered as one archive; a single image downloads directly"
                  />
                </div>
              </OptionsGrid>
              <OptionNote>
                Originals are never resampled. PNG and JPEG output re-encodes the exact stored pixels, so dimensions never change.
              </OptionNote>
            </div>
          </AdvancedOptions>

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={scan} loading={scanJob.busy} disabled={scanJob.busy}>
              <Images className="h-4 w-4" /> {images ? "Scan again" : "Find images"}
            </Button>
            {scanJob.busy && (
              <Button variant="outline" onClick={scanJob.cancel}>
                Cancel
              </Button>
            )}
            <span className="text-[11.5px] text-muted">
              {images
                ? `${images.length} image${images.length === 1 ? "" : "s"} found`
                : `${searchPages.length} page${searchPages.length === 1 ? "" : "s"} to search · runs locally`}
            </span>
          </div>
          {scanJob.busy && (
            <Progress value={scanJob.percent ?? undefined} label={scanJob.label} detail={describeJobTime(scanJob)} />
          )}
        </>
      )}

      {warning && <Alert tone="warning">{warning}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
      {scanJob.failed && <Alert tone="error">{scanJob.error}</Alert>}
      {scanJob.status === "cancelled" && <Alert tone="info">Cancelled — the previous results are unchanged.</Alert>}

      {images && images.length > 0 && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5">
              <Badge tone="forest">{images.length} images</Badge>
              <Badge>{formatBytes(images.reduce((sum, image) => sum + image.size, 0))} total</Badge>
              <Badge>
                {selected.size} selected · {formatBytes(totalSize)}
              </Badge>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSelected(new Set(images.map((image) => image.id)))}
              >
                Select all
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                None
              </Button>
            </div>
          </div>

          {preview && (
            <div className="checker flex max-h-[360px] items-center justify-center overflow-hidden rounded-xl border border-line p-4">
              <img
                src={preview}
                alt="Image preview"
                className="pdf-page-shadow max-h-[330px] w-auto max-w-full object-contain"
                loading="lazy"
                decoding="async"
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {images.map((image) => {
              const isSelected = selected.has(image.id);
              return (
                <button
                  key={image.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => {
                    const next = new Set(selected);
                    if (next.has(image.id)) next.delete(image.id);
                    else next.add(image.id);
                    setSelected(next);
                    if (image.preview) setPreview(image.preview);
                  }}
                  onDoubleClick={() => downloadBytes(image.bytes, image.name, mimeFor(image))}
                  className={cn(
                    "group overflow-hidden rounded-xl border text-left transition-colors",
                    isSelected
                      ? "border-forest bg-lime/10 ring-1 ring-forest/20"
                      : "border-line bg-paper hover:border-forest/30",
                  )}
                >
                  <div className="checker flex aspect-[4/3] items-center justify-center overflow-hidden p-1.5">
                    {image.preview ? (
                      <img
                        src={image.preview}
                        alt={`Image from page ${image.page}`}
                        className="max-h-full max-w-full object-contain"
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <div className="flex flex-col items-center gap-1 text-ink/75">
                        <FileImage className="h-5 w-5" />
                        <span className="text-[9px] font-semibold uppercase">{image.extension}</span>
                      </div>
                    )}
                  </div>
                  <div className="border-t border-line px-2 py-1.5">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-[10px] font-semibold tabular-nums text-ink/70">
                        {image.width}×{image.height}
                      </span>
                      <span
                        className={cn(
                          "flex h-3.5 w-3.5 items-center justify-center rounded-full border",
                          isSelected ? "border-forest bg-forest text-lime" : "border-ink/20",
                        )}
                      >
                        {isSelected && <Check className="h-2 w-2" />}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-[9.5px] text-muted">
                      p.{image.page} · {image.extension.toUpperCase()} · {formatBytes(image.size)}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={() => void exportImages()} loading={exportJob.busy} disabled={!chosen.length || exportJob.busy}>
              <Download className="h-4 w-4" /> Download{" "}
              {chosen.length > 1 ? `${chosen.length} images` : "image"}
              {chosen.length > 1 && opts.value.packageZip ? " (ZIP)" : ""}
            </Button>
            {exportJob.busy && (
              <Button variant="outline" onClick={exportJob.cancel}>
                Cancel
              </Button>
            )}
            <span className="text-[11.5px] text-muted">Tip: double-click a thumbnail to save it directly.</span>
          </div>
          {exportJob.busy && (
            <Progress value={exportJob.percent ?? undefined} label={exportJob.label} detail={describeJobTime(exportJob)} />
          )}
          {exportJob.failed && <Alert tone="error">{exportJob.error}</Alert>}
        </>
      )}

      {exportResult && exportResult.bytes && (
        <DownloadPanel
          title={exportResult.count === 1 ? "Image ready" : `${exportResult.count} images ready`}
          filename={exportResult.name}
          size={exportResult.bytes.byteLength}
          onDownload={() =>
            exportResult.bytes &&
            downloadBytes(exportResult.bytes, exportResult.name, exportResult.mime)
          }
          bytes={exportResult.bytes}
          mime={exportResult.mime}
          description={
            exportResult.count === 1
              ? "Exact stored pixels · downloaded to your device only"
              : `ZIP · ${exportResult.count} images · ${formatBytes(exportResult.bytes.byteLength)}`
          }
          facts={[
            { label: "Format", value: opts.value.format === "original" ? "As stored" : opts.value.format.toUpperCase() },
            { label: "Images", value: String(exportResult.count) },
          ]}
        />
      )}
      {exportResult?.kind === "individual" && (
        <Alert tone="success">
          {exportResult.count} images were downloaded as separate files — allow multiple downloads if your browser asks.
        </Alert>
      )}

      {images && images.length === 0 && !scanJob.busy && (
        <div className="rounded-xl border border-dashed border-line bg-paper p-6 text-center text-[12px] text-muted">
          Nothing to extract. Lower the minimum width and height, widen the page range, or check that the PDF contains raster
          images rather than vector graphics.
        </div>
      )}
    </div>
  );
}

/* ================================================================== *
 * SMART SUMMARY (LOCAL, EXTRACTIVE)
 * ================================================================== */
const STOPWORDS = new Set(
  `a about above after again against all am an and any are aren't as at be because been before being below between both but by can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves
  also may might must shall will upon within without however therefore thus whereas among per via etc page pages figure table section document report`
    .split(/\s+/)
    .filter(Boolean),
);

interface SummarySentence {
  text: string;
  page: number;
  score: number;
  index: number;
}

interface SummaryStats {
  words: number;
  sentences: number;
  pages: number;
  minutes: number;
}

type SummaryLength = "short" | "medium" | "long";
type SummaryLayout = "bullets" | "paragraphs";
type TextExportKind = "md" | "txt";

interface SummaryPrefs extends Record<string, unknown> {
  length: SummaryLength;
  layout: SummaryLayout;
  keywordCount: number;
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'“‘(])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.split(/\s+/).length >= 5 && /[A-Za-z]/.test(sentence));
}

export function SummarizeTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const opts = useToolPreferences<SummaryPrefs>("summarize", {
    length: "medium",
    layout: "bullets",
    keywordCount: 12,
  });
  const job = useJob<void>();
  const [range, setRange] = useState("");
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<SummarySentence[] | null>(null);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [stats, setStats] = useState<SummaryStats | null>(null);
  const [edited, setEdited] = useState("");
  const [copied, setCopied] = useState(false);
  const [pdfResult, setPdfResult] = useState<{ bytes: Uint8Array; name: string; pages: number } | null>(null);
  const [textExport, setTextExport] = useState<{ bytes: Uint8Array; name: string } | null>(null);

  const ratio = opts.value.length === "short" ? 0.08 : opts.value.length === "medium" ? 0.16 : 0.28;

  const compose = (picked: SummarySentence[], layout: SummaryLayout): string =>
    layout === "bullets" ? picked.map((sentence) => `• ${sentence.text}`).join("\n\n") : picked.map((sentence) => sentence.text).join("\n\n");

  useEffect(() => {
    setSummary(null);
    setKeywords([]);
    setStats(null);
    setEdited("");
    setPdfResult(null);
    setTextExport(null);
    setError("");
    job.reset();
    // The job is a stable controller; the document is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf.bytes]);

  const run = () => {
    const source = pdf.bytes;
    const file = pdf.file;
    if (!source || !file) return;
    setError("");
    setSummary(null);
    setKeywords([]);
    setEdited("");
    setPdfResult(null);
    setTextExport(null);
    const length = opts.value.length;
    const layout = opts.value.layout;
    const keywordCount = opts.value.keywordCount;
    const ratioValue = length === "short" ? 0.08 : length === "medium" ? 0.16 : 0.28;
    void job.run(async ({ report, throwIfCancelled }) => {
      const pages = uniqueInOrder(parseRanges(range, pdf.pageCount));
      if (pages.length > 150) throw new Error("Summaries are limited to 150 pages per run. Use a page range for longer documents.");
      report(3, "Reading the text layer…");
      const extracted = await extractDocument(source, {
        pages,
        onProgress: (done, totalCount) => report((done / totalCount) * 55, `Reading page ${done} of ${totalCount}…`),
      });
      throwIfCancelled();
      if (extracted.text.replace(/\s/g, "").length < 200) {
        throw new Error("Not enough text to summarise. Scanned PDFs need OCR first — try OCR PDF, then come back.");
      }
      report(65, "Ranking sentences…");

      const allSentences: { text: string; page: number }[] = [];
      extracted.pages.forEach((page) => {
        splitSentences(page.text).forEach((sentence) => allSentences.push({ text: sentence, page: page.page }));
      });
      if (!allSentences.length) throw new Error("No complete sentences were found in this document.");

      const frequencies = new Map<string, number>();
      for (const sentence of allSentences) {
        for (const raw of sentence.text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []) {
          if (raw.length < 3 || STOPWORDS.has(raw)) continue;
          frequencies.set(raw, (frequencies.get(raw) ?? 0) + 1);
        }
      }
      const maxFrequency = Math.max(1, ...frequencies.values());

      const scored = allSentences.map((sentence, index) => {
        const words = (sentence.text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []).filter(
          (word) => !STOPWORDS.has(word) && word.length > 2,
        );
        const unique = new Set(words);
        let score = 0;
        unique.forEach((word) => {
          score += (frequencies.get(word) ?? 0) / maxFrequency;
        });
        score = score / Math.sqrt(Math.max(8, words.length));
        // lead bias: early sentences carry the thesis in most documents
        if (index < 3) score *= 1.22;
        else if (index < 8) score *= 1.08;
        if (/\b(conclusion|summary|result|finding|recommend|objective|purpose|total|important)\b/i.test(sentence.text)) {
          score *= 1.12;
        }
        if (sentence.text.length > 320) score *= 0.9;
        return { ...sentence, score, index };
      });

      const target = Math.max(3, Math.min(30, Math.round(scored.length * ratioValue)));
      const picked: SummarySentence[] = [];
      const seenPrefixes = new Set<string>();
      for (const candidate of [...scored].sort((a, b) => b.score - a.score)) {
        const prefix = candidate.text.toLowerCase().split(/\s+/).slice(0, 7).join(" ");
        if (seenPrefixes.has(prefix)) continue;
        seenPrefixes.add(prefix);
        picked.push(candidate);
        if (picked.length >= target) break;
      }
      picked.sort((a, b) => a.index - b.index);

      const topKeywords = [...frequencies.entries()]
        .filter(([word]) => word.length > 3)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, keywordCount)
        .map(([word]) => word);

      const words = extracted.text.split(/\s+/).filter(Boolean).length;
      throwIfCancelled();
      setSummary(picked);
      setKeywords(topKeywords);
      setStats({
        words,
        sentences: allSentences.length,
        pages: extracted.pages.length,
        minutes: Math.max(1, Math.round(words / 220)),
      });
      setEdited(compose(picked, layout));
      report(100, "Summary ready");
    });
  };

  const summaryText = () =>
    [
      `Paperly summary — ${pdf.file?.name ?? "document"}`,
      `${stats?.pages ?? 0} pages · ${stats?.words.toLocaleString() ?? 0} words · ${summary?.length ?? 0} selected passages · about ${stats?.minutes ?? 0} min read`,
      `Method: local deterministic extractive summariser (${opts.value.length} length, ${opts.value.layout === "bullets" ? "bullet list" : "paragraphs"})`,
      "",
      edited.trim(),
      "",
      keywords.length ? `Key terms: ${keywords.join(", ")}` : "",
      "",
      "Extractive summary created locally by Paperly. No text was uploaded or sent to an AI service.",
    ]
      .filter(Boolean)
      .join("\n");

  const summaryMarkdown = () => {
    const title = pdf.file ? baseName(pdf.file.name) : "Document";
    return [
      `# Summary: ${title}`,
      "",
      `**Source:** ${pdf.file?.name ?? "document"} · ${stats?.pages ?? 0} pages · ${stats?.words.toLocaleString() ?? 0} words · about ${stats?.minutes ?? 0} min read`,
      "",
      "## Key passages",
      "",
      ...edited
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => (line.startsWith("•") ? `- ${line.replace(/^•\s*/, "")}` : line)),
      "",
      keywords.length ? `## Key terms\n\n${keywords.map((word) => `\`${word}\``).join(" · ")}` : "",
      "",
      "---",
      `Extractive summary generated locally by Paperly (${opts.value.length} length). Passages are selected from the source document; no text is paraphrased or uploaded.`,
    ].join("\n");
  };

  const exportText = (kind: TextExportKind) => {
    const body = kind === "md" ? summaryMarkdown() : summaryText();
    const bytes = new TextEncoder().encode(body);
    const name = `${sanitizeName(baseName(pdf.file?.name ?? "document"))}-summary.${kind}`;
    downloadBytes(bytes, name, kind === "md" ? "text/markdown" : "text/plain");
    setTextExport({ bytes, name });
  };

  const createPdf = async () => {
    if (!summary || !edited.trim()) return;
    setError("");
    try {
      const title = pdf.file ? baseName(pdf.file.name) : "Document";
      const rendered = await renderMarkdownToPdf(summaryMarkdown(), {
        plainText: false,
        paper: "a4",
        orientation: "portrait",
        margin: 56,
        size: 11,
        lineHeight: 1.5,
        family: "Helvetica",
        pageNumbers: true,
        accent: "#d9f26c",
      });
      setPdfResult({ bytes: rendered.bytes, name: `${sanitizeName(title)}-summary.pdf`, pages: rendered.pages });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const result = summary && stats;
  usePrimaryShortcut(run, Boolean(pdf.bytes) && !job.busy);
  useDownloadShortcut(() => {
    const target = pdfResult ?? textExport;
    if (target) downloadBytes(target.bytes, target.name, pdfResult ? "application/pdf" : undefined);
  }, Boolean(pdfResult ?? textExport));

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A text-based PDF to summarise" />
      {pdf.bytes && (
        <>
          <div className="rounded-xl border border-forest/15 bg-lime/20 p-3.5">
            <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-forest">
              <Sparkles className="h-4 w-4" /> A summary without sending your document to an AI company
            </p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-forest/90">
              Paperly ranks the most representative sentences in your document and keeps their exact wording. It is{" "}
              <strong>extractive</strong>, not generative: it never invents facts, and nothing leaves this tab. For documents where you
              need paraphrase or translation, use a service you trust with the content.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Summary length">
              <Segmented
                value={opts.value.length}
                onChange={(value) => opts.set("length", value)}
                size="sm"
                options={[
                  { value: "short", label: "Short" },
                  { value: "medium", label: "Medium" },
                  { value: "long", label: "Detailed" },
                ]}
              />
            </Field>
            <Field label="Format">
              <Segmented
                value={opts.value.layout}
                onChange={(value) => opts.set("layout", value)}
                size="sm"
                options={[
                  { value: "bullets", label: "Bullets" },
                  { value: "paragraphs", label: "Paragraphs" },
                ]}
              />
            </Field>
            <RangeField
              value={range}
              onChange={setRange}
              total={pdf.pageCount}
              label="Pages to include"
              hint="Leave empty for the whole document."
            />
          </div>
          <OptionsGrid>
            <SliderField
              label="Key terms"
              value={opts.value.keywordCount}
              onChange={(value) => opts.set("keywordCount", value)}
              min={4}
              max={24}
              step={2}
              format={(value) => `${value}`}
              hint="How many high-frequency terms to list beside the summary."
            />
            <div className="flex items-end">
              <OptionNote>
                Passages keep their exact wording and document order, so you can search the source to verify them.
              </OptionNote>
            </div>
          </OptionsGrid>

          {error && <Alert tone="error">{error}</Alert>}
          {job.failed && <Alert tone="error">{job.error}</Alert>}
          {job.status === "cancelled" && <Alert tone="info">Cancelled — nothing was downloaded.</Alert>}

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={run} loading={job.busy} disabled={job.busy}>
              <Sparkles className="h-4 w-4" /> Summarise document
            </Button>
            {job.busy && (
              <Button variant="outline" onClick={job.cancel}>
                Cancel
              </Button>
            )}
            <span className="text-[11.5px] text-muted">
              Extractive · deterministic · fully local · {Math.round(ratio * 100)}% of sentences
            </span>
          </div>
          {job.busy && <Progress value={job.percent ?? undefined} label={job.label} detail={describeJobTime(job)} />}
        </>
      )}

      {result && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: "Pages read", value: stats.pages },
              { label: "Words extracted", value: stats.words.toLocaleString() },
              { label: "Sentences ranked", value: stats.sentences.toLocaleString() },
              { label: "Reading time", value: `~${stats.minutes} min` },
            ].map((item) => (
              <div key={item.label} className="rounded-xl border border-line bg-paper px-3 py-2.5">
                <p className="text-[18px] font-semibold leading-none text-forest">{item.value}</p>
                <p className="mt-1 text-[10px] uppercase tracking-[0.07em] text-ink/75">{item.label}</p>
              </div>
            ))}
          </div>

          {keywords.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink/75">
                {keywords.length} key terms
              </span>
              {keywords.map((word) => (
                <span
                  key={word}
                  className="rounded-full border border-line bg-paper px-2 py-0.5 text-[10.5px] font-medium text-ink/70"
                >
                  {word}
                </span>
              ))}
            </div>
          )}

          <div>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="summary-text" className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/75">
                Your summary · editable
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    setCopied(await copyText(summaryText()));
                    setTimeout(() => setCopied(false), 1600);
                  }}
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy"}
                </Button>
                <Button variant="outline" size="sm" onClick={() => exportText("md")}>
                  <FileText className="h-3.5 w-3.5" /> .md
                </Button>
                <Button variant="outline" size="sm" onClick={() => exportText("txt")}>
                  <Download className="h-3.5 w-3.5" /> .txt
                </Button>
                <Button size="sm" onClick={() => void createPdf()} loading={job.busy}>
                  PDF
                </Button>
              </div>
            </div>
            <textarea
              id="summary-text"
              value={edited}
              onChange={(event) => setEdited(event.target.value)}
              rows={12}
              className="w-full rounded-xl border border-line bg-paper px-3.5 py-3 text-[12.5px] leading-relaxed focus:border-forest/40 focus:outline-none focus:ring-2 focus:ring-forest/10"
            />
            <p className="mt-1 text-[10.5px] text-muted">
              {summary.length} of {stats.sentences.toLocaleString()} sentences selected
              {summary.length ? ` · first from page ${summary[0].page}` : ""} · method: local deterministic extractive summariser.
              Remove anything that isn’t useful before exporting.
            </p>
          </div>

          <div className="rounded-xl border border-line bg-bone-deep/30 p-3 text-[11px] leading-relaxed text-muted">
            <p className="flex items-center gap-1.5 font-semibold text-ink/75">
              <Quote className="h-3.5 w-3.5 text-forest" /> Where the passages came from
            </p>
            <p className="mt-1">
              {Array.from(new Set(summary.map((sentence) => sentence.page))).join(", ")}. Each passage is copied exactly, in document
              order, so you can search the source to verify it.
            </p>
          </div>
        </div>
      )}

      {pdfResult && (
        <DownloadPanel
          title="Summary PDF ready"
          filename={pdfResult.name}
          size={pdfResult.bytes.byteLength}
          pages={pdfResult.pages}
          onDownload={() => downloadBytes(pdfResult.bytes, pdfResult.name)}
          description="Editable text · source and key terms included · no document content left the browser"
          bytes={pdfResult.bytes}
        />
      )}

      {!pdfResult && textExport && (
        <DownloadPanel
          title="Summary text ready"
          filename={textExport.name}
          size={textExport.bytes.byteLength}
          onDownload={() =>
            downloadBytes(textExport.bytes, textExport.name, textExport.name.endsWith(".md") ? "text/markdown" : "text/plain")
          }
          bytes={textExport.bytes}
          description={`${stats?.words.toLocaleString() ?? 0} words read · ${summary?.length ?? 0} passages · method: local extractive summariser`}
        />
      )}

      {!pdf.bytes && (
        <div className="flex items-start gap-2 rounded-xl border border-dashed border-line bg-bone-deep/25 px-3.5 py-3 text-[11.5px] leading-relaxed text-muted">
          <ScanText className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Scanned PDFs have no text to summarise. Run OCR PDF first, then use the
          searchable result here.
        </div>
      )}
    </div>
  );
}
