import {
  Check,
  Layers,
  ListOrdered,
  LockKeyhole,
  Plus,
  RotateCw,
  Save,
  ShieldCheck,
  Trash2,
  Type,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  StandardFonts,
  baseName,
  degrees,
  downloadBytes,
  embedFonts,
  formatBytes,
  getPageDimensions,
  hexToRgb,
  openPdfJs,
  openPdfLib,
  readFileBytes,
  renderPdfPage,
  safePdfText,
  sanitizeName,
  zipAndDownload,
  type RenderedPage,
} from "@/lib/pdf";
import { recompressImages } from "@/tools/Optimize";
import { useInitialFiles, usePdfFile } from "@/lib/usePdf";
import {
  Alert,
  Button,
  ColorInput,
  Field,
  FileDrop,
  FileRow,
  Progress,
  Segmented,
  Select,
  Switch,
  inputClass,
  useToolId,
} from "@/components/ui";
import { DownloadPanel } from "@/components/toolParts";
import { getTool } from "@/lib/toolRegistry";
import { recordActivity } from "@/lib/activity";
import { friendlyProcessingError, validateUpload } from "@/lib/security";
import { cn } from "@/utils/cn";

const MM = 2.834645669;
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/* ================================================================== *
 * BATCH PDF — iLovePDF caps this on free; Paperly does not.
 * ================================================================== */
type BatchOp = "compress" | "rotate" | "protect" | "numbers" | "watermark";

const LEVELS = {
  light: { quality: 0.82, maxDimension: 2600, label: "Light" },
  balanced: { quality: 0.66, maxDimension: 2000, label: "Balanced" },
  strong: { quality: 0.45, maxDimension: 1400, label: "Strong" },
} as const;
type BatchLevel = keyof typeof LEVELS;

const NUMBER_POSITIONS = [
  { value: "bottom-center", label: "Bottom center" },
  { value: "bottom-right", label: "Bottom right" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "top-center", label: "Top center" },
  { value: "top-right", label: "Top right" },
  { value: "top-left", label: "Top left" },
] as const;

interface BatchSettings {
  level: BatchLevel;
  angle: 90 | 180 | 270;
  password: string;
  confirm: string;
  allowPrinting: boolean;
  numberPosition: (typeof NUMBER_POSITIONS)[number]["value"];
  numberStart: number;
  numberFormat: "plain" | "slash" | "of";
  watermark: string;
  watermarkSize: number;
  watermarkOpacity: number;
  watermarkColor: string;
  watermarkRotation: number;
}

interface BatchEntry {
  name: string;
  bytes: Uint8Array;
  before: number;
  after: number;
}

export function BatchTool() {
  const toolId = useToolId();
  const initial = useInitialFiles().filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
  const [files, setFiles] = useState<File[]>(initial);
  const [op, setOp] = useState<BatchOp>("compress");
  const [settings, setSettings] = useState<BatchSettings>({
    level: "balanced",
    angle: 90,
    password: "",
    confirm: "",
    allowPrinting: true,
    numberPosition: "bottom-center",
    numberStart: 1,
    numberFormat: "slash",
    watermark: "CONFIDENTIAL",
    watermarkSize: 46,
    watermarkOpacity: 0.16,
    watermarkColor: "#e8613c",
    watermarkRotation: 35,
  });
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const cancelRef = useRef(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [entries, setEntries] = useState<BatchEntry[] | null>(null);

  const totalIn = files.reduce((sum, f) => sum + f.size, 0);
  const invalid = op === "protect" && (settings.password.length < 4 || settings.password !== settings.confirm);

  const transform = async (file: File): Promise<Uint8Array> => {
    const buffer = await readFileBytes(file);
    if (op === "compress") {
      const result = await recompressImages(buffer, { quality: LEVELS[settings.level].quality, maxDimension: LEVELS[settings.level].maxDimension }, () => undefined);
      return result.bytes;
    }
    const doc = await openPdfLib(buffer);
    if (op === "protect") {
      doc.encrypt({
        userPassword: settings.password,
        ownerPassword: settings.password,
        permissions: {
          printing: settings.allowPrinting ? "highResolution" : false,
          copying: false,
          modifying: false,
          annotating: false,
          fillingForms: true,
          contentAccessibility: true,
          documentAssembly: false,
        },
      });
      return doc.save();
    }
    if (op === "rotate") {
      doc.getPages().forEach((page) => {
        page.setRotation(degrees((page.getRotation().angle + settings.angle) % 360));
      });
      return doc.save();
    }
    if (op === "numbers") {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const total = doc.getPageCount();
      doc.getPages().forEach((page, index) => {
        const n = settings.numberStart + index;
        const label =
          settings.numberFormat === "slash" ? `${n} / ${total}` : settings.numberFormat === "of" ? `Page ${n} of ${total}` : `${n}`;
        const width = page.getWidth();
        const height = page.getHeight();
        const textWidth = font.widthOfTextAtSize(label, 9);
        const margin = 14 * MM;
        let x = (width - textWidth) / 2;
        if (settings.numberPosition.endsWith("left")) x = margin;
        if (settings.numberPosition.endsWith("right")) x = width - margin - textWidth;
        const y = settings.numberPosition.startsWith("top") ? height - margin - 9 : margin;
        page.drawText(label, { x, y, size: 9, font, color: hexToRgb("#25352c") });
      });
      return doc.save();
    }
    // watermark
    const fonts = await embedFonts(doc);
    const text = safePdfText(settings.watermark);
    if (!text.trim()) throw new Error("Enter watermark text.");
    doc.getPages().forEach((page) => {
      const { width, height } = page.getSize();
      const textWidth = fonts.bold.widthOfTextAtSize(text, settings.watermarkSize);
      page.drawText(text, {
        x: (width - textWidth) / 2,
        y: height / 2 - settings.watermarkSize * 0.35,
        size: settings.watermarkSize,
        font: fonts.bold,
        color: hexToRgb(settings.watermarkColor),
        opacity: settings.watermarkOpacity,
        rotate: degrees(settings.watermarkRotation),
      });
    });
    return doc.save();
  };

  const run = async () => {
    setErrors([]);
    setEntries(null);
    if (!files.length) {
      setErrors(["Add at least one PDF."]);
      return;
    }
    if (invalid) {
      setErrors(["Use a password of at least 4 characters and make sure both fields match."]);
      return;
    }
    if (op === "watermark" && !settings.watermark.trim()) {
      setErrors(["Enter watermark text."]);
      return;
    }
    setBusy(true);
    setProgress(0);
    cancelRef.current = false;
    const output: BatchEntry[] = [];
    const failures: string[] = [];
    const suffix = op === "compress" ? "compressed" : op === "rotate" ? "rotated" : op === "protect" ? "protected" : op === "numbers" ? "numbered" : "watermarked";
    for (let i = 0; i < files.length; i++) {
      if (cancelRef.current) {
        failures.push(`Cancelled after ${i} of ${files.length} files. Completed files are still available.`);
        break;
      }
      const file = files[i];
      setStatus(`Processing ${i + 1} of ${files.length} · ${file.name}`);
      try {
        const bytes = await transform(file);
        output.push({
          name: `${sanitizeName(baseName(file.name))}-${suffix}.pdf`,
          bytes,
          before: file.size,
          after: bytes.byteLength,
        });
      } catch (err) {
        failures.push(`${file.name}: ${(err as Error).message}`);
      }
      setProgress(((i + 1) / files.length) * 100);
    }
    setEntries(output);
    setErrors(failures);
    setBusy(false);
    setStatus("");
  };

  const download = async () => {
    if (!entries?.length) return;
    if (entries.length === 1) {
      downloadBytes(entries[0].bytes, entries[0].name);
    } else {
      await zipAndDownload(
        entries.map((entry) => ({ name: entry.name, data: entry.bytes })),
        `paperly-batch-${new Date().toISOString().slice(0, 10)}.zip`,
      );
    }
    if (toolId) {
      recordActivity({
        toolId,
        toolName: getTool(toolId)?.name ?? "Paperly",
        filename: entries.length === 1 ? entries[0].name : `paperly-batch-${entries.length}-files.zip`,
        size: entries.reduce((sum, e) => sum + e.after, 0),
      });
    }
  };

  const outTotal = entries?.reduce((sum, e) => sum + e.after, 0) ?? 0;
  const savedPct = entries?.length ? Math.round((1 - outTotal / Math.max(1, entries.reduce((sum, e) => sum + e.before, 0))) * 100) : 0;

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-forest/15 bg-lime/20 p-3.5">
        <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-forest">
          <Layers className="h-4 w-4" /> Batch processing with no artificial cap
        </p>
        <p className="mt-1 text-[11.5px] leading-relaxed text-forest/90">
          Apply one operation to many PDFs and download a ZIP. Every file is processed locally, so the only limit is your device’s memory — no
          per-task file counts, no size ceiling, no ads.
        </p>
      </div>

      {files.length === 0 ? (
        <FileDrop
          accept="application/pdf,.pdf"
          acceptLabel="PDF files"
          multiple
          onFiles={(picked) => {
            const valid = picked.filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
            setFiles(valid);
            setEntries(null);
          }}
        />
      ) : (
        <div className="space-y-2">
          {files.map((file, index) => {
            const entry = entries?.find((e) => e.name.startsWith(sanitizeName(baseName(file.name))));
            return (
              <FileRow
                key={`${file.name}-${file.size}-${index}`}
                file={file}
                index={index}
                size={entry ? `${formatBytes(entry.before)} → ${formatBytes(entry.after)}` : formatBytes(file.size)}
                onRemove={() => {
                  setFiles(files.filter((_, i) => i !== index));
                  setEntries(null);
                }}
              />
            );
          })}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-paper px-3 py-2 text-[12px] font-medium text-ink/75 hover:border-forest/30">
              <Plus className="h-3.5 w-3.5" /> Add PDFs
              <input
                type="file"
                accept="application/pdf,.pdf"
                multiple
                aria-label="Add more PDF files to the batch"
                className="sr-only"
                onChange={async (e) => {
                  const picked = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  const valid: File[] = [];
                  const problems: string[] = [];
                  for (const candidate of picked) {
                    try {
                      await validateUpload(candidate, "application/pdf,.pdf");
                      valid.push(candidate);
                    } catch (err) {
                      problems.push(friendlyProcessingError(err, `${candidate.name} couldn’t be added.`));
                    }
                  }
                  if (valid.length) {
                    setFiles((current) => [...current, ...valid]);
                    setEntries(null);
                  }
                  setErrors(problems);
                }}
              />
            </label>
            <div className="flex items-center gap-2 text-[11.5px] text-muted">
              <span>{files.length} file{files.length === 1 ? "" : "s"} · {formatBytes(totalIn)} in</span>
              {files.length > 0 && (
                <button type="button" onClick={() => { setFiles([]); setEntries(null); }} className="font-medium text-clay-ink hover:underline">
                  Clear
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="border-t border-line pt-4">
        <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink/70">Operation for every file</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {[
            { value: "compress" as BatchOp, label: "Compress", icon: Layers },
            { value: "rotate" as BatchOp, label: "Rotate", icon: RotateCw },
            { value: "protect" as BatchOp, label: "Protect", icon: LockKeyhole },
            { value: "numbers" as BatchOp, label: "Page numbers", icon: ListOrdered },
            { value: "watermark" as BatchOp, label: "Watermark", icon: Type },
          ].map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => { setOp(option.value); setEntries(null); }}
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-[11.5px] font-medium transition-colors",
                op === option.value ? "border-forest bg-forest text-paper" : "border-line bg-paper text-ink/70 hover:border-forest/30",
              )}
            >
              <option.icon className="h-4 w-4" />
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {op === "compress" && (
          <Field label="Compression level" hint="Photos are re-encoded; text stays sharp.">
            <Select value={settings.level} onChange={(e) => setSettings({ ...settings, level: e.target.value as BatchLevel })}>
              {Object.entries(LEVELS).map(([key, value]) => (
                <option key={key} value={key}>{value.label}</option>
              ))}
            </Select>
          </Field>
        )}
        {op === "rotate" && (
          <Field label="Rotate every page">
            <Select value={settings.angle} onChange={(e) => setSettings({ ...settings, angle: Number(e.target.value) as 90 | 180 | 270 })}>
              <option value={90}>90° clockwise</option>
              <option value={180}>180°</option>
              <option value={270}>90° anticlockwise</option>
            </Select>
          </Field>
        )}
        {op === "protect" && (
          <>
            <Field label="Password" hint="At least 4 characters. AES-256.">
              <input type="password" value={settings.password} onChange={(e) => setSettings({ ...settings, password: e.target.value })} className={inputClass} autoComplete="new-password" />
            </Field>
            <Field label="Confirm password">
              <input type="password" value={settings.confirm} onChange={(e) => setSettings({ ...settings, confirm: e.target.value })} className={inputClass} autoComplete="new-password" />
            </Field>
            <div className="sm:col-span-2">
              <Switch checked={settings.allowPrinting} onChange={(v) => setSettings({ ...settings, allowPrinting: v })} label="Allow printing" description="Copying and editing are disabled in every output" />
            </div>
          </>
        )}
        {op === "numbers" && (
          <>
            <Field label="Position">
              <Select value={settings.numberPosition} onChange={(e) => setSettings({ ...settings, numberPosition: e.target.value as BatchSettings["numberPosition"] })}>
                {NUMBER_POSITIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </Select>
            </Field>
            <Field label="Format">
              <Segmented
                value={settings.numberFormat}
                onChange={(v) => setSettings({ ...settings, numberFormat: v })}
                size="sm"
                options={[
                  { value: "plain", label: "1" },
                  { value: "slash", label: "1 / N" },
                  { value: "of", label: "Page 1 of N" },
                ]}
              />
            </Field>
            <Field label="First number">
              <input type="number" min={0} value={settings.numberStart} onChange={(e) => setSettings({ ...settings, numberStart: Math.max(0, Number(e.target.value) || 0) })} className={cn(inputClass, "tabular-nums")} />
            </Field>
          </>
        )}
        {op === "watermark" && (
          <>
            <Field label="Watermark text">
              <input value={settings.watermark} onChange={(e) => setSettings({ ...settings, watermark: e.target.value })} className={inputClass} maxLength={60} />
            </Field>
            <Field label="Opacity" hint={`${Math.round(settings.watermarkOpacity * 100)}%`}>
              <input type="range" min={4} max={80} value={settings.watermarkOpacity * 100} onChange={(e) => setSettings({ ...settings, watermarkOpacity: Number(e.target.value) / 100 })} className="mt-3 w-full accent-[#1c4c3b]" />
            </Field>
            <Field label="Font size" hint={`${settings.watermarkSize}pt`}>
              <input type="range" min={14} max={110} value={settings.watermarkSize} onChange={(e) => setSettings({ ...settings, watermarkSize: Number(e.target.value) })} className="mt-3 w-full accent-[#1c4c3b]" />
            </Field>
            <Field label="Colour">
              <ColorInput value={settings.watermarkColor} onChange={(v) => setSettings({ ...settings, watermarkColor: v })} label="Watermark colour" />
            </Field>
            <Field label="Rotation" hint={`${settings.watermarkRotation}°`}>
              <input type="range" min={-90} max={90} step={5} value={settings.watermarkRotation} onChange={(e) => setSettings({ ...settings, watermarkRotation: Number(e.target.value) })} className="mt-3 w-full accent-[#1c4c3b]" />
            </Field>
          </>
        )}
      </div>

      {errors.length > 0 && (
        <Alert tone="error" title={`${errors.length} file${errors.length === 1 ? "" : "s"} couldn’t be processed`}>
          <ul className="mt-1 space-y-0.5">
            {errors.slice(0, 6).map((error) => <li key={error}>• {error}</li>)}
          </ul>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Button onClick={run} loading={busy} disabled={!files.length || invalid || busy}>
          <Layers className="h-4 w-4" /> {busy ? "Processing batch…" : `Process ${files.length || 0} file${files.length === 1 ? "" : "s"}`}
        </Button>
        {busy && (
          <Button variant="outline" onClick={() => { cancelRef.current = true; setStatus("Cancelling after the current file…"); }}>
            Cancel
          </Button>
        )}
        <span className="text-[11.5px] text-muted">Runs sequentially in this tab · nothing is uploaded</span>
      </div>
      {busy && <Progress value={progress} label={status} />}

      {entries && (
        <DownloadPanel
          title={entries.length === 1 ? "Batch finished" : `${entries.length} files processed`}
          filename={entries.length === 1 ? entries[0].name : `paperly-batch-${entries.length}-files.zip`}
          size={outTotal}
          pages={undefined}
          onDownload={() => void download()}
          description={
            entries.length
              ? `${entries.length} output${entries.length === 1 ? "" : "s"} · ${formatBytes(outTotal)} total${savedPct > 0 && op === "compress" ? ` · ${savedPct}% smaller` : ""}${entries.length > 1 ? " · packaged as a ZIP" : ""}`
              : "No outputs"
          }
          bytes={entries.length === 1 ? entries[0].bytes : undefined}
          extra={
            entries.length > 1 ? (
              <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-paper/15 bg-paper/[0.05] p-2 text-[11px] text-paper/70 scrollbar-thin">
                {entries.map((entry) => (
                  <div key={entry.name} className="flex items-center justify-between gap-2 py-0.5">
                    <span className="truncate">{entry.name}</span>
                    <span className="shrink-0 tabular-nums text-paper/75">{formatBytes(entry.after)}</span>
                  </div>
                ))}
              </div>
            ) : undefined
          }
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * CREATE FILLABLE FORM
 * ================================================================== */
type FieldKind = "text" | "checkbox" | "dropdown";

interface BuilderField {
  id: string;
  page: number;
  kind: FieldKind;
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
  required: boolean;
  multiline: boolean;
  fontSize: number;
  options: string;
}

const FIELD_DEFAULTS: Record<FieldKind, { w: number; h: number; label: string }> = {
  text: { w: 220, h: 26, label: "Text field" },
  checkbox: { w: 18, h: 18, label: "Checkbox" },
  dropdown: { w: 200, h: 26, label: "Dropdown" },
};

export function CreateFormTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [pageIndex, setPageIndex] = useState(0);
  const [dims, setDims] = useState<{ width: number; height: number; rotation: number }[]>([]);
  const [preview, setPreview] = useState<RenderedPage | null>(null);
  const [displayWidth, setDisplayWidth] = useState(720);
  const [fields, setFields] = useState<BuilderField[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeKind, setActiveKind] = useState<FieldKind | "select">("select");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; pages: number; fields: number } | null>(null);
  const counter = useRef(0);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ mode: "move" | "resize"; id: string; startX: number; startY: number; orig: BuilderField } | null>(null);

  const currentDims = dims[pageIndex] ?? { width: 612, height: 792, rotation: 0 };
  const pageW = currentDims.width;
  const pageH = currentDims.height;
  const scale = displayWidth / pageW;
  const pageFields = fields.filter((f) => f.page === pageIndex);
  const selected = fields.find((f) => f.id === selectedId) ?? null;
  const rotatedPages = dims.filter((d) => d.rotation % 360 !== 0).length;

  useEffect(() => {
    setPageIndex(0);
    setFields([]);
    setSelectedId(null);
    setResult(null);
    if (!pdf.bytes) {
      setDims([]);
      return;
    }
    const bytes = pdf.bytes;
    getPageDimensions(bytes).then(setDims).catch(() => undefined);
  }, [pdf.bytes]);

  useEffect(() => {
    if (!pdf.bytes) {
      setPreview(null);
      return;
    }
    let alive = true;
    const bytes = pdf.bytes;
    (async () => {
      const doc = await openPdfJs(bytes);
      const rendered = await renderPdfPage(doc, pageIndex + 1, { targetWidth: 1000, quality: 0.9, rotation: 0 });
      await doc.destroy();
      if (alive) setPreview(rendered);
    })().catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [pdf.bytes, pageIndex]);

  useEffect(() => {
    const node = surfaceRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => setDisplayWidth(entries[0].contentRect.width));
    observer.observe(node);
    setDisplayWidth(node.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, [preview, pdf.bytes]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      const node = surfaceRef.current;
      if (!drag || !node) return;
      const rect = node.getBoundingClientRect();
      const dx = ((event.clientX - drag.startX) / rect.width) * pageW;
      const dy = ((event.clientY - drag.startY) / rect.height) * pageH;
      setFields((current) =>
        current.map((field) => {
          if (field.id !== drag.id) return field;
          if (drag.mode === "move") {
            return { ...field, x: clamp(drag.orig.x + dx, 0, pageW - field.w), y: clamp(drag.orig.y + dy, 0, pageH - field.h) };
          }
          return { ...field, w: clamp(drag.orig.w + dx, 14, pageW - field.x), h: clamp(drag.orig.h + dy, 14, pageH - field.y) };
        }),
      );
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [pageW, pageH]);

  const placeField = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (activeKind === "select" || !surfaceRef.current) return;
    const rect = surfaceRef.current.getBoundingClientRect();
    const x = clamp(((event.clientX - rect.left) / rect.width) * pageW, 0, pageW - 20);
    const y = clamp(((event.clientY - rect.top) / rect.height) * pageH, 0, pageH - 20);
    const size = FIELD_DEFAULTS[activeKind];
    counter.current += 1;
    const base = activeKind === "text" ? "text" : activeKind === "checkbox" ? "consent" : "choice";
    const field: BuilderField = {
      id: uid(),
      page: pageIndex,
      kind: activeKind,
      x: clamp(x - size.w / 2, 0, pageW - size.w),
      y: clamp(y - size.h / 2, 0, pageH - size.h),
      w: size.w,
      h: size.h,
      name: `${base}_${fields.filter((f) => f.kind === activeKind).length + 1}`,
      required: false,
      multiline: false,
      fontSize: 11,
      options: activeKind === "dropdown" ? "Option one, Option two, Option three" : "",
    };
    setFields((current) => [...current, field]);
    setSelectedId(field.id);
    setActiveKind("select");
    setResult(null);
  };

  const update = (id: string, patch: Partial<BuilderField>) => {
    setFields((current) => current.map((field) => (field.id === id ? { ...field, ...patch } : field)));
    setResult(null);
  };

  const save = async () => {
    if (!pdf.bytes || !pdf.file) return;
    if (!fields.length) {
      setError("Add at least one field before saving.");
      return;
    }
    const cleaned = fields.map((field) => ({
      ...field,
      name: field.name.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "") || `field_${field.id.slice(-4)}`,
    }));
    const names = cleaned.map((f) => f.name.toLowerCase());
    const duplicate = names.find((name, index) => names.indexOf(name) !== index);
    if (duplicate) {
      setError(`Two fields use the name “${duplicate}”. Give every field a unique name.`);
      return;
    }
    const emptyChoice = cleaned.find((f) => f.kind === "dropdown" && !f.options.split(",").map((o) => o.trim()).filter(Boolean).length);
    if (emptyChoice) {
      setError(`Add at least one option to “${emptyChoice.name}”.`);
      return;
    }
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const doc = await openPdfLib(pdf.bytes);
      const form = doc.getForm();
      const pages = doc.getPages();
      const border = hexToRgb("#9aa39d");
      for (const field of cleaned) {
        const page = pages[field.page];
        if (!page) continue;
        const pageHeight = page.getHeight();
        const box = { x: field.x, y: pageHeight - field.y - field.h, width: field.w, height: field.h };
        if (field.kind === "text") {
          const text = form.createTextField(field.name);
          text.addToPage(page, { ...box, borderWidth: 1, borderColor: border, backgroundColor: hexToRgb("#fbfaf5") });
          text.setFontSize(field.fontSize);
          if (field.multiline || field.h > 34) text.enableMultiline();
          if (field.required) text.enableRequired();
        } else if (field.kind === "checkbox") {
          const check = form.createCheckBox(field.name);
          check.addToPage(page, { ...box, borderWidth: 1, borderColor: border, backgroundColor: hexToRgb("#ffffff") });
          if (field.required) check.enableRequired();
        } else {
          const choice = form.createDropdown(field.name);
          const options = field.options.split(",").map((o) => o.trim()).filter(Boolean);
          choice.addOptions(options);
          choice.addToPage(page, { ...box, borderWidth: 1, borderColor: border, backgroundColor: hexToRgb("#fbfaf5") });
          if (field.required) choice.enableRequired();
        }
      }
      const bytes = await doc.save();
      setResult({
        bytes,
        name: `${sanitizeName(baseName(pdf.file.name))}-form.pdf`,
        pages: doc.getPageCount(),
        fields: cleaned.length,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!pdf.file) {
    return (
      <div className="space-y-4">
        <FileDrop accept="application/pdf,.pdf" acceptLabel="The PDF to add fields to" onFiles={(files) => pdf.setFile(files[0])} />
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            { title: "Design visually", body: "Click the page to place text fields, checkboxes and dropdowns." },
            { title: "Real interactive fields", body: "Saved with proper AcroForm widgets, names and options — not drawn boxes." },
            { title: "Test immediately", body: "Hand the result to Fill PDF forms and complete it before sharing." },
          ].map((item) => (
            <div key={item.title} className="rounded-xl border border-line bg-bone-deep/25 p-3.5">
              <p className="text-[12.5px] font-semibold">{item.title}</p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-muted">{item.body}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FileRow file={pdf.file} onRemove={pdf.clear} size={`${pdf.pageCount} pages · ${formatBytes(pdf.file.size)}`} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-bone-deep/40 p-2">
        <div className="flex flex-wrap gap-1">
          {(["text", "checkbox", "dropdown"] as FieldKind[]).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => { setActiveKind(kind); setSelectedId(null); }}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11.5px] font-medium transition-colors",
                activeKind === kind ? "bg-forest text-paper" : "text-ink/70 hover:bg-paper hover:text-ink",
              )}
            >
              {kind === "text" ? <Type className="h-3.5 w-3.5" /> : kind === "checkbox" ? <Check className="h-3.5 w-3.5" /> : <ListOrdered className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">{FIELD_DEFAULTS[kind].label}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" disabled={pageIndex === 0} onClick={() => { setPageIndex((i) => i - 1); setSelectedId(null); }} aria-label="Previous page">
            <RotateCw className="h-3.5 w-3.5 -scale-x-100" />
          </Button>
          <span className="min-w-[74px] text-center text-[11.5px] font-medium tabular-nums text-ink/70">Page {pageIndex + 1} / {pdf.pageCount}</span>
          <Button variant="ghost" size="sm" disabled={pageIndex >= pdf.pageCount - 1} onClick={() => { setPageIndex((i) => i + 1); setSelectedId(null); }} aria-label="Next page">
            <RotateCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div>
          <p className="mb-2 text-[11.5px] text-muted">
            {activeKind === "select" ? "Drag a field to move it, or select one to edit its name and options." : `Click the page to place a ${FIELD_DEFAULTS[activeKind].label.toLowerCase()}.`}
          </p>
          <div className="rounded-xl border border-line bg-bone-deep/50 p-3 sm:p-5">
            <div className="mx-auto w-full max-w-[760px]">
              <div
                ref={surfaceRef}
                onPointerDown={placeField}
                className={cn("relative w-full overflow-hidden rounded-sm bg-white pdf-page-shadow", activeKind !== "select" ? "cursor-crosshair" : "cursor-default")}
                style={{ aspectRatio: `${pageW} / ${pageH}` }}
              >
                {preview ? (
                  <img src={preview.dataUrl} alt={`Page ${pageIndex + 1}`} className="pointer-events-none absolute inset-0 h-full w-full object-fill" draggable={false} />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-[12px] text-ink/70">Rendering page…</div>
                )}
                {pageFields.map((field) => (
                  <div
                    key={field.id}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      setSelectedId(field.id);
                      dragRef.current = { mode: "move", id: field.id, startX: event.clientX, startY: event.clientY, orig: { ...field } };
                    }}
                    className={cn(
                      "absolute flex cursor-move items-center justify-center overflow-hidden border-2 text-[9px] font-semibold",
                      selectedId === field.id ? "border-clay bg-clay/15 text-clay-ink" : "border-forest/60 bg-forest/10 text-forest",
                      field.kind === "checkbox" ? "rounded-sm" : "rounded",
                    )}
                    style={{ left: field.x * scale, top: field.y * scale, width: field.w * scale, height: field.h * scale }}
                    title={field.name}
                  >
                    <span className="truncate px-1">{field.kind === "text" ? field.name : field.kind === "checkbox" ? "✓" : field.name}</span>
                    {selectedId === field.id && (
                      <>
                        <button
                          type="button"
                          aria-label="Delete field"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => { setFields((current) => current.filter((f) => f.id !== field.id)); setSelectedId(null); }}
                          className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-ink text-paper"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                        <div
                          onPointerDown={(event) => {
                            event.stopPropagation();
                            dragRef.current = { mode: "resize", id: field.id, startX: event.clientX, startY: event.clientY, orig: { ...field } };
                          }}
                          className="absolute bottom-0 right-0 h-2.5 w-2.5 cursor-se-resize rounded-sm bg-clay"
                        />
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button onClick={save} loading={busy}>
              <Save className="h-4 w-4" /> Save interactive form
            </Button>
            <span className="text-[11.5px] text-muted">{fields.length} field{fields.length === 1 ? "" : "s"} · real AcroForm widgets</span>
            {fields.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => { setFields([]); setSelectedId(null); setResult(null); }}>
                Clear fields
              </Button>
            )}
          </div>
          {busy && <Progress label="Writing form fields into the PDF…" />}
          {error && <Alert tone="error" className="mt-3">{error}</Alert>}
          {rotatedPages > 0 && (
            <Alert tone="info" className="mt-3">
              This PDF has {rotatedPages} rotated page{rotatedPages === 1 ? "" : "s"}. Fields are placed on the unrotated page content, which matches the
              preview above; most readers display them in the same position.
            </Alert>
          )}
        </div>

        <aside className="space-y-3">
          <div className="rounded-xl border border-line bg-paper p-3.5">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">Field properties</p>
            {!selected && <p className="text-[12px] leading-relaxed text-muted">Select a field on the page to change its name, size or required state.</p>}
            {selected && (
              <div className="space-y-3">
                <Field label="Field name" hint="Used by PDF readers and form tools. Letters, numbers and underscores.">
                  <input value={selected.name} onChange={(e) => update(selected.id, { name: e.target.value })} className={inputClass} />
                </Field>
                {selected.kind === "dropdown" && (
                  <Field label="Options" hint="Comma separated">
                    <textarea value={selected.options} onChange={(e) => update(selected.id, { options: e.target.value })} rows={3} className={cn(inputClass, "h-auto py-2")} />
                  </Field>
                )}
                {selected.kind === "text" && (
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Font size">
                      <input type="number" min={6} max={24} value={selected.fontSize} onChange={(e) => update(selected.id, { fontSize: clamp(Number(e.target.value) || 11, 6, 24) })} className={cn(inputClass, "h-9")} />
                    </Field>
                    <Field label="Multiline">
                      <button
                        type="button"
                        onClick={() => update(selected.id, { multiline: !selected.multiline })}
                        className={cn("mt-1 h-9 w-full rounded-lg border text-[12px] font-medium", selected.multiline ? "border-forest bg-forest text-paper" : "border-line bg-paper")}
                      >
                        {selected.multiline ? "On" : "Off"}
                      </button>
                    </Field>
                  </div>
                )}
                <Switch checked={selected.required} onChange={(v) => update(selected.id, { required: v })} label="Required field" description="Readers mark it as mandatory" />
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Width pt">
                    <input type="number" min={12} value={Math.round(selected.w)} onChange={(e) => update(selected.id, { w: clamp(Number(e.target.value) || 20, 12, pageW - selected.x) })} className={cn(inputClass, "h-9")} />
                  </Field>
                  <Field label="Height pt">
                    <input type="number" min={12} value={Math.round(selected.h)} onChange={(e) => update(selected.id, { h: clamp(Number(e.target.value) || 20, 12, pageH - selected.y) })} className={cn(inputClass, "h-9")} />
                  </Field>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => {
                      const copy = { ...selected, id: uid(), name: `${selected.name}_copy`, x: clamp(selected.x + 12, 0, pageW - selected.w), y: clamp(selected.y + 12, 0, pageH - selected.h) };
                      setFields((current) => [...current, copy]);
                      setSelectedId(copy.id);
                    }}
                  >
                    Duplicate
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => { setFields((current) => current.filter((f) => f.id !== selected.id)); setSelectedId(null); }}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-line bg-bone-deep/30 p-3">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">All fields · {fields.length}</p>
            {fields.length === 0 ? (
              <p className="text-[11.5px] text-muted">Nothing added yet.</p>
            ) : (
              <ul className="space-y-1">
                {fields.map((field) => (
                  <li key={field.id}>
                    <button
                      type="button"
                      onClick={() => { setActiveKind("select"); setPageIndex(field.page); setSelectedId(field.id); }}
                      className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px]", selectedId === field.id ? "bg-forest text-paper" : "hover:bg-paper")}
                    >
                      <span className="truncate">{field.name}</span>
                      <span className="ml-auto shrink-0 text-[9.5px] opacity-60">{field.kind} · p.{field.page + 1}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-xl border border-forest/15 bg-lime/20 p-3 text-[11px] leading-relaxed text-forest">
            <p className="flex items-center gap-1.5 font-semibold"><ShieldCheck className="h-3.5 w-3.5" /> Real, fillable widgets</p>
            <p className="mt-1 text-forest/90">The saved PDF contains genuine form fields — test it with Fill PDF forms or any desktop reader.</p>
          </div>
        </aside>
      </div>

      {result && (
        <DownloadPanel
          title="Interactive form created"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${result.fields} field${result.fields === 1 ? "" : "s"} written as AcroForm widgets · use the handoff below to fill and test the result`}
          bytes={result.bytes}
        />
      )}
    </div>
  );
}
