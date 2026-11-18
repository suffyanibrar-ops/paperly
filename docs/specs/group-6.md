# Group 6 — Intelligence, Privacy, OCR, Metadata

Files: `src/tools/Knowledge.tsx`, `src/tools/Privacy.tsx`, `src/tools/OcrTool.tsx`,
`src/tools/MetadataEdit.tsx`
Read `docs/PLAYBOOK.md` first.

## Ask your PDF
- Add **suggested questions** derived from the indexed passages (3–4 chips) so the tool is usable without
  knowing what to ask.
- Add per-answer citations with page numbers and quoted context (keep the existing verbatim answer path).
- Add scope controls: all pages vs a page range, and multi-document scope with per-document passage counts.
- Add **Export Q&A** (Markdown) and a “clear conversation” action.
- Keep `Find answer`, `Indexed 3 passages from 3 pages across 1 PDF`, and
  `Answer · verbatim from your PDFs`.

## Inspect PDF
- Add a **risk score** (0–100) with a plain-language band and the top three reasons.
- Add accessibility checks (tagged, language, title, bookmarks), PDF/A-claim checks, page-size summary,
  image count/DPI estimate, and a list of repair suggestions.
- Add **Export report** as JSON and Markdown, and a copy-summary action.
- Keep `Structural red flags`, `Not encrypted`, and the metadata key copy.

## Find & redact
- Keep the existing presets, Luhn/IBAN validation and report. Add:
  - custom regex with validation and a clear error;
  - page range and “apply to all matches”;
  - per-match context with a deselect checkbox;
  - post-apply verification that matched text no longer extracts, with a pass/fail report.
- Keep `Find matches`, `What to remove`, `What to look for`, and `Redactions applied`.

## Sanitize
- Add explicit toggles: standard metadata, XMP, JavaScript/actions, embedded files, annotations, form/XFA,
  optional content layers, and external links. Explain what each removes.
- Add a **verification report** after saving (what was found before, what remains) and a “nothing found”
  state.
- Keep `Sanitized copy ready and verified`, `Disable all` and the `removed by the sanitiser` copy.

## OCR
- Add language search/selection (keep all 18), page range, DPI/scale, preprocessing (grayscale, contrast,
  auto-rotate when a page is sideways), and “searchable PDF” vs “text only” vs “both”.
- Add page-level progress, ETA, and Cancel (Tesseract worker must be terminated on cancel).
- Show confidence/first-page text preview before download.
- Keep `OCR PDF` and `Searchable PDF ready` (including `No searchable PDF produced` failure copy).

## Metadata
- Add metadata templates (Author/Subject/Keywords presets), XMP check, created/modified date pickers, and
  a batch-across-files mode if the current architecture allows it without a rewrite.
- Add “Strip all metadata” with a confirmation, and show a before/after diff of changed keys.
- Keep `Save metadata & download`, `Metadata updated`, `Clear all standard metadata`.

Use `AdvancedOptions`, `useToolPreferences`, `useJob` (OCR/redaction progress + cancel), `DownloadPanel`
with `bytes`, and keyboard shortcuts.
