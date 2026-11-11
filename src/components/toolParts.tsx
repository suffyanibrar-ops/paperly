import { FileCheck2, RefreshCw, Download, FileText, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { Alert, Button, Field, FileDrop, FileRow, Progress, SuccessPanel, inputClass, useToolId } from "@/components/ui";
import { formatBytes } from "@/lib/format";
import { recordActivity } from "@/lib/activity";
import { getTool } from "@/lib/toolRegistry";
import { startTool } from "@/lib/router";
import type { usePdfFile } from "@/lib/usePdf";

export type PdfState = ReturnType<typeof usePdfFile>;

export function SinglePdfInput({
  state,
  acceptLabel = "A PDF file",
  onLoaded,
}: {
  state: PdfState;
  acceptLabel?: string;
  onLoaded?: () => void;
}) {
  if (!state.file) {
    return <FileDrop accept="application/pdf,.pdf" acceptLabel={acceptLabel} onFiles={(files) => state.setFile(files[0])} />;
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
  hint = "Use a range like 1-3, 5, 8. Leave empty for all pages.",
  showAll = true,
}: {
  value: string;
  onChange: (v: string) => void;
  total: number;
  label?: string;
  hint?: string;
  showAll?: boolean;
}) {
  return (
    <Field label={label} htmlFor="page-range" hint={hint}>
      <div className="flex gap-2">
        <input
          id="page-range"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="All pages"
          className={inputClass}
          inputMode="text"
          autoComplete="off"
        />
        {showAll && (
          <Button variant="outline" size="md" onClick={() => onChange("")} className="shrink-0" type="button">
            All
          </Button>
        )}
      </div>
      <p className="text-[11px] text-muted">{total ? `${total} page${total === 1 ? "" : "s"} available` : "Add a file first"}</p>
    </Field>
  );
}

export function ContinueWith({ bytes, filename, ids }: { bytes: Uint8Array; filename: string; ids?: string[] }) {
  const toolId = useToolId();
  const current = toolId ? getTool(toolId) : undefined;
  const suggested = (ids ?? current?.related ?? []).map((id) => getTool(id)).filter((t) => Boolean(t) && t!.accepts.includes("application/pdf") && t!.id !== toolId).map((t) => t!).slice(0, 3);
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
              const file = new File([bytes as unknown as BlobPart], filename.endsWith(".pdf") ? filename : `${filename}.pdf`, { type: "application/pdf" });
              startTool(tool.id, [file]);
            }}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-paper/20 bg-paper/[0.06] px-2.5 text-[11.5px] font-medium text-paper transition-colors hover:border-lime/40 hover:bg-paper/10"
          >
            <tool.icon className="h-3.5 w-3.5 text-lime" /> {tool.name}
          </button>
        ))}
      </div>
    </div>
  );
}

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
}) {
  const saved = originalSize && originalSize > 0 ? Math.round(((originalSize - size) / originalSize) * 100) : null;
  const toolId = useToolId();
  const handleDownload = () => {
    onDownload();
    if (toolId) {
      recordActivity({ toolId, toolName: getTool(toolId)?.name ?? "Paperly", filename, size, pages });
    }
  };
  return (
    <SuccessPanel
      title={title}
      onDownload={handleDownload}
      downloadLabel={`Download ${formatBytes(size)}`}
      description={
        description ?? (
          <span>
            {pages ? `${pages} page${pages === 1 ? "" : "s"} · ` : ""}
            {formatBytes(size)}
            {saved !== null && saved > 0 ? ` · ${saved}% smaller than the original` : ""}
          </span>
        )
      }
    >
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-paper/15 bg-paper/[0.06] px-3 py-2 text-[11.5px] text-paper/70">
        <span className="flex min-w-0 items-center gap-1.5 font-medium text-paper/90">
          <FileCheck2 className="h-3.5 w-3.5 shrink-0 text-lime" />
          <span className="truncate">{filename}</span>
        </span>
        {originalSize ? <span>Original {formatBytes(originalSize)}</span> : null}
      </div>
      {bytes ? <ContinueWith bytes={bytes} filename={filename} ids={handoffIds} /> : null}
      {extra}
    </SuccessPanel>
  );
}

export { Download, FileText };
