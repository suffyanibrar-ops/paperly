import {
  ArrowRight,
  Calendar,
  Check,
  ChevronDown,
  ChevronUp,
  Circle,
  Eye,
  FileCheck2,
  FileSpreadsheet,
  FileText,
  Layers,
  ListOrdered,
  LockKeyhole,
  PenLine,
  Plus,
  RotateCw,
  Save,
  Images,
  ScanText,
  ShieldCheck,
  Trash2,
  Type,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { PDFHexString, PDFName } from "@cantoo/pdf-lib";
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
  dataUrlToBytes,
  readFileBytes,
  renderPdfPage,
  safePdfText,
  sanitizeName,
  zipAndDownload,
  type RenderedPage,
} from "@/lib/pdf";
import { recompressImages } from "@/tools/Optimize";
import { useInitialFiles, usePdfFile } from "@/lib/usePdf";
import { FREE_BATCH_LIMIT, ProBadge, usePro } from "@/lib/pro";
import { ocrPdfToSearchable } from "@/lib/ocrBatch";
import { DEFAULT_SANITIZE_OPTIONS, sanitizePdf } from "@/tools/Privacy";
import {
  Alert,
  Badge,
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
import { OutputPreview } from "@/components/OutputPreview";
import { getTool } from "@/lib/toolRegistry";
import { recordActivity } from "@/lib/activity";
import { friendlyProcessingError, validateUpload } from "@/lib/security";
import { SAMPLE } from "@/lib/sample";
import { describeJobTime, useJob } from "@/lib/job";
import { useDownloadShortcut, usePrimaryShortcut } from "@/lib/hotkeys";
import { useToolPreferences } from "@/lib/prefs";
import { cn } from "@/utils/cn";

const MM = 2.834645669;
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** Quote one CSV cell (RFC 4180) — report values can contain commas and quotes. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/* ================================================================== *
 * BATCH PDF — iLovePDF caps this on free; Paperly does not.
 * ================================================================== */
type BatchOp = "compress" | "rotate" | "protect" | "numbers" | "watermark" | "flatten" | "sanitize" | "ocr" | "jpg";
type QueueStatus = "pending" | "running" | "done" | "failed";

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
type NumberPosition = (typeof NUMBER_POSITIONS)[number]["value"];

const BATCH_OPERATIONS: { value: BatchOp; label: string; icon: typeof Layers; description: string }[] = [
  { value: "compress", label: "Compress", icon: Layers, description: "Re-encodes photos; text stays sharp" },
  { value: "rotate", label: "Rotate", icon: RotateCw, description: "Adds 90°, 180° or 270° to every page" },
  { value: "protect", label: "Protect", icon: LockKeyhole, description: "AES-256 with one password for all files" },
  { value: "numbers", label: "Page numbers", icon: ListOrdered, description: "Bottom or top, with your own format" },
  { value: "watermark", label: "Watermark", icon: Type, description: "Diagonal text over every page" },
  { value: "flatten", label: "Flatten", icon: FileCheck2, description: "Bakes form fields into the page" },
  { value: "sanitize", label: "Sanitize", icon: ShieldCheck, description: "Strips metadata, scripts, attachments and hidden actions" },
  { value: "ocr", label: "OCR", icon: ScanText, description: "Adds a searchable English text layer to scans (≤50 pages)" },
  { value: "jpg", label: "PDF → JPG", icon: Images, description: "Exports every page as a JPEG inside a ZIP" },
];

interface BatchPrefs extends Record<string, unknown> {
  op: BatchOp;
  level: BatchLevel;
  angle: 90 | 180 | 270;
  allowPrinting: boolean;
  numberPosition: NumberPosition;
  numberStart: number;
  numberFormat: "plain" | "slash" | "of";
  watermark: string;
  watermarkSize: number;
  watermarkOpacity: number;
  watermarkColor: string;
  watermarkRotation: number;
}

interface QueueItem {
  id: string;
  file: File;
  status: QueueStatus;
  error: string;
  bytes: Uint8Array | null;
  outputName: string;
  before: number;
  after: number;
}

function toQueueItem(file: File): QueueItem {
  return {
    id: uid(),
    file,
    status: "pending",
    error: "",
    bytes: null,
    outputName: "",
    before: file.size,
    after: 0,
  };
}

export function BatchTool() {
  const toolId = useToolId();
  const initial = useInitialFiles();
  const opts = useToolPreferences<BatchPrefs>("batch", {
    op: "compress",
    level: "balanced",
    angle: 90,
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
  const pro = usePro();
  const job = useJob<void>();
  const [items, setItems] = useState<QueueItem[]>(() =>
    initial
      .filter((file) => /\.pdf$/i.test(file.name) || file.type === "application/pdf")
      .slice(0, pro.isPro ? undefined : FREE_BATCH_LIMIT)
      .map(toQueueItem),
  );
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [problem, setProblem] = useState("");

  const op = opts.value.op;
  const totalIn = items.reduce((sum, item) => sum + item.before, 0);
  const done = items.filter(
    (item): item is QueueItem & { bytes: Uint8Array } => item.status === "done" && item.bytes !== null,
  );
  const failed = items.filter((item) => item.status === "failed");
  const invalid = op === "protect" && (password.length < 4 || password !== confirm);
  const suffixFor = (operation: BatchOp) =>
    operation === "compress"
      ? "compressed"
      : operation === "rotate"
        ? "rotated"
        : operation === "protect"
          ? "protected"
          : operation === "numbers"
            ? "numbered"
            : operation === "flatten"
              ? "flattened"
              : operation === "sanitize"
                ? "sanitized"
                : operation === "ocr"
                  ? "searchable"
                  : operation === "jpg"
                    ? "images"
                    : "watermarked";

  const transform = async (file: File): Promise<Uint8Array> => {
    const buffer = await readFileBytes(file);
    if (op === "compress") {
      const result = await recompressImages(
        buffer,
        { quality: LEVELS[opts.value.level].quality, maxDimension: LEVELS[opts.value.level].maxDimension },
        () => undefined,
      );
      return result.bytes;
    }
    if (op === "sanitize") {
      const result = await sanitizePdf(buffer, DEFAULT_SANITIZE_OPTIONS, () => undefined);
      return result.bytes;
    }
    if (op === "ocr") {
      return ocrPdfToSearchable(buffer, () => undefined);
    }
    if (op === "jpg") {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      const source = await openPdfJs(buffer);
      for (let page = 1; page <= source.numPages; page++) {
        const rendered = await renderPdfPage(source, page, { targetWidth: 1654, type: "image/jpeg", quality: 0.9 });
        zip.file(`page-${String(page).padStart(3, "0")}.jpg`, dataUrlToBytes(rendered.dataUrl));
      }
      await source.destroy().catch(() => undefined);
      return new Uint8Array(await (await zip.generateAsync({ type: "blob", compression: "DEFLATE" })).arrayBuffer());
    }
    const doc = await openPdfLib(buffer);
    if (op === "protect") {
      doc.encrypt({
        userPassword: password,
        ownerPassword: password,
        permissions: {
          printing: opts.value.allowPrinting ? "highResolution" : false,
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
        page.setRotation(degrees((page.getRotation().angle + opts.value.angle) % 360));
      });
      return doc.save();
    }
    if (op === "numbers") {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const total = doc.getPageCount();
      doc.getPages().forEach((page, index) => {
        const n = opts.value.numberStart + index;
        const label =
          opts.value.numberFormat === "slash"
            ? `${n} / ${total}`
            : opts.value.numberFormat === "of"
              ? `Page ${n} of ${total}`
              : `${n}`;
        const width = page.getWidth();
        const height = page.getHeight();
        const textWidth = font.widthOfTextAtSize(label, 9);
        const margin = 14 * MM;
        let x = (width - textWidth) / 2;
        if (opts.value.numberPosition.endsWith("left")) x = margin;
        if (opts.value.numberPosition.endsWith("right")) x = width - margin - textWidth;
        const y = opts.value.numberPosition.startsWith("top") ? height - margin - 9 : margin;
        page.drawText(label, { x, y, size: 9, font, color: hexToRgb("#25352c") });
      });
      return doc.save();
    }
    if (op === "flatten") {
      try {
        doc.getForm().flatten();
      } catch {
        /* documents without form fields are already flat */
      }
      return doc.save();
    }
    // watermark
    const fonts = await embedFonts(doc);
    const text = safePdfText(opts.value.watermark);
    if (!text.trim()) throw new Error("Enter watermark text.");
    doc.getPages().forEach((page) => {
      const { width, height } = page.getSize();
      const textWidth = fonts.bold.widthOfTextAtSize(text, opts.value.watermarkSize);
      page.drawText(text, {
        x: (width - textWidth) / 2,
        y: height / 2 - opts.value.watermarkSize * 0.35,
        size: opts.value.watermarkSize,
        font: fonts.bold,
        color: hexToRgb(opts.value.watermarkColor),
        opacity: opts.value.watermarkOpacity,
        rotate: degrees(opts.value.watermarkRotation),
      });
    });
    return doc.save();
  };

  const runQueue = (targets?: string[]) => {
    const queue = items.filter((item) => !targets || targets.includes(item.id));
    if (!queue.length) {
      setProblem("Add at least one PDF.");
      return;
    }
    if (!pro.isPro && (targets ?? items.map((item) => item.id)).length > FREE_BATCH_LIMIT) {
      pro.openUpgrade(`Batch runs over ${FREE_BATCH_LIMIT} files are part of Paperly Pro. Every single-file tool remains free.`);
      return;
    }
    if (invalid) {
      setProblem("Use a password of at least 4 characters and make sure both fields match.");
      return;
    }
    if (op === "watermark" && !opts.value.watermark.trim()) {
      setProblem("Enter watermark text.");
      return;
    }
    setProblem("");
    const operation = op;
    void job.run(async ({ step, throwIfCancelled }) => {
      const ids = new Set(queue.map((item) => item.id));
      setItems((current) =>
        current.map((item) =>
          ids.has(item.id) ? { ...item, status: "pending", error: "", bytes: null, after: 0 } : item,
        ),
      );
      for (let index = 0; index < queue.length; index += 1) {
        throwIfCancelled();
        const entry = queue[index];
        setItems((current) =>
          current.map((item) => (item.id === entry.id ? { ...item, status: "running", error: "" } : item)),
        );
        try {
          const bytes = await transform(entry.file);
          setItems((current) =>
            current.map((item) =>
              item.id === entry.id
                ? {
                    ...item,
                    status: "done",
                    bytes,
                    after: bytes.byteLength,
                    outputName: `${sanitizeName(baseName(entry.file.name))}-${suffixFor(operation)}.${operation === "jpg" ? "zip" : "pdf"}`,
                  }
                : item,
            ),
          );
        } catch (err) {
          setItems((current) =>
            current.map((item) =>
              item.id === entry.id
                ? {
                    ...item,
                    status: "failed",
                    error: friendlyProcessingError(err, "This file couldn’t be processed."),
                  }
                : item,
            ),
          );
        }
        step(index + 1, queue.length, `File ${index + 1} of ${queue.length} · ${entry.file.name}`);
      }
    });
  };

  const download = async () => {
    if (!done.length) return;
    if (done.length === 1) {
      downloadBytes(done[0].bytes, done[0].outputName);
    } else {
      await zipAndDownload(
        done.map((entry) => ({ name: entry.outputName, data: entry.bytes })),
        `paperly-batch-${new Date().toISOString().slice(0, 10)}.zip`,
      );
    }
    if (toolId) {
      recordActivity({
        toolId,
        toolName: getTool(toolId)?.name ?? "Paperly",
        filename: done.length === 1 ? done[0].outputName : `paperly-batch-${done.length}-files.zip`,
        size: done.reduce((sum, entry) => sum + entry.after, 0),
      });
    }
  };

  const downloadReport = () => {
    const header = ["File", "Status", "Input bytes", "Output bytes", "Saved %", "Output file", "Message"];
    const rows = items.map((item) => [
      item.file.name,
      item.status,
      String(item.before),
      item.status === "done" ? String(item.after) : "",
      item.status === "done" && item.before > 0
        ? String(Math.max(0, Math.round((1 - item.after / item.before) * 100)))
        : "",
      item.status === "done" ? item.outputName : "",
      item.error,
    ]);
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    downloadBytes(
      new TextEncoder().encode(csv),
      `paperly-batch-report-${new Date().toISOString().slice(0, 10)}.csv`,
      "text/csv",
    );
  };

  const addFiles = async (picked: File[]) => {
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
      const room = pro.isPro ? valid.length : Math.max(0, FREE_BATCH_LIMIT - items.length);
      const accepted = valid.slice(0, room);
      if (accepted.length < valid.length) {
        pro.openUpgrade(
          `Batch runs over ${FREE_BATCH_LIMIT} files are part of Paperly Pro. ${valid.length - accepted.length} file${
            valid.length - accepted.length === 1 ? " was" : "s were"
          } not added.`,
        );
      }
      if (accepted.length) setItems((current) => [...current, ...accepted.map(toQueueItem)]);
    }
    setProblem(problems.join(" "));
  };

  const outTotal = done.reduce((sum, entry) => sum + entry.after, 0);
  const savedPct = done.length
    ? Math.round((1 - outTotal / Math.max(1, done.reduce((sum, entry) => sum + entry.before, 0))) * 100)
    : 0;
  const processedCount = items.filter((item) => item.status === "done").length;

  usePrimaryShortcut(() => runQueue(), items.length > 0 && !job.busy && !invalid);
  useDownloadShortcut(() => void download(), done.length > 0);

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-forest/15 bg-lime/20 p-3.5">
        <p className="flex flex-wrap items-center gap-1.5 text-[12.5px] font-semibold text-forest">
          <Layers className="h-4 w-4" /> Batch processing, on your device
          {!pro.isPro && <ProBadge />}
        </p>
        <p className="mt-1 text-[11.5px] leading-relaxed text-forest/90">
          Apply one operation to many PDFs and download a ZIP with a CSV report. Every file is processed locally. The free plan runs up to{" "}
          {FREE_BATCH_LIMIT} files per batch; <strong>Paperly Pro</strong> removes the limit for high-volume commercial work.
        </p>
        {!pro.isPro && (
          <button
            type="button"
            onClick={() => pro.openUpgrade(`Batch runs over ${FREE_BATCH_LIMIT} files are part of Paperly Pro.`)}
            className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-lg bg-forest px-2.5 text-[11px] font-semibold text-paper"
          >
            Unlock unlimited batch <ArrowRight className="h-3 w-3 text-lime" />
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <FileDrop
          accept="application/pdf,.pdf"
          acceptLabel="PDF files"
          multiple
          sample={SAMPLE.pdf}
          hint={`Add up to ${pro.isPro ? "unlimited" : FREE_BATCH_LIMIT} PDFs; each one is processed separately.`}
          onFiles={(picked) => void addFiles(picked)}
        />
      ) : (
        <div className="space-y-2">
          {items.map((item, index) => (
            <div key={item.id} className="rounded-xl border border-line bg-paper px-3 py-2.5">
              <div className="flex items-center gap-3">
                <span className="w-5 shrink-0 text-center text-[11px] font-semibold tabular-nums text-ink/60">
                  {index + 1}
                </span>
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-bone-deep text-forest">
                  <FileText className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold leading-tight">{item.file.name}</p>
                  <p
                    className={cn(
                      "mt-0.5 text-[11px]",
                      item.status === "failed" ? "font-medium text-clay-ink" : "text-muted",
                    )}
                  >
                    {formatBytes(item.before)}
                    {item.status === "done" ? ` → ${formatBytes(item.after)}` : ""}
                    {item.error ? ` · ${item.error}` : ""}
                    {item.status === "pending" && !item.error ? " · waiting" : ""}
                    {item.status === "running" ? " · working…" : ""}
                  </p>
                </div>
                {item.status === "done" && (
                  <Badge tone="forest">
                    <Check className="h-3 w-3" /> Done
                  </Badge>
                )}
                {item.status === "failed" && <Badge tone="clay">Failed</Badge>}
                {item.status === "failed" && !job.busy && (
                  <button
                    type="button"
                    onClick={() => runQueue([item.id])}
                    aria-label={`Retry ${item.file.name}`}
                    title="Retry this file"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink/70 transition-colors hover:bg-forest/10 hover:text-forest"
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))}
                  aria-label={`Remove ${item.file.name}`}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink/70 transition-colors hover:bg-clay/10 hover:text-clay-ink"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-paper px-3 py-2 text-[12px] font-medium text-ink/75 hover:border-forest/30">
                <Plus className="h-3.5 w-3.5" /> Add PDFs
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  multiple
                  aria-label="Add more PDF files to the batch"
                  className="sr-only"
                  onChange={async (event) => {
                    const picked = Array.from(event.target.files ?? []);
                    event.target.value = "";
                    await addFiles(picked);
                  }}
                />
              </label>
              {failed.length > 0 && !job.busy && (
                <Button variant="outline" size="sm" onClick={() => runQueue(failed.map((item) => item.id))}>
                  <RotateCw className="h-3.5 w-3.5" /> Retry {failed.length} failed file{failed.length === 1 ? "" : "s"}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={downloadReport}>
                <FileSpreadsheet className="h-3.5 w-3.5" /> CSV report
              </Button>
            </div>
            <div className="flex items-center gap-2 text-[11.5px] text-muted">
              <span>
                {items.length} file{items.length === 1 ? "" : "s"} · {formatBytes(totalIn)} in
              </span>
              <button
                type="button"
                onClick={() => {
                  setItems([]);
                  job.reset();
                }}
                className="font-medium text-clay-ink hover:underline"
              >
                Clear
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="border-t border-line pt-4">
        <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink/70">Operation for every file</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {BATCH_OPERATIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              title={option.description}
              aria-pressed={op === option.value}
              onClick={() => {
                opts.set("op", option.value);
                setProblem("");
              }}
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-[11.5px] font-medium transition-colors",
                op === option.value
                  ? "border-forest bg-forest text-paper"
                  : "border-line bg-paper text-ink/70 hover:border-forest/30",
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
            <Select
              value={opts.value.level}
              onChange={(event) => opts.set("level", event.target.value as BatchLevel)}
            >
              {Object.entries(LEVELS).map(([key, value]) => (
                <option key={key} value={key}>
                  {value.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {op === "rotate" && (
          <Field label="Rotate every page">
            <Select
              value={opts.value.angle}
              onChange={(event) => opts.set("angle", Number(event.target.value) as 90 | 180 | 270)}
            >
              <option value={90}>90° clockwise</option>
              <option value={180}>180°</option>
              <option value={270}>90° anticlockwise</option>
            </Select>
          </Field>
        )}
        {op === "protect" && (
          <>
            <Field label="Password" hint="At least 4 characters. AES-256. Not remembered between visits.">
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className={inputClass}
                autoComplete="new-password"
              />
            </Field>
            <Field label="Confirm password">
              <input
                type="password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                className={inputClass}
                autoComplete="new-password"
              />
            </Field>
            <div className="sm:col-span-2">
              <Switch
                checked={opts.value.allowPrinting}
                onChange={(value) => opts.set("allowPrinting", value)}
                label="Allow printing"
                description="Copying and editing are disabled in every output"
              />
            </div>
          </>
        )}
        {op === "numbers" && (
          <>
            <Field label="Position">
              <Select
                value={opts.value.numberPosition}
                onChange={(event) => opts.set("numberPosition", event.target.value as NumberPosition)}
              >
                {NUMBER_POSITIONS.map((position) => (
                  <option key={position.value} value={position.value}>
                    {position.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Format">
              <Segmented
                value={opts.value.numberFormat}
                onChange={(value) => opts.set("numberFormat", value)}
                size="sm"
                options={[
                  { value: "plain", label: "1" },
                  { value: "slash", label: "1 / N" },
                  { value: "of", label: "Page 1 of N" },
                ]}
              />
            </Field>
            <Field label="First number">
              <input
                type="number"
                min={0}
                value={opts.value.numberStart}
                onChange={(event) => opts.set("numberStart", Math.max(0, Number(event.target.value) || 0))}
                className={cn(inputClass, "tabular-nums")}
              />
            </Field>
          </>
        )}
        {op === "watermark" && (
          <>
            <Field label="Watermark text">
              <input
                value={opts.value.watermark}
                onChange={(event) => opts.set("watermark", event.target.value)}
                className={inputClass}
                maxLength={60}
              />
            </Field>
            <Field label="Opacity" hint={`${Math.round(opts.value.watermarkOpacity * 100)}%`}>
              <input
                type="range"
                min={4}
                max={80}
                value={opts.value.watermarkOpacity * 100}
                onChange={(event) => opts.set("watermarkOpacity", Number(event.target.value) / 100)}
                className="mt-3 w-full accent-[#1c4c3b]"
              />
            </Field>
            <Field label="Font size" hint={`${opts.value.watermarkSize}pt`}>
              <input
                type="range"
                min={14}
                max={110}
                value={opts.value.watermarkSize}
                onChange={(event) => opts.set("watermarkSize", Number(event.target.value))}
                className="mt-3 w-full accent-[#1c4c3b]"
              />
            </Field>
            <Field label="Colour">
              <ColorInput
                value={opts.value.watermarkColor}
                onChange={(value) => opts.set("watermarkColor", value)}
                label="Watermark colour"
              />
            </Field>
            <Field label="Rotation" hint={`${opts.value.watermarkRotation}°`}>
              <input
                type="range"
                min={-90}
                max={90}
                step={5}
                value={opts.value.watermarkRotation}
                onChange={(event) => opts.set("watermarkRotation", Number(event.target.value))}
                className="mt-3 w-full accent-[#1c4c3b]"
              />
            </Field>
          </>
        )}
        {op === "flatten" && (
          <div className="sm:col-span-2 rounded-xl border border-line bg-bone-deep/30 px-3.5 py-3 text-[11.5px] leading-relaxed text-ink/70">
            Form fields become permanent page content, so the answers survive in every reader. PDFs without a form are copied through
            unchanged.
          </div>
        )}
      </div>

      {problem && <Alert tone="error">{problem}</Alert>}
      {failed.length > 0 && (
        <Alert tone="error" title={`${failed.length} file${failed.length === 1 ? "" : "s"} couldn’t be processed`}>
          <ul className="mt-1 space-y-0.5">
            {failed.slice(0, 6).map((item) => (
              <li key={item.id}>• {item.file.name}: {item.error}</li>
            ))}
          </ul>
        </Alert>
      )}
      {job.status === "cancelled" && (
        <Alert tone="info">
          Cancelled after {processedCount} of {items.length} file{items.length === 1 ? "" : "s"}. Finished files are still available.
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Button onClick={() => runQueue()} loading={job.busy} disabled={!items.length || invalid || job.busy}>
          <Layers className="h-4 w-4" />{" "}
          {job.busy ? "Processing batch…" : `Process ${items.length || 0} file${items.length === 1 ? "" : "s"}`}
        </Button>
        {job.busy && (
          <Button variant="outline" onClick={job.cancel}>
            Cancel
          </Button>
        )}
        <span className="text-[11.5px] text-muted">Runs sequentially in this tab · nothing is uploaded</span>
      </div>
      {job.busy && (
        <Progress value={job.percent ?? undefined} label={job.label} detail={describeJobTime(job)} />
      )}

      {done.length > 0 && !job.busy && (
        <DownloadPanel
          title={done.length === 1 ? "Batch finished" : `${done.length} files processed`}
          filename={done.length === 1 ? done[0].outputName : `paperly-batch-${done.length}-files.zip`}
          size={outTotal}
          onDownload={() => void download()}
          description={
            `${done.length} output${done.length === 1 ? "" : "s"} · ${formatBytes(outTotal)} total${
              savedPct > 0 && op === "compress" ? ` · ${savedPct}% smaller` : ""
            }${done.length > 1 ? " · packaged as a ZIP" : ""}`
          }
          bytes={done.length === 1 ? done[0].bytes : undefined}
          facts={[
            { label: "Operation", value: BATCH_OPERATIONS.find((entry) => entry.value === op)?.label ?? op },
            { label: "Files", value: `${done.length} of ${items.length}` },
          ]}
          extra={
            <div className="mt-2 space-y-2">
              {done.length > 1 && (
                <div className="max-h-40 overflow-y-auto rounded-lg border border-paper/15 bg-paper/[0.05] p-2 text-[11px] text-paper/70 scrollbar-thin">
                  {done.map((entry) => (
                    <div key={entry.id} className="flex items-center justify-between gap-2 py-0.5">
                      <span className="truncate">{entry.outputName}</span>
                      <span className="shrink-0 tabular-nums text-paper/75">{formatBytes(entry.after)}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={downloadReport}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-paper/20 bg-paper/[0.06] px-2.5 text-[11.5px] font-medium text-paper transition-colors hover:border-lime/40 hover:bg-paper/10"
                >
                  <FileSpreadsheet className="h-3.5 w-3.5 text-lime" /> Download CSV report
                </button>
              </div>
            </div>
          }
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * CREATE FILLABLE FORM
 * ================================================================== */
type FieldKind = "text" | "checkbox" | "radio" | "dropdown" | "date" | "signature";

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
  defaultValue: string;
  tooltip: string;
}

const FIELD_DEFAULTS: Record<FieldKind, { w: number; h: number; label: string; base: string }> = {
  text: { w: 220, h: 26, label: "Text field", base: "text" },
  checkbox: { w: 18, h: 18, label: "Checkbox", base: "consent" },
  radio: { w: 200, h: 58, label: "Radio group", base: "choice" },
  dropdown: { w: 200, h: 26, label: "Dropdown", base: "choice" },
  date: { w: 170, h: 26, label: "Date field", base: "date" },
  signature: { w: 200, h: 50, label: "Signature area", base: "signature" },
};

const FIELD_KINDS: { kind: FieldKind; label: string; icon: typeof Type }[] = [
  { kind: "text", label: "Text field", icon: Type },
  { kind: "checkbox", label: "Checkbox", icon: Check },
  { kind: "radio", label: "Radio group", icon: Circle },
  { kind: "dropdown", label: "Dropdown", icon: ListOrdered },
  { kind: "date", label: "Date field", icon: Calendar },
  { kind: "signature", label: "Signature area", icon: PenLine },
];

const parseOptions = (raw: string): string[] => [
  ...new Set(
    raw
      .split(",")
      .map((option) => option.trim())
      .filter(Boolean),
  ),
];

interface FormResult {
  bytes: Uint8Array;
  name: string;
  pages: number;
  fields: number;
}

export function CreateFormTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const opts = useToolPreferences("create-form", { requiredByDefault: false });
  const job = useJob<FormResult>();
  const [pageIndex, setPageIndex] = useState(0);
  const [dims, setDims] = useState<{ width: number; height: number; rotation: number }[]>([]);
  const [preview, setPreview] = useState<RenderedPage | null>(null);
  const [displayWidth, setDisplayWidth] = useState(720);
  const [fields, setFields] = useState<BuilderField[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeKind, setActiveKind] = useState<FieldKind | "select">("select");
  const [error, setError] = useState("");
  const [ghost, setGhost] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [formPreview, setFormPreview] = useState<{ bytes: Uint8Array; name: string } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ mode: "move" | "resize"; id: string; startX: number; startY: number; orig: BuilderField } | null>(
    null,
  );
  const placeRef = useRef<{ pointerId: number; clientX: number; clientY: number; x: number; y: number } | null>(null);
  const ghostRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  const currentDims = dims[pageIndex] ?? { width: 612, height: 792, rotation: 0 };
  const pageW = currentDims.width;
  const pageH = currentDims.height;
  const scale = displayWidth / pageW;
  const pageFields = fields.filter((field) => field.page === pageIndex);
  const selected = fields.find((field) => field.id === selectedId) ?? null;
  const rotatedPages = dims.filter((dim) => dim.rotation % 360 !== 0).length;
  const result = job.result;

  useEffect(() => {
    setPageIndex(0);
    setFields([]);
    setSelectedId(null);
    job.reset();
    if (!pdf.bytes) {
      setDims([]);
      return;
    }
    const bytes = pdf.bytes;
    getPageDimensions(bytes)
      .then(setDims)
      .catch(() => undefined);
    // `job` is a stable controller; the document is the real dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
            return {
              ...field,
              x: clamp(drag.orig.x + dx, 0, pageW - field.w),
              y: clamp(drag.orig.y + dy, 0, pageH - field.h),
            };
          }
          return {
            ...field,
            w: clamp(drag.orig.w + dx, 14, pageW - field.x),
            h: clamp(drag.orig.h + dy, 14, pageH - field.y),
          };
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

  const pagePoint = (clientX: number, clientY: number) => {
    const node = surfaceRef.current;
    if (!node) return { x: 0, y: 0 };
    const rect = node.getBoundingClientRect();
    return {
      x: clamp(((clientX - rect.left) / rect.width) * pageW, 0, pageW),
      y: clamp(((clientY - rect.top) / rect.height) * pageH, 0, pageH),
    };
  };

  const createField = (kind: FieldKind, box: { x: number; y: number; w: number; h: number }) => {
    const base = FIELD_DEFAULTS[kind].base;
    const taken = new Set(fields.map((field) => field.name));
    let index = fields.filter((field) => field.kind === kind).length + 1;
    let name = `${base}_${index}`;
    while (taken.has(name)) {
      index += 1;
      name = `${base}_${index}`;
    }
    const field: BuilderField = {
      id: uid(),
      page: pageIndex,
      kind,
      x: clamp(box.x, 0, Math.max(0, pageW - box.w)),
      y: clamp(box.y, 0, Math.max(0, pageH - box.h)),
      w: box.w,
      h: box.h,
      name,
      required: opts.value.requiredByDefault,
      multiline: false,
      fontSize: 11,
      options: kind === "dropdown" || kind === "radio" ? "Option one, Option two, Option three" : "",
      defaultValue: "",
      tooltip: "",
    };
    setFields((current) => [...current, field]);
    setSelectedId(field.id);
    setActiveKind("select");
    setError("");
  };

  const beginPlacement = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (activeKind === "select" || !surfaceRef.current) return;
    const point = pagePoint(event.clientX, event.clientY);
    placeRef.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: point.x, y: point.y };
    ghostRef.current = null;
    setGhost(null);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* pointer capture is a convenience, not a requirement */
    }
  };

  const updatePlacement = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = placeRef.current;
    if (!start) return;
    if (Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < 6) return;
    const point = pagePoint(event.clientX, event.clientY);
    const rect = {
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      w: Math.abs(point.x - start.x),
      h: Math.abs(point.y - start.y),
    };
    ghostRef.current = rect;
    setGhost(rect);
  };

  const finishPlacement = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = placeRef.current;
    const drawn = ghostRef.current;
    placeRef.current = null;
    ghostRef.current = null;
    setGhost(null);
    if (!start || activeKind === "select") return;
    event.stopPropagation();
    const size = FIELD_DEFAULTS[activeKind];
    if (drawn && drawn.w >= 14 && drawn.h >= 14) {
      createField(activeKind, drawn);
      return;
    }
    createField(activeKind, {
      x: start.x - size.w / 2,
      y: start.y - size.h / 2,
      w: size.w,
      h: size.h,
    });
  };

  const update = (id: string, patch: Partial<BuilderField>) => {
    setFields((current) => current.map((field) => (field.id === id ? { ...field, ...patch } : field)));
    job.reset();
  };

  const moveField = (id: string, direction: -1 | 1) => {
    setFields((current) => {
      const index = current.findIndex((field) => field.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
    job.reset();
  };

  const cleanedFields = (): BuilderField[] => {
    if (!fields.length) throw new Error("Add at least one field before saving.");
    const cleaned = fields.map((field) => ({
      ...field,
      name:
        field.name
          .replace(/[^A-Za-z0-9_]/g, "_")
          .replace(/^_+|_+$/g, "") || `field_${field.id.slice(-4)}`,
    }));
    const names = cleaned.map((field) => field.name.toLowerCase());
    const duplicate = names.find((name, index) => names.indexOf(name) !== index);
    if (duplicate) throw new Error(`Two fields use the name “${duplicate}”. Give every field a unique name.`);
    const emptyChoice = cleaned.find(
      (field) => (field.kind === "dropdown" || field.kind === "radio") && parseOptions(field.options).length === 0,
    );
    if (emptyChoice) throw new Error(`Add at least one option to “${emptyChoice.name}”.`);
    return cleaned;
  };

  const buildForm = async (cleaned: BuilderField[]): Promise<{ bytes: Uint8Array; pages: number }> => {
    const source = pdf.bytes;
    if (!source) throw new Error("Add a PDF first.");
    const doc = await openPdfLib(source);
    const form = doc.getForm();
    const pages = doc.getPages();
    const border = hexToRgb("#9aa39d");
    const needsLabels = cleaned.some((field) => field.kind === "radio");
    const labelFont = needsLabels ? await doc.embedFont(StandardFonts.Helvetica) : null;
    for (const field of cleaned) {
      const page = pages[field.page];
      if (!page) continue;
      const pageHeight = page.getHeight();
      const box = { x: field.x, y: pageHeight - field.y - field.h, width: field.w, height: field.h };
      const tooltip = field.tooltip.trim();
      if (field.kind === "text" || field.kind === "date") {
        const text = form.createTextField(field.name);
        text.addToPage(page, { ...box, borderWidth: 1, borderColor: border, backgroundColor: hexToRgb("#fbfaf5") });
        text.setFontSize(field.fontSize);
        if (field.multiline || field.h > 34) text.enableMultiline();
        if (field.required) text.enableRequired();
        const hint = tooltip || (field.kind === "date" ? "Date — use YYYY-MM-DD" : "");
        if (hint) text.acroField.dict.set(PDFName.of("TU"), PDFHexString.fromText(hint));
        if (field.defaultValue.trim()) {
          try {
            text.setText(field.defaultValue);
            text.acroField.dict.set(PDFName.of("DV"), PDFHexString.fromText(field.defaultValue));
          } catch {
            /* an unencodable default never blocks the rest of the form */
          }
        }
        if (field.kind === "date") {
          // Acrobat's own date-format script; readers without JavaScript simply show a text box.
          try {
            const action = doc.context.obj({
              Type: "Action",
              S: "JavaScript",
              JS: 'AFDate_FormatEx("yyyy-mm-dd");',
            });
            text.acroField.dict.set(PDFName.of("AA"), doc.context.obj({ F: action }));
          } catch {
            /* optional formatting only */
          }
        }
        continue;
      }
      if (field.kind === "checkbox") {
        const check = form.createCheckBox(field.name);
        check.addToPage(page, { ...box, borderWidth: 1, borderColor: border, backgroundColor: hexToRgb("#ffffff") });
        if (field.required) check.enableRequired();
        if (tooltip) check.acroField.dict.set(PDFName.of("TU"), PDFHexString.fromText(tooltip));
        if (field.defaultValue === "true") check.check();
        continue;
      }
      if (field.kind === "dropdown") {
        const choice = form.createDropdown(field.name);
        choice.addOptions(parseOptions(field.options));
        choice.addToPage(page, { ...box, borderWidth: 1, borderColor: border, backgroundColor: hexToRgb("#fbfaf5") });
        if (field.required) choice.enableRequired();
        if (tooltip) choice.acroField.dict.set(PDFName.of("TU"), PDFHexString.fromText(tooltip));
        if (field.defaultValue && parseOptions(field.options).includes(field.defaultValue)) {
          try {
            choice.select(field.defaultValue);
          } catch {
            /* select only accepts a listed option */
          }
        }
        continue;
      }
      if (field.kind === "radio") {
        const group = form.createRadioGroup(field.name);
        const options = parseOptions(field.options);
        const row = Math.max(12, Math.min(22, field.h / Math.max(1, options.length)));
        options.forEach((option, index) => {
          const top = field.y + index * row;
          group.addOptionToPage(option, page, {
            x: field.x,
            y: pageHeight - top - 12,
            width: 12,
            height: 12,
            borderWidth: 1,
            borderColor: border,
            backgroundColor: hexToRgb("#ffffff"),
          });
          if (labelFont) {
            page.drawText(option.slice(0, 70), {
              x: field.x + 17,
              y: pageHeight - top - 10,
              size: Math.min(10.5, Math.max(7, row - 4)),
              font: labelFont,
              color: hexToRgb("#25352c"),
            });
          }
        });
        if (field.required) group.enableRequired();
        if (tooltip) group.acroField.dict.set(PDFName.of("TU"), PDFHexString.fromText(tooltip));
        if (field.defaultValue && options.includes(field.defaultValue)) {
          try {
            group.select(field.defaultValue);
          } catch {
            /* select only accepts a listed option */
          }
        }
        continue;
      }
      // Signature: a real /Sig widget so readers show a signing area.
      const widget = doc.context.obj({
        Type: "Annot",
        Subtype: "Widget",
        FT: "Sig",
        T: PDFHexString.fromText(field.name),
        TU: PDFHexString.fromText(tooltip || "Signature area"),
        Rect: [box.x, box.y, box.x + box.width, box.y + box.height],
        F: 4,
        MK: { BC: [0.66, 0.69, 0.67] },
        BS: { W: 1, S: "S" },
      });
      const fieldRef = doc.context.register(widget);
      const annots = page.node.Annots();
      if (annots) annots.push(fieldRef);
      else page.node.set(PDFName.of("Annots"), doc.context.obj([fieldRef]));
      form.acroForm.addField(fieldRef);
    }
    const bytes = await doc.save();
    return { bytes, pages: doc.getPageCount() };
  };

  const outputName = () => `${sanitizeName(baseName(pdf.file?.name ?? "document"))}-form.pdf`;

  const save = () => {
    if (!pdf.file) return;
    let cleaned: BuilderField[];
    try {
      cleaned = cleanedFields();
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    setError("");
    void job.run(async ({ report }) => {
      report(25, "Writing form fields into the PDF…");
      const built = await buildForm(cleaned);
      report(90, "Checking the saved form…");
      return { bytes: built.bytes, name: outputName(), pages: built.pages, fields: cleaned.length };
    });
  };

  const previewForm = async () => {
    let cleaned: BuilderField[];
    try {
      cleaned = cleanedFields();
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    setError("");
    setPreviewBusy(true);
    try {
      const built = await buildForm(cleaned);
      setFormPreview({ bytes: built.bytes, name: `${sanitizeName(baseName(pdf.file?.name ?? "document"))}-form-preview.pdf` });
    } catch (err) {
      setError(friendlyProcessingError(err, "The preview couldn’t be built. Try saving instead."));
    } finally {
      setPreviewBusy(false);
    }
  };

  usePrimaryShortcut(save, Boolean(pdf.bytes) && fields.length > 0 && !job.busy);
  useDownloadShortcut(() => {
    if (result) downloadBytes(result.bytes, result.name);
  }, Boolean(result));

  if (!pdf.file) {
    return (
      <div className="space-y-4">
        <FileDrop
          accept="application/pdf,.pdf"
          acceptLabel="The PDF to add fields to"
          sample={SAMPLE.pdf}
          onFiles={(files) => pdf.setFile(files[0])}
        />
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            { title: "Design visually", body: "Click the page to place a field, or drag a rectangle to size it exactly." },
            { title: "Real interactive fields", body: "Saved with proper AcroForm widgets, names, tooltips and options — not drawn boxes." },
            { title: "Test immediately", body: "Preview the fillable result here, then hand it to Fill PDF forms to complete it." },
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
          {FIELD_KINDS.map((entry) => (
            <button
              key={entry.kind}
              type="button"
              aria-pressed={activeKind === entry.kind}
              onClick={() => {
                setActiveKind(entry.kind);
                setSelectedId(null);
              }}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11.5px] font-medium transition-colors",
                activeKind === entry.kind ? "bg-forest text-paper" : "text-ink/70 hover:bg-paper hover:text-ink",
              )}
            >
              <entry.icon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{entry.label}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={pageIndex === 0}
            onClick={() => {
              setPageIndex((index) => index - 1);
              setSelectedId(null);
            }}
            aria-label="Previous page"
          >
            <RotateCw className="h-3.5 w-3.5 -scale-x-100" />
          </Button>
          <span className="min-w-[74px] text-center text-[11.5px] font-medium tabular-nums text-ink/70">
            Page {pageIndex + 1} / {pdf.pageCount}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={pageIndex >= pdf.pageCount - 1}
            onClick={() => {
              setPageIndex((index) => index + 1);
              setSelectedId(null);
            }}
            aria-label="Next page"
          >
            <RotateCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div>
          <p className="mb-2 text-[11.5px] text-muted">
            {activeKind === "select"
              ? "Drag a field to move it, use the corner handle to resize it, or pick a type above to add another."
              : `Click the page to place a ${FIELD_DEFAULTS[activeKind].label.toLowerCase()}, or drag a rectangle to size it.`}
          </p>
          <div className="rounded-xl border border-line bg-bone-deep/50 p-3 sm:p-5">
            <div className="mx-auto w-full max-w-[760px]">
              <div
                ref={surfaceRef}
                onPointerDown={beginPlacement}
                onPointerMove={updatePlacement}
                onPointerUp={finishPlacement}
                className={cn(
                  "relative w-full overflow-hidden rounded-sm bg-white pdf-page-shadow",
                  activeKind !== "select" ? "cursor-crosshair" : "cursor-default",
                )}
                style={{ aspectRatio: `${pageW} / ${pageH}`, touchAction: activeKind === "select" ? undefined : "none" }}
              >
                {preview ? (
                  <img
                    src={preview.dataUrl}
                    alt={`Page ${pageIndex + 1}`}
                    className="pointer-events-none absolute inset-0 h-full w-full object-fill"
                    draggable={false}
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-[12px] text-ink/70">
                    Rendering page…
                  </div>
                )}
                {ghost && (
                  <div
                    className="pointer-events-none absolute rounded border-2 border-dashed border-clay bg-clay/10"
                    style={{ left: ghost.x * scale, top: ghost.y * scale, width: ghost.w * scale, height: ghost.h * scale }}
                  />
                )}
                {pageFields.map((field) => (
                  <div
                    key={field.id}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      setSelectedId(field.id);
                      dragRef.current = {
                        mode: "move",
                        id: field.id,
                        startX: event.clientX,
                        startY: event.clientY,
                        orig: { ...field },
                      };
                    }}
                    className={cn(
                      "absolute flex cursor-move items-center justify-center overflow-hidden border-2 text-[9px] font-semibold",
                      selectedId === field.id
                        ? "border-clay bg-clay/15 text-clay-ink"
                        : "border-forest/60 bg-forest/10 text-forest",
                      field.kind === "checkbox" ? "rounded-sm" : "rounded",
                    )}
                    style={{ left: field.x * scale, top: field.y * scale, width: field.w * scale, height: field.h * scale }}
                    title={`${field.name}${field.required ? " · required" : ""}`}
                  >
                    <span className="truncate px-1">
                      {field.kind === "checkbox"
                        ? "✓"
                        : field.kind === "signature"
                          ? "Sign"
                          : field.kind === "radio"
                            ? "Radio"
                            : field.kind === "date"
                              ? "Date"
                              : field.name}
                    </span>
                    {selectedId === field.id && (
                      <>
                        <button
                          type="button"
                          aria-label="Delete field"
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={() => {
                            setFields((current) => current.filter((entry) => entry.id !== field.id));
                            setSelectedId(null);
                            job.reset();
                          }}
                          className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-ink text-paper"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                        <div
                          onPointerDown={(event) => {
                            event.stopPropagation();
                            dragRef.current = {
                              mode: "resize",
                              id: field.id,
                              startX: event.clientX,
                              startY: event.clientY,
                              orig: { ...field },
                            };
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
            <Button onClick={save} loading={job.busy} disabled={job.busy}>
              <Save className="h-4 w-4" /> Save interactive form
            </Button>
            {job.busy && (
              <Button variant="outline" onClick={job.cancel}>
                Cancel
              </Button>
            )}
            <Button variant="outline" onClick={() => void previewForm()} loading={previewBusy} disabled={!fields.length || previewBusy}>
              <Eye className="h-4 w-4" /> Preview fillable result
            </Button>
            <span className="text-[11.5px] text-muted">
              {fields.length} field{fields.length === 1 ? "" : "s"} · real AcroForm widgets
            </span>
            {fields.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFields([]);
                  setSelectedId(null);
                  job.reset();
                }}
              >
                Clear fields
              </Button>
            )}
          </div>
          {job.busy && <Progress value={job.percent ?? undefined} label={job.label} detail={describeJobTime(job)} />}
          {error && (
            <Alert tone="error" className="mt-3">
              {error}
            </Alert>
          )}
          {job.failed && (
            <Alert tone="error" className="mt-3">
              {job.error}
            </Alert>
          )}
          {rotatedPages > 0 && (
            <Alert tone="info" className="mt-3">
              This PDF has {rotatedPages} rotated page{rotatedPages === 1 ? "" : "s"}. Fields are placed on the unrotated page content,
              which matches the preview above; most readers display them in the same position.
            </Alert>
          )}
        </div>

        <aside className="space-y-3">
          <div className="rounded-xl border border-line bg-paper p-3.5">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">Field properties</p>
            {!selected && (
              <p className="text-[12px] leading-relaxed text-muted">
                Select a field on the page to change its name, default value, tooltip, size or required state.
              </p>
            )}
            {selected && (
              <div className="space-y-3">
                <Field label="Field name" hint="Used by PDF readers and form tools. Letters, numbers and underscores.">
                  <input
                    value={selected.name}
                    onChange={(event) => update(selected.id, { name: event.target.value })}
                    className={inputClass}
                    aria-label="Field name"
                  />
                </Field>
                <Field label="Tooltip" hint="Shown by readers when the field is hovered or focused.">
                  <input
                    value={selected.tooltip}
                    onChange={(event) => update(selected.id, { tooltip: event.target.value })}
                    className={inputClass}
                    maxLength={120}
                    placeholder={selected.kind === "date" ? "Date — use YYYY-MM-DD" : "Optional hint"}
                    aria-label="Tooltip"
                  />
                </Field>
                {(selected.kind === "text" || selected.kind === "date") && (
                  <Field label="Default value" hint="Prefilled when the form is opened.">
                    <input
                      value={selected.defaultValue}
                      onChange={(event) => update(selected.id, { defaultValue: event.target.value })}
                      className={inputClass}
                      aria-label="Default value"
                      placeholder={selected.kind === "date" ? "2025-01-31" : "Empty"}
                    />
                  </Field>
                )}
                {selected.kind === "checkbox" && (
                  <Switch
                    checked={selected.defaultValue === "true"}
                    onChange={(value) => update(selected.id, { defaultValue: value ? "true" : "" })}
                    label="Checked by default"
                    description="Readers open the file with this box ticked"
                  />
                )}
                {(selected.kind === "dropdown" || selected.kind === "radio") && (
                  <>
                    <Field
                      label="Options"
                      hint={
                        selected.kind === "radio"
                          ? "Comma separated. Each option gets its own row inside the box."
                          : "Comma separated"
                      }
                    >
                      <textarea
                        value={selected.options}
                        onChange={(event) => update(selected.id, { options: event.target.value })}
                        rows={3}
                        className={cn(inputClass, "h-auto py-2")}
                        aria-label="Options"
                      />
                    </Field>
                    <Field label="Default choice">
                      <Select
                        value={selected.defaultValue}
                        onChange={(event) => update(selected.id, { defaultValue: event.target.value })}
                        aria-label="Default choice"
                      >
                        <option value="">No default</option>
                        {parseOptions(selected.options).map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </>
                )}
                {selected.kind === "signature" && (
                  <p className="rounded-lg border border-line bg-bone-deep/30 px-2.5 py-2 text-[11px] leading-relaxed text-muted">
                    Signature areas are real PDF signature fields. Sign them with the Sign PDF tool or any desktop reader.
                  </p>
                )}
                {selected.kind === "text" && (
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Font size">
                      <input
                        type="number"
                        min={6}
                        max={24}
                        value={selected.fontSize}
                        onChange={(event) =>
                          update(selected.id, { fontSize: clamp(Number(event.target.value) || 11, 6, 24) })
                        }
                        className={cn(inputClass, "h-9")}
                        aria-label="Font size"
                      />
                    </Field>
                    <Field label="Multiline">
                      <button
                        type="button"
                        onClick={() => update(selected.id, { multiline: !selected.multiline })}
                        aria-pressed={selected.multiline}
                        className={cn(
                          "mt-1 h-9 w-full rounded-lg border text-[12px] font-medium",
                          selected.multiline ? "border-forest bg-forest text-paper" : "border-line bg-paper",
                        )}
                      >
                        {selected.multiline ? "On" : "Off"}
                      </button>
                    </Field>
                  </div>
                )}
                <Switch
                  checked={selected.required}
                  onChange={(value) => update(selected.id, { required: value })}
                  label="Required field"
                  description="Readers mark it as mandatory"
                />
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Width pt">
                    <input
                      type="number"
                      min={12}
                      value={Math.round(selected.w)}
                      onChange={(event) =>
                        update(selected.id, { w: clamp(Number(event.target.value) || 20, 12, pageW - selected.x) })
                      }
                      className={cn(inputClass, "h-9")}
                      aria-label="Field width"
                    />
                  </Field>
                  <Field label="Height pt">
                    <input
                      type="number"
                      min={12}
                      value={Math.round(selected.h)}
                      onChange={(event) =>
                        update(selected.id, { h: clamp(Number(event.target.value) || 20, 12, pageH - selected.y) })
                      }
                      className={cn(inputClass, "h-9")}
                      aria-label="Field height"
                    />
                  </Field>
                </div>
                <Field label="Page" hint={`This PDF has ${pdf.pageCount} pages.`}>
                  <input
                    type="number"
                    min={1}
                    max={pdf.pageCount}
                    value={selected.page + 1}
                    onChange={(event) =>
                      update(selected.id, {
                        page: clamp((Number(event.target.value) || 1) - 1, 0, Math.max(0, pdf.pageCount - 1)),
                      })
                    }
                    className={cn(inputClass, "h-9 tabular-nums")}
                    aria-label="Field page"
                  />
                </Field>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => {
                      const copy: BuilderField = {
                        ...selected,
                        id: uid(),
                        name: `${selected.name}_copy`,
                        x: clamp(selected.x + 12, 0, pageW - selected.w),
                        y: clamp(selected.y + 12, 0, pageH - selected.h),
                      };
                      setFields((current) => [...current, copy]);
                      setSelectedId(copy.id);
                      job.reset();
                    }}
                  >
                    Duplicate
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setFields((current) => current.filter((field) => field.id !== selected.id));
                      setSelectedId(null);
                      job.reset();
                    }}
                    aria-label="Delete the selected field"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-line bg-bone-deep/30 p-3">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">
              All fields · {fields.length}
            </p>
            {fields.length === 0 ? (
              <p className="text-[11.5px] text-muted">Nothing added yet.</p>
            ) : (
              <ul className="space-y-1">
                {fields.map((field, index) => (
                  <li key={field.id}>
                    <div
                      className={cn(
                        "flex items-center gap-1 rounded-lg pr-1",
                        selectedId === field.id ? "bg-forest text-paper" : "hover:bg-paper",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setActiveKind("select");
                          setPageIndex(field.page);
                          setSelectedId(field.id);
                        }}
                        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-[11.5px]"
                      >
                        <span className="shrink-0 text-[9.5px] font-bold tabular-nums opacity-60">{index + 1}</span>
                        <span className="truncate">{field.name}</span>
                        <span className="ml-auto shrink-0 text-[9.5px] opacity-60">
                          {field.kind} · p.{field.page + 1}
                          {field.required ? " · *" : ""}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => moveField(field.id, -1)}
                        disabled={index === 0}
                        aria-label={`Move ${field.name} earlier in the tab order`}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded disabled:opacity-25"
                      >
                        <ChevronUp className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveField(field.id, 1)}
                        disabled={index === fields.length - 1}
                        aria-label={`Move ${field.name} later in the tab order`}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded disabled:opacity-25"
                      >
                        <ChevronDown className="h-3 w-3" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[10.5px] leading-relaxed text-muted">
              The list order is the tab order readers step through.
            </p>
          </div>

          <div className="rounded-xl border border-line bg-paper p-3.5">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">New field defaults</p>
            <Switch
              checked={opts.value.requiredByDefault}
              onChange={(value) => opts.set("requiredByDefault", value)}
              label="Required by default"
              description="Every field added from now on is marked mandatory in the form"
            />
            <button
              type="button"
              onClick={opts.reset}
              className="mt-2 text-[11px] font-medium text-forest hover:underline"
            >
              Reset to the default
            </button>
          </div>

          <div className="rounded-xl border border-forest/15 bg-lime/20 p-3 text-[11px] leading-relaxed text-forest">
            <p className="flex items-center gap-1.5 font-semibold">
              <ShieldCheck className="h-3.5 w-3.5" /> Real, fillable widgets
            </p>
            <p className="mt-1 text-forest/90">
              The saved PDF contains genuine form fields — preview it here, then test it with Fill PDF forms or any desktop reader.
            </p>
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
          description={`${result.fields} field${result.fields === 1 ? "" : "s"} written as AcroForm widgets · open the preview to check the tab order`}
          bytes={result.bytes}
          facts={[
            { label: "Fields", value: String(result.fields) },
            { label: "Required", value: String(fields.filter((field) => field.required).length) },
          ]}
          handoffIds={["fill-forms", "sign", "flatten"]}
        />
      )}

      {formPreview && (
        <OutputPreview
          bytes={formPreview.bytes}
          filename={formPreview.name}
          mime="application/pdf"
          onClose={() => setFormPreview(null)}
          onDownload={() => downloadBytes(formPreview.bytes, formPreview.name)}
        />
      )}
    </div>
  );
}
