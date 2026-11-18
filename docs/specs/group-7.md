# Group 7 — HTML, Archive, Markdown, Workflow

Files: `src/tools/HtmlArchive.tsx`, `src/tools/MarkdownTools.tsx`, `src/tools/Workflow.tsx`
Read `docs/PLAYBOOK.md` first.

## HTML → PDF
- Add input methods: upload HTML file, **paste HTML**, and **generated sample HTML** (`SAMPLE.html`);
  do not add URL fetching (CORS makes it unreliable and the CSP blocks arbitrary origins).
- Add page size/orientation/margins, scale, print-backgrounds, header/footer text, and “headings become
  bookmarks”.
- Keep and surface the DOMPurify sanitisation report (what was removed) before conversion.
- Keep `Convert HTML to PDF` and `HTML converted to PDF`.

## Archive readiness
- Keep the existing audit checks (they are strong). Add:
  - a **profile** selector (PDF/A-1b, PDF/A-2b, PDF/A-3b with attachments) and an honest note that this is
    an archival *preparation*, not a certified PDF/A validator;
  - export the audit report as JSON/Markdown;
  - controls for flatten forms, strip actions, normalise metadata, embed original;
  - a before/after check summary after preparing the copy.
- Keep `Prepare archive PDF` and `Archive copy prepared`.

## Markdown → PDF
- Add themes (Serif, Modern, Compact), page size/margins, title page, table of contents, code highlighting,
  footnotes, and frontmatter (title/author/date).
- Add a live preview toggle and a word/character count.
- Keep `document is ready`.

## PDF → Markdown
- Add toggles for headings, tables, images (linked/embedded/none), links, page breaks, and frontmatter.
- Add OCR fallback messaging for pages with no text layer (link to OCR, do not silently OCR).
- Keep `Convert to Markdown` and `Markdown output`.

## Workflow
- Expand the operation palette with the safe operations already in the codebase (rotate, compress, page
  numbers, watermark, flatten, protect, sanitize, extract pages, OCR where available).
- Add save/load pipeline as JSON, duplicate/remove steps, drag-to-reorder, and a per-step dry-run summary
  (estimated pages/files) before running.
- Add per-step progress with the current step name and Cancel between steps; keep the existing success copy.
- Keep the existing operation labels and finish states that E2E relies on.

Use `AdvancedOptions`/`OptionsGrid` where it does not hide the builder, `useToolPreferences` for saved
options, `DownloadPanel` with bytes, `usePrimaryShortcut` and `useDownloadShortcut`.
