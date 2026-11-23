export interface LocalPdfInspection {
  kind: "pdf";
  name: string;
  size: number;
  pages: number;
  encrypted: boolean;
  /** True when the document opens but needs a password to reveal pages. */
  needsPassword: boolean;
  /** Non-whitespace characters found in the sampled pages. */
  textChars: number;
  sampledPages: number;
  /** No meaningful text layer — the file is almost certainly a scan. */
  scanned: boolean;
  title?: string;
  author?: string;
  producer?: string;
  error?: string;
}

function nonWhitespace(value: string): number {
  return value.replace(/\s+/g, "").length;
}

/**
 * Inspect a PDF entirely in this tab.
 *
 * The heavy PDF.js engine is imported dynamically so the landing page itself
 * stays light; once loaded it is cached by the service worker. Only the first
 * few pages are sampled for a text layer, which is enough to distinguish a scan
 * from a digital document without walking a 500-page file.
 */
export async function inspectPdfFile(file: File): Promise<LocalPdfInspection> {
  const base: LocalPdfInspection = {
    kind: "pdf",
    name: file.name,
    size: file.size,
    pages: 0,
    encrypted: false,
    needsPassword: false,
    textChars: 0,
    sampledPages: 0,
    scanned: false,
  };
  try {
    const { openPdfJs, readFileBytes, MAX_PDF_PAGES } = await import("@/lib/pdf");
    const buffer = await readFileBytes(file);
    let doc: Awaited<ReturnType<typeof openPdfJs>>;
    try {
      doc = await openPdfJs(buffer, undefined, { maxPages: MAX_PDF_PAGES });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      const message = (error as { message?: string })?.message ?? "";
      if (name === "PasswordException" || /password/i.test(message)) {
        return { ...base, needsPassword: true, encrypted: true, error: "This PDF needs a password before it can be read." };
      }
      return { ...base, error: message || "This file couldn’t be read as a PDF." };
    }

    const internal = doc as unknown as { _pdfInfo?: { isEncrypted?: boolean } };
    const encrypted = Boolean(internal._pdfInfo?.isEncrypted);
    let title: string | undefined;
    let author: string | undefined;
    let producer: string | undefined;
    try {
      const meta = await doc.getMetadata();
      const info = (meta.info ?? {}) as Record<string, unknown>;
      title = typeof info.Title === "string" ? info.Title : undefined;
      author = typeof info.Author === "string" ? info.Author : undefined;
      producer = typeof info.Producer === "string" ? info.Producer : undefined;
    } catch {
      /* metadata is optional */
    }

    const sampled = Math.min(doc.numPages, 4);
    let textChars = 0;
    for (let index = 1; index <= sampled; index++) {
      try {
        const page = await doc.getPage(index);
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => ("str" in item && typeof item.str === "string" ? item.str : ""))
          .join("");
        textChars += nonWhitespace(text);
      } catch {
        /* a single unreadable page must not fail the whole inspection */
      }
    }
    const pages = doc.numPages;
    await doc.destroy().catch(() => undefined);
    return {
      ...base,
      pages,
      encrypted,
      textChars,
      sampledPages: sampled,
      // A handful of characters can be a page number stamped onto a scan.
      scanned: sampled > 0 && textChars < 30,
      title,
      author,
      producer,
    };
  } catch (error) {
    return { ...base, error: (error as { message?: string })?.message ?? "This file couldn’t be inspected." };
  }
}

export type RecommendationTone = "urgent" | "helpful" | "neutral";

export interface InspectionRecommendation {
  toolId: string;
  reason: string;
  tone: RecommendationTone;
}

/** Turn local facts into one-click, explainable next actions. */
export function recommendationsFor(files: File[], inspection: LocalPdfInspection | null): InspectionRecommendation[] {
  const pdfs = files.filter((file) => /\.pdf$/i.test(file.name) || file.type === "application/pdf");
  if (files.length > 1) {
    const multiple: InspectionRecommendation[] = [
      { toolId: "merge", reason: `${files.length} files — combine them in one PDF`, tone: "urgent" },
      { toolId: "organize", reason: "Reorder and merge every page in one visual grid", tone: "helpful" },
      { toolId: "batch", reason: "Run one operation across all files and download a ZIP", tone: "helpful" },
    ];
    if (pdfs.length > 1 && inspection?.scanned) {
      multiple.unshift({ toolId: "ocr", reason: "The first PDF looks scanned — add a searchable text layer", tone: "urgent" });
    }
    return multiple;
  }
  if (!inspection) return [];
  if (inspection.needsPassword) {
    return [
      { toolId: "unlock", reason: "Password-protected — unlock your own copy first", tone: "urgent" },
      { toolId: "inspect-pdf", reason: "Check the structure without uploading it", tone: "neutral" },
    ];
  }
  if (inspection.scanned) {
    return [
      { toolId: "ocr", reason: "Scanned PDF detected — add a searchable text layer", tone: "urgent" },
      { toolId: "pdf-to-jpg", reason: "No text layer — export the pages as images", tone: "helpful" },
      { toolId: "compress", reason: `${(inspection.size / 1024 / 1024).toFixed(1)} MB scan — shrink it locally`, tone: "helpful" },
    ];
  }
  const actions: InspectionRecommendation[] = [];
  if (inspection.size > 4 * 1024 * 1024) {
    actions.push({ toolId: "compress", reason: `${(inspection.size / 1024 / 1024).toFixed(1)} MB — re-encode images locally`, tone: "urgent" });
  }
  if (inspection.pages > 12) {
    actions.push({ toolId: "split", reason: `${inspection.pages} pages — split or extract a range`, tone: "helpful" });
    actions.push({ toolId: "organize", reason: "Reorder, rotate or remove pages visually", tone: "helpful" });
  }
  actions.push({ toolId: "pdf-to-word", reason: "Selectable text found — convert to an editable document", tone: "neutral" });
  actions.push({ toolId: "inspect-pdf", reason: "See fonts, metadata and risk structures", tone: "neutral" });
  return actions.slice(0, 4);
}
