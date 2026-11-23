import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Combine,
  Copy,
  Download,
  FileOutput,
  GripVertical,
  Hash,
  Layers,
  LockKeyhole,
  Play,
  Plus,
  RotateCw,
  Scissors,
  ShieldCheck,
  Trash2,
  Upload,
  Workflow as WorkflowIcon,
  X,
} from "lucide-react";
import { PDFName } from "@cantoo/pdf-lib";
import {
  PDFDocument,
  baseName,
  degrees,
  downloadBytes,
  embedFonts,
  formatBytes,
  hexToRgb,
  openPdfLib,
  parseRanges,
  readFileBytes,
  safePdfText,
  sanitizeName,
  zipAndDownload,
} from "@/lib/pdf";
import { flattenPdf, recompressImages } from "@/tools/Optimize";
import { useInitialFiles } from "@/lib/usePdf";
import { Alert, Badge, Button, Field, FileDrop, FileRow, Progress, Segmented, Select, Switch, TextInput } from "@/components/ui";
import { DownloadPanel } from "@/components/toolParts";
import { friendlyProcessingError } from "@/lib/security";
import { SAMPLE } from "@/lib/sample";
import { useToolPreferences } from "@/lib/prefs";
import { JobCancelledError, describeJobTime, useJob } from "@/lib/job";
import { useDownloadShortcut, usePrimaryShortcut } from "@/lib/hotkeys";
import { downloadOutput } from "@/lib/output";
import { FREE_BATCH_LIMIT, FREE_WORKFLOW_LIMIT, ProBadge, usePro } from "@/lib/pro";
import { deleteWorkflow, listWorkflows, saveWorkflow, type SavedWorkflow } from "@/lib/workflows";

/* ================================================================== *
 * PDF WORKFLOW — chain several operations over one or many PDFs
 * ================================================================== */
type StepKind = "rotate" | "remove" | "extract" | "watermark" | "numbers" | "compress" | "flatten" | "sanitize";
type Level = "light" | "balanced" | "strong";

interface Step {
  id: string;
  kind: StepKind;
  angle: 90 | 180 | 270;
  range: string;
  text: string;
  opacity: number;
  size: number;
  position: "bottom" | "top";
  start: number;
  level: Level;
  /** JPEG quality used by the flatten step (0.4–0.95). */
  quality: number;
  /** Sanitise: remove document metadata / XMP. */
  stripMeta: boolean;
  /** Sanitise: remove open actions, scripts and form definitions. */
  stripActions: boolean;
  /** Sanitise: remove page annotations and comments. */
  stripAnnots: boolean;
}

const MAX_FILES = 20;
const MAX_STEPS = 10;

const COMPRESSION_LEVELS: Record<Level, { quality: number; maxDimension: number; label: string }> = {
  light: { quality: 0.82, maxDimension: 2600, label: "Light" },
  balanced: { quality: 0.66, maxDimension: 2000, label: "Balanced" },
  strong: { quality: 0.45, maxDimension: 1400, label: "Strong" },
};

const STEP_META: Record<StepKind, { label: string; icon: typeof RotateCw; hint: string }> = {
  rotate: { label: "Rotate pages", icon: RotateCw, hint: "Turn every page by a fixed angle." },
  remove: { label: "Remove pages", icon: Trash2, hint: "Drop the page ranges you don’t need." },
  extract: { label: "Extract pages", icon: Scissors, hint: "Keep only the ranges you choose." },
  watermark: { label: "Add watermark", icon: WorkflowIcon, hint: "Stamp diagonal text across every page." },
  numbers: { label: "Page numbers", icon: Hash, hint: "Number the kept pages automatically." },
  flatten: { label: "Flatten to images", icon: Layers, hint: "Rasterise each page, so nothing hidden survives." },
  sanitize: { label: "Sanitise", icon: ShieldCheck, hint: "Strip metadata, scripts and annotations." },
  compress: { label: "Compress", icon: FileOutput, hint: "Re-encode images after the structural work." },
};

const STEP_ORDER: StepKind[] = ["rotate", "remove", "extract", "watermark", "numbers", "flatten", "sanitize", "compress"];

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function newStep(kind: StepKind): Step {
  return {
    id: uid(),
    kind,
    angle: 90,
    range: "",
    text: kind === "watermark" ? "CONFIDENTIAL" : "",
    opacity: 0.18,
    size: 44,
    position: "bottom",
    start: 1,
    level: "balanced",
    quality: 0.72,
    stripMeta: true,
    stripActions: true,
    stripAnnots: false,
  };
}

const hasTextStep = (steps: Step[]) => steps.some((step) => step.kind === "watermark" || step.kind === "numbers");

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function describeStep(step: Step): string {
  switch (step.kind) {
    case "rotate":
      return `${step.angle}° ${step.angle === 180 ? "turn" : "rotation"}`;
    case "remove":
      return step.range.trim() ? `Remove ${step.range.trim()}` : "No range set — nothing removed";
    case "extract":
      return step.range.trim() ? `Keep ${step.range.trim()}` : "No range set — every page kept";
    case "watermark":
      return step.text.trim() ? `“${step.text.trim()}” at ${Math.round(step.opacity * 100)}%` : "No text set";
    case "numbers":
      return `Starts at ${step.start} · ${step.position === "top" ? "top" : "bottom"}`;
    case "compress":
      return `${COMPRESSION_LEVELS[step.level].label} image re-encoding`;
    case "flatten":
      return `${Math.round(step.quality * 100)}% JPEG, 1600 px wide`;
    case "sanitize":
      return (
        [step.stripMeta ? "metadata" : "", step.stripActions ? "actions and scripts" : "", step.stripAnnots ? "annotations" : ""]
          .filter(Boolean)
          .join(" · ") || "Nothing selected"
      );
  }
}

async function drawOverlays(doc: PDFDocument, steps: Step[]) {
  const watermark = [...steps].reverse().find((step) => step.kind === "watermark");
  const numbers = [...steps].reverse().find((step) => step.kind === "numbers");
  if (!watermark && !numbers) return;
  const fonts = await embedFonts(doc);
  const pages = doc.getPages();
  pages.forEach((page, index) => {
    const { width, height } = page.getSize();
    if (watermark?.text.trim()) {
      const text = safePdfText(watermark.text.trim());
      const size = watermark.size;
      const textWidth = fonts.bold.widthOfTextAtSize(text, size);
      page.drawText(text, {
        x: Math.max(12, (width - textWidth) / 2),
        y: Math.max(12, height / 2 - size / 2),
        size,
        font: fonts.bold,
        color: hexToRgb("#8b1e1e"),
        opacity: Math.min(1, Math.max(0.05, watermark.opacity)),
        rotate: degrees(45),
      });
    }
    if (numbers && index + 1 >= (numbers.start || 1)) {
      const label = safePdfText(`Page ${index + 1} of ${pages.length}`);
      const textWidth = fonts.regular.widthOfTextAtSize(label, 10);
      const y = numbers.position === "top" ? height - 24 : 20;
      page.drawText(label, {
        x: (width - textWidth) / 2,
        y,
        size: 10,
        font: fonts.regular,
        color: hexToRgb("#3b4a42"),
        opacity: 0.85,
      });
    }
  });
}

/** Strip metadata, scripts and annotations according to the step settings. */
async function sanitizeOutput(bytes: Uint8Array, step: Step): Promise<Uint8Array> {
  const doc = await openPdfLib(bytes);
  const catalog = doc.catalog;
  if (step.stripMeta) {
    for (const key of ["Metadata", "PieceInfo", "MarkInfo", "StructTreeRoot"]) {
      try {
        catalog.delete(PDFName.of(key));
      } catch {
        /* unusual catalog entries are ignored */
      }
    }
    try {
      doc.setTitle("");
      doc.setAuthor("");
      doc.setSubject("");
      doc.setKeywords([]);
    } catch {
      /* the information dictionary is optional */
    }
  }
  if (step.stripActions) {
    for (const key of ["OpenAction", "AA", "Names", "Perms", "AcroForm"]) {
      try {
        catalog.delete(PDFName.of(key));
      } catch {
        /* ignore */
      }
    }
  }
  if (step.stripAnnots) {
    for (const page of doc.getPages()) {
      try {
        page.node.delete(PDFName.of("Annots"));
      } catch {
        /* a page without annotations needs no change */
      }
    }
  }
  try {
    doc.setProducer("Paperly · sanitised copy");
    doc.setCreator("Paperly");
  } catch {
    /* ignore */
  }
  return doc.save({ useObjectStreams: true });
}

/** Apply the pipeline to one PDF and return the new bytes. */
async function runPipeline(
  bytes: ArrayBuffer,
  steps: Step[],
  onPhase: (label: string, value: number) => void,
  isCancelled: () => boolean,
): Promise<Uint8Array> {
  const check = () => {
    if (isCancelled()) throw new JobCancelledError();
  };
  const structural = steps.filter((step) => step.kind === "rotate" || step.kind === "remove" || step.kind === "extract");
  const compress = [...steps].reverse().find((step) => step.kind === "compress");
  const flatten = [...steps].reverse().find((step) => step.kind === "flatten");
  const sanitize = [...steps].reverse().find((step) => step.kind === "sanitize");
  let out: Uint8Array;

  if (structural.length || hasTextStep(steps)) {
    onPhase("Rebuilding the document structure…", 20);
    check();
    const source = await openPdfLib(bytes);
    const total = source.getPageCount();
    if (total > 1000) throw new Error("This workflow supports PDFs up to 1,000 pages per file. Split the file first.");

    let keep = source.getPageIndices();
    const extract = structural.find((step) => step.kind === "extract");
    if (extract?.range.trim()) keep = parseRanges(extract.range, total).map((page) => page - 1);
    for (const step of structural.filter((item) => item.kind === "remove")) {
      if (!step.range.trim()) continue;
      const drop = new Set(parseRanges(step.range, total).map((page) => page - 1));
      keep = keep.filter((index) => !drop.has(index));
    }
    if (!keep.length) throw new Error("Your pipeline removed every page. Leave at least one page in the output.");

    const rotate = [...structural].reverse().find((step) => step.kind === "rotate");
    const target = await PDFDocument.create();
    const copied = await target.copyPages(source, keep);
    copied.forEach((page) => {
      if (rotate) page.setRotation(degrees(((page.getRotation().angle + rotate.angle) % 360)));
      target.addPage(page);
    });
    await drawOverlays(target, steps);
    check();
    onPhase("Saving the rebuilt PDF…", 46);
    out = await target.save({ useObjectStreams: true });
  } else {
    const doc = await openPdfLib(bytes);
    await drawOverlays(doc, steps);
    out = await doc.save({ useObjectStreams: true });
  }

  check();
  if (flatten) {
    onPhase("Rasterising pages into images…", 56);
    out = await flattenPdf(
      toArrayBuffer(out),
      { targetWidth: 1600, quality: Math.min(0.95, Math.max(0.4, flatten.quality)) },
      (value) => onPhase("Rasterising pages into images…", 56 + (value / 100) * 8),
    );
    check();
  }
  if (sanitize) {
    onPhase("Removing metadata, scripts and annotations…", 68);
    out = await sanitizeOutput(out, sanitize);
    check();
  }
  if (compress) {
    onPhase("Compressing embedded images…", 80);
    const config = COMPRESSION_LEVELS[compress.level];
    const result = await recompressImages(toArrayBuffer(out), config, () => undefined);
    if (result.bytes.byteLength < out.byteLength) out = result.bytes;
    check();
  }
  onPhase("Done", 100);
  return out;
}

/* ------------------------------------------------------------------ *
 * Pipeline files (save / load)
 * ------------------------------------------------------------------ */
interface PipelineFileDocument {
  application: "paperly";
  version: 1;
  kind: "workflow-pipeline";
  savedAt: string;
  merge: boolean;
  steps: Partial<Step>[];
}

function normalizeStep(raw: Partial<Step>, index: number): Step {
  const kind = STEP_ORDER.find((entry) => entry === raw.kind);
  if (!kind) throw new Error(`Step ${index + 1} uses an operation Paperly doesn’t have.`);
  const base = newStep(kind);
  const number = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  return {
    ...base,
    angle: raw.angle === 180 || raw.angle === 270 ? raw.angle : 90,
    range: typeof raw.range === "string" ? raw.range.slice(0, 120) : "",
    text: typeof raw.text === "string" ? raw.text.slice(0, 80) : base.text,
    opacity: number(raw.opacity, base.opacity, 0.05, 0.6),
    size: number(raw.size, base.size, 12, 72),
    position: raw.position === "top" ? "top" : "bottom",
    start: Math.round(number(raw.start, 1, 1, 5000)),
    level: raw.level === "light" || raw.level === "strong" ? raw.level : "balanced",
    quality: number(raw.quality, base.quality, 0.4, 0.95),
    stripMeta: raw.stripMeta !== false,
    stripActions: raw.stripActions !== false,
    stripAnnots: raw.stripAnnots === true,
  };
}

interface DryRunRow {
  label: string;
  detail: string;
  pagesIn: number;
  pagesOut: number;
  note: string;
}

interface DryRunResult {
  rows: DryRunRow[];
  pagesIn: number;
  pagesOut: number;
  perFile: number[];
  counts: number[];
}

interface WorkflowResult {
  bytes: Uint8Array;
  name: string;
  count: number;
  merged: boolean;
  zip: boolean;
  steps: number;
  totalPages: number;
  signature: string;
}

const WORKFLOW_DEFAULTS = { merge: false };

export function WorkflowTool() {
  const initial = useInitialFiles();
  const pro = usePro();
  const opts = useToolPreferences("workflow", WORKFLOW_DEFAULTS);
  const [files, setFiles] = useState<File[]>(() => initial.slice(0, pro.isPro ? MAX_FILES : FREE_BATCH_LIMIT));
  const [steps, setSteps] = useState<Step[]>([]);
  const [password, setPassword] = useState("");
  const [inputError, setInputError] = useState("");
  const [dry, setDry] = useState<DryRunResult | null>(null);
  const [dryBusy, setDryBusy] = useState(false);
  const [dryError, setDryError] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const pageCounts = useRef(new Map<string, number>());
  const loadRef = useRef<HTMLInputElement | null>(null);
  const job = useJob<WorkflowResult>();
  const [saved, setSaved] = useState<SavedWorkflow[]>(() => listWorkflows());
  const [workflowName, setWorkflowName] = useState("");
  const [savedNotice, setSavedNotice] = useState("");
  const [autoRunId, setAutoRunId] = useState<string | null>(null);
  const runRef = useRef<() => void>(() => undefined);

  const merge = opts.value.merge;
  const signature = JSON.stringify({
    steps: steps.map((step) => ({ ...step, id: undefined })),
    files: files.map((file) => `${file.name}:${file.size}:${file.lastModified}`),
    merge,
    encrypted: password.length > 0,
  });

  useEffect(() => {
    setDry(null);
  }, [files, steps]);

  const patch = (id: string, changes: Partial<Step>) => {
    setSteps((current) => current.map((step) => (step.id === id ? { ...step, ...changes } : step)));
  };

  const move = (index: number, direction: -1 | 1) => {
    setSteps((current) => {
      const next = [...current];
      const swap = index + direction;
      if (swap < 0 || swap >= next.length) return current;
      [next[index], next[swap]] = [next[swap], next[index]];
      return next;
    });
  };

  const moveTo = (from: number, to: number) => {
    setSteps((current) => {
      if (from === to || from < 0 || to < 0 || from >= current.length || to >= current.length) return current;
      const next = [...current];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  };

  const duplicate = (id: string) => {
    setSteps((current) => {
      if (current.length >= MAX_STEPS) return current;
      const index = current.findIndex((step) => step.id === id);
      if (index < 0) return current;
      const copy: Step = { ...current[index], id: uid() };
      return [...current.slice(0, index + 1), copy, ...current.slice(index + 1)];
    });
  };

  const addFiles = (incoming: File[]) => {
    const pdfs = incoming.filter((file) => /\.pdf$/i.test(file.name) || file.type === "application/pdf");
    const cap = pro.isPro ? MAX_FILES : FREE_BATCH_LIMIT;
    if (files.length + pdfs.length > cap) {
      pro.openUpgrade(
        pro.isPro
          ? `A workflow runs up to ${MAX_FILES} PDFs at once.`
          : `Workflows over ${FREE_BATCH_LIMIT} files are part of Paperly Pro. Every single-file tool remains free.`,
      );
    }
    setFiles([...files, ...pdfs].slice(0, cap));
  };

  const refreshSaved = () => setSaved(listWorkflows());

  const saveNamedWorkflow = () => {
    if (steps.length < 2) {
      setInputError("A reusable workflow needs at least 2 steps. Add another operation first.");
      return;
    }
    const existing = saved.find((entry) => entry.name.toLowerCase() === workflowName.trim().toLowerCase());
    if (!existing && !pro.isPro && saved.length >= FREE_WORKFLOW_LIMIT) {
      pro.openUpgrade(`Saving more than ${FREE_WORKFLOW_LIMIT} custom workflow pipeline${FREE_WORKFLOW_LIMIT === 1 ? "" : "s"} is part of Paperly Pro.`);
      return;
    }
    const record = saveWorkflow({
      id: existing?.id,
      name: workflowName.trim() || `Workflow ${saved.length + 1}`,
      merge,
      steps: steps.map((step) => ({ ...step, id: undefined })),
    });
    if (!record) {
      setInputError("This browser blocked local storage, so the workflow couldn’t be saved.");
      return;
    }
    refreshSaved();
    setWorkflowName(record.name);
    setInputError("");
    setSavedNotice(`Saved “${record.name}” to this browser. It never leaves your device.`);
  };

  const loadNamedWorkflow = (entry: SavedWorkflow, runNow = false) => {
    try {
      const loaded = entry.steps.slice(0, MAX_STEPS).map((raw, index) => normalizeStep((raw ?? {}) as Partial<Step>, index));
      if (!loaded.length) throw new Error("That workflow has no steps.");
      setSteps(loaded);
      opts.set("merge", entry.merge);
      setWorkflowName(entry.name);
      setSavedNotice("");
      setInputError("");
      if (runNow) setAutoRunId(entry.id);
    } catch (err) {
      setInputError(friendlyProcessingError(err, "That saved workflow couldn’t be loaded."));
    }
  };

  const removeNamedWorkflow = (entry: SavedWorkflow) => {
    deleteWorkflow(entry.id);
    refreshSaved();
    setSavedNotice(`Deleted “${entry.name}” from this browser.`);
  };

  const savePipeline = () => {
    if (!steps.length) {
      setInputError("Add at least one step before saving a pipeline.");
      return;
    }
    const payload: PipelineFileDocument = {
      application: "paperly",
      version: 1,
      kind: "workflow-pipeline",
      savedAt: new Date().toISOString(),
      merge,
      steps: steps.map((step) => ({ ...step, id: undefined })),
    };
    downloadBytes(
      new Uint8Array(new TextEncoder().encode(`${JSON.stringify(payload, null, 2)}\n`)),
      "paperly-pipeline.json",
      "application/json",
    );
    setInputError("");
  };

  const loadPipeline = async (file: File) => {
    setInputError("");
    try {
      const raw = JSON.parse(await file.text()) as Partial<PipelineFileDocument> & { steps?: unknown };
      const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
      if (!rawSteps.length) throw new Error("That file doesn’t contain any pipeline steps.");
      const loaded = rawSteps.slice(0, MAX_STEPS).map((entry, index) => normalizeStep((entry ?? {}) as Partial<Step>, index));
      setSteps(loaded);
      if (typeof raw.merge === "boolean") opts.set("merge", raw.merge);
      setDry(null);
    } catch (err) {
      setInputError(friendlyProcessingError(err, "That JSON file isn’t a Paperly pipeline."));
    }
  };

  const currentPageCount = async (file: File) => {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    const cached = pageCounts.current.get(key);
    if (cached !== undefined) return cached;
    const doc = await openPdfLib(await readFileBytes(file));
    const count = doc.getPageCount();
    pageCounts.current.set(key, count);
    return count;
  };

  const runDry = async () => {
    if (!files.length) {
      setDryError("Add at least one PDF to plan a workflow.");
      return;
    }
    if (!steps.length) {
      setDryError("Add at least one step to plan a workflow.");
      return;
    }
    setDryBusy(true);
    setDryError("");
    try {
      const counts: number[] = [];
      for (const file of files) counts.push(await currentPageCount(file));
      const kept = counts.map((count) => new Set(Array.from({ length: count }, (_, index) => index)));
      const pagesIn = counts.reduce((sum, count) => sum + count, 0);
      const rows: DryRunRow[] = [];
      for (const step of steps) {
        const before = kept.reduce((sum, set) => sum + set.size, 0);
        let note = "";
        if (step.kind === "extract") {
          if (!step.range.trim()) note = "No range set — every page is kept.";
          else {
            counts.forEach((count, index) => {
              try {
                kept[index] = new Set(parseRanges(step.range, count).map((page) => page - 1));
              } catch {
                note = "That range doesn’t fit these files, so the step is skipped.";
              }
            });
          }
        } else if (step.kind === "remove") {
          if (!step.range.trim()) note = "No range set — nothing is removed.";
          else {
            counts.forEach((count, index) => {
              try {
                for (const page of parseRanges(step.range, count)) kept[index].delete(page - 1);
              } catch {
                note = "That range doesn’t fit these files, so the step is skipped.";
              }
            });
          }
        }
        const after = kept.reduce((sum, set) => sum + set.size, 0);
        if (after === 0) note = note || "This step would remove every page.";
        rows.push({ label: STEP_META[step.kind].label, detail: describeStep(step), pagesIn: before, pagesOut: after, note });
      }
      setDry({
        rows,
        pagesIn,
        pagesOut: kept.reduce((sum, set) => sum + set.size, 0),
        perFile: kept.map((set) => set.size),
        counts,
      });
    } catch (err) {
      setDryError(friendlyProcessingError(err, "The dry run couldn’t read these files."));
    } finally {
      setDryBusy(false);
    }
  };

  const run = () =>
    job.run(async (reporter) => {
      if (!files.length) throw new Error("Add at least one PDF to start a workflow.");
      if (!steps.length) throw new Error("Add at least one step to your workflow.");
      if (password && password.length < 4) throw new Error("Use at least 4 characters for the password, or leave it empty.");

      const outputs: { name: string; bytes: Uint8Array }[] = [];
      let totalPages = 0;
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        reporter.report(4 + (index / files.length) * 76, `Processing ${file.name}…`, `${index + 1} of ${files.length}`);
        if (reporter.cancelled) throw new JobCancelledError();
        const bytes = await readFileBytes(file);
        const processed = await runPipeline(
          bytes,
          steps,
          (label, value) => {
            reporter.report(
              4 + (index / files.length) * 76 + (value / 100) * (76 / files.length),
              `${file.name} · ${label}`,
              `File ${index + 1} of ${files.length}`,
            );
          },
          () => reporter.cancelled,
        );
        try {
          totalPages += (await openPdfLib(processed)).getPageCount();
        } catch {
          /* page count is informational only */
        }
        outputs.push({ name: `${sanitizeName(baseName(file.name))}-workflow.pdf`, bytes: processed });
      }

      if (reporter.cancelled) throw new JobCancelledError();
      let finalBytes: Uint8Array;
      let finalName: string;
      let merged = false;
      if (merge && outputs.length > 1) {
        reporter.report(84, "Merging every result into one document…");
        const combined = await PDFDocument.create();
        for (const output of outputs) {
          const source = await openPdfLib(output.bytes);
          const copied = await combined.copyPages(source, source.getPageIndices());
          copied.forEach((page) => combined.addPage(page));
        }
        finalBytes = await combined.save({ useObjectStreams: true });
        finalName = `${sanitizeName(baseName(files[0].name))}-workflow.pdf`;
        merged = true;
        totalPages = combined.getPageCount();
      } else if (merge) {
        finalBytes = outputs[0].bytes;
        finalName = outputs[0].name;
        merged = true;
      } else {
        finalBytes = new Uint8Array();
        finalName = "";
      }

      if (password) {
        reporter.report(92, "Encrypting the output with AES-256…");
        const targets = merged ? [{ name: finalName, bytes: finalBytes }] : outputs;
        for (const target of targets) {
          const doc = await openPdfLib(target.bytes);
          doc.encrypt({ userPassword: password, ownerPassword: password, permissions: { printing: "highResolution" } });
          target.bytes = await doc.save();
        }
        if (merged) finalBytes = targets[0].bytes;
      }

      if (reporter.cancelled) throw new JobCancelledError();
      if (!merged) {
        await zipAndDownload(
          outputs.map((output) => ({ name: output.name, data: output.bytes })),
          "paperly-workflow.zip",
        );
      }
      return {
        bytes: finalBytes,
        name: merged ? finalName : "paperly-workflow.zip",
        count: outputs.length,
        merged,
        zip: !merged,
        steps: steps.length,
        totalPages,
        signature,
      };
    });

  const result = job.result;
  const fresh = Boolean(result) && result?.signature === signature;
  runRef.current = () => void run();
  usePrimaryShortcut(() => void run(), Boolean(files.length) && Boolean(steps.length) && !job.busy);
  useEffect(() => {
    if (!autoRunId) return;
    if (!files.length || !steps.length) {
      setAutoRunId(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setAutoRunId(null);
      runRef.current();
    }, 120);
    return () => window.clearTimeout(timer);
  }, [autoRunId, files.length, steps.length]);
  useDownloadShortcut(
    () => {
      if (result?.merged) downloadOutput(result.bytes, result.name, "application/pdf");
    },
    fresh && Boolean(result?.merged),
  );

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-forest/15 bg-lime/25 p-3.5 text-[11.5px] leading-relaxed text-forest">
        <p className="flex items-center gap-1.5 font-semibold">
          <WorkflowIcon className="h-4 w-4" /> One pipeline, every file
        </p>
        <p className="mt-1 text-ink/75">
          Chain up to {MAX_STEPS} operations and run them across up to {MAX_FILES} PDFs in one pass — rotate, trim, watermark, number, flatten,
          sanitise, compress, merge and encrypt. The whole recipe runs locally, once. Steps always run in this order: page selection, overlays,
          flatten, sanitise, compression.
        </p>
      </div>

      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink/75">1 · Input files</p>
        {files.length === 0 ? (
          <FileDrop
            accept="application/pdf,.pdf"
            acceptLabel="PDF files to process"
            multiple
            onFiles={addFiles}
            sample={SAMPLE.pdf}
            hint={`Up to ${MAX_FILES} PDFs, processed in this tab only.`}
          />
        ) : (
          <div className="space-y-2">
            {files.map((file, index) => (
              <FileRow
                key={`${file.name}-${index}`}
                file={file}
                onRemove={() => setFiles((current) => current.filter((_, i) => i !== index))}
                size={formatBytes(file.size)}
              />
            ))}
            {files.length < MAX_FILES && (
              <label className="flex cursor-pointer items-center gap-1.5 text-[12px] font-medium text-forest">
                <Plus className="h-3.5 w-3.5" /> Add more PDFs ({files.length}/{MAX_FILES})
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  multiple
                  className="sr-only"
                  onChange={(event) => {
                    addFiles(Array.from(event.target.files ?? []));
                    event.target.value = "";
                  }}
                />
              </label>
            )}
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink/75">2 · Pipeline</p>
            <Badge tone="forest">
              {steps.length} step{steps.length === 1 ? "" : "s"}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => void runDry()}
              disabled={dryBusy || job.busy || !steps.length || !files.length}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-line bg-paper px-2 text-[11px] font-medium text-ink/70 transition-colors hover:border-forest/35 hover:text-forest disabled:opacity-40"
            >
              <Play className="h-3 w-3" /> {dryBusy ? "Planning…" : "Dry run"}
            </button>
            <button
              type="button"
              onClick={savePipeline}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-line bg-paper px-2 text-[11px] font-medium text-ink/70 transition-colors hover:border-forest/35 hover:text-forest"
            >
              <Download className="h-3 w-3" /> Save JSON
            </button>
            <button
              type="button"
              onClick={() => loadRef.current?.click()}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-line bg-paper px-2 text-[11px] font-medium text-ink/70 transition-colors hover:border-forest/35 hover:text-forest"
            >
              <Upload className="h-3 w-3" /> Load JSON
            </button>
            <input
              ref={loadRef}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              aria-label="Load a saved pipeline"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void loadPipeline(file);
              }}
            />
            {steps.length > 0 && (
              <button
                type="button"
                onClick={() => setSteps([])}
                className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-ink/60 transition-colors hover:text-clay-ink"
              >
                <X className="h-3 w-3" /> Clear
              </button>
            )}
          </div>
        </div>
        <div className="mb-3 rounded-xl border border-line bg-bone/40 p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="flex items-center gap-1 text-[10.5px] font-bold uppercase tracking-[0.08em] text-ink/70">
              <WorkflowIcon className="h-3 w-3 text-forest" /> Saved workflows
              {!pro.isPro && <ProBadge />}
            </p>
            <span className="ml-auto font-mono text-[10px] text-ink/60">
              {saved.length}/{pro.isPro ? "∞" : FREE_WORKFLOW_LIMIT}
            </span>
          </div>
          {saved.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {saved.map((entry) => (
                <span key={entry.id} className="inline-flex items-center gap-1 rounded-lg border border-line bg-paper py-1 pl-2 pr-1 text-[11px] font-medium">
                  <button type="button" onClick={() => loadNamedWorkflow(entry)} className="max-w-[150px] truncate hover:text-forest" title={`Load ${entry.name}`}>
                    {entry.name}
                  </button>
                  <button
                    type="button"
                    aria-label={`Run ${entry.name}`}
                    title="Load and run now"
                    onClick={() => loadNamedWorkflow(entry, true)}
                    disabled={!files.length}
                    className="rounded p-0.5 text-forest hover:bg-lime/30 disabled:opacity-30"
                  >
                    <Play className="h-3 w-3" />
                  </button>
                  <button type="button" aria-label={`Delete ${entry.name}`} title="Delete" onClick={() => removeNamedWorkflow(entry)} className="rounded p-0.5 text-ink/50 hover:bg-clay/10 hover:text-clay-ink">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <input
              value={workflowName}
              onChange={(event) => { setWorkflowName(event.target.value.slice(0, 80)); setSavedNotice(""); }}
              placeholder="Name this workflow (e.g. Merge → OCR → Compress)"
              aria-label="Workflow name"
              className="h-8 min-w-[180px] flex-1 rounded-lg border border-line bg-paper px-2.5 text-[11.5px] text-ink placeholder:text-ink/40 focus:border-forest/40 focus:outline-none"
            />
            <button
              type="button"
              onClick={saveNamedWorkflow}
              className="inline-flex h-8 items-center gap-1 rounded-lg bg-forest px-2.5 text-[11px] font-semibold text-paper"
            >
              <Plus className="h-3 w-3" /> Save workflow
            </button>
          </div>
          {savedNotice && <p className="mt-1.5 text-[10.5px] font-medium text-forest">{savedNotice}</p>}
          <p className="mt-1.5 text-[10px] leading-relaxed text-muted">
            Saved macros live in this browser only. Files and passwords are never stored — load a macro, drop files, and press Run.
          </p>
        </div>

        <div className="mb-2 flex flex-wrap gap-1.5">
          {STEP_ORDER.map((kind) => {
            const meta = STEP_META[kind];
            const Icon = meta.icon;
            return (
              <button
                key={kind}
                type="button"
                title={meta.hint}
                disabled={steps.length >= MAX_STEPS}
                onClick={() => setSteps((current) => [...current, newStep(kind)])}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-paper px-2.5 text-[11.5px] font-medium text-ink/75 transition-colors hover:border-forest/30 hover:text-forest disabled:opacity-40"
              >
                <Icon className="h-3.5 w-3.5" /> {meta.label}
              </button>
            );
          })}
        </div>
        {inputError && (
          <p role="alert" className="mb-2 text-[11px] font-medium text-clay-ink">
            {inputError}
          </p>
        )}

        {steps.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line bg-bone-deep/25 px-3 py-4 text-[12px] text-muted">
            Add the operations above in the order they should run. Example: rotate → remove pages → watermark → compress.
          </p>
        ) : (
          <ol className="space-y-2">
            {steps.map((step, index) => {
              const meta = STEP_META[step.kind];
              const Icon = meta.icon;
              return (
                <li
                  key={step.id}
                  className={
                    dropIndex === index && dragIndex !== null && dragIndex !== index
                      ? "rounded-xl border border-forest/50 bg-lime/10 p-3"
                      : "rounded-xl border border-line bg-paper p-3"
                  }
                >
                  <div
                    className="flex items-center gap-2"
                    draggable
                    onDragStart={(event) => {
                      setDragIndex(index);
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(event) => {
                      if (dragIndex === null) return;
                      event.preventDefault();
                      setDropIndex(index);
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (dragIndex !== null) moveTo(dragIndex, index);
                      setDragIndex(null);
                      setDropIndex(null);
                    }}
                    onDragEnd={() => {
                      setDragIndex(null);
                      setDropIndex(null);
                    }}
                  >
                    <span
                      aria-hidden="true"
                      title="Drag to reorder"
                      className="cursor-grab text-ink/40 active:cursor-grabbing"
                    >
                      <GripVertical className="h-3.5 w-3.5" />
                    </span>
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-forest text-[10px] font-bold text-lime">{index + 1}</span>
                    <Icon className="h-3.5 w-3.5 text-forest" />
                    <p className="text-[12.5px] font-semibold">{meta.label}</p>
                    <span className="ml-auto flex items-center gap-0.5">
                      <Button variant="ghost" size="sm" aria-label="Move step up" disabled={index === 0} onClick={() => move(index, -1)}>
                        <ArrowUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="sm" aria-label="Move step down" disabled={index === steps.length - 1} onClick={() => move(index, 1)}>
                        <ArrowDown className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="sm" aria-label="Duplicate step" disabled={steps.length >= MAX_STEPS} onClick={() => duplicate(step.id)}>
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="Remove step"
                        onClick={() => setSteps((current) => current.filter((item) => item.id !== step.id))}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </span>
                  </div>

                  <div className="mt-2.5">
                    {step.kind === "rotate" && (
                      <Segmented
                        value={String(step.angle)}
                        onChange={(value) => patch(step.id, { angle: Number(value) as Step["angle"] })}
                        options={[
                          { value: "90", label: "90° right" },
                          { value: "180", label: "180°" },
                          { value: "270", label: "90° left" },
                        ]}
                      />
                    )}
                    {(step.kind === "remove" || step.kind === "extract") && (
                      <Field label={step.kind === "remove" ? "Pages to remove" : "Pages to keep"} hint="Ranges like 1-2, 5, 8-10. Leave empty for all pages.">
                        <TextInput
                          value={step.range}
                          placeholder="e.g. 1-2, 7"
                          onChange={(event) => patch(step.id, { range: event.target.value })}
                        />
                      </Field>
                    )}
                    {step.kind === "watermark" && (
                      <div className="grid gap-2 sm:grid-cols-[1fr_120px]">
                        <Field label="Watermark text">
                          <TextInput
                            value={step.text}
                            maxLength={80}
                            placeholder="CONFIDENTIAL"
                            onChange={(event) => patch(step.id, { text: event.target.value })}
                          />
                        </Field>
                        <Field label="Opacity" hint={`${Math.round(step.opacity * 100)}%`}>
                          <input
                            type="range"
                            min={5}
                            max={60}
                            value={Math.round(step.opacity * 100)}
                            onChange={(event) => patch(step.id, { opacity: Number(event.target.value) / 100 })}
                            className="w-full accent-forest"
                          />
                        </Field>
                      </div>
                    )}
                    {step.kind === "numbers" && (
                      <div className="grid gap-2 sm:grid-cols-2">
                        <Field label="Start numbering at">
                          <TextInput
                            type="number"
                            min={1}
                            value={step.start}
                            onChange={(event) => patch(step.id, { start: Math.max(1, Number(event.target.value) || 1) })}
                          />
                        </Field>
                        <Field label="Position">
                          <Select value={step.position} onChange={(event) => patch(step.id, { position: event.target.value as Step["position"] })}>
                            <option value="bottom">Bottom of page</option>
                            <option value="top">Top of page</option>
                          </Select>
                        </Field>
                      </div>
                    )}
                    {step.kind === "compress" && (
                      <Segmented
                        value={step.level}
                        onChange={(value) => patch(step.id, { level: value })}
                        options={(["light", "balanced", "strong"] as Level[]).map((level) => ({
                          value: level,
                          label: COMPRESSION_LEVELS[level].label,
                        }))}
                      />
                    )}
                    {step.kind === "flatten" && (
                      <div className="grid gap-2 sm:grid-cols-2">
                        <Field label={`JPEG quality · ${Math.round(step.quality * 100)}%`}>
                          <input
                            type="range"
                            min={40}
                            max={95}
                            value={Math.round(step.quality * 100)}
                            aria-label="Flatten JPEG quality"
                            onChange={(event) => patch(step.id, { quality: Number(event.target.value) / 100 })}
                            className="w-full accent-forest"
                          />
                        </Field>
                        <p className="self-end pb-2 text-[11px] leading-relaxed text-muted">
                          Each page becomes an image, so text is no longer selectable and every hidden layer, script or annotation is gone.
                        </p>
                      </div>
                    )}
                    {step.kind === "sanitize" && (
                      <div className="grid gap-2 sm:grid-cols-3">
                        <Switch checked={step.stripMeta} onChange={(value) => patch(step.id, { stripMeta: value })} label="Metadata" description="XMP, info" />
                        <Switch
                          checked={step.stripActions}
                          onChange={(value) => patch(step.id, { stripActions: value })}
                          label="Scripts"
                          description="JS, actions, forms"
                        />
                        <Switch
                          checked={step.stripAnnots}
                          onChange={(value) => patch(step.id, { stripAnnots: value })}
                          label="Annotations"
                          description="Comments, links"
                        />
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        {dryError && (
          <p role="alert" className="mt-2 text-[11px] font-medium text-clay-ink">
            {dryError}
          </p>
        )}
        {dry && (
          <div className="mt-3 rounded-xl border border-line bg-paper p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-[12px] font-semibold text-forest">
                <Play className="h-3.5 w-3.5" /> Dry run · nothing processed yet
              </p>
              <span className="text-[11px] text-muted">
                {files.length} file{files.length === 1 ? "" : "s"} · {dry.pagesIn} pages in → {dry.pagesOut} pages out
              </span>
            </div>
            <div className="mt-2 space-y-1">
              {dry.rows.map((row, index) => (
                <div key={`${row.label}-${index}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-bone/40 px-2.5 py-1.5">
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-forest text-[9px] font-bold text-lime">{index + 1}</span>
                  <span className="text-[11.5px] font-semibold">{row.label}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-muted">{row.detail}</span>
                  <span className="text-[11px] tabular-nums text-ink/70">
                    {row.pagesIn} → <strong className="text-forest">{row.pagesOut}</strong> pages
                  </span>
                  {row.note && <span className="w-full text-[10.5px] text-amber-800">{row.note}</span>}
                </div>
              ))}
            </div>
            <p className="mt-2 text-[10.5px] leading-relaxed text-muted">
              Final page counts per file: {dry.perFile.map((count, index) => `${files[index]?.name ?? `file ${index + 1}`} (${count})`).join(", ")}. Flattening
              and compression change file size, not page count.
            </p>
          </div>
        )}
      </div>

      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink/75">3 · Output</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-line bg-paper p-3">
            <Switch checked={merge} onChange={(value) => opts.set("merge", value)} label="Merge all results into one PDF" />
            <p className="mt-1 text-[11px] text-muted">Off: each input gets its own PDF, delivered as a ZIP.</p>
          </div>
          <Field label="Password (optional)" hint="Encrypts the output with AES-256. At least 4 characters. Never saved.">
            <div className="relative">
              <LockKeyhole className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink/60" />
              <TextInput
                type="password"
                value={password}
                placeholder="Leave empty for no encryption"
                autoComplete="new-password"
                className="pl-8"
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          </Field>
        </div>
      </div>

      {job.failed && <Alert tone="error">{job.error}</Alert>}
      {job.status === "cancelled" && <Alert tone="info">Cancelled — nothing was downloaded. Your files and pipeline are unchanged.</Alert>}
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Button onClick={() => void run()} loading={job.busy} disabled={!files.length || !steps.length}>
          <Combine className="h-4 w-4" /> {job.busy ? "Running workflow…" : `Run workflow on ${files.length || 0} file${files.length === 1 ? "" : "s"}`}
        </Button>
        {job.busy && (
          <Button variant="ghost" onClick={job.cancel}>
            Cancel
          </Button>
        )}
        <span className="text-[11.5px] text-muted">
          {steps.length} step{steps.length === 1 ? "" : "s"} · {opts.changed ? "options changed" : "default output"} · ⌘↵ to run
        </span>
      </div>
      {job.busy && (
        <Progress value={job.percent ?? undefined} label={job.label || "Running the workflow…"} etaMs={job.etaMs} detail={describeJobTime(job)} />
      )}

      {fresh && result?.merged && result.bytes.byteLength > 0 && (
        <DownloadPanel
          filename={result.name}
          size={result.bytes.byteLength}
          onDownload={() => downloadBytes(result.bytes, result.name)}
          title="Workflow complete"
          description={`${result.steps} step${result.steps === 1 ? "" : "s"} applied across ${result.count} PDF${result.count === 1 ? "" : "s"} · merged into one document`}
          bytes={result.bytes}
          handoffIds={["compress", "protect", "sign"]}
          facts={[{ label: "Pages", value: String(result.totalPages) }]}
        />
      )}
      {fresh && result && !result.merged && (
        <Alert tone="success" title="Workflow complete">
          {result.steps} step{result.steps === 1 ? "" : "s"} applied to {result.count} PDF{result.count === 1 ? "" : "s"}. Your ZIP
          (paperly-workflow.zip) has been downloaded — if the browser blocked it, run the workflow again and allow downloads for this site.
        </Alert>
      )}

      <div className="rounded-xl border border-line bg-bone-deep/30 p-3 text-[11px] leading-relaxed text-muted">
        Every step runs in this tab with PDF.js and pdf-lib. Rotations, page removal, extraction, watermarks and numbering rebuild only the page tree;
        flattening rasterises each page; sanitising removes metadata, scripts and annotations you select; compression re-encodes embedded photos;
        encryption uses AES-256 and is verified before the result is offered. A pipeline saved as JSON never contains your files or your password.
      </div>
    </div>
  );
}
