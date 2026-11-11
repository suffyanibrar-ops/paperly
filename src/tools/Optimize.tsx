import { Check, Download, Gauge, Hash, Wrench } from "lucide-react";
import { PDFDict, PDFName, PDFNumber, PDFRawStream, type PDFRef } from "@cantoo/pdf-lib";
import { useEffect, useState } from "react";
import {
  PDFDocument,
  StandardFonts,
  baseName,
  dataUrlToBytes,
  downloadBytes,
  formatBytes,
  hexToRgb,
  imageToJpegDataUrl,
  openPdfJs,
  openPdfLib,
  parseRanges,
  readFileBytes,
  renderPdfPage,
  sanitizeName,
  uniqueInOrder,
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
  Select,
  StepHeader,
  TextInput,
  inputClass,
} from "@/components/ui";
import { DownloadPanel, RangeField, SinglePdfInput } from "@/components/toolParts";
import { cn } from "@/utils/cn";

/* ================================================================== *
 * COMPRESS
 * ================================================================== */
type Level = "light" | "balanced" | "strong";

const LEVELS: Record<Level, { quality: number; maxDimension: number; label: string; hint: string }> = {
  light: { quality: 0.82, maxDimension: 2600, label: "Light", hint: "Barely visible change" },
  balanced: { quality: 0.66, maxDimension: 2000, label: "Balanced", hint: "Best size / quality" },
  strong: { quality: 0.45, maxDimension: 1400, label: "Strong", hint: "Smallest file" },
};

interface CompressResult {
  optimized: Uint8Array;
  optimizedSize: number;
  imagesChanged: number;
  flattened?: Uint8Array;
  flattenedSize?: number;
  originalSize: number;
  pages: number;
  /** When the user asked for a specific output size. */
  targetBytes?: number;
  targetMet?: boolean;
}

export async function recompressImages(
  bytes: ArrayBuffer,
  opts: { quality: number; maxDimension: number },
  onProgress: (value: number) => void,
): Promise<{ bytes: Uint8Array; changed: number }> {
  const doc = await openPdfLib(bytes);
  const context = doc.context;
  const seen = new Map<string, boolean>();
  let changed = 0;
  const pages = doc.getPages();
  for (let p = 0; p < pages.length; p++) {
    const resources = pages[p].node.Resources();
    const xObjects = resources?.lookup(PDFName.of("XObject"));
    if (xObjects instanceof PDFDict) {
      for (const [, ref] of xObjects.entries()) {
        const key = ref.toString();
        if (seen.has(key)) continue;
        seen.set(key, true);
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
          const jpeg = await imageToJpegDataUrl(new Blob([original as unknown as BlobPart], { type: "image/jpeg" }), opts.maxDimension, opts.quality);
          const next = dataUrlToBytes(jpeg.dataUrl);
          if (next.byteLength >= original.byteLength * 0.94) continue;
          const newDict = PDFDict.withContext(context);
          for (const [k, v] of dict.entries()) newDict.set(k, v);
          newDict.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
          newDict.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB"));
          newDict.set(PDFName.of("Width"), PDFNumber.of(jpeg.width));
          newDict.set(PDFName.of("Height"), PDFNumber.of(jpeg.height));
          newDict.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
          newDict.set(PDFName.of("Length"), PDFNumber.of(next.byteLength));
          newDict.delete(PDFName.of("DecodeParms"));
          context.assign(ref as PDFRef, PDFRawStream.of(newDict, next));
          changed++;
        } catch {
          /* leave unusual images untouched */
        }
      }
    }
    onProgress(Math.round(((p + 1) / pages.length) * 55));
  }
  const saved = await doc.save({ useObjectStreams: true });
  return { bytes: saved, changed };
}

export async function flattenPdf(
  bytes: ArrayBuffer,
  opts: { targetWidth: number; quality: number },
  onProgress: (value: number) => void,
): Promise<Uint8Array> {
  const source = await openPdfJs(bytes);
  const out = await PDFDocument.create();
  for (let i = 1; i <= source.numPages; i++) {
    const rendered = await renderPdfPage(source, i, {
      targetWidth: opts.targetWidth,
      type: "image/jpeg",
      quality: opts.quality,
    });
    const page = await source.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const pdfPage = out.addPage([viewport.width, viewport.height]);
    const image = await out.embedJpg(dataUrlToBytes(rendered.dataUrl));
    pdfPage.drawImage(image, { x: 0, y: 0, width: viewport.width, height: viewport.height });
    onProgress(Math.round(55 + (i / source.numPages) * 45));
  }
  await source.destroy();
  return out.save({ useObjectStreams: true });
}

export function CompressTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [level, setLevel] = useState<Level>("balanced");
  const [targetMB, setTargetMB] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<CompressResult | null>(null);
  const [choice, setChoice] = useState<"optimized" | "flattened">("optimized");

  const compress = async () => {
    if (!pdf.bytes || !pdf.file) return;
    setBusy(true);
    setError("");
    setResult(null);
    setProgress(2);
    setPhase("Analyzing embedded images…");
    try {
      const config = LEVELS[level];
      const optimized = await recompressImages(pdf.bytes, config, (v) => {
        setProgress(v);
        setPhase("Re-encoding photos, keeping text sharp…");
      });
      let flattened: Uint8Array | undefined;
      const savings = 1 - optimized.bytes.byteLength / pdf.file.size;
      if (savings < 0.12 && pdf.pageCount <= 60) {
        setProgress(55);
        setPhase("Trying a page-flatten pass for extra savings…");
        flattened = await flattenPdf(
          pdf.bytes,
          { targetWidth: level === "strong" ? 950 : level === "balanced" ? 1200 : 1500, quality: level === "strong" ? 0.55 : 0.7 },
          setProgress,
        );
        // Never suggest a “smaller” version that is actually larger.
        if (flattened.byteLength >= optimized.bytes.byteLength) flattened = undefined;
      }
      let chosen = optimized.bytes;
      let targetBytes: number | undefined;
      let targetMet: boolean | undefined;
      const requestedMB = Number(targetMB);
      if (targetMB.trim() && Number.isFinite(requestedMB) && requestedMB > 0) {
        targetBytes = Math.round(requestedMB * 1024 * 1024);
        const candidates: Uint8Array[] = [optimized.bytes];
        if (flattened) candidates.push(flattened);
        const underTarget = (list: Uint8Array[]) => list.some((item) => item.byteLength <= targetBytes!);
        if (!underTarget(candidates) && pdf.pageCount <= 150) {
          const attempts: { quality: number; maxDimension: number }[] = [LEVELS.strong, { quality: 0.35, maxDimension: 1100 }, { quality: 0.26, maxDimension: 900 }];
          for (const config of attempts) {
            setPhase("Pushing harder to reach your target size…");
            const attempt = await recompressImages(pdf.bytes, config, () => undefined);
            candidates.push(attempt.bytes);
            if (underTarget(candidates)) break;
            if (pdf.pageCount <= 60) {
              setPhase("Flattening pages to reach your target size…");
              candidates.push(await flattenPdf(pdf.bytes, { targetWidth: 900, quality: 0.42 }, () => undefined));
              if (underTarget(candidates)) break;
            }
          }
        }
        const fits = candidates.filter((item) => item.byteLength <= targetBytes!).sort((a, b) => a.byteLength - b.byteLength);
        chosen = (fits[0] ?? [...candidates].sort((a, b) => a.byteLength - b.byteLength)[0])!;
        targetMet = chosen.byteLength <= targetBytes;
        flattened = undefined;
      }
      setResult({
        optimized: chosen,
        optimizedSize: chosen.byteLength,
        imagesChanged: optimized.changed,
        flattened,
        flattenedSize: flattened?.byteLength,
        originalSize: pdf.file.size,
        pages: pdf.pageCount,
        targetBytes,
        targetMet,
      });
      setChoice(flattened && flattened.byteLength < optimized.bytes.byteLength ? "flattened" : "optimized");
      setProgress(100);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setPhase("");
    }
  };

  const active = result ? (choice === "flattened" && result.flattened ? result.flattened : result.optimized) : null;
  const activeSize = result ? (choice === "flattened" && result.flattenedSize ? result.flattenedSize : result.optimizedSize) : 0;
  const savedPct = result ? Math.round((1 - activeSize / result.originalSize) * 100) : 0;

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to compress" />
      {pdf.bytes && (
        <>
          <div>
            <StepHeader step={2} title="Compression level" hint="Quality vs. size" />
            <Segmented
              value={level}
              onChange={(v) => {
                setLevel(v);
                setResult(null);
              }}
              options={(["light", "balanced", "strong"] as Level[]).map((l) => ({
                value: l,
                label: LEVELS[l].label,
                hint: LEVELS[l].hint,
              }))}
            />
          </div>
          <Field
            label="Target size (optional)"
            hint="Enter a size in MB and Paperly will keep pushing compression until the file fits — or return the smallest achievable result and tell you honestly."
          >
            <div className="flex items-center gap-2">
              <TextInput
                type="number"
                min={0.05}
                step={0.05}
                inputMode="decimal"
                value={targetMB}
                placeholder={pdf.file ? `e.g. ${Math.max(0.1, Number((pdf.file.size / 1024 / 1024 / 2).toFixed(1)))}` : "e.g. 1.5"}
                onChange={(event) => {
                  setTargetMB(event.target.value);
                  setResult(null);
                }}
                className="max-w-[180px]"
              />
              <span className="text-[12px] text-muted">MB</span>
            </div>
          </Field>
          <div className="rounded-xl border border-line bg-bone-deep/35 p-3.5 text-[12px] leading-relaxed text-ink/75">
            <p className="flex items-center gap-1.5 font-semibold text-forest">
              <Gauge className="h-3.5 w-3.5" /> Smarter than flattening everything
            </p>
            <p className="mt-1">
              Paperly re-encodes embedded photos and optimizes the PDF structure. Selectable text, links and vectors stay intact. If a file is
              already lean, we say so instead of giving you a bigger file.
            </p>
          </div>
          {error && <Alert tone="error">{error}</Alert>}
          <div className="border-t border-line pt-4">
            <Button onClick={compress} loading={busy}>
              <Gauge className="h-4 w-4" /> {busy ? "Compressing…" : "Compress PDF"}
            </Button>
          </div>
          {busy && <Progress value={progress} label={phase} />}
        </>
      )}

      {result && active && (
        <div className="space-y-3">
          <div className="animate-pop rounded-2xl border border-forest/15 bg-forest p-5 text-paper">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-lime text-forest">
                <Check className="h-5 w-5" strokeWidth={2.6} />
              </div>
              <div>
                <h3 className="text-[17px] font-semibold">
                  {savedPct > 0 ? `${savedPct}% smaller` : "Already highly optimized"}
                </h3>
                <p className="mt-0.5 text-[12.5px] text-paper/70">
                  {formatBytes(result.originalSize)} → {formatBytes(activeSize)}
                  {result.imagesChanged ? ` · ${result.imagesChanged} photo${result.imagesChanged === 1 ? "" : "s"} re-encoded` : ""}
                </p>
                {result.targetBytes && (
                  <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-paper/10 px-2.5 py-1 text-[11px] font-medium">
                    <Gauge className="h-3 w-3 text-lime" />
                    Target {formatBytes(result.targetBytes)} · {result.targetMet ? "reached" : "not reachable without OCR-quality loss"}
                  </p>
                )}
              </div>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setChoice("optimized")}
                className={cn(
                  "rounded-xl border p-3 text-left transition-colors",
                  choice === "optimized" ? "border-lime bg-paper/10" : "border-paper/15 hover:bg-paper/5",
                )}
              >
                <p className="text-[12.5px] font-semibold">Keep text sharp</p>
                <p className="text-[11px] text-paper/70">Photos re-encoded · {formatBytes(result.optimizedSize)}</p>
              </button>
              {result.flattened && result.flattenedSize && (
                <button
                  type="button"
                  onClick={() => setChoice("flattened")}
                  className={cn(
                    "rounded-xl border p-3 text-left transition-colors",
                    choice === "flattened" ? "border-lime bg-paper/10" : "border-paper/15 hover:bg-paper/5",
                  )}
                >
                  <p className="text-[12.5px] font-semibold">Maximum shrink (flattened)</p>
                  <p className="text-[11px] text-paper/70">Pages become images · {formatBytes(result.flattenedSize)}</p>
                </button>
              )}
            </div>
            <Button
              variant="accent"
              className="mt-4"
              onClick={() =>
                downloadBytes(active, `${sanitizeName(baseName(pdf.file?.name ?? "document"))}-compressed.pdf`)
              }
            >
              <Download className="h-4 w-4" /> Download {formatBytes(activeSize)}
            </Button>
          </div>
          {savedPct <= 0 && (
            <Alert tone="info" title="No meaningful reduction">
              This PDF is already optimized. You can still download the rebuilt version, which may open faster in some readers.
            </Alert>
          )}
          {choice === "flattened" && (
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
export function RepairTool() {
  const initial = useInitialFiles().filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
  const [file, setFile] = useState<File | null>(initial[0] ?? null);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [damage, setDamage] = useState("");
  const [loading, setLoading] = useState(Boolean(initial[0]));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; pages: number; method: string; lost?: string } | null>(
    null,
  );

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
    setError("");
    setResult(null);
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

  const repair = async () => {
    if (!bytes || !file) return;
    setBusy(true);
    setError("");
    setResult(null);
    setProgress(10);
    try {
      let structuralError = "";
      try {
        const doc = await openPdfLib(bytes);
        const bytesOut = await doc.save({ useObjectStreams: true });
        if (bytesOut.byteLength > 100) {
          setProgress(100);
          setResult({
            bytes: bytesOut,
            name: `${sanitizeName(baseName(file.name))}-repaired.pdf`,
            pages: doc.getPageCount(),
            method: "Structure rebuilt",
          });
          return;
        }
      } catch (err) {
        structuralError = (err as Error).message;
      }

      setProgress(25);
      let source: Awaited<ReturnType<typeof openPdfJs>>;
      try {
        source = await openPdfJs(bytes);
      } catch {
        throw new Error(
          structuralError ||
            "This file is too damaged to read any pages. If you have another copy, or the original source application, try re-exporting it.",
        );
      }
      if (source.numPages > 80) {
        throw new Error("This file needs page-by-page recovery, which is limited to 80 pages here. Try splitting the source file first.");
      }
      const out = await PDFDocument.create();
      for (let i = 1; i <= source.numPages; i++) {
        const rendered = await renderPdfPage(source, i, { targetWidth: 1400, type: "image/jpeg", quality: 0.85 });
        const page = await source.getPage(i);
        const viewport = page.getViewport({ scale: 1 });
        const pdfPage = out.addPage([viewport.width, viewport.height]);
        const image = await out.embedJpg(dataUrlToBytes(rendered.dataUrl));
        pdfPage.drawImage(image, { x: 0, y: 0, width: viewport.width, height: viewport.height });
        setProgress(25 + (i / source.numPages) * 70);
      }
      await source.destroy();
      const outBytes = await out.save({ useObjectStreams: true });
      setProgress(100);
      setResult({
        bytes: outBytes,
        name: `${sanitizeName(baseName(file.name))}-recovered.pdf`,
        pages: out.getPageCount(),
        method: "Page-by-page recovery",
        lost: "Rebuilt pages are images, so selectable text may not survive.",
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {!file ? (
        <FileDrop accept="application/pdf,.pdf" acceptLabel="The damaged PDF" onFiles={(files) => setFile(files[0])} />
      ) : (
        <div className="space-y-2">
          <FileRow
            file={file}
            onRemove={() => {
              setFile(null);
              setResult(null);
            }}
            size={loading ? "Reading…" : pageCount ? `${pageCount} pages · ${formatBytes(file.size)}` : formatBytes(file.size)}
          />
          {loading && <Progress label="Inspecting the document locally…" />}
          {!loading && damage && <Alert tone="warning" title="Damage detected">{damage}</Alert>}
          {!loading && !damage && (
            <Alert tone="success" title="File opens normally">
              This PDF loads cleanly. Repair can still rebuild its structure, which sometimes fixes slow or odd rendering in other readers.
            </Alert>
          )}
        </div>
      )}

      {file && bytes && (
        <>
          <div className="rounded-xl border border-line bg-bone-deep/35 p-3.5">
            <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-forest">
              <Wrench className="h-3.5 w-3.5" /> Two-stage recovery
            </p>
            <ol className="mt-1.5 space-y-1 text-[11.5px] leading-relaxed text-ink/70">
              <li>1. Rebuild the PDF structure (keeps text, links and quality).</li>
              <li>2. If the structure is unusable, render every readable page into a fresh PDF.</li>
            </ol>
          </div>
          {error && <Alert tone="error">{error}</Alert>}
          <div className="border-t border-line pt-4">
            <Button onClick={repair} loading={busy}>
              <Wrench className="h-4 w-4" /> Repair PDF
            </Button>
          </div>
          {busy && <Progress value={progress} label="Rebuilding the document locally…" />}
        </>
      )}
      {result && (
        <>
          <DownloadPanel
          bytes={result.bytes}
            title="Document recovered"
            filename={result.name}
            size={result.bytes.byteLength}
            pages={result.pages}
            onDownload={() => downloadBytes(result.bytes, result.name)}
            description={`${result.method} · ${result.pages} readable pages · ${formatBytes(result.bytes.byteLength)}`}
          />
          {result.lost && <Alert tone="warning">{result.lost}</Alert>}
        </>
      )}
    </div>
  );
}

/* ================================================================== *
 * PAGE NUMBERS
 * ================================================================== */
const POSITIONS = [
  { value: "bottom-center", label: "Bottom center" },
  { value: "bottom-right", label: "Bottom right" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "top-center", label: "Top center" },
  { value: "top-right", label: "Top right" },
  { value: "top-left", label: "Top left" },
] as const;
type Position = (typeof POSITIONS)[number]["value"];
type Format = "plain" | "page" | "slash" | "of" | "dashes";

const MM = 2.834645669;

function numberText(format: Format, n: number, total: number) {
  switch (format) {
    case "page":
      return `Page ${n}`;
    case "slash":
      return `${n} / ${total}`;
    case "of":
      return `Page ${n} of ${total}`;
    case "dashes":
      return `- ${n} -`;
    default:
      return `${n}`;
  }
}

export function PageNumbersTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const { thumbs } = usePdfThumbs(pdf.bytes, { width: 380, quality: 0.8, max: 1 });
  const [position, setPosition] = useState<Position>("bottom-center");
  const [format, setFormat] = useState<Format>("slash");
  const [start, setStart] = useState(1);
  const [size, setSize] = useState(10);
  const [margin, setMargin] = useState(12);
  const [color, setColor] = useState("#25352c");
  const [range, setRange] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; pages: number } | null>(null);

  useEffect(() => setResult(null), [position, format, start, size, margin, color, range]);

  const apply = async () => {
    if (!pdf.bytes || !pdf.file) return;
    setBusy(true);
    setError("");
    try {
      const pages = uniqueInOrder(parseRanges(range, pdf.pageCount));
      const doc = await openPdfLib(pdf.bytes);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const all = doc.getPages();
      pages.forEach((pageNumber) => {
        const page = all[pageNumber - 1];
        const label = numberText(format, start + pageNumber - 1, pdf.pageCount);
        const textWidth = font.widthOfTextAtSize(label, size);
        const { width, height } = page.getSize();
        const marginPt = margin * MM;
        let x = (width - textWidth) / 2;
        if (position.endsWith("left")) x = marginPt;
        if (position.endsWith("right")) x = width - marginPt - textWidth;
        const y = position.startsWith("top") ? height - marginPt - size : marginPt;
        page.drawText(label, { x, y, size, font, color: hexToRgb(color) });
      });
      const bytes = await doc.save();
      setResult({ bytes, name: `${sanitizeName(baseName(pdf.file.name))}-numbered.pdf`, pages: pages.length });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const previewWidth = 260;
  const previewNumber = numberText(format, start, pdf.pageCount);
  const previewStyle: React.CSSProperties = {
    fontSize: `${Math.max(7, (size / 612) * previewWidth * 1.5)}px`,
    color,
    position: "absolute",
    left: position.endsWith("left") ? `${(margin / 210) * 100}%` : position.endsWith("right") ? "auto" : "50%",
    right: position.endsWith("right") ? `${(margin / 210) * 100}%` : "auto",
    transform: position.endsWith("center") ? "translateX(-50%)" : "none",
    top: position.startsWith("top") ? `${(margin / 297) * 100}%` : "auto",
    bottom: position.startsWith("bottom") ? `${(margin / 297) * 100}%` : "auto",
    fontWeight: 500,
    whiteSpace: "nowrap",
  };

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to number" />
      {pdf.bytes && (
        <>
          <div className="grid gap-5 md:grid-cols-[1fr_260px]">
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Position">
                  <Select value={position} onChange={(e) => setPosition(e.target.value as Position)}>
                    {POSITIONS.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Format">
                  <Select value={format} onChange={(e) => setFormat(e.target.value as Format)}>
                    <option value="plain">1</option>
                    <option value="page">Page 1</option>
                    <option value="slash">1 / N</option>
                    <option value="of">Page 1 of N</option>
                    <option value="dashes">- 1 -</option>
                  </Select>
                </Field>
                <Field label="First number">
                  <input
                    type="number"
                    min={0}
                    max={9999}
                    value={start}
                    onChange={(e) => setStart(Math.max(0, Number(e.target.value) || 0))}
                    className={cn(inputClass, "tabular-nums")}
                  />
                </Field>
                <Field label="Font size" hint={`${size} pt`}>
                  <input
                    type="range"
                    min={7}
                    max={22}
                    value={size}
                    onChange={(e) => setSize(Number(e.target.value))}
                    className="mt-3 w-full accent-[#1c4c3b]"
                  />
                </Field>
                <Field label="Margin from edge" hint={`${margin} mm`}>
                  <input
                    type="range"
                    min={4}
                    max={40}
                    value={margin}
                    onChange={(e) => setMargin(Number(e.target.value))}
                    className="mt-3 w-full accent-[#1c4c3b]"
                  />
                </Field>
                <Field label="Text color">
                  <ColorInput value={color} onChange={setColor} label="Page number color" />
                </Field>
              </div>
              <RangeField
                value={range}
                onChange={setRange}
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
          {error && <Alert tone="error">{error}</Alert>}
          <div className="border-t border-line pt-4">
            <Button onClick={apply} loading={busy}>
              <Hash className="h-4 w-4" /> Add page numbers
            </Button>
          </div>
        </>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Numbers added"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          onDownload={() => downloadBytes(result.bytes, result.name)}
        />
      )}
    </div>
  );
}

