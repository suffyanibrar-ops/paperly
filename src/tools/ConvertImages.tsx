import { ArrowDown, ArrowUp, Download, FileImage, Images, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  PDFDocument,
  baseName,
  dataUrlToBytes,
  downloadBytes,
  downloadUrl,
  fileExt,
  formatBytes,
  imageToJpegDataUrl,
  openPdfJs,
  parseRanges,
  renderPdfPage,
  sanitizeName,
  uniqueInOrder,
  zipAndDownload,
} from "@/lib/pdf";
import { useInitialFiles, usePdfFile } from "@/lib/usePdf";
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
type PaperSize = "fit" | "a4" | "letter";
const PAPER: Record<Exclude<PaperSize, "fit">, [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

export function JpgToPdfTool() {
  const initial = useInitialFiles().filter(isImage);
  const [images, setImages] = useState<File[]>(initial);
  const [size, setSize] = useState<PaperSize>("a4");
  const [orientation, setOrientation] = useState<"auto" | "portrait" | "landscape">("auto");
  const [margin, setMargin] = useState(10);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string } | null>(null);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= images.length) return;
    const next = [...images];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setImages(next);
    setResult(null);
  };

  const create = async () => {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      if (!images.length) throw new Error("Add at least one image.");
      const doc = await PDFDocument.create();
      for (let i = 0; i < images.length; i++) {
        const file = images[i];
        const jpeg = await imageToJpegDataUrl(file, 3200, 0.9);
        const embedded = await doc.embedJpg(dataUrlToBytes(jpeg.dataUrl));
        const marginPt = margin * 2.834645669;
        if (size === "fit") {
          const page = doc.addPage([jpeg.width * 0.75, jpeg.height * 0.75]);
          page.drawImage(embedded, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
        } else {
          const [baseW, baseH] = PAPER[size];
          const horizontal = orientation === "auto" ? jpeg.width >= jpeg.height : orientation === "landscape";
          const [pw, ph] = horizontal ? [baseH, baseW] : [baseW, baseH];
          const page = doc.addPage([pw, ph]);
          const boxW = pw - marginPt * 2;
          const boxH = ph - marginPt * 2;
          const scale = Math.min(boxW / jpeg.width, boxH / jpeg.height);
          const w = jpeg.width * scale;
          const h = jpeg.height * scale;
          page.drawImage(embedded, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
        }
        setProgress(((i + 1) / images.length) * 100);
      }
      const bytes = await doc.save();
      setResult({ bytes, name: `${sanitizeName(baseName(images[0].name))}${images.length > 1 ? "-images" : ""}.pdf` });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <StepHeader step={1} title="Add your images" hint={`${images.length} selected`} />
      {images.length === 0 ? (
        <FileDrop
          accept={IMAGE_ACCEPT}
          acceptLabel="JPG, PNG, WebP, GIF"
          multiple
          onFiles={(picked) => {
            setImages(picked.filter(isImage));
            setResult(null);
          }}
        />
      ) : (
        <div className="space-y-2">
          {images.map((file, i) => (
            <div key={`${file.name}-${file.size}-${i}`} className="flex items-center gap-3 rounded-xl border border-line bg-paper px-3 py-2">
              <span className="w-5 text-center text-[11px] font-semibold tabular-nums text-ink/75">{i + 1}</span>
              <div className="h-9 w-9 shrink-0 overflow-hidden rounded-lg border border-line bg-bone-deep">
                <ImageThumb file={file} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold leading-tight">{file.name}</p>
                <p className="text-[11px] text-muted">
                  {fileExt(file.name).toUpperCase()} · {formatBytes(file.size)}
                </p>
              </div>
              <div className="flex items-center gap-0.5">
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
                if (e.target.files?.length) setImages([...images, ...Array.from(e.target.files).filter(isImage)]);
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
            <Select value={size} onChange={(e) => setSize(e.target.value as PaperSize)}>
              <option value="a4">A4</option>
              <option value="letter">US Letter</option>
              <option value="fit">Fit to image</option>
            </Select>
          </Field>
          <Field label="Orientation">
            <Select value={orientation} onChange={(e) => setOrientation(e.target.value as typeof orientation)} disabled={size === "fit"}>
              <option value="auto">Auto / match image</option>
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
            </Select>
          </Field>
          <Field label="Margin" hint={size === "fit" ? "No margin in fit mode" : `${margin} mm`}>
            <input
              type="range"
              min={0}
              max={40}
              value={margin}
              disabled={size === "fit"}
              aria-label="Page margin in millimetres"
              onChange={(e) => setMargin(Number(e.target.value))}
              className="mt-3 w-full accent-[#1c4c3b]"
            />
          </Field>
        </div>
        <p className="mt-2 text-[11.5px] text-muted">
          Images are converted to high-quality JPEG first, so transparency becomes white and every viewer sees the same result.
        </p>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex items-center gap-2 border-t border-line pt-4">
        <Button onClick={create} loading={busy} disabled={!images.length}>
          <Images className="h-4 w-4" /> Create PDF
        </Button>
        <span className="text-[11.5px] text-muted">{images.length ? `${images.length} images · original order` : "No images yet"}</span>
      </div>
      {busy && <Progress value={progress} label="Building your PDF locally…" />}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Your image PDF is ready"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={images.length}
          onDownload={() => downloadBytes(result.bytes, result.name)}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * PDF → JPG
 * ================================================================== */
interface ImageResult {
  name: string;
  dataUrl: string;
  bytes: number;
  page: number;
  width: number;
  height: number;
}

export function PdfToJpgTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [format, setFormat] = useState<"image/jpeg" | "image/png">("image/jpeg");
  const [dpi, setDpi] = useState<96 | 150 | 300>(150);
  const [quality, setQuality] = useState(85);
  const [range, setRange] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ImageResult[] | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const run = async () => {
    if (!pdf.bytes || !pdf.file) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const pages = uniqueInOrder(parseRanges(range, pdf.pageCount));
      if (pages.length > 250) throw new Error("This tool handles up to 250 pages at a time. Split the PDF first for larger jobs.");
      const doc = await openPdfJs(pdf.bytes);
      const base = sanitizeName(baseName(pdf.file.name));
      const items: ImageResult[] = [];
      for (let i = 0; i < pages.length; i++) {
        const rendered = await renderPdfPage(doc, pages[i], {
          scale: dpi / 72,
          type: format,
          quality: quality / 100,
        });
        const ext = format === "image/png" ? "png" : "jpg";
        items.push({
          name: `${base}-page-${String(pages[i]).padStart(2, "0")}.${ext}`,
          dataUrl: rendered.dataUrl,
          bytes: dataUrlToBytes(rendered.dataUrl).byteLength,
          page: pages[i],
          width: rendered.width,
          height: rendered.height,
        });
        setProgress(((i + 1) / pages.length) * 100);
        if (i === 0) setResult([...items]);
      }
      await doc.destroy();
      setResult(items);
      setPreview(items[0]?.dataUrl ?? null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const total = result?.reduce((sum, r) => sum + r.bytes, 0) ?? 0;

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to export" />
      {pdf.bytes && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Format">
              <Segmented
                value={format}
                onChange={(v) => setFormat(v)}
                size="sm"
                options={[
                  { value: "image/jpeg", label: "JPG" },
                  { value: "image/png", label: "PNG" },
                ]}
              />
            </Field>
            <Field label="Resolution" hint={`≈ ${dpi} DPI`}>
              <Select value={dpi} onChange={(e) => setDpi(Number(e.target.value) as 96 | 150 | 300)}>
                <option value={96}>Web · 96 DPI</option>
                <option value={150}>Standard · 150 DPI</option>
                <option value={300}>Print · 300 DPI</option>
              </Select>
            </Field>
            <Field label="JPG quality" hint={format === "image/png" ? "PNG is lossless" : `${quality}%`}>
              <input
                type="range"
                min={50}
                max={100}
                step={5}
                value={quality}
                disabled={format === "image/png"}
                onChange={(e) => setQuality(Number(e.target.value))}
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
          {error && <Alert tone="error">{error}</Alert>}
          <div className="flex items-center gap-2 border-t border-line pt-4">
            <Button onClick={run} loading={busy}>
              <FileImage className="h-4 w-4" /> Convert to {format === "image/png" ? "PNG" : "JPG"}
            </Button>
            <span className="text-[11.5px] text-muted">
              {pdf.pageCount} page{pdf.pageCount === 1 ? "" : "s"} · rendered in your browser
            </span>
          </div>
          {busy && <Progress value={progress} label="Rendering page images…" />}
        </>
      )}

      {result && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-forest/15 bg-forest p-5 text-paper">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-[17px] font-semibold">
                  {result.length} image{result.length === 1 ? "" : "s"} ready
                </h3>
                <p className="mt-0.5 text-[12.5px] text-paper/70">
                  {formatBytes(total)} total · {dpi} DPI · {format === "image/png" ? "lossless PNG" : "high-quality JPG"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {result.length === 1 ? (
                  <Button variant="accent" onClick={() => downloadUrl(result[0].dataUrl, result[0].name)}>
                    <Download className="h-4 w-4" /> Download image
                  </Button>
                ) : (
                  <Button
                    variant="accent"
                    onClick={() =>
                      void zipAndDownload(
                        result.map((r) => ({ name: r.name, data: dataUrlToBytes(r.dataUrl) })),
                        `${sanitizeName(baseName(pdf.file?.name ?? "document"))}-${format === "image/png" ? "png" : "jpg"}.zip`,
                      )
                    }
                  >
                    <Download className="h-4 w-4" /> Download ZIP
                  </Button>
                )}
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
                    title={`Download ${item.name}`}
                    onDoubleClick={() => downloadUrl(item.dataUrl, item.name)}
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
          <p className="text-[11.5px] text-muted">Tip: double-click a thumbnail to download that page.</p>
        </div>
      )}

      {!pdf.bytes && (
        <EmptyHint>Your JPGs will appear here as previews. Add a PDF above to begin — nothing is uploaded.</EmptyHint>
      )}
    </div>
  );
}
