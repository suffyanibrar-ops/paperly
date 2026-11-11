import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Combine,
  FileOutput,
  Hash,
  LockKeyhole,
  Plus,
  RotateCw,
  Scissors,
  Trash2,
  Workflow as WorkflowIcon,
  X,
} from "lucide-react";
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
import { recompressImages } from "@/tools/Optimize";
import { useInitialFiles } from "@/lib/usePdf";
import {
  Alert,
  Badge,
  Button,
  Field,
  FileDrop,
  FileRow,
  Progress,
  Segmented,
  Select,
  Switch,
  TextInput,
} from "@/components/ui";
import { DownloadPanel } from "@/components/toolParts";

/* ================================================================== *
 * PDF WORKFLOW — chain several operations over one or many PDFs
 * ================================================================== */
type StepKind = "rotate" | "remove" | "extract" | "watermark" | "numbers" | "compress";
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
}

const MAX_FILES = 20;
const MAX_STEPS = 8;

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
  compress: { label: "Compress", icon: FileOutput, hint: "Re-encode photos after the structural work." },
};

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
  };
}

const hasTextStep = (steps: Step[]) => steps.some((step) => step.kind === "watermark" || step.kind === "numbers");

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
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

/** Apply the pipeline to one PDF and return the new bytes. */
async function runPipeline(
  bytes: ArrayBuffer,
  steps: Step[],
  onPhase: (label: string, value: number) => void,
): Promise<Uint8Array> {
  const structural = steps.filter((step) => step.kind === "rotate" || step.kind === "remove" || step.kind === "extract");
  const compress = [...steps].reverse().find((step) => step.kind === "compress");
  let out: Uint8Array;

  if (structural.length || hasTextStep(steps)) {
    onPhase("Rebuilding the document structure…", 30);
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
    onPhase("Saving the rebuilt PDF…", 55);
    out = await target.save({ useObjectStreams: true });
  } else {
    const doc = await openPdfLib(bytes);
    await drawOverlays(doc, steps);
    out = await doc.save({ useObjectStreams: true });
  }

  if (compress) {
    onPhase("Compressing embedded images…", 70);
    const config = COMPRESSION_LEVELS[compress.level];
    const result = await recompressImages(toArrayBuffer(out), config, () => undefined);
    if (result.bytes.byteLength < out.byteLength) out = result.bytes;
  }
  onPhase("Done", 100);
  return out;
}

export function WorkflowTool() {
  const initial = useInitialFiles();
  const [files, setFiles] = useState<File[]>(initial);
  const [steps, setSteps] = useState<Step[]>([]);
  const [merge, setMerge] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; count: number; merged: boolean } | null>(null);

  useEffect(() => {
    setResult(null);
  }, [files, steps, merge, password]);

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

  const addFiles = (incoming: File[]) => {
    const pdfs = incoming.filter((file) => /\.pdf$/i.test(file.name) || file.type === "application/pdf");
    setFiles((current) => [...current, ...pdfs].slice(0, MAX_FILES));
  };

  const run = async () => {
    if (!files.length) {
      setError("Add at least one PDF to start a workflow.");
      return;
    }
    if (!steps.length) {
      setError("Add at least one step to your workflow.");
      return;
    }
    if (password && password.length < 4) {
      setError("Use at least 4 characters for the password, or leave it empty.");
      return;
    }
    setBusy(true);
    setError("");
    setResult(null);
    setProgress(2);
    try {
      const outputs: { name: string; bytes: Uint8Array }[] = [];
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        setPhase(`Processing ${file.name} (${index + 1} of ${files.length})…`);
        setProgress(4 + (index / files.length) * 80);
        const bytes = await readFileBytes(file);
        const processed = await runPipeline(bytes, steps, (label, value) => {
          setPhase(`${file.name}: ${label}`);
          setProgress(4 + (index / files.length) * 80 + (value / 100) * (80 / files.length));
        });
        outputs.push({ name: `${sanitizeName(baseName(file.name))}-workflow.pdf`, bytes: processed });
      }

      let finalBytes: Uint8Array;
      let finalName: string;
      let merged = false;
      if (merge && outputs.length > 1) {
        setPhase("Merging every result into one document…");
        setProgress(88);
        const combined = await PDFDocument.create();
        for (const output of outputs) {
          const source = await openPdfLib(output.bytes);
          const copied = await combined.copyPages(source, source.getPageIndices());
          copied.forEach((page) => combined.addPage(page));
        }
        finalBytes = await combined.save({ useObjectStreams: true });
        finalName = `${sanitizeName(baseName(files[0].name))}-workflow.pdf`;
        merged = true;
      } else if (merge) {
        finalBytes = outputs[0].bytes;
        finalName = outputs[0].name;
        merged = true;
      } else {
        finalBytes = new Uint8Array();
        finalName = "";
      }

      if (password) {
        setPhase("Encrypting the output with AES-256…");
        setProgress(94);
        const targets = merged ? [{ name: finalName, bytes: finalBytes }] : outputs;
        for (const target of targets) {
          const doc = await openPdfLib(target.bytes);
          doc.encrypt({ userPassword: password, ownerPassword: password, permissions: { printing: "highResolution" } });
          target.bytes = await doc.save();
        }
        if (merged) finalBytes = targets[0].bytes;
      }

      setProgress(100);
      if (merged) {
        setResult({ bytes: finalBytes, name: finalName, count: files.length, merged: true });
      } else {
        await zipAndDownload(
          outputs.map((output) => ({ name: output.name, data: output.bytes })),
          "paperly-workflow.zip",
        );
        setResult({
          bytes: new Uint8Array(),
          name: `paperly-workflow.zip`,
          count: outputs.length,
          merged: false,
        });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setPhase("");
    }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-forest/15 bg-lime/25 p-3.5 text-[11.5px] leading-relaxed text-forest">
        <p className="flex items-center gap-1.5 font-semibold">
          <WorkflowIcon className="h-4 w-4" /> One pipeline, every file
        </p>
        <p className="mt-1 text-ink/75">
          Chain up to {MAX_STEPS} operations and run them across up to {MAX_FILES} PDFs in one pass — rotate, trim, watermark, number,
          compress, merge and encrypt. Other suites make you repeat a single operation; here the whole recipe runs locally, once.
        </p>
      </div>

      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink/75">1 · Input files</p>
        {files.length === 0 ? (
          <FileDrop accept="application/pdf,.pdf" acceptLabel="PDF files to process" multiple onFiles={addFiles} />
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
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink/75">2 · Pipeline</p>
          <Badge tone="forest">{steps.length} step{steps.length === 1 ? "" : "s"}</Badge>
        </div>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {(Object.keys(STEP_META) as StepKind[]).map((kind) => {
            const meta = STEP_META[kind];
            const Icon = meta.icon;
            return (
              <button
                key={kind}
                type="button"
                disabled={steps.length >= MAX_STEPS}
                onClick={() => setSteps((current) => [...current, newStep(kind)])}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-paper px-2.5 text-[11.5px] font-medium text-ink/75 transition-colors hover:border-forest/30 hover:text-forest disabled:opacity-40"
              >
                <Icon className="h-3.5 w-3.5" /> {meta.label}
              </button>
            );
          })}
        </div>

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
                <li key={step.id} className="rounded-xl border border-line bg-paper p-3">
                  <div className="flex items-center gap-2">
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
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink/75">3 · Output</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-line bg-paper p-3">
            <Switch checked={merge} onChange={setMerge} label="Merge all results into one PDF" />
            <p className="mt-1 text-[11px] text-muted">Off: each input gets its own PDF, delivered as a ZIP.</p>
          </div>
          <Field label="Password (optional)" hint="Encrypts the output with AES-256. At least 4 characters.">
            <div className="relative">
              <LockKeyhole className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink/60" />
              <TextInput
                type="password"
                value={password}
                placeholder="Leave empty for no encryption"
                autoComplete="new-password"
                className={`${""} pl-8`}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          </Field>
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      <div className="border-t border-line pt-4">
        <Button onClick={run} loading={busy} disabled={!files.length || !steps.length}>
          <Combine className="h-4 w-4" /> {busy ? "Running workflow…" : `Run workflow on ${files.length || 0} file${files.length === 1 ? "" : "s"}`}
        </Button>
        {busy && <div className="mt-3"><Progress value={progress} label={phase} /></div>}
      </div>

      {result && result.merged && result.bytes.byteLength > 0 && (
        <DownloadPanel
          filename={result.name}
          size={result.bytes.byteLength}
          onDownload={() => downloadBytes(result.bytes, result.name)}
          title="Workflow complete"
          description={`${steps.length} step${steps.length === 1 ? "" : "s"} applied across ${result.count} PDF${result.count === 1 ? "" : "s"} · merged into one document`}
          bytes={result.bytes}
          handoffIds={["compress", "protect", "sign"]}
        />
      )}
      {result && !result.merged && (
        <Alert tone="success" title="Workflow complete">
          {steps.length} step{steps.length === 1 ? "" : "s"} applied to {result.count} PDF{result.count === 1 ? "" : "s"}. Your ZIP
          (paperly-workflow.zip) has been downloaded — if the browser blocked it, run the workflow again and allow downloads for this site.
        </Alert>
      )}

      <div className="rounded-xl border border-line bg-bone-deep/30 p-3 text-[11px] leading-relaxed text-muted">
        Every step runs in this tab with PDF.js and pdf-lib. Rotations, page removal, extraction, watermarks and numbering rebuild only the page
        tree; compression re-encodes embedded photos; encryption uses AES-256 and is verified before the result is offered.
      </div>
    </div>
  );
}
