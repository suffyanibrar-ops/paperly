# Group 5 — Forms, Scan, Batch, Page tools, Structure

Files: `src/tools/FormsScan.tsx`, `src/tools/Pro.tsx`, `src/tools/ProExtras.tsx`, `src/tools/Structure.tsx`
Read `docs/PLAYBOOK.md` first.

## Fill forms
- Add field-by-field navigation (Previous/Next), a “3 of 12 fields filled” progress line, and required
  markers with validation before save.
- Add **Import values** (JSON) and **Export values** (JSON) so a form can be filled repeatedly.
- Add “Flatten after filling” (default on for archival) and “Clear all” confirmation.
- Keep `Save filled PDF`, the `Cleared 4 standard fields` copy, and existing field labels.

## Scan
- Add an optional **camera capture** mode (getUserMedia) with a clear fallback to file upload and a
  permission-denied message; the file path must keep working without a camera.
- Add image clean-up controls: grayscale, black & white threshold, contrast/brightness, rotate 90°, and
  page size/orientation. Reuse the existing canvas pipeline.
- Support multiple captured/uploaded pages with remove/reorder and a thumbnail strip.
- Keep `Scan saved as PDF` and the `Scan saved as PDF` action.

## Batch
- Expand the operation list with the safe, well-supported operations already implemented in the app
  (compress, rotate, page numbers, watermark, flatten, protect, OCR where available).
- Add a queue with per-file status, error message, **retry failed**, remove, and a final ZIP plus a CSV
  report of results.
- Show aggregate progress and allow Cancel between files.
- Keep `Process 2 files` / `2 files processed` and the existing operation labels.

## Create form
- Add field types: text, checkbox, radio group, dropdown, date, signature; required/default/tooltip.
- Add a visual placement canvas: click or drag on the page to position a field; show its rectangle and
  allow moving/resizing (keep the existing coordinate model).
- Add tab order controls and a preview of the fillable result.
- Keep `Save interactive form` + `Interactive form created`.

## Remove pages / Extract pages
- Replace/augment the range-only UI with the shared `PagePicker` (keep `#page-range` where it exists).
- Add quick selection (All/Odd/Even/Invert), a live “N of M pages” summary, and output naming.
- Keep `Remove N page` / `Pages removed` and `Extract pages` / `Pages extracted`.

## Extract images
- Add minimum-width/height filters, format preference (original/PNG/JPEG), deduplicate identical images,
  page range, transparent-PNG handling, and a ZIP option.
- Show a thumbnail grid with dimensions and byte size; let users deselect images before export.
- Keep `Find images` / `images found` / `images ready`.

## Summarise
- Add length (short/medium/detailed), bullet vs paragraph, keyword count, reading time, and page range.
- Show the extracted word count and the method used (local deterministic summariser), plus an export as
  Markdown/TXT.
- Keep `Summarise document` + `Your summary`.

## Bookmarks
- Add **Import JSON**, **Export JSON**, **Auto-generate from headings** (reuse `src/lib/outline.ts`),
  and a “clear all” confirmation.
- Add validation: duplicate titles, out-of-range pages, nesting depth; show the count.
- Keep `Save bookmarks`, `3 bookmarks`, `No bookmarks yet`, `Add bookmark`, and the labels
  `Bookmark N title` / `Target page for bookmark N`.

## Split by bookmarks
- Add depth selection, naming template tokens (`{name}`, `{index}`, `{title}`), include-front-matter,
  and a preview of the output file list with page ranges.
- Keep `Split into 3 PDFs` and `3 section PDFs ready`.

Use `PagePicker`, `AdvancedOptions`, `useToolPreferences`, `DownloadPanel` with bytes, and the shared
shortcuts where they do not conflict with canvas editing keys.
