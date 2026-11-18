# Paperly PDF — research, competitor analysis and gap closure

Prepared for the tool-enhancement release. Sources are public product pages reviewed for this pass; links
are listed at the end. This document is deliberately opinionated: it records **where Paperly was weaker**,
what this release changes, and what is out of scope by design.

## 1. Method

- Reviewed the public tool catalogues and positioning of iLovePDF, Smallpdf, Adobe Acrobat online, PDF24,
  Sejda and Stirling PDF.
- Compared against Paperly's 51-tool registry and its existing implementation (features, defaults,
  accessibility, output handling, limits, failure modes).
- Judged gaps on three axes: **capability**, **first-run usability**, and **trust/reliability**.
- Every gap mapped to an existing Paperly tool where possible. New tools were avoided: 51 is already a
  broad catalogue, and adding a 52nd surface dilutes maintenance more than it helps discovery.

## 2. Competitor snapshot

| Dimension | iLovePDF | Smallpdf | Adobe online | PDF24 | Sejda | Stirling PDF | Paperly (before) | Paperly (this release) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Processing model | Server + desktop/mobile apps | Server | Server (cloud) | Server tools + free Windows desktop app | Server + desktop | Self-hosted server | **In-browser only** | **In-browser only** |
| Free limits | Daily task caps, size caps | Daily task caps | Account/trial gates | Generous free quota | 3 tasks/hour, 50 MB/200 pages | Depends on host | **None** | **None** |
| Tool breadth | ~30 | ~25 | ~20 | 77 (with desktop) | 30+ | 50+ | 51 | 51, deeper |
| Merge/split/organize | Yes | Yes | Yes | Yes | Yes, incl. alternate/mix, split by size/text/half | Yes | Yes | Yes + interleave, split every N/half, per-file ranges |
| Convert PDF↔Office/images | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes + page ranges, layout/quality options |
| OCR | Yes | Yes | Yes | Yes | Yes | Yes | Yes, 18 languages | + preprocessing, range, output modes, cancel |
| Forms | Yes | Limited | Yes (fill/sign) | Yes | Yes (create) | Yes | Yes (fill/create/flatten) | + value import/export, field types, placement |
| Redaction | Yes | Yes | Yes | Yes | Yes | Yes | Yes, patterns + boxes | + regex, remove-text mode, **post-save verification** |
| Compare | Yes | Yes | Limited | Yes | Yes | Yes | Yes | + modes, ignore rules, report export |
| PDF/A | Yes | Limited | Yes | Yes | — | Yes | Archive readiness audit | + profile selection, honest "preparation" wording |
| E-sign request | Yes | Yes | Yes | No | No | No | No | Out of scope (needs a server/identity) |
| AI summarise / translate / chat | Yes (AI) | Yes (AI) | Yes (AI) | Limited | No | Limited | Deterministic summary + retrieval Q&A | Kept deterministic, no fake AI claims |
| Offline / PWA | Desktop app | Extension | No | Desktop app | Desktop app | Self-host | **Installable PWA** | **Installable PWA** |
| Page thumbnails | Yes | Yes | Yes | Yes | Yes | Yes | Partial | **Shared visual picker across page tools** |
| Rename/preview/checksum/sharing output | Download only | Download only | Download only | Download only | Download only | Download only | Download only | **Rename, preview, copy, share, SHA-256** |
| Job cancellation | Varies | Varies | Varies | Varies | Varies | Varies | Rarely | **Uniform cancel/ETA/retry contract** |
| Keyboard-first | Partial | Partial | Partial | No | No | No | Command palette | **⌘K, ⌘↵, ⌘S, ?, shift-click ranges** |
| Sample without a file | No | No | No | No | No | No | No | **Locally generated samples** |

## 3. Where competitors were genuinely better

These were the highest-value gaps and are addressed by the release:

1. **Split modes.** iLovePDF/Sejda offer split-by-size, split-in-half, alternating mix, and split every N
   pages. Paperly only offered extract / one-per-page / custom lines. → *split + merge upgrades*.
2. **Page selection UX.** Competitors use thumbnails with range shortcuts. Paperly relied on typed ranges
   in most tools. → *shared `PagePicker` (thumbnails, shift-click, odd/even/invert, typed fallback)*.
3. **Output controls.** None of the browser competitors let you rename, preview, checksum or share the
   result before saving. This is a differentiator, not a catch-up. → *enhanced `DownloadPanel`*.
4. **Compression clarity.** Competitors show a quality preset and a before/after size. Paperly's
   compression worked but hid the tradeoff. → *presets, DPI/quality, honest before/after report*.
5. **Permissions in Protect.** Competitors expose print/copy/modify permissions. Paperly only set a
   password. → *permission matrix + owner password*.
6. **Watermark richness.** Image watermarks, tiling, rotation and behind-content placement are standard.
   Paperly's text watermark was narrower. → *image, tile, rotation, 9-position, range*.
7. **Redaction assurance.** Most competitors simply say "redacted". A verifiable post-save check is rare
   and matters for legal/HR use. Paperly now re-extracts text and confirms removal. → *verification*.
8. **First-run confidence.** Competitors guide with presets; Paperly exposed raw inputs. → *presets,
   samples, inline hints, remembered settings*.

## 4. Gaps this release does not close (and why)

| Gap | Why it stays out |
| --- | --- |
| E-signature **request** workflow (email, identity, audit trail) | Requires a server, accounts, identity verification and legal retention. Paperly's promise is no upload; faking this would be worse than omitting it. Local signing remains complete. |
| AI translation / generative summaries | Requires cloud LLMs or a large on-device model. Paperly keeps deterministic extraction, BM25-style retrieval and extractive summaries, and never sends text anywhere. |
| Certified PDF/A validation (veraPDF-level) | True certification needs a full ISO validator and ICC profiles. Paperly prepares archival copies and audits the known prerequisites, and now says "preparation, not certification". |
| Cloud storage integrations (Drive/Dropbox) | Adds OAuth, network requests and third-party data flow, contradicting the privacy architecture. |
| Real-time collaboration / comments | Needs persistence and sync. Out of scope for a local-first utility. |
| Native desktop/mobile apps | The installable PWA already provides offline use and installability without a second codebase. |

## 5. UX gaps (applies to all 51 tools)

- **One screen, one decision.** Move secondary controls into `AdvancedOptions`; keep the primary action
  visible.
- **Remember choices.** Reloading a tool no longer resets quality, layout or style options.
- **Progressive disclosure.** Presets first, exact numbers second, jargon never.
- **Honest progress.** Elapsed time, remaining estimate, page-level detail, cancel, and a retry path.
- **Errors as instructions.** Say what failed and the next action (unlock, repair, split, lower DPI).
- **Result confidence.** Show pages, size, saving, settings used and a checksum.
- **Keyboard parity.** ⌘K search, ⌘↵ run, ⌘S download, `?` help, shift-click ranges, Escape closes.
- **Samples.** Every PDF/image/text input can try a generated example with zero setup.
- **Mobile.** Sticky action bars, stacked forms, no horizontal scroll, 44px hit targets.

## 6. Reliability gaps closed

- **Cancellation** across long operations, with no stale result overwrites (run sequence guard).
- **Memory safety** through the existing canvas pixel cap plus cooperative page-by-page loops.
- **Output integrity**: extension enforcement, MIME mapping, SHA-256 checksum, local render preview.
- **Post-action verification** for redaction and sanitisation.
- **Normalised error language** (no paths, stack frames or engine internals).
- **Storage resilience**: preferences survive corrupt JSON and version drift; private mode degrades
  silently.
- **Accessibility**: result panel focus/announcement, labelled controls, `aria-pressed`, alert roles,
  keyboard-operable pickers, reduced-motion respect.

## 7. What remains uniquely Paperly

1. **No upload path at all** — not a policy, an architecture. There is no server endpoint to leak to.
2. **No limits, accounts or watermarks.**
3. **Output transparency** — rename, preview, copy, share, checksum before saving.
4. **One workflow builder** across 20 files / 8 operations.
5. **Offline PWA** with a hand-built service worker and pinned engine assets.
6. **A verifiable privacy claim** backed by CSP (`connect-src 'self'` plus the two pinned engine CDNs).

## 8. Sources

- iLovePDF tools and feature catalogue — <https://www.ilovepdf.com/>
- PDF24 tools catalogue — <https://www.pdf24.org/en/>
- Sejda tools and desktop offering — <https://www.sejda.com/>
- Smallpdf — <https://smallpdf.com/>
- Adobe Acrobat online overview — <https://www.adobe.com/acrobat/online.html>
- Stirling PDF (self-hosted catalogue) — <https://stirlingpdf.io/>

Product pages change; treat the tables as a point-in-time comparison rather than a contractual claim about
any third party.
