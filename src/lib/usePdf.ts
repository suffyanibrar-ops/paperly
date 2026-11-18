import { useEffect, useState } from "react";
import { MAX_PDF_PAGES, openPdfJs, readablePdfError, readFileBytes, renderPdfPage, type RenderedPage } from "@/lib/pdf";
import { friendlyProcessingError, validateUpload, type ValidatedFile } from "@/lib/security";
import { currentPath, takeStashedFiles } from "@/lib/router";

export function usePdfFile(initialFiles: File[] = []) {
  const [file, setFile] = useState<File | null>(() => initialFiles.find((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf") ?? null);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [loading, setLoading] = useState(Boolean(file));
  const [error, setError] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [nonce, setNonce] = useState(0);

  const [validated, setValidated] = useState<ValidatedFile | null>(null);

  useEffect(() => {
    if (!file) {
      setBytes(null);
      setPageCount(0);
      setLoading(false);
      setValidated(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError("");
    setNeedsPassword(false);
    (async () => {
      // Size, extension and magic-byte validation before any parser runs.
      const checked = await validateUpload(file, "application/pdf,.pdf");
      if (!alive) return;
      setValidated(checked);
      const buffer = await readFileBytes(file);
      const doc = await openPdfJs(buffer, undefined, { maxPages: MAX_PDF_PAGES });
      if (!alive) {
        await doc.destroy();
        return;
      }
      setBytes(buffer);
      setPageCount(doc.numPages);
      await doc.destroy();
    })()
      .catch((err) => {
        if (!alive) return;
        setBytes(null);
        setValidated(null);
        setNeedsPassword(Boolean((err as { name?: string })?.name === "PasswordException"));
        setError(readablePdfError(err));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [file, nonce]);

  return {
    file,
    validated,
    bytes,
    pageCount,
    loading,
    error,
    needsPassword,
    setFile: (f: File | null) => {
      setFile(f);
      if (!f) setBytes(null);
    },
    reload: () => setNonce((n) => n + 1),
    clear: () => {
      setFile(null);
      setBytes(null);
      setPageCount(0);
      setError("");
    },
  };
}

export function useInitialFiles(): File[] {
  const [files] = useState<File[]>(() => takeStashedFiles(currentPath()));
  return files;
}

export interface Thumb extends RenderedPage {
  page: number;
}

export function usePdfThumbs(
  bytes: ArrayBuffer | null,
  opts: { width?: number; quality?: number; max?: number; enabled?: boolean } = {},
) {
  const { width = 180, quality = 0.72, max = 150, enabled = true } = opts;
  const [thumbs, setThumbs] = useState<Thumb[]>([]);
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!bytes || !enabled) {
      setThumbs([]);
      setProgress(0);
      setTotal(0);
      return;
    }
    let alive = true;
    setLoading(true);
    setError("");
    setThumbs([]);
    (async () => {
      const doc = await openPdfJs(bytes, undefined, { maxPages: MAX_PDF_PAGES });
      if (!alive) return;
      const count = Math.min(doc.numPages, max);
      setTotal(doc.numPages);
      const results: Thumb[] = [];
      for (let i = 1; i <= count; i++) {
        const rendered = await renderPdfPage(doc, i, { targetWidth: width, type: "image/jpeg", quality });
        if (!alive) break;
        results.push({ ...rendered, page: i });
        setThumbs([...results]);
        setProgress(i);
      }
      await doc.destroy();
    })()
      .catch((err) => alive && setError(friendlyProcessingError(err, readablePdfError(err))))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [bytes, width, quality, max, enabled]);

  return { thumbs, progress, total, loading, error };
}

export interface LoadedFileError {
  message: string;
  isPassword: boolean;
}

export function fileLoadError(err: unknown): LoadedFileError {
  return {
    message: readablePdfError(err),
    isPassword: Boolean((err as { name?: string })?.name === "PasswordException"),
  };
}
