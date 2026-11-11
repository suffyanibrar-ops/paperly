# Security policy and verified controls

_Last verified: production-build audit, November 2026 (50-tool split build)._

## Threat model

Paperly is a client-side application with no document-processing backend. The primary risks are therefore **malicious input files**, **untrusted markup**, **sensitive data hidden inside documents** (active content, metadata, attachments) and **supply-chain compromise** — not server-side data breaches.

## Controls and evidence

| Control | Implementation | Verification |
| --- | --- | --- |
| No document upload | File API + in-tab engines | Playwright suites record requests; no document bytes leave the tab |
| File type validation | magic bytes + size + accept list (`src/lib/security.ts`) | 8 unit tests + e2e rejection of a fake PDF |
| ZIP validation | **central-directory** inspection (EOCD/ZIP64, data-descriptor safe, duplicate/encrypted/traversal/ratio/size checks, local-header cross-check) | 21 adversarial unit tests in `tests/unit/zip.test.ts` |
| Office parser hardening | formula/VBA/HTML disabled, row & sheet caps | SheetJS upgrade regression + e2e fixtures |
| HTML sanitisation | DOMPurify allowlist + DOM second pass + CSS allowlist | 12 unit tests including scripts, iframes, SVG, `javascript:`, remote images, `position:fixed`, `url()` |
| Remote resource blocking | only `data:image/*` survives in HTML conversion | e2e asserts zero `evil.test` requests |
| Resource limits | 200 MB PDF / 1,000 pages / 40 MP canvas / 25–80 MB Office | unit tests + shipped constants |
| Memory safety | loading-task teardown shim, `page.cleanup()`, canvas release, OOM error mapping | PDF.js 6 upgrade verified by e2e merge |
| Redaction (manual) | page rasterisation + burned pixels | e2e + **independent Poppler**: redacted page 1 = 0 extractable chars, page 3 = 279 chars, sensitive token absent from page 1; `qpdf --check` clean |
| Pattern redaction (`find-redact`) | text-line matching → normalised boxes → same rasterise-and-burn pipeline; pages without matches are byte-copied | `tests/e2e/power.spec.ts` asserts the matched token is gone from extracted text of the flattened page while untouched pages keep their text |
| Sanitizer (`sanitize`) | pdf-lib low-level removal of JS/actions, embedded files, Info + XMP, annotations, AcroForm, OCProperties, thumbnails, signature fields (`context.delete` on removed graphs) | unit-tested helpers + e2e: output is reloaded and every selected structure is re-checked; residual structure aborts the download |
| Metadata rewrite (`metadata`) | Info dictionary only; output reloaded and re-read before download | e2e asserts `getTitle()`/`getAuthor()` on the downloaded bytes |
| Encryption | AES-256 via Web Crypto, verified output | e2e + **independent qpdf/Poppler**: `R = 6`, `AES-256`, wrong password rejected, unlock output has zero `/Encrypt` |
| Security headers | `netlify.toml` CSP/HSTS/frame-deny/permissions, mirrored in `public/_headers` | Headless Chromium loads 13 routes with **zero `securitypolicyviolation` events**; `script-src` no longer needs `'unsafe-inline'` (no inline scripts in the split build) |
| Fonts | Self-hosted WOFF2, `font-src 'self' data:` | Network log shows only `/fonts/*.woff2`; no `fonts.googleapis.com` / `fonts.gstatic.com` anywhere in source or build |
| Offline cache | Service worker precaches only same-origin static assets (shell, hashed JS/CSS, PDF.js worker, fonts, icons); no document bytes are ever cached; OCR CDN responses are stale-while-revalidate | `scripts/build-sw.mjs` manifest review + VM smoke test + e2e offline reload |
| Dependencies | SheetJS 0.20.3 from the official CDN, PDF.js 6.2.108, image-size override 2.0.4, Vite 7.3.7; `vite-plugin-singlefile` removed | `npm audit` reviewed; production build verified |

## Dependency provenance

- `xlsx@0.20.3` is installed from `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` (the vendor’s official distribution channel; the npm registry copy remains at 0.18.5 and is vulnerable to CVE-2023-30533 and CVE-2024-22363).
- `pdfjs-dist@6.2.108` fixes GHSA-hq66-cqwq-w95j (arbitrary JavaScript via a malicious PDF).
- `image-size@2.0.4` is enforced with an npm override to fix GHSA-5p2g-fcmc-qvqq / GHSA-w3rx-r6r6-pgpr pulled in by `pptxgenjs`; the PPTX writer was regression-tested after the override.

## Known limitations

1. **`style-src` still requires `'unsafe-inline'`** because the UI uses inline style attributes for dynamic values (positions, colours, dimensions). `script-src` no longer allows inline scripts: the build emits external hashed chunks only and prerendered JSON-LD blocks are non-executable.
2. HTML conversion executes no scripts, but it is not a formally sandboxed origin (separate-origin iframe or server-side rendering). Isolation relies on allowlist sanitisation, inert rendering and CSP.
3. OCR downloads third-party engine files at runtime; pinning versions reduces, but cannot eliminate, upstream risk. The service worker caches those pinned URLs for offline reuse.
4. Visual signatures are not certificate-backed and must not be represented as qualified e-signatures. Sanitizing a signed document invalidates the signature by design.
5. Extraction tools that infer structure are heuristic by nature: pattern redaction matches within text lines (not across line breaks), table extraction is positional, bookmark heading detection is font-size based, and Ask Your PDF is lexical retrieval. The UI discloses each limitation; none of them fabricate content.
6. Sanitize removes reachable structures and their object graphs; orphaned objects elsewhere in the file are not guaranteed to be removed, and no compliance certification is claimed.
7. **Browser automation is Chromium-only**; Firefox/WebKit are not in CI.
8. **No security certification** is claimed: controls are tested behaviours, not an audit certification.

## Reporting

Email `privacy@paperly.tools` with reproduction steps. Never include sensitive documents; a minimal synthetic PDF is enough.

## Independent verification log (previous audit on the 42-tool build)

Commands run against artefacts produced by the Playwright matrix:

```text
$ qpdf --show-encryption --password='' protect-sample-protected.pdf
Incorrect password supplied
R = 6
P = -1340
print high resolution: allowed      extract for any purpose: not allowed

$ pdfinfo -upw 'Matrix-Passphrase1!' protect-sample-protected.pdf
Pages: 3   Encrypted: yes (... algorithm:AES-256)

$ qpdf --check --password='wrong' protect-sample-protected.pdf
qpdf: ...: invalid password

$ grep -ac '/Encrypt' unlock-encrypted-unlocked.pdf
0

$ pdftotext -f 1 -l 1 redact-sample-redacted.pdf - | tr -d '[:space:]' | wc -c
0
$ pdftotext -f 3 -l 3 redact-sample-redacted.pdf - | grep -c '99887766'
1        # untouched page retains its own text, as designed
$ qpdf --check redact-sample-redacted.pdf
No syntax or stream encoding errors found
```

CSP and font verification for the current build (headless Chromium, production-parity server):

```text
routes checked: /, /tools, /tool/{merge,ask-pdf,inspect-pdf,find-redact,sanitize,bookmarks,
                split-bookmarks,metadata,tables-to-csv}, /activity, /sitemap
securitypolicyviolation events: 0
console errors: 0
fonts requested: /fonts/inter-tight-latin-normal.woff2, /fonts/instrument-serif-latin-italic.woff2 (both 200)
external font origins requested: none
```
