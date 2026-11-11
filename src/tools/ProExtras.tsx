import { Check, Copy, Download, FileImage, FileOutput, Images, Quote, ScanText, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
  zipAndDownload,
} from "@/lib/pdf";
import { extractDocument } from "@/lib/extract";
import { useInitialFiles, usePdfFile, usePdfThumbs } from "@/lib/usePdf";
import { copyText } from "@/lib/router";
import {
  Alert,
  Badge,
  Button,
  Field,
  Progress,
  Segmented,
  Select,
  Switch,
} from "@/components/ui";
import { DownloadPanel, RangeField, SinglePdfInput } from "@/components/toolParts";
import { renderMarkdownToPdf } from "@/tools/MarkdownTools";
import { cn } from "@/utils/cn";

/* ================================================================== *
 * REMOVE PAGES
 * ================================================================== */
export function RemovePagesTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const { thumbs } = usePdfThumbs(pdf.bytes, { width: 130, quality: 0.65, max: 200 });
  const [range, setRange] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; kept: number; removed: number } | null>(null);

  const removeSet = useMemo(() => {
    if (!pdf.pageCount) return new Set<number>();
    try {
      return new Set(parseRanges(range, pdf.pageCount));
    } catch {
      return new Set<number>();
    }
  }, [range, pdf.pageCount]);

  const togglePage = (page: number) => {
    const next = new Set(removeSet);
    if (next.has(page)) next.delete(page);
    else next.add(page);
    setRange([...next].sort((a, b) => a - b).join(","));
    setResult(null);
  };

  const apply = async () => {
    if (!pdf.bytes || !pdf.file) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const remove = uniqueInOrder(parseRanges(range, pdf.pageCount));
      if (remove.length >= pdf.pageCount) throw new Error("You can’t remove every page. Leave at least one.");
      const src = await openPdfLib(pdf.bytes);
      const out = await PDFDocument.create();
      const keep = src.getPageIndices().filter((index) => !remove.includes(index + 1));
      const copied = await out.copyPages(src, keep);
      copied.forEach((page) => out.addPage(page));
      const bytes = await out.save();
      setResult({
        bytes,
        name: `${sanitizeName(baseName(pdf.file.name))}-removed.pdf`,
        kept: keep.length,
        removed: remove.length,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF with pages to remove" />
      {pdf.bytes && (
        <>
          <RangeField
            value={range}
            onChange={(v) => { setRange(v); setResult(null); }}
            total={pdf.pageCount}
            label="Pages to remove"
            hint="Read only the pages you want gone — everything else is kept. You can also click thumbnails below."
            showAll={false}
          />
          {pdf.pageCount <= 120 && (
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
              {Array.from({ length: pdf.pageCount }, (_, index) => index + 1).map((page) => {
                const thumb = thumbs.find((t) => t.page === page);
                const selected = removeSet.has(page);
                return (
                  <button
                    key={page}
                    type="button"
                    onClick={() => togglePage(page)}
                    aria-pressed={selected}
                    aria-label={`${selected ? "Keep" : "Remove"} page ${page}`}
                    className={cn(
                      "group relative overflow-hidden rounded-lg border text-left transition-all",
                      selected ? "border-clay bg-clay/10 ring-2 ring-clay/25" : "border-line bg-white hover:border-forest/40",
                    )}
                  >
                    <div className="checker flex aspect-[3/4] items-center justify-center p-1">
                      {thumb ? (
                        <img src={thumb.dataUrl} alt={`Page ${page}`} className="max-h-full max-w-full border border-ink/5 bg-white" loading="lazy" decoding="async" />
                      ) : (
                        <span className="text-[10px] text-ink/70">{page}</span>
                      )}
                    </div>
                    <div className="flex items-center justify-between border-t border-line px-1.5 py-1">
                      <span className="text-[10px] font-semibold tabular-nums text-ink/70">p.{page}</span>
                      <span className={cn("flex h-3.5 w-3.5 items-center justify-center rounded-full border", selected ? "border-clay bg-clay text-white" : "border-ink/20")}>
                        {selected && <Trash2 className="h-2 w-2" />}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-bone-deep/35 px-3.5 py-2.5 text-[11.5px]">
            <span className="font-semibold text-clay-ink">{removeSet.size} page{removeSet.size === 1 ? "" : "s"} selected for removal</span>
            <span className="text-muted">{pdf.pageCount - removeSet.size} page{pdf.pageCount - removeSet.size === 1 ? "" : "s"} will remain</span>
          </div>
          {error && <Alert tone="error">{error}</Alert>}
          <div className="flex items-center gap-2 border-t border-line pt-4">
            <Button onClick={apply} loading={busy} disabled={!removeSet.size}>
              <Trash2 className="h-4 w-4" /> Remove {removeSet.size || ""} page{removeSet.size === 1 ? "" : "s"}
            </Button>
            <Button variant="ghost" onClick={() => setRange("")}>Clear selection</Button>
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
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * EXTRACT PAGES
 * ================================================================== */
export function ExtractPagesTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [range, setRange] = useState("");
  const [separate, setSeparate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<
    | { kind: "pdf"; bytes: Uint8Array; name: string; pages: number }
    | { kind: "zip"; entries: { name: string; bytes: Uint8Array }[]; name: string; pages: number }
    | null
  >(null);

  const apply = async () => {
    if (!pdf.bytes || !pdf.file) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const pages = uniqueInOrder(parseRanges(range, pdf.pageCount));
      const src = await openPdfLib(pdf.bytes);
      const base = sanitizeName(baseName(pdf.file.name));
      if (separate) {
        const entries: { name: string; bytes: Uint8Array }[] = [];
        for (const page of pages) {
          const out = await PDFDocument.create();
          const [copied] = await out.copyPages(src, [page - 1]);
          out.addPage(copied);
          entries.push({ name: `${base}-page-${String(page).padStart(2, "0")}.pdf`, bytes: await out.save() });
        }
        setResult({ kind: "zip", entries, name: `${base}-pages.zip`, pages: pages.length });
      } else {
        const out = await PDFDocument.create();
        const copied = await out.copyPages(src, pages.map((p) => p - 1));
        copied.forEach((page) => out.addPage(page));
        setResult({ kind: "pdf", bytes: await out.save(), name: `${base}-extracted.pdf`, pages: pages.length });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to extract pages from" />
      {pdf.bytes && (
        <>
          <RangeField value={range} onChange={setRange} total={pdf.pageCount} label="Pages to extract" hint="Example: 1-3, 7, 10-12. Leave empty for all pages." />
          <div className="flex flex-wrap gap-1.5">
            {[
              { label: "All pages", value: "" },
              { label: "Odd pages", value: Array.from({ length: pdf.pageCount }, (_, i) => i + 1).filter((n) => n % 2).join(",") },
              { label: "Even pages", value: Array.from({ length: pdf.pageCount }, (_, i) => i + 1).filter((n) => n % 2 === 0).join(",") },
              { label: "First half", value: `1-${Math.ceil(pdf.pageCount / 2)}` },
              { label: "Second half", value: `${Math.ceil(pdf.pageCount / 2) + 1}-${pdf.pageCount}` },
            ].map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => setRange(preset.value)}
                className="rounded-full border border-line bg-paper px-3 py-1.5 text-[11.5px] font-medium text-ink/70 hover:border-forest/30 hover:text-forest"
              >
                {preset.label}
              </button>
            ))}
          </div>
          <Switch checked={separate} onChange={setSeparate} label="One PDF per page" description="Packages each extracted page as its own PDF in a ZIP" />
          {error && <Alert tone="error">{error}</Alert>}
          <div className="border-t border-line pt-4">
            <Button onClick={apply} loading={busy}>
              <FileOutput className="h-4 w-4" /> Extract pages
            </Button>
          </div>
        </>
      )}
      {result && (
        <DownloadPanel
          title={result.kind === "zip" ? `${result.entries.length} single-page PDFs ready` : "Pages extracted"}
          filename={result.name}
          size={result.kind === "zip" ? result.entries.reduce((sum, entry) => sum + entry.bytes.byteLength, 0) : result.bytes.byteLength}
          pages={result.pages}
          onDownload={() => {
            if (result.kind === "pdf") downloadBytes(result.bytes, result.name);
            else void zipAndDownload(result.entries.map((entry) => ({ name: entry.name, data: entry.bytes })), result.name);
          }}
          bytes={result.kind === "pdf" ? result.bytes : undefined}
          description={`${result.pages} page${result.pages === 1 ? "" : "s"} copied with original text, links and quality`}
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function bytesToPreview(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
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
  for (let i = 0, p = 0; i < width * height; i++, p += components) {
    let r: number;
    let g: number;
    let b: number;
    if (components === 1) {
      r = g = b = decoded[p];
    } else if (components === 4) {
      const c = decoded[p] / 255;
      const m = decoded[p + 1] / 255;
      const y = decoded[p + 2] / 255;
      const k = decoded[p + 3] / 255;
      r = 255 * (1 - c) * (1 - k);
      g = 255 * (1 - m) * (1 - k);
      b = 255 * (1 - y) * (1 - k);
    } else {
      r = decoded[p];
      g = decoded[p + 1];
      b = decoded[p + 2];
    }
    const o = i * 4;
    imageData.data[o] = r;
    imageData.data[o + 1] = g;
    imageData.data[o + 2] = b;
    imageData.data[o + 3] = alpha ? alpha[i] : 255;
  }
  ctx.putImageData(imageData, 0, 0);
  const dataUrl = canvas.toDataURL("image/png");
  return dataUrlToBytes(dataUrl);
}

export function ExtractImagesTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [minSize, setMinSize] = useState(96);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
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
  }, [pdf.bytes]);

  const scan = async () => {
    if (!pdf.bytes || !pdf.file) return;
    setBusy(true);
    setError("");
    setWarning("");
    setImages(null);
    setPreview(null);
    try {
      const doc = await openPdfLib(pdf.bytes);
      const context = doc.context;
      const pages = doc.getPages();
      const seen = new Set<string>();
      const output: ExtractedImage[] = [];
      const skipped: string[] = [];
      let counter = 0;

      for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
        const resources = pages[pageIndex].node.Resources();
        const xObjects = resources?.lookup(PDFName.of("XObject"));
        if (xObjects instanceof PDFDict) {
          for (const [resourceName, ref] of xObjects.entries()) {
            if (!(ref instanceof Object) || !("objectNumber" in (ref as object))) continue;
            const key = ref.toString();
            if (seen.has(key)) continue;
            seen.add(key);
            const stream = context.lookup(ref as PDFRef);
            if (!(stream instanceof PDFRawStream)) continue;
            const dict = stream.dict;
            const subtype = dict.lookup(PDFName.of("Subtype"));
            if (!(subtype instanceof PDFName) || subtype.asString() !== "/Image") continue;
            const width = dict.lookup(PDFName.of("Width"), PDFNumber)?.asNumber() ?? 0;
            const height = dict.lookup(PDFName.of("Height"), PDFNumber)?.asNumber() ?? 0;
            if (width < minSize || height < minSize) continue;
            if (width * height > 40_000_000) {
              skipped.push(`${resourceName.asString().replace("/", "")} on page ${pageIndex + 1} (too large)`);
              continue;
            }
            const filter = streamFilter(dict);
            counter += 1;
            const label = `${sanitizeName(baseName(pdf.file.name))}-p${pageIndex + 1}-${String(counter).padStart(2, "0")}`;
            if (filter === "/DCTDecode") {
              const bytes = stream.getContents();
              const previewUrl = bytes.length < 8_000_000 ? bytesToPreview(bytes, "image/jpeg") : null;
              output.push({ id: key, page: pageIndex + 1, width, height, bytes, size: bytes.byteLength, extension: "jpg", preview: previewUrl, name: `${label}.jpg` });
            } else if (filter === "/JPXDecode") {
              const bytes = stream.getContents();
              output.push({ id: key, page: pageIndex + 1, width, height, bytes, size: bytes.byteLength, extension: "jp2", preview: null, name: `${label}.jp2` });
            } else if (filter === "/FlateDecode" || filter === "") {
              const bytes = rawToPngBytes(dict, stream, context);
              if (!bytes) {
                skipped.push(`${resourceName.asString().replace("/", "")} on page ${pageIndex + 1} (unsupported colour format)`);
                continue;
              }
              output.push({ id: key, page: pageIndex + 1, width, height, bytes, size: bytes.byteLength, extension: "png", preview: bytesToPreview(bytes, "image/png"), name: `${label}.png` });
            } else {
              skipped.push(`${resourceName.asString().replace("/", "")} on page ${pageIndex + 1} (${filter.replace("/", "")})`);
            }
            if (output.length >= 250) break;
          }
        }
        setProgress(((pageIndex + 1) / pages.length) * 100);
        if (output.length >= 250) break;
      }

      output.sort((a, b) => b.width * b.height - a.width * a.height);
      setImages(output);
      setSelected(new Set(output.map((image) => image.id)));
      setPreview(output.find((image) => image.preview)?.preview ?? null);
      if (!output.length) setWarning("No extractable raster images were found above the minimum size. Vector artwork and text are not images.");
      else if (skipped.length) setWarning(`${skipped.length} image${skipped.length === 1 ? "" : "s"} used an unsupported encoding and were skipped: ${skipped.slice(0, 3).join(", ")}.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const totalSize = images?.filter((image) => selected.has(image.id)).reduce((sum, image) => sum + image.size, 0) ?? 0;
  const chosen = images?.filter((image) => selected.has(image.id)) ?? [];

  const download = async () => {
    if (!chosen.length) return;
    if (chosen.length === 1) {
      downloadBytes(chosen[0].bytes, chosen[0].name, chosen[0].extension === "jpg" ? "image/jpeg" : chosen[0].extension === "png" ? "image/png" : "image/jp2");
      return;
    }
    await zipAndDownload(
      chosen.map((image) => ({ name: image.name, data: image.bytes })),
      `${sanitizeName(baseName(pdf.file?.name ?? "document"))}-images.zip`,
    );
  };

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF with images" />
      {pdf.bytes && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Minimum image size" hint="Filters out logos, bullets and decorative icons.">
              <Select value={minSize} onChange={(e) => setMinSize(Number(e.target.value))}>
                <option value={48}>48 px · include small graphics</option>
                <option value={96}>96 px · recommended</option>
                <option value={200}>200 px · photos only</option>
                <option value={400}>400 px · large images only</option>
              </Select>
            </Field>
            <div className="rounded-xl border border-line bg-bone-deep/35 px-3.5 py-2.5 text-[11.5px] leading-relaxed text-ink/70">
              <p className="font-semibold text-forest">Original quality, not screenshots</p>
              <p className="mt-0.5">JPEG photos are exported byte-for-byte. Raster images stored as raw samples are rebuilt as lossless PNG.</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={scan} loading={busy} disabled={busy}>
              <Images className="h-4 w-4" /> {images ? "Scan again" : "Find images"}
            </Button>
            <span className="text-[11.5px] text-muted">{images ? `${images.length} image${images.length === 1 ? "" : "s"} found` : "Scans page resources locally"}</span>
          </div>
          {busy && <Progress value={progress} label="Reading embedded image streams…" />}
        </>
      )}

      {warning && <Alert tone="warning">{warning}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}

      {images && images.length > 0 && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5">
              <Badge tone="forest">{images.length} images</Badge>
              <Badge>{formatBytes(images.reduce((sum, image) => sum + image.size, 0))} total</Badge>
              <Badge>{selected.size} selected · {formatBytes(totalSize)}</Badge>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setSelected(new Set(images.map((image) => image.id)))}>Select all</Button>
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>None</Button>
            </div>
          </div>

          {preview && (
            <div className="checker flex max-h-[360px] items-center justify-center overflow-hidden rounded-xl border border-line p-4">
              <img src={preview} alt="Image preview" className="max-h-[330px] w-auto max-w-full object-contain pdf-page-shadow" loading="lazy" decoding="async" />
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {images.map((image) => {
              const isSelected = selected.has(image.id);
              return (
                <button
                  key={image.id}
                  type="button"
                  onClick={() => {
                    const next = new Set(selected);
                    if (next.has(image.id)) next.delete(image.id);
                    else next.add(image.id);
                    setSelected(next);
                    if (image.preview) setPreview(image.preview);
                  }}
                  onDoubleClick={() => downloadBytes(image.bytes, image.name, image.extension === "jpg" ? "image/jpeg" : image.extension === "png" ? "image/png" : "image/jp2")}
                  className={cn(
                    "group overflow-hidden rounded-xl border text-left transition-colors",
                    isSelected ? "border-forest bg-lime/10 ring-1 ring-forest/20" : "border-line bg-paper hover:border-forest/30",
                  )}
                >
                  <div className="checker flex aspect-[4/3] items-center justify-center overflow-hidden p-1.5">
                    {image.preview ? (
                      <img src={image.preview} alt={`Image from page ${image.page}`} className="max-h-full max-w-full object-contain" loading="lazy" decoding="async" />
                    ) : (
                      <div className="flex flex-col items-center gap-1 text-ink/75">
                        <FileImage className="h-5 w-5" />
                        <span className="text-[9px] font-semibold uppercase">{image.extension}</span>
                      </div>
                    )}
                  </div>
                  <div className="border-t border-line px-2 py-1.5">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-[10px] font-semibold tabular-nums text-ink/70">{image.width}×{image.height}</span>
                      <span className={cn("flex h-3.5 w-3.5 items-center justify-center rounded-full border", isSelected ? "border-forest bg-forest text-lime" : "border-ink/20")}>
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
            <Button onClick={() => void download()} disabled={!chosen.length}>
              <Download className="h-4 w-4" /> Download {chosen.length === 1 ? "image" : `${chosen.length} images`}{chosen.length > 1 ? " (ZIP)" : ""}
            </Button>
            <span className="text-[11.5px] text-muted">Tip: double-click a thumbnail to save it directly.</span>
          </div>
        </>
      )}

      {images && images.length === 0 && !busy && (
        <div className="rounded-xl border border-dashed border-line bg-paper p-6 text-center text-[12px] text-muted">
          Nothing to extract. Try a lower minimum size, or check that the PDF contains raster images rather than vector graphics.
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
  const [range, setRange] = useState("");
  const [length, setLength] = useState<"short" | "medium" | "long">("medium");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<SummarySentence[] | null>(null);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [stats, setStats] = useState<{ words: number; sentences: number; pages: number; minutes: number } | null>(null);
  const [edited, setEdited] = useState("");
  const [copied, setCopied] = useState(false);
  const [pdfResult, setPdfResult] = useState<{ bytes: Uint8Array; name: string; pages: number } | null>(null);

  const ratio = length === "short" ? 0.08 : length === "medium" ? 0.16 : 0.28;

  const run = async () => {
    if (!pdf.bytes || !pdf.file) return;
    setBusy(true);
    setError("");
    setSummary(null);
    setKeywords([]);
    setEdited("");
    setPdfResult(null);
    setProgress(0);
    setStatus("Reading the text layer…");
    try {
      const pages = uniqueInOrder(parseRanges(range, pdf.pageCount));
      if (pages.length > 150) throw new Error("Summaries are limited to 150 pages per run. Use a page range for longer documents.");
      const extracted = await extractDocument(pdf.bytes, {
        pages,
        onProgress: (done, total) => {
          setProgress((done / total) * 55);
          setStatus(`Reading page ${done} of ${total}…`);
        },
      });
      if (extracted.text.replace(/\s/g, "").length < 200) {
        throw new Error("Not enough text to summarise. Scanned PDFs need OCR first — try OCR PDF, then come back.");
      }
      setStatus("Ranking sentences…");
      setProgress(65);

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
        const words = (sentence.text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []).filter((w) => !STOPWORDS.has(w) && w.length > 2);
        const unique = new Set(words);
        let score = 0;
        unique.forEach((word) => {
          score += (frequencies.get(word) ?? 0) / maxFrequency;
        });
        score = score / Math.sqrt(Math.max(8, words.length));
        // lead bias: early sentences carry the thesis in most documents
        if (index < 3) score *= 1.22;
        else if (index < 8) score *= 1.08;
        if (/\b(conclusion|summary|result|finding|recommend|objective|purpose|total|important)\b/i.test(sentence.text)) score *= 1.12;
        if (sentence.text.length > 320) score *= 0.9;
        return { ...sentence, score, index };
      });

      const target = Math.max(3, Math.min(30, Math.round(scored.length * ratio)));
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
        .slice(0, 12)
        .map(([word]) => word);

      const words = extracted.text.split(/\s+/).filter(Boolean).length;
      setSummary(picked);
      setKeywords(topKeywords);
      setStats({ words, sentences: allSentences.length, pages: extracted.pages.length, minutes: Math.max(1, Math.round(words / 220)) });
      setEdited(picked.map((sentence) => `• ${sentence.text}`).join("\n\n"));
      setProgress(100);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setStatus("");
    }
  };

  const summaryText = () =>
    [
      `Paperly summary — ${pdf.file?.name ?? "document"}`,
      `${stats?.pages ?? 0} pages · ${stats?.words.toLocaleString() ?? 0} words · ${summary?.length ?? 0} selected passages`,
      "",
      edited.trim(),
      "",
      keywords.length ? `Key terms: ${keywords.join(", ")}` : "",
      "",
      "Extractive summary created locally by Paperly. No text was uploaded or sent to an AI service.",
    ]
      .filter(Boolean)
      .join("\n");

  const createPdf = async () => {
    if (!summary || !edited.trim()) return;
    setBusy(true);
    setError("");
    try {
      const title = pdf.file ? baseName(pdf.file.name) : "Document";
      const lines = edited
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => (line.startsWith("•") ? `- ${line.replace(/^•\s*/, "").replace(/\[\.\.\.\]/g, "")}` : line));
      const markdown = [
        `# Summary: ${title}`,
        "",
        `**Source:** ${pdf.file?.name ?? "document"} · ${stats?.pages ?? 0} pages · ${stats?.words.toLocaleString() ?? 0} words · ${stats?.minutes ?? 0} min read`,
        "",
        "## Key passages",
        "",
        ...lines,
        "",
        keywords.length ? `## Key terms\n\n${keywords.map((word) => `\`${word}\``).join(" · ")}` : "",
        "",
        "---",
        "Extractive summary generated locally by Paperly. Passages are selected from the source document; no text is paraphrased or uploaded.",
      ].join("\n");
      const rendered = await renderMarkdownToPdf(markdown, {
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
    } finally {
      setBusy(false);
    }
  };

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
              Paperly ranks the most representative sentences in your document and keeps their exact wording. It is <strong>extractive</strong>, not
              generative: it never invents facts, and nothing leaves this tab. For documents where you need paraphrase or translation, use a service
              you trust with the content.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Summary length">
              <Segmented
                value={length}
                onChange={setLength}
                size="sm"
                options={[
                  { value: "short", label: "Short" },
                  { value: "medium", label: "Medium" },
                  { value: "long", label: "Detailed" },
                ]}
              />
            </Field>
            <RangeField value={range} onChange={setRange} total={pdf.pageCount} label="Pages to include" hint="Leave empty for the whole document." />
          </div>
          {error && <Alert tone="error">{error}</Alert>}
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={run} loading={busy}>
              <Sparkles className="h-4 w-4" /> Summarise document
            </Button>
            <span className="text-[11.5px] text-muted">Extractive · deterministic · fully local</span>
          </div>
          {busy && <Progress value={progress} label={status} />}
        </>
      )}

      {summary && stats && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: "Pages read", value: stats.pages },
              { label: "Words", value: stats.words.toLocaleString() },
              { label: "Sentences ranked", value: stats.sentences.toLocaleString() },
              { label: "Selected", value: summary.length },
            ].map((item) => (
              <div key={item.label} className="rounded-xl border border-line bg-paper px-3 py-2.5">
                <p className="text-[18px] font-semibold leading-none text-forest">{item.value}</p>
                <p className="mt-1 text-[10px] uppercase tracking-[0.07em] text-ink/75">{item.label}</p>
              </div>
            ))}
          </div>

          {keywords.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink/75">Key terms</span>
              {keywords.map((word) => (
                <span key={word} className="rounded-full border border-line bg-paper px-2 py-0.5 text-[10.5px] font-medium text-ink/70">{word}</span>
              ))}
            </div>
          )}

          <div>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="summary-text" className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/75">Your summary · editable</label>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => { setCopied(await copyText(summaryText())); setTimeout(() => setCopied(false), 1600); }}
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => downloadBytes(new Uint8Array(new TextEncoder().encode(summaryText())), `${sanitizeName(baseName(pdf.file?.name ?? "document"))}-summary.txt`, "text/plain")}
                >
                  <Download className="h-3.5 w-3.5" /> .txt
                </Button>
                <Button size="sm" onClick={createPdf} loading={busy}>PDF</Button>
              </div>
            </div>
            <textarea
              id="summary-text"
              value={edited}
              onChange={(e) => setEdited(e.target.value)}
              rows={12}
              className="w-full rounded-xl border border-line bg-paper px-3.5 py-3 text-[12.5px] leading-relaxed focus:border-forest/40 focus:outline-none focus:ring-2 focus:ring-forest/10"
            />
            <p className="mt-1 text-[10.5px] text-muted">
              Every bullet is a verbatim sentence from your document{summary.length ? ` · first from page ${summary[0].page}` : ""}. Remove anything that
              isn’t useful before exporting.
            </p>
          </div>

          <div className="rounded-xl border border-line bg-bone-deep/30 p-3 text-[11px] leading-relaxed text-muted">
            <p className="flex items-center gap-1.5 font-semibold text-ink/75"><Quote className="h-3.5 w-3.5 text-forest" /> Where the passages came from</p>
            <p className="mt-1">
              {Array.from(new Set(summary.map((sentence) => sentence.page))).join(", ")}. Each passage is copied exactly, in document order, so you can
              search the source to verify it.
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

      {!pdf.bytes && (
        <div className="flex items-start gap-2 rounded-xl border border-dashed border-line bg-bone-deep/25 px-3.5 py-3 text-[11.5px] leading-relaxed text-muted">
          <ScanText className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Scanned PDFs have no text to summarise. Run OCR PDF first, then use the searchable result
          here.
        </div>
      )}
    </div>
  );
}

