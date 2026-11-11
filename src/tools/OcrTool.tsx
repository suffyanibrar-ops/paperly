import { Check, Copy, Download, ScanText, TextCursorInput } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { Alert, Button, Field, Progress, Segmented, Select, Switch } from "@/components/ui";
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
  width: number;
  height: number;
  imageDataUrl?: string;
}

type OcrMode = "searchable" | "text";

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

export function OcrTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [language, setLanguage] = useState("eng");
  const [mode, setMode] = useState<OcrMode>("searchable");
  const [range, setRange] = useState("");
  const [dpi, setDpi] = useState<150 | 200 | 300>(200);
  const [skipText, setSkipText] = useState(true);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [text, setText] = useState("");
  const [confidence, setConfidence] = useState<number | null>(null);
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; pages: number; words: number; skipped: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const aliveRef = useRef(true);
  const cancelRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const run = async () => {
    if (!pdf.bytes || !pdf.file) return;
    setBusy(true);
    setError("");
    setWarning("");
    setText("");
    setResult(null);
    setConfidence(null);
    setProgress(1);
    cancelRef.current = false;
    setPhase("Preparing your pages…");

    let worker: Awaited<ReturnType<typeof import("tesseract.js")["createWorker"]>> | null = null;
    try {
      const pages = uniqueInOrder(parseRanges(range, pdf.pageCount));
      if (pages.length > 50) throw new Error("OCR is limited to 50 pages per run. Split the PDF first for longer documents.");

      // Skip pages that already contain a usable text layer.
      let extract: Awaited<ReturnType<typeof extractDocument>> | null = null;
      if (skipText) {
        try {
          extract = await extractDocument(pdf.bytes, { pages });
        } catch {
          extract = null;
        }
      }

      setPhase("Downloading the OCR engine (first run only)…");
      setProgress(4);
      const { createWorker } = await import("tesseract.js");
      worker = await createWorker(language, 1, {
        workerPath: `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/worker.min.js`,
        corePath: `https://cdn.jsdelivr.net/npm/tesseract.js-core@${CORE_VERSION}`,
        langPath: LANG_PATH,
        logger: (message) => {
          if (!aliveRef.current) return;
          if (message.status === "recognizing text") {
            setPhase(`Recognising text · ${Math.round((message.progress ?? 0) * 100)}% of this page`);
          } else if (message.status.includes("language") || message.status.includes("initializ")) {
            setPhase("Loading language data (first run only)…");
          }
        },
      });

      const doc = await openPdfJs(pdf.bytes);
      const output = await PDFDocument.create();
      const fonts = await embedFonts(output);
      const ocrPages: OcrPage[] = [];
      let wordCount = 0;
      let skipped = 0;

      for (let index = 0; index < pages.length; index++) {
        const pageNumber = pages[index];
        if (!aliveRef.current || cancelRef.current) break;
        const existing = extract?.pages.find((p) => p.page === pageNumber)?.text?.replace(/\s/g, "") ?? "";
        const source = await doc.getPage(pageNumber);
        const viewport = source.getViewport({ scale: 1 });

        if (skipText && existing.length > 18) {
          skipped++;
          const [copiedPage] = await output.copyPages(await openPdfLib(pdf.bytes), [pageNumber - 1]);
          output.addPage(copiedPage);
          ocrPages.push({ page: pageNumber, text: "", words: [], confidence: 100, width: viewport.width, height: viewport.height });
          setProgress(8 + ((index + 1) / pages.length) * 88);
          continue;
        }

        setPhase(`Rendering page ${index + 1} of ${pages.length}…`);
        const scale = dpi / 72;
        const rendered = await renderPdfPage(doc, pageNumber, {
          scale,
          type: "image/jpeg",
          quality: 0.92,
        });
        if (cancelRef.current) break;
        const { data } = await worker.recognize(rendered.dataUrl, {}, { text: true, blocks: true });
        if (cancelRef.current) break;
        const typed = data as TesseractData;
        const words = collectWords(typed);
        wordCount += words.length;
        ocrPages.push({
          page: pageNumber,
          text: safePdfText(typed.text ?? ""),
          words,
          confidence: typed.confidence ?? 0,
          width: viewport.width,
          height: viewport.height,
          imageDataUrl: mode === "searchable" ? rendered.dataUrl : undefined,
        });

        if (mode === "searchable") {
          const width = viewport.width;
          const height = viewport.height;
          const page = output.addPage([width, height]);
          const image = await output.embedJpg(dataUrlToBytes(rendered.dataUrl));
          page.drawImage(image, { x: 0, y: 0, width, height });
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
        setProgress(8 + ((index + 1) / pages.length) * 88);
      }
      await doc.destroy();

      if (cancelRef.current) {
        setProgress(0);
        setWarning("OCR cancelled. Pages processed before cancellation were discarded and no file was generated.");
        return;
      }
      const allText = ocrPages.map((p) => `— Page ${p.page} —\n${p.text}`).join("\n\n");
      setText(allText);
      const confidences = ocrPages.filter((p) => p.words.length).map((p) => p.confidence);
      setConfidence(confidences.length ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length) : null);
      if (!wordCount) {
        setWarning("No text was recognised. Try a higher resolution, a straighter scan or the correct language.");
      }
      if (skipped) {
        setWarning(`Skipped ${skipped} page${skipped === 1 ? "" : "s"} that already had a text layer.`);
      }

      if (mode === "searchable" && wordCount > 0) {
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
    } catch (err) {
      const message = (err as Error).message || "OCR failed.";
      setError(
        /fetch|network|load|worker/i.test(message)
          ? "The OCR engine couldn’t be downloaded. Check your internet connection and try again — language data is fetched once, then cached."
          : message,
      );
    } finally {
      if (worker) {
        try {
          await worker.terminate();
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
            <Field label="Output">
              <Segmented
                value={mode}
                onChange={setMode}
                size="sm"
                options={[
                  { value: "searchable", label: "Searchable PDF" },
                  { value: "text", label: "Text only" },
                ]}
              />
            </Field>
            <Field label="Document language" hint="Pick the language printed on the page.">
              <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Recognition resolution" hint="Higher is slower but more accurate.">
              <Select value={dpi} onChange={(e) => setDpi(Number(e.target.value) as 150 | 200 | 300)}>
                <option value={150}>Fast · 150 DPI</option>
                <option value={200}>Recommended · 200 DPI</option>
                <option value={300}>Maximum · 300 DPI</option>
              </Select>
            </Field>
            <div className="pt-4">
              <Switch
                checked={skipText}
                onChange={setSkipText}
                label="Skip pages with existing text"
                description="Keeps digital text intact and OCRs only image pages"
              />
            </div>
          </div>
          <RangeField value={range} onChange={setRange} total={pdf.pageCount} label="Pages to OCR" hint="Leave empty for every page (up to 50 per run)." />

          {error && <Alert tone="error">{error}</Alert>}
          {warning && <Alert tone="warning">{warning}</Alert>}

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={run} loading={busy} disabled={busy}>
              <ScanText className="h-4 w-4" /> {mode === "searchable" ? "OCR PDF" : "Extract text with OCR"}
            </Button>
            {busy && (
              <Button
                variant="outline"
                onClick={() => {
                  cancelRef.current = true;
                  setPhase("Cancelling after the current page…");
                }}
              >
                Cancel
              </Button>
            )}
            <span className="text-[11.5px] text-muted">
              {pdf.pageCount} page{pdf.pageCount === 1 ? "" : "s"} · runs locally after a one-time engine download
            </span>
          </div>
          {busy && <Progress value={progress} label={phase} />}
        </>
      )}

      {text && !result && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/75">Recognised text</p>
            <div className="flex items-center gap-2">
              {confidence !== null && <span className="text-[11px] text-muted">≈ {confidence}% confidence</span>}
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  setCopied(await copyText(text));
                  setTimeout(() => setCopied(false), 1600);
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
            value={text}
            readOnly
            rows={10}
            className="w-full rounded-xl border border-line bg-paper px-3.5 py-2.5 font-mono text-[12px] leading-relaxed"
          />
          <p className="text-[11px] text-muted">{text.replace(/\s/g, "").length.toLocaleString()} characters recognised.</p>
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
          description={`${result.words.toLocaleString()} words recognised${confidence !== null ? ` · ${confidence}% confidence` : ""} · invisible text layer embedded${result.skipped ? ` · ${result.skipped} page${result.skipped === 1 ? " was" : "s were"} already digital and kept as-is` : ""}`}
        />
      )}

      {!result && text && mode === "searchable" && (
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
    </div>
  );
}
