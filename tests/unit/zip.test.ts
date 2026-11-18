import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { assertZipSafe, inspectZip } from "@/lib/security";

interface RawEntry {
  name: string;
  data?: Uint8Array;
  flags?: number;
  method?: number;
  compressedOverride?: number;
  uncompressedOverride?: number;
  localName?: string;
  localEncrypted?: boolean;
  centralEncrypted?: boolean;
  dataDescriptor?: boolean;
}

const enc = new TextEncoder();

/** Minimal, fully controllable ZIP writer for adversarial fixtures. */
function buildZip(entries: RawEntry[], options: { omitEocd?: boolean; zip64?: boolean; comment?: string } = {}): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: { bytes: Uint8Array; offset: number; entry: RawEntry; sizes: { c: number; u: number } }[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const localNameBytes = enc.encode(entry.localName ?? entry.name);
    const data = entry.data ?? new Uint8Array(0);
    const compressed = entry.compressedOverride ?? data.length;
    const uncompressed = entry.uncompressedOverride ?? data.length;
    const method = entry.method ?? 0;
    const flags = (entry.flags ?? 0) | (entry.dataDescriptor ? 0x0008 : 0) | (entry.localEncrypted ? 0x0001 : 0);

    const local = new Uint8Array(30 + localNameBytes.length + data.length + (entry.dataDescriptor ? 16 : 0));
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, 0, true); // crc (not verified by the validator)
    lv.setUint32(18, entry.dataDescriptor ? 0 : compressed, true);
    lv.setUint32(22, entry.dataDescriptor ? 0 : uncompressed, true);
    lv.setUint16(26, localNameBytes.length, true);
    local.set(localNameBytes, 30);
    local.set(data, 30 + localNameBytes.length);
    if (entry.dataDescriptor) {
      const dd = 30 + localNameBytes.length + data.length;
      lv.setUint32(dd, 0x08074b50, true);
      lv.setUint32(dd + 8, compressed, true);
      lv.setUint32(dd + 12, uncompressed, true);
    }
    locals.push(local);
    centrals.push({ bytes: new Uint8Array(), offset, entry, sizes: { c: compressed, u: uncompressed } });
    offset += local.length;
  }

  const centralStart = offset;
  const centralParts: Uint8Array[] = [];
  let centralSize = 0;
  for (const record of centrals) {
    const nameBytes = enc.encode(record.entry.name);
    const extra = new Uint8Array(record.entry.centralEncrypted ? 0 : 0);
    const central = new Uint8Array(46 + nameBytes.length + extra.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, (record.entry.flags ?? 0) | (record.entry.dataDescriptor ? 0x0008 : 0) | (record.entry.centralEncrypted ? 0x0001 : 0), true);
    cv.setUint16(10, record.entry.method ?? 0, true);
    cv.setUint32(20, record.sizes.c, true);
    cv.setUint32(24, record.sizes.u, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, extra.length, true);
    cv.setUint32(42, record.offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);
    centralSize += central.length;
  }
  const centralDirectory = new Uint8Array(centralSize);
  let cp = 0;
  for (const part of centralParts) {
    centralDirectory.set(part, cp);
    cp += part.length;
  }

  const compressedTotal = centrals.reduce((sum, record) => sum + record.sizes.c, 0);
  const uncompressedTotal = centrals.reduce((sum, record) => sum + record.sizes.u, 0);
  const comment = enc.encode(options.comment ?? "");

  let tail: Uint8Array;
  if (options.zip64) {
    const zip64 = new Uint8Array(56);
    const zv = new DataView(zip64.buffer);
    zv.setUint32(0, 0x06064b50, true);
    zv.setBigUint64(4, 44n, true);
    zv.setUint16(12, 45, true);
    zv.setUint16(14, 45, true);
    zv.setBigUint64(24, BigInt(entries.length), true);
    zv.setBigUint64(32, BigInt(entries.length), true);
    zv.setBigUint64(40, BigInt(centralSize), true);
    zv.setBigUint64(48, BigInt(centralStart), true);

    const locator = new Uint8Array(20);
    const lv = new DataView(locator.buffer);
    lv.setUint32(0, 0x07064b50, true);
    lv.setBigUint64(8, BigInt(centralStart + centralSize), true);
    lv.setUint32(16, 1, true);

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, 0xffff, true);
    ev.setUint16(10, 0xffff, true);
    ev.setUint32(12, 0xffffffff, true);
    ev.setUint32(16, 0xffffffff, true);
    tail = new Uint8Array(zip64.length + locator.length + eocd.length);
    tail.set(zip64, 0);
    tail.set(locator, zip64.length);
    tail.set(eocd, zip64.length + locator.length);
  } else {
    const eocd = new Uint8Array(22 + comment.length);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, centralStart, true);
    ev.setUint16(20, comment.length, true);
    eocd.set(comment, 22);
    tail = eocd;
  }

  const total = centralStart + (options.omitEocd ? 0 : centralDirectory.length + tail.length);
  const out = new Uint8Array(total);
  let p = 0;
  for (const local of locals) {
    out.set(local, p);
    p += local.length;
  }
  if (options.omitEocd) return out;
  out.set(centralDirectory, centralStart);
  out.set(tail, centralStart + centralDirectory.length);
  void compressedTotal;
  void uncompressedTotal;
  return out;
}

const ooxml = (extra: RawEntry[] = [], options = {}) =>
  buildZip(
    [
      { name: "[Content_Types].xml", data: enc.encode("<Types/>") },
      { name: "word/document.xml", data: enc.encode("<w:document/>") },
      ...extra,
    ],
    options,
  );

const blob = (bytes: Uint8Array) => new Blob([bytes]);

describe("central-directory validation", () => {
  it("accepts a minimal stored archive and reports entries", () => {
    const result = inspectZip(ooxml());
    expect(result.entries).toHaveLength(2);
    expect(result.hasContentTypes).toBe(true);
    expect(result.zip64).toBe(false);
  });

  it("accepts a deflate archive", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", "<document>" + "x".repeat(2000) + "</document>");
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const result = inspectZip(bytes);
    // JSZip adds an explicit directory entry for the word/ folder.
    expect(result.entries.filter((entry) => !entry.name.endsWith("/"))).toHaveLength(2);
    expect(result.entries.some((entry) => entry.name === "word/document.xml" && entry.uncompressedSize > 0)).toBe(true);
  });

  it("accepts a data-descriptor archive whose local sizes are deferred (flag bit 3)", () => {
    const payload = enc.encode("<document>deferred sizes</document>");
    const bytes = buildZip(
      [
        { name: "[Content_Types].xml", data: enc.encode("<Types/>") },
        { name: "word/document.xml", data: payload, dataDescriptor: true },
      ],
      {},
    );
    const result = inspectZip(bytes);
    const entry = result.entries.find((item) => item.name === "word/document.xml");
    expect(result.entries).toHaveLength(2);
    expect(entry?.dataDescriptor).toBe(true);
    // The trusted size comes from the central directory, not the zeroed local header.
    expect(entry?.uncompressedSize).toBe(payload.length);
  });

  it("accepts a valid ZIP64 archive and reads 64-bit sizes", () => {
    const result = inspectZip(ooxml([], { zip64: true }));
    expect(result.zip64).toBe(true);
    expect(result.entries).toHaveLength(2);
  });

  it("rejects duplicate entries", () => {
    const bytes = ooxml([{ name: "word/document.xml", data: enc.encode("second") }]);
    expect(() => inspectZip(bytes)).toThrow(/duplicate entries/);
  });

  it("rejects parent traversal, absolute paths and drive letters", () => {
    expect(() => inspectZip(ooxml([{ name: "../escape.xml", data: enc.encode("x") }]))).toThrow(/unsafe path/);
    expect(() => inspectZip(ooxml([{ name: "/etc/passwd", data: enc.encode("x") }]))).toThrow(/unsafe path/);
    expect(() => inspectZip(ooxml([{ name: "C:/Windows/evil.xml", data: enc.encode("x") }]))).toThrow(/unsafe path/);
    expect(() => inspectZip(ooxml([{ name: "word/../../evil.xml", data: enc.encode("x") }]))).toThrow(/unsafe path/);
    expect(() => inspectZip(ooxml([{ name: "word\\..\\..\\evil.xml", data: enc.encode("x") }]))).toThrow(/unsafe path/);
  });

  it("rejects null bytes in names", () => {
    expect(() => inspectZip(ooxml([{ name: "word/bad\u0000name.xml", data: enc.encode("x") }]))).toThrow(/null byte|invalid file name/);
  });

  it("rejects encrypted entries in either header", () => {
    expect(() => inspectZip(ooxml([{ name: "word/secret.xml", data: enc.encode("x"), centralEncrypted: true }]))).toThrow(/Password-protected/);
    expect(() => inspectZip(ooxml([{ name: "word/secret.xml", data: enc.encode("x"), localEncrypted: true }]))).toThrow(/Password-protected/);
  });

  it("rejects a high-ratio decompression bomb", () => {
    const bomb = ooxml([
      { name: "word/media/payload.bin", data: new Uint8Array(64), compressedOverride: 64, uncompressedOverride: 300 * 1024 * 1024 },
    ]);
    expect(() => inspectZip(bomb)).toThrow(/expands abnormally/);
  });

  it("rejects an archive whose declared content with no stored bytes", () => {
    const lies = ooxml([{ name: "word/ghost.xml", compressedOverride: 0, uncompressedOverride: 1024 }]);
    expect(() => inspectZip(lies)).toThrow(/no stored data|extends beyond/);
  });

  it("rejects unsupported compression methods", () => {
    expect(() => inspectZip(ooxml([{ name: "word/x.xml", data: enc.encode("x"), method: 99 }]))).toThrow(/unsupported compression method/);
  });

  it("rejects archives with no central directory", () => {
    expect(() => inspectZip(ooxml([], { omitEocd: true }))).toThrow(/truncated|central directory/);
  });

  it("rejects truncated files", () => {
    const bytes = ooxml();
    expect(() => inspectZip(bytes.subarray(0, bytes.length - 30))).toThrow(/truncated|central directory/);
  });

  it("rejects mismatched local header names", () => {
    const bytes = ooxml([{ name: "word/media/image1.bin", localName: "word/media/other.bin", data: enc.encode("x") }]);
    expect(() => inspectZip(bytes)).toThrow(/mismatched local header/);
  });

  it("rejects an empty archive", () => {
    expect(() => inspectZip(buildZip([]))).toThrow(/empty or damaged/);
  });

  it("rejects trailing garbage after the end-of-directory record", () => {
    const bytes = ooxml();
    const padded = new Uint8Array(bytes.length + 8);
    padded.set(bytes);
    expect(() => inspectZip(padded)).toThrow(/truncated|central directory/);
  });

  it("rejects a central directory that lies about the entry count", () => {
    const bytes = ooxml();
    const patched = bytes.slice();
    const view = new DataView(patched.buffer);
    const eocd = patched.length - 22;
    view.setUint16(eocd + 10, 9, true);
    expect(() => inspectZip(patched)).toThrow(/invalid entry|ended unexpectedly|does not match/);
  });

  it("rejects a non-zip blob outright", () => {
    expect(() => inspectZip(enc.encode("this is not a zip file at all"))).toThrow(/not a valid Office document/);
  });
});

describe("format binding", () => {
  it("accepts only archives that contain the claimed format folder", async () => {
    await expect(assertZipSafe(blob(ooxml()), "docx")).resolves.toBeTruthy();
    await expect(assertZipSafe(blob(ooxml()), "xlsx")).rejects.toThrow(/doesn’t look like a .xlsx/);
    const xlsx = buildZip([
      { name: "[Content_Types].xml", data: enc.encode("<Types/>") },
      { name: "xl/workbook.xml", data: enc.encode("<workbook/>") },
    ]);
    await expect(assertZipSafe(blob(xlsx), "xlsx")).resolves.toBeTruthy();
    await expect(assertZipSafe(blob(xlsx), "docx")).rejects.toThrow(/doesn’t look like a .docx/);
  });

  it("rejects a zip without OOXML content types", async () => {
    await expect(assertZipSafe(blob(buildZip([{ name: "word/document.xml", data: enc.encode("x") }])), "docx")).rejects.toThrow(/valid Office Open XML/);
  });

  it("accepts a real JSZip-generated docx-shaped archive", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", "<document/>");
    const bytes = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    await expect(assertZipSafe(bytes, "docx")).resolves.toBeTruthy();
  });
});
