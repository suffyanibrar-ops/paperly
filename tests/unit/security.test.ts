import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  UploadError,
  assertSafeDownloadName,
  assertZipSafe,
  extensionOf,
  formatLimit,
  isLikelySavedWebPage,
  kindsForAccept,
  detectSignature,
  friendlyProcessingError,
  sanitizeCssText,
  sanitizeHtml,
  safeFileName,
  validateUpload,
} from "@/lib/security";

const bytes = (...values: number[]) => new Uint8Array(values);
const fileOf = (name: string, parts: BlobPart[], type = "") => new File(parts, name, { type });

describe("file signature detection", () => {
  it("detects genuine PDF, JPEG, PNG, GIF and WebP signatures", () => {
    expect(detectSignature(bytes(0x25, 0x50, 0x44, 0x46, 0x2d))).toBe("pdf");
    expect(detectSignature(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image");
    expect(detectSignature(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image");
    expect(detectSignature(Uint8Array.from("GIF89a", (c) => c.charCodeAt(0)))).toBe("image");
    expect(detectSignature(Uint8Array.from("RIFF0000WEBP", (c) => c.charCodeAt(0)))).toBe("image");
  });

  it("does not trust a .pdf extension on a text file", () => {
    expect(detectSignature(Uint8Array.from("hello world", (c) => c.charCodeAt(0)))).toBeNull();
  });
});

describe("validateUpload", () => {
  it("rejects a mislabelled PDF before parsing", async () => {
    const fake = fileOf("invoice.pdf", ["this is not a pdf"], "application/pdf");
    await expect(validateUpload(fake, "application/pdf,.pdf")).rejects.toBeInstanceOf(UploadError);
  });

  it("accepts a well-formed PDF signature", async () => {
    const pdf = fileOf("ok.pdf", ["%PDF-1.7\n%test"], "application/pdf");
    const result = await validateUpload(pdf, "application/pdf,.pdf");
    expect(result.kind).toBe("pdf");
  });

  it("rejects a wrong type for the tool", async () => {
    const png = fileOf("photo.png", [bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)], "image/png");
    await expect(validateUpload(png, "application/pdf,.pdf")).rejects.toThrow(/isn’t supported here/);
  });

  it("rejects empty files and oversized files", async () => {
    await expect(validateUpload(fileOf("empty.pdf", [], "application/pdf"), ".pdf")).rejects.toThrow(/empty/);
    const big = fileOf("big.pdf", ["%PDF-1.4"], "application/pdf");
    Object.defineProperty(big, "size", { value: 250 * 1024 * 1024 });
    await expect(validateUpload(big, ".pdf")).rejects.toThrow(/safe limit/);
  });

  it("rejects an image whose bytes are not an image", async () => {
    const fakeImage = fileOf("photo.png", ["plain text"], "image/png");
    await expect(validateUpload(fakeImage, "image/png,.png")).rejects.toThrow(/isn’t a valid image/);
  });

  it("rejects binary payloads presented as text", async () => {
    const binary = fileOf("notes.txt", [bytes(0x00, 0x01, 0x02, 0x03, 0x04)], "text/plain");
    await expect(validateUpload(binary, ".txt")).rejects.toThrow(/binary/);
  });
});

describe("OOXML zip guards", () => {
  const makeZip = async (entries: Record<string, string>) => {
    const zip = new JSZip();
    Object.entries(entries).forEach(([name, value]) => zip.file(name, value));
    return zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  };

  it("accepts a normal docx-style archive", async () => {
    const blob = await makeZip({ "[Content_Types].xml": "<Types/>", "word/document.xml": "<document/>" });
    await expect(assertZipSafe(blob, "docx")).resolves.toBeTruthy();
  });

  it("rejects an archive without OOXML content types", async () => {
    const blob = await makeZip({ "word/document.xml": "<document/>" });
    await expect(assertZipSafe(blob, "docx")).rejects.toThrow(/valid Office Open XML/);
  });

  it("rejects an archive whose folder does not match the claimed format", async () => {
    const blob = await makeZip({ "[Content_Types].xml": "<Types/>", "xl/workbook.xml": "<workbook/>" });
    await expect(assertZipSafe(blob, "docx")).rejects.toThrow(/doesn’t look like a .docx/);
  });

  it("rejects path traversal entries", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", "<document/>");
    zip.file("../escape.txt", "x");
    const blob = await zip.generateAsync({ type: "blob" });
    await expect(assertZipSafe(blob, "docx")).rejects.toThrow(/unsafe path/);
  });

  it("rejects non-zip input", async () => {
    await expect(assertZipSafe(new Blob(["not a zip"]), "docx")).rejects.toThrow(/not a valid Office/);
  });
});

describe("HTML sanitisation", () => {
  const attack = `<!doctype html><html><head><title>x</title><style>@import url(https://evil.test/x.css);</style></head>
  <body onload="alert(1)">
    <h1 onclick="steal()">Report</h1>
    <script>window.__pwned = true</script>
    <iframe src="https://evil.test"></iframe>
    <object data="evil.swf"></object>
    <embed src="evil.swf" />
    <form action="https://evil.test"><input name="x" /></form>
    <img src="https://evil.test/tracker.png" onerror="alert(1)" />
    <img src="data:image/png;base64,iVBORw0KGgo=" alt="ok" />
    <a href="javascript:alert(1)">bad</a>
    <a href="https://example.com">good</a>
    <svg onload="alert(1)"><circle /></svg>
    <div style="color:#123;position:fixed;top:0;background:url(https://evil.test/x)">styled</div>
    <table><tr><td colspan="2" style="font-weight:bold">Cell</td></tr></table>
  </body></html>`;

  it("removes every executable or framing vector", () => {
    const result = sanitizeHtml(attack);
    expect(result.html).not.toMatch(/<script/i);
    expect(result.html).not.toMatch(/<iframe/i);
    expect(result.html).not.toMatch(/<object|<embed/i);
    expect(result.html).not.toMatch(/<form|<input/i);
    expect(result.html).not.toMatch(/<svg/i);
    expect(result.html).not.toMatch(/onerror|onload|onclick/i);
    expect(result.html).not.toMatch(/javascript:/i);
    expect(result.html).not.toMatch(/https:\/\/evil\.test/i);
    expect(result.blockedImages).toBeGreaterThan(0);
  });

  it("keeps legitimate document markup", () => {
    const result = sanitizeHtml(attack);
    expect(result.html).toMatch(/<h1>Report<\/h1>/);
    expect(result.html).toMatch(/<table>/);
    expect(result.html).toMatch(/colspan="2"/);
    expect(result.html).toMatch(/data:image\/png;base64/);
    expect(result.html).toMatch(/href="https:\/\/example\.com"/);
    expect(result.html).toMatch(/rel="noopener noreferrer nofollow"/);
  });

  it("strips unsafe CSS declarations but keeps typography", () => {
    const result = sanitizeHtml(attack);
    expect(result.html).not.toMatch(/position\s*:\s*fixed/i);
    expect(result.html).not.toMatch(/url\(/i);
    expect(result.html).toMatch(/font-weight: bold/);
    expect(result.html).toMatch(/color: #123/);
    expect(result.html).not.toMatch(/@import/i);
  });

  it("removes unsafe CSS from standalone declarations", () => {
    const { css, removed } = sanitizeCssText(
      "color: red; background: url(https://evil.test/x.png); position: fixed; width: expression(alert(1)); font-size: 12px",
    );
    expect(removed).toBe(3);
    expect(css).toBe("color: red; font-size: 12px");
  });
});

describe("safe filenames and error mapping", () => {
  it("neutralises path traversal and control characters", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("..\\..\\windows\\system32\\x.pdf")).toBe("x.pdf");
    expect(safeFileName("<script>.pdf")).toBe("script.pdf");
    expect(safeFileName("   ")).toBe("paperly-document");
  });

  it("maps memory and password failures to actionable messages without leaking internals", () => {
    expect(friendlyProcessingError(new RangeError("Array buffer allocation failed"))).toMatch(/out of memory/i);
    expect(friendlyProcessingError(new Error("Input document is encrypted"))).toMatch(/Unlock PDF/);
    expect(friendlyProcessingError(new Error("Internal stack trace at /secret/path/module.js"))).toBe("Something went wrong while processing this file.");
  });
});


describe("limit and accept helpers", () => {
  it("formats byte limits for humans", () => {
    expect(formatLimit(2 * 1024 * 1024)).toBe("2 MB");
    expect(formatLimit(40 * 1024)).toBe("40 KB");
  });

  it("maps accept tokens to file kinds, including wildcards", () => {
    expect(kindsForAccept("application/pdf,.pdf").has("pdf")).toBe(true);
    expect(kindsForAccept("image/png,.jpg").has("image")).toBe(true);
    expect(kindsForAccept("application/vnd.openxmlformats-officedocument.wordprocessingml.document").has("docx")).toBe(true);
    expect(kindsForAccept("text/csv").has("csv")).toBe(true);
    expect(kindsForAccept("*").has("pdf")).toBe(true);
  });

  it("reads extensions case-insensitively", () => {
    expect(extensionOf("Report.PDF")).toBe("pdf");
    expect(extensionOf("no-extension")).toBe("no-extension");
  });

  it("flags anti-bot or scripted HTML saved from the web", () => {
    expect(isLikelySavedWebPage("<!doctype html><html><script>x()</script></html>")).toBe(true);
    expect(isLikelySavedWebPage("<h1>Just a fragment</h1>")).toBe(false);
  });
});

describe("additional sanitisation branches", () => {
  it("allows mail links but strips other schemes", () => {
    const result = sanitizeHtml('<a href="mailto:a@b.test">mail</a><a href="tel:+1">tel</a><a href="/relative">rel</a>');
    expect(result.html).toContain("mailto:a@b.test");
    expect(result.html).not.toContain("tel:");
    expect(result.html).not.toContain("/relative");
  });

  it("removes unknown elements without allowing them to render", () => {
    const result = sanitizeHtml("<marquee>hello</marquee><custom-tag>world</custom-tag><p>kept</p>");
    expect(result.html).not.toMatch(/<marquee|<custom-tag/);
    expect(result.html).toContain("<p>kept</p>");
  });

  it("handles empty input and attributes without values", () => {
    expect(sanitizeHtml("").html).toBe("");
    expect(sanitizeHtml("<p disabled onclick>x</p>").html).toBe("<p>x</p>");
  });
});

describe("legacy Excel and download names", () => {
  it("accepts a true CFB (Excel 97) signature and rejects a fake .xls", async () => {
    const real = fileOf("legacy.xls", [bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)], "application/vnd.ms-excel");
    await expect(validateUpload(real, ".xls,.xlsx")).resolves.toMatchObject({ kind: "xlsx" });
    const fake = fileOf("legacy.xls", ["not excel"], "application/vnd.ms-excel");
    await expect(validateUpload(fake, ".xls,.xlsx")).rejects.toThrow(/valid Excel/);
  });

  it("blocks encrypted zip entries", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", "<document/>");
    const blob = await zip.generateAsync({ type: "blob" });
    const buffer = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(buffer.buffer);
    // set the encryption flag on the first local file header
    view.setUint16(6, view.getUint16(6, true) | 1, true);
    await expect(assertZipSafe(new Blob([buffer]), "docx")).rejects.toThrow(/Password-protected Office/);
  });

  it("rejects an empty archive", async () => {
    const blob = await new JSZip().generateAsync({ type: "blob" });
    await expect(assertZipSafe(blob, "docx")).rejects.toThrow(/empty or damaged/);
  });

  it("never returns a traversal-shaped download name", () => {
    expect(assertSafeDownloadName("../../evil.pdf")).toBe("evil.pdf");
    expect(assertSafeDownloadName("normal report.pdf")).toBe("normal report.pdf");
  });

  it("maps quota failures to a recoverable message", () => {
    const quota = new Error("quota");
    quota.name = "QuotaExceededError";
    expect(friendlyProcessingError(quota)).toMatch(/ran out of storage/);
  });
});
