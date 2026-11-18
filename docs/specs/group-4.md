# Group 4 — Conversions & Data extraction

Files: `src/tools/ConvertDocs.tsx`, `src/tools/ConvertImages.tsx`, `src/tools/DataExtract.tsx`
Read `docs/PLAYBOOK.md` first. This group has the most E2E label dependencies; preserve them exactly.

## PDF → Word / Excel / PowerPoint
- Add a **page range** (using the shared RangeField/parseRanges syntax) to all three.
- PDF → Word: layout modes (**flowing text** vs **positioned**, default flowing), include-images toggle,
  page-break preservation, and an **OCR fallback** hint when a page has no text layer (offer OCR tool,
  do not silently OCR).
- PDF → Excel: table detection sensitivity, header-row toggle, all-tables vs selected table, output
  `.xlsx` (keep CSV option if present); explain what will be extracted before running.
- PDF → PPT: slide-per-page, page range, image quality/DPI, 16:9 vs 4:3, include page notes.
- Add progress with page detail + Cancel; keep existing success titles:
  `Word document is ready`, `spreadsheet is ready`, `slides ready`, `deck is now a PDF`.

## Word / Excel / PowerPoint → PDF
- Word: page size/orientation/margins, images on/off, heading→bookmark option, page range.
- Excel: sheet selection, fit-to-width, gridlines, orientation, page size, margins, header/footer.
- PowerPoint: slide size, notes pages, page range, background images.
- Keep `workbook is now a PDF`, `now a PDF`, and the existing action labels.

## Extract text
- Add output modes: **plain text**, **per-page files (ZIP)**, **JSON** with page numbers, and
  **page-marker text** (`--- Page 3 ---`).
- Add a reading-order/layout choice (preserve line breaks vs reflow) and page range.
- Show a preview of the first extracted page before download.
- Keep `Extract text`.

## JPG → PDF
- Add page size (A4/Letter/Legal/A5/fit-to-image), orientation, margin, fit mode (contain/cover),
  image order reorder, rotate, one-image-per-page vs combined, and JPEG quality.
- Add a **generated sample scan** (`SAMPLE.image`) to the empty state.
- Keep `Create PDF` + `image PDF is ready`.

## PDF → JPG
- Add DPI/scale, format (JPG/PNG/WebP), quality, page range, and a JPG/PNG background choice.
- Add a thumbnail preview of the first exported page before download.
- Keep `Convert to JPG` + `images ready`.

## Tables → CSV
- Add detection sensitivity, header-row handling, all-tables vs selected table, page range.
- Add output **CSV / XLSX / JSON**, plus a preview table of the first detected table with row/column count.
- Keep `Extract tables` and the `Page 1 · Table 1` labelling.

Use `AdvancedOptions`/`OptionsGrid`, `useToolPreferences`, `useJob` with page-level progress and Cancel,
`DownloadPanel` with bytes, and both keyboard shortcuts. Add samples where they fit (PDF, image, CSV).
