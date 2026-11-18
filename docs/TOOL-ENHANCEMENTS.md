# Tool enhancements shipped in this release

All 51 tools were revisited. This page records what changed, grouped by the site's own categories.
Everything remains local-only: no new network calls, no new dependencies, no uploads.

## Platform-wide (applies across the catalogue)

- **Local sample documents** generated in the browser (PDF, scan PNG, Markdown, CSV, HTML, text) so every
  input can be tried without finding a file.
- **Paste to upload** (⌘V) plus drag-and-drop, per-file validation summaries and clearer accepted-format hints.
- **Visual page picker** with thumbnails, shift-click ranges, All/Odd/Even/Invert/Clear and a typed-range
  fallback (also accepts `odd`, `even`, `last`, `last-3`, `>10`, `7-`, `1-10:2`).
- **Advanced options** panels with **remembered settings** (versioned local storage, reset from Activity).
- **Job engine**: real progress, elapsed time, ETA, **Cancel**, retry and normalised error copy.
- **Result panel**: rename before download, in-app **preview**, copy, share, **SHA-256 checksum**, result
  facts and one-click hand-off to a follow-up tool.
- **Keyboard**: ⌘K search, **⌘/Ctrl+Enter** run, **⌘/Ctrl+S** download, `?` shortcut sheet, Escape closes
  dialogs, shift-click selects page ranges.
- **Accessibility**: result panels announced and focused, labelled controls, `aria-pressed` toggles, alert
  roles, progress semantics, reduced-motion support.

## Organize

| Tool | Added |
| --- | --- |
| Merge | Sequential / **Interleave** mode; per-file page ranges; source-file **bookmarks**; live file/page/size summary; duplicate-name warning; per-file progress + cancel |
| Split | Extract / every page / **every N** / custom parts / **odd-even** / **split in half**; `PagePicker` synced with the range field; file-name token pattern; ZIP vs individual files; output-count preview |
| Organize | Duplicate, insert blank, move to start/end, rotate page, **reverse**, reset to original; drag or keyboard reorder; before → after page count and empty-document warning |
| Rotate | 90/180/270 quick actions; all/odd/even/last targeting; per-page rotation badges; "upright landscape pages" heuristic (labelled as a shape heuristic); reset rotation |
| Crop | mm/pt/% margins with conversion; A4/Letter/Legal/A5/custom sizes; **crop-rectangle preview**; **auto-detect text margins**; range/odd/even; old → new dimensions |
| Resize | Page presets, orientation, Fit/Fill/Stretch/Actual/Scale-%, margins, range, per-page orientation, optional page dropping, live target preview |
| N-up | 2/4/6/9/booklet, sheet size/orientation, margins, gutter, borders, reading order, range, source page numbers |
| Headers & footers | Token picker (`{page}{pages}{total}{date}{title}{filename}`), left/centre/right slots, presets, different first page, typography, rule, range |
| Bates | Prefix chips, suffix, start, increment, digits, positions, secondary stamp, range, **per-file numbering across multiple files** |
| Flatten | Forms / annotations / both, range, optional rasterisation, annotation-appearance baking that keeps vectors/text, link handling, summary |

## Convert

| Tool | Added |
| --- | --- |
| PDF → Word | Page range; **flowing vs positioned** layout; include images; page-break preservation; heading styles; OCR hint for pages with no text layer |
| PDF → Excel | Page range; column sensitivity; header → Excel AutoFilter; per-page or one sheet; **CSV** output; run summary and first-page preview |
| PDF → PowerPoint | Page range; 16:9/4:3; quality presets; slide numbers; speaker notes from the text layer |
| Word → PDF | Page size, orientation, margins; inline images from `word/media`; **headings → real PDF outline**; pages to keep; page numbers |
| Excel → PDF | Sheet selection, orientation, page size, margins, fit-columns vs equal-width, gridlines, header/footer, repeat header row, CSV sample |
| PowerPoint → PDF | Slide range; 16:9/4:3; speaker-notes band; background images |
| Extract text | Marker/plain/JSON/per-page ZIP output; reading order; page range; first-page preview; copy all |
| JPG → PDF | Page size, orientation, margins, **contain/cover**, rotate/reorder, 1/2/4 per page, JPEG quality, sample scan |
| PDF → JPG | 72–600 DPI; JPG/PNG/WebP; quality; white/grey/transparent background; page range; preview gallery |
| Markdown → PDF | Serif/Modern/Compact themes, page setup, **title page**, **TOC with real page numbers**, code highlighting, footnotes, frontmatter, live preview, counts |
| PDF → Markdown | Headings, tables, frontmatter, link targets, page breaks, images (marker/embedded), OCR fallback messaging |
| HTML → PDF | Upload/paste/sample; page setup, scale, margins, header/footer, print backgrounds; **headings → PDF bookmarks**; sanitisation report |
| Tables → CSV | Page range, detection sensitivity, header handling, **CSV/XLSX/JSON**, quote-all, select all/clear, combined download |

## Optimize

| Tool | Added |
| --- | --- |
| Compress | Screen/Balanced/Print/Archive presets; 72–600 DPI; JPEG quality; grayscale; strip metadata; remove annotations; keep text selectable; target-size attempt log; honest before/after report; cancel |
| Repair | Safe rebuild (with a second load strategy), aggressive salvage, pages-only; every rebuild re-opened and verified; recovery report; render width and metadata options |
| Page numbers | Six format presets incl. custom tokens; 3×3 position grid with live preview; start number, skip first, range, font, colour, opacity, bold, margin |

## Secure & sign

| Tool | Added |
| --- | --- |
| Protect | User + owner passwords, confirm, strength meter, show/hide, generated password; six-permission matrix; AES-256; opens-with and refuses-without verification |
| Unlock | Probe distinguishes plain / restricted / password / unreadable; **remove all** vs **restrictions only**; preserves forms/links/bookmarks; verifies no `/Encrypt` remains |
| Redact | Draw boxes + pattern search; **black box vs remove text**; case/whole-word/regex; range; per-match selection; **post-save verification** that matched text is gone |
| Find & Redact | Regex compile validation; page range; per-page select-all; context list; verification report; cancel |
| Sanitize | Granular groups (Info, XMP, scripts/actions, attachments, annotations, forms/XFA, layers, thumbnails, signatures, external links); before/removed/remaining verification table |
| Sign | Draw/type/upload; saved signatures (opt-in local only); date and initials stamps; multiple placements across pages; reason/location block; lock-after-signing |
| Watermark | Text or image; font/colour/bold; opacity, rotation, margin; 9-position grid; tiling; page range; **behind content**; live preview and invisibility warning |
| Fill forms | Field navigation and jump list; filled meter; required validation; **import/export values JSON**; flatten option; confirmed clear |
| Create form | Text, checkbox, radio, dropdown, date, **real signature field**; required/default/tooltip; click-to-place and drag-rectangle; tab order; fillable preview |
| Flatten | Forms only / annotations only / both; range; rasterisation; appearance baking with vectors/text preserved; summary |

## Intelligence & data

| Tool | Added |
| --- | --- |
| Ask your PDF | Suggested questions; citations with page + quote; page-range and multi-document scope with per-document toggles; conversation history; export Q&A; clear; cancellable indexing |
| Inspect PDF | 0–100 risk score with reasons; accessibility checks; PDF/A claim + output intent; image count + DPI estimate; repair suggestions; JSON + Markdown reports |
| Compare | Inline/side-by-side/overlay with blend; ignore whitespace/case; page range; per-page match %; added/removed/changed counts; diff context; HTML/CSV report |
| Summarise | Length, bullets vs paragraphs, keyword count, page range, reading time; explicit local-extractive method; Markdown and text exports |
| Metadata | Templates; XMP detect/strip; created/modified pickers with Today; confirmed **strip all metadata**; before/after diff; never persists personal fields |
| Bookmarks | JSON import/export; heading auto-generation with sensitivity/depth/running-head handling; duplicate/out-of-range validation; confirmed remove-all |
| Split by bookmarks | Depth, front-matter split; `{name}/{title}/{index}` naming with live preview; section table with page ranges; real ZIP bytes for rename/checksum |

## Files, archive & workflow

| Tool | Added |
| --- | --- |
| Archive readiness | PDF/A-1b/2b/3b **preparation profiles** (honest: not certification); Markdown/JSON audit export; before/after check comparison; existing flatten/strip/normalise controls |
| Workflow | Expanded palette (rotate, remove, extract, watermark, numbers, flatten, sanitize, compress); save/load pipeline JSON; duplicate/remove/drag-order; dry-run page simulation; per-step progress and cancel |
| Batch | Queue with per-file status, errors, **retry failed**, remove; new Flatten operation; aggregate progress + cancel; CSV report; ZIP or per-file results |
| Scan | Camera with permission fallback + sample scan; grayscale/B&W/contrast/brightness; rotate; page size/orientation/margins/quality; multi-page strip; presets |
| Extract images | Size filters, page range, dedupe, original/PNG/JPEG + quality, transparency flattening, ZIP or individual, thumbnail selection |
| Remove / extract pages | Visual `PagePicker` synced with the typed range; quick selection; live "N of M"; editable output name; one-PDF-per-page option |
| Edit PDF | Undo/redo; select/delete/duplicate/nudge; z-order; text size/colour/opacity/bold/italic/alignment; shapes incl. arrow/highlight/whiteout; image insert; zoom and page jump |
| OCR | Searchable language grid (18 languages), 150–400 DPI, grayscale/contrast/auto-rotate, searchable/text/both output, page progress + ETA, cancel terminates the worker, confidence preview |

## Reliability follow-ups worth knowing

- `@cantoo/pdf-lib` re-emits stale `/Encrypt` bytes when saving a password-decrypted document. The Unlock
  pipeline now drops stale security objects and verifies the result; this was validated against encrypted
  fixtures.
- Annotation flattening (new) bakes appearances into content streams. The synthetic fixture has no
  annotations, so a manual check with a commented/stamped PDF is recommended before relying on it for
  archival work.
- PDF → Word image extraction depends on PDF.js exposing decoded images; if it cannot, the conversion still
  succeeds without pictures rather than failing.
- Visual signatures are not certificate-backed; archival preparation is not PDF/A certification. Both are
  stated in the UI.
