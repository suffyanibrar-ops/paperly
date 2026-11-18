# Paperly tool-enhancement playbook

This is the contract for the per-tool upgrade pass. Read it fully before editing.

## Mission

Make every tool **easier for a first-time visitor** and **more capable for a power user**, without
changing what the tool fundamentally does. Every tool should gain, where it makes sense:

1. one-click presets / smart defaults;
2. an **Advanced options** panel with real controls (not decorative);
3. better empty, loading, error and cancelled states;
4. a result panel with **rename, preview, copy/share, checksum** (shared automatically through
   `DownloadPanel`);
5. keyboard support (`⌘/Ctrl+Enter` run, `⌘/Ctrl+S` download);
6. remembered settings between visits.

Quality bar: production. No placeholder buttons, no dead options, no `console.log`, no TODOs.

## Hard constraints

- **Only edit the files assigned to your group.** Do not touch `src/lib/*`, `src/components/*`,
  `src/pages/*`, `tests/*`, `scripts/*`, `README.md`, `package.json`, or any other tool file.
- **No new npm dependencies.** No network calls at runtime.
- **Never rename a primary action button** or remove a success title that the E2E suite asserts.
  The suite clicks exact labels and waits for exact copy. Keep these strings stable:
  - merge: `Merge PDF` → `PDFs became one`
  - split: `Extract pages` → `extracted PDF is ready`; keep `#page-range`
  - organize: `Apply changes` → `pages are in order`
  - rotate: `Rotate 90° all pages` → `Pages turned`
  - crop: `Crop PDF` → `Margins trimmed`
  - compress: `Compress PDF` → title matching `smaller|highly optimized`
  - repair: `Repair PDF` → `Document recovered`
  - page numbers: `Add page numbers` → `Numbers added` (default format must keep producing `1 / 3`)
  - protect/unlock: `Protect PDF` → `PDF protected`; `Unlock PDF` → `PDF unlocked`
  - edit/sign/watermark: `Export edited PDF` → `edited PDF is ready`; `Save signed PDF` → `Document signed`;
    `Apply watermark` → `Watermark applied`
  - redact: button matching `Apply N redaction...` → `Redactions applied`
  - compare: `Compare documents` → `pages differ|identical`
  - jpg-to-pdf: `Create PDF` → `image PDF is ready`
  - pdf-to-jpg: `Convert to JPG` → `images ready`
  - word/excel/ppt conversions: existing action labels and `Word document is ready`, `spreadsheet is ready`,
    `deck is now a PDF`, `workbook is now a PDF`, `now a PDF`
  - extract text: `Extract text`; tables: `Extract tables`; markdown: `Convert to Markdown` → `Markdown output`
  - OCR: `OCR PDF` → `Searchable PDF ready`
  - sanitize: `Sanitized copy ready and verified`
  - archive: `Prepare archive PDF` → `Archive copy prepared`
  - forms: `Save filled PDF`, `Save interactive form`; scan: `Scan saved as PDF`
  - extract/remove pages: `Extract pages`, `Remove N page`; resize: `Resize PDF`; n-up: `Create N-up PDF`;
    headers/footers: `Add headers & footers`; Bates: `Apply Bates numbering`; flatten: `Flatten PDF`
  - bookmarks: `Save bookmarks`; split-bookmarks: `Split into 3 PDFs` / `3 section PDFs ready`
  - metadata: `Save metadata & download` → `Metadata updated`; batch: `Process N files` → `2 files processed`;
    summarize: `Summarise document` → `Your summary`; ask: `Find answer` → `Answer · verbatim from your PDFs`
  - inspect: `Structural red flags`.
- Keep existing input ids (`#page-range`), accessible labels (`aria-label`), and exported component names.
- Do not add new tools to the registry. Improve the 51 existing ones.
- Keep English UI copy consistent with the existing voice: calm, concrete, no hype, no exclamation marks.
- All processing stays in the browser. No uploads, no telemetry.
- TypeScript strict, no `any` unless unavoidable, no unused imports/vars.
- Run `npx tsc --noEmit` and `npx eslint <your files>` before finishing.

## Shared APIs (already built — import, don't edit)

Paths are aliased with `@/`.

### Preferences — remembered options

```tsx
import { useToolPreferences } from "@/lib/prefs";

const opts = useToolPreferences("compress", {
  level: "balanced" as "screen" | "balanced" | "print",
  grayscale: false,
  stripMetadata: true,
});
opts.value.level;            // typed
opts.set("grayscale", true); // persists immediately
opts.patch({ level: "print", grayscale: false });
opts.reset();                // back to defaults
opts.changed;                // true when user changed something
```

Scope must be the tool id; use a distinct scope such as `"merge"`, `"split"`, `"page-numbers"`.
Never persist file contents, passwords or personal data. Only option values (booleans, numbers, enums,
short strings).

### Job runner — progress, cancel, retry, errors

```tsx
import { useJob, describeJobTime } from "@/lib/job";
import { Progress } from "@/components/ui";

const job = useJob<{ bytes: Uint8Array; name: string }>();

const run = () =>
  job.run(async ({ report, step, throwIfCancelled }) => {
    const files = await readAll();
    for (let i = 0; i < files.length; i++) {
      throwIfCancelled();            // call between chunks
      await process(files[i]);
      step(i + 1, files.length, "Processing pages…");
    }
    return { bytes, name };
  });

// render
{job.busy && <Progress value={job.percent ?? undefined} label={job.label} etaMs={job.etaMs} detail={describeJobTime(job)} />}
<Button onClick={run} loading={job.busy}>Compress PDF</Button>
{job.busy && <Button variant="ghost" onClick={job.cancel}>Cancel</Button>}
{job.failed && <Alert tone="error">{job.error}</Alert>}
{job.succeeded && <DownloadPanel ... />}
{job.status === "cancelled" && <Alert tone="info">Cancelled — nothing was downloaded.</Alert>}
```

If replacing an existing `busy/error/result` state would risk regressions, keep the existing state and
add cancellation cooperatively with an `AbortController` or a `cancelled` ref. `useJob` is preferred for
new pipelines.

### Keyboard shortcuts

```tsx
import { usePrimaryShortcut, useDownloadShortcut } from "@/lib/hotkeys";

usePrimaryShortcut(run, Boolean(canRun) && !job.busy);
useDownloadShortcut(() => downloadOutput(bytes, name), Boolean(result));
```

### Advanced options + presets

```tsx
import {
  AdvancedOptions, OptionsGrid, NumberField, SliderField, PresetChips, OptionNote,
} from "@/components/AdvancedOptions";

<AdvancedOptions scope="compress" badge="5 controls" description="Quality, colour, metadata">
  <PresetChips
    label="Quality preset"
    value={opts.value.level}
    presets={[
      { id: "screen", label: "Screen", description: "Smallest file, 96 DPI" },
      { id: "balanced", label: "Balanced", description: "Everyday sharing, 150 DPI" },
      { id: "print", label: "Print", description: "Best quality, 300 DPI" },
    ]}
    onSelect={(preset) => opts.set("level", preset.id)}
  />
  <OptionsGrid>
    <NumberField label="Resolution" value={dpi} onChange={setDpi} min={72} max={600} step={1} suffix="DPI" />
    <SliderField label="Image quality" value={quality} onChange={setQuality} min={30} max={100} format={(v) => `${v}%`} />
    <Switch label="Grayscale" checked={opts.value.grayscale} onChange={(v) => opts.set("grayscale", v)} />
  </OptionsGrid>
  <OptionNote>Text stays selectable in every preset.</OptionNote>
  <Button variant="ghost" onClick={opts.reset}>Reset options</Button>
</AdvancedOptions>
```

`AdvancedOptions` remembers its open state per `scope`. Do not wrap already-advanced tools in a second
advanced panel if that hides their main controls — use `OptionsGrid` inline instead when the tool is
already expert-oriented (workflow, compare, inspect, create-form).

### Page queries

The global `parseRanges` now accepts, in addition to `1-3, 5`:

`odd`, `even`, `last`, `last-3`, `7-`, `-4`, `>10`, `<4`, `1-10:2` (step).

`RangeField` already shows All/Odd/Even/Last chips and validates live. Tools using `parseRanges` get this
automatically. For new code prefer:

```ts
import { parsePageQuery, describePageQuery, pagesToQuery } from "@/lib/pageQuery";
const pages = parsePageQuery(range, total);          // throws friendly Error
const label = describePageQuery(pages, total);       // "2 selected pages"
```

### Visual page picker

```tsx
import { PagePicker } from "@/components/PagePicker";

<PagePicker
  bytes={pdf.bytes}
  pageCount={pdf.pageCount}
  selected={selected}
  onChange={setSelected}
  label="Choose pages to extract"
/>
```

Features: thumbnails, shift-click range, All/Odd/Even/Invert/Clear, typed range with Replace/Add.
Use it in split, remove-pages, extract-pages, rotate, crop, pdf-to-jpg, extract-text, OCR and previews.
For 100+ page documents it renders the first 120 and the range input covers the rest.

### Result panel

`DownloadPanel` gained shared features. Existing call sites work unchanged. New optional props:

```tsx
<DownloadPanel
  bytes={result.bytes}
  filename={result.name}
  size={result.bytes.byteLength}
  pages={result.pages}
  originalSize={originalSize}
  mime="application/pdf"
  facts={[{ label: "Quality", value: "150 DPI" }, { label: "Layout", value: "A4 portrait" }]}
  onDownload={() => downloadOutput(result.bytes, result.name)}
  title="PDF compressed"
  description={...}
/>
```

`bytes` enables rename/preview/copy/share/checksum. **Prefer passing `bytes`.** When `bytes` is present
the panel performs the download itself (your `onDownload` is not called); keep `onDownload` as a fallback.
`extra` is still rendered inside the panel.

### Output helpers

```ts
import {
  downloadOutput, ensureOutputName, outputMimeType, savedPercentLabel,
  sha256Hex, copyOutput, shareOutput,
} from "@/lib/output";
```

### Samples

```tsx
import { SAMPLE } from "@/lib/sample";
<FileDrop ... sample={SAMPLE.pdf} />        // SinglePdfInput accepts `sample` too
<FileDrop ... sample={SAMPLE.image} />
<FileDrop ... sample={SAMPLE.markdown} />
```

`SAMPLE` offers `pdf`, `image`, `markdown`, `csv`, `html`, `text`. Add the relevant one when a tool's
empty state currently offers nothing to try. The sample is generated locally.

### FileDrop

New optional props: `hint?: ReactNode`, `sample?: SampleSpec`. It already supports drag, browse, paste
(⌘V) and per-file validation with a readable summary.

### Sticky action bar

```tsx
import { ToolActionBar } from "@/components/toolParts";
<ToolActionBar note="4 pages · nothing uploaded">{primaryButton}{cancelButton}</ToolActionBar>
```

Use it when a tool form is long enough that the primary button scrolls out of view on mobile.

## UX rules for every tool

- **First screen stays simple.** Put secondary controls in `AdvancedOptions`; keep the primary button
  visible and at the bottom.
- **Smart defaults.** Default to the safest, most useful behaviour (e.g. keep text selectable, preserve
  originals, all pages, highest quality that is still fast).
- **Explain the tradeoff inline.** A one-line hint under a control beats a help page.
- **Every failure is actionable.** Say what happened and what to do next; use `Alert tone="error"`.
  Add an "Open Unlock PDF" link when a password blocks the tool.
- **Cancellation.** Long loops must call `throwIfCancelled()` (or check a ref) and the UI must offer
  Cancel. Leave the tool's prior result intact after a cancel.
- **No dead ends.** After success, keep the form usable ("Run again", "Change options", "Start over").
- **Result facts.** Show page count, size, settings used and (for compression) the saving.
- **Keyboard.** Add `usePrimaryShortcut` / `useDownloadShortcut` at minimum to the primary flow.
- **Screen readers.** Keep existing `aria-label`s; add `aria-pressed` for toggles, `role="alert"` for
  errors, and label every new input.
- **Mobile.** No horizontal scroll; controls stack; action bar sticks above the fold.
- **Do not regress** current behaviour, output validity or exact success copy.

## Per-tool checklist

For each tool you touch:

- [ ] Read the existing implementation before editing (including its result/error paths).
- [ ] Add at least 2 meaningful new capabilities (or a substantial depth upgrade of an existing one).
- [ ] Add or extend an Advanced options panel with persisted settings.
- [ ] Add progress detail + cancel where the operation takes >1s.
- [ ] Pass `bytes` to `DownloadPanel` so preview/rename/checksum work.
- [ ] Add a sample where the tool has an empty state and `SAMPLE` fits.
- [ ] Add `⌘/Ctrl+Enter` (run) and, when a result exists, `⌘/Ctrl+S` (download).
- [ ] Keep all E2E-critical labels and messages.
- [ ] Run TypeScript and ESLint; fix everything you introduced.

## Verification

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.4/bin:$PATH"
cd "/Users/nokhaizibrar/Desktop/Tests Project/paperly"
npx tsc --noEmit
npx eslint src/tools/<YourFiles>.tsx
npm test          # unit tests must stay green
```

Do not run the full production build or Playwright suite; the coordinator owns those.

## Final report format

Reply with:

1. files changed;
2. for each tool: the new capabilities and options added;
3. anything you deliberately left out and why;
4. any risk, error-message change, or selector you had to touch (should normally be none).
