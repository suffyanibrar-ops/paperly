# Paperly PDF — system architecture and engines

## 1. Principles

1. **Local by architecture.** There is no upload endpoint. Every byte is processed in the tab; the service
   worker only caches code and engine assets.
2. **Lazy engines.** The shell, catalogue and marketing pages never import PDF.js, pdf-lib, Office
   writers, OCR or spreadsheet code. A tool's engine loads when that tool opens.
3. **One contract per concern.** Progress/cancel, options persistence, page selection, output handling and
   error copy are shared engines — not reimplemented per tool.
4. **Fail with instructions.** Every error names the cause and the next action.
5. **Nothing irreversible without proof.** Redaction and sanitisation verify the saved output.

## 2. Layers

```
                       ┌────────────────────────────────────────────┐
                       │ Shell: router, Chrome, CommandPalette, SEO  │
                       │ (no PDF engine in the first paint)          │
                       └───────────────┬────────────────────────────┘
                                       │ route: /tool/:id
                       ┌───────────────▼────────────────────────────┐
                       │ ToolPage → lazy tool module                 │
                       │ ToolShell (identity, privacy, shortcuts)    │
                       └───────────────┬────────────────────────────┘
                                       │
     ┌─────────────────────────────────┼──────────────────────────────────┐
     │                                 │                                  │
┌────▼─────────────┐        ┌──────────▼───────────┐         ┌────────────▼───────────┐
│ Workspace UI      │        │ Tool engines          │         │ Shared engines          │
│ FileDrop, PagePicker│      │ PDF.js / pdf-lib      │         │ job · prefs · pageQuery │
│ AdvancedOptions   │        │ docx/xlsx/pptx/JSZip  │         │ output · sample ·       │
│ DownloadPanel     │        │ Tesseract OCR         │         │ security · knowledge ·  │
│ OutputPreview     │        │ DOMPurify/html2canvas │         │ outline · tables ·      │
└───────────────────┘        └───────────────────────┘         │ extract · redactPatterns│
                                                                └────────────────────────┘
```

## 3. Engines and contracts

### 3.1 Job engine — `src/lib/job.ts`

- `useJob<T>()` → `{ run, cancel, retry, reset, status, result, error, percent, label, detail, etaMs }`.
- `run(task)` gives a `JobReporter` with `report`, `step`, `throwIfCancelled`, `signal`.
- Guarantees: one run at a time; cancelling aborts the signal and ignores the late result; errors are
  normalised through `friendlyProcessingError`; unmount aborts; state updates are sequence-guarded.
- Tools call `throwIfCancelled()` between pages/files and surface `Cancel`.

### 3.2 Preference engine — `src/lib/prefs.ts`

- Namespaced `paperly.prefs.v1.<scope>` envelope `{version, value, savedAt}`.
- `useToolPreferences(toolId, defaults)` merges new defaults with saved values, so a release can add an
  option without breaking existing storage.
- Corrupt JSON, old versions, private mode and quota failures degrade to defaults.
- `useStickyFlag` / `useStickyValue` keep UI state (open panels, last preset) separate from tool options.
- Only settings are stored — no file contents, passwords or personal data.

### 3.3 Page-query engine — `src/lib/pageQuery.ts`

- `parsePageQuery(input, total)` supports `all`, `odd`, `even`, `last`, `last-N`, `N-M`, `N-M:step`, `N-`,
  `-M`, `>N`, `<N`, descending ranges, and de-duplicates.
- `resolvePages` is exposed to tools through the existing `parseRanges` in `src/lib/pdf.ts`, so all 28
  existing call sites gained the new syntax without a rewrite.
- `describePageQuery`, `pagesToQuery`, `pageQueryChips`, `validatePageQuery` support summaries, round
  trips and live validation.
- `PagePicker` combines thumbnails, shift-click ranges, All/Odd/Even/Invert/Clear and a typed fallback for
  large documents.

### 3.4 Output engine — `src/lib/output.ts`

- MIME/kind inference, extension enforcement, safe naming, text decode.
- Download, new-tab open, clipboard copy, Web Share, SHA-256.
- `DownloadPanel` composes these with rename, preview, copy/share, checksum, result facts and one-click
  hand-off to a follow-up tool.
- `OutputPreview` renders PDFs page-by-page with PDF.js, images via a short-lived blob URL and text
  directly. No iframe/object navigation (CSP `frame-src 'none'`, `object-src 'none'`).

### 3.5 PDF core — `src/lib/pdf.ts`

- PDF.js **legacy build** loading task (Safari-compatible iterator/withResolvers polyfills) with an explicit `destroy()`, page limit (1000), canvas pixel cap (40 MP).
- pdf-lib helpers for load/save, fonts, safe WinAnsi text, wrapping, colours and downloads.
- All tools dispose PDF.js documents; memory is released page by page via `page.cleanup()`.

### 3.6 Document intelligence — `src/lib/knowledge.ts`, `extract.ts`, `tables.ts`, `outline.ts`

- Reading-order extraction, paragraph/column detection, BM25-style retrieval, table detection and RFC-4180
  CSV, outline flattening/writing and split ranges.
- Deterministic, local and dependency-light; no network model calls.

### 3.7 Security — `src/lib/security.ts`

- Upload validation by extension + MIME + magic bytes; zip-bomb ratio/entry caps; PDF page caps.
- DOMPurify allowlist for HTML→PDF; CSS property allowlist.
- `friendlyProcessingError` strips paths/stacks and maps engine failures to human copy.
- Download-name sanitisation prevents traversal.

### 3.8 Samples — `src/lib/sample.ts`

- Locally generated PDF (cover/invoice/terms), scan PNG, Markdown, CSV, HTML and text.
- Heavy PDF generation is dynamically imported, so samples never enter the first paint.

## 4. Tool anatomy

Every tool module exports one or more React components. A typical tool:

1. reads a file through `usePdfFile` / `FileDrop` (validation happens before any parser);
2. holds options in `useToolPreferences` or local state;
3. runs a cancellable async pipeline that reports progress;
4. renders a `DownloadPanel` with the output bytes;
5. exposes keyboard shortcuts and an `AdvancedOptions` panel for secondary controls.

Tools may compose helpers from `src/lib` but **must not** add network calls, uploads or new dependencies.

## 5. Performance and bundling

- Route-level `React.lazy`; one module per tool group.
- Vendor groups: `vendor-pdfjs`, `vendor-pdf-lib`, `vendor-jszip`, `vendor-ocr`, `vendor-docx`,
  `vendor-pptx`, `vendor-spreadsheet`, `vendor-canvas`.
- The shell imports only pure helpers (`format`, `router`, `prefs`, `activity`, `hotkeys`, `output`,
  `pageQuery`); `ui.tsx` imports `security` (DOMPurify) and type-only sample signatures.
- Service worker precaches the shell, hashed assets, PDF.js worker and fonts; navigations are
  network-first, assets cache-first.
- Long loops yield between pages so Cancel clicks and progress paint are not starved.

## 6. Security model

- CSP: `default-src 'self'`, `object-src 'none'`, `frame-src 'none'`, `connect-src 'self' blob: data:`
  plus the two pinned engine CDNs (Tesseract wasm + language data).
- No `eval`; PDF.js `isEvalSupported: false`.
- X-Frame-Options DENY, COOP/CORP same-origin, HSTS, Permissions-Policy with camera allowed only for scan.
- Preferences contain no document data; activity stores filename/size/pages only.
- Redaction verification re-extracts text from the saved bytes to prove removal.

## 7. Accessibility

- Result panels are announced (`role="status"`, `aria-live`) and receive focus.
- Every new control has a label or `aria-label`; toggles use `aria-pressed`.
- Free previews/dialogs are modal, Escape-closable and return focus.
- Thumbnail pickers are real buttons with page-number labels; shift-click is an enhancement, not the only
  path.
- Reduced motion is respected by the animation classes (`prefers-reduced-motion`).

## 8. Error taxonomy

| Class | Example | Copy strategy |
| --- | --- | --- |
| Upload | wrong type, fake PDF, oversized | name the file and the accepted formats/limit |
| Password | encrypted PDF | offer Unlock PDF, never leak internals |
| Corrupt | invalid xref, broken stream | offer Repair PDF |
| Memory | canvas/allocation failure | suggest fewer pages / lower DPI |
| Storage | quota exceeded | suggest fewer pages or a new tab |
| User | invalid range, empty password | field-level message next to the input |
| Cancelled | user pressed Cancel | neutral notice, no error styling |

## 9. Testing strategy

- **Unit:** security, upload validation, text geometry, retrieval, redaction patterns, outline, tables,
  page-query, preferences, job engine, output naming/MIME.
- **E2E:** every registered tool is exercised against the production build with output assertions (page
  counts, extracted text, form values, encryption, ZIP contents, image signatures, metadata, outline
  targets, CSV cells), plus malformed input, malicious archives, wrong passwords and a 120-page file.
- **Registry test:** 51 tools, unique ids, valid related links, a renderer for every tool.

## 10. Adding a tool

1. Implement the component under `src/tools/` and export a named function.
2. Register metadata in `src/lib/toolRegistry.ts` and the lazy loader in `src/pages/ToolPage.tsx`.
3. Reuse `usePdfFile`, `RangeField`/`PagePicker`, `AdvancedOptions`, `useJob` and `DownloadPanel`.
4. Update the registry test count only when the catalogue intentionally changes.
5. Add a unit test for pure logic and an output-verifying E2E case.
6. Run `npm run typecheck && npm run lint && npm test && npm run build && npm run test:e2e`.
