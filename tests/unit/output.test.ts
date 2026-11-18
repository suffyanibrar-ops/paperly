import { describe, expect, it } from "vitest";
import {
  ensureOutputName,
  outputKind,
  outputMimeType,
  outputStem,
  outputText,
  savedPercentLabel,
  sha256Hex,
  splitOutputName,
} from "@/lib/output";

describe("output engine", () => {
  it("maps extensions to MIME types", () => {
    expect(outputMimeType("report.pdf")).toBe("application/pdf");
    expect(outputMimeType("photo.JPG")).toBe("image/jpeg");
    expect(outputMimeType("table.csv")).toBe("text/csv");
    expect(outputMimeType("unknown.xyz")).toBe("application/octet-stream");
    expect(outputMimeType("image/png")).toBe("image/png");
  });

  it("classifies outputs for preview and actions", () => {
    expect(outputKind("application/pdf")).toBe("pdf");
    expect(outputKind("image/webp")).toBe("image");
    expect(outputKind("text/markdown")).toBe("text");
    expect(outputKind("application/zip")).toBe("archive");
    expect(outputKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("office");
    expect(outputKind("application/octet-stream")).toBe("other");
  });

  it("enforces and preserves output extensions", () => {
    expect(ensureOutputName("report", "out.pdf")).toBe("report.pdf");
    expect(ensureOutputName("report.PDF", "out.pdf")).toBe("report.PDF");
    expect(ensureOutputName("report.docx", "out.pdf")).toBe("report.pdf");
    expect(ensureOutputName("", "merged-final.pdf")).toBe("merged-final.pdf");
    expect(ensureOutputName(".pdf", "merged-final.pdf")).toBe("merged-final.pdf");
    expect(splitOutputName("merged-final.pdf")).toEqual({ stem: "merged-final", extension: ".pdf" });
    expect(splitOutputName("archive")).toEqual({ stem: "archive", extension: "" });
  });

  it("formats saved-size copy honestly", () => {
    expect(savedPercentLabel(1000, 620)).toBe("38% smaller");
    expect(savedPercentLabel(1000, 1200)).toBeNull();
    expect(savedPercentLabel(0, 10)).toBeNull();
  });

  it("builds a safe output stem", () => {
    expect(outputStem("My File.pdf", "compressed")).toBe("My File-compressed");
    expect(outputStem("a/b:c.pdf")).toBe("a-b-c");
  });

  it("decodes text output and caps it", () => {
    const bytes = new TextEncoder().encode("hello world");
    expect(outputText(bytes)).toBe("hello world");
    expect(outputText(bytes, 5)).toBe("hello");
  });

  it("hashes bytes when Web Crypto is available", async () => {
    const bytes = new TextEncoder().encode("paperly");
    const hash = await sha256Hex(bytes);
    if (typeof crypto !== "undefined" && crypto.subtle) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).toBe(await sha256Hex(new TextEncoder().encode("paperly")));
    } else {
      expect(hash).toBe("");
    }
  });
});
