import { baseName, fileExt, sanitizeName } from "@/lib/format";

/* ------------------------------------------------------------------ *
 * Output engine
 *
 * Everything that happens after "the bytes exist": naming, MIME types,
 * integrity checks, clipboard, share sheet and downloads. Kept free of
 * PDF-engine imports so the app shell can use it without pulling PDF.js
 * or pdf-lib into the first paint.
 * ------------------------------------------------------------------ */

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  zip: "application/zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  txt: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  md: "text/markdown",
  markdown: "text/markdown",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export type OutputKind = "pdf" | "image" | "text" | "archive" | "office" | "other";

export function outputMimeType(nameOrMime?: string): string {
  if (!nameOrMime) return "application/octet-stream";
  if (nameOrMime.includes("/")) return nameOrMime;
  return MIME_BY_EXT[fileExt(nameOrMime)] ?? "application/octet-stream";
}

export function outputKind(mime: string): OutputKind {
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("text/") || mime === "application/json" || mime === "application/xml") return "text";
  if (mime === "application/zip") return "archive";
  if (mime.includes("openxmlformats")) return "office";
  return "other";
}

/** True when the output can be rendered in the in-app preview dialog. */
export function canPreviewOutput(mime: string): boolean {
  return ["pdf", "image", "text"].includes(outputKind(mime));
}

/**
 * Give an output a valid extension. `fallbackName` supplies the extension
 * when the user typed only a stem; `.pdf` / `.docx` etc. are enforced.
 */
export function ensureOutputName(name: string, fallbackName: string): string {
  const requiredExt = fileExt(fallbackName);
  const fallbackStem = sanitizeName(baseName(fallbackName), "paperly-document");
  const cleaned = sanitizeName(name, "") || fallbackStem;
  if (!requiredExt) return cleaned;
  // A bare extension (".pdf") is not a filename — fall back to the source stem.
  if (/^\.[a-z0-9]+$/i.test(cleaned)) return `${fallbackStem}.${requiredExt}`;
  if (cleaned.toLowerCase().endsWith(`.${requiredExt}`)) return cleaned;
  const stem = cleaned.includes(".") ? cleaned.replace(/\.[^.]+$/, "") : cleaned;
  return `${stem || fallbackStem}.${requiredExt}`;
}

/** Split a filename into an editable stem plus its fixed extension. */
export function splitOutputName(filename: string): { stem: string; extension: string } {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return { stem: filename, extension: "" };
  return { stem: filename.slice(0, dot), extension: filename.slice(dot) };
}

/** SHA-256 of the output bytes, hex encoded. Empty string when unavailable. */
export async function sha256Hex(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  try {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (typeof crypto === "undefined" || !crypto.subtle) return "";
    const digest = await crypto.subtle.digest("SHA-256", data as unknown as BufferSource);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return "";
  }
}

export function bytesToBlob(bytes: Uint8Array | ArrayBuffer, mime = "application/octet-stream"): Blob {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // `BlobPart` typing rejects shared-buffer views; a plain copy is safe and small.
  return new Blob([data as unknown as BlobPart], { type: mime });
}

export function downloadOutput(bytes: Uint8Array | ArrayBuffer, filename: string, mime?: string): void {
  const type = mime ?? outputMimeType(filename);
  const url = URL.createObjectURL(bytesToBlob(bytes, type));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Open the output in a new tab. Returns false if the popup was blocked. */
export function openOutputInNewTab(bytes: Uint8Array | ArrayBuffer, filename: string, mime?: string): boolean {
  const type = mime ?? outputMimeType(filename);
  const url = URL.createObjectURL(bytesToBlob(bytes, type));
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  // Revoke late: the new tab reads the blob during its own load.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return Boolean(opened);
}

/** Decode text output for preview/copy. Caps very large files. */
export function outputText(bytes: Uint8Array, maxChars = 400_000): string {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes).slice(0, maxChars);
  } catch {
    return "";
  }
}

/** Copy text or a PNG to the clipboard. Returns false when unsupported. */
export async function copyOutput(bytes: Uint8Array | ArrayBuffer, mime: string): Promise<boolean> {
  const type = outputMimeType(mime);
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    if (type.startsWith("text/") || type === "application/json") {
      await navigator.clipboard.writeText(outputText(data));
      return true;
    }
    if (type === "image/png" && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ [type]: bytesToBlob(data, type) })]);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export type ShareResult = "shared" | "cancelled" | "unsupported" | "failed";

export function canShareOutput(mime: string, bytes = new Uint8Array([0])): boolean {
  try {
    if (typeof navigator === "undefined" || typeof navigator.share !== "function") return false;
    if (typeof navigator.canShare !== "function") return false;
    const probe = new File([bytesToBlob(bytes, mime)], "paperly-output", { type: mime });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

export async function shareOutput(
  bytes: Uint8Array | ArrayBuffer,
  filename: string,
  mime?: string,
): Promise<ShareResult> {
  const type = mime ?? outputMimeType(filename);
  try {
    const file = new File([bytesToBlob(bytes, type)], filename, { type });
    if (typeof navigator === "undefined" || typeof navigator.share !== "function") return "unsupported";
    if (typeof navigator.canShare === "function" && !navigator.canShare({ files: [file] })) return "unsupported";
    await navigator.share({ files: [file], title: filename });
    return "shared";
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") return "cancelled";
    return "failed";
  }
}

/** Short "size saved" label, e.g. "38% smaller". */
export function savedPercentLabel(original: number, output: number): string | null {
  if (!Number.isFinite(original) || original <= 0 || !Number.isFinite(output)) return null;
  const saved = Math.round(((original - output) / original) * 100);
  if (saved <= 0) return null;
  return `${saved}% smaller`;
}

/** A safe default download stem from a source filename. */
export function outputStem(sourceName: string, suffix = ""): string {
  return sanitizeName(`${baseName(sourceName)}${suffix ? `-${suffix}` : ""}`);
}
