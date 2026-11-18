# Group 3 — Edit, Sign, Watermark, Redact, Compare

Files: `src/tools/Edit.tsx`, `src/tools/RedactCompare.tsx`
Read `docs/PLAYBOOK.md` first. These are the most interaction-heavy tools; keep the existing canvas
coordinates and export math intact unless you are deliberately fixing them.

## Edit PDF
- Add **undo/redo** for added elements (toolbar buttons + ⌘Z/⌘⇧Z while not typing).
- Add element selection, delete (Delete/Backspace), duplicate (⌘D), and z-order (bring forward/send back).
- Expand text styling: font size, colour, opacity, bold/italic, alignment; keep the existing font path.
- Add shapes: rectangle, ellipse, line and arrow, with fill/stroke/opacity.
- Add image insertion from file (PNG/JPEG) with aspect-ratio lock, plus the existing signature path.
- Add zoom controls (fit width / 100% / +−) and page navigation; show the current page of N.
- Keep `Export edited PDF` and `edited PDF is ready`.

## Sign PDF
- Support draw, type and upload signatures (keep current capabilities), plus **saved signatures** in
  memory/localStorage (never upload the image) and initials/date stamp presets.
- Allow multiple placements on multiple pages, each draggable, with size/rotation and a “lock after
  signing” option that flattens and prevents further edits.
- Add a date field and a “signature reason/location” line for a more professional result.
- Keep `Save signed PDF` and `Document signed`.

## Watermark
- Add image watermarks (PNG/JPEG) alongside text, with scale and opacity.
- Add tiling (`single`, `tile`, `diagonal repeat`), rotation, 9-position grid, margin, page range,
  odd/even, “behind content”, font size/family, and a live preview thumbnail.
- Warn when the watermark would be invisible (white-on-white / opacity 0).
- Keep `Apply watermark` and `Watermark applied`.

## Redact
- Keep the existing draw-box redaction and pattern search. Add:
  - **Remove text completely** vs **black box** (both must be irreversible on save);
  - case sensitivity, whole-word and regular-expression toggles;
  - page range and “apply to all matches”;
  - a verification step after saving: re-extract text from the output and confirm each matched string is
    gone; show a pass/fail report. If verification cannot run, say so honestly.
- Improve the match list with per-match page/context and deselect.
- Keep the `Apply N redactions` button pattern and `Redactions applied` title.

## Compare
- Add comparison modes: **side-by-side**, **overlay** and **inline text diff**.
- Add ignore whitespace, ignore case, and page-range options.
- Show per-page match percentage, changed/added/removed counts, and the first differences with contexts.
- Add **Export diff report** as HTML or CSV, and a copy-summary action.
- Keep `Compare documents` and the `pages differ|identical` summary copy.

Use `AdvancedOptions` for secondary controls, `useToolPreferences`, `usePrimaryShortcut`, and
`DownloadPanel` with `bytes` for the exported result.
