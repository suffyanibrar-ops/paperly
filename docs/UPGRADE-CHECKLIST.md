# Paperly PDF — 51-tool upgrade checklist

Status legend: **VERIFIED** = implemented and output-checked this cycle. **NOT REVIEWED** = existing baseline only; do not treat as upgraded. **BLOCKED** = requires a decision or missing capability.

## PDF → Word batch (this cycle)

- Added `src/lib/wordLayout.ts`: geometry-based heading levels, paragraphs, bullets, alignment and indentation.
- DOCX now uses real Word Heading 1/2/3 styles, bullet lists, source font sizes (converted to half-points), left indents and centre/right alignment.
- Preserves page breaks and images; numbered lists keep their visible marker because Word numbering IDs are document-global.
- Verified by `tests/unit/wordLayout.test.ts` (4 tests) and the existing DOCX output E2E test.

## Edit PDF batch (previous cycle)

- Added Helvetica/Times/Courier text families, line height, rotation, text backgrounds, underline and strikethrough.
- Added freehand pen, translucent marker and visual note elements.
- Added **cover-and-replace**: selects an existing text line from the PDF.js text layer, places a background cover and editable text on top. Clearly disclosed as not in-place text editing; underlying text remains (use Redact PDF to destroy it).
- Fixed mobile editor fit-width overflow (0px horizontal overflow at 390px).
- Verified by `tests/e2e/edit-v2.spec.ts`, unit suite and critical/feature/mobile regressions.

## Master checklist

| ID | Tool | Status | Notes |
| --- | --- | --- | --- |
| `merge` | Merge PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `split` | Split PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `organize` | Organize PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `rotate` | Rotate PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `crop` | Crop PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `compress` | Compress PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `repair` | Repair PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `page-numbers` | Page numbers | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `jpg-to-pdf` | JPG to PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `pdf-to-jpg` | PDF to JPG | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `pdf-to-word` | PDF to Word | VERIFIED | Geometry-based headings, paragraphs, bullets, alignment, indentation; DOCX output E2E + 4 layout unit tests. |
| `pdf-to-excel` | PDF to Excel | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `pdf-to-ppt` | PDF to PowerPoint | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `word-to-pdf` | Word to PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `excel-to-pdf` | Excel to PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `ppt-to-pdf` | PowerPoint to PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `extract-text` | Extract text | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `edit` | Edit PDF | VERIFIED | Fonts, line height, rotation, backgrounds, underline/strike, freehand, marker, notes, cover-and-replace; mobile overflow fixed; output test passed. |
| `sign` | Sign PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `watermark` | Watermark PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `redact` | Redact PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `compare` | Compare PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `protect` | Protect PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `unlock` | Unlock PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `ocr` | OCR PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `markdown-to-pdf` | Markdown to PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `pdf-to-markdown` | PDF to Markdown | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `resize` | Resize PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `n-up` | N-up & Booklet | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `headers-footers` | Headers & Footers | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `bates` | Bates numbering | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `fill-forms` | Fill PDF forms | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `flatten` | Flatten PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `scan` | Scan to PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `html-to-pdf` | HTML to PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `archive` | Archive PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `batch` | Batch processing | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `create-form` | Create fillable form | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `remove-pages` | Remove pages | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `extract-pages` | Extract pages | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `extract-images` | Extract images | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `summarize` | Summarise PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `ask-pdf` | Ask Your PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `inspect-pdf` | Inspect PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `find-redact` | Find & Redact | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `sanitize` | Sanitize PDF | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `bookmarks` | Edit Bookmarks | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `split-bookmarks` | Split by Bookmarks | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `metadata` | Edit Metadata | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `workflow` | PDF Workflow | NOT REVIEWED | Baseline E2E coverage only in this cycle. |
| `tables-to-csv` | Tables to CSV | NOT REVIEWED | Baseline E2E coverage only in this cycle. |

## Next batch

1. PDF → Excel table detection and PDF → PowerPoint reconstruction quality.
2. Edit PDF: page management and hyperlink annotations.
3. Compression/recovery edge cases.
4. Remaining tools in registry order.
