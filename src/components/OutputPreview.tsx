import { ChevronLeft, ChevronRight, ExternalLink, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui";
import { useEscape } from "@/lib/hotkeys";
import type { ManagedPdfDocument } from "@/lib/pdf";
import { bytesToBlob, canPreviewOutput, openOutputInNewTab, outputKind, outputText } from "@/lib/output";
import { cn } from "@/utils/cn";

/* ------------------------------------------------------------------ *
 * In-app output preview
 *
 * A private, CSP-safe preview: PDFs are rendered to a canvas by PDF.js,
 * images use a short-lived blob URL, text is decoded locally. No iframe,
 * no object URL navigation, no upload.
 * ------------------------------------------------------------------ */

export function OutputPreview({
  bytes,
  filename,
  mime,
  onClose,
  onDownload,
}: {
  bytes: Uint8Array;
  filename: string;
  mime: string;
  onClose: () => void;
  onDownload?: () => void;
}) {
  const kind = outputKind(mime);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [imageSrc, setImageSrc] = useState("");
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEscape(onClose);

  // Focus the close button and lock background scrolling while open.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Image + text previews are synchronous and cheap.
  useEffect(() => {
    setError("");
    if (kind === "image") {
      setLoading(false);
      const url = URL.createObjectURL(bytesToBlob(bytes, mime));
      setImageSrc(url);
      return () => URL.revokeObjectURL(url);
    }
    if (kind === "text") {
      setLoading(false);
      setText(outputText(bytes));
      return;
    }
    if (kind !== "pdf") {
      setLoading(false);
      setError("This output type can’t be previewed here. Download it to open it in its native app.");
    }
  }, [bytes, kind, mime]);

  // Open the PDF once, then render pages against the same document. Reopening
  // per page would re-parse the whole file on every arrow click.
  const docRef = useRef<ManagedPdfDocument | null>(null);
  const [openedAt, setOpenedAt] = useState(0);

  useEffect(() => {
    if (kind !== "pdf") return;
    let alive = true;
    setLoading(true);
    setError("");
    (async () => {
      try {
        const { openPdfJs } = await import("@/lib/pdf");
        const doc = await openPdfJs(bytes);
        if (!alive) {
          await doc.destroy();
          return;
        }
        docRef.current = doc;
        setPageCount(doc.numPages);
        setOpenedAt(Date.now());
      } catch (err) {
        if (alive) {
          setError((err as Error).message || "The preview couldn’t be rendered.");
          setLoading(false);
        }
      }
    })();
    return () => {
      alive = false;
      const doc = docRef.current;
      docRef.current = null;
      void doc?.destroy();
    };
  }, [bytes, kind]);

  // PDF pages are rendered one at a time so huge files never build a giant canvas.
  useEffect(() => {
    if (kind !== "pdf" || !docRef.current) return;
    const doc = docRef.current;
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const { renderPdfPage } = await import("@/lib/pdf");
        const target = Math.min(Math.max(1, page), doc.numPages);
        if (target !== page) {
          setPage(target);
          return;
        }
        const rendered = await renderPdfPage(doc, target, { targetWidth: 900, type: "image/jpeg", quality: 0.9 });
        if (alive) setImageSrc(rendered.dataUrl);
      } catch (err) {
        if (alive) setError((err as Error).message || "The preview couldn’t be rendered.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [bytes, kind, page, openedAt]);

  if (!canPreviewOutput(mime)) return null;
  const total = pageCount ?? 1;

  const dialog = (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-ink/70 p-3 backdrop-blur-sm sm:p-6"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Preview of ${filename}`}
        className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-paper/15 bg-paper shadow-lift"
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5 sm:px-4">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold">{filename}</span>
            <span className="block text-[11px] text-muted">
              Local preview · nothing is uploaded
              {kind === "pdf" && pageCount ? ` · page ${page} of ${pageCount}` : ""}
            </span>
          </span>
          {kind === "pdf" && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="Previous page"
                disabled={page <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-line text-ink/70 transition-colors hover:border-forest/30 hover:text-forest disabled:opacity-30"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label="Next page"
                disabled={page >= total}
                onClick={() => setPage((value) => Math.min(total, value + 1))}
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-line text-ink/70 transition-colors hover:border-forest/30 hover:text-forest disabled:opacity-30"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
          <button
            type="button"
            aria-label="Open in a new tab"
            title="Open in a new tab"
            onClick={() => openOutputInNewTab(bytes, filename, mime)}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-line text-ink/70 transition-colors hover:border-forest/30 hover:text-forest"
          >
            <ExternalLink className="h-4 w-4" />
          </button>
          {onDownload && (
            <Button size="sm" variant="outline" onClick={onDownload} className="hidden sm:inline-flex">
              Download
            </Button>
          )}
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-line text-ink/70 transition-colors hover:border-clay/40 hover:text-clay-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-[45vh] flex-1 overflow-auto bg-bone-deep/50 p-3 sm:p-6">
          {loading ? (
            <div className="flex min-h-[40vh] flex-col items-center justify-center gap-2 text-[12px] text-muted">
              <Loader2 className="h-5 w-5 animate-spin text-forest" />
              Rendering a local preview…
            </div>
          ) : error ? (
            <div className="mx-auto max-w-md rounded-xl border border-clay/20 bg-clay/[0.05] p-4 text-center text-[12.5px] text-clay-ink">
              {error}
            </div>
          ) : kind === "text" ? (
            <pre className="mx-auto max-w-3xl whitespace-pre-wrap break-words rounded-xl border border-line bg-paper p-4 font-mono text-[12px] leading-relaxed text-ink/85">
              {text || "This text file is empty."}
            </pre>
          ) : (
            <img
              src={imageSrc}
              alt={`Preview of ${filename}`}
              className={cn(
                "mx-auto block rounded-lg border border-line bg-white shadow-soft",
                kind === "pdf" ? "w-full max-w-[900px]" : "max-h-[75vh] w-auto",
              )}
            />
          )}
        </div>
      </div>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(dialog, document.body) : dialog;
}
