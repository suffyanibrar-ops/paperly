import { ArrowDown, ArrowUp, Download, DownloadCloud, FileImage, Images, Plus, RotateCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  PDFDocument,
  MAX_CANVAS_PIXELS_PUBLIC,
  baseName,
  dataUrlToBytes,
  downloadUrl,
  fileExt,
  formatBytes,
  openPdfJs,
  sanitizeName,
  zipAndDownload,
  type PDFDocumentProxy,
} from "@/lib/pdf";
import { useInitialFiles, usePdfFile } from "@/lib/usePdf";
import { describeJobTime, useJob } from "@/lib/job";
import { useDownloadShortcut, usePrimaryShortcut } from "@/lib/hotkeys";
import { useToolPreferences } from "@/lib/prefs";
import { downloadOutput } from "@/lib/output";
import { describePageQuery, parsePageQuery } from "@/lib/pageQuery";
import { SAMPLE } from "@/lib/sample";
import {
  Alert,
  Button,
  EmptyHint,
  Field,
  FileDrop,
  Progress,
  Segmented,
  Select,
  StepHeader,
} from "@/components/ui";
import { DownloadPanel, RangeField, SinglePdfInput } from "@/components/toolParts";
import { AdvancedOptions, NumberField, OptionNote, OptionsGrid, PresetChips, SliderField } from "@/components/AdvancedOptions";
import { cn } from "@/utils/cn";

const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,image/gif,image/avif,.jpg,.jpeg,.png,.webp,.gif,.avif";

function isImage(file: File) {
  return file.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|avif)$/i.test(file.name);
}

/** Object URLs must be revoked, so each thumbnail owns its URL lifecycle. */
function ImageThumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url ? <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" /> : <span className="block h-full w-full bg-bone-deep" />;
}

/* ================================================================== *
 * JPG → PDF
 * ================================================================== */
type PaperSize = "fit" | "a4" | "letter" | "legal" | "a5";
const PAPER: Record<Exclude<PaperSize, "fit">, [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
  legal: [612, 1008],
  a5: [419.53, 595.28],
};
type FitMode = "contain" | "cover";
type ImagesPerPage = "one" | "two" | "four";

const PER_PAGE: Record<ImagesPerPage, number> = { one: 1, two: 2, four: 4 };
const PER_PAGE_LABEL: Record<ImagesPerPage, string> = {
  one: "One image per page",
  two: "Two images per page",
  four: "Four images per page (2 × 2)",
};

interface ImageItem {
  id: string;
  file: File;
  rotation: number;
}

interface EncodedImage {
  dataUrl: string;
  width: number;
  height: number;
}

interface EncodeOptions {
  rotation: number;
  quality: number;
  /** Target width / height. When set with `cover`, the image is cropped to it. */
  aspect?: number;
  fit: FitMode;
  maxDimension: number;
}

function rotatedSize(bitmap: ImageBitmap, rotation: number): { width: number; height: number } {
  const swap = rotation % 180 === 90;
  return swap ? { width: bitmap.height, height: bitmap.width } : { width: bitmap.width, height: bitmap.height };
}

/** Rotate, optionally crop to a page ratio, then re-encode as JPEG. */
function encodeBitmap(bitmap: ImageBitmap, options: EncodeOptions): EncodedImage {
  const rotation = ((options.rotation % 360) + 360) % 360;
  const size = rotatedSize(bitmap, rotation);
  const rotated = document.createElement("canvas");
  rotated.width = size.width;
  rotated.height = size.height;
  const rotateContext = rotated.getContext("2d");
  if (!rotateContext) throw new Error("Your browser can’t process images (canvas unavailable).");
  rotateContext.fillStyle = "#ffffff";
  rotateContext.fillRect(0, 0, rotated.width, rotated.height);
  rotateContext.translate(rotated.width / 2, rotated.height / 2);
  rotateContext.rotate((rotation * Math.PI) / 180);
  rotateContext.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);

  let sourceX = 0;
  let sourceY = 0;
  let sourceWidth = rotated.width;
  let sourceHeight = rotated.height;
  if (options.aspect && options.fit === "cover") {
    const current = rotated.width / rotated.height;
    if (current > options.aspect) {
      sourceWidth = rotated.height * options.aspect;
      sourceX = (rotated.width - sourceWidth) / 2;
    } else if (current < options.aspect) {
      sourceHeight = rotated.width / options.aspect;
      sourceY = (rotated.height - sourceHeight) / 2;
    }
  }

  const scale = Math.min(1, options.maxDimension / Math.max(sourceWidth, sourceHeight));
  const outWidth = Math.max(1, Math.round(sourceWidth * scale));
  const outHeight = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = outWidth;
  canvas.height = outHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Your browser can’t process images (canvas unavailable).");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, outWidth, outHeight);
  context.imageSmoothingQuality = "high";
  context.drawImage(rotated, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, outWidth, outHeight);
  const dataUrl = canvas.toDataURL("image/jpeg", Math.min(1, Math.max(0.4, options.quality / 100)));
  rotated.width = 1;
  rotated.height = 1;
  canvas.width = 1;
  canvas.height = 1;
  return { dataUrl, width: outWidth, height: outHeight };
}

interface ImagePdfResult {
  bytes: Uint8Array;
  name: string;
  pages: number;
  images: number;
  paper: string;
}

export function JpgToPdfTool() {
  const initial = useInitialFiles().filter(isImage);
  const [images, setImages] = useState<ImageItem[]>(() =>
    initial.map((file, index) => ({ id: `${file.name}-${file.size}-${index}`, file, rotation: 0 })),
  );
  const opts = useToolPreferences("jpg-to-pdf", {
    size: "a4" as PaperSize,
    orientation: "auto" as "auto" | "portrait" | "landscape",
    margin: 10,
    fit: "contain" as FitMode,
    quality: 90,
    perPage: "one" as ImagesPerPage,
  });
  const [result, setResult] = useState<ImagePdfResult | null>(null);
  const job = useJob<ImagePdfResult>();
  const canRun = images.length > 0 && !job.busy;
  const perPage = PER_PAGE[opts.value.perPage];
  const pageCount = Math.max(1, Math.ceil(images.length / perPage));

  /** "Fit to image" needs one image per page; otherwise A4 keeps the maths honest. */
  const effectiveSize: Exclude<PaperSize, "fit"> = opts.value.size === "fit" && perPage === 1 ? "a4" : opts.value.size === "fit" ? "a4" : opts.value.size;

  const move = (from: number, to: number) => {
    if (to < 0 || to >= images.length) return;
    const next = [...images];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setImages(next);
    setResult(null);
  };

  const rotate = (index: number) => {
    setImages((current) => current.map((item, i) => (i === index ? { ...item, rotation: (item.rotation + 90) % 360 } : item)));
    setResult(null);
  };

  const create = () => {
    if (!images.length) return;
    const items = images;
    void (async () => {
      const output = await job.run(async (reporter) => {
        const doc = await PDFDocument.create();
        const pages = Math.ceil(items.length / perPage);
        for (let pageIndex = 0; pageIndex < pages; pageIndex += 1) {
          reporter.throwIfCancelled();
          const slice = items.slice(pageIndex * perPage, pageIndex * perPage + perPage);
          const loaded: { item: ImageItem; bitmap: ImageBitmap }[] = [];
          try {
            for (const item of slice) {
              try {
                loaded.push({ item, bitmap: await createImageBitmap(item.file) });
              } catch {
                throw new Error(`${item.file.name} couldn’t be decoded. Re-save it as JPG or PNG and try again.`);
              }
            }
            const first = loaded[0];
            const firstSize = rotatedSize(first.bitmap, first.item.rotation);
            const fitPage = opts.value.size === "fit" && perPage === 1;
            let pageWidth: number;
            let pageHeight: number;
            if (fitPage) {
              pageWidth = firstSize.width * 0.75;
              pageHeight = firstSize.height * 0.75;
            } else {
              const [baseWidth, baseHeight] = PAPER[effectiveSize];
              const horizontal =
                opts.value.orientation === "auto" ? firstSize.width >= firstSize.height : opts.value.orientation === "landscape";
              [pageWidth, pageHeight] = horizontal ? [baseHeight, baseWidth] : [baseWidth, baseHeight];
            }
            const page = doc.addPage([pageWidth, pageHeight]);
            const marginPoints = fitPage ? 0 : opts.value.margin * 2.834645669;
            const boxWidth = Math.max(8, pageWidth - marginPoints * 2);
            const boxHeight = Math.max(8, pageHeight - marginPoints * 2);
            const columns = perPage === 1 ? 1 : perPage === 2 ? 1 : 2;
            const rows = perPage === 1 ? 1 : 2;
            const gap = perPage === 1 ? 0 : 6;
            const cellWidth = boxWidth / columns;
            const cellHeight = boxHeight / rows;

            for (let i = 0; i < loaded.length; i += 1) {
              reporter.throwIfCancelled();
              const { item, bitmap } = loaded[i];
              const targetWidth = fitPage ? pageWidth : cellWidth - gap;
              const targetHeight = fitPage ? pageHeight : cellHeight - gap;
              const encoded = encodeBitmap(bitmap, {
                rotation: item.rotation,
                quality: opts.value.quality,
                fit: opts.value.fit,
                aspect: fitPage ? undefined : targetWidth / targetHeight,
                maxDimension: 2800,
              });
              const embedded = await doc.embedJpg(dataUrlToBytes(encoded.dataUrl));
              const scale = Math.min(targetWidth / encoded.width, targetHeight / encoded.height);
              const drawWidth = encoded.width * scale;
              const drawHeight = encoded.height * scale;
              const cellLeft = fitPage ? 0 : marginPoints + (i % columns) * cellWidth + gap / 2;
              const cellBottom = fitPage ? 0 : marginPoints + boxHeight - (Math.floor(i / columns) + 1) * cellHeight + gap / 2;
              page.drawImage(embedded, {
                x: cellLeft + (targetWidth - drawWidth) / 2,
                y: cellBottom + (targetHeight - drawHeight) / 2,
                width: drawWidth,
                height: drawHeight,
              });
            }
          } finally {
            loaded.forEach((entry) => entry.bitmap.close?.());
          }
          reporter.report(((pageIndex + 1) / pages) * 100, `Building page ${pageIndex + 1} of ${pages}…`);
        }
        const bytes = await doc.save();
        const first = images[0];
        return {
          bytes,
          name: `${sanitizeName(baseName(first.file.name))}${images.length > 1 ? "-images" : ""}.pdf`,
          pages: doc.getPageCount(),
          images: items.length,
          paper: opts.value.size === "fit" && perPage === 1 ? "Fit to image" : effectiveSize.toUpperCase(),
        };
      });
      if (output) setResult(output);
    })();
  };

  usePrimaryShortcut(create, canRun);
  useDownloadShortcut(
    () => {
      if (!result) return;
      downloadOutput(result.bytes, result.name, "application/pdf");
    },
    Boolean(result),
  );

  const paperLabel = result?.paper ?? (opts.value.size === "fit" && perPage === 1 ? "Fit to image" : effectiveSize.toUpperCase());

  return (
    <div className="space-y-5">
      <StepHeader step={1} title="Add your images" hint={`${images.length} selected`} />
      {images.length === 0 ? (
        <FileDrop
          accept={IMAGE_ACCEPT}
          acceptLabel="JPG, PNG, WebP, GIF"
          multiple
          sample={SAMPLE.image}
          hint="Drop several files at once — the order here is the page order."
          onFiles={(picked) => {
            setImages(
              picked
                .filter(isImage)
                .map((file, index) => ({ id: `${file.name}-${file.size}-${Date.now()}-${index}`, file, rotation: 0 })),
            );
            setResult(null);
          }}
        />
      ) : (
        <div className="space-y-2">
          {images.map((item, i) => (
            <div key={item.id} className="flex items-center gap-3 rounded-xl border border-line bg-paper px-3 py-2">
              <span className="w-5 text-center text-[11px] font-semibold tabular-nums text-ink/75">{i + 1}</span>
              <div className="h-9 w-9 shrink-0 overflow-hidden rounded-lg border border-line bg-bone-deep">
                <ImageThumb file={item.file} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold leading-tight">{item.file.name}</p>
                <p className="text-[11px] text-muted">
                  {fileExt(item.file.name).toUpperCase()} · {formatBytes(item.file.size)}
                  {item.rotation ? ` · rotated ${item.rotation}°` : ""}
                </p>
              </div>
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => rotate(i)}
                  aria-label={`Rotate ${item.file.name} by 90 degrees`}
                  title="Rotate 90°"
                  className="rounded p-1.5 text-ink/75 hover:bg-ink/5"
                >
                  <RotateCw className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => move(i, i - 1)}
                  disabled={i === 0}
                  aria-label="Move image up"
                  className="rounded p-1.5 text-ink/75 hover:bg-ink/5 disabled:opacity-20"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => move(i, i + 1)}
                  disabled={i === images.length - 1}
                  aria-label="Move image down"
                  className="rounded p-1.5 text-ink/75 hover:bg-ink/5 disabled:opacity-20"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setImages(images.filter((_, idx) => idx !== i));
                    setResult(null);
                  }}
                  aria-label="Remove image"
                  className="rounded p-1.5 text-ink/75 hover:bg-clay/10 hover:text-clay-ink"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-paper px-3 py-2 text-[12px] font-medium text-ink/75 hover:border-forest/30">
            <Plus className="h-3.5 w-3.5" /> Add images
            <input
              type="file"
              accept={IMAGE_ACCEPT}
              multiple
              className="sr-only"
              onChange={(e) => {
                if (e.target.files?.length) {
                  const added = Array.from(e.target.files)
                    .filter(isImage)
                    .map((file, index) => ({ id: `${file.name}-${file.size}-${Date.now()}-${index}`, file, rotation: 0 }));
                  setImages([...images, ...added]);
                }
                e.target.value = "";
              }}
            />
          </label>
        </div>
      )}

      <div className="border-t border-line pt-4">
        <StepHeader step={2} title="Page setup" />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Page size">
            <Select value={opts.value.size} onChange={(e) => opts.set("size", e.target.value as PaperSize)}>
              <option value="a4">A4</option>
              <option value="letter">US Letter</option>
              <option value="legal">US Legal</option>
              <option value="a5">A5</option>
              <option value="fit" disabled={perPage > 1}>
                Fit to image
              </option>
            </Select>
          </Field>
          <Field label="Orientation">
            <Select
              value={opts.value.orientation}
              onChange={(e) => opts.set("orientation", e.target.value as "auto" | "portrait" | "landscape")}
              disabled={opts.value.size === "fit" && perPage === 1}
            >
              <option value="auto">Auto / match image</option>
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
            </Select>
          </Field>
          <Field
            label="Margin"
            hint={
              opts.value.size === "fit" && perPage === 1
                ? "No margin in fit mode"
                : perPage > 1
                  ? `${opts.value.margin} mm · a small gap separates the images`
                  : `${opts.value.margin} mm`
            }
          >
            <input
              type="range"
              min={0}
              max={40}
              value={opts.value.margin}
              disabled={opts.value.size === "fit" && perPage === 1}
              aria-label="Page margin in millimetres"
              onChange={(e) => opts.set("margin", Number(e.target.value))}
              className="mt-3 w-full accent-[#1c4c3b]"
            />
          </Field>
        </div>
        <p className="mt-2 text-[11.5px] text-muted">
          {opts.value.size === "fit" && perPage === 1
            ? "Each page takes the exact proportions of its image."
            : "Images are re-encoded as JPEG first, so transparency becomes white and every viewer sees the same result."}
        </p>
      </div>

      <AdvancedOptions scope="jpg-to-pdf" badge="3 controls" description="Fit, quality, images per page" onReset={opts.reset}>
        <OptionsGrid>
          <div>
            <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink/70">Fit mode</p>
            <Segmented<FitMode>
              value={opts.value.fit}
              onChange={(value) => opts.set("fit", value)}
              size="sm"
              options={[
                { value: "contain", label: "Contain" },
                { value: "cover", label: "Cover" },
              ]}
            />
            <p className="mt-1.5 text-[11.5px] text-muted">
              {opts.value.fit === "contain"
                ? "The whole image is visible, with white space around it."
                : "The image fills the page and the overflow is trimmed evenly."}
            </p>
          </div>
          <Field label="Images per page">
            <Select
              value={opts.value.perPage}
              onChange={(e) => {
                const next = e.target.value as ImagesPerPage;
                opts.set("perPage", next);
                // "Fit to image" only makes sense with one image per page.
                if (next !== "one" && opts.value.size === "fit") opts.set("size", "a4");
              }}
            >
              {(Object.keys(PER_PAGE_LABEL) as ImagesPerPage[]).map((key) => (
                <option key={key} value={key}>
                  {PER_PAGE_LABEL[key]}
                </option>
              ))}
            </Select>
          </Field>
          <SliderField
            label="JPEG quality"
            value={opts.value.quality}
            onChange={(value) => opts.set("quality", value)}
            min={50}
            max={100}
            step={5}
            format={(value) => `${value}%`}
            hint="90% is visually lossless for scans; lower saves size."
          />
        </OptionsGrid>
        <div className="mt-3">
          <OptionNote>
            {images.length
              ? `${pageCount} page${pageCount === 1 ? "" : "s"} will be produced from ${images.length} image${
                  images.length === 1 ? "" : "s"
                }.`
              : "Add images above to see how many pages they will fill."}
          </OptionNote>
        </div>
      </AdvancedOptions>

      {job.failed && <Alert tone="error">{job.error}</Alert>}
      {job.status === "cancelled" && <Alert tone="info">Cancelled — nothing was downloaded. Your previous result is unchanged.</Alert>}
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Button onClick={create} loading={job.busy} disabled={!canRun}>
          <Images className="h-4 w-4" /> Create PDF
        </Button>
        {job.busy && (
          <Button variant="ghost" onClick={job.cancel}>
            Cancel
          </Button>
        )}
        <span className="text-[11.5px] text-muted">
          {images.length ? `${images.length} images · ${pageCount} page${pageCount === 1 ? "" : "s"} · ${paperLabel}` : "No images yet"}
        </span>
      </div>
      {job.busy && (
        <Progress value={job.percent ?? undefined} label={job.label} detail={describeJobTime(job)} etaMs={job.etaMs} />
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Your image PDF is ready"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          mime="application/pdf"
          onDownload={() => downloadOutput(result.bytes, result.name, "application/pdf")}
          description={`${result.pages} page${result.pages === 1 ? "" : "s"} · ${result.images} image${
            result.images === 1 ? "" : "s"
          } · ${result.paper} · ${PER_PAGE_LABEL[opts.value.perPage].toLowerCase()}`}
          facts={[
            { label: "Paper", value: result.paper },
            { label: "Fit", value: opts.value.fit === "cover" ? "Cover" : "Contain" },
            { label: "Quality", value: `${opts.value.quality}%` },
          ]}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * PDF → JPG
 * ================================================================== */
type ImageFormat = "jpg" | "png" | "webp";
type ImageBackground = "white" | "gray" | "transparent";

const FORMAT_MIME: Record<ImageFormat, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };
const DPI_OPTIONS = [72, 96, 150, 200, 300, 600];
const FORMAT_LABEL: Record<ImageFormat, string> = { jpg: "jpg", png: "png", webp: "webp" };
const BACKGROUND_VALUE: Record<ImageBackground, string> = { white: "#ffffff", gray: "#eceae2", transparent: "#ffffff" };

interface ImageResult {
  name: string;
  dataUrl: string;
  bytes: number;
  page: number;
  width: number;
  height: number;
  mime: string;
}

function webpSupported(): boolean {
  try {
    return document.createElement("canvas").toDataURL("image/webp").startsWith("data:image/webp");
  } catch {
    return false;
  }
}

interface RenderOptions {
  scale: number;
  format: ImageFormat;
  quality: number;
  background: ImageBackground;
}

async function renderPageImage(doc: PDFDocumentProxy, pageNumber: number, options: RenderOptions): Promise<ImageResult> {
  const page = await doc.getPage(pageNumber);
  try {
    const base = page.getViewport({ scale: 1 });
    let scale = Math.max(0.1, options.scale);
    if (base.width * scale * base.height * scale > MAX_CANVAS_PIXELS_PUBLIC) {
      scale = Math.sqrt(MAX_CANVAS_PIXELS_PUBLIC / (base.width * base.height));
    }
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const transparent = options.background === "transparent" && options.format === "png";
    const context = canvas.getContext("2d", { alpha: transparent });
    if (!context) throw new Error("Your browser can’t render PDF pages (canvas unavailable).");
    if (!transparent) {
      context.fillStyle = BACKGROUND_VALUE[options.background];
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    await page.render({ canvasContext: context, viewport, canvas } as never).promise;
    const dataUrl = canvas.toDataURL(FORMAT_MIME[options.format], Math.min(1, Math.max(0.2, options.quality / 100)));
    const mime = dataUrl.slice(5, dataUrl.indexOf(";")) || FORMAT_MIME[options.format];
    const result = {
      name: "",
      dataUrl,
      bytes: dataUrlToBytes(dataUrl).byteLength,
      page: pageNumber,
      width: canvas.width,
      height: canvas.height,
      mime,
    };
    canvas.width = 1;
    canvas.height = 1;
    return result;
  } finally {
    page.cleanup();
  }
}

export function PdfToJpgTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const opts = useToolPreferences("pdf-to-jpg", {
    format: "jpg" as ImageFormat,
    dpi: 150,
    quality: 85,
    background: "white" as ImageBackground,
  });
  const [range, setRange] = useState("");
  const [result, setResult] = useState<ImageResult[] | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const job = useJob<ImageResult[]>();
  const canRun = Boolean(pdf.bytes && pdf.file) && !job.busy;
  const dpi = opts.value.dpi;

  const run = () => {
    if (!pdf.bytes || !pdf.file) return;
    const bytes = pdf.bytes;
    const sourceName = pdf.file.name;
    const total = pdf.pageCount;
    const format = opts.value.format;
    const background = opts.value.background;
    const quality = opts.value.quality;
    void (async () => {
      const output = await job.run(async (reporter) => {
        if (format === "webp" && !webpSupported()) {
          throw new Error("This browser can’t write WebP images. Choose JPG or PNG instead — the pages are unchanged.");
        }
        const pages = parsePageQuery(range, total);
        if (pages.length > 250) throw new Error("This tool handles up to 250 pages at a time. Split the PDF first for larger jobs.");
        reporter.report(2, "Opening the document…", describePageQuery(pages, total));
        const doc = await openPdfJs(bytes);
        try {
          const base = sanitizeName(baseName(sourceName));
          const items: ImageResult[] = [];
          for (let i = 0; i < pages.length; i += 1) {
            reporter.throwIfCancelled();
            const rendered = await renderPageImage(doc, pages[i], {
              scale: Math.max(0.5, dpi) / 72,
              format,
              quality,
              background,
            });
            items.push({
              name: `${base}-page-${String(pages[i]).padStart(2, "0")}.${FORMAT_LABEL[format]}`,
              dataUrl: rendered.dataUrl,
              bytes: rendered.bytes,
              page: pages[i],
              width: rendered.width,
              height: rendered.height,
              mime: rendered.mime,
            });
            if (i === 0) setPreview(rendered.dataUrl);
            reporter.report(2 + ((i + 1) / pages.length) * 96, `Rendering page ${i + 1} of ${pages.length}…`, `page ${pages[i]}`);
          }
          reporter.report(100, "Done");
          return items;
        } finally {
          await doc.destroy();
        }
      });
      if (output) {
        setResult(output);
        setPreview(output[0]?.dataUrl ?? null);
      }
    })();
  };

  const downloadOne = (item: ImageResult) => downloadUrl(item.dataUrl, item.name);
  const downloadZip = (items: ImageResult[]) =>
    void zipAndDownload(
      items.map((item) => ({ name: item.name, data: dataUrlToBytes(item.dataUrl) })),
      `${sanitizeName(baseName(pdf.file?.name ?? "document"))}-${FORMAT_LABEL[opts.value.format]}.zip`,
    );

  usePrimaryShortcut(run, canRun);
  useDownloadShortcut(
    () => {
      if (!result?.length) return;
      if (result.length === 1) downloadOne(result[0]);
      else downloadZip(result);
    },
    Boolean(result?.length),
  );

  const totalBytes = result?.reduce((sum, item) => sum + item.bytes, 0) ?? 0;
  const single = result?.length === 1 ? result[0] : null;

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to export" />
      {pdf.bytes && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Format">
              <Segmented<ImageFormat>
                value={opts.value.format}
                onChange={(value) => {
                  opts.set("format", value);
                  if (value !== "png" && opts.value.background === "transparent") opts.set("background", "white");
                }}
                size="sm"
                options={[
                  { value: "jpg", label: "JPG" },
                  { value: "png", label: "PNG" },
                  { value: "webp", label: "WebP" },
                ]}
              />
            </Field>
            <Field label="Resolution" hint={`${dpi} DPI`}>
              <Select value={dpi} onChange={(e) => opts.set("dpi", Number(e.target.value))}>
                {DPI_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value === 96
                      ? "Web · 96 DPI"
                      : value === 150
                        ? "Standard · 150 DPI"
                        : value === 300
                          ? "Print · 300 DPI"
                          : value === 72
                            ? "Screen · 72 DPI"
                            : `${value} DPI`}
                  </option>
                ))}
                {!DPI_OPTIONS.includes(dpi) && <option value={dpi}>{dpi} DPI (custom)</option>}
              </Select>
            </Field>
            <Field label="Output quality" hint={opts.value.format === "png" ? "PNG is lossless" : `${opts.value.quality}%`}>
              <input
                type="range"
                min={50}
                max={100}
                step={5}
                value={opts.value.quality}
                disabled={opts.value.format === "png"}
                aria-label="Output quality"
                onChange={(e) => opts.set("quality", Number(e.target.value))}
                className="mt-3 w-full accent-[#1c4c3b] disabled:opacity-40"
              />
            </Field>
          </div>
          <RangeField
            value={range}
            onChange={setRange}
            total={pdf.pageCount}
            label="Pages to export"
            hint="Leave empty for every page. Exporting many high-DPI pages uses more memory."
          />
          <AdvancedOptions scope="pdf-to-jpg" badge="3 controls" description="Background, exact DPI, presets" onReset={opts.reset}>
            <OptionsGrid>
              <Field label="Background" hint={opts.value.format === "png" ? "Transparent is only available for PNG." : "JPG has no transparency, so the page is rendered flat."}>
                <Select value={opts.value.background} onChange={(e) => opts.set("background", e.target.value as ImageBackground)}>
                  <option value="white">White</option>
                  <option value="gray">Soft grey</option>
                  <option value="transparent" disabled={opts.value.format !== "png"}>
                    Transparent (PNG only)
                  </option>
                </Select>
              </Field>
              <NumberField
                label="Exact resolution"
                value={dpi}
                onChange={(value) => opts.set("dpi", value)}
                min={72}
                max={600}
                step={1}
                suffix="DPI"
                hint="72 DPI matches screen size. 300 DPI is print quality."
              />
              <div className="sm:col-span-2">
                <PresetChips
                  label="Resolution preset"
                  value={String(dpi)}
                  presets={[
                    { id: "96", label: "Web", description: "96 DPI — small files for screens" },
                    { id: "150", label: "Standard", description: "150 DPI — everyday sharing" },
                    { id: "300", label: "Print", description: "300 DPI — sharp on paper" },
                  ]}
                  onSelect={(preset) => opts.set("dpi", Number(preset.id))}
                />
              </div>
            </OptionsGrid>
            <div className="mt-3">
              <OptionNote>
                Pages are rendered in this tab at the resolution you pick. Higher DPI means sharper images and bigger files.
              </OptionNote>
            </div>
          </AdvancedOptions>
          {job.failed && <Alert tone="error">{job.error}</Alert>}
          {job.status === "cancelled" && <Alert tone="info">Cancelled — nothing was downloaded. Your previous result is unchanged.</Alert>}
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={run} loading={job.busy} disabled={!canRun}>
              <FileImage className="h-4 w-4" /> Convert to {opts.value.format === "png" ? "PNG" : opts.value.format === "webp" ? "WebP" : "JPG"}
            </Button>
            {job.busy && (
              <Button variant="ghost" onClick={job.cancel}>
                Cancel
              </Button>
            )}
            <span className="text-[11.5px] text-muted">
              {pdf.pageCount} page{pdf.pageCount === 1 ? "" : "s"} · rendered in your browser
            </span>
          </div>
          {job.busy && (
            <Progress value={job.percent ?? undefined} label={job.label} detail={describeJobTime(job)} etaMs={job.etaMs} />
          )}
        </>
      )}

      {single && (
        <DownloadPanel
          bytes={dataUrlToBytes(single.dataUrl)}
          title="1 image ready"
          filename={single.name}
          size={single.bytes}
          pages={1}
          mime={single.mime}
          onDownload={() => downloadOne(single)}
          description={`${single.width} × ${single.height} px · ${dpi} DPI · page ${single.page}`}
          facts={[
            { label: "Format", value: FORMAT_LABEL[opts.value.format].toUpperCase() },
            { label: "Background", value: opts.value.background },
          ]}
        />
      )}

      {result && result.length > 1 && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-forest/15 bg-forest p-5 text-paper">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-[17px] font-semibold">{result.length} images ready</h3>
                <p className="mt-0.5 text-[12.5px] text-paper/70">
                  {formatBytes(totalBytes)} total · {dpi} DPI · {FORMAT_LABEL[opts.value.format].toUpperCase()} ·{" "}
                  {result[0].width} × {result[0].height} px
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="accent" onClick={() => downloadZip(result)}>
                  <DownloadCloud className="h-4 w-4" /> Download ZIP
                </Button>
              </div>
            </div>
          </div>

          {preview && (
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <div className="checker flex max-h-[420px] items-center justify-center overflow-hidden rounded-xl border border-line p-4">
                <img src={preview} alt="Exported preview" className="max-h-[380px] w-auto max-w-full object-contain pdf-page-shadow" loading="lazy" decoding="async" />
              </div>
              <div className="flex gap-2 overflow-x-auto sm:w-[220px] sm:flex-wrap sm:content-start sm:overflow-hidden">
                {result.slice(0, 12).map((item) => (
                  <button
                    key={item.name}
                    type="button"
                    onClick={() => setPreview(item.dataUrl)}
                    title={`Preview ${item.name}`}
                    onDoubleClick={() => downloadOne(item)}
                    className={cn(
                      "group relative h-24 w-[72px] shrink-0 overflow-hidden rounded-lg border bg-white",
                      preview === item.dataUrl ? "border-forest ring-2 ring-forest/20" : "border-line hover:border-forest/40",
                    )}
                  >
                    <img src={item.dataUrl} alt={`Page ${item.page}`} className="h-full w-full object-cover object-top" loading="lazy" decoding="async" />
                    <span className="absolute inset-x-0 bottom-0 bg-ink/65 py-0.5 text-center text-[9px] font-medium text-paper">
                      p.{item.page}
                    </span>
                  </button>
                ))}
                {result.length > 12 && (
                  <div className="flex h-24 w-[72px] shrink-0 items-center justify-center rounded-lg border border-dashed border-line text-[10px] text-muted">
                    +{result.length - 12}
                    <br />more
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => downloadOne(result[0])}>
              <Download className="h-3.5 w-3.5" /> First image only
            </Button>
            <span className="text-[11.5px] text-muted">Double-click a thumbnail to download that page.</span>
          </div>
        </div>
      )}

      {!pdf.bytes && (
        <EmptyHint>Your images will appear here as previews. Add a PDF above to begin — nothing is uploaded.</EmptyHint>
      )}
    </div>
  );
}
