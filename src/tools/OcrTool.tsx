import { Check, Copy, Download, RotateCw, ScanText, Search, TextCursorInput } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  PDFDocument,
  baseName,
  dataUrlToBytes,
  downloadBytes,
  embedFonts,
  openPdfJs,
  parseRanges,
  renderPdfPage,
  safePdfText,
  sanitizeName,
  uniqueInOrder,
  openPdfLib,
} from "@/lib/pdf";
import { extractDocument } from "@/lib/extract";
import { useInitialFiles, usePdfFile } from "@/lib/usePdf";
import { copyText } from "@/lib/router";
import { usePrimaryShortcut } from "@/lib/hotkeys";
import { useToolPreferences } from "@/lib/prefs";
import { Alert, Badge, Button, Field, Progress, Segmented, Select, Switch, inputClass } from "@/components/ui";
import { AdvancedOptions, OptionsGrid, OptionNote, SliderField } from "@/components/AdvancedOptions";
import { DownloadPanel, RangeField, SinglePdfInput } from "@/components/toolParts";
import { cn } from "@/utils/cn";

/* ------------------------------------------------------------------ *
 * Tesseract is loaded from a CDN worker/core, pinned to exact versions.
 * Language data is downloaded once by the browser and cached by it.
 * ------------------------------------------------------------------ */
const TESSERACT_VERSION = "6.0.1";
const CORE_VERSION = "6.1.2";
const LANG_PATH = "https://tessdata.projectnaptha.com/4.0.0";

const LANGUAGES = [
  { code: "eng", name: "English" },
  { code: "deu", name: "German" },
  { code: "fra", name: "French" },
  { code: "spa", name: "Spanish" },
  { code: "ita", name: "Italian" },
  { code: "por", name: "Portuguese" },
  { code: "nld", name: "Dutch" },
  { code: "pol", name: "Polish" },
  { code: "swe", name: "Swedish" },
  { code: "tur", name: "Turkish" },
  { code: "rus", name: "Russian" },
  { code: "ukr", name: "Ukrainian" },
  { code: "ara", name: "Arabic" },
  { code: "hin", name: "Hindi" },
  { code: "chi_sim", name: "Chinese (Simplified)" },
  { code: "chi_tra", name: "Chinese (Traditional)" },
  { code: "jpn", name: "Japanese" },
  { code: "kor", name: "Korean" },
];

interface OcrWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

interface OcrPage {
  page: number;
  text: string;
  words: OcrWord[];
  confidence: number;
  /** Page size in PDF points, already swapped when the page was auto-rotated. */
  width: number;
  height: number;
  rotated: boolean;
}

type OcrMode = "searchable" | "text" | "both";

interface TesseractData {
  text?: string;
  confidence?: number;
  words?: OcrWord[];
  blocks?: { paragraphs: { lines: { words: OcrWord[] }[] }[] }[] | null;
}

function collectWords(data: TesseractData): OcrWord[] {
  if (Array.isArray(data.words) && data.words.length) return data.words;
  const words: OcrWord[] = [];
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const word of line.words ?? []) if (word?.text?.trim()) words.push(word);
      }
    }
  }
  return words;
}

/** Mean per-word confidence, used to decide whether a second orientation helps. */
function meanWordConfidence(words: readonly OcrWord[]): number {
  if (!words.length) return 0;
  let total = 0;
  let counted = 0;
  for (const word of words) {
    const value = (word as unknown as { confidence?: number }).confidence;
    if (typeof value === "number") {
      total += value;
      counted++;
    }
  }
  return counted ? total / counted : 0;
}

/** Grayscale + contrast preprocessing, done locally on a canvas. */
async function preprocessImage(dataUrl: string, options: { grayscale: boolean; contrast: number }): Promise<string> {
  if (!options.grayscale && options.contrast === 1) return dataUrl;
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close?.();
    return dataUrl;
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  const intercept = 128 * (1 - options.contrast);
  for (let index = 0; index < data.length; index += 4) {
    let red = data[index];
    let green = data[index + 1];
    let blue = data[index + 2];
    if (options.grayscale) {
      const luminance = 0.299 * red + 0.587 * green + 0.114 * blue;
      red = luminance;
      green = luminance;
      blue = luminance;
    }
    if (options.contrast !== 1) {
      red = red * options.contrast + intercept;
      green = green * options.contrast + intercept;
      blue = blue * options.contrast + intercept;
    }
    data[index] = Math.min(255, Math.max(0, red));
    data[index + 1] = Math.min(255, Math.max(0, green));
    data[index + 2] = Math.min(255, Math.max(0, blue));
  }
  context.putImageData(image, 0, 0);
  const output = canvas.toDataURL("image/jpeg", 0.92);
  canvas.width = 1;
  canvas.height = 1;
  return output;
}

/** Rotate a rendered page image by 90° clockwise. */
async function rotateImageDataUrl(dataUrl: string): Promise<string> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.height;
  canvas.height = bitmap.width;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close?.();
    return dataUrl;
  }
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(Math.PI / 2);
  context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  bitmap.close?.();
  const output = canvas.toDataURL("image/jpeg", 0.92);
  canvas.width = 1;
  canvas.height = 1;
  return output;
}

export function OcrTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const opts = useToolPreferences("ocr", {
    language: "eng",
    mode: "searchable" as OcrMode,
    dpi: 200,
    skipText: true,
    grayscale: false,
    contrast: 100,
    autoRotate: false,
  });

  const [range, setRange] = useState("");
  const [languageQuery, setLanguageQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [progress, setProgress] = useState(0);
  const [etaMs, setEtaMs] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [text, setText] = useState("");
  const [confidence, setConfidence] = useState<number | null>(null);
  const [rotatedPages, setRotatedPages] = useState<number[]>([]);
  const [pageCount, setPageCount] = useState(0);
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; pages: number; words: number; skipped: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const aliveRef = useRef(true);
  const cancelRef = useRef(false);
  const workerRef = useRef<Awaited<ReturnType<typeof import("tesseract.js")["createWorker"]>> | null>(null);
  const pageProgressRef = useRef(0);
  const pageIndexRef = useRef(0);
  const pageTotalRef = useRef(1);

  const language = opts.value.language;
  const mode = opts.value.mode;
  const dpi = opts.value.dpi;
  const skipText = opts.value.skipText;
  const grayscale = opts.value.grayscale;
  const contrast = opts.value.contrast;
  const autoRotate = opts.value.autoRotate;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      cancelRef.current = true;
      void workerRef.current?.terminate().catch(() => undefined);
      workerRef.current = null;
    };
  }, []);

  const filteredLanguages = useMemo(() => {
    const query = languageQuery.trim().toLowerCase();
    if (!query) return LANGUAGES;
    return LANGUAGES.filter((entry) => entry.name.toLowerCase().includes(query) || entry.code.includes(query));
  }, [languageQuery]);

  const selectedLanguage = LANGUAGES.find((entry) => entry.code === language) ?? LANGUAGES[0];

  const reportPageProgress = (pageFraction: number) => {
    const index = pageIndexRef.current;
    const total = pageTotalRef.current;
    const overall = ((Math.min(index + pageFraction, total)) / Math.max(1, total)) * 100;
    setProgress(Math.max(2, Math.min(99, overall)));
  };

  const cancel = () => {
    cancelRef.current = true;
    setPhase("Terminating the OCR worker…");
    const worker = workerRef.current;
    workerRef.current = null;
    if (worker) void worker.terminate().catch(() => undefined);
  };

  const run = async () => {
    if (!pdf.bytes || !pdf.file || busy) return;
    setBusy(true);
    setError("");
    setWarning("");
    setText("");
    setResult(null);
    setConfidence(null);
    setRotatedPages([]);
    setProgress(1);
    setEtaMs(null);
    cancelRef.current = false;
    setPhase("Preparing your pages…");
    const startedAt = Date.now();

    let worker: Awaited<ReturnType<typeof import("tesseract.js")["createWorker"]>> | null = null;
    try {
      const pages = uniqueInOrder(parseRanges(range, pdf.pageCount));
      if (!pages.length) throw new Error("Choose at least one page to OCR.");
      if (pages.length > 50) throw new Error("OCR is limited to 50 pages per run. Split the PDF first for longer documents.");
      setPageCount(pages.length);
      pageTotalRef.current = pages.length;
      pageIndexRef.current = 0;

      // Skip pages that already contain a usable text layer.
      let extract: Awaited<ReturnType<typeof extractDocument>> | null = null;
      if (skipText) {
        try {
          extract = await extractDocument(pdf.bytes, { pages });
        } catch {
          extract = null;
        }
      }
      if (cancelRef.current) throw new Error("cancelled");

      setPhase("Downloading the OCR engine (first run only)…");
      setProgress(4);
      const { createWorker } = await import("tesseract.js");
      worker = await createWorker(language, 1, {
        workerPath: `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/worker.min.js`,
        corePath: `https://cdn.jsdelivr.net/npm/tesseract.js-core@${CORE_VERSION}`,
        langPath: LANG_PATH,
        logger: (message) => {
          if (!aliveRef.current || cancelRef.current) return;
          if (message.status === "recognizing text") {
            pageProgressRef.current = message.progress ?? 0;
            setPhase(
              `Page ${Math.min(pageIndexRef.current + 1, pageTotalRef.current)} of ${pageTotalRef.current} · recognising text (${Math.round(
                (message.progress ?? 0) * 100,
              )}%)`,
            );
            reportPageProgress(message.progress ?? 0);
          } else if (message.status.includes("language") || message.status.includes("initializ")) {
            setPhase("Loading language data (first run only)…");
          }
        },
      });
      workerRef.current = worker;

      const doc = await openPdfJs(pdf.bytes);
      const output = await PDFDocument.create();
      const fonts = await embedFonts(output);
      const source = await openPdfLib(pdf.bytes);
      const ocrPages: OcrPage[] = [];
      const rotated: number[] = [];
      let wordCount = 0;
      let skipped = 0;

      for (let index = 0; index < pages.length; index++) {
        const pageNumber = pages[index];
        pageIndexRef.current = index;
        pageProgressRef.current = 0;
        if (!aliveRef.current || cancelRef.current) throw new Error("cancelled");
        const existing = extract?.pages.find((page) => page.page === pageNumber)?.text?.replace(/\s/g, "") ?? "";
        const sourcePage = await doc.getPage(pageNumber);
        const viewport = sourcePage.getViewport({ scale: 1 });

        if (skipText && existing.length > 18) {
          skipped++;
          const [copiedPage] = await output.copyPages(source, [pageNumber - 1]);
          output.addPage(copiedPage);
          ocrPages.push({ page: pageNumber, text: "", words: [], confidence: 100, width: viewport.width, height: viewport.height, rotated: false });
          reportPageProgress(1);
          continue;
        }

        setPhase(`Page ${index + 1} of ${pages.length} · rendering…`);
        const scale = dpi / 72;
        const rendered = await renderPdfPage(doc, pageNumber, {
          scale,
          type: "image/jpeg",
          quality: 0.92,
        });
        if (cancelRef.current) throw new Error("cancelled");
        let image = await preprocessImage(rendered.dataUrl, { grayscale, contrast: contrast / 100 });
        if (cancelRef.current) throw new Error("cancelled");

        const landscape = viewport.width > viewport.height;
        let best = await worker.recognize(image, {}, { text: true, blocks: true });
        let bestData = best.data as TesseractData;
        let pageRotated = false;
        if (autoRotate && landscape) {
          const firstConfidence = meanWordConfidence(collectWords(bestData));
          if (firstConfidence < 55) {
            if (cancelRef.current) throw new Error("cancelled");
            const turned = await rotateImageDataUrl(image);
            const second = await worker.recognize(turned, {}, { text: true, blocks: true });
            const secondData = second.data as TesseractData;
            if (meanWordConfidence(collectWords(secondData)) > firstConfidence) {
              best = second;
              bestData = secondData;
              image = turned;
              pageRotated = true;
            }
          }
        }
        if (cancelRef.current) throw new Error("cancelled");

        const words = collectWords(bestData);
        wordCount += words.length;
        const width = pageRotated ? viewport.height : viewport.width;
        const height = pageRotated ? viewport.width : viewport.height;
        if (pageRotated) rotated.push(pageNumber);
        ocrPages.push({
          page: pageNumber,
          text: safePdfText(bestData.text ?? ""),
          words,
          confidence: bestData.confidence ?? 0,
          width,
          height,
          rotated: pageRotated,
        });

        if (mode !== "text") {
          const page = output.addPage([width, height]);
          const embedded = await output.embedJpg(dataUrlToBytes(image));
          page.drawImage(embedded, { x: 0, y: 0, width, height });
          const font = fonts.regular;
          for (const word of words) {
            const clean = safePdfText(word.text.trim());
            if (!clean) continue;
            const wordW = (word.bbox.x1 - word.bbox.x0) / scale;
            const wordH = (word.bbox.y1 - word.bbox.y0) / scale;
            if (wordH < 2 || wordW < 2) continue;
            const size = Math.max(4, Math.min(28, wordH * 0.92));
            let fitted = clean;
            let measured = font.widthOfTextAtSize(fitted, size);
            if (measured > wordW && wordW > 0) {
              while (fitted.length > 1 && measured > wordW * 1.12) {
                fitted = fitted.slice(0, -1);
                measured = font.widthOfTextAtSize(fitted, size);
              }
            }
            // Invisible but extractable: browsers and Acrobat can select/search it.
            page.drawText(fitted, {
              x: word.bbox.x0 / scale,
              y: height - word.bbox.y1 / scale,
              size,
              font,
              opacity: 0,
            });
          }
        }
        reportPageProgress(1);
        const elapsed = Date.now() - startedAt;
        const donePages = index + 1;
        setEtaMs(donePages >= pages.length ? 0 : Math.round((elapsed / donePages) * (pages.length - donePages)));
      }
      await doc.destroy();

      if (cancelRef.current) throw new Error("cancelled");
      const allText = ocrPages.map((page) => `— Page ${page.page} —\n${page.text}`).join("\n\n");
      setText(allText);
      setRotatedPages(rotated);
      const confidences = ocrPages.filter((page) => page.words.length).map((page) => page.confidence);
      setConfidence(confidences.length ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length) : null);
      if (!wordCount) {
        setWarning("No text was recognised. Try a higher resolution, a straighter scan or the correct language.");
      }
      if (skipped) {
        setWarning(`Skipped ${skipped} page${skipped === 1 ? "" : "s"} that already had a text layer.`);
      }
      if (rotated.length) {
        setWarning(
          `Auto-rotated ${rotated.length} sideways page${rotated.length === 1 ? "" : "s"} (page ${rotated.join(", ")}) before recognising text.`,
        );
      }

      if (mode !== "text" && wordCount > 0) {
        setProgress(98);
        const bytes = await output.save();
        setResult({
          bytes,
          name: `${sanitizeName(baseName(pdf.file.name))}-searchable.pdf`,
          pages: pages.length,
          words: wordCount,
          skipped,
        });
      }
      setProgress(100);
      setEtaMs(null);
    } catch (err) {
      if (cancelRef.current) {
        setProgress(0);
        setEtaMs(null);
        setWarning("OCR cancelled. The Tesseract worker was terminated; nothing was downloaded and your original is untouched.");
      } else {
        const message = (err as Error).message || "OCR failed.";
        setError(
          /fetch|network|load|worker/i.test(message)
            ? "The OCR engine couldn’t be downloaded. Check your internet connection and try again — language data is fetched once, then cached."
            : message,
        );
      }
    } finally {
      const active = workerRef.current ?? worker;
      workerRef.current = null;
      if (active) {
        try {
          await active.terminate();
        } catch {
          /* already gone */
        }
      }
      setBusy(false);
      setPhase("");
    }
  };

  const downloadText = () => {
    if (!text) return;
    downloadBytes(
      new Uint8Array(new TextEncoder().encode(text)),
      `${sanitizeName(baseName(pdf.file?.name ?? "document"))}-ocr.txt`,
      "text/plain",
    );
  };

  usePrimaryShortcut(() => void run(), Boolean(pdf.bytes) && !busy);

  const outputLabel = mode === "text" ? "Extract text with OCR" : "OCR PDF";
  const previewText = text ? text.split("\n").slice(0, 40).join("\n") : "";

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A scanned PDF" />
      {pdf.bytes && (
        <>
          <div className="rounded-xl border border-forest/15 bg-lime/20 p-3.5">
            <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-forest">
              <ScanText className="h-4 w-4" /> Turn scans into selectable, searchable text
            </p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-forest/90">
              Pages are rendered at your chosen resolution and read with Tesseract running in this tab. The resulting searchable PDF overlays an
              invisible text layer on the page image — nothing is uploaded.
              On first use, the OCR engine and language data download once from a public CDN.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Output" hint="The searchable PDF keeps the scan appearance; text-only skips the file.">
              <Segmented
                value={mode}
                onChange={(value) => opts.set("mode", value)}
                size="sm"
                options={[
                  { value: "searchable", label: "Searchable PDF" },
                  { value: "text", label: "Text only" },
                  { value: "both", label: "Both" },
                ]}
              />
            </Field>
            <Field label="Recognition resolution" hint="Higher is slower but more accurate. 200 DPI suits most scans.">
              <Select value={dpi} onChange={(event) => opts.set("dpi", Number(event.target.value))}>
                <option value={150}>Fast · 150 DPI</option>
                <option value={200}>Recommended · 200 DPI</option>
                <option value={300}>High · 300 DPI</option>
                <option value={400}>Maximum · 400 DPI (slow)</option>
              </Select>
            </Field>
          </div>

          <div className="rounded-xl border border-line bg-paper p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">Document language</p>
              <span className="text-[10.5px] text-muted">
                {LANGUAGES.length} languages · selected {selectedLanguage.name}
              </span>
            </div>
            <div className="mt-2">
              <label htmlFor="ocr-language-search" className="sr-only">
                Search OCR languages
              </label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/40" />
                <input
                  id="ocr-language-search"
                  value={languageQuery}
                  onChange={(event) => setLanguageQuery(event.target.value)}
                  placeholder="Search languages — type a name or code"
                  className={cn(inputClass, "pl-9")}
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="mt-2 grid max-h-44 gap-1 overflow-y-auto pr-1 sm:grid-cols-3 scrollbar-thin">
              {filteredLanguages.map((entry) => {
                const active = entry.code === language;
                return (
                  <button
                    key={entry.code}
                    type="button"
                    aria-pressed={active}
                    onClick={() => opts.set("language", entry.code)}
                    className={cn(
                      "flex items-center justify-between gap-1 rounded-lg border px-2 py-1.5 text-left text-[11.5px] font-medium transition-colors",
                      active
                        ? "border-forest bg-forest text-paper"
                        : "border-line bg-paper text-ink/70 hover:border-forest/30 hover:text-forest",
                    )}
                  >
                    <span className="truncate">{entry.name}</span>
                    <span className={cn("text-[9.5px] uppercase tracking-[0.04em]", active ? "text-paper/70" : "text-muted")}>{entry.code}</span>
                  </button>
                );
              })}
              {filteredLanguages.length === 0 && <p className="text-[11.5px] text-muted">No language matches “{languageQuery}”. Clear the search to see all 18.</p>}
            </div>
          </div>

          <RangeField value={range} onChange={setRange} total={pdf.pageCount} label="Pages to OCR" hint="Leave empty for every page (up to 50 per run)." />

          <AdvancedOptions scope="ocr" badge="4 controls" description="Preprocessing and page handling" onReset={opts.reset}>
            <OptionsGrid>
              <div className="flex items-end">
                <Switch
                  checked={grayscale}
                  onChange={(value) => opts.set("grayscale", value)}
                  label="Grayscale before OCR"
                  description="Converts the page image to grey, which often helps faint pencil scans."
                />
              </div>
              <div className="flex items-end">
                <Switch
                  checked={autoRotate}
                  onChange={(value) => opts.set("autoRotate", value)}
                  label="Auto-rotate sideways pages"
                  description="Retries a landscape page turned 90° when the first pass reads poorly, then keeps the better result."
                />
              </div>
              <SliderField
                label="Contrast"
                value={contrast}
                onChange={(value) => opts.set("contrast", value)}
                min={100}
                max={200}
                step={5}
                format={(value) => `${value}%`}
                hint="100% keeps the scan untouched. Raising it darkens text and lightens the paper."
              />
              <div className="flex items-end">
                <Switch
                  checked={skipText}
                  onChange={(value) => opts.set("skipText", value)}
                  label="Skip pages with existing text"
                  description="Keeps digital text intact and OCRs only image pages."
                />
              </div>
            </OptionsGrid>
            <div className="mt-3">
              <OptionNote>
                These settings are remembered on this device. The page range is not: it resets for each document.
              </OptionNote>
            </div>
          </AdvancedOptions>

          {error && <Alert tone="error">{error}</Alert>}
          {warning && <Alert tone="warning">{warning}</Alert>}

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={run} loading={busy} disabled={busy}>
              <ScanText className="h-4 w-4" /> {outputLabel}
            </Button>
            {busy && (
              <Button variant="outline" onClick={cancel}>
                Cancel
              </Button>
            )}
            <span className="text-[11.5px] text-muted">
              {pdf.pageCount} page{pdf.pageCount === 1 ? "" : "s"} · runs locally after a one-time engine download
            </span>
          </div>
          {busy && (
            <Progress
              value={progress}
              label={phase}
              etaMs={etaMs}
              detail={`${Math.max(0, Math.min(pageTotalRef.current, pageIndexRef.current + (pageProgressRef.current > 0 ? 1 : 0)))}/${pageTotalRef.current} pages`}
            />
          )}
        </>
      )}

      {text && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/75">
              Recognised text{pageCount ? ` · ${pageCount} page${pageCount === 1 ? "" : "s"}` : ""}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {confidence !== null && <Badge tone={confidence >= 80 ? "forest" : confidence >= 60 ? "neutral" : "clay"}>≈ {confidence}% confidence</Badge>}
              {rotatedPages.length > 0 && <Badge tone="neutral">{rotatedPages.length} auto-rotated</Badge>}
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  setCopied(await copyText(text));
                  window.setTimeout(() => setCopied(false), 1600);
                }}
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy"}
              </Button>
              <Button variant="outline" size="sm" onClick={downloadText}>
                <Download className="h-3.5 w-3.5" /> .txt
              </Button>
            </div>
          </div>
          <textarea
            value={result ? previewText : text}
            readOnly
            rows={result ? 8 : 10}
            aria-label="Recognised text"
            className="w-full rounded-xl border border-line bg-paper px-3.5 py-2.5 font-mono text-[12px] leading-relaxed"
          />
          <p className="text-[11px] text-muted">
            {text.replace(/\s/g, "").length.toLocaleString()} characters recognised
            {result ? " · the preview above shows the first lines; the .txt download has everything" : ""}.
          </p>
        </div>
      )}

      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Searchable PDF ready"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          onDownload={() => downloadBytes(result.bytes, result.name)}
          facts={[
            { label: "Language", value: selectedLanguage.name },
            { label: "Resolution", value: `${dpi} DPI` },
            ...(confidence !== null ? [{ label: "Confidence", value: `${confidence}%` }] : []),
          ]}
          description={`${result.words.toLocaleString()} words recognised${confidence !== null ? ` · ${confidence}% confidence` : ""} · invisible text layer embedded${result.skipped ? ` · ${result.skipped} page${result.skipped === 1 ? " was" : "s were"} already digital and kept as-is` : ""}`}
        />
      )}

      {!result && text && mode !== "text" && (
        <Alert tone="warning" title="No searchable PDF produced">
          No words were recognised on the selected pages, so there is nothing to embed. Check the language and resolution.
        </Alert>
      )}

      <div className={cn("rounded-xl border border-line bg-bone-deep/30 p-3 text-[11px] leading-relaxed text-muted")}>
        <p className="flex items-center gap-1.5 font-semibold text-ink/75">
          <TextCursorInput className="h-3.5 w-3.5 text-forest" /> Tips for accurate OCR
        </p>
        <ul className="mt-1.5 space-y-0.5">
          <li>• Use at least 200 DPI; 300 DPI helps small print and receipts.</li>
          <li>• Select the exact printed language — mixing languages lowers accuracy.</li>
          <li>• The searchable PDF keeps the original scan appearance; text sits invisibly underneath.</li>
          <li>• Right-to-left and CJK languages work but may have lower confidence.</li>
        </ul>
      </div>

      {!pdf.bytes && !pdf.loading && (
        <div className="flex items-start gap-2 rounded-xl border border-dashed border-line bg-bone-deep/25 px-3.5 py-3 text-[11px] leading-relaxed text-muted">
          <RotateCw className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Scanned pages have no text until they are OCR’d. Add a scanned PDF to build the invisible
          text layer, or choose “Text only” to extract the words without producing a PDF.
        </div>
      )}
    </div>
  );
}
