import {
  ArrowDown,
  ArrowUp,
  Check,
  Crop,
  GripVertical,
  Info,
  Loader2,
  Plus,
  RotateCw,
  Scissors,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  PDFDocument,
  baseName,
  degrees,
  downloadBytes,
  formatBytes,
  openPdfJs,
  openPdfLib,
  parseRanges,
  readFileBytes,
  sanitizeName,
  uniqueInOrder,
  zipAndDownload,
  type PDFPage,
} from "@/lib/pdf";
import { useInitialFiles, usePdfFile, usePdfThumbs } from "@/lib/usePdf";
import { friendlyProcessingError, validateUpload } from "@/lib/security";
import {
  Alert,
  Button,
  Field,
  FileDrop,
  FileRow,
  Progress,
  Segmented,
  StepHeader,
  inputClass,
} from "@/components/ui";
import { DownloadPanel, RangeField, SinglePdfInput } from "@/components/toolParts";
import { cn } from "@/utils/cn";

/* ================================================================== *
 * MERGE
 * ================================================================== */
function usePageCounts(files: File[]): (number | null)[] {
  const [counts, setCounts] = useState<(number | null)[]>(() => files.map(() => null));
  useEffect(() => {
    let alive = true;
    setCounts(files.map(() => null));
    (async () => {
      const next: (number | null)[] = [];
      for (const file of files) {
        try {
          const doc = await openPdfJs(await readFileBytes(file));
          next.push(doc.numPages);
          await doc.destroy();
        } catch {
          next.push(null);
        }
        if (!alive) return;
        setCounts([...next, ...files.slice(next.length).map(() => null)]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [files]);
  return counts;
}

export function MergeTool() {
  const initial = useInitialFiles().filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
  const [files, setFiles] = useState<File[]>(initial);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; pages: number; sources: number } | null>(null);
  const counts = usePageCounts(files);

  const totalPages = counts.reduce<number>((sum, n) => sum + (n ?? 0), 0);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= files.length) return;
    const next = [...files];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setFiles(next);
    setResult(null);
  };

  const merge = async () => {
    setError("");
    if (files.length < 2) {
      setError("Add at least two PDFs to merge.");
      return;
    }
    setBusy(true);
    setProgress(0);
    try {
      const out = await PDFDocument.create();
      let pages = 0;
      for (let i = 0; i < files.length; i++) {
        const src = await openPdfLib(await readFileBytes(files[i]));
        const copied = await out.copyPages(src, src.getPageIndices());
        copied.forEach((p) => out.addPage(p));
        pages += copied.length;
        setProgress(((i + 1) / files.length) * 100);
      }
      const bytes = await out.save();
      setResult({
        bytes,
        name: `${sanitizeName(baseName(files[0].name))}-merged.pdf`,
        pages,
        sources: files.length,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <StepHeader step={1} title="Choose your PDFs" hint="Two or more" />
      {files.length === 0 ? (
        <FileDrop
          accept="application/pdf,.pdf"
          acceptLabel="PDF files"
          multiple
          onFiles={(picked) => {
            setFiles(picked.filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf"));
            setResult(null);
          }}
        />
      ) : (
        <div className="space-y-2">
          {files.map((file, i) => (
            <FileRow
              key={`${file.name}-${file.size}-${i}`}
              file={file}
              index={i}
              size={counts[i] ? `${counts[i]} pages · ${formatBytes(file.size)}` : "Reading…"}
              onRemove={() => {
                setFiles(files.filter((_, idx) => idx !== i));
                setResult(null);
              }}
            >
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  aria-label={`Move ${file.name} up`}
                  onClick={() => move(i, i - 1)}
                  disabled={i === 0}
                  className="rounded-md p-1.5 text-ink/75 hover:bg-ink/5 hover:text-forest disabled:opacity-20"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${file.name} down`}
                  onClick={() => move(i, i + 1)}
                  disabled={i === files.length - 1}
                  className="rounded-md p-1.5 text-ink/75 hover:bg-ink/5 hover:text-forest disabled:opacity-20"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
              </div>
            </FileRow>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-paper px-3 py-2 text-[12px] font-medium text-ink/75 hover:border-forest/30">
              <Plus className="h-3.5 w-3.5" /> Add more PDFs
              <input
                type="file"
                accept="application/pdf,.pdf"
                multiple
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
                    setFiles([...files, ...valid]);
                    setResult(null);
                  }
                  setError(problems.join(" "));
                }}
              />
            </label>
            <span className="text-[11.5px] text-muted">
              {files.length} files · {totalPages || "…"} pages total
            </span>
          </div>
        </div>
      )}

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex flex-wrap items-center gap-2.5 border-t border-line pt-4">
        <Button onClick={merge} loading={busy} disabled={files.length < 2 || busy}>
          {busy ? "Merging locally…" : "Merge PDF"}
        </Button>
        {files.length > 0 && !busy && (
          <Button variant="ghost" onClick={() => { setFiles([]); setResult(null); setError(""); }}>
            Clear all
          </Button>
        )}
      </div>
      {busy && <Progress value={progress} label="Merging pages in your browser…" />}

      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title={`${result.sources} PDFs became one`}
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${result.pages} pages · ${formatBytes(result.bytes.byteLength)} · order preserved exactly as shown`}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * SPLIT
 * ================================================================== */
type SplitMode = "extract" | "single" | "custom";

async function copyPagesToPdf(src: PDFDocument, pageNums: number[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, pageNums.map((n) => n - 1));
  copied.forEach((p) => out.addPage(p));
  return out.save();
}

export function SplitTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [mode, setMode] = useState<SplitMode>("extract");
  const [range, setRange] = useState("");
  const [custom, setCustom] = useState("1-3\n4-6");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  type Result =
    | { kind: "pdf"; bytes: Uint8Array; name: string; pages: number }
    | { kind: "zip"; entries: { name: string; bytes: Uint8Array }[]; name: string; pages: number };
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    setResult(null);
    setError("");
  }, [pdf.bytes, mode]);

  const split = async () => {
    if (!pdf.bytes || !pdf.file) return;
    setError("");
    setBusy(true);
    setProgress(4);
    try {
      const src = await openPdfLib(pdf.bytes);
      const total = src.getPageCount();
      const base = sanitizeName(baseName(pdf.file.name));
      if (mode === "extract") {
        const pages = uniqueInOrder(parseRanges(range, total));
        const bytes = await copyPagesToPdf(src, pages);
        setResult({ kind: "pdf", bytes, name: `${base}-pages-${pages.length}.pdf`, pages: pages.length });
      } else {
        let groups: { name: string; pages: number[] }[] = [];
        if (mode === "single") {
          groups = Array.from({ length: total }, (_, i) => ({
            name: `${base}-page-${i + 1}.pdf`,
            pages: [i + 1],
          }));
        } else {
          const lines = custom.split("\n").map((l) => l.trim()).filter(Boolean);
          if (!lines.length) throw new Error("Add at least one page range, one per line.");
          groups = lines.map((line, i) => ({
            name: `${base}-part-${i + 1}.pdf`,
            pages: uniqueInOrder(parseRanges(line, total)),
          }));
        }
        const entries: { name: string; bytes: Uint8Array }[] = [];
        for (let i = 0; i < groups.length; i++) {
          entries.push({ name: groups[i].name, bytes: await copyPagesToPdf(src, groups[i].pages) });
          setProgress(((i + 1) / groups.length) * 100);
        }
        setResult({
          kind: "zip",
          entries,
          name: `${base}-split.zip`,
          pages: groups.reduce((sum, g) => sum + g.pages.length, 0),
        });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to split" />

      {pdf.bytes && (
        <>
          <div className="border-t border-line pt-4">
            <StepHeader step={2} title="How should we split it?" />
            <Segmented
              value={mode}
              onChange={setMode}
              className="sm:grid-cols-3"
              options={[
                { value: "extract", label: "Extract a range", hint: "One PDF out" },
                { value: "single", label: "Every page", hint: "ZIP of single pages" },
                { value: "custom", label: "Custom parts", hint: "One range per line" },
              ]}
            />
          </div>

          {mode === "extract" && (
            <RangeField value={range} onChange={setRange} total={pdf.pageCount} label="Pages to keep" hint="Leave empty to keep every page. Use 1-3, 5, 8-10." />
          )}
          {mode === "custom" && (
            <Field
              label="One output PDF per line"
              hint="Each line becomes a separate PDF. Example: 1-3 then 4,6,8 then 9-12."
            >
              <textarea
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                rows={4}
                className={cn(inputClass, "h-auto py-2.5 font-mono text-[13px]")}
                spellCheck={false}
              />
            </Field>
          )}
          {mode === "single" && (
            <Alert tone="info">
              This will produce {pdf.pageCount} separate PDF{pdf.pageCount === 1 ? "" : "s"}, packaged into a single ZIP. Each keeps its original quality.
            </Alert>
          )}

          {error && <Alert tone="error">{error}</Alert>}
          <div className="flex flex-wrap items-center gap-2.5 border-t border-line pt-4">
            <Button onClick={split} loading={busy}>
              <Scissors className="h-4 w-4" /> {mode === "extract" ? "Extract pages" : "Split PDF"}
            </Button>
            <span className="text-[11.5px] text-muted">Original quality · no re-rendering</span>
          </div>
          {busy && <Progress value={progress} label="Cutting your PDF into new files…" />}
        </>
      )}

      {result && (
        <DownloadPanel
          bytes={result.kind === "pdf" ? result.bytes : undefined}
          title={result.kind === "zip" ? `Your ${result.entries.length} files are ready` : "Your extracted PDF is ready"}
          filename={result.kind === "zip" ? result.name : result.name}
          size={
            result.kind === "zip"
              ? result.entries.reduce((sum, e) => sum + e.bytes.byteLength, 0)
              : result.bytes.byteLength
          }
          pages={result.pages}
          description={
            result.kind === "zip"
              ? `${result.entries.length} separate PDFs in one ZIP · no page content changed`
              : `${result.pages} page${result.pages === 1 ? "" : "s"} extracted with original quality`
          }
          onDownload={() => {
            if (result.kind === "pdf") downloadBytes(result.bytes, result.name);
            else void zipAndDownload(result.entries.map((e) => ({ name: e.name, data: e.bytes })), result.name);
          }}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * ORGANIZE
 * ================================================================== */
interface PageItem {
  id: string;
  page: number;
  rotation: number;
}

export function OrganizeTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const { thumbs, loading: thumbsLoading, total } = usePdfThumbs(pdf.bytes, { width: 200, quality: 0.75 });
  const [order, setOrder] = useState<PageItem[]>([]);
  const [dragging, setDragging] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string } | null>(null);

  useEffect(() => {
    setOrder(
      Array.from({ length: pdf.pageCount }, (_, i) => ({
        id: `${i + 1}-${Math.random().toString(36).slice(2, 7)}`,
        page: i + 1,
        rotation: 0,
      })),
    );
    setResult(null);
    setError("");
  }, [pdf.bytes, pdf.pageCount]);

  const thumbFor = (page: number) => thumbs.find((t) => t.page === page);
  const changed = order.length !== pdf.pageCount || order.some((item) => item.rotation !== 0) || order.some((item, i) => item.page !== i + 1);

  const reorder = (from: number, to: number) => {
    if (from === to) return;
    const next = [...order];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setOrder(next);
    setResult(null);
  };

  const apply = async () => {
    if (!pdf.bytes || !pdf.file) return;
    if (!order.length) {
      setError("This PDF has no pages left. Undo some removals and try again.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const src = await openPdfLib(pdf.bytes);
      const out = await PDFDocument.create();
      for (let i = 0; i < order.length; i++) {
        const [copied] = await out.copyPages(src, [order[i].page - 1]);
        if (order[i].rotation) {
          const current = copied.getRotation().angle;
          copied.setRotation(degrees((current + order[i].rotation + 360) % 360));
        }
        out.addPage(copied);
      }
      const bytes = await out.save();
      setResult({ bytes, name: `${sanitizeName(baseName(pdf.file.name))}-organized.pdf` });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {!pdf.file ? (
        <FileDrop accept="application/pdf,.pdf" acceptLabel="A PDF to organize" onFiles={(f) => pdf.setFile(f[0])} />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <FileRow
            file={pdf.file}
            onRemove={pdf.clear}
            size={pdf.loading ? "Reading…" : `${pdf.pageCount} pages · ${formatBytes(pdf.file.size)}`}
          />
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-bone-deep px-2.5 py-1 text-[11.5px] font-medium text-ink/70">
              {order.length} of {pdf.pageCount} kept
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setOrder(
                  Array.from({ length: pdf.pageCount }, (_, i) => ({
                    id: `${i + 1}-reset-${Math.random().toString(36).slice(2, 6)}`,
                    page: i + 1,
                    rotation: 0,
                  })),
                );
                setResult(null);
              }}
            >
              Reset
            </Button>
          </div>
        </div>
      )}

      {pdf.error && <Alert tone="error">{pdf.error}</Alert>}
      {pdf.loading && <Progress label="Reading and rendering pages locally…" />}

      {pdf.bytes && (
        <>
          {thumbsLoading && order.length > 0 && (
            <div className="flex items-center gap-2 rounded-lg bg-lime/20 px-3 py-2 text-[11.5px] font-medium text-forest">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Rendering previews {thumbs.length}/{total}…
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {order.map((item, index) => {
              const thumb = thumbFor(item.page);
              return (
                <div
                  key={item.id}
                  draggable
                  onDragStart={() => setDragging(index)}
                  onDragEnd={() => setDragging(null)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragging !== null) reorder(dragging, index);
                    setDragging(null);
                  }}
                  className={cn(
                    "group relative cursor-grab overflow-hidden rounded-xl border bg-white transition-all active:cursor-grabbing",
                    dragging === index ? "border-clay opacity-50" : "border-line hover:border-forest/40 hover:shadow-soft",
                  )}
                >
                  <div className="checker flex aspect-[3/4] items-center justify-center p-2">
                    {thumb ? (
                      <img
                        src={thumb.dataUrl}
                        alt={`Page ${item.page}`}
                        className="max-h-full max-w-full rounded-sm border border-ink/5 bg-white pdf-page-shadow transition-transform duration-200"
                        style={{ transform: `rotate(${item.rotation}deg)` }}
                        draggable={false}
                      loading="lazy" decoding="async" />
                    ) : (
                      <div className="flex h-full w-full animate-pulse items-center justify-center rounded bg-white/70 text-[10px] text-ink/70">
                        page {item.page}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-1 border-t border-line px-1.5 py-1.5">
                    <span className="flex h-5 min-w-5 items-center justify-center rounded bg-bone-deep px-1 text-[10.5px] font-bold tabular-nums text-ink/70">
                      {index + 1}
                    </span>
                    <span className="text-[10px] text-ink/75">from p.{item.page}</span>
                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        aria-label={`Rotate page ${index + 1}`}
                        onClick={() => {
                          setOrder(order.map((o, i) => (i === index ? { ...o, rotation: (o.rotation + 90) % 360 } : o)));
                          setResult(null);
                        }}
                        className="rounded p-1 text-ink/75 hover:bg-forest/10 hover:text-forest"
                      >
                        <RotateCw className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove page ${index + 1}`}
                        onClick={() => {
                          setOrder(order.filter((_, i) => i !== index));
                          setResult(null);
                        }}
                        className="rounded p-1 text-ink/75 hover:bg-clay/10 hover:text-clay-ink"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="pointer-events-none absolute left-2 top-2 rounded bg-ink/60 p-1 text-paper opacity-0 transition-opacity group-hover:opacity-100">
                    <GripVertical className="h-3.5 w-3.5" />
                  </div>
                  {item.rotation !== 0 && (
                    <span className="absolute right-2 top-2 rounded-full bg-forest px-1.5 py-0.5 text-[9px] font-bold text-lime">
                      {item.rotation}°
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <p className="flex items-center gap-1.5 text-[11.5px] text-muted">
            <Info className="h-3.5 w-3.5" /> Drag pages to reorder. Rotate or remove with the controls on each page.
          </p>

          {error && <Alert tone="error">{error}</Alert>}
          <div className="flex flex-wrap items-center gap-2.5 border-t border-line pt-4">
            <Button onClick={apply} loading={busy} disabled={!order.length || busy}>
              <Check className="h-4 w-4" /> Apply changes
            </Button>
            <span className="text-[11.5px] text-muted">
              {changed ? "Unsaved changes to page order" : "Original order"}
            </span>
          </div>
        </>
      )}

      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Your pages are in order"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={order.length}
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${order.length} pages reorganized · page order and rotation baked in`}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * ROTATE
 * ================================================================== */
export function RotateTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const { thumbs, loading: thumbsLoading } = usePdfThumbs(pdf.bytes, { width: 150, quality: 0.7, max: 40 });
  const [angle, setAngle] = useState<90 | 180 | 270>(90);
  const [range, setRange] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; pages: number } | null>(null);

  const apply = async () => {
    if (!pdf.bytes || !pdf.file) return;
    setBusy(true);
    setError("");
    try {
      const pages = uniqueInOrder(parseRanges(range, pdf.pageCount));
      const doc = await openPdfLib(pdf.bytes);
      const all = doc.getPages();
      pages.forEach((n) => {
        const page = all[n - 1];
        const current = page.getRotation().angle;
        page.setRotation(degrees((current + angle) % 360));
      });
      const bytes = await doc.save();
      setResult({ bytes, name: `${sanitizeName(baseName(pdf.file.name))}-rotated.pdf`, pages: pages.length });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to rotate" />
      {pdf.bytes && (
        <>
          <div>
            <StepHeader step={2} title="Choose rotation" />
            <Segmented
              value={String(angle) as "90" | "180" | "270"}
              onChange={(v) => {
                setAngle(Number(v) as 90 | 180 | 270);
                setResult(null);
              }}
              options={[
                { value: "90", label: "90° right", icon: <RotateCw className="h-3.5 w-3.5" /> },
                { value: "180", label: "Upside down", icon: <RotateCw className="h-3.5 w-3.5 rotate-180" /> },
                { value: "270", label: "90° left", icon: <RotateCw className="h-3.5 w-3.5 -scale-x-100" /> },
              ]}
            />
          </div>
          <RangeField
            value={range}
            onChange={(v) => {
              setRange(v);
              setResult(null);
            }}
            total={pdf.pageCount}
            label="Pages to rotate"
            hint="Leave empty to rotate every page."
          />
          {thumbs.length > 0 && (
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/75">
                Preview · current page orientation
              </p>
              <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-thin">
                {thumbs.slice(0, 12).map((t) => (
                  <div key={t.page} className="w-16 shrink-0">
                    <div className="overflow-hidden rounded border border-line bg-white">
                      <img src={t.dataUrl} alt={`Page ${t.page}`} className="w-full" loading="lazy" decoding="async" />
                    </div>
                    <p className="mt-1 text-center text-[10px] text-ink/75">p.{t.page}</p>
                  </div>
                ))}
                {thumbs.length > 12 && <div className="flex w-16 shrink-0 items-center justify-center text-[10px] text-muted">+{pdf.pageCount - 12} more</div>}
                {thumbsLoading && <Loader2 className="mt-6 h-4 w-4 animate-spin text-forest" />}
              </div>
            </div>
          )}
          {error && <Alert tone="error">{error}</Alert>}
          <div className="border-t border-line pt-4">
            <Button onClick={apply} loading={busy}>
              <RotateCw className="h-4 w-4" /> Rotate {angle}° {range ? "selected pages" : "all pages"}
            </Button>
          </div>
        </>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Pages turned"
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
 * CROP
 * ================================================================== */
const MM = 2.834645669;

export function CropTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const { thumbs } = usePdfThumbs(pdf.bytes, { width: 420, quality: 0.8, max: 1 });
  const [top, setTop] = useState(8);
  const [right, setRight] = useState(8);
  const [bottom, setBottom] = useState(8);
  const [left, setLeft] = useState(8);
  const [range, setRange] = useState("");
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; pages: number } | null>(null);

  useEffect(() => {
    if (!pdf.bytes) {
      setSize(null);
      return;
    }
    let alive = true;
    const bytes = pdf.bytes;
    (async () => {
      const doc = await openPdfLib(bytes);
      const page = doc.getPage(0);
      if (alive) setSize({ width: page.getWidth(), height: page.getHeight() });
    })().catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [pdf.bytes]);

  const horizontal = size ? ((left + right) * MM) / size.width : 0;
  const vertical = size ? ((top + bottom) * MM) / size.height : 0;
  const invalid = horizontal >= 1 || vertical >= 1;

  const apply = async () => {
    if (!pdf.bytes || !pdf.file) return;
    setBusy(true);
    setError("");
    try {
      if (!top && !right && !bottom && !left) throw new Error("Set at least one margin to crop.");
      if (invalid) throw new Error("Those margins are larger than the page. Reduce them and try again.");
      const pages = uniqueInOrder(parseRanges(range, pdf.pageCount));
      const doc = await openPdfLib(pdf.bytes);
      const all = doc.getPages();
      pages.forEach((n) => {
        const page: PDFPage = all[n - 1];
        const box = page.getCropBox();
        const w = box.width - (left + right) * MM;
        const h = box.height - (top + bottom) * MM;
        if (w < 36 || h < 36) return;
        page.setCropBox(box.x + left * MM, box.y + bottom * MM, w, h);
      });
      const bytes = await doc.save();
      setResult({ bytes, name: `${sanitizeName(baseName(pdf.file.name))}-cropped.pdf`, pages: pages.length });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setTop(0);
    setRight(0);
    setBottom(0);
    setLeft(0);
    setResult(null);
  };

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to crop" />
      {pdf.bytes && (
        <>
          <div className="flex flex-wrap gap-2">
            {[
              { label: "Trim scan edges", t: 6, r: 6, b: 6, l: 6 },
              { label: "Wide white margins", t: 14, r: 10, b: 14, l: 10 },
              { label: "Remove header strip", t: 22, r: 0, b: 0, l: 0 },
            ].map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => {
                  setTop(preset.t);
                  setRight(preset.r);
                  setBottom(preset.b);
                  setLeft(preset.l);
                  setResult(null);
                }}
                className="rounded-full border border-line bg-paper px-3 py-1.5 text-[11.5px] font-medium text-ink/75 transition-colors hover:border-forest/35 hover:text-forest"
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div className="grid gap-5 sm:grid-cols-[1fr_220px]">
            <div className="space-y-4">
              <StepHeader step={2} title="Margins to trim" hint="In millimetres" />
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: "Top", value: top, set: setTop },
                  { label: "Bottom", value: bottom, set: setBottom },
                  { label: "Left", value: left, set: setLeft },
                  { label: "Right", value: right, set: setRight },
                ].map((m) => (
                  <Field key={m.label} label={m.label}>
                    <div className="relative">
                      <input
                        type="number"
                        min={0}
                        max={200}
                        step={1}
                        value={m.value}
                        onChange={(e) => {
                          m.set(Math.max(0, Math.min(200, Number(e.target.value) || 0)));
                          setResult(null);
                        }}
                        className={cn(inputClass, "pr-9 tabular-nums")}
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-medium text-ink/75">mm</span>
                    </div>
                  </Field>
                ))}
              </div>
              <RangeField
                value={range}
                onChange={(v) => {
                  setRange(v);
                  setResult(null);
                }}
                total={pdf.pageCount}
                label="Pages to crop"
                hint="Leave empty to crop all pages uniformly."
              />
            </div>

            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/75">Preview</p>
              <div className="relative overflow-hidden rounded-lg border border-line bg-white p-2.5">
                {thumbs[0] ? (
                  <div className="relative">
                    <img src={thumbs[0].dataUrl} alt="First page preview" className="w-full opacity-80" loading="lazy" decoding="async" />
                    <div
                      className="pointer-events-none absolute border-2 border-clay bg-clay/10"
                      style={{
                        top: `${Math.min(45, Math.max(0, vertical * 50))}%`,
                        bottom: `${Math.min(45, Math.max(0, vertical * 50))}%`,
                        left: `${Math.min(45, Math.max(0, horizontal * 50))}%`,
                        right: `${Math.min(45, Math.max(0, horizontal * 50))}%`,
                      }}
                    />
                  </div>
                ) : (
                  <div className="flex aspect-[3/4] animate-pulse items-center justify-center bg-bone-deep text-[11px] text-ink/70">
                    Rendering preview…
                  </div>
                )}
              </div>
              <p className="mt-1.5 text-[10.5px] leading-snug text-muted">
                The highlighted area is what remains. Margins apply to the current page edge.
              </p>
            </div>
          </div>

          {error && <Alert tone="error">{error}</Alert>}
          <div className="flex items-center gap-2 border-t border-line pt-4">
            <Button onClick={apply} loading={busy} disabled={invalid}>
              <Crop className="h-4 w-4" /> Crop PDF
            </Button>
            <Button variant="ghost" onClick={reset}>
              Reset margins
            </Button>
          </div>
        </>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Margins trimmed"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          onDownload={() => downloadBytes(result.bytes, result.name)}
        />
      )}
    </div>
  );
}
