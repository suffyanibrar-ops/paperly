# Paperly production audit — 19 November 2026

Scope: the existing repository at `suffyanibrar-ops/paperly`, branch `main`, 51 registered tools and
their shared engines. The upgrade described in `TOOL-ENHANCEMENTS.md` was already present in two local
commits; this audit re-verified it, tested the integrated build, and fixed the defects found here.

## 1. What was inspected

- Repository, branch, remote, commits and working tree (`origin` → `https://github.com/suffyanibrar-ops/paperly.git`).
- Stack: React 19 + TypeScript, Vite 7, Tailwind 4, PDF.js 6.2.108 (now the legacy build), pdf-lib,
  Tesseract.js, docx/xlsx/pptx, JSZip, DOMPurify, html2canvas.
- All 20 tool modules exporting the 51 registered tools, plus shared engines (`pdf`, `security`, `job`,
  `prefs`, `pageQuery`, `output`, `extract`, `knowledge`, `tables`, `outline`, `redactPatterns`).
- Prerender/service-worker scripts, CSP and security headers, unit/E2E suites, CI workflow, deployment config.
- Runtime in Chromium (desktop + Pixel 7 viewport) and the production build served by `vite preview`.

## 2. Prioritised findings

| ID | Priority | Finding | Status |
| --- | --- | --- | --- |
| P0-1 | Critical | Every tool crashed in Safari with `Can't find variable: Iterator`. PDF.js 6 uses ES2025 iterator helpers and `Promise.withResolvers`; Safari before 18.4 has neither. | **Fixed** — `src/lib/pdf.ts` and `ConvertDocs.tsx` use `pdfjs-dist/legacy/build/pdf.mjs`; the worker is copied from the same legacy build. |
| P0-2 | Critical | GitHub delivery blocked. The configured HTTPS credential is read-only for the repo (`403` on push); `gh auth status` reports the default token is invalid (`401`). | **Blocked externally** — needs a Contents: Read and write token / fresh `gh auth login`. No credentials were printed or changed. |
| P1-1 | High | WCAG contrast failure on the catalogue: the active category pill used dark `text-ink/75` on a dark forest background (1.51:1). | **Fixed** — active count now uses `text-paper/80`; axe reports 0 violations on the audited pages. |
| P1-2 | High | E2E `waitSuccess` matched a hidden hint containing “smaller” before the compress result appeared, causing false timeouts. | **Fixed** — helper now matches visible text only. |
| P1-3 | Medium | OCR E2E flaked once while fetching the pinned Tesseract CDN assets; passed immediately on rerun. | **Monitored** — external-network dependency; test is not weakened. |
| P2-1 | Medium | No automated accessibility gate despite axe-core already being a dependency. | **Fixed** — added `tests/e2e/accessibility.spec.ts` (WCAG 2.2 A/AA, 6 surfaces). |
| P2-2 | Medium | Batch OCR and batch metadata are not implemented (OCR depends on a first-use CDN fetch; metadata is single-file by architecture). | **Documented** — deliberate scope decision, not silently claimed. |
| P2-3 | Medium | Visual signatures are not certificate-backed; archive profiles are PDF/A preparation, not certified conformance. | **Documented** in UI, README and `PRODUCTION-READINESS.md`. |
| P2-4 | Low | No dark theme or interface localisation. | **Open** — not a regression; out of this release’s scope. |
| P3-1 | Low | The bundled Playwright browsers live in `.pw-browsers`; the default cache path is empty. | **Documented** — run with `PLAYWRIGHT_BROWSERS_PATH="$PWD/.pw-browsers"` on this machine. |
| P3-2 | Low | The preview server is local only; nothing is deployed until the push succeeds. | **Blocked** by P0-2. |

## 3. Bugs and defects fixed during this audit

1. **Safari crash on every tool** (`Iterator`) — legacy PDF.js build + matching worker.
2. **Active filter count contrast** on `/tools` — 1.51:1 → passing.
3. **False-positive E2E success matches** — visible-text-only result assertion.
4. **No accessibility regression gate** — axe-core suite added.
5. Earlier upgrade pass also fixed the `@cantoo/pdf-lib` stale `/Encrypt` bug in Unlock and added output
   verification for redaction/sanitisation (see `TOOL-ENHANCEMENTS.md`).

## 4. Verification performed

| Gate | Command | Result |
| --- | --- | --- |
| TypeScript | `npx tsc --noEmit` | Pass (0 errors) |
| Lint | `npm run lint` | Pass (0 errors, `console.log` disallowed) |
| Unit/contract | `npm test` | **313/313 passed** |
| Coverage gate | `npm run test:coverage` | Pass, 78% statements on the gated module |
| Production build | `npm run build` | Pass — 63 prerendered routes, 79 precached files, worker generated |
| Output E2E | `npx playwright test` | **76/76 passed** before the audit; 25/25 matrix-a + 51/51 remaining suites re-passed after the Safari fix |
| Accessibility | `npx playwright test tests/e2e/accessibility.spec.ts` | **1/1 passed**, 0 WCAG A/AA violations on 6 surfaces |
| All-tools smoke | platform E2E | 51/51 tools mount, advanced panels open, options toggle, **0 console errors** |

Total after the audit: **77 E2E cases** in 7 files, **313 unit tests**.

## 5. Git and delivery state

- Branch created for this hardening pass: **`upgrade/production-hardening`** (from local `main`).
- Local commits ahead of `origin/main`:
  - `eea12de` — all 51 tools + shared UX engines
  - `fe92ebd` — Safari/PDF.js legacy fix
  - plus this audit commit (accessibility fix, WCAG gate, audit report)
- Existing commits and the `preview` branch are preserved; no force-push, reset or branch deletion.
- Push attempt: `git push origin upgrade/production-hardening` → **403 permission denied**; `gh auth status`
  → **401 bad credentials**. This is an account/token permission issue, not a code issue.

## 6. Production verdict

- **Application code:** ready for production use. Build, typecheck, lint, unit, output E2E, WCAG gate and
  all-tool smoke pass. The Safari-specific blocker is resolved.
- **Deployment:** **not complete**. GitHub push and therefore Netlify deployment are blocked until the
  connector or CLI is authenticated with write access. No test result above is conditional on that push.

## 7. Required to finish delivery

Authenticate one of:

```bash
gh auth login -h github.com          # choose HTTPS, then authorize with repo access
# or provide a fine-grained PAT with Contents: Read and write on suffyanibrar-ops/paperly
```

Then:

```bash
cd "/Users/nokhaizibrar/Desktop/Tests Project/paperly"
git push origin upgrade/production-hardening
```

Open a PR from `upgrade/production-hardening` into `main` after review. No conflicting remote work exists
at the time of this audit (`origin/main` is the parent of both local commits).
