import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronsLeft,
  ChevronsRight,
  Copy,
  FilePlus2,
  Files,
  GripVertical,
  Info,
  Loader2,
  Plus,
  RotateCw,
  Scissors,
  Trash2,
  X,
} from "lucide-react";
import JSZip from "jszip";
import { useEffect, useRef, useState } from "react";
import {
  PDFDocument,
  baseName,
  degrees,
  downloadBytes,
  formatBytes,
  openPdfJs,
  openPdfLib,
  readFileBytes,
  renderPdfPage,
  sanitizeName,
  MAX_PDF_PAGES,
} from "@/lib/pdf";
import { useInitialFiles } from "@/lib/usePdf";
import { friendlyProcessingError, validateUpload } from "@/lib/security";
import { Alert, Button, FileDrop, Progress } from "@/components/ui";
import { DownloadPanel } from "@/components/toolParts";
import { useJob } from "@/lib/job";
import { useDownloadShortcut, useEscape, usePrimaryShortcut } from "@/lib/hotkeys";
import { Toast, type ToastMessage } from "@/components/Toast";
import { cn } from "@/utils/cn";

/**
 * Unified multi-PDF organizer.
 *
 * Drop several PDFs at once and work on one visual page grid: reorder across
 * files, merge, split into multiple documents, rotate, duplicate, delete and
 * insert blank pages — then export one final PDF or a ZIP of split segments.
 * Every operation runs on this device.
 */

interface Source {
  id: string;
  file: File;
  bytes: ArrayBuffer;
  pageCount: number;
  dims: { w: number; h: number }[];
}

interface PageItem {
  id: string;
  /** Empty for an inserted blank page. */
  sourceId: string;
  page: number;
  rotation: number;
  blank?: boolean;
}

interface OrganizeResult {
  bytes: Uint8Array;
  name: string;
  pages: number;
  files: number;
  blank: number;
  rotated: number;
  mime: string;
}

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(sequence += 1).toString(36)}`;

function pagesForSource(source: Source): PageItem[] {
  return Array.from({ length: source.pageCount }, (_, index) => ({
    id: nextId("page"),
    sourceId: source.id,
    page: index + 1,
    rotation: 0,
  }));
}

function useSourceThumbs(sources: Source[]) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [rendered, setRendered] = useState(0);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    if (!sources.length) {
      setThumbs({});
      setRendered(0);
      setTotal(0);
      return;
    }
    let alive = true;
    setLoading(true);
    setRendered(0);
    setThumbs({});
    const cap = 120;
    const count = sources.reduce((sum, source) => sum + Math.min(source.pageCount, cap), 0);
    setTotal(count);
    (async () => {
      let budget = cap;
      let done = 0;
      for (const source of sources) {
        if (!alive || budget <= 0) break;
        const doc = await openPdfJs(source.bytes, undefined, { maxPages: MAX_PDF_PAGES });
        const pages = Math.min(doc.numPages, budget);
        for (let page = 1; page <= pages; page++) {
          if (!alive) break;
          const renderedPage = await renderPdfPage(doc, page, { targetWidth: 170, type: "image/jpeg", quality: 0.72 });
          if (!alive) break;
          done += 1;
          setThumbs((current) => ({ ...current, [`${source.id}:${page}`]: renderedPage.dataUrl }));
          setRendered(done);
        }
        budget -= pages;
        await doc.destroy().catch(() => undefined);
      }
    })()
      .catch(() => undefined)
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [sources]);

  return { thumbs, loading, rendered, total };
}

async function loadSource(file: File): Promise<Source> {
  await validateUpload(file, "application/pdf,.pdf");
  const bytes = await readFileBytes(file);
  const doc = await openPdfLib(bytes);
  const pages = doc.getPages();
  if (pages.length > MAX_PDF_PAGES) {
    throw new Error(`${file.name} has ${pages.length.toLocaleString()} pages. Paperly organizes up to ${MAX_PDF_PAGES.toLocaleString()} at once.`);
  }
  return {
    id: nextId("source"),
    file,
    bytes,
    pageCount: pages.length,
    dims: pages.map((page) => ({ w: page.getWidth(), h: page.getHeight() })),
  };
}

export function UnifiedOrganizeTool() {
  const initial = useInitialFiles();
  const [sources, setSources] = useState<Source[]>([]);
  const [order, setOrder] = useState<PageItem[]>([]);
  const [splitAfter, setSplitAfter] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<OrganizeResult | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastSeq = useRef(0);
  const job = useJob<OrganizeResult>();
  const showToast = (text: string, tone: "success" | "info" = "success") => setToast({ id: (toastSeq.current += 1), text, tone });
  const addRef = useRef<HTMLInputElement | null>(null);
  const startedRef = useRef(false);
  const { thumbs, loading: thumbsLoading, rendered, total } = useSourceThumbs(sources);

  const addFiles = async (picked: File[]) => {
    if (!picked.length) return;
    setLoading(true);
    setError("");
    setResult(null);
    const loaded: Source[] = [];
    const problems: string[] = [];
    let pageBudget = MAX_PDF_PAGES - order.length;
    for (const file of picked) {
      try {
        const source = await loadSource(file);
        if (source.pageCount > pageBudget) {
          problems.push(`${file.name} would exceed the ${MAX_PDF_PAGES.toLocaleString()}-page workspace limit.`);
          continue;
        }
        pageBudget -= source.pageCount;
        loaded.push(source);
      } catch (err) {
        problems.push(friendlyProcessingError(err, `${file.name} couldn’t be opened.`));
      }
    }
    if (loaded.length) {
      setSources((current) => [...current, ...loaded]);
      setOrder((current) => [...current, ...loaded.flatMap(pagesForSource)]);
      const added = loaded.reduce((sum, source) => sum + source.pageCount, 0);
      setNotice(`${added} pages added from ${loaded.length} file${loaded.length === 1 ? "" : "s"}.`);
      showToast(`${added} pages added from ${loaded.length} file${loaded.length === 1 ? "" : "s"}.`);
    }
    setError(problems.join(" "));
    setLoading(false);
  };

  useEffect(() => {
    if (startedRef.current || !initial.length) return;
    startedRef.current = true;
    void addFiles(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  const update = (next: PageItem[]) => {
    setOrder(next);
    setResult(null);
    setNotice("");
  };

  const reorder = (from: number, to: number) => {
    if (from === to || to < 0 || to >= order.length) return;
    const next = [...order];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    update(next);
  };

  const removeSource = (sourceId: string) => {
    setSources((current) => current.filter((source) => source.id !== sourceId));
    setOrder((current) => {
      const next = current.filter((item) => item.sourceId !== sourceId);
      setSplitAfter((marks) => new Set([...marks].filter((id) => next.some((item) => item.id === id))));
      return next;
    });
    setResult(null);
    showToast("Removed that file and its pages.", "info");
  };

  const toggleSplit = (id: string) => {
    let added = false;
    setSplitAfter((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else {
        next.add(id);
        added = true;
      }
      return next;
    });
    setResult(null);
    showToast(added ? "Split marker added — export will produce a ZIP of PDFs." : "Split marker removed.", added ? "success" : "info");
  };

  const reset = () => {
    update(sources.flatMap(pagesForSource));
    setSplitAfter(new Set());
  };

  const sourceFor = (item: PageItem) => sources.find((source) => source.id === item.sourceId);

  const referenceSize = (item: PageItem, fallback: { w: number; h: number }) => {
    const source = sourceFor(item);
    return source?.dims[item.page - 1] ?? fallback;
  };

  const buildSegment = async (
    segment: PageItem[],
    docs: Map<string, PDFDocument>,
    name: string,
    throwIfCancelled: () => void,
  ): Promise<{ bytes: Uint8Array; name: string }> => {
    const out = await PDFDocument.create();
    let fallback = { w: 595.28, h: 841.89 };
    for (const item of order) {
      const source = sourceFor(item);
      if (source?.dims[item.page - 1]) {
        fallback = source.dims[item.page - 1];
        break;
      }
    }
    for (let index = 0; index < segment.length; index++) {
      const item = segment[index];
      throwIfCancelled();
      if (item.blank) {
        const before = segment.slice(0, index).reverse().find((candidate) => !candidate.blank);
        const after = segment.slice(index + 1).find((candidate) => !candidate.blank);
        const reference = before ?? after;
        const size = reference ? referenceSize(reference, fallback) : fallback;
        out.addPage([size.w, size.h]);
        continue;
      }
      const doc = docs.get(item.sourceId);
      if (!doc) continue;
      const [copied] = await out.copyPages(doc, [item.page - 1]);
      if (item.rotation) {
        const current = copied.getRotation().angle;
        copied.setRotation(degrees((current + item.rotation + 360) % 360));
      }
      out.addPage(copied);
    }
    return { bytes: await out.save(), name };
  };

  const apply = () => {
    if (!sources.length) {
      setError("Add at least one PDF first.");
      return;
    }
    if (!order.length) {
      setError("Every page is removed. Add a blank page or reset the original order.");
      return;
    }
    setError("");
    void job.run(async ({ step, throwIfCancelled }) => {
      const docs = new Map<string, PDFDocument>();
      for (const source of sources) docs.set(source.id, await openPdfLib(source.bytes));
      const segments: PageItem[][] = [];
      let currentSegment: PageItem[] = [];
      for (const item of order) {
        throwIfCancelled();
        currentSegment.push(item);
        if (splitAfter.has(item.id)) {
          segments.push(currentSegment);
          currentSegment = [];
        }
      }
      if (currentSegment.length) segments.push(currentSegment);

      const single = sources.length === 1 ? sources[0] : null;
      const stem = single ? sanitizeName(baseName(single.file.name)) : "paperly-organized";
      const blank = order.filter((item) => item.blank).length;
      const rotated = order.filter((item) => item.rotation !== 0).length;

      if (segments.length <= 1) {
        step(1, 1, "Rebuilding the final PDF…", `${order.length} pages`);
        const built = await buildSegment(order, docs, `${stem}-organized.pdf`, throwIfCancelled);
        return { ...built, pages: order.length, files: 1, blank, rotated, mime: "application/pdf" };
      }

      const entries: { name: string; data: Uint8Array }[] = [];
      for (let index = 0; index < segments.length; index++) {
        step(index + 1, segments.length, "Building split documents…", `${index + 1} of ${segments.length}`);
        const built = await buildSegment(segments[index], docs, `${stem}-part-${String(index + 1).padStart(2, "0")}.pdf`, throwIfCancelled);
        entries.push({ name: built.name, data: built.bytes });
      }
      const zip = new JSZip();
      for (const entry of entries) zip.file(entry.name, entry.data);
      const bytes = new Uint8Array(await (await zip.generateAsync({ type: "blob", compression: "DEFLATE" })).arrayBuffer());
      return {
        bytes,
        name: `${stem}-split-${segments.length}-parts.zip`,
        pages: order.length,
        files: segments.length,
        blank,
        rotated,
        mime: "application/zip",
      };
    }).then((output) => {
      if (output) {
        setResult(output);
        showToast(output.files > 1 ? `${output.files} split PDFs packaged in one ZIP.` : "Final PDF ready — press ⌘/Ctrl+S to download.");
      }
    });
  };

  const download = () => {
    if (!result) return;
    downloadBytes(result.bytes, result.name, result.mime);
  };

  usePrimaryShortcut(apply, Boolean(sources.length) && order.length > 0 && !job.busy);
  useDownloadShortcut(download, Boolean(result));
  useEscape(() => {
    if (!sources.length || job.busy) return;
    reset();
    setResult(null);
    setError("");
    showToast("Workspace reset to the original page order.", "info");
  }, Boolean(sources.length) && !job.busy);

  const totalBytes = sources.reduce((sum, source) => sum + source.file.size, 0);
  const removed = sources.reduce((sum, source) => sum + source.pageCount, 0) - order.filter((item) => !item.blank).length;
  const splitCount = splitAfter.size + (splitAfter.size ? 1 : 0) || 1;

  return (
    <div className="space-y-5">
      {!sources.length ? (
        <FileDrop
          accept="application/pdf,.pdf"
          acceptLabel="PDF files to organize"
          multiple
          onFiles={(files) => void addFiles(files)}
          hint="Drop several PDFs to merge and organize every page in one grid. Up to 1,000 pages, processed in this tab."
        />
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 rounded-full bg-bone-deep px-2.5 py-1 text-[11.5px] font-medium text-ink/70">
              <Files className="h-3.5 w-3.5" /> {sources.length} source{sources.length === 1 ? "" : "s"} · {formatBytes(totalBytes)}
            </span>
            <span className="rounded-full bg-bone-deep px-2.5 py-1 text-[11.5px] font-medium text-ink/70">
              {order.length} of {sources.reduce((sum, source) => sum + source.pageCount, 0)} pages kept
            </span>
            <Button variant="ghost" size="sm" onClick={() => addRef.current?.click()} disabled={loading}>
              <Plus className="h-3.5 w-3.5" /> Add PDFs
            </Button>
            <input
              ref={addRef}
              type="file"
              accept="application/pdf,.pdf"
              multiple
              className="sr-only"
              aria-label="Add more PDFs"
              onChange={(event) => {
                const picked = Array.from(event.target.files ?? []);
                event.target.value = "";
                void addFiles(picked);
              }}
            />
            <span className="ml-auto flex flex-wrap gap-1.5">
              <Button variant="ghost" size="sm" onClick={() => update([...order].reverse())} disabled={order.length < 2}>
                Reverse order
              </Button>
              <Button variant="ghost" size="sm" onClick={reset}>
                Reset all
              </Button>
            </span>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {sources.map((source, index) => (
              <span key={source.id} className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-line bg-paper py-1 pl-2 pr-1 text-[11px]">
                <span className="flex h-4 w-4 items-center justify-center rounded bg-bone-deep font-mono text-[9px] font-bold text-forest">{index + 1}</span>
                <span className="max-w-[180px] truncate font-medium">{source.file.name}</span>
                <span className="font-mono text-[10px] text-muted">{source.pageCount}p</span>
                <button type="button" onClick={() => removeSource(source.id)} aria-label={`Remove ${source.file.name}`} className="rounded p-0.5 text-ink/50 hover:bg-clay/10 hover:text-clay-ink">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {loading && <Progress label="Opening PDFs and reading their pages locally…" />}
      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      {order.length > 0 && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => update(order.map((item) => ({ ...item, rotation: (item.rotation + 90) % 360 })))}
                disabled={!order.length}
              >
                <RotateCw className="h-3.5 w-3.5" /> Rotate all
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => update([...order, { id: nextId("page"), sourceId: "", page: 0, rotation: 0, blank: true }])}
              >
                <FilePlus2 className="h-3.5 w-3.5" /> Blank at end
              </Button>
            </div>
            <p className="flex items-center gap-1 text-[11px] text-muted">
              <Info className="h-3.5 w-3.5" /> Drag cards to reorder · split markers produce a ZIP
            </p>
          </div>

          {thumbsLoading && (
            <div className="flex items-center gap-2 rounded-lg bg-lime/20 px-3 py-2 text-[11.5px] font-medium text-forest">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Rendering previews {rendered}/{total}…
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {order.map((item, index) => {
              const source = sourceFor(item);
              const sourceIndex = source ? sources.findIndex((entry) => entry.id === source.id) + 1 : 0;
              const thumb = item.blank ? undefined : thumbs[`${item.sourceId}:${item.page}`];
              const split = splitAfter.has(item.id);
              return (
                <div
                  key={item.id}
                  draggable
                  onDragStart={() => setDragging(index)}
                  onDragEnd={() => setDragging(null)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (dragging !== null) reorder(dragging, index);
                    setDragging(null);
                  }}
                  className={cn(
                    "group relative cursor-grab overflow-hidden rounded-xl border bg-paper transition-all active:cursor-grabbing",
                    dragging === index ? "border-clay opacity-50" : split ? "border-clay/60" : "border-line hover:border-forest/40 hover:shadow-soft",
                  )}
                >
                  <div className="checker flex aspect-[3/4] items-center justify-center p-2">
                    {item.blank ? (
                      <div className="flex h-full w-full flex-col items-center justify-center gap-1 rounded border border-dashed border-ink/20 bg-paper text-[10px] uppercase tracking-[0.08em] text-ink/50">
                        <FilePlus2 className="h-4 w-4" />
                        Blank page
                      </div>
                    ) : thumb ? (
                      <img
                        src={thumb}
                        alt={`Preview of ${source?.file.name ?? "page"} page ${item.page}`}
                        className="max-h-full max-w-full rounded-sm border border-ink/5 bg-white pdf-page-shadow transition-transform duration-200"
                        style={{ transform: `rotate(${item.rotation}deg)` }}
                        draggable={false}
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <div className="flex h-full w-full animate-pulse items-center justify-center rounded bg-paper/70 text-[10px] text-ink/60">
                        {item.blank ? "blank" : `page ${item.page}`}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-1 border-t border-line px-1.5 py-1.5">
                    <span className="flex h-5 min-w-5 items-center justify-center rounded bg-bone-deep px-1 font-mono text-[10px] font-bold text-ink/70">{index + 1}</span>
                    <span className="min-w-0 truncate text-[10px] text-ink/60" title={source?.file.name}>
                      {item.blank ? "new blank" : `#${sourceIndex} · p.${item.page}`}
                    </span>
                    <div className="flex items-center gap-0.5">
                      <button type="button" aria-label={`Move page ${index + 1} earlier`} title="Move earlier" disabled={index === 0} onClick={() => reorder(index, index - 1)} className="rounded p-1 text-ink/60 hover:bg-ink/5 hover:text-forest disabled:opacity-20">
                        <ArrowUp className="h-3 w-3" />
                      </button>
                      <button type="button" aria-label={`Move page ${index + 1} later`} title="Move later" disabled={index === order.length - 1} onClick={() => reorder(index, index + 1)} className="rounded p-1 text-ink/60 hover:bg-ink/5 hover:text-forest disabled:opacity-20">
                        <ArrowDown className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Duplicate page ${index + 1}`}
                        title="Duplicate"
                        onClick={() => {
                          if (item.blank) return;
                          const next = [...order];
                          next.splice(index + 1, 0, { ...item, id: nextId("page") });
                          update(next);
                        }}
                        disabled={Boolean(item.blank)}
                        className="rounded p-1 text-ink/60 hover:bg-forest/10 hover:text-forest disabled:opacity-20"
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                      <button type="button" aria-label={`Rotate page ${index + 1}`} title="Rotate 90°" onClick={() => update(order.map((entry, i) => (i === index ? { ...entry, rotation: (entry.rotation + 90) % 360 } : entry)))} className="rounded p-1 text-ink/60 hover:bg-forest/10 hover:text-forest">
                        <RotateCw className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" aria-label={`Remove page ${index + 1}`} title="Remove" onClick={() => update(order.filter((_, i) => i !== index))} className="rounded p-1 text-ink/60 hover:bg-clay/10 hover:text-clay-ink">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1 border-t border-line/70 px-1.5 py-1 text-[10px] text-ink/60">
                    <button
                      type="button"
                      aria-label={`Insert blank page after page ${index + 1}`}
                      onClick={() => {
                        const next = [...order];
                        next.splice(index + 1, 0, { id: nextId("page"), sourceId: "", page: 0, rotation: 0, blank: true });
                        update(next);
                      }}
                      className="rounded px-1 py-0.5 hover:bg-forest/10 hover:text-forest"
                    >
                      + blank
                    </button>
                    <button type="button" aria-label={`Move page ${index + 1} to start`} disabled={index === 0} onClick={() => reorder(index, 0)} className="rounded px-1 py-0.5 hover:bg-forest/10 hover:text-forest disabled:opacity-30">
                      <ChevronsLeft className="inline h-3 w-3" />
                    </button>
                    <button type="button" aria-label={`Move page ${index + 1} to end`} disabled={index === order.length - 1} onClick={() => reorder(index, order.length - 1)} className="rounded px-1 py-0.5 hover:bg-forest/10 hover:text-forest disabled:opacity-30">
                      <ChevronsRight className="inline h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      aria-pressed={split}
                      aria-label={`${split ? "Remove" : "Add"} split after page ${index + 1}`}
                      onClick={() => toggleSplit(item.id)}
                      title={split ? "Remove split marker" : "Split after this page"}
                      className={cn("ml-auto inline-flex items-center gap-0.5 rounded px-1 py-0.5", split ? "bg-clay/15 font-semibold text-clay-ink" : "hover:bg-forest/10 hover:text-forest")}
                    >
                      <Scissors className="h-3 w-3" /> Split
                    </button>
                    {item.rotation !== 0 && <span className="font-bold text-forest">{item.rotation}°</span>}
                  </div>
                  <div className="pointer-events-none absolute left-2 top-2 rounded bg-ink/60 p-1 text-paper opacity-0 transition-opacity group-hover:opacity-100">
                    <GripVertical className="h-3.5 w-3.5" />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-line bg-bone-deep/30 px-3.5 py-2.5 text-[11.5px] text-ink/70">
            <span>
              <strong className="font-semibold text-ink">{sources.reduce((sum, source) => sum + source.pageCount, 0)}</strong> → {order.length} pages
            </span>
            {removed > 0 && <span className="text-clay-ink">{removed} removed</span>}
            {order.filter((item) => item.blank).length > 0 && <span>{order.filter((item) => item.blank).length} blank added</span>}
            {order.some((item) => item.rotation !== 0) && <span>rotated pages</span>}
            {splitAfter.size > 0 && <span className="font-semibold text-clay-ink">{splitCount} documents · ZIP export</span>}
          </div>

          {order.length === 0 && (
            <Alert tone="warning" title="Every page is removed">
              Add a blank page or reset to the original order to export something.
            </Alert>
          )}

          {job.error && <Alert tone="error">{job.error}</Alert>}
          {job.status === "cancelled" && <Alert tone="info">Cancelled — nothing was downloaded. Your page order is still here.</Alert>}

          <div className="flex flex-wrap items-center gap-2.5 border-t border-line pt-4">
            <Button onClick={apply} loading={job.busy} disabled={!order.length || job.busy}>
              <Check className="h-4 w-4" /> {splitAfter.size ? `Export ${splitCount} PDFs (ZIP)` : "Export final PDF"}
            </Button>
            {job.busy && (
              <Button variant="ghost" onClick={job.cancel}>
                Cancel
              </Button>
            )}
            <span className="text-[11.5px] text-muted">⌘/Ctrl+Enter exports · Esc resets the workspace</span>
          </div>
          {job.busy && <Progress value={job.percent ?? undefined} label={job.label} />}
        </>
      )}

      {toast && <Toast message={toast} onClose={() => setToast(null)} />}

      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title={result.files > 1 ? "Your split documents are ready" : "Your pages are in order"}
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          originalSize={totalBytes}
          mime={result.mime}
          onDownload={download}
          description={
            result.files > 1
              ? `${result.files} PDFs packaged in one ZIP · ${result.pages} pages from ${sources.length} source${sources.length === 1 ? "" : "s"}`
              : `${result.pages} pages reorganized · merged from ${sources.length} source${sources.length === 1 ? "" : "s"} · page order and rotation baked in`
          }
          facts={[
            { label: "Sources", value: String(sources.length) },
            ...(result.blank ? [{ label: "Blank pages", value: String(result.blank) }] : []),
            ...(result.rotated ? [{ label: "Rotated", value: `${result.rotated} pages` }] : []),
            ...(result.files > 1 ? [{ label: "Documents", value: String(result.files) }] : []),
          ]}
        />
      )}
    </div>
  );
}
