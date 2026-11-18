# Group 2 — Optimize & Security

Files: `src/tools/Optimize.tsx`, `src/tools/Security.tsx`
Read `docs/PLAYBOOK.md` first. Preserve all current success titles and primary button labels.

## Compress PDF
- Add quality presets shared through `useToolPreferences`: **Screen** (96 DPI), **Balanced** (150 DPI,
  default), **Print** (300 DPI), **Archive** (max quality, lossless re-save).
- Add controls: image resolution (72–600 DPI), JPEG quality (30–100), **grayscale** (with an honest
  warning that it rasterises colour content), **strip metadata**, **remove annotations**, and keep
  `Keep text selectable` (default on).
- Keep the existing **target file size** mode; make its estimate/attempts visible.
- Show a before/after report: original size, output size, percentage saved, pages, settings, and a short
  line explaining what happened. If the output grows, say so instead of claiming success.
- Add progress detail per page and Cancel. Preserve `Compress PDF` and the result title matching
  `smaller|highly optimized`.
- Pass `bytes`, `originalSize`, and `facts` to `DownloadPanel` so rename/preview/checksum work.

## Repair PDF
- Add recovery modes: **Safe rebuild** (default), **Aggressive salvage** (ignore invalid objects/repair
  xref), and **Pages only** (drop forms/attachments/scripts).
- Show a recovery report (pages recovered, objects/metadata repaired, attachments removed) and note that
  some content may be unrecoverable.
- Try a second load strategy automatically before reporting failure, and keep the friendly error.
- Keep `Repair PDF` + `Document recovered`.

## Page numbers
- Keep the default output exactly `1 / 3` … `3 / 3` for the E2E test.
- Add format presets: `1`, `1 / 3`, `Page 1`, `Page 1 of 3`, `- 1 -`, custom tokens `{page}` `{pages}`.
- Add start number, skip-first-page, page range, font size, colour, opacity, bold, margin, and a
  3×3 position grid with a live miniature preview.
- Persist the chosen style; keep `Add page numbers` + `Numbers added`.

## Protect PDF
- Add user password + owner/permissions password (owner optional), confirm field, strength meter,
  show/hide toggle, and a **generate strong password** action.
- Add a permission matrix: printing, copying text, modifying, annotating, filling forms, accessibility.
  Explain that permissions are enforced by readers but cannot stop a determined attacker.
- Keep AES-256 via the existing `@cantoo/pdf-lib` path; validate the password before running.
- Keep `Protect PDF` + `PDF protected`.

## Unlock PDF
- Accept a password, explain when one is needed, and offer **Remove restrictions only** (owner password /
  permissions) vs **Remove all protection**.
- Report whether a user password existed; never claim success on a wrong password.
- Keep `Unlock PDF` + `PDF unlocked`.

Use `AdvancedOptions`, `useToolPreferences`, `useJob` (or cooperative cancel), `DownloadPanel` with bytes,
and `⌘/Ctrl+Enter`/`⌘/Ctrl+S` shortcuts.
