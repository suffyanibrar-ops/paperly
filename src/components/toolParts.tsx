import {
  Check,
  Copy,
  Download,
  Eye,
  FileCheck2,
  FileText,
  Hash,
  RefreshCw,
  Share2,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Button, Field, FileDrop, FileRow, Progress, SuccessPanel, inputClass, useToolId } from "@/components/ui";
import { OutputPreview } from "@/components/OutputPreview";
import { formatBytes } from "@/lib/format";
import { recordActivity } from "@/lib/activity";
import { getTool } from "@/lib/toolRegistry";
import { startTool } from "@/lib/router";
import { useDownloadShortcut } from "@/lib/hotkeys";
import { SAMPLE } from "@/lib/sample";
import { describePageQuery, pageQueryChips, parsePageQuery, validatePageQuery } from "@/lib/pageQuery";
import {
  canPreviewOutput,
  canShareOutput,
  copyOutput,
  downloadOutput,
  ensureOutputName,
  outputMimeType,
  savedPercentLabel,
  shareOutput,
  sha256Hex,
  splitOutputName,
} from "@/lib/output";
import type { usePdfFile } from "@/lib/usePdf";
import { cn } from "@/utils/cn";

export type PdfState = ReturnType<typeof usePdfFile>;

const darkActionClass =
  "inline-flex h-8 items-center gap-1.5 rounded-lg border border-paper/20 bg-paper/[0.06] px-2.5 text-[11.5px] font-medium text-paper transition-colors hover:border-lime/40 hover:bg-paper/10 disabled:opacity-50";

export function SinglePdfInput({
  state,
  acceptLabel = "A PDF file",
  onLoaded,
  sample = SAMPLE.pdf,
  hint,
}: {
  state: PdfState;
  acceptLabel?: string;
  onLoaded?: () => void;
  /** Pass `undefined` to hide the sample button. */
  sample?: typeof SAMPLE.pdf | undefined;
  hint?: ReactNode;
}) {
  if (!state.file) {
    return (
      <FileDrop
        accept="application/pdf,.pdf"
        acceptLabel={acceptLabel}
        onFiles={(files) => state.setFile(files[0])}
        sample={sample}
        hint={hint}
      />
    );
  }
  return (
    <div className="space-y-3">
      <FileRow
        file={state.file}
        onRemove={state.clear}
        size={
          state.loading
            ? "Reading…"
            : state.error
              ? "Couldn’t read file"
              : `${state.pageCount} page${state.pageCount === 1 ? "" : "s"} · ${formatBytes(state.file.size)}`
        }
      />
      {state.loading && <Progress label="Reading your PDF locally…" />}
      {state.error && (
        <Alert tone="error" title="That file won’t open">
          {state.error}{" "}
          {state.needsPassword && (
            <a href="#/tool/unlock" className="font-semibold underline">
              Open Unlock PDF
            </a>
          )}
        </Alert>
      )}
      {state.file && !state.loading && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="cursor-pointer">
            <span className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-paper px-2.5 text-[12px] font-medium text-ink/75 transition-colors hover:border-forest/30">
              <RefreshCw className="h-3 w-3" /> Replace file
            </span>
            <input
              type="file"
              accept="application/pdf,.pdf"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  state.setFile(f);
                  onLoaded?.();
                }
                e.target.value = "";
              }}
            />
          </label>
          <span className="flex items-center gap-1 text-[11px] text-muted">
            <ShieldCheck className="h-3.5 w-3.5 text-forest" /> Read in this tab only
          </span>
        </div>
      )}
    </div>
  );
}

export function RangeField({
  value,
  onChange,
  total,
  label = "Pages",
  hint = "Use a range like 1-3, 5, 8 — or odd, even, last, last-3, >10.",
  showAll = true,
}: {
  value: string;
  onChange: (v: string) => void;
  total: number;
  label?: string;
  hint?: string;
  showAll?: boolean;
}) {
  const problem = total > 0 && value.trim() ? validatePageQuery(value, total) : null;
  let preview = "";
  if (total > 0 && !problem) {
    try {
      preview = describePageQuery(parsePageQuery(value, total), total);
    } catch {
      preview = "";
    }
  }
  return (
    <Field label={label} htmlFor="page-range" hint={hint}>
      <div className="flex gap-2">
        <input
          id="page-range"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="All pages"
          className={cn(inputClass, problem && "border-clay/50 focus:border-clay focus:ring-clay/10")}
          inputMode="text"
          autoComplete="off"
          aria-invalid={Boolean(problem)}
          aria-describedby={problem ? "page-range-error" : undefined}
        />
        {showAll && (
          <Button variant="outline" size="md" onClick={() => onChange("")} className="shrink-0" type="button">
            All
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {pageQueryChips(total)
          .filter((chip) => chip.value !== "")
          .map((chip) => (
            <button
              key={chip.label}
              type="button"
              title={chip.title}
              onClick={() => onChange(chip.value)}
              aria-pressed={value.trim() === chip.value.trim()}
              className={cn(
                "rounded-md border px-1.5 py-0.5 text-[10.5px] font-medium transition-colors",
                value.trim() === chip.value.trim()
                  ? "border-forest bg-forest text-paper"
                  : "border-line bg-paper text-ink/60 hover:border-forest/30 hover:text-forest",
              )}
            >
              {chip.label}
            </button>
          ))}
      </div>
      {problem ? (
        <p id="page-range-error" role="alert" className="text-[11px] font-medium text-clay-ink">
          {problem}
        </p>
      ) : (
        <p className="text-[11px] text-muted">
          {total ? `${total} page${total === 1 ? "" : "s"} available${preview ? ` · ${preview}` : ""}` : "Add a file first"}
        </p>
      )}
    </Field>
  );
}

export function ContinueWith({ bytes, filename, ids }: { bytes: Uint8Array; filename: string; ids?: string[] }) {
  const toolId = useToolId();
  const current = toolId ? getTool(toolId) : undefined;
  const suggested = (ids ?? current?.related ?? [])
    .map((id) => getTool(id))
    .filter((t) => Boolean(t) && t!.accepts.includes("application/pdf") && t!.id !== toolId)
    .map((t) => t!)
    .slice(0, 3);
  if (!suggested.length) return null;
  return (
    <div className="mt-3 border-t border-paper/15 pt-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-paper/75">Continue with the result</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {suggested.map((tool) => (
          <button
            key={tool.id}
            type="button"
            onClick={() => {
              const file = new File([bytes as unknown as BlobPart], filename.endsWith(".pdf") ? filename : `${filename}.pdf`, {
                type: "application/pdf",
              });
              startTool(tool.id, [file]);
            }}
            className={darkActionClass}
          >
            <tool.icon className="h-3.5 w-3.5 text-lime" /> {tool.name}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ResultFacts({ facts }: { facts: { label: string; value: string }[] }) {
  if (!facts.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-paper/15 bg-paper/[0.06] px-3 py-2 text-[11.5px] text-paper/70">
      {facts.map((fact) => (
        <span key={fact.label} className="flex items-center gap-1.5">
          <span className="text-paper/45">{fact.label}</span>
          <span className="font-semibold text-paper/90">{fact.value}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * The one result panel every tool shares: rename before download, local
 * preview, copy, share, checksum and one-click hand-off to a follow-up tool.
 */
export function DownloadPanel({
  filename,
  size,
  pages,
  onDownload,
  title = "Your file is ready",
  description,
  originalSize,
  extra,
  bytes,
  handoffIds,
  mime,
  facts,
  allowRename = true,
}: {
  filename: string;
  size: number;
  pages?: number;
  onDownload: () => void;
  title?: string;
  description?: ReactNode;
  originalSize?: number;
  extra?: ReactNode;
  bytes?: Uint8Array;
  handoffIds?: string[];
  /** Falls back to the filename extension. */
  mime?: string;
  /** Extra result chips, e.g. { label: "Layout", value: "2-up" }. */
  facts?: { label: string; value: string }[];
  allowRename?: boolean;
}) {
  const toolId = useToolId();
  const type = mime ?? outputMimeType(filename);
  const initial = useMemo(() => splitOutputName(filename), [filename]);
  const [stem, setStem] = useState(initial.stem);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [checksum, setChecksum] = useState("");
  const [checksumBusy, setChecksumBusy] = useState(false);
  const [copied, setCopied] = useState<"idle" | "ok" | "no">("idle");
  const [shared, setShared] = useState<"idle" | "ok" | "no">("idle");
  const shareable = useMemo(() => Boolean(bytes) && canShareOutput(type), [bytes, type]);
  const previewable = Boolean(bytes) && canPreviewOutput(type);
  const finalName = ensureOutputName(`${stem}${initial.extension}`, filename);
  const savedLabel = originalSize ? savedPercentLabel(originalSize, size) : null;

  useEffect(() => {
    const next = splitOutputName(filename);
    setStem(next.stem);
    setChecksum("");
    setCopied("idle");
    setShared("idle");
  }, [filename]);

  const handleDownload = () => {
    if (bytes) downloadOutput(bytes, finalName, type);
    else onDownload();
    if (toolId) recordActivity({ toolId, toolName: getTool(toolId)?.name ?? "Paperly", filename: finalName, size, pages });
  };

  // Every result panel supports ⌘S / Ctrl+S without further tool wiring.
  useDownloadShortcut(handleDownload, Boolean(bytes));

  const runCopy = async () => {
    if (!bytes) return;
    const ok = await copyOutput(bytes, type);
    setCopied(ok ? "ok" : "no");
    window.setTimeout(() => setCopied("idle"), 2200);
  };

  const runShare = async () => {
    if (!bytes) return;
    const result = await shareOutput(bytes, finalName, type);
    setShared(result === "shared" ? "ok" : "no");
    window.setTimeout(() => setShared("idle"), 2200);
  };

  const runChecksum = async () => {
    if (!bytes || checksumBusy) return;
    setChecksumBusy(true);
    const value = await sha256Hex(bytes);
    setChecksum(value);
    setChecksumBusy(false);
  };

  const resultFacts = [
    { label: "Size", value: formatBytes(size) },
    ...(pages ? [{ label: "Pages", value: String(pages) }] : []),
    ...(originalSize ? [{ label: "Original", value: formatBytes(originalSize) }] : []),
    ...(savedLabel ? [{ label: "Saved", value: savedLabel }] : []),
    ...(checksum ? [{ label: "SHA-256", value: `${checksum.slice(0, 12)}…` }] : []),
    ...(facts ?? []),
  ];

  return (
    <>
      <SuccessPanel
        title={title}
        onDownload={handleDownload}
        downloadLabel={`Download ${formatBytes(size)}`}
        description={
          description ?? (
            <span>
              {pages ? `${pages} page${pages === 1 ? "" : "s"} · ` : ""}
              {formatBytes(size)}
              {savedLabel ? ` · ${savedLabel} than the original` : ""}
            </span>
          )
        }
      >
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-paper/15 bg-paper/[0.06] px-3 py-2 text-[11.5px] text-paper/70">
            <FileCheck2 className="h-3.5 w-3.5 shrink-0 text-lime" />
            {allowRename ? (
              <span className="flex min-w-0 flex-1 items-center gap-1">
                <label htmlFor="output-filename" className="sr-only">
                  Output file name
                </label>
                <input
                  id="output-filename"
                  value={stem}
                  onChange={(event) => setStem(event.target.value)}
                  spellCheck={false}
                  className="h-7 min-w-0 flex-1 rounded-md border border-paper/20 bg-paper/10 px-2 text-[12px] font-medium text-paper placeholder:text-paper/40 focus:border-lime/50 focus:outline-none"
                />
                <span className="font-semibold text-paper/80">{initial.extension}</span>
              </span>
            ) : (
              <span className="truncate font-medium text-paper/90">{filename}</span>
            )}
          </div>
          <ResultFacts facts={resultFacts} />
          <div className="flex flex-wrap items-center gap-1.5">
            {previewable && (
              <button type="button" className={darkActionClass} onClick={() => setPreviewOpen(true)}>
                <Eye className="h-3.5 w-3.5" /> Preview
              </button>
            )}
            {bytes && (type.startsWith("text/") || type === "application/json" || type === "image/png") && (
              <button type="button" className={darkActionClass} onClick={() => void runCopy()}>
                {copied === "ok" ? <Check className="h-3.5 w-3.5 text-lime" /> : <Copy className="h-3.5 w-3.5" />}
                {copied === "ok" ? "Copied" : copied === "no" ? "Copy blocked" : "Copy"}
              </button>
            )}
            {shareable && (
              <button type="button" className={darkActionClass} onClick={() => void runShare()}>
                {shared === "ok" ? <Check className="h-3.5 w-3.5 text-lime" /> : <Share2 className="h-3.5 w-3.5" />}
                {shared === "ok" ? "Shared" : shared === "no" ? "Share blocked" : "Share"}
              </button>
            )}
            {bytes && (
              <button type="button" className={darkActionClass} onClick={() => void runChecksum()} disabled={checksumBusy}>
                <Hash className={cn("h-3.5 w-3.5", checksumBusy && "animate-pulse")} />
                {checksum ? "Checksum ready" : checksumBusy ? "Hashing…" : "Checksum"}
              </button>
            )}
          </div>
          {checksum && (
            <p className="break-all font-mono text-[10px] leading-relaxed text-paper/50" title="SHA-256 of the downloaded bytes">
              {checksum}
            </p>
          )}
        </div>
        {bytes ? <ContinueWith bytes={bytes} filename={finalName} ids={handoffIds} /> : null}
        {extra}
      </SuccessPanel>
      {previewOpen && bytes ? (
        <OutputPreview
          bytes={bytes}
          filename={finalName}
          mime={type}
          onClose={() => setPreviewOpen(false)}
          onDownload={handleDownload}
        />
      ) : null}
    </>
  );
}

/**
 * Keeps the primary action reachable on long tool forms. Wrap the action row
 * in this instead of a plain div when the tool has many options above it.
 */
export function ToolActionBar({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="sticky bottom-3 z-10 mt-4 flex flex-wrap items-center gap-2.5 rounded-xl border border-line bg-paper/95 p-3 shadow-soft backdrop-blur">
      {children}
      {note ? <span className="ml-auto text-[11px] text-muted">{note}</span> : null}
    </div>
  );
}

export { Download, FileText };
