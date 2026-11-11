import DOMPurify from "dompurify";

/* ================================================================== *
 * Upload limits + file-signature validation
 * Never trust the extension or the browser-reported MIME type.
 * ================================================================== */
export const LIMITS = {
  pdfBytes: 200 * 1024 * 1024,
  docxBytes: 50 * 1024 * 1024,
  xlsxBytes: 25 * 1024 * 1024,
  pptxBytes: 80 * 1024 * 1024,
  imageBytes: 40 * 1024 * 1024,
  textBytes: 5 * 1024 * 1024,
  csvBytes: 25 * 1024 * 1024,
  htmlBytes: 2 * 1024 * 1024,
  pdfPages: 1000,
  imagePages: 200,
  zipEntries: 4000,
  zipRatio: 200,
  zipUncompressed: 512 * 1024 * 1024,
  canvasPixels: 40_000_000,
  htmlChars: 2_000_000,
} as const;

export type FileKind = "pdf" | "image" | "docx" | "xlsx" | "pptx" | "html" | "markdown" | "text" | "csv" | "unknown";

export class UploadError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "UploadError";
    this.code = code;
  }
}

export function formatLimit(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

const EXT_KIND: Record<string, FileKind> = {
  pdf: "pdf",
  jpg: "image",
  jpeg: "image",
  png: "image",
  webp: "image",
  gif: "image",
  avif: "image",
  heic: "image",
  bmp: "image",
  tif: "image",
  tiff: "image",
  docx: "docx",
  xlsx: "xlsx",
  xls: "xlsx",
  pptx: "pptx",
  html: "html",
  htm: "html",
  md: "markdown",
  markdown: "markdown",
  txt: "text",
  csv: "csv",
};

export function extensionOf(name: string): string {
  return (name.split(".").pop() ?? "").toLowerCase();
}

export function kindForFile(file: File): FileKind {
  return EXT_KIND[extensionOf(file.name)] ?? "unknown";
}

/** Accepted-kinds derived from the tool's `accept` string. */
export function kindsForAccept(accept: string): Set<FileKind> {
  const kinds = new Set<FileKind>();
  const tokens = accept.split(",").map((token) => token.trim().toLowerCase()).filter(Boolean);
  for (const token of tokens) {
    if (token === "*" || token === "*/*") {
      (Object.keys(EXT_KIND) as string[]).forEach((ext) => kinds.add(EXT_KIND[ext]));
      kinds.add("unknown");
      continue;
    }
    if (token.startsWith(".")) {
      const kind = EXT_KIND[token.slice(1)];
      if (kind) kinds.add(kind);
      continue;
    }
    if (token.startsWith("application/pdf")) kinds.add("pdf");
    else if (token === "text/csv") kinds.add("csv");
    else if (token === "text/html") kinds.add("html");
    else if (token.startsWith("text/markdown")) kinds.add("markdown");
    else if (token === "text/plain") kinds.add("text");
    else if (token.startsWith("image/")) kinds.add("image");
    else if (token.includes("wordprocessingml")) kinds.add("docx");
    else if (token.includes("spreadsheetml") || token.includes("ms-excel")) kinds.add("xlsx");
    else if (token.includes("presentationml") || token.includes("ms-powerpoint")) kinds.add("pptx");
  }
  return kinds;
}

function limitFor(kind: FileKind): number {
  switch (kind) {
    case "pdf":
      return LIMITS.pdfBytes;
    case "docx":
      return LIMITS.docxBytes;
    case "xlsx":
      return LIMITS.xlsxBytes;
    case "pptx":
      return LIMITS.pptxBytes;
    case "image":
      return LIMITS.imageBytes;
    case "html":
      return LIMITS.htmlBytes;
    case "csv":
      return LIMITS.csvBytes;
    default:
      return LIMITS.textBytes;
  }
}

/** Read only the first bytes needed for signature checks. */
export async function readHead(file: Blob, length = 512): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, length).arrayBuffer());
}

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  signature.every((value, index) => bytes[offset + index] === value);

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  Array.from(bytes.subarray(start, end)).map((b) => String.fromCharCode(b)).join("");

export function detectSignature(head: Uint8Array): FileKind | null {
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46])) return "pdf"; // %PDF
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image"; // PNG
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image"; // JPEG
  if (/^GIF8[79]a$/.test(ascii(head, 0, 6))) return "image";
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") return "image";
  if (ascii(head, 0, 2) === "BM") return "image";
  if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) return "image";
  if (ascii(head, 4, 8) === "ftyp") {
    const brand = ascii(head, 8, 12).toLowerCase();
    if (["avif", "avis", "heic", "heix", "hevc", "mif1", "msf1"].some((b) => brand.startsWith(b))) return "image";
  }
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) return "unknown"; // ZIP container: refined by extension + entries
  if (ascii(head, 0, 5) === "{\\rtf") return "unknown";
  return null;
}

const ZIP_KIND: Partial<Record<FileKind, RegExp>> = {
  docx: /^word\//,
  xlsx: /^xl\//,
  pptx: /^ppt\//,
};

export interface ZipEntryInfo {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  encrypted: boolean;
  dataDescriptor: boolean;
}

export interface ZipInspection {
  entries: ZipEntryInfo[];
  totalUncompressed: number;
  totalCompressed: number;
  hasContentTypes: boolean;
  commentLength: number;
  zip64: boolean;
}

const ZIP_EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;
const MAX_CENTRAL_DIRECTORY = 64 * 1024 * 1024;

function uint64(view: DataView, offset: number): number {
  const low = view.getUint32(offset, true);
  const high = view.getUint32(offset + 4, true);
  // Values above 2^53 are never legitimate for a browser-processed document.
  if (high > 0x001fffff) throw new UploadError("zip-size", "This archive declares an impossible file size.");
  return high * 0x100000000 + low;
}

/** Locate and return the end-of-central-directory record (ZIP32 or ZIP64). */
function findEndOfCentralDirectory(bytes: Uint8Array, view: DataView) {
  if (bytes.length < 22) throw new UploadError("zip-invalid", "That file is not a valid Office document.");
  const floor = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= floor; offset--) {
    if (view.getUint32(offset, true) === ZIP_EOCD) {
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength === bytes.length) {
        eocd = offset;
        break;
      }
    }
  }
  if (eocd < 0) {
    throw new UploadError("zip-truncated", "This archive is truncated or has no central directory, so it cannot be verified safely.");
  }

  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  if (disk !== 0 || centralDisk !== 0) {
    throw new UploadError("zip-multidisk", "Multi-volume archives aren’t supported.");
  }
  let count = view.getUint16(eocd + 10, true);
  let centralSize = view.getUint32(eocd + 12, true);
  let centralOffset = view.getUint32(eocd + 16, true);
  const commentLength = view.getUint16(eocd + 20, true);
  let zip64 = false;

  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || view.getUint32(locator, true) !== ZIP64_LOCATOR) {
      throw new UploadError("zip-truncated", "This ZIP64 archive is missing its end-of-directory locator.");
    }
    const zip64Offset = uint64(view, locator + 8);
    if (zip64Offset + 56 > bytes.length || view.getUint32(zip64Offset, true) !== ZIP64_EOCD) {
      throw new UploadError("zip-truncated", "This ZIP64 archive has a damaged central directory.");
    }
    if (view.getUint32(zip64Offset + 16, true) !== 0 || view.getUint32(zip64Offset + 20, true) !== 0) {
      throw new UploadError("zip-multidisk", "Multi-volume archives aren’t supported.");
    }
    count = uint64(view, zip64Offset + 32);
    centralSize = uint64(view, zip64Offset + 40);
    centralOffset = uint64(view, zip64Offset + 48);
    zip64 = true;
  }

  if (count > LIMITS.zipEntries) {
    throw new UploadError("zip-entries", "This archive contains too many files to process safely.");
  }
  if (centralSize > MAX_CENTRAL_DIRECTORY || centralSize > bytes.length) {
    throw new UploadError("zip-invalid", "This archive declares an impossible central directory.");
  }
  if (centralOffset + centralSize > bytes.length) {
    throw new UploadError("zip-truncated", "The central directory extends beyond the end of the file.");
  }
  return { count, centralSize, centralOffset, commentLength, zip64 };
}

/**
 * Validate an Office Open XML archive using its central directory.
 *
 * Central-directory validation is authoritative: local headers may zero their
 * sizes and defer them to a trailing data descriptor (general-purpose flag bit
 * 3), so scanning local headers cannot detect bombs or lies. This routine:
 *  - rejects truncated/multi-disk/inconsistent archives;
 *  - reads trusted sizes from the central directory (including ZIP64 extras);
 *  - rejects encrypted entries, duplicate names, unsafe paths and null bytes;
 *  - enforces per-entry and aggregate expansion ratios and size caps;
 *  - confirms every entry's local header exists with a matching name.
 */
export function inspectZip(bytes: Uint8Array): ZipInspection {
  if (bytes.length < 22 || !startsWith(bytes, [0x50, 0x4b])) {
    throw new UploadError("not-zip", "That file is not a valid Office document.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { count, centralSize, centralOffset, commentLength, zip64 } = findEndOfCentralDirectory(bytes, view);
  if (count === 0) throw new UploadError("zip-empty", "That Office document appears to be empty or damaged.");

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const entries: ZipEntryInfo[] = [];
  const names = new Set<string>();
  let offset = centralOffset;
  const directoryEnd = centralOffset + centralSize;
  let totalUncompressed = 0;
  let totalCompressed = 0;
  let hasContentTypes = false;

  for (let index = 0; index < count; index++) {
    if (offset + 46 > directoryEnd || offset + 46 > bytes.length) {
      throw new UploadError("zip-truncated", "The central directory ended unexpectedly.");
    }
    if (view.getUint32(offset, true) !== ZIP_CENTRAL) {
      throw new UploadError("zip-invalid", "The central directory contains an invalid entry.");
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    let compressedSize = view.getUint32(offset + 20, true);
    let uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const entryCommentLength = view.getUint16(offset + 32, true);
    const diskStart = view.getUint16(offset + 34, true);
    let localHeaderOffset = view.getUint32(offset + 42, true);
    const next = offset + 46 + nameLength + extraLength + entryCommentLength;
    if (next > directoryEnd) throw new UploadError("zip-truncated", "A central-directory entry extends beyond the directory.");
    if (nameLength === 0 || nameLength > 512) throw new UploadError("zip-name", "This archive contains an invalid file name.");
    if (diskStart !== 0) throw new UploadError("zip-multidisk", "Multi-volume archives aren’t supported.");

    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    if (rawName.includes(0)) throw new UploadError("zip-name", "This archive contains a file name with a null byte.");

    // ZIP64 extended information extra field (header id 0x0001).
    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      let extra = offset + 46 + nameLength;
      const extraEnd = extra + extraLength;
      let found = false;
      while (extra + 4 <= extraEnd) {
        const id = view.getUint16(extra, true);
        const size = view.getUint16(extra + 2, true);
        const dataStart = extra + 4;
        if (dataStart + size > extraEnd) throw new UploadError("zip-invalid", "An archive extra field is malformed.");
        if (id === 0x0001) {
          let cursor = dataStart;
          if (uncompressedSize === 0xffffffff && cursor + 8 <= dataStart + size) {
            uncompressedSize = uint64(view, cursor);
            cursor += 8;
          }
          if (compressedSize === 0xffffffff && cursor + 8 <= dataStart + size) {
            compressedSize = uint64(view, cursor);
            cursor += 8;
          }
          if (localHeaderOffset === 0xffffffff && cursor + 8 <= dataStart + size) {
            localHeaderOffset = uint64(view, cursor);
          }
          found = true;
        }
        extra = dataStart + size;
      }
      if (!found) throw new UploadError("zip-invalid", "This ZIP64 archive is missing required size information.");
    }

    if (method !== 0 && method !== 8) {
      throw new UploadError("zip-method", "This archive uses an unsupported compression method.");
    }
    const encrypted = (flags & 0x0001) !== 0 || (flags & 0x0040) !== 0;
    if (encrypted) {
      throw new UploadError("zip-encrypted", "Password-protected Office files aren’t supported. Remove the password and try again.");
    }

    const name = decoder.decode(rawName).replace(/\\/g, "/");
    if (!name || name.endsWith("/")) {
      // directory entry — still validated for traversal, not counted as content
      if (name.includes("\u0000")) throw new UploadError("zip-name", "This archive contains an invalid file name.");
    }
    const segments = name.split("/");
    const unsafe =
      name.startsWith("/") ||
      /^[a-z]:/i.test(name) ||
      segments.some((segment) => segment === ".." || segment === ".") ||
      Array.from(name).some((character) => character.charCodeAt(0) < 0x20);
    if (unsafe) throw new UploadError("zip-path", "This archive contains an unsafe path.");

    const lower = name.toLowerCase();
    if (names.has(lower) && !name.endsWith("/")) {
      throw new UploadError("zip-duplicate", "This archive contains duplicate entries and cannot be verified safely.");
    }
    names.add(lower);
    if (name === "[Content_Types].xml") hasContentTypes = true;

    if (localHeaderOffset + 30 > bytes.length) {
      throw new UploadError("zip-truncated", "An archive entry points outside the file.");
    }
    if (view.getUint32(localHeaderOffset, true) !== ZIP_LOCAL) {
      throw new UploadError("zip-invalid", "An archive entry has an inconsistent local header.");
    }
    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const localNameStart = localHeaderOffset + 30;
    if (localNameLength !== nameLength || localNameStart + localNameLength > bytes.length) {
      throw new UploadError("zip-invalid", "An archive entry has a mismatched local header name.");
    }
    const localName = decoder.decode(bytes.subarray(localNameStart, localNameStart + localNameLength)).replace(/\\/g, "/");
    if (localName !== name) {
      throw new UploadError("zip-invalid", "An archive entry has a mismatched local header name.");
    }
    const localHeaderFlags = view.getUint16(localHeaderOffset + 6, true);
    if ((localHeaderFlags & 0x0001) !== 0 || (localHeaderFlags & 0x0040) !== 0) {
      throw new UploadError("zip-encrypted", "Password-protected Office files aren’t supported. Remove the password and try again.");
    }

    if (uncompressedSize > 0 && compressedSize === 0) {
      throw new UploadError("zip-invalid", "An archive entry declares content with no stored data.");
    }
    const dataStart = localNameStart + localNameLength + localExtraLength;
    if (dataStart + compressedSize > bytes.length) {
      throw new UploadError("zip-truncated", "An archive entry’s data extends beyond the file.");
    }
    // Compressed payloads must live before the central directory and must not overlap it.
    if (compressedSize > 0 && dataStart + compressedSize > centralOffset) {
      throw new UploadError("zip-invalid", "An archive entry overlaps the central directory.");
    }
    if (uncompressedSize > 512 * 1024 * 1024) {
      throw new UploadError("zip-size", "An archive entry expands beyond the safe processing limit.");
    }
    if (compressedSize > 0 && uncompressedSize / compressedSize > 120 && uncompressedSize > 1024 * 1024) {
      throw new UploadError("zip-bomb", "An archive entry expands abnormally and was blocked to protect your device.");
    }

    totalUncompressed += uncompressedSize;
    totalCompressed += compressedSize;
    if (totalUncompressed > LIMITS.zipUncompressed) {
      throw new UploadError("zip-size", "The expanded document is too large to process in a browser.");
    }

    entries.push({
      name,
      flags,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      encrypted,
      dataDescriptor: (flags & 0x0008) !== 0,
    });
    offset = next;
  }

  if (offset > directoryEnd) throw new UploadError("zip-invalid", "The central directory is malformed.");
  if (entries.length !== count) throw new UploadError("zip-invalid", "The archive entry count does not match its directory.");
  if (totalCompressed > 0 && totalUncompressed / Math.max(1, totalCompressed) > LIMITS.zipRatio) {
    throw new UploadError("zip-bomb", "This archive expands abnormally and was blocked to protect your device.");
  }
  return { entries, totalUncompressed, totalCompressed, hasContentTypes, commentLength, zip64 };
}

/** Validate an Office archive and confirm it matches the claimed format. */
export async function assertZipSafe(file: Blob, expected?: "docx" | "xlsx" | "pptx"): Promise<ZipInspection> {
  const inspection = inspectZip(new Uint8Array(await file.arrayBuffer()));
  if (expected) {
    if (!inspection.hasContentTypes) {
      throw new UploadError("zip-invalid", "That file is not a valid Office Open XML document.");
    }
    if (!inspection.entries.some((entry) => ZIP_KIND[expected]?.test(entry.name))) {
      throw new UploadError("zip-mismatch", `That file doesn’t look like a .${expected} document.`);
    }
  }
  return inspection;
}

export interface ValidatedFile {
  file: File;
  kind: FileKind;
  size: number;
}

/**
 * Validate size, type and (where practical) magic bytes before any parser runs.
 * Throws UploadError with a message that is safe to show to the user.
 */
export async function validateUpload(file: File, accept = ""): Promise<ValidatedFile> {
  if (!(file instanceof File)) throw new UploadError("not-a-file", "That item isn’t a file.");
  const kind = kindForFile(file);
  const allowed = accept ? kindsForAccept(accept) : null;

  if (allowed && !allowed.has("unknown") && !allowed.has(kind)) {
    const labels = [...allowed].map((k) => (k === "image" ? "images" : k.toUpperCase())).join(", ");
    throw new UploadError("type", `${file.name} isn’t supported here. Add ${labels} files.`);
  }
  if (kind === "unknown") {
    throw new UploadError("type", `${file.name} isn’t a supported file type.`);
  }
  const limit = limitFor(kind);
  if (file.size === 0) throw new UploadError("empty", `${file.name} is empty.`);
  if (file.size > limit) {
    throw new UploadError("size", `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. The safe limit for this tool is ${formatLimit(limit)}.`);
  }

  if (kind === "ooxml" as FileKind) {
    // defensive: never reached, keeps TS exhaustive
  }

  if (kind === "pdf") {
    const head = await readHead(file, 1024);
    if (!new TextDecoder("latin1").decode(head).includes("%PDF-")) {
      throw new UploadError("signature", `${file.name} doesn’t look like a real PDF. The file may be damaged or mislabelled.`);
    }
  } else if (kind === "image") {
    const head = await readHead(file);
    if (detectSignature(head) !== "image") {
      throw new UploadError("signature", `${file.name} isn’t a valid image we can read.`);
    }
  } else if (kind === "docx" || kind === "xlsx" || kind === "pptx") {
    if (extensionOf(file.name) === "xls") {
      const head = await readHead(file, 8);
      if (!startsWith(head, [0xd0, 0xcf, 0x11, 0xe0])) throw new UploadError("signature", `${file.name} isn’t a valid Excel 97–2003 file.`);
    } else {
      await assertZipSafe(file, kind);
    }
  } else if (kind === "html" || kind === "markdown" || kind === "text" || kind === "csv") {
    const head = await readHead(file, 256);
    if (head.includes(0)) throw new UploadError("signature", `${file.name} looks like a binary file, not text.`);
  }

  return { file, kind, size: file.size };
}

/* ================================================================== *
 * HTML sanitisation — allowlist only, no scripts, no remote resources
 * ================================================================== */
export const HTML_ALLOWED_TAGS = [
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr", "span", "div",
  "strong", "b", "em", "i", "u", "s", "del", "ins", "mark", "small", "sub", "sup",
  "blockquote", "pre", "code", "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  "a", "img", "figure", "figcaption", "section", "article", "header", "footer", "main",
];

/** Inline CSS properties that are safe for a printed document. */
const SAFE_CSS_PROPERTIES = new Set([
  "color", "background-color", "background", "font-family", "font-size", "font-weight", "font-style",
  "font-variant", "text-align", "text-decoration", "text-transform", "text-indent", "text-shadow",
  "line-height", "letter-spacing", "word-spacing", "white-space", "vertical-align", "list-style",
  "list-style-type", "list-style-position", "margin", "margin-top", "margin-right", "margin-bottom",
  "margin-left", "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border", "border-top", "border-right", "border-bottom", "border-left", "border-color",
  "border-style", "border-width", "border-radius", "border-collapse", "border-spacing",
  "width", "min-width", "max-width", "height", "min-height", "max-height", "float", "clear",
  "display", "opacity", "overflow-wrap", "word-break", "column-count", "column-gap", "page-break-after",
]);

/** Remove unsafe declarations (url(), expression(), @import, behaviours, position:fixed overlays). */
export function sanitizeCssText(css: string): { css: string; removed: number } {
  let removed = 0;
  const declarations = css.split(";");
  const output: string[] = [];
  for (const declaration of declarations) {
    const trimmed = declaration.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf(":");
    if (index < 0) {
      removed++;
      continue;
    }
    const property = trimmed.slice(0, index).trim().toLowerCase();
    const value = trimmed.slice(index + 1).trim();
    const unsafe =
      !SAFE_CSS_PROPERTIES.has(property) ||
      /url\s*\(|expression\s*\(|@import|javascript:|vbscript:|behavior\s*:|binding\s*:|-moz-binding|position\s*:\s*(fixed|absolute|sticky)|z-index/i.test(value) ||
      /[<>]/.test(value);
    if (unsafe) {
      removed++;
      continue;
    }
    output.push(`${property}: ${value}`);
  }
  return { css: output.join("; "), removed };
}

export interface SanitizedHtml {
  html: string;
  removedElements: number;
  removedAttributes: number;
  blockedImages: number;
}

/**
 * Sanitise untrusted HTML with DOMPurify using a strict allowlist.
 * Remote/script URLs are removed; only inline data images are permitted.
 */
export function sanitizeHtml(input: string): SanitizedHtml {
  const removedCount = { elements: 0, attributes: 0, images: 0, css: 0 };
  const purifier = DOMPurify(window);
  let sanitized = purifier.sanitize(input, {
    ALLOWED_TAGS: HTML_ALLOWED_TAGS,
    ALLOWED_ATTR: ["style", "class", "colspan", "rowspan", "href", "src", "alt", "title", "width", "height", "align"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "button", "select", "textarea", "link", "meta", "base", "svg", "math", "template", "canvas", "video", "audio", "source", "track", "noscript", "portal"],
    FORBID_ATTR: ["srcset", "sizes", "poster", "ping", "formaction", "action", "xlink:href", "background", "loading", "referrerpolicy", "crossorigin"],
    KEEP_CONTENT: true,
    SAFE_FOR_TEMPLATES: false,
    RETURN_TRUSTED_TYPE: false,
  }) as unknown as string;

  // DOMPurify in jsdom can return a string or fragment depending on config; normalise.
  if (typeof sanitized !== "string") sanitized = String(sanitized ?? "");

  // Second pass: rebuild a DOM so style attributes and resource URLs can be policed precisely.
  const doc = new DOMParser().parseFromString(`<div id="root">${sanitized}</div>`, "text/html");
  const root = doc.getElementById("root")!;
  const allowedTags = new Set(HTML_ALLOWED_TAGS.map((tag) => tag.toUpperCase()));
  for (const element of Array.from(root.querySelectorAll("*"))) {
    // Enforce the allowlist deterministically; DOMPurify profiles can otherwise
    // union in extra tags. Unknown tags are unwrapped (children are re-checked).
    if (!allowedTags.has(element.tagName)) {
      const parent = element.parentNode;
      if (parent) {
        while (element.firstChild) parent.insertBefore(element.firstChild, element);
        parent.removeChild(element);
      }
      removedCount.elements++;
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name === "style") continue;
      if (name === "src" || name === "href") continue;
      if (!["alt", "title", "class", "colspan", "rowspan", "width", "height", "align"].includes(name)) {
        element.removeAttribute(attribute.name);
        removedCount.attributes++;
      }
    }
    if (element.hasAttribute("style")) {
      const cleaned = sanitizeCssText(element.getAttribute("style") ?? "");
      removedCount.css += cleaned.removed;
      if (cleaned.css) element.setAttribute("style", cleaned.css);
      else element.removeAttribute("style");
    }
    if (element.tagName === "IMG") {
      const src = element.getAttribute("src") ?? "";
      const safeImage = /^data:image\/(png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i.test(src);
      if (!safeImage) {
        element.remove();
        removedCount.images++;
        continue;
      }
      element.setAttribute("alt", element.getAttribute("alt") || "Embedded image");
    }
    if (element.tagName === "A") {
      const href = (element.getAttribute("href") ?? "").trim();
      if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
        element.setAttribute("rel", "noopener noreferrer nofollow");
        element.setAttribute("target", "_blank");
      } else {
        element.removeAttribute("href");
        removedCount.attributes++;
      }
    }
    if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "FORM", "SVG", "MATH"].includes(element.tagName)) {
      element.remove();
      removedCount.elements++;
    }
  }
  return {
    html: root.innerHTML,
    removedElements: removedCount.elements,
    removedAttributes: removedCount.attributes,
    blockedImages: removedCount.images,
  };
}

/** Human-readable guard for browser CAPTCHA/anti-bot pages saved as HTML. */
export function isLikelySavedWebPage(html: string): boolean {
  return /<!doctype html|<html[\s>]/i.test(html) && /<script|<link|<style/i.test(html);
}

/* ================================================================== *
 * Safe filenames + friendly errors
 * ================================================================== */
export function safeFileName(name: string, fallback = "paperly-document"): string {
  const base = name
    .replace(/\\/g, "/")
    .split("/")
    .pop()!
    .replace(/[<>]/g, "")
    // Control characters are deliberately stripped from filenames.
    .split("")
    .map((character) => {
      const code = character.charCodeAt(0);
      if (code < 0x20 || code === 0x7f || ':"|?*'.includes(character)) return "-";
      return character;
    })
    .join("")
    .replace(/-{2,}/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^\.+/, "")
    .replace(/^[-\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  const clipped = base.slice(0, 120).trim();
  return clipped.replace(/^[-.]+$/, "") || fallback;
}

export function friendlyProcessingError(error: unknown, fallback = "Something went wrong while processing this file."): string {
  const err = error as { name?: string; message?: string; code?: string };
  const message = err?.message ?? "";
  if (error instanceof UploadError) return message;
  if (err?.name === "RangeError" || /allocation failed|out of memory|Array buffer allocation/i.test(message)) {
    return "Your browser ran out of memory. Close other tabs, or use a smaller file / lower resolution.";
  }
  if (err?.name === "QuotaExceededError") return "The browser ran out of storage while building this file. Try fewer pages.";
  if (/password|encrypt(ed|ion)?/i.test(message)) return "This PDF is password-protected. Use Unlock PDF first.";
  if (/invalid pdf|no pdf header|not a pdf/i.test(message)) return "That file isn’t a valid PDF, or it is damaged.";
  if (/tainted|cross-origin/i.test(message)) return "A remote image or stylesheet blocks secure rendering. Use a data-URI image or enable CORS.";
  // Never surface filesystem paths, stack frames or bundled module paths.
  if (/(?:\/[\w.-]+){2,}|https?:\/\/|\bat\s+\w+\s*\(|stack trace|node_modules/i.test(message)) return fallback;
  return message || fallback;
}

/** Sanitise a filename for a download attribute and reject traversal. */
export function assertSafeDownloadName(name: string): string {
  const clean = safeFileName(name);
  if (clean.includes("..") || clean.includes("/") || clean.includes("\\")) return "paperly-document.pdf";
  return clean;
}
