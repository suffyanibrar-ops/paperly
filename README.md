# Paperly PDF

[![CI](https://github.com/suffyanibrar-ops/paperly/actions/workflows/ci.yml/badge.svg)](https://github.com/suffyanibrar-ops/paperly/actions/workflows/ci.yml)

A commercial-grade, privacy-first PDF platform. **51 working tools** run inside the browser — documents are never uploaded to a server.

Production: <https://paperlypdf.netlify.app/>

## What it does

- **Organize** — merge, split, reorder, rotate, crop, n-up, page numbers, headers/footers, Bates numbering, resize, edit bookmarks, split by bookmarks, and a **PDF Workflow** builder that chains up to eight operations across twenty files in one run.
- **Convert** — PDF ⇄ Word, Excel, PowerPoint, images, Markdown, HTML, text and CSV tables.
- **Optimize** — compress (including a **target file size** mode), repair, flatten, extract images, archive readiness.
- **Secure** — AES-256 protect/unlock, redact, find & redact by pattern, fill forms, create forms, sign, watermark, sanitize active content and metadata.
- **Intelligence** — extract text, OCR (18 languages), compare versions, summarise, ask a question across documents, inspect a PDF’s full structure and risk surface.
- **Platform** — command palette, local activity history, batch processing, installable offline PWA, no account, no uploads, no daily limits.

## Architecture

| Layer | Technology |
| --- | --- |
| UI | React 19 + TypeScript, Tailwind CSS 4, Vite 7 |
| Routing | Hash routes for resilient static hosting + real path URLs for the prerendered Netlify deployment; route-level `React.lazy` splitting |
| PDF engine | PDF.js 6.2.108 (render, text, outline), `@cantoo/pdf-lib` 2.11.1 (rewrite, AES-256, forms, outline writing) |
| OCR | Tesseract.js 6 (WASM worker); engine and language data are fetched from pinned CDNs on first use, then cached by the service worker |
| Office | `docx`, patched SheetJS 0.20.3, `pptxgenjs`, JSZip |
| HTML → PDF | html2canvas over DOMPurify-sanitised markup |
| HTML sanitisation | DOMPurify 3.4.17 with a strict tag/attribute allowlist and CSS property allowlist |
| Offline | Hand-written service worker generated at build time (`scripts/build-sw.mjs`): precached shell + hashed assets + PDF.js worker + fonts, network-first navigations, cache-first assets |
| Fonts | Self-hosted WOFF2 (Inter Tight, Instrument Serif) — no font CDN request |
| Build | `vite build` → hashed chunks in `dist/assets` → `scripts/copy-worker.cjs` → `scripts/prerender.mjs` writes 62 static SEO routes → `scripts/build-sw.mjs` writes `dist/sw.js` |
| CI | GitHub Actions: typecheck, lint, unit tests, coverage gate, production build, Playwright matrix |

### Performance

| Build | First load (gzip) | Notes |
| --- | --- | --- |
| Previous single-file bundle | **1,086 KB** | One inlined `index.html` (3.37 MB raw) duplicated into every prerendered route; 176 MB `dist` |
| Current split build | **~131 KB** | Entry 118 KB + CSS 13.5 KB + preload helper 0.6 KB; PDF/Office/OCR engines load on demand; ~6.4 MB `dist` |

Heavy vendors are grouped per package (`vendor-pdfjs`, `vendor-pdf-lib`, `vendor-ocr`, `vendor-spreadsheet`, …) so a shared chunk never drags an unused engine into the first paint. Route pages and tool interfaces are lazy; a tool’s engine is only fetched when that tool is opened.

### Directory map

```
src/lib/security.ts      upload validation, magic bytes, zip-bomb guards, DOMPurify policy, safe errors
src/lib/pdf.ts           PDF.js/pdf-lib orchestration, canvas memory caps, managed document teardown
src/lib/format.ts        tiny dependency-free formatters used by the app shell
src/lib/textGeometry.ts  pure text-geometry helpers (line grouping, boxes, normalisation)
src/lib/textItems.ts     PDF.js text-item extraction into page geometry
src/lib/extract.ts       reading-order text extraction, paragraphs, column detection
src/lib/knowledge.ts     deterministic BM25-style retrieval for Ask Your PDF
src/lib/redactPatterns.ts pattern presets, matching, Luhn/IBAN validation, reports
src/lib/outline.ts       outline tree flattening, split ranges, heading detection, outline writing
src/lib/tables.ts        table region/column detection, cell assembly, RFC-4180 CSV
src/lib/toolRegistry.ts  single source of truth for all 51 tools (also parsed by the prerenderer)
src/tools/               tool implementations grouped by domain
src/pages/               marketing, legal, help, guides, comparison and activity pages
scripts/prerender.mjs    static SEO generation (titles, canonicals, OG, JSON-LD, sitemap, OG image)
scripts/build-sw.mjs     offline service-worker/precache manifest generation
scripts/serve-dist.cjs   production-parity QA server (applies netlify.toml CSP/security headers)
tests/unit               Vitest + Testing Library (security, uploads, geometry, retrieval, patterns, outline, tables)
tests/e2e                Playwright output-verification suites
```

## Testing

- `tests/unit` — 220+ Vitest tests. `security.ts` is coverage-gated at 70%; text geometry, retrieval ranking, redaction patterns, outline math, table/CSV generation and app registry all have dedicated suites. A registry consistency test enforces 50 unique tools, valid related-tool links and **a renderer for every registered tool**.
- `tests/e2e` — Playwright suites against a production-parity server (real CSP, gzip, prerendered routes). `matrix-a.spec.ts` and `matrix-b.spec.ts` exercise every registered tool with generated-output assertions (page counts, extracted text, form values, encryption, ZIP contents, image signatures, metadata, outline targets, CSV cells) plus malformed-input, malicious-archive, wrong-password and 120-page large-file cases. `power.spec.ts` covers the eight newest tools end-to-end plus the offline service worker. The full suite is **74 tests** (critical 8, matrix-a 25, matrix-b 26, power 12, mobile 2) and runs green in ~2 minutes against the production build.
- Every tool is verified by its **output**, not by whether a button rendered.

## Commands

```bash
npm install
npm run dev              # local development
npm run build            # production build + SEO prerender + offline service worker
npm run preview          # preview the built app
npm run typecheck        # tsc --noEmit
npm run lint             # ESLint (flat config)
npm test                 # Vitest unit/integration tests
npm run test:coverage    # coverage with enforced thresholds
npm run test:e2e         # Playwright (production-parity server, gzip + real headers)
npm run test:e2e:install # install the Chromium binary once
node scripts/e2e-fixtures.cjs  # regenerate the synthetic PDF/DOCX fixtures
```

## Security model

- **No document upload endpoint exists.** Files are read with the File API and processed in the tab. The server only ever serves static assets.
- **Signature validation before parsing** for PDF/JPEG/PNG/GIF/WebP/AVIF/TIFF and OOXML; a text file renamed `.pdf` is rejected.
- **Zip guards** for DOCX/XLSX/PPTX: entry count, uncompressed size, compression ratio, traversal paths and encrypted entries.
- **Spreadsheet parsing** disables formula evaluation, HTML export and VBA; sheet/row counts are bounded.
- **HTML → PDF** strips scripts, frames, objects, forms, SVG, event handlers and remote resources via DOMPurify plus a second DOM pass; inline CSS is filtered by property allowlist; rendering happens off-screen in an inert subtree.
- **Resource limits**: PDF ≤ 200 MB / 1,000 pages, images ≤ 40 MB, canvas ≤ 40 MP; OOM errors are mapped to actionable messages.
- **Redaction** rasterises affected pages and burns the redactions into the image, so extracted text is genuinely removed. Unmarked pages keep selectable text. **Find & Redact** applies the same true-redaction pipeline to pattern matches (emails, phones, SSNs, cards, IBANs, dates, custom regex).
- **Sanitize** removes JavaScript/actions, embedded files, Info + XMP metadata, annotations, form fields, optional-content layers, thumbnails and signature fields through pdf-lib’s low-level object graph, then reloads the output to verify every selected structure is gone.
- **Encryption** uses AES-256 and self-verifies that the output requires the password. Passwords never leave the tab.
- **Security headers** (CSP, HSTS, nosniff, frame-deny, referrer and permissions policy) are declared in `netlify.toml` and mirrored in `public/_headers`; the Playwright suite asserts them on the production-parity server.

## Privacy disclosures

- **Fonts are bundled.** No request to Google Fonts or any other font CDN is made at runtime.
- **Documents are never sent to an OCR service.** The only external requests, made when you use OCR, are the pinned Tesseract engine/core (`cdn.jsdelivr.net`) and the language data (`tessdata.projectnaptha.com`). Pages are rendered locally; only the engine files are downloaded, then cached by the service worker so offline OCR works after first use.
- Activity history stores tool name, output filename, pages, size and timestamp under `paperly.activity.v1`; clear it from **Activity**.
- The app works fully offline after the first visit: the service worker precaches the shell, every hashed asset, the PDF.js worker and the self-hosted fonts. Navigations fall back to the cached shell when the network is unavailable.

## Known, disclosed limitations

1. **Extraction and inspection are heuristic where the PDF format allows it.** Ask Your PDF is lexical BM25 retrieval, not semantic: it returns the passages that contain your words and never invents an answer. Table extraction is positional (merged cells, borderless columns and rotated pages need review). Heading detection for bookmarks is font-size/line-length based. Sanitize removes reachable structures, not orphaned objects, and is not a certification.
2. **OCR needs one network fetch** for the engine/language data on first use. There is no bundled OCR model; after the first run the service worker keeps the CDN responses for offline use.
3. **PDF/A is not certified.** The Archive tool produces an archival copy and a readiness report; validate with veraPDF if you need formal conformance.
4. **Signatures are visual**, not certificate-backed.
5. **Office conversion is text-first**; complex layout fidelity is not guaranteed.
6. **Certified compliance, native apps, cloud-storage integrations and AI translation are not offered.** The comparison page says so explicitly.
7. **Service-worker updates apply on the next navigation** (the new worker activates immediately and the page reloads on the following visit). Clear site data to force a hard reset.
8. **Browser support**: modern Chromium, Firefox and Safari. The e2e suite runs in Chromium only.

## Deployment (Netlify)

1. Connect the repository; Netlify reads `netlify.toml` (`npm run build`, publish `dist`).
2. Set `PAPERLY_ORIGIN=https://paperlypdf.netlify.app` (or the custom domain) so canonical URLs and the sitemap use the correct host.
3. Deploy, then verify headers with `curl -I https://<domain>/` and confirm `/sitemap.xml`, `/robots.txt`, `/pdf.worker.min.mjs`, `/sw.js`, `/fonts/*.woff2` and a prerendered route such as `/tool/merge`. The previous deployment served none of these — a redeploy is required after source changes.
4. Verify the offline path: load the site once, go offline in DevTools, reload, and confirm the shell and a previously opened tool load.
5. No private environment variables are read by client code; do not add secrets to Vite variables.

## Reporting security issues

Email `privacy@paperly.tools`. Do not attach sensitive documents.
