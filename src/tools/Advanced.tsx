import { Copy, FileDown, Grid2x2, LayoutTemplate, ListOrdered, Printer, Rows3, Scaling, Stamp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  PDFDocument,
  StandardFonts,
  baseName,
  dataUrlToBytes,
  downloadBytes,
  formatBytes,
  degrees,
  hexToRgb,
  safePdfText,
  openPdfJs,
  openPdfLib,
  parseRanges,
  renderPdfPage,
  sanitizeName,
  uniqueInOrder,
} from "@/lib/pdf";
import { useInitialFiles, usePdfFile } from "@/lib/usePdf";
import {
  Alert,
  Button,
  ColorInput,
  Field,
  Progress,
  Select,
  StepHeader,
  Switch,
  inputClass,
} from "@/components/ui";
import { DownloadPanel, RangeField, SinglePdfInput } from "@/components/toolParts";
import {
  bookletSequence,
  drawSlots,
  layoutFont,
  paperDimensions,
  placeEmbeddedPage,
  replacePlaceholders,
  type PaperKey,
  type PlaceMode,
  type SlotTexts,
} from "@/lib/layout";
import { cn } from "@/utils/cn";

const MM = 2.834645669;

/* ================================================================== *
 * RESIZE PDF
 * ================================================================== */
export function ResizeTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [paper, setPaper] = useState<PaperKey>("a4");
  const [orientation, setOrientation] = useState<"portrait" | "landscape">("portrait");
  const [custom, setCustom] = useState({ w: 210, h: 297 });
  const [mode, setMode] = useState<PlaceMode>("fit");
  const [margin, setMargin] = useState(0);
  const [range, setRange] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; pages: number; resized: number } | null>(null);

  const target = paperDimensions(paper, orientation, { w: custom.w * MM, h: custom.h * MM });

  const apply = async () => {
    if (!pdf.bytes || !pdf.file) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const wanted = new Set(uniqueInOrder(parseRanges(range, pdf.pageCount)));
      const src = await openPdfLib(pdf.bytes);
      const out = await PDFDocument.create();
      const sourcePages = src.getPages();
      const embedded = await out.embedPages(sourcePages);
      const pad = margin * MM;
      for (let i = 0; i < sourcePages.length; i++) {
        if (!wanted.has(i + 1)) {
          const [copied] = await out.copyPages(src, [i]);
          out.addPage(copied);
        } else {
          const page = out.addPage([target.w, target.h]);
          placeEmbeddedPage(
            page,
            embedded[i],
            { x: pad, y: pad, w: Math.max(10, target.w - pad * 2), h: Math.max(10, target.h - pad * 2) },
            mode,
            { rotation: sourcePages[i].getRotation().angle },
          );
        }
        setProgress(((i + 1) / sourcePages.length) * 100);
      }
      const bytes = await out.save();
      setResult({
        bytes,
        name: `${sanitizeName(baseName(pdf.file.name))}-resized.pdf`,
        pages: out.getPageCount(),
        resized: wanted.size,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to resize" />
      {pdf.bytes && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="New page size">
              <Select value={paper} onChange={(e) => setPaper(e.target.value as PaperKey)}>
                <option value="a4">A4 · 210 × 297 mm</option>
                <option value="letter">US Letter · 8.5 × 11 in</option>
                <option value="legal">US Legal · 8.5 × 14 in</option>
                <option value="a5">A5 · 148 × 210 mm</option>
                <option value="a3">A3 · 297 × 420 mm</option>
                <option value="tabloid">Tabloid · 11 × 17 in</option>
                <option value="custom">Custom size…</option>
              </Select>
            </Field>
            <Field label="Orientation">
              <Select value={orientation} onChange={(e) => setOrientation(e.target.value as "portrait" | "landscape")}>
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </Select>
            </Field>
            <Field label="Content scaling">
              <Select value={mode} onChange={(e) => setMode(e.target.value as PlaceMode)}>
                <option value="fit">Fit inside the page</option>
                <option value="fill">Fill the page (may crop)</option>
                <option value="stretch">Stretch to exact size</option>
                <option value="actual">Actual size, centred</option>
              </Select>
            </Field>
            <Field label="Margin" hint={`${margin} mm`}>
              <input type="range" min={0} max={40} value={margin} onChange={(e) => setMargin(Number(e.target.value))} className="mt-3 w-full accent-[#1c4c3b]" />
            </Field>
          </div>

          {paper === "custom" && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Width (mm)">
                <input type="number" min={50} max={2000} value={custom.w} onChange={(e) => setCustom({ ...custom, w: Math.max(50, Number(e.target.value) || 210) })} className={cn(inputClass, "tabular-nums")} />
              </Field>
              <Field label="Height (mm)">
                <input type="number" min={50} max={2000} value={custom.h} onChange={(e) => setCustom({ ...custom, h: Math.max(50, Number(e.target.value) || 297) })} className={cn(inputClass, "tabular-nums")} />
              </Field>
            </div>
          )}

          <RangeField value={range} onChange={setRange} total={pdf.pageCount} label="Pages to resize" hint="Pages outside the range stay at their original size." />
          <div className="rounded-xl border border-line bg-bone-deep/35 p-3 text-[11.5px] leading-relaxed text-ink/70">
            <p className="flex items-center gap-1.5 font-semibold text-forest">
              <Scaling className="h-3.5 w-3.5" /> {Math.round(target.w / MM)} × {Math.round(target.h / MM)} mm per page
            </p>
            <p className="mt-1">
              Pages are embedded as vectors, so text stays sharp and searchable. Rotated pages keep their orientation. Nothing is uploaded.
            </p>
          </div>
          {error && <Alert tone="error">{error}</Alert>}
          <div className="border-t border-line pt-4">
            <Button onClick={apply} loading={busy}>
              <Scaling className="h-4 w-4" /> Resize PDF
            </Button>
          </div>
          {busy && <Progress value={progress} label="Reflowing pages onto the new canvas…" />}
        </>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Pages resized"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${result.resized} page${result.resized === 1 ? "" : "s"} fitted to ${Math.round(target.w / MM)} × ${Math.round(target.h / MM)} mm · ${result.pages} pages total`}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * N-UP & BOOKLET
 * ================================================================== */
type NUpMode = "2" | "4" | "6" | "9" | "booklet";

export function NUpTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [mode, setMode] = useState<NUpMode>("2");
  const [paper, setPaper] = useState<PaperKey>("a4");
  const [orientation, setOrientation] = useState<"portrait" | "landscape">("landscape");
  const [margin, setMargin] = useState(8);
  const [gap, setGap] = useState(4);
  const [border, setBorder] = useState(true);
  const [columnOrder, setColumnOrder] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; sheets: number; source: number } | null>(null);

  const perSheet = mode === "booklet" ? 2 : Number(mode);
  const sheet = paperDimensions(paper, mode === "booklet" ? "landscape" : orientation);

  const preview = useMemo(() => {
    const cols = mode === "2" ? 2 : mode === "booklet" ? 2 : mode === "4" ? 2 : mode === "6" ? 3 : 3;
    const rows = mode === "2" || mode === "booklet" ? 1 : mode === "4" ? 2 : mode === "6" ? 2 : 3;
    return { cols, rows };
  }, [mode]);

  const apply = async () => {
    if (!pdf.bytes || !pdf.file) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const src = await openPdfLib(pdf.bytes);
      const out = await PDFDocument.create();
      const sourcePages = src.getPages();
      const embedded = await out.embedPages(sourcePages);
      const rotations = sourcePages.map((p) => p.getRotation().angle);
      const m = margin * MM;
      const g = gap * MM;
      const cols = mode === "booklet" ? 2 : preview.cols;
      const rows = preview.rows;
      const cellW = (sheet.w - m * 2 - g * (cols - 1)) / cols;
      const cellH = (sheet.h - m * 2 - g * (rows - 1)) / rows;

      if (mode === "booklet") {
        const sequence = bookletSequence(sourcePages.length);
        for (let i = 0; i < sequence.length; i += 2) {
          const page = out.addPage([sheet.w, sheet.h]);
          [sequence[i], sequence[i + 1]].forEach((pageNumber, column) => {
            const box = { x: m + column * (cellW + g), y: m, w: cellW, h: cellH };
            if (border) {
              page.drawRectangle({ x: box.x, y: box.y, width: box.w, height: box.h, borderColor: undefined, borderWidth: 0 });
            }
            if (pageNumber && embedded[pageNumber - 1]) {
              placeEmbeddedPage(page, embedded[pageNumber - 1], box, "fit", {
                rotation: rotations[pageNumber - 1],
                border,
                borderColor: "#d8d3c6",
              });
            }
          });
          setProgress(((i / 2 + 1) / (sequence.length / 2)) * 100);
        }
      } else {
        const totalSheets = Math.ceil(sourcePages.length / perSheet);
        for (let sheetIndex = 0; sheetIndex < totalSheets; sheetIndex++) {
          const page = out.addPage([sheet.w, sheet.h]);
          for (let slot = 0; slot < perSheet; slot++) {
            const localIndex = columnOrder ? (slot % rows) * cols + Math.floor(slot / rows) : slot;
            const sourceIndex = sheetIndex * perSheet + localIndex;
            if (sourceIndex >= sourcePages.length) continue;
            const row = Math.floor(slot / cols);
            const col = slot % cols;
            const box = {
              x: m + col * (cellW + g),
              y: sheet.h - m - (row + 1) * cellH - row * g,
              w: cellW,
              h: cellH,
            };
            placeEmbeddedPage(page, embedded[sourceIndex], box, "fit", {
              rotation: rotations[sourceIndex],
              border,
              borderColor: "#d8d3c6",
            });
          }
          setProgress(((sheetIndex + 1) / totalSheets) * 100);
        }
      }
      const bytes = await out.save();
      setResult({
        bytes,
        name: `${sanitizeName(baseName(pdf.file.name))}-${mode === "booklet" ? "booklet" : `${mode}up`}.pdf`,
        sheets: out.getPageCount(),
        source: sourcePages.length,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to impose" />
      {pdf.bytes && (
        <>
          <StepHeader step={2} title="Layout" hint={`${pdf.pageCount} source pages`} />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {[
              { value: "2" as NUpMode, label: "2 per sheet", icon: Rows3 },
              { value: "4" as NUpMode, label: "4 per sheet", icon: Grid2x2 },
              { value: "6" as NUpMode, label: "6 per sheet", icon: LayoutTemplate },
              { value: "9" as NUpMode, label: "9 per sheet", icon: Grid2x2 },
              { value: "booklet" as NUpMode, label: "Booklet", icon: Printer },
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setMode(option.value)}
                className={cn(
                  "flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-[11.5px] font-medium transition-colors",
                  mode === option.value ? "border-forest bg-forest text-paper" : "border-line bg-paper text-ink/70 hover:border-forest/30",
                )}
              >
                <option.icon className="h-4 w-4" />
                {option.label}
              </button>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Sheet size">
              <Select value={paper} onChange={(e) => setPaper(e.target.value as PaperKey)}>
                <option value="a4">A4</option>
                <option value="letter">US Letter</option>
                <option value="legal">US Legal</option>
                <option value="a3">A3</option>
              </Select>
            </Field>
            <Field label="Orientation" hint={mode === "booklet" ? "Booklets are always landscape" : undefined}>
              <Select value={mode === "booklet" ? "landscape" : orientation} onChange={(e) => setOrientation(e.target.value as "portrait" | "landscape")} disabled={mode === "booklet"}>
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </Select>
            </Field>
            <Field label="Sheet margin" hint={`${margin} mm`}>
              <input type="range" min={0} max={30} value={margin} onChange={(e) => setMargin(Number(e.target.value))} className="mt-3 w-full accent-[#1c4c3b]" />
            </Field>
            <Field label="Gap between pages" hint={`${gap} mm`}>
              <input type="range" min={0} max={20} value={gap} onChange={(e) => setGap(Number(e.target.value))} className="mt-3 w-full accent-[#1c4c3b]" />
            </Field>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Switch checked={border} onChange={setBorder} label="Draw page borders" description="Handy print guides" />
            {mode !== "booklet" && (
              <Switch checked={columnOrder} onChange={setColumnOrder} label="Fill columns first" description="Off: fill rows left to right" />
            )}
          </div>

          <div className="flex items-center justify-center rounded-xl border border-line bg-bone-deep/30 p-4">
            <div
              className="grid w-full max-w-[280px] gap-1.5 rounded border border-ink/15 bg-paper p-1.5 shadow-soft"
              style={{ aspectRatio: `${sheet.w} / ${sheet.h}`, gridTemplateColumns: `repeat(${preview.cols}, minmax(0,1fr))`, gridTemplateRows: `repeat(${preview.rows}, minmax(0,1fr))` }}
            >
              {Array.from({ length: preview.cols * preview.rows }).map((_, i) => (
                <div key={i} className="flex items-center justify-center rounded-sm bg-bone-deep text-[9px] font-semibold text-ink/75">
                  {i + 1}
                </div>
              ))}
            </div>
          </div>
          <p className="text-center text-[11px] text-muted">
            {mode === "booklet"
              ? "Saddle-stitch imposition with fronts and backs. Print double-sided, flip on the short edge, then fold."
              : `Output: ${Math.ceil(pdf.pageCount / perSheet)} sheet${Math.ceil(pdf.pageCount / perSheet) === 1 ? "" : "s"} at ${perSheet} pages each.`}
          </p>
          {error && <Alert tone="error">{error}</Alert>}
          <div className="border-t border-line pt-4">
            <Button onClick={apply} loading={busy}>
              <Grid2x2 className="h-4 w-4" /> {mode === "booklet" ? "Create booklet" : "Create N-up PDF"}
            </Button>
          </div>
          {busy && <Progress value={progress} label="Imposing pages onto sheets…" />}
        </>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title={mode === "booklet" ? "Booklet ready" : "N-up PDF ready"}
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.sheets}
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${result.source} source pages → ${result.sheets} sheet${result.sheets === 1 ? "" : "s"} · vectors preserved`}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * HEADERS & FOOTERS
 * ================================================================== */
const BLANK: SlotTexts = { left: "", center: "", right: "" };

export function HeadersFootersTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [header, setHeader] = useState<SlotTexts>({ left: "{title}", center: "", right: "{date}" });
  const [footer, setFooter] = useState<SlotTexts>({ left: "", center: "Page {page} of {total}", right: "" });
  const [family, setFamily] = useState<"Helvetica" | "Times" | "Courier">("Helvetica");
  const [size, setSize] = useState(8.5);
  const [color, setColor] = useState("#5c6a61");
  const [margin, setMargin] = useState(14);
  const [rule, setRule] = useState(true);
  const [range, setRange] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; pages: number } | null>(null);

  const templates = [
    { name: "Report", header: { left: "{title}", center: "", right: "{date}" }, footer: { left: "Confidential", center: "Page {page} of {total}", right: "" } },
    { name: "Contract", header: { left: "{filename}", center: "", right: "" }, footer: { left: "", center: "Page {page} / {total}", right: "{date}" } },
    { name: "Minimal", header: BLANK, footer: { left: "", center: "{page}", right: "" } },
  ];

  const apply = async () => {
    if (!pdf.bytes || !pdf.file) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      if (![header.left, header.center, header.right, footer.left, footer.center, footer.right].some((v) => v.trim())) {
        throw new Error("Add at least one header or footer line.");
      }
      const pages = uniqueInOrder(parseRanges(range, pdf.pageCount));
      const doc = await openPdfLib(pdf.bytes);
      const font = await layoutFont(doc, family);
      const all = doc.getPages();
      const title = doc.getTitle() || baseName(pdf.file!.name);
      const date = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
      pages.forEach((n) => {
        const page = all[n - 1];
        const vars = { page: n, total: pdf.pageCount, title, filename: pdf.file!.name, date, bates: "" };
        const mapped = (slots: SlotTexts): SlotTexts => ({
          left: replacePlaceholders(slots.left, vars),
          center: replacePlaceholders(slots.center, vars),
          right: replacePlaceholders(slots.right, vars),
        });
        const base = { font, size, color, marginX: margin * MM, marginY: margin * MM, rule, ruleColor: "#d9d4c6" };
        if (header.left || header.center || header.right) drawSlots(page, mapped(header), { ...base, atTop: true });
        if (footer.left || footer.center || footer.right) drawSlots(page, mapped(footer), { ...base, atTop: false });
      });
      const bytes = await doc.save();
      setResult({ bytes, name: `${sanitizeName(baseName(pdf.file.name))}-headers-footers.pdf`, pages: pages.length });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF for headers & footers" />
      {pdf.bytes && (
        <>
          <div className="flex flex-wrap gap-1.5">
            <span className="mr-1 self-center text-[10.5px] font-semibold uppercase tracking-[0.09em] text-ink/75">Presets</span>
            {templates.map((template) => (
              <button
                key={template.name}
                type="button"
                onClick={() => {
                  setHeader(template.header);
                  setFooter(template.footer);
                  setResult(null);
                }}
                className="rounded-full border border-line bg-paper px-3 py-1.5 text-[11.5px] font-medium text-ink/75 hover:border-forest/35 hover:text-forest"
              >
                {template.name}
              </button>
            ))}
          </div>

          {(["header", "footer"] as const).map((slot) => {
            const value = slot === "header" ? header : footer;
            const setValue = slot === "header" ? setHeader : setFooter;
            return (
              <div key={slot} className="rounded-xl border border-line bg-paper p-3.5">
                <p className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">
                  <span>{slot}</span>
                  <span className="normal-case tracking-normal text-ink/70">left · center · right</span>
                </p>
                <div className="grid gap-2 sm:grid-cols-3">
                  {(["left", "center", "right"] as const).map((align) => (
                    <input
                      key={align}
                      value={value[align]}
                      onChange={(e) => {
                        setValue({ ...value, [align]: e.target.value });
                        setResult(null);
                      }}
                      placeholder={`${slot} ${align}`}
                      aria-label={`${slot} ${align}`}
                      className={inputClass}
                    />
                  ))}
                </div>
              </div>
            );
          })}

          <div className="flex flex-wrap gap-1.5 rounded-xl border border-forest/12 bg-lime/15 p-2.5 text-[10.5px] text-forest">
            <span className="font-semibold">Placeholders:</span>
            {["{page}", "{total}", "{title}", "{filename}", "{date}"].map((token) => (
              <code key={token} className="rounded bg-paper px-1.5 py-0.5 font-mono">
                {token}
              </code>
            ))}
            <span className="text-forest/90">— click any template to see them in action.</span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Typeface">
              <Select value={family} onChange={(e) => setFamily(e.target.value as typeof family)}>
                <option value="Helvetica">Sans (Helvetica)</option>
                <option value="Times">Serif (Times)</option>
                <option value="Courier">Mono (Courier)</option>
              </Select>
            </Field>
            <Field label="Font size" hint={`${size}pt`}>
              <input type="number" min={6} max={18} step={0.5} value={size} onChange={(e) => setSize(Math.max(6, Math.min(18, Number(e.target.value) || 8.5)))} className={cn(inputClass, "tabular-nums")} />
            </Field>
            <Field label="Text color">
              <ColorInput value={color} onChange={setColor} label="Header text color" />
            </Field>
            <Field label="Edge margin" hint={`${margin} mm`}>
              <input type="range" min={6} max={35} value={margin} onChange={(e) => setMargin(Number(e.target.value))} className="mt-3 w-full accent-[#1c4c3b]" />
            </Field>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Switch checked={rule} onChange={setRule} label="Subtle separator line" />
            <div>
              <RangeField value={range} onChange={setRange} total={pdf.pageCount} label="Pages" hint="Leave empty for every page." />
            </div>
          </div>
          {error && <Alert tone="error">{error}</Alert>}
          <div className="border-t border-line pt-4">
            <Button onClick={apply} loading={busy}>
              <Rows3 className="h-4 w-4" /> Add headers & footers
            </Button>
          </div>
        </>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Headers and footers added"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          onDownload={() => downloadBytes(result.bytes, result.name)}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * BATES NUMBERING
 * ================================================================== */
const BATES_POSITIONS = [
  { value: "bottom-right", label: "Bottom right" },
  { value: "bottom-center", label: "Bottom center" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "top-right", label: "Top right" },
  { value: "top-center", label: "Top center" },
  { value: "top-left", label: "Top left" },
] as const;

export function BatesTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [prefix, setPrefix] = useState("ABC-");
  const [suffix, setSuffix] = useState("");
  const [start, setStart] = useState(1);
  const [digits, setDigits] = useState(6);
  const [position, setPosition] = useState<(typeof BATES_POSITIONS)[number]["value"]>("bottom-right");
  const [size, setSize] = useState(9);
  const [color, setColor] = useState("#26312b");
  const [margin, setMargin] = useState(14);
  const [stamp, setStamp] = useState("CONFIDENTIAL");
  const [range, setRange] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; pages: number; first: string; last: string } | null>(null);

  const sample = `${prefix}${String(start).padStart(digits, "0")}${suffix}`;

  const apply = async () => {
    if (!pdf.bytes || !pdf.file) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const pages = uniqueInOrder(parseRanges(range, pdf.pageCount));
      const doc = await openPdfLib(pdf.bytes);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const bold = await doc.embedFont(StandardFonts.HelveticaBold);
      const all = doc.getPages();
      pages.forEach((pageNumber, index) => {
        const page = all[pageNumber - 1];
        const label = `${prefix}${String(start + index).padStart(digits, "0")}${suffix}`;
        const textWidth = font.widthOfTextAtSize(label, size);
        const { width, height } = page.getSize();
        const marginPt = margin * MM;
        let x = width - marginPt - textWidth;
        if (position.endsWith("left")) x = marginPt;
        if (position.endsWith("center")) x = (width - textWidth) / 2;
        const y = position.startsWith("top") ? height - marginPt - size : marginPt;
        page.drawText(label, { x, y, size, font, color: hexToRgb(color) });
        if (stamp.trim()) {
          const stampWidth = bold.widthOfTextAtSize(stamp, Math.max(5, size * 0.68));
          const stampX = position.endsWith("left") ? marginPt : position.endsWith("center") ? (width - stampWidth) / 2 : width - marginPt - stampWidth;
          const stampY = position.startsWith("top") ? y - size - 6 : y + size + 5;
          if (stampY > 4 && stampY < height - 6) {
            page.drawText(safePdfText(stamp), {
              x: stampX,
              y: stampY,
              size: Math.max(5, size * 0.68),
              font: bold,
              color: hexToRgb("#a64127"),
              opacity: 0.85,
            });
          }
        }
      });
      const bytes = await doc.save();
      setResult({
        bytes,
        name: `${sanitizeName(baseName(pdf.file.name))}-bates.pdf`,
        pages: pages.length,
        first: `${prefix}${String(start).padStart(digits, "0")}${suffix}`,
        last: `${prefix}${String(start + pages.length - 1).padStart(digits, "0")}${suffix}`,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to Bates-number" />
      {pdf.bytes && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Prefix">
              <input value={prefix} onChange={(e) => setPrefix(e.target.value)} className={inputClass} placeholder="ABC-" maxLength={16} />
            </Field>
            <Field label="Suffix">
              <input value={suffix} onChange={(e) => setSuffix(e.target.value)} className={inputClass} placeholder="" maxLength={16} />
            </Field>
            <Field label="First number">
              <input type="number" min={0} max={99999999} value={start} onChange={(e) => setStart(Math.max(0, Number(e.target.value) || 0))} className={cn(inputClass, "tabular-nums")} />
            </Field>
            <Field label="Digits" hint={`${digits} digits, zero-padded`}>
              <Select value={digits} onChange={(e) => setDigits(Number(e.target.value))}>
                {[3, 4, 5, 6, 7, 8, 9].map((d) => (
                  <option key={d} value={d}>
                    {d} digits
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Position">
              <Select value={position} onChange={(e) => setPosition(e.target.value as typeof position)}>
                {BATES_POSITIONS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Font size" hint={`${size}pt`}>
              <input type="number" min={6} max={20} value={size} onChange={(e) => setSize(Math.max(6, Math.min(20, Number(e.target.value) || 9)))} className={cn(inputClass, "tabular-nums")} />
            </Field>
            <Field label="Edge margin" hint={`${margin} mm`}>
              <input type="range" min={6} max={40} value={margin} onChange={(e) => setMargin(Number(e.target.value))} className="mt-3 w-full accent-[#1c4c3b]" />
            </Field>
            <Field label="Number color">
              <ColorInput value={color} onChange={setColor} label="Bates number color" />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Secondary stamp (optional)" hint="Printed just above the number, in clay.">
              <input value={stamp} onChange={(e) => setStamp(e.target.value)} className={inputClass} placeholder="CONFIDENTIAL" maxLength={40} />
            </Field>
            <RangeField value={range} onChange={setRange} total={pdf.pageCount} label="Pages to stamp" hint="Numbering follows the order of selected pages." />
          </div>
          <div className="flex items-center gap-3 rounded-xl border border-line bg-bone-deep/35 px-3.5 py-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-forest text-lime">
              <Stamp className="h-4 w-4" />
            </div>
            <div>
              <p className="text-[12.5px] font-semibold">{sample}</p>
              <p className="text-[10.5px] text-muted">Next number · sequential through selected pages</p>
            </div>
          </div>
          {error && <Alert tone="error">{error}</Alert>}
          <div className="border-t border-line pt-4">
            <Button onClick={apply} loading={busy}>
              <ListOrdered className="h-4 w-4" /> Apply Bates numbering
            </Button>
          </div>
        </>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Bates numbering applied"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${result.first} → ${result.last} · ${result.pages} pages stamped`}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * FLATTEN PDF
 * ================================================================== */
export function FlattenTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [flattenForms, setFlattenForms] = useState(true);
  const [rasterize, setRasterize] = useState(false);
  const [dpi, setDpi] = useState(150);
  const [fieldCount, setFieldCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; pages: number; method: string } | null>(null);

  useEffect(() => {
    setFieldCount(null);
    if (!pdf.bytes) return;
    let alive = true;
    (async () => {
      try {
        const doc = await openPdfLib(pdf.bytes as ArrayBuffer);
        const count = doc.getForm().getFields().length;
        if (alive) setFieldCount(count);
      } catch {
        if (alive) setFieldCount(0);
      }
    })();
    return () => {
      alive = false;
    };
  }, [pdf.bytes]);

  const apply = async () => {
    if (!pdf.bytes || !pdf.file) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      if (!flattenForms && !rasterize) throw new Error("Choose form flattening, page rasterization, or both.");
      let bytes: Uint8Array;
      let pages = pdf.pageCount;
      if (rasterize) {
        const source = await openPdfJs(pdf.bytes);
        const sourceLayout = await openPdfLib(pdf.bytes);
        const rotations = sourceLayout.getPages().map((p) => p.getRotation().angle);
        const out = await PDFDocument.create();
        for (let i = 1; i <= source.numPages; i++) {
          const rendered = await renderPdfPage(source, i, { scale: dpi / 72, type: "image/jpeg", quality: 0.9, rotation: 0 });
          const view = await source.getPage(i);
          const viewport = view.getViewport({ scale: 1 });
          const page = out.addPage([viewport.width, viewport.height]);
          if (rotations[i - 1]) page.setRotation(degrees(rotations[i - 1]));
          const image = await out.embedJpg(dataUrlToBytes(rendered.dataUrl));
          page.drawImage(image, { x: 0, y: 0, width: viewport.width, height: viewport.height });
          setProgress((i / source.numPages) * 100);
        }
        await source.destroy();
        pages = out.getPageCount();
        bytes = await out.save();
      } else {
        const doc = await openPdfLib(pdf.bytes);
        if (flattenForms) {
          try {
            doc.getForm().flatten();
          } catch {
            /* documents without forms are already flat */
          }
        }
        pages = doc.getPageCount();
        bytes = await doc.save();
        setProgress(100);
      }
      setResult({
        bytes,
        name: `${sanitizeName(baseName(pdf.file.name))}-flattened.pdf`,
        pages,
        method: rasterize ? `Pages rasterized at ${dpi} DPI` : "Form fields flattened",
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to flatten" />
      {pdf.bytes && (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            <Switch checked={flattenForms} onChange={setFlattenForms} label="Flatten form fields" description="Turns inputs into permanent page content" />
            <Switch checked={rasterize} onChange={setRasterize} label="Rasterize every page" description="Bakes the exact visual appearance into images" />
          </div>
          {rasterize && (
            <Field label="Raster resolution" hint="Higher keeps small text crisp; files get larger.">
              <Select value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
                <option value={110}>Standard · 110 DPI</option>
                <option value={150}>High · 150 DPI</option>
                <option value={220}>Print · 220 DPI</option>
                <option value={300}>Maximum · 300 DPI</option>
              </Select>
            </Field>
          )}
          <div className="rounded-xl border border-line bg-bone-deep/35 p-3.5">
            <p className="flex items-center gap-1.5 text-[12px] font-semibold text-forest">
              <FileDown className="h-3.5 w-3.5" /> What this does
            </p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-ink/70">
              {fieldCount === null
                ? "Checking for interactive form fields…"
                : fieldCount > 0
                  ? `This PDF has ${fieldCount} interactive form field${fieldCount === 1 ? "" : "s"}. Flattening makes the current values permanent and uneditable.`
                  : "No interactive form fields were found. You can still rasterize the pages to lock the visual appearance."}
            </p>
            {rasterize && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-amber-800">
                Rasterized pages are images: text will no longer be selectable or searchable. Flattening forms only (without rasterizing) keeps text and
                vectors fully searchable.
              </p>
            )}
          </div>
          {error && <Alert tone="error">{error}</Alert>}
          <div className="border-t border-line pt-4">
            <Button onClick={apply} loading={busy} disabled={!flattenForms && !rasterize}>
              <Copy className="h-4 w-4" /> Flatten PDF
            </Button>
          </div>
          {busy && <Progress value={progress} label={rasterize ? "Rasterizing pages…" : "Flattening interactive content…"} />}
        </>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="PDF flattened"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${result.method} · ${result.pages} pages · ${formatBytes(result.bytes.byteLength)}`}
        />
      )}
    </div>
  );
}
