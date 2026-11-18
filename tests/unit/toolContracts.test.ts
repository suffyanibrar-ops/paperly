import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Contract test for E2E-critical copy.
 *
 * Playwright clicks these labels and waits for these result titles. Renaming one
 * silently breaks the release suite, so the labels are pinned here as well.
 * Copy improvements are welcome — update the E2E helper and this file together.
 */
const sources = new Map<string, string>();
function source(file: string): string {
  if (!sources.has(file)) sources.set(file, readFileSync(path.resolve("src/tools", file), "utf8"));
  return sources.get(file)!;
}

const CONTRACTS: { file: string; label: string }[] = [
  { file: "Organize.tsx", label: "Merge PDF" },
  { file: "Organize.tsx", label: "PDFs became one" },
  { file: "Organize.tsx", label: "Extract pages" },
  { file: "Organize.tsx", label: "extracted PDF is ready" },
  { file: "Organize.tsx", label: "Apply changes" },
  { file: "Organize.tsx", label: "pages are in order" },
  { file: "Organize.tsx", label: "Rotate {angle}°" },
  { file: "Organize.tsx", label: "Pages turned" },
  { file: "Organize.tsx", label: "Crop PDF" },
  { file: "Organize.tsx", label: "Margins trimmed" },
  { file: "Optimize.tsx", label: "Compress PDF" },
  { file: "Optimize.tsx", label: "Repair PDF" },
  { file: "Optimize.tsx", label: "Document recovered" },
  { file: "Optimize.tsx", label: "Add page numbers" },
  { file: "Optimize.tsx", label: "Numbers added" },
  { file: "Security.tsx", label: "Protect PDF" },
  { file: "Security.tsx", label: "PDF protected" },
  { file: "Security.tsx", label: "Unlock PDF" },
  { file: "Security.tsx", label: "PDF unlocked" },
  { file: "Edit.tsx", label: "Export edited PDF" },
  { file: "Edit.tsx", label: "edited PDF is ready" },
  { file: "Edit.tsx", label: "Save signed PDF" },
  { file: "Edit.tsx", label: "Document signed" },
  { file: "Edit.tsx", label: "Apply watermark" },
  { file: "Edit.tsx", label: "Watermark applied" },
  { file: "RedactCompare.tsx", label: "Redactions applied" },
  { file: "RedactCompare.tsx", label: "Compare documents" },
  { file: "ConvertImages.tsx", label: "Create PDF" },
  { file: "ConvertImages.tsx", label: "image PDF is ready" },
  { file: "ConvertImages.tsx", label: "Convert to {opts.value.format" },
  { file: "ConvertDocs.tsx", label: "Word document is ready" },
  { file: "ConvertDocs.tsx", label: "spreadsheet is ready" },
  { file: "ConvertDocs.tsx", label: "Extract text" },
  { file: "DataExtract.tsx", label: "Extract tables" },
  { file: "FormsScan.tsx", label: "Save filled PDF" },
  { file: "FormsScan.tsx", label: "Scan saved as PDF" },
  { file: "Pro.tsx", label: "Save interactive form" },
  { file: "ProExtras.tsx", label: "Extract pages" },
  { file: "ProExtras.tsx", label: "Your summary" },
  { file: "Structure.tsx", label: "Save bookmarks" },
  { file: "Structure.tsx", label: "Add bookmark" },
  { file: "Structure.tsx", label: "No bookmarks yet" },
  { file: "Knowledge.tsx", label: "Find answer" },
  { file: "Knowledge.tsx", label: "Answer · verbatim from your PDFs" },
  { file: "Privacy.tsx", label: "Sanitized copy ready and verified" },
  { file: "OcrTool.tsx", label: "OCR PDF" },
  { file: "OcrTool.tsx", label: "Searchable PDF ready" },
  { file: "MetadataEdit.tsx", label: "Save metadata & download" },
  { file: "MetadataEdit.tsx", label: "Metadata updated" },
  { file: "HtmlArchive.tsx", label: "Convert HTML to PDF" },
  { file: "HtmlArchive.tsx", label: "HTML converted to PDF" },
  { file: "HtmlArchive.tsx", label: "Prepare archive PDF" },
  { file: "HtmlArchive.tsx", label: "Archive copy prepared" },
  { file: "MarkdownTools.tsx", label: "Convert to Markdown" },
  { file: "MarkdownTools.tsx", label: "Markdown output" },
  { file: "MarkdownTools.tsx", label: "document is ready" },
];

describe("E2E tool contracts", () => {
  it.each(CONTRACTS)("$file keeps the $label copy", ({ file, label }) => {
    expect(source(file), `${file} no longer contains the E2E-critical copy “${label}”`).toContain(label);
  });

  it("keeps the page-range input id used by the split E2E", () => {
    expect(readFileSync(path.resolve("src/components/toolParts.tsx"), "utf8")).toContain('id="page-range"');
  });
});
