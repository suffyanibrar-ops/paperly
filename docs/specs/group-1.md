# Group 1 — Organize & Advanced

Files: `src/tools/Organize.tsx`, `src/tools/Advanced.tsx`
Read `docs/PLAYBOOK.md` first. Both files are large; read each tool implementation fully before editing.

## Merge PDF
- Add a **merge mode**: `Sequential` (default, current behaviour) and `Interleave` (alternate pages
  round-robin across files — the "alternate & mix" gap).
- Add an optional **page range per file** ("All pages" by default) so users can merge a subset of each.
  If a per-file range is invalid, show which file and page problem.
- Add **bookmarks per source file** toggle (writes an outline entry at each file's first page). Reuse
  `src/lib/outline.ts` helpers if they expose outline writing; otherwise use pdf-lib's outline API.
- Show a live summary: files, total pages, total size, duplicate filenames.
- Show per-file progress and allow Cancel.
- Keep the `Merge PDF` button label and the `PDFs became one` result title.

## Split PDF
- Add a **visual page picker** (`PagePicker`) for extract mode; keep `#page-range` and the
  `Extract pages` button so the E2E flow keeps working. Keep the picker and range field in sync.
- Add modes: extract (current), **every N pages**, single pages (current), custom ranges (current),
  **odd/even**, and **split in half** (left/right for landscape spreads or top/bottom for portrait).
- Add a **file naming pattern** for multi-file outputs with tokens `{name}`, `{page}`, `{part}`,
  `{start}`, `{end}`; default preserves current names.
- Add a ZIP / individual-files preference (default ZIP).
- Preview the number of output files before running.
- Keep the `extracted PDF is ready` success title for extract mode.

## Organize PDF
- Add per-page actions beyond remove/reorder: **duplicate**, **insert blank page after**, **move to
  start/end**, and **rotate this page**.
- Add **Reverse order** and **Reset to original** actions.
- Add subtle drag-and-drop reordering with a keyboard-accessible fallback (existing buttons stay).
- Show page count before/after ("3 → 5 pages") and a warning when every page is removed.
- Keep `Apply changes`, `pages are in order`, and the thumbnail interaction.

## Rotate PDF
- Keep `Rotate 90° all pages` as a one-click quick action.
- Add quick actions for 90/180/270, all/odd/even/selected pages and a `PagePicker`/`RangeField`.
- Show current rotation per page in the thumbnail grid, and a **Reset rotation** action.
- Add an optional **auto-upright** heuristic: if a page is landscape but its text is rotated, offer
  "Upright landscape pages" with a preview note. Never claim perfect OCR-style detection.
- Keep `Pages turned` success title.

## Crop PDF
- Add unit-aware margins (mm / pt / %), a **page-size preset** (A4, Letter, Legal, A5, custom width ×
  height) and a **preview of page 1 with the crop rectangle drawn over the page**.
- Add an **Auto-detect margins** action using PDF.js text/image bounds; show the detected values and let
  the user adjust them before applying. If detection is inconclusive, say so and keep the manual values.
- Let crop apply to all pages, a range, or odd/even. Preserve the crop box semantics (content outside the
  crop box is not printed).
- Show the old → new page dimensions.
- Keep `Crop PDF` and `Margins trimmed`.

## Resize / N-up / Headers & Footers / Bates / Flatten
- **Resize:** page-size presets, orientation, scale percentage vs fit vs margins, apply to range,
  per-page vs uniform, preview dimensions; keep `Resize PDF` + `Pages resized`.
- **N-up:** presets 2/4/6/9-up, page size/orientation, border, gutter, reading order, page range,
  page numbers under each panel; keep `Create N-up PDF` + `N-up PDF ready`.
- **Headers & footers:** token picker ({page}, {pages}, {date}, {title}, {filename}), left/center/right
  slots, font size, margin, line rule, range, different-first-page; keep `Add headers & footers` +
  `Headers and footers added`.
- **Bates:** prefix/suffix presets, start number, increment, digit padding, position, font size, colour,
  range, and per-file numbering; keep `Apply Bates numbering` + `Bates numbering applied`.
- **Flatten:** choose forms only / annotations only / both, keep selectable text, range, and a summary of
  what was flattened; keep `Flatten PDF` + `PDF flattened`.
- Use `AdvancedOptions` for secondary controls and `useToolPreferences` for persistence where the option
  set is non-trivial. Add `⌘/Ctrl+Enter` to each primary action.
