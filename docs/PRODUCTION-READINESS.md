# Paperly PDF — production readiness

This checklist covers what "production ready" means for a client-side document platform: correctness,
determinism, memory behaviour, security posture, accessibility, observability and deployability.

## 1. Release gates

Run in this order before shipping:

```bash
npm run typecheck      # tsc --noEmit
npm run lint           # eslint .
npm test               # fixtures + 313 Vitest tests
npm run build          # vite build + worker copy + SEO prerender + service worker
npm run test:e2e       # 76 Playwright cases against the production build
```

A release is blocked by any failing gate. The E2E suite verifies **outputs**, not just rendered buttons:
page counts, extracted text, form values, encryption, ZIP contents, image signatures, metadata, outline
targets and CSV cells.

## 2. Browser support

| Browser | Status | Notes |
| --- | --- | --- |
| Chrome / Edge (evergreen) | Primary | Full PDF.js, OCR wasm, Web Share, clipboard image copy |
| Firefox (evergreen) | Supported | Clipboard image copy limited; share sheet often absent (buttons hide) |
| Safari 16.4+ | Supported | Legacy PDF.js build supplies iterator-helper / `Promise.withResolvers` polyfills; Web Share preferred; large canvases are released after each page |
| Mobile Safari / Chrome | Supported | Camera capture in Scan requires HTTPS and user permission |
| IE / legacy Edge | Not supported | ES2020 modules and WASM |

Feature detection, not user-agent sniffing, decides optional actions (share, clipboard, camera).

## 3. Limits and memory behaviour

- PDF: 200 MB, 1,000 pages per run.
- Images: 40 MB each, 200 images per image-to-PDF run.
- Office: 50 MB docx, 25 MB xlsx, 80 MB pptx.
- Text/HTML: 5 MB / 2 MB; CSVs 25 MB; zip entries 4,000 and ratio 200.
- Canvas: 40 MP hard cap; pages above it are downscaled or rejected with guidance.
- PDF.js documents are destroyed after use; page canvases are reset to 1×1 after export to release
  backing stores on Safari.
- Long loops yield between pages so progress and Cancel remain responsive.
- Users are told to split files rather than silently degrading quality.

## 4. Security review

| Area | Control |
| --- | --- |
| Uploads | Extension + MIME + magic-byte validation before parsing; size caps |
| Archives | Zip-bomb ratio/entry caps; path traversal rejection |
| HTML | DOMPurify allowlist (tags, attributes, CSS properties); scripts/iframes/objects removed |
| PDF scripting | JavaScript/OpenAction detection (Inspect/Sanitize/Archive); removal in sanitised copies |
| CSP | `default-src 'self'`; `object-src 'none'`; `frame-src 'none'`; `connect-src 'self' blob: data:` + pinned OCR CDNs |
| Framing | `X-Frame-Options: DENY`, `frame-ancestors 'none'` |
| Cross-origin | COOP/CORP same-origin; referrer strict-origin-when-cross-origin |
| Crypto | AES-256 via `@cantoo/pdf-lib`; no home-grown crypto |
| Errors | Paths, stack traces and module internals stripped before display |
| Downloads | Filenames sanitised; MIME derived from extension; no `javascript:` URLs |
| Storage | Preferences/activity hold options, filenames, sizes and page counts only — never bytes |
| Verification | Redaction/sanitisation re-extract output text and report pass/fail |

No analytics, no error reporting endpoint, no third-party request during normal use. The only external
origins allowed by CSP are the pinned Tesseract engine/language CDNs, fetched on first OCR use.

## 5. Privacy review

- There is no upload endpoint in the codebase.
- The service worker caches code and fonts, never documents.
- Activity history is local (`localStorage`) and clearable in one action.
- Samples are generated locally and contain no personal data.
- The privacy page and tool chrome describe the architecture accurately.

## 6. Accessibility review

Target: WCAG 2.2 AA for the shell and primary tool flows.

- Keyboard: all controls are native buttons/inputs; thumbnail grids are buttons; Escape closes dialogs;
  ⌘K, ⌘↵, ⌘S, `?` and shift-click ranges have visible equivalents.
- Focus: result panels receive focus and are announced; dialogs focus their close button; global
  `:focus-visible` ring.
- Semantics: labelled fields, `aria-pressed` toggles, `role="alert"` errors, `role="progressbar"` with
  `aria-valuetext`, `aria-live` results.
- Motion: `prefers-reduced-motion` disables animation and smooth scrolling.
- Targets: icon-only buttons get ≥36 px hit areas on coarse pointers.
- Colour: existing palette meets contrast for body text and actions; status is never colour-only.
- Not yet audited: screen-reader walkthrough of the canvas editors (Edit/Sign). Tracked as follow-up.

## 7. Performance budget

- First load: shell + CSS + fonts, no document engine.
- Tool engine loads on first open of that tool and is cached by the service worker.
- Vendor chunks are isolated per package so opening one tool never preloads another engine.
- Previews render one page at a time; thumbnails are capped at 120 and rendered progressively.
- Checksums are computed only on demand; previews open only on demand.

## 8. Determinism and output integrity

- Same input + same options produce the same structural output.
- Outputs are validated implicitly by E2E (opens with pdf-lib/JSZip, expected page counts/signatures).
- The result panel exposes size, pages, settings and an optional SHA-256 so a user can prove the file they
  saved is the file that was produced.
- If compression would enlarge a file, the UI says so rather than claiming a saving.

## 9. Recovery paths

| Failure | Recovery offered |
| --- | --- |
| Encrypted file | Unlock tool link in the error |
| Corrupt file | Repair tool link |
| Memory exhaustion | Close tabs / split the file / lower DPI |
| Wrong password | Inline message, no state change |
| Cancelled job | Neutral notice, prior result retained |
| Tool crash | Route-level error boundary with "Try again" and "Choose another tool" |
| Storage unavailable | Preferences silently fall back to defaults |

## 10. Deployment

- Netlify: `netlify.toml` applies CSP/security headers; SPA fallback; prerendered routes are real files.
- GitHub Pages preview: `PAPERLY_BASE` supports sub-path deployments.
- Service worker: generated at build time with a content-hashed cache name; `sw.js` is never cached.
- Rollback: redeploy the previous build; no server state or migrations to reverse.

## 11. Known limitations (documented, not hidden)

- Visual signatures are not cryptographic digital signatures (no certificate/PKI).
- Archival preparation is not a certified PDF/A validation.
- Summaries and Q&A are deterministic/extractive, not generative AI.
- OCR accuracy depends on scan quality and language data; the UI reports failure instead of pretending.
- Very large documents (100+ MB, hundreds of pages) may be slow on low-memory mobile devices; the app caps
  and guides rather than crashing.
- PDF/PowerPoint conversion fidelity is best-effort for complex layouts (fonts, nested tables, charts).

## 12. Operational checklist per release

- [ ] Typecheck, lint, unit, build, E2E green.
- [ ] New options stored under versioned preference scopes; no personal data.
- [ ] New controls labelled; errors use alert roles.
- [ ] Long operations cancellable; no state update after unmount.
- [ ] E2E-critical button labels and success copy unchanged.
- [ ] Bundle budget checked (no engine in the entry chunk).
- [ ] Privacy/security copy still accurate.
- [ ] Docs (`README`, architecture, this file) updated.
