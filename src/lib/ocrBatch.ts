import {
  PDFDocument,
  dataUrlToBytes,
  embedFonts,
  openPdfJs,
  renderPdfPage,
  safePdfText,
} from "@/lib/pdf";

/**
 * Batch OCR helper.
 *
 * A deliberately small, deterministic version of the interactive OCR tool:
 * every page is rendered locally, recognised by Tesseract in a Web Worker and
 * rebuilt as a searchable PDF (page image + invisible text layer). No page is
 * ever uploaded. The Tesseract engine and language data are the same pinned
 * CDN assets the single-file tool uses, cached by the service worker.
 */
const TESSERACT_VERSION = "6.0.1";
const CORE_VERSION = "6.1.2";
const LANG_PATH = "https://tessdata.projectnaptha.com/4.0.0";
const MAX_BATCH_OCR_PAGES = 50;

interface OcrWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

interface TesseractData {
  text?: string;
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

export async function ocrPdfToSearchable(
  bytes: ArrayBuffer | Uint8Array,
  onProgress: (percent: number, detail: string) => void,
): Promise<Uint8Array> {
  const doc = await openPdfJs(bytes);
  if (doc.numPages > MAX_BATCH_OCR_PAGES) {
    await doc.destroy().catch(() => undefined);
    throw new Error(`Batch OCR handles up to ${MAX_BATCH_OCR_PAGES} pages per file. Split longer documents first.`);
  }
  const total = doc.numPages;
  onProgress(2, "Starting the local OCR engine…");
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng", 1, {
    workerPath: `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/worker.min.js`,
    corePath: `https://cdn.jsdelivr.net/npm/tesseract.js-core@${CORE_VERSION}`,
    langPath: LANG_PATH,
  });
  try {
    const output = await PDFDocument.create();
    const fonts = await embedFonts(output);
    for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
      onProgress(4 + ((pageNumber - 1) / total) * 94, `OCR page ${pageNumber} of ${total}…`);
      const sourcePage = await doc.getPage(pageNumber);
      const viewport = sourcePage.getViewport({ scale: 1 });
      const scale = 200 / 72;
      const rendered = await renderPdfPage(doc, pageNumber, { scale, type: "image/jpeg", quality: 0.9 });
      const recognized = await worker.recognize(rendered.dataUrl, {}, { text: true, blocks: true });
      const data = recognized.data as TesseractData;
      const width = viewport.width;
      const height = viewport.height;
      const page = output.addPage([width, height]);
      const image = await output.embedJpg(dataUrlToBytes(rendered.dataUrl));
      page.drawImage(image, { x: 0, y: 0, width, height });
      for (const word of collectWords(data)) {
        const clean = safePdfText(word.text.trim());
        if (!clean) continue;
        const wordW = (word.bbox.x1 - word.bbox.x0) / scale;
        const wordH = (word.bbox.y1 - word.bbox.y0) / scale;
        if (wordH < 2 || wordW < 2) continue;
        const size = Math.max(4, Math.min(28, wordH * 0.92));
        let fitted = clean;
        let measured = fonts.regular.widthOfTextAtSize(fitted, size);
        if (measured > wordW && wordW > 0) {
          while (fitted.length > 1 && measured > wordW * 1.12) {
            fitted = fitted.slice(0, -1);
            measured = fonts.regular.widthOfTextAtSize(fitted, size);
          }
        }
        page.drawText(fitted, {
          x: word.bbox.x0 / scale,
          y: height - word.bbox.y1 / scale,
          size,
          font: fonts.regular,
          opacity: 0,
        });
      }
    }
    onProgress(98, "Saving the searchable PDF…");
    return await output.save();
  } finally {
    await doc.destroy().catch(() => undefined);
    await worker.terminate().catch(() => undefined);
  }
}
