import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronsLeft,
  ChevronsRight,
  Copy,
  Crop,
  FilePlus2,
  GripVertical,
  Info,
  Loader2,
  Plus,
  RotateCcw,
  RotateCw,
  Scissors,
  Trash2,
  Wand2,
} from "lucide-react";
import JSZip from "jszip";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  PDFDocument,
  baseName,
  degrees,
  downloadBytes,
  formatBytes,
  getPageDimensions,
  openPdfJs,
  openPdfLib,
  parseRanges,
  readFileBytes,
  sanitizeName,
  uniqueInOrder,
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
import { PagePicker } from "@/components/PagePicker";
import {
  AdvancedOptions,
  NumberField,
  OptionNote,
  OptionsGrid,
  PresetChips,
} from "@/components/AdvancedOptions";
import { describeJobTime, useJob, type JobController, type JobReporter } from "@/lib/job";
import { useDownloadShortcut, usePrimaryShortcut } from "@/lib/hotkeys";
import { useToolPreferences } from "@/lib/prefs";
import { pagesToQuery, parsePageQuery, validatePageQuery } from "@/lib/pageQuery";
import { downloadOutput } from "@/lib/output";
import { writeOutline, type OutlineEntry } from "@/lib/outline";
import { SAMPLE } from "@/lib/sample";
import { cn } from "@/utils/cn";

/* ================================================================== *
 * Shared helpers
 * ================================================================== */

let sharedId = 0;
function nextId(prefix: string): string {
  sharedId += 1;
  return `${prefix}-${sharedId}`;
}

const isPdf = (file: File) => /\.pdf$/i.test(file.name) || file.type === "application/pdf";

/**
 * One cancellable runner per tool. The job owns progress, ETA, cancel and
 * error copy; `result` is kept separately so cancelling or failing never
 * throws away the previous download.
 */
function useRunner<T>() {
  const job = useJob<T>();
  const [result, setResult] = useState<T | null>(null);
  const { run: startJob, reset: resetJob } = job;
  const run = useCallback(
    async (task: (reporter: JobReporter) => Promise<T>) => {
      const value = await startJob(task);
      if (value !== null) setResult(value);
      return value;
    },
    [startJob],
  );
  const clear = useCallback(() => {
    setResult(null);
    resetJob();
  }, [resetJob]);
  return { job, result, run, clear };
}

/** Compact multi-row mode picker (scroll-free on phones). */
function ModeGrid<T extends string>({
  value,
  onChange,
  options,
  columns = 3,
  label = "Mode",
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; hint?: string }[];
  columns?: 2 | 3;
  label?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn("grid gap-2", columns === 2 ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3")}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-xl border px-2.5 py-2 text-left transition-colors",
              active ? "border-forest bg-forest text-paper" : "border-line bg-paper text-ink/70 hover:border-forest/30",
            )}
          >
            <span className="block text-[12.5px] font-semibold leading-tight">{option.label}</span>
            {option.hint ? (
              <span className={cn("mt-0.5 block text-[10.5px] leading-snug", active ? "text-paper/70" : "text-muted")}>{option.hint}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function JobProgress<T>({ job }: { job: JobController<T> }) {
  return (
    <Progress
      value={job.percent ?? undefined}
      label={job.label}
      etaMs={job.etaMs}
      detail={describeJobTime(job)}
    />
  );
}

function JobError<T>({ job }: { job: JobController<T> }) {
  if (!job.failed) return null;
  return (
    <Alert tone="error" title="That didn’t work">
      {job.error}
    </Alert>
  );
}

function CancelledNote<T>({ job }: { job: JobController<T> }) {
  if (job.status !== "cancelled") return null;
  return <Alert tone="info">Cancelled — nothing was downloaded. Your settings and files are still here.</Alert>;
}

/* ================================================================== *
 * MERGE
 * ================================================================== */
type MergeMode = "sequential" | "interleave";

interface MergeItem {
  id: string;
  file: File;
  range: string;
}

interface MergeResult {
  bytes: Uint8Array;
  name: string;
  pages: number;
  sources: number;
  mode: MergeMode;
  bookmarks: number;
}

function usePageCounts(files: File[]): (number | null)[] {
  const [counts, setCounts] = useState<(number | null)[]>(() => files.map(() => null));
  // Keyed on the actual files, not the array identity, so editing a per-file page
  // range never re-reads every PDF.
  const signature = files.map((file) => `${file.name}|${file.size}|${file.lastModified}`).join("\u0000");
  useEffect(() => {
    let alive = true;
    const list = signature ? signature.split("\u0000") : [];
    setCounts(list.map(() => null));
    (async () => {
      const next: (number | null)[] = [];
      for (let index = 0; index < list.length; index++) {
        try {
          const doc = await openPdfJs(await readFileBytes(files[index]));
          next.push(doc.numPages);
          await doc.destroy();
        } catch {
          next.push(null);
        }
        if (!alive) return;
        setCounts([...next, ...list.slice(next.length).map(() => null)]);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signature covers every file field used
  }, [signature]);
  return counts;
}

export function MergeTool() {
  const initial = useInitialFiles().filter(isPdf);
  const [items, setItems] = useState<MergeItem[]>(() =>
    initial.map((file) => ({ id: nextId("merge"), file, range: "" })),
  );
  const [mode, setMode] = useState<MergeMode>("sequential");
  const [error, setError] = useState("");
  const prefs = useToolPreferences("merge", { bookmarks: false, documentTitles: true });
  const { job, result, run, clear } = useRunner<MergeResult>();

  const files = useMemo(() => items.map((item) => item.file), [items]);
  const counts = usePageCounts(files);

  const ranges = useMemo(
    () =>
      items.map((item, index) => {
        const count = counts[index];
        if (!item.range.trim()) return { pages: null as number[] | null, problem: "" };
        if (!count) return { pages: null as number[] | null, problem: "" };
        const problem = validatePageQuery(item.range, count);
        if (problem) return { pages: null as number[] | null, problem: `${item.file.name}: ${problem}` };
        try {
          return { pages: parsePageQuery(item.range, count), problem: "" };
        } catch (err) {
          return { pages: null as number[] | null, problem: `${item.file.name}: ${(err as Error).message}` };
        }
      }),
    [items, counts],
  );

  const rangeProblem = ranges.find((entry) => entry.problem)?.problem ?? "";
  const selectedPages = ranges.reduce((sum, entry, index) => sum + (entry.pages?.length ?? counts[index] ?? 0), 0);
  const totalSize = items.reduce((sum, item) => sum + item.file.size, 0);
  const duplicateNames = useMemo(() => {
    const seen = new Map<string, number>();
    items.forEach((item) => seen.set(item.file.name, (seen.get(item.file.name) ?? 0) + 1));
    return [...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name);
  }, [items]);

  const merge = () => {
    setError("");
    if (items.length < 2) {
      setError("Add at least two PDFs to merge.");
      return;
    }
    if (rangeProblem) {
      setError(rangeProblem);
      return;
    }
    void run(async ({ step, throwIfCancelled }) => {
      const sources: { doc: PDFDocument; pages: number[] }[] = [];
      for (let i = 0; i < items.length; i++) {
        throwIfCancelled();
        const doc = await openPdfLib(await readFileBytes(items[i].file));
        const total = doc.getPageCount();
        const problem = validatePageQuery(items[i].range, total);
        if (problem) throw new Error(`${items[i].file.name}: ${problem}`);
        const pages = parsePageQuery(items[i].range, total);
        sources.push({ doc, pages: pages.map((page) => page - 1) });
        step(i + 1, items.length * 2, `Reading ${items[i].file.name}…`, `${i + 1} of ${items.length} files`);
      }

      const out = await PDFDocument.create();
      const firstOutputPage = new Map<number, number>();
      let written = 0;

      if (mode === "sequential") {
        for (let i = 0; i < sources.length; i++) {
          throwIfCancelled();
          firstOutputPage.set(i, written + 1);
          const copied = await out.copyPages(sources[i].doc, sources[i].pages);
          copied.forEach((page) => out.addPage(page));
          written += copied.length;
          step(sources.length + i + 1, sources.length * 2, "Merging pages…", `${i + 1} of ${sources.length} files`);
        }
      } else {
        const rounds = Math.max(...sources.map((source) => source.pages.length));
        for (let round = 0; round < rounds; round++) {
          throwIfCancelled();
          for (let i = 0; i < sources.length; i++) {
            const pageIndex = sources[i].pages[round];
            if (pageIndex === undefined) continue;
            if (!firstOutputPage.has(i)) firstOutputPage.set(i, written + 1);
            const [copied] = await out.copyPages(sources[i].doc, [pageIndex]);
            out.addPage(copied);
            written += 1;
          }
          step(sources.length + round + 1, sources.length + rounds, "Interleaving pages…", `round ${round + 1} of ${rounds}`);
        }
      }

      let bookmarks = 0;
      if (prefs.value.bookmarks) {
        const entries: OutlineEntry[] = sources.map((source, i) => {
          const raw = prefs.value.documentTitles ? source.doc.getTitle() || "" : "";
          const title = (raw || baseName(items[i].file.name)).replace(/\s+/g, " ").trim() || `Part ${i + 1}`;
          return { id: `merge-${i}`, title: title.slice(0, 120), page: firstOutputPage.get(i) ?? 1, level: 1 };
        });
        writeOutline(out, entries);
        bookmarks = entries.length;
      }

      const bytes = await out.save();
      return {
        bytes,
        name: `${sanitizeName(baseName(items[0].file.name))}-merged.pdf`,
        pages: written,
        sources: sources.length,
        mode,
        bookmarks,
      };
    });
  };

  usePrimaryShortcut(merge, items.length >= 2 && !job.busy && !rangeProblem);
  useDownloadShortcut(
    () => {
      if (result) downloadOutput(result.bytes, result.name, "application/pdf");
    },
    Boolean(result),
  );

  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setItems(next);
    clear();
  };

  const updateRange = (id: string, range: string) => {
    setItems(items.map((item) => (item.id === id ? { ...item, range } : item)));
    clear();
  };

  const addFiles = async (candidates: File[]) => {
    const valid: File[] = [];
    const problems: string[] = [];
    for (const candidate of candidates) {
      try {
        await validateUpload(candidate, "application/pdf,.pdf");
        if (isPdf(candidate)) valid.push(candidate);
      } catch (err) {
        problems.push(friendlyProcessingError(err, `${candidate.name} couldn’t be added.`));
      }
    }
    setError(problems.join(" "));
    if (valid.length) {
      setItems([...items, ...valid.map((file) => ({ id: nextId("merge"), file, range: "" }))]);
      clear();
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <StepHeader step={1} title="Choose your PDFs" hint="Two or more" />
        {items.length === 0 ? (
          <FileDrop
            accept="application/pdf,.pdf"
            acceptLabel="PDF files"
            multiple
            sample={SAMPLE.pdf}
            hint="Order matters: files merge top to bottom. Drag to reorder, or set a page range per file."
            onFiles={(picked) => {
              const valid = picked.filter(isPdf);
              if (!valid.length) return;
              setItems(valid.map((file) => ({ id: nextId("merge"), file, range: "" })));
              setError("");
              clear();
            }}
          />
        ) : (
          <div className="space-y-3">
            {items.map((item, i) => {
              const hint = ranges[i];
              const count = counts[i];
              return (
                <div key={item.id} className="space-y-1.5">
                  <FileRow
                    file={item.file}
                    index={i}
                    size={count ? `${count} pages · ${formatBytes(item.file.size)}` : "Reading…"}
                    onRemove={() => {
                      setItems(items.filter((_, index) => index !== i));
                      clear();
                    }}
                  >
                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        aria-label={`Move ${item.file.name} up`}
                        onClick={() => move(i, i - 1)}
                        disabled={i === 0}
                        className="rounded-md p-1.5 text-ink/75 hover:bg-ink/5 hover:text-forest disabled:opacity-20"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${item.file.name} down`}
                        onClick={() => move(i, i + 1)}
                        disabled={i === items.length - 1}
                        className="rounded-md p-1.5 text-ink/75 hover:bg-ink/5 hover:text-forest disabled:opacity-20"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </FileRow>
                  <div className="flex flex-wrap items-center gap-2 pl-1">
                    <label htmlFor={`merge-range-${item.id}`} className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink/55">
                      Pages
                    </label>
                    <input
                      id={`merge-range-${item.id}`}
                      value={item.range}
                      onChange={(event) => updateRange(item.id, event.target.value)}
                      placeholder="All pages"
                      aria-label={`Pages from ${item.file.name}`}
                      aria-invalid={Boolean(hint?.problem)}
                      autoComplete="off"
                      spellCheck={false}
                      className={cn("h-8 w-44 rounded-lg border border-line bg-paper px-2.5 text-[12.5px] focus:border-forest/50 focus:outline-none focus:ring-2 focus:ring-forest/10", hint?.problem && "border-clay/50")}
                    />
                    <span className="text-[11px] text-muted">
                      {count ? `of ${count}` : "…"} · 1-3, 5, odd, last-2
                    </span>
                    {hint?.problem ? (
                      <p role="alert" className="basis-full text-[11px] font-medium text-clay-ink">
                        {hint.problem}
                      </p>
                    ) : null}
                  </div>
                </div>
              );
            })}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-paper px-3 py-2 text-[12px] font-medium text-ink/75 hover:border-forest/30">
                <Plus className="h-3.5 w-3.5" /> Add more PDFs
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  multiple
                  className="sr-only"
                  onChange={async (event) => {
                    const picked = Array.from(event.target.files ?? []);
                    event.target.value = "";
                    await addFiles(picked);
                  }}
                />
              </label>
              <span className="text-[11.5px] text-muted">
                {items.length} files · {selectedPages || "…"} pages total
              </span>
            </div>
          </div>
        )}
      </div>

      <div>
        <StepHeader step={2} title="Merge order" hint="How pages interleave" />
        <Segmented
          value={mode}
          onChange={(next) => {
            setMode(next);
            clear();
          }}
          options={[
            { value: "sequential", label: "Sequential", hint: "File after file" },
            { value: "interleave", label: "Interleave", hint: "Alternate pages" },
          ]}
        />
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
          {mode === "sequential"
            ? "Every page of the first file, then every page of the next — the classic merge."
            : "Round-robin: page 1 of each file, then page 2 of each file. Great for merging two scans of the same document."}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-line bg-bone-deep/30 px-3.5 py-2.5 text-[11.5px] text-ink/70">
        <span>
          <strong className="font-semibold text-ink">{items.length}</strong> files
        </span>
        <span>
          <strong className="font-semibold text-ink">{selectedPages || "…"}</strong> pages
        </span>
        <span>
          <strong className="font-semibold text-ink">{formatBytes(totalSize)}</strong> total
        </span>
        <span className="text-forest">{mode === "sequential" ? "Sequential order" : "Interleaved order"}</span>
      </div>

      {duplicateNames.length > 0 && (
        <Alert tone="warning" title="Two files share a name">
          {duplicateNames.join(", ")} appear more than once. Every file is still merged in the order shown.
        </Alert>
      )}

      <AdvancedOptions
        scope="merge"
        badge={`${prefs.value.bookmarks ? "2" : "1"} control${prefs.value.bookmarks ? "s" : ""}`}
        description="Bookmarks and outline titles"
        onReset={prefs.reset}
      >
        <OptionsGrid>
          <label className="flex items-start justify-between gap-4 rounded-xl border border-line bg-paper px-3.5 py-3">
            <span>
              <span className="block text-[13px] font-medium">Bookmark each source file</span>
              <span className="mt-0.5 block text-[11.5px] leading-snug text-muted">
                Adds an outline entry at each file’s first page.
              </span>
            </span>
            <input
              type="checkbox"
              checked={prefs.value.bookmarks}
              onChange={(event) => prefs.set("bookmarks", event.target.checked)}
              aria-label="Bookmark each source file"
              className="mt-1 h-4 w-4 shrink-0 accent-[#1c4c3b]"
            />
          </label>
          <label className={cn("flex items-start justify-between gap-4 rounded-xl border border-line bg-paper px-3.5 py-3", !prefs.value.bookmarks && "opacity-60")}>
            <span>
              <span className="block text-[13px] font-medium">Use document titles</span>
              <span className="mt-0.5 block text-[11.5px] leading-snug text-muted">
                Falls back to the file name when a PDF has no title.
              </span>
            </span>
            <input
              type="checkbox"
              disabled={!prefs.value.bookmarks}
              checked={prefs.value.bookmarks && prefs.value.documentTitles}
              onChange={(event) => prefs.set("documentTitles", event.target.checked)}
              aria-label="Use document titles for bookmarks"
              className="mt-1 h-4 w-4 shrink-0 accent-[#1c4c3b]"
            />
          </label>
        </OptionsGrid>
        <OptionNote>Pages are copied as vectors — text stays selectable and nothing is re-rendered.</OptionNote>
      </AdvancedOptions>

      {error && <Alert tone="error">{error}</Alert>}
      <JobError job={job} />
      <CancelledNote job={job} />

      <div className="flex flex-wrap items-center gap-2.5 border-t border-line pt-4">
        <Button onClick={merge} loading={job.busy} disabled={items.length < 2 || job.busy}>
          {job.busy ? "Merging locally…" : "Merge PDF"}
        </Button>
        {job.busy && (
          <Button variant="ghost" onClick={job.cancel}>
            Cancel
          </Button>
        )}
        {items.length > 0 && !job.busy && (
          <Button
            variant="ghost"
            onClick={() => {
              setItems([]);
              setError("");
              clear();
            }}
          >
            Clear all
          </Button>
        )}
        <span className="text-[11px] text-muted">⌘/Ctrl + Enter</span>
      </div>
      {job.busy && <JobProgress job={job} />}

      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title={`${result.sources} PDFs became one`}
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          originalSize={totalSize}
          mime="application/pdf"
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${result.pages} pages · ${formatBytes(result.bytes.byteLength)} · ${result.mode === "sequential" ? "files merged in order" : "pages interleaved"}${
            result.bookmarks ? ` · ${result.bookmarks} bookmarks` : ""
          }`}
          facts={[
            { label: "Order", value: result.mode === "sequential" ? "Sequential" : "Interleaved" },
            ...(result.bookmarks ? [{ label: "Bookmarks", value: String(result.bookmarks) }] : []),
          ]}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * SPLIT
 * ================================================================== */
type SplitMode = "extract" | "single" | "everyN" | "custom" | "oddeven" | "half";

interface SplitEntry {
  name: string;
  pages: number[];
  /** Half-page output: which side of the sheet to keep. */
  half?: "low" | "high";
}

interface SplitResult {
  kind: "pdf" | "zip";
  bytes: Uint8Array;
  name: string;
  pages: number;
  files: number;
  entries: { name: string; bytes: Uint8Array }[];
  mode: SplitMode;
}

const SPLIT_MODES: { value: SplitMode; label: string; hint: string }[] = [
  { value: "extract", label: "Extract a range", hint: "One PDF out" },
  { value: "single", label: "Every page", hint: "One file per page" },
  { value: "everyN", label: "Every N pages", hint: "Chunked parts" },
  { value: "custom", label: "Custom parts", hint: "One range per line" },
  { value: "oddeven", label: "Odd / even", hint: "Two PDFs" },
  { value: "half", label: "Split in half", hint: "Cut each sheet" },
];

function fillNamePattern(pattern: string, vars: { name: string; part: string; page: string; start: string; end: string }): string {
  const filled = pattern
    .replace(/\{name\}/gi, vars.name)
    .replace(/\{part\}/gi, vars.part)
    .replace(/\{page\}/gi, vars.page)
    .replace(/\{start\}/gi, vars.start)
    .replace(/\{end\}/gi, vars.end)
    .replace(/\.pdf$/i, "");
  return `${sanitizeName(filled, "paperly")}.pdf`;
}

function dedupeNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const used = seen.get(name) ?? 0;
    seen.set(name, used + 1);
    return used === 0 ? name : name.replace(/\.pdf$/i, `-${used + 1}.pdf`);
  });
}

/** Cut a copied page in half by moving its media box to one side. */
function cutPageInHalf(page: PDFPage, half: "low" | "high") {
  const box = page.getMediaBox();
  const horizontal = box.width >= box.height;
  if (horizontal) {
    const w = box.width / 2;
    const x = half === "low" ? box.x : box.x + w;
    page.setMediaBox(x, box.y, w, box.height);
    page.setCropBox(x, box.y, w, box.height);
  } else {
    const h = box.height / 2;
    const y = half === "low" ? box.y : box.y + h;
    page.setMediaBox(box.x, y, box.width, h);
    page.setCropBox(box.x, y, box.width, h);
  }
}

export function SplitTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [mode, setMode] = useState<SplitMode>("extract");
  const [range, setRange] = useState("");
  const [custom, setCustom] = useState("1-3\n4-6");
  const [chunk, setChunk] = useState(2);
  const [error, setError] = useState("");
  const prefs = useToolPreferences("split", { zip: true, pattern: "" });
  const { job, result, run, clear } = useRunner<SplitResult>();

  const total = pdf.pageCount;

  useEffect(() => {
    clear();
    setError("");
  }, [pdf.bytes, mode, clear]);

  const plan = useMemo(() => {
    if (!pdf.file || !total) return { entries: [] as SplitEntry[], error: "" };
    const base = sanitizeName(baseName(pdf.file.name));
    const pattern = prefs.value.pattern;
    const named = (legacy: string, vars: { part: string; page: string; start: string; end: string }) =>
      pattern.trim() ? fillNamePattern(pattern, { name: base, ...vars }) : `${base}-${legacy}.pdf`;
    try {
      if (mode === "extract") {
        const pages = parsePageQuery(range, total);
        return {
          entries: [{ name: `${base}-pages-${pages.length}.pdf`, pages }],
          error: "",
        };
      }
      if (mode === "single") {
        return {
          entries: Array.from({ length: total }, (_, index) => ({
            name: named(`page-${index + 1}`, { part: String(index + 1), page: String(index + 1), start: String(index + 1), end: String(index + 1) }),
            pages: [index + 1],
          })),
          error: "",
        };
      }
      if (mode === "everyN") {
        const step = Math.max(1, Math.min(200, Math.round(chunk)));
        const parts: SplitEntry[] = [];
        for (let start = 1; start <= total; start += step) {
          const end = Math.min(total, start + step - 1);
          const index = parts.length + 1;
          parts.push({
            name: named(`part-${index}`, { part: String(index), page: String(start), start: String(start), end: String(end) }),
            pages: Array.from({ length: end - start + 1 }, (_, offset) => start + offset),
          });
        }
        return { entries: parts, error: "" };
      }
      if (mode === "custom") {
        const lines = custom.split("\n").map((line) => line.trim()).filter(Boolean);
        if (!lines.length) return { entries: [] as SplitEntry[], error: "Add at least one page range, one per line." };
        const entries: SplitEntry[] = [];
        for (let index = 0; index < lines.length; index++) {
          const pages = uniqueInOrder(parseRanges(lines[index], total));
          if (!pages.length) throw new Error(`“${lines[index]}” has no pages.`);
          const part = index + 1;
          entries.push({
            name: named(`part-${part}`, { part: String(part), page: String(pages[0]), start: String(pages[0]), end: String(pages[pages.length - 1]) }),
            pages,
          });
        }
        return { entries, error: "" };
      }
      if (mode === "oddeven") {
        const odd: number[] = [];
        const even: number[] = [];
        for (let page = 1; page <= total; page++) (page % 2 === 1 ? odd : even).push(page);
        const entries: SplitEntry[] = [];
        if (odd.length) {
          entries.push({
            name: named("odd", { part: "1", page: "1", start: "1", end: String(odd[odd.length - 1]) }),
            pages: odd,
          });
        }
        if (even.length) {
          entries.push({
            name: named("even", { part: String(entries.length + 1), page: "2", start: "2", end: String(even[even.length - 1]) }),
            pages: even,
          });
        }
        return { entries, error: "" };
      }
      const entries: SplitEntry[] = [];
      for (let page = 1; page <= total; page++) {
        entries.push({
          name: `${base}-page-${page}-a.pdf`,
          pages: [page],
          half: "low",
        });
        entries.push({
          name: `${base}-page-${page}-b.pdf`,
          pages: [page],
          half: "high",
        });
      }
      return { entries, error: "" };
    } catch (err) {
      return { entries: [] as SplitEntry[], error: (err as Error).message };
    }
  }, [mode, range, custom, chunk, total, pdf.file, prefs.value.pattern]);

  const selectedPages = useMemo(() => {
    if (!total) return [] as number[];
    try {
      return parsePageQuery(range, total);
    } catch {
      return [] as number[];
    }
  }, [range, total]);

  const syncFromPicker = (pages: number[]) => {
    setRange(pages.length === total ? "" : pagesToQuery(pages, total));
    clear();
  };

  const split = () => {
    if (!pdf.bytes || !pdf.file) return;
    if (plan.error) {
      setError(plan.error);
      return;
    }
    if (!plan.entries.length) {
      setError("Nothing to split — choose at least one page.");
      return;
    }
    setError("");
    const entries = plan.entries;
    const pattern = prefs.value.pattern;
    void run(async ({ step, throwIfCancelled }) => {
      const src = await openPdfLib(pdf.bytes as ArrayBuffer);
      const base = sanitizeName(baseName(pdf.file!.name));
      const built: { name: string; bytes: Uint8Array }[] = [];
      for (let i = 0; i < entries.length; i++) {
        throwIfCancelled();
        const entry = entries[i];
        const out = await PDFDocument.create();
        const copied = await out.copyPages(src, entry.pages.map((page) => page - 1));
        copied.forEach((page) => out.addPage(page));
        let name = entry.name;
        if (entry.half) {
          const sourceBox = src.getPage(entry.pages[0] - 1).getMediaBox();
          const axis = sourceBox.width >= sourceBox.height ? "left" : "top";
          const side = entry.half === "low" ? axis : axis === "left" ? "right" : "bottom";
          cutPageInHalf(out.getPage(0), entry.half);
          if (pattern.trim()) {
            const base_ = fillNamePattern(pattern, {
              name: base,
              part: String(i + 1),
              page: String(entry.pages[0]),
              start: String(entry.pages[0]),
              end: String(entry.pages[0]),
            });
            name = base_.replace(/\.pdf$/i, `-${side}.pdf`);
          } else {
            name = `${base}-page-${entry.pages[0]}-${side}.pdf`;
          }
        }
        const bytes = await out.save();
        built.push({ name, bytes });
        step(i + 1, entries.length, "Cutting your PDF into new files…", `${i + 1} of ${entries.length}`);
      }
      const names = dedupeNames(built.map((entry) => entry.name));
      const finalEntries = built.map((entry, index) => ({ name: names[index], bytes: entry.bytes }));
      if (finalEntries.length === 1 && !entries[0].half) {
        return {
          kind: "pdf" as const,
          bytes: finalEntries[0].bytes,
          name: finalEntries[0].name,
          pages: entries[0].pages.length,
          files: 1,
          entries: finalEntries,
          mode,
        };
      }
      throwIfCancelled();
      const zip = new JSZip();
      finalEntries.forEach((entry) => zip.file(entry.name, entry.bytes));
      const zipBytes = await zip.generateAsync({ type: "uint8array" });
      return {
        kind: "zip" as const,
        bytes: zipBytes,
        name: `${base}-split.zip`,
        pages: entries.reduce((sum, entry) => sum + entry.pages.length, 0),
        files: finalEntries.length,
        entries: finalEntries,
        mode,
      };
    });
  };

  usePrimaryShortcut(split, Boolean(pdf.bytes) && !job.busy && !plan.error);
  useDownloadShortcut(
    () => {
      if (result) downloadOutput(result.bytes, result.name, result.kind === "zip" ? "application/zip" : "application/pdf");
    },
    Boolean(result),
  );

  const downloadAll = () => {
    if (!result || result.kind !== "zip") return;
    downloadOutput(result.bytes, result.name, "application/zip");
  };

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to split" />

      {pdf.bytes && (
        <>
          <div className="border-t border-line pt-4">
            <StepHeader step={2} title="How should we split it?" />
            <ModeGrid value={mode} onChange={setMode} options={SPLIT_MODES} />
          </div>

          {mode === "extract" && (
            <>
              <RangeField
                value={range}
                onChange={(value) => {
                  setRange(value);
                  setError("");
                  clear();
                }}
                total={pdf.pageCount}
                label="Pages to keep"
                hint="Leave empty to keep every page. Also accepts odd, even, last-2, >10."
              />
              <PagePicker
                bytes={pdf.bytes}
                pageCount={pdf.pageCount}
                selected={selectedPages}
                onChange={syncFromPicker}
                label="Choose pages to extract"
                hint="Click a thumbnail, shift-click for a range"
              />
            </>
          )}

          {mode === "single" && (
            <Alert tone="info">
              This will produce {pdf.pageCount} separate PDF{pdf.pageCount === 1 ? "" : "s"}, packaged into a single ZIP. Each
              keeps its original quality.
            </Alert>
          )}

          {mode === "everyN" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <NumberField
                label="Pages per file"
                value={chunk}
                onChange={(value) => {
                  setChunk(value);
                  clear();
                }}
                min={1}
                max={200}
                step={1}
                suffix="pages"
                hint="Every output keeps at most this many consecutive pages."
              />
              <div className="rounded-xl border border-line bg-bone-deep/30 px-3.5 py-3 text-[11.5px] leading-relaxed text-ink/70">
                {plan.entries.length} file{plan.entries.length === 1 ? "" : "s"} will be produced
                {plan.entries.length ? `, the last one holding ${plan.entries[plan.entries.length - 1].pages.length} page${plan.entries[plan.entries.length - 1].pages.length === 1 ? "" : "s"}.` : "."}
              </div>
            </div>
          )}

          {mode === "custom" && (
            <Field
              label="One output PDF per line"
              hint="Each line becomes a separate PDF. Example: 1-3 then 4,6,8 then 9-12."
            >
              <textarea
                value={custom}
                onChange={(event) => {
                  setCustom(event.target.value);
                  clear();
                }}
                rows={4}
                className={cn(inputClass, "h-auto py-2.5 font-mono text-[13px]")}
                spellCheck={false}
              />
            </Field>
          )}

          {mode === "oddeven" && (
            <Alert tone="info">
              Odd pages and even pages become two separate PDFs. Useful for scans where the back sides were captured
              separately.
            </Alert>
          )}

          {mode === "half" && (
            <Alert tone="info">
              Each page is cut into two smaller pages: left/right for landscape sheets, top/bottom for portrait ones.
              Both halves keep the original vector content.
            </Alert>
          )}

          <div className="rounded-xl border border-line bg-bone-deep/30 px-3.5 py-2.5 text-[11.5px] text-ink/70">
            {plan.error ? (
              <span className="font-medium text-clay-ink">{plan.error}</span>
            ) : (
              <>
                <strong className="font-semibold text-ink">{plan.entries.length}</strong> output file
                {plan.entries.length === 1 ? "" : "s"} ·{" "}
                {plan.entries.reduce((sum, entry) => sum + entry.pages.length, 0)} pages total
                {plan.entries.length > 1 ? ` · ${prefs.value.zip ? "delivered as one ZIP" : "individual downloads"}` : ""}
              </>
            )}
          </div>

          <AdvancedOptions
            scope="split"
            badge="2 controls"
            description="File naming and packaging"
            onReset={prefs.reset}
          >
            <OptionsGrid>
              <Field
                label="File name pattern"
                hint="Tokens: {name} {page} {part} {start} {end}. Leave empty for the classic names."
              >
                <input
                  value={prefs.value.pattern}
                  onChange={(event) => prefs.set("pattern", event.target.value)}
                  placeholder="{name}-part-{part}"
                  spellCheck={false}
                  maxLength={80}
                  className={inputClass}
                />
              </Field>
              <div className="space-y-2">
                <SwitchLike
                  label="Package multiple files as a ZIP"
                  description="Off: each file gets its own download button."
                  checked={prefs.value.zip}
                  onChange={(value) => prefs.set("zip", value)}
                />
              </div>
            </OptionsGrid>
            <OptionNote>
              Names are made unique automatically. The default pattern reproduces the same file names as before.
            </OptionNote>
          </AdvancedOptions>

          {error && <Alert tone="error">{error}</Alert>}
          <JobError job={job} />
          <CancelledNote job={job} />

          <div className="flex flex-wrap items-center gap-2.5 border-t border-line pt-4">
            <Button onClick={split} loading={job.busy} disabled={job.busy || Boolean(plan.error)}>
              <Scissors className="h-4 w-4" /> {mode === "extract" ? "Extract pages" : "Split PDF"}
            </Button>
            {job.busy && (
              <Button variant="ghost" onClick={job.cancel}>
                Cancel
              </Button>
            )}
            <span className="text-[11.5px] text-muted">Original quality · no re-rendering</span>
          </div>
          {job.busy && <JobProgress job={job} />}
        </>
      )}

      {result && result.kind === "pdf" && (
        <DownloadPanel
          bytes={result.bytes}
          title={result.mode === "extract" ? "Your extracted PDF is ready" : "Your split PDF is ready"}
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          mime="application/pdf"
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${result.pages} page${result.pages === 1 ? "" : "s"} extracted with original quality`}
        />
      )}

      {result && result.kind === "zip" && prefs.value.zip && (
        <DownloadPanel
          bytes={result.bytes}
          title={`Your ${result.files} files are ready`}
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          mime="application/zip"
          onDownload={() => downloadBytes(result.bytes, result.name, "application/zip")}
          description={`${result.files} separate PDFs in one ZIP · no page content changed`}
          facts={[{ label: "Packaging", value: "ZIP" }]}
        />
      )}

      {result && result.kind === "zip" && !prefs.value.zip && (
        <div className="space-y-2 rounded-2xl border border-forest/20 bg-lime/10 p-4">
          <p className="text-[13px] font-semibold text-forest">{result.files} files ready</p>
          <p className="text-[11.5px] text-ink/70">
            {result.pages} pages in total · click each file to download it, or take the whole set as a ZIP.
          </p>
          <ul className="divide-y divide-forest/10 overflow-hidden rounded-xl border border-forest/15 bg-paper">
            {result.entries.map((entry) => (
              <li key={entry.name} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
                <span className="min-w-0 truncate text-[12px] font-medium">{entry.name}</span>
                <span className="flex items-center gap-2">
                  <span className="text-[11px] tabular-nums text-muted">{formatBytes(entry.bytes.byteLength)}</span>
                  <Button size="sm" variant="outline" onClick={() => downloadOutput(entry.bytes, entry.name, "application/pdf")}>
                    Download
                  </Button>
                </span>
              </li>
            ))}
          </ul>
          <Button size="sm" variant="soft" onClick={downloadAll}>
            Download all as ZIP
          </Button>
        </div>
      )}
    </div>
  );
}

/** Small accessible checkbox row that matches the Switch look without label wrapping. */
function SwitchLike({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-start justify-between gap-4 rounded-xl border border-line bg-paper px-3.5 py-3">
      <span>
        <span className="block text-[13px] font-medium">{label}</span>
        {description ? <span className="mt-0.5 block text-[11.5px] leading-snug text-muted">{description}</span> : null}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={label}
        className="mt-1 h-4 w-4 shrink-0 accent-[#1c4c3b]"
      />
    </label>
  );
}

/* ================================================================== *
 * ORGANIZE
 * ================================================================== */
interface PageItem {
  id: string;
  /** Source page number, or 0 for an inserted blank page. */
  page: number;
  rotation: number;
  blank?: boolean;
}

interface OrganizeResult {
  bytes: Uint8Array;
  name: string;
  pages: number;
  blank: number;
  rotated: number;
}

function buildOriginalOrder(count: number): PageItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: nextId("page"),
    page: index + 1,
    rotation: 0,
  }));
}

export function OrganizeTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const { thumbs, loading: thumbsLoading, total } = usePdfThumbs(pdf.bytes, { width: 200, quality: 0.75 });
  const [order, setOrder] = useState<PageItem[]>([]);
  const [dragging, setDragging] = useState<number | null>(null);
  const [error, setError] = useState("");
  const { job, result, run, clear } = useRunner<OrganizeResult>();

  useEffect(() => {
    setOrder(buildOriginalOrder(pdf.pageCount));
    clear();
    setError("");
  }, [pdf.bytes, pdf.pageCount, clear]);

  const thumbFor = (page: number) => thumbs.find((thumb) => thumb.page === page);
  const changed =
    order.length !== pdf.pageCount || order.some((item, index) => item.blank || item.rotation !== 0 || item.page !== index + 1);
  const blankCount = order.filter((item) => item.blank).length;
  const removedCount = pdf.pageCount - new Set(order.filter((item) => !item.blank).map((item) => item.page)).size;

  const update = (next: PageItem[]) => {
    setOrder(next);
    clear();
    setError("");
  };

  const reorder = (from: number, to: number) => {
    if (from === to || to < 0 || to >= order.length) return;
    const next = [...order];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    update(next);
  };

  const apply = async () => {
    if (!pdf.bytes || !pdf.file) return;
    if (!order.length) {
      setError("This PDF has no pages left. Undo some removals and try again.");
      return;
    }
    setError("");
    void run(async ({ step, throwIfCancelled }) => {
      const src = await openPdfLib(pdf.bytes as ArrayBuffer);
      const sourcePages = src.getPages();
      const dims = sourcePages.map((page) => ({ w: page.getWidth(), h: page.getHeight() }));
      const fallback = dims[0] ? { w: dims[0].w, h: dims[0].h } : { w: 595.28, h: 841.89 };
      const out = await PDFDocument.create();
      let blank = 0;
      let rotated = 0;
      for (let index = 0; index < order.length; index++) {
        throwIfCancelled();
        const item = order[index];
        if (item.blank) {
          const before = order.slice(0, index).reverse().find((candidate) => !candidate.blank);
          const after = order.slice(index + 1).find((candidate) => !candidate.blank);
          const reference = before ?? after;
          const size = reference && dims[reference.page - 1] ? dims[reference.page - 1] : fallback;
          out.addPage([size.w, size.h]);
          blank += 1;
          step(index + 1, order.length, "Rebuilding pages…", `${index + 1} of ${order.length}`);
          continue;
        }
        const [copied] = await out.copyPages(src, [item.page - 1]);
        if (item.rotation) {
          const current = copied.getRotation().angle;
          copied.setRotation(degrees((current + item.rotation + 360) % 360));
          rotated += 1;
        }
        out.addPage(copied);
        step(index + 1, order.length, "Rebuilding pages…", `${index + 1} of ${order.length}`);
      }
      const bytes = await out.save();
      return {
        bytes,
        name: `${sanitizeName(baseName(pdf.file!.name))}-organized.pdf`,
        pages: order.length,
        blank,
        rotated,
      };
    });
  };

  usePrimaryShortcut(apply, Boolean(pdf.bytes) && order.length > 0 && !job.busy);
  useDownloadShortcut(
    () => {
      if (result) downloadOutput(result.bytes, result.name, "application/pdf");
    },
    Boolean(result),
  );

  return (
    <div className="space-y-5">
      {!pdf.file ? (
        <FileDrop
          accept="application/pdf,.pdf"
          acceptLabel="A PDF to organize"
          sample={SAMPLE.pdf}
          onFiles={(files) => pdf.setFile(files[0])}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <FileRow
            file={pdf.file}
            onRemove={pdf.clear}
            size={pdf.loading ? "Reading…" : `${pdf.pageCount} pages · ${formatBytes(pdf.file.size)}`}
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-bone-deep px-2.5 py-1 text-[11.5px] font-medium text-ink/70">
              {order.length} of {pdf.pageCount} kept
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                update([...order].reverse());
              }}
              disabled={order.length < 2}
            >
              Reverse order
            </Button>
            <Button variant="ghost" size="sm" onClick={() => update(buildOriginalOrder(pdf.pageCount))}>
              Reset to original
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
              const thumb = item.blank ? undefined : thumbFor(item.page);
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
                    "group relative cursor-grab overflow-hidden rounded-xl border bg-white transition-all active:cursor-grabbing",
                    dragging === index ? "border-clay opacity-50" : "border-line hover:border-forest/40 hover:shadow-soft",
                  )}
                >
                  <div className="checker flex aspect-[3/4] items-center justify-center p-2">
                    {item.blank ? (
                      <div className="flex h-full w-full flex-col items-center justify-center gap-1 rounded border border-dashed border-ink/20 bg-white text-[10px] uppercase tracking-[0.08em] text-ink/50">
                        <FilePlus2 className="h-4 w-4" />
                        Blank page
                      </div>
                    ) : thumb ? (
                      <img
                        src={thumb.dataUrl}
                        alt={`Page ${item.page}`}
                        className="max-h-full max-w-full rounded-sm border border-ink/5 bg-white pdf-page-shadow transition-transform duration-200"
                        style={{ transform: `rotate(${item.rotation}deg)` }}
                        draggable={false}
                        loading="lazy"
                        decoding="async"
                      />
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
                    <span className="min-w-0 truncate text-[10px] text-ink/75">
                      {item.blank ? "new blank" : `from p.${item.page}`}
                    </span>
                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        aria-label={`Move page ${index + 1} earlier`}
                        title="Move earlier"
                        disabled={index === 0}
                        onClick={() => reorder(index, index - 1)}
                        className="rounded p-1 text-ink/75 hover:bg-ink/5 hover:text-forest disabled:opacity-20"
                      >
                        <ArrowUp className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Move page ${index + 1} later`}
                        title="Move later"
                        disabled={index === order.length - 1}
                        onClick={() => reorder(index, index + 1)}
                        className="rounded p-1 text-ink/75 hover:bg-ink/5 hover:text-forest disabled:opacity-20"
                      >
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
                        className="rounded p-1 text-ink/75 hover:bg-forest/10 hover:text-forest disabled:opacity-20"
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Rotate page ${index + 1}`}
                        title="Rotate 90°"
                        onClick={() => update(order.map((entry, i) => (i === index ? { ...entry, rotation: (entry.rotation + 90) % 360 } : entry)))}
                        className="rounded p-1 text-ink/75 hover:bg-forest/10 hover:text-forest"
                      >
                        <RotateCw className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove page ${index + 1}`}
                        title="Remove"
                        onClick={() => update(order.filter((_, i) => i !== index))}
                        className="rounded p-1 text-ink/75 hover:bg-clay/10 hover:text-clay-ink"
                      >
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
                        next.splice(index + 1, 0, { id: nextId("page"), page: 0, rotation: 0, blank: true });
                        update(next);
                      }}
                      className="rounded px-1 py-0.5 hover:bg-forest/10 hover:text-forest"
                    >
                      + blank
                    </button>
                    <button
                      type="button"
                      aria-label={`Move page ${index + 1} to start`}
                      disabled={index === 0}
                      onClick={() => reorder(index, 0)}
                      className="rounded px-1 py-0.5 hover:bg-forest/10 hover:text-forest disabled:opacity-30"
                    >
                      <ChevronsLeft className="inline h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move page ${index + 1} to end`}
                      disabled={index === order.length - 1}
                      onClick={() => reorder(index, order.length - 1)}
                      className="rounded px-1 py-0.5 hover:bg-forest/10 hover:text-forest disabled:opacity-30"
                    >
                      <ChevronsRight className="inline h-3 w-3" />
                    </button>
                    {item.rotation !== 0 && <span className="ml-auto font-bold text-forest">{item.rotation}°</span>}
                  </div>
                  <div className="pointer-events-none absolute left-2 top-2 rounded bg-ink/60 p-1 text-paper opacity-0 transition-opacity group-hover:opacity-100">
                    <GripVertical className="h-3.5 w-3.5" />
                  </div>
                </div>
              );
            })}
          </div>
          <p className="flex items-start gap-1.5 text-[11.5px] text-muted">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Drag pages to reorder, or use the arrow buttons. Every card can also be duplicated, rotated, removed or
            followed by a blank page.
          </p>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-line bg-bone-deep/30 px-3.5 py-2.5 text-[11.5px] text-ink/70">
            <span>
              <strong className="font-semibold text-ink">{pdf.pageCount}</strong> → {order.length} pages
            </span>
            {removedCount > 0 && <span className="text-clay-ink">{removedCount} removed</span>}
            {blankCount > 0 && <span>{blankCount} blank added</span>}
            {order.some((item) => item.rotation !== 0) && <span>rotated pages</span>}
          </div>

          {order.length === 0 && (
            <Alert tone="warning" title="Every page is removed">
              An empty PDF can’t be exported. Reset to original, or duplicate a page to keep one.
            </Alert>
          )}

          {error && <Alert tone="error">{error}</Alert>}
          <JobError job={job} />
          <CancelledNote job={job} />

          <div className="flex flex-wrap items-center gap-2.5 border-t border-line pt-4">
            <Button onClick={apply} loading={job.busy} disabled={!order.length || job.busy}>
              <Check className="h-4 w-4" /> Apply changes
            </Button>
            {job.busy && (
              <Button variant="ghost" onClick={job.cancel}>
                Cancel
              </Button>
            )}
            <span className="text-[11.5px] text-muted">
              {changed ? "Unsaved changes to page order" : "Original order"}
            </span>
          </div>
          {job.busy && <JobProgress job={job} />}
        </>
      )}

      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Your pages are in order"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          originalSize={pdf.file?.size}
          mime="application/pdf"
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${result.pages} pages reorganized · page order and rotation baked in`}
          facts={[
            ...(result.blank ? [{ label: "Blank pages", value: String(result.blank) }] : []),
            ...(result.rotated ? [{ label: "Rotated", value: `${result.rotated} pages` }] : []),
          ]}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * ROTATE
 * ================================================================== */
interface RotateResult {
  bytes: Uint8Array;
  name: string;
  pages: number;
  angle: number;
  reset: boolean;
  skipped: number;
}

export function RotateTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const { thumbs, loading: thumbsLoading } = usePdfThumbs(pdf.bytes, { width: 150, quality: 0.7, max: 60 });
  const [range, setRange] = useState("");
  const [dims, setDims] = useState<{ width: number; height: number; rotation: number }[]>([]);
  const [error, setError] = useState("");
  const prefs = useToolPreferences("rotate", { angle: 90 as 90 | 180 | 270, skipRotated: false, badges: true });
  const { job, result, run, clear } = useRunner<RotateResult>();
  const angle = prefs.value.angle;
  const setAngle = (next: 90 | 180 | 270) => prefs.set("angle", next);

  useEffect(() => {
    setRange("");
    clear();
    setError("");
  }, [pdf.bytes, clear]);

  useEffect(() => {
    if (!pdf.bytes) {
      setDims([]);
      return;
    }
    let alive = true;
    getPageDimensions(pdf.bytes)
      .then((next) => {
        if (alive) setDims(next);
      })
      .catch(() => {
        if (alive) setDims([]);
      });
    return () => {
      alive = false;
    };
  }, [pdf.bytes]);

  const selected = useMemo(() => {
    if (!pdf.pageCount) return [] as number[];
    try {
      return parsePageQuery(range, pdf.pageCount);
    } catch {
      return [] as number[];
    }
  }, [range, pdf.pageCount]);

  const rotationFor = (page: number) => dims[page - 1]?.rotation ?? 0;
  const isLandscape = (page: number) => {
    const entry = dims[page - 1];
    if (!entry) return false;
    const turned = Math.abs(entry.rotation) % 180 === 90;
    return turned ? entry.height > entry.width : entry.width > entry.height;
  };
  const landscapePages = useMemo(
    () => Array.from({ length: pdf.pageCount }, (_, index) => index + 1).filter((page) => isLandscape(page)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dims, pdf.pageCount],
  );

  const togglePage = (page: number) => {
    const next = selected.includes(page) ? selected.filter((value) => value !== page) : [...selected, page].sort((a, b) => a - b);
    setRange(next.length === pdf.pageCount ? "" : pagesToQuery(next, pdf.pageCount));
    clear();
    setError("");
  };

  const rotate = (reset = false) => {
    if (!pdf.bytes || !pdf.file) return;
    if (!reset && !angle) {
      setError("Choose a rotation of 90°, 180° or 270°.");
      return;
    }
    setError("");
    void run(async ({ step, throwIfCancelled }) => {
      const doc = await openPdfLib(pdf.bytes as ArrayBuffer);
      const all = doc.getPages();
      const targets = uniqueInOrder(parseRanges(range, pdf.pageCount));
      let turned = 0;
      let skipped = 0;
      for (let i = 0; i < targets.length; i++) {
        throwIfCancelled();
        const page = all[targets[i] - 1];
        if (!page) continue;
        const current = page.getRotation().angle;
        if (!reset && prefs.value.skipRotated && ((current % 360) + 360) % 360 !== 0) {
          skipped += 1;
          step(i + 1, targets.length, "Turning pages…", `page ${targets[i]} already rotated`);
          continue;
        }
        page.setRotation(degrees(reset ? 0 : (current + angle) % 360));
        turned += 1;
        step(i + 1, targets.length, "Turning pages…", `${i + 1} of ${targets.length}`);
      }
      const bytes = await doc.save();
      return {
        bytes,
        name: `${sanitizeName(baseName(pdf.file!.name))}-${reset ? "rotation-reset" : "rotated"}.pdf`,
        pages: turned,
        angle,
        reset,
        skipped,
      };
    });
  };

  const upright = () => {
    if (!landscapePages.length) return;
    setAngle(90);
    setRange(pagesToQuery(landscapePages, pdf.pageCount) === "" ? "" : pagesToQuery(landscapePages, pdf.pageCount));
    clear();
  };

  usePrimaryShortcut(() => rotate(false), Boolean(pdf.bytes) && !job.busy);
  useDownloadShortcut(
    () => {
      if (result) downloadOutput(result.bytes, result.name, "application/pdf");
    },
    Boolean(result),
  );

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to rotate" />
      {pdf.bytes && (
        <>
          <div>
            <StepHeader step={2} title="Choose rotation" />
            <Segmented
              value={String(angle) as "90" | "180" | "270"}
              onChange={(value) => {
                setAngle(Number(value) as 90 | 180 | 270);
                clear();
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
            onChange={(value) => {
              setRange(value);
              clear();
              setError("");
            }}
            total={pdf.pageCount}
            label="Pages to rotate"
            hint="Leave empty to rotate every page. Click a page below to include it."
          />

          {landscapePages.length > 0 && dims.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-bone-deep/30 px-3.5 py-2.5">
              <p className="min-w-0 flex-1 text-[11.5px] leading-relaxed text-ink/70">
                <strong className="font-semibold text-ink">{landscapePages.length}</strong> page
                {landscapePages.length === 1 ? " looks" : "s look"} landscape. Sideways scans are usually fixed by one
                90° turn.
              </p>
              <Button size="sm" variant="outline" onClick={upright}>
                <Wand2 className="h-3.5 w-3.5" /> Upright landscape pages
              </Button>
            </div>
          )}
          {landscapePages.length > 0 && (
            <OptionNote tone="warn">
              Upright is a page-shape heuristic, not OCR text detection. It selects the landscape pages and turns them
              90° — check the preview before exporting.
            </OptionNote>
          )}

          {thumbs.length > 0 && (
            <div>
              <p className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/75">
                <span>Preview · click a page to target it</span>
                <span className="normal-case tracking-normal text-muted">
                  {selected.length === pdf.pageCount ? "all pages" : `${selected.length} targeted`}
                </span>
              </p>
              <div className="grid max-h-[360px] grid-cols-3 gap-2 overflow-y-auto pr-1 sm:grid-cols-5 md:grid-cols-6">
                {thumbs.map((thumb) => {
                  const active = selected.includes(thumb.page);
                  const current = rotationFor(thumb.page);
                  return (
                    <button
                      key={thumb.page}
                      type="button"
                      aria-pressed={active}
                      aria-label={`Page ${thumb.page}, current rotation ${current}°${active ? ", targeted" : ""}`}
                      onClick={() => togglePage(thumb.page)}
                      className={cn(
                        "group relative overflow-hidden rounded-lg border bg-white text-left transition-all",
                        active ? "border-forest ring-2 ring-forest/25" : "border-line hover:border-forest/40",
                      )}
                    >
                      <img src={thumb.dataUrl} alt="" className="block aspect-[3/4] w-full object-contain" loading="lazy" />
                      <span
                        className={cn(
                          "absolute bottom-1 left-1 rounded px-1 py-0.5 text-[9.5px] font-bold tabular-nums",
                          active ? "bg-forest text-lime" : "bg-ink/70 text-paper",
                        )}
                      >
                        {thumb.page}
                      </span>
                      {prefs.value.badges && current !== 0 && (
                        <span className="absolute right-1 top-1 rounded bg-clay px-1 py-0.5 text-[9px] font-bold text-paper">
                          {current}°
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              {thumbs.length > 12 && (
                <p className="mt-1.5 text-[11px] text-muted">
                  Showing {thumbs.length} of {pdf.pageCount} pages. Use the range field for the rest.
                </p>
              )}
              {thumbsLoading && <Loader2 className="mt-2 h-4 w-4 animate-spin text-forest" />}
            </div>
          )}

          {error && <Alert tone="error">{error}</Alert>}
          <JobError job={job} />
          <CancelledNote job={job} />

          <div className="flex flex-wrap items-center gap-2.5 border-t border-line pt-4">
            <Button onClick={() => rotate(false)} loading={job.busy}>
              <RotateCw className="h-4 w-4" /> Rotate {angle}° {range.trim() ? "selected pages" : "all pages"}
            </Button>
            {job.busy && (
              <Button variant="ghost" onClick={job.cancel}>
                Cancel
              </Button>
            )}
            <Button variant="ghost" onClick={() => rotate(true)} disabled={job.busy}>
              <RotateCcw className="h-4 w-4" /> Reset rotation
            </Button>
          </div>
          <AdvancedOptions
            scope="rotate"
            badge="2 controls"
            description="Page selection and preview"
            onReset={prefs.reset}
          >
            <OptionsGrid>
              <label className="flex items-start justify-between gap-4 rounded-xl border border-line bg-paper px-3.5 py-3">
                <span>
                  <span className="block text-[13px] font-medium">Skip pages already rotated</span>
                  <span className="mt-0.5 block text-[11.5px] leading-snug text-muted">
                    Leaves pages that carry a stored rotation exactly as they are.
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={prefs.value.skipRotated}
                  onChange={(event) => prefs.set("skipRotated", event.target.checked)}
                  aria-label="Skip pages already rotated"
                  className="mt-1 h-4 w-4 shrink-0 accent-[#1c4c3b]"
                />
              </label>
              <label className="flex items-start justify-between gap-4 rounded-xl border border-line bg-paper px-3.5 py-3">
                <span>
                  <span className="block text-[13px] font-medium">Show rotation badges</span>
                  <span className="mt-0.5 block text-[11.5px] leading-snug text-muted">
                    Marks thumbnails that already carry a rotation.
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={prefs.value.badges}
                  onChange={(event) => prefs.set("badges", event.target.checked)}
                  aria-label="Show rotation badges"
                  className="mt-1 h-4 w-4 shrink-0 accent-[#1c4c3b]"
                />
              </label>
            </OptionsGrid>
            <OptionNote>
              Rotations are stored on the page, never re-rendered. Reset rotation sets the targeted pages back to 0°.
            </OptionNote>
          </AdvancedOptions>
          <p className="text-[11px] text-muted">
            The button label follows your selection: <em>all pages</em> when the range is empty.
          </p>
          {job.busy && <JobProgress job={job} />}
        </>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Pages turned"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          originalSize={pdf.file?.size}
          mime="application/pdf"
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${result.pages} page${result.pages === 1 ? "" : "s"} ${result.reset ? "reset to 0°" : `turned ${result.angle}°`}${
            result.skipped ? ` · ${result.skipped} already rotated, left alone` : ""
          } · everything else untouched`}
          facts={[{ label: "Rotation", value: result.reset ? "0°" : `${result.angle}°` }]}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * CROP
 * ================================================================== */
const MM = 2.834645669;

type CropUnit = "mm" | "pt" | "%";

const CROP_UNITS: { value: CropUnit; label: string }[] = [
  { value: "mm", label: "mm" },
  { value: "pt", label: "pt" },
  { value: "%", label: "%" },
];

const CROP_PAPERS: { value: string; label: string; w: number; h: number }[] = [
  { value: "none", label: "Keep the current page size", w: 0, h: 0 },
  { value: "a4", label: "A4 · 210 × 297 mm", w: 210, h: 297 },
  { value: "letter", label: "US Letter · 216 × 279 mm", w: 215.9, h: 279.4 },
  { value: "legal", label: "US Legal · 216 × 356 mm", w: 215.9, h: 355.6 },
  { value: "a5", label: "A5 · 148 × 210 mm", w: 148, h: 210 },
  { value: "custom", label: "Custom size…", w: 0, h: 0 },
];

function unitToPoints(value: number, unit: CropUnit, extent: number): number {
  if (unit === "mm") return value * MM;
  if (unit === "pt") return value;
  return (value / 100) * extent;
}

function pointsToUnit(points: number, unit: CropUnit, extent: number): number {
  if (unit === "mm") return points / MM;
  if (unit === "pt") return points;
  return extent > 0 ? (points / extent) * 100 : 0;
}

interface CropResult {
  bytes: Uint8Array;
  name: string;
  pages: number;
  skipped: number;
  from: { w: number; h: number };
  to: { w: number; h: number };
}

export function CropTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const { thumbs } = usePdfThumbs(pdf.bytes, { width: 420, quality: 0.8, max: 1 });
  const prefs = useToolPreferences("crop", {
    unit: "mm" as CropUnit,
    top: 8,
    right: 8,
    bottom: 8,
    left: 8,
    customW: 210,
    customH: 297,
  });
  const [range, setRange] = useState("");
  const [paper, setPaper] = useState("none");
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const { job, result, run, clear } = useRunner<CropResult>();

  const unit = prefs.value.unit;
  const margins = { top: prefs.value.top, right: prefs.value.right, bottom: prefs.value.bottom, left: prefs.value.left };
  const setMargin = (key: "top" | "right" | "bottom" | "left", value: number) => {
    prefs.set(key, Math.max(0, Math.min(unit === "%" ? 45 : 300, value)));
    clear();
    setNote("");
  };

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

  useEffect(() => {
    clear();
    setError("");
    setNote("");
    setPaper("none");
  }, [pdf.bytes, clear]);

  const pageW = size?.width ?? 595.28;
  const pageH = size?.height ?? 841.89;
  const leftPt = unitToPoints(margins.left, unit, pageW);
  const rightPt = unitToPoints(margins.right, unit, pageW);
  const topPt = unitToPoints(margins.top, unit, pageH);
  const bottomPt = unitToPoints(margins.bottom, unit, pageH);

  const horizontal = pageW > 0 ? (leftPt + rightPt) / pageW : 0;
  const vertical = pageH > 0 ? (topPt + bottomPt) / pageH : 0;
  const invalid = horizontal >= 1 || vertical >= 1;
  const newW = Math.max(0, pageW - leftPt - rightPt);
  const newH = Math.max(0, pageH - topPt - bottomPt);
  const suffix = unit === "%" ? "%" : unit;
  const formatMargin = (points: number, extent: number) => {
    if (unit === "%") return `${Math.round((points / (extent || 1)) * 1000) / 10}%`;
    const value = unit === "mm" ? points / MM : points;
    return `${Math.round(value * 10) / 10} ${unit}`;
  };

  const changeUnit = (next: CropUnit) => {
    const convert = (value: number, extent: number) => {
      const points = unitToPoints(value, unit, extent);
      const converted = pointsToUnit(points, next, extent);
      return Math.round(converted * 10) / 10;
    };
    prefs.patch({
      unit: next,
      left: convert(margins.left, pageW),
      right: convert(margins.right, pageW),
      top: convert(margins.top, pageH),
      bottom: convert(margins.bottom, pageH),
    });
    setNote("");
    clear();
  };

  const presets = [
    { id: "trim", label: "Trim scan edges", description: "6 mm off every side", t: 6, r: 6, b: 6, l: 6 },
    { id: "wide", label: "Wide white margins", description: "14 mm top and bottom, 10 mm sides", t: 14, r: 10, b: 14, l: 10 },
    { id: "header", label: "Remove header strip", description: "22 mm off the top only", t: 22, r: 0, b: 0, l: 0 },
    { id: "none", label: "No margins", description: "Start from the full page", t: 0, r: 0, b: 0, l: 0 },
  ];

  const applyPreset = (preset: (typeof presets)[number]) => {
    const convert = (mm: number, extent: number) => Math.round(pointsToUnit(mm * MM, unit, extent) * 10) / 10;
    prefs.patch({
      top: convert(preset.t, pageH),
      right: convert(preset.r, pageW),
      bottom: convert(preset.b, pageH),
      left: convert(preset.l, pageW),
    });
    setNote("");
    clear();
  };

  const activePreset =
    presets.find((preset) => {
      const target = (mm: number, extent: number) => pointsToUnit(mm * MM, unit, extent);
      const close = (actual: number, mm: number, extent: number) => Math.abs(actual - target(mm, extent)) <= (unit === "%" ? 0.6 : 0.6);
      return (
        close(margins.top, preset.t, pageH) &&
        close(margins.right, preset.r, pageW) &&
        close(margins.bottom, preset.b, pageH) &&
        close(margins.left, preset.l, pageW)
      );
    })?.id ?? "custom";

  const applyPaper = (value: string) => {
    setPaper(value);
    clear();
    setNote("");
    const target = CROP_PAPERS.find((entry) => entry.value === value);
    if (!target || value === "none") return;
    const targetW = (value === "custom" ? prefs.value.customW : target.w) * MM;
    const targetH = (value === "custom" ? prefs.value.customH : target.h) * MM;
    if (targetW >= pageW || targetH >= pageH) {
      setNote("That paper size is larger than this page, so there is nothing to trim. Pick a smaller size or set margins by hand.");
      setPaper("none");
      return;
    }
    const mx = (pageW - targetW) / 2;
    const my = (pageH - targetH) / 2;
    prefs.patch({
      left: Math.round(pointsToUnit(mx, unit, pageW) * 10) / 10,
      right: Math.round(pointsToUnit(mx, unit, pageW) * 10) / 10,
      top: Math.round(pointsToUnit(my, unit, pageH) * 10) / 10,
      bottom: Math.round(pointsToUnit(my, unit, pageH) * 10) / 10,
    });
    setNote(
      value === "custom"
        ? `Margins set so the page trims to ${prefs.value.customW} × ${prefs.value.customH} mm.`
        : `Margins set so the page trims to ${target.label}.`,
    );
  };

  const detect = async () => {
    if (!pdf.bytes) return;
    setDetecting(true);
    setError("");
    setNote("");
    try {
      const doc = await openPdfJs(pdf.bytes);
      const page = await doc.getPage(1);
      const viewport = page.getViewport({ scale: 1, rotation: 0 });
      const content = await page.getTextContent();
      // Text items arrive in PDF user space; composing with the viewport matrix
      // puts every glyph box in top-left device space at 100%.
      const multiply = (a: number[], b: number[]) => [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
      ];
      const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const matrix = multiply(viewport.transform, item.transform);
        const x = matrix[4];
        const baseline = matrix[5];
        const width = Math.max(item.width ?? 0, 1);
        const height = Math.max(item.height ?? 0, 1);
        bounds.minX = Math.min(bounds.minX, x);
        bounds.maxX = Math.max(bounds.maxX, x + width);
        bounds.minY = Math.min(bounds.minY, baseline - height);
        bounds.maxY = Math.max(bounds.maxY, baseline);
      }
      await doc.destroy();
      if (!Number.isFinite(bounds.minX) || bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) {
        setNote(
          "Auto-detect found no text on page 1 — this is probably a scan or image-only page, so there are no text bounds to measure. Set the margins by hand.",
        );
        return;
      }
      const detected = {
        left: Math.max(0, Math.min(bounds.minX, viewport.width)),
        right: Math.max(0, Math.min(viewport.width - bounds.maxX, viewport.width)),
        top: Math.max(0, Math.min(bounds.minY, viewport.height)),
        bottom: Math.max(0, Math.min(viewport.height - bounds.maxY, viewport.height)),
      };
      if (detected.left + detected.right < 1 && detected.top + detected.bottom < 1) {
        setNote(
          "The text on page 1 reaches every edge, so auto-detect found nothing to trim. Your current margins were left untouched.",
        );
        return;
      }
      const inkPoints = (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY);
      if (inkPoints < viewport.width * viewport.height * 0.02) {
        setNote(
          "Page 1 has very little text, so the detected margins may hug a single line. Values were applied — adjust them before cropping.",
        );
      } else {
        setNote("Margins measured from the text bounds on page 1. These hug the content exactly — add a few millimetres of bleed if you want breathing room.");
      }
      prefs.patch({
        left: Math.round(pointsToUnit(detected.left, unit, pageW) * 10) / 10,
        right: Math.round(pointsToUnit(detected.right, unit, pageW) * 10) / 10,
        top: Math.round(pointsToUnit(detected.top, unit, pageH) * 10) / 10,
        bottom: Math.round(pointsToUnit(detected.bottom, unit, pageH) * 10) / 10,
      });
      clear();
    } catch (err) {
      setError(friendlyProcessingError(err, "Auto-detect couldn’t read this page."));
    } finally {
      setDetecting(false);
    }
  };

  const apply = async () => {
    if (!pdf.bytes || !pdf.file) return;
    if (!topPt && !rightPt && !bottomPt && !leftPt) {
      setError("Set at least one margin to crop.");
      return;
    }
    if (invalid) {
      setError("Those margins are larger than the page. Reduce them and try again.");
      return;
    }
    setError("");
    void run(async ({ step, throwIfCancelled }) => {
      const pages = uniqueInOrder(parseRanges(range, pdf.pageCount));
      const doc = await openPdfLib(pdf.bytes as ArrayBuffer);
      const all = doc.getPages();
      let skipped = 0;
      let cropped = 0;
      for (let index = 0; index < pages.length; index++) {
        throwIfCancelled();
        const page = all[pages[index] - 1];
        const box = page.getCropBox();
        const width = box.width - leftPt - rightPt;
        const height = box.height - topPt - bottomPt;
        if (width < 36 || height < 36) {
          skipped += 1;
          step(index + 1, pages.length, "Trimming margins…", `page ${pages[index]} skipped`);
          continue;
        }
        page.setCropBox(box.x + leftPt, box.y + bottomPt, width, height);
        cropped += 1;
        step(index + 1, pages.length, "Trimming margins…", `${index + 1} of ${pages.length}`);
      }
      const bytes = await doc.save();
      return {
        bytes,
        name: `${sanitizeName(baseName(pdf.file!.name))}-cropped.pdf`,
        pages: cropped,
        skipped,
        from: { w: pageW, h: pageH },
        to: { w: newW, h: newH },
      };
    });
  };

  usePrimaryShortcut(apply, Boolean(pdf.bytes) && !job.busy && !invalid);
  useDownloadShortcut(
    () => {
      if (result) downloadOutput(result.bytes, result.name, "application/pdf");
    },
    Boolean(result),
  );

  const reset = () => {
    prefs.patch({ top: 0, right: 0, bottom: 0, left: 0 });
    setPaper("none");
    setNote("");
    clear();
  };

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to crop" />
      {pdf.bytes && (
        <>
          <PresetChips
            label="Margin preset"
            value={activePreset}
            presets={presets.map(({ id, label, description }) => ({ id, label, description }))}
            onSelect={(preset) => {
              const found = presets.find((entry) => entry.id === preset.id);
              if (found) applyPreset(found);
            }}
          />

          <div className="grid gap-5 sm:grid-cols-[1fr_240px]">
            <div className="space-y-4">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <StepHeader step={2} title="Margins to trim" hint={`Measured in ${unit === "%" ? "percent of the page" : unit === "pt" ? "points" : "millimetres"}`} />
                <div className="flex items-center gap-1" role="group" aria-label="Margin unit">
                  {CROP_UNITS.map((entry) => (
                    <button
                      key={entry.value}
                      type="button"
                      aria-pressed={unit === entry.value}
                      onClick={() => changeUnit(entry.value)}
                      className={cn(
                        "min-w-9 rounded-md border px-2 py-1 text-[11.5px] font-medium transition-colors",
                        unit === entry.value
                          ? "border-forest bg-forest text-paper"
                          : "border-line bg-paper text-ink/70 hover:border-forest/35 hover:text-forest",
                      )}
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <NumberField label="Top" value={margins.top} onChange={(value) => setMargin("top", value)} min={0} max={unit === "%" ? 45 : 300} step={unit === "%" ? 0.5 : 1} suffix={suffix} />
                <NumberField label="Bottom" value={margins.bottom} onChange={(value) => setMargin("bottom", value)} min={0} max={unit === "%" ? 45 : 300} step={unit === "%" ? 0.5 : 1} suffix={suffix} />
                <NumberField label="Left" value={margins.left} onChange={(value) => setMargin("left", value)} min={0} max={unit === "%" ? 45 : 300} step={unit === "%" ? 0.5 : 1} suffix={suffix} />
                <NumberField label="Right" value={margins.right} onChange={(value) => setMargin("right", value)} min={0} max={unit === "%" ? 45 : 300} step={unit === "%" ? 0.5 : 1} suffix={suffix} />
              </div>

              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-[210px] flex-1">
                  <Field label="Trim to paper size" hint="Crops evenly to a standard size. Pick “Keep” to use the margins above.">
                    <select
                      value={paper}
                      onChange={(event) => {
                        const value = event.target.value;
                        if (value === "custom") {
                          setPaper("custom");
                          setNote("Enter the width and height, then choose “Trim to this size”.");
                          return;
                        }
                        applyPaper(value);
                      }}
                      className={cn(inputClass, "appearance-none pr-9")}
                    >
                      {CROP_PAPERS.map((entry) => (
                        <option key={entry.value} value={entry.value}>
                          {entry.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Button variant="outline" onClick={() => void detect()} loading={detecting} disabled={detecting}>
                  <Wand2 className="h-4 w-4" /> Auto-detect margins
                </Button>
              </div>

              {paper === "custom" && (
                <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                  <NumberField
                    label="Custom width"
                    value={prefs.value.customW}
                    onChange={(value) => prefs.set("customW", value)}
                    min={20}
                    max={2000}
                    suffix="mm"
                  />
                  <NumberField
                    label="Custom height"
                    value={prefs.value.customH}
                    onChange={(value) => prefs.set("customH", value)}
                    min={20}
                    max={2000}
                    suffix="mm"
                  />
                  <Button variant="soft" onClick={() => applyPaper("custom")}>
                    Trim to this size
                  </Button>
                </div>
              )}

              <RangeField
                value={range}
                onChange={(value) => {
                  setRange(value);
                  clear();
                  setError("");
                }}
                total={pdf.pageCount}
                label="Pages to crop"
                hint="Leave empty to crop all pages. Chips cover odd, even and the last pages."
              />
            </div>

            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/75">Preview · page 1</p>
              <div className="relative overflow-hidden rounded-lg border border-line bg-white p-2.5">
                {thumbs[0] ? (
                  <div className="relative">
                    <img src={thumbs[0].dataUrl} alt="First page preview" className="w-full opacity-85" loading="lazy" decoding="async" />
                    <div className="pointer-events-none absolute inset-0 bg-ink/10" />
                    <div
                      className="pointer-events-none absolute border-2 border-clay bg-white/0 shadow-[0_0_0_9999px_rgba(38,49,43,0.08)]"
                      style={{
                        top: `${Math.min(49, Math.max(0, (topPt / pageH) * 100))}%`,
                        bottom: `${Math.min(49, Math.max(0, (bottomPt / pageH) * 100))}%`,
                        left: `${Math.min(49, Math.max(0, (leftPt / pageW) * 100))}%`,
                        right: `${Math.min(49, Math.max(0, (rightPt / pageW) * 100))}%`,
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
                The clear rectangle is what remains. Content outside the crop box stays in the file but is not shown or
                printed.
              </p>
              <div className="mt-2 rounded-lg border border-line bg-bone-deep/30 px-2.5 py-2 text-[11px] leading-relaxed text-ink/70">
                <p className="font-semibold text-ink">
                  {Math.round(pageW)} × {Math.round(pageH)} pt → {Math.round(newW)} × {Math.round(newH)} pt
                </p>
                <p className="mt-0.5">
                  Trim: {formatMargin(leftPt, pageW)} left · {formatMargin(rightPt, pageW)} right · {formatMargin(topPt, pageH)} top ·{" "}
                  {formatMargin(bottomPt, pageH)} bottom
                </p>
                <p className="mt-0.5 text-[10.5px] text-muted">
                  Result is {Math.round(newW / MM)} × {Math.round(newH / MM)} mm on page 1.
                </p>
              </div>
            </div>
          </div>

          {note && <Alert tone="info">{note}</Alert>}
          {invalid && (
            <Alert tone="error" title="Those margins don’t fit">
              The left and right (or top and bottom) margins add up to more than the page. Reduce one of them.
            </Alert>
          )}
          {error && <Alert tone="error">{error}</Alert>}
          <JobError job={job} />
          <CancelledNote job={job} />

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={apply} loading={job.busy} disabled={invalid || job.busy}>
              <Crop className="h-4 w-4" /> Crop PDF
            </Button>
            {job.busy && (
              <Button variant="ghost" onClick={job.cancel}>
                Cancel
              </Button>
            )}
            <Button variant="ghost" onClick={reset}>
              Reset margins
            </Button>
            <Linkish onClick={() => void prefs.reset()}>Reset options to defaults</Linkish>
          </div>
          {job.busy && <JobProgress job={job} />}

          <AdvancedOptions scope="crop" badge="2 controls" description="Applies to this tool only">
            <OptionsGrid>
              <div className="rounded-xl border border-line bg-paper px-3.5 py-3 text-[11.5px] leading-relaxed text-ink/70">
                <p className="text-[13px] font-medium text-ink">Crop box, not a destructive crop</p>
                <p className="mt-0.5">
                  Only the visible box changes; page content is never re-encoded, so text stays selectable and nothing is
                  lost. A crop applied twice trims twice.
                </p>
              </div>
              <div className="rounded-xl border border-line bg-paper px-3.5 py-3 text-[11.5px] leading-relaxed text-ink/70">
                <p className="text-[13px] font-medium text-ink">Uniform margins</p>
                <p className="mt-0.5">
                  The same margins apply to every selected page, measured from that page’s own edge. Mixed page sizes are
                  handled per page.
                </p>
              </div>
            </OptionsGrid>
          </AdvancedOptions>
        </>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Margins trimmed"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          originalSize={pdf.file?.size}
          mime="application/pdf"
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${result.pages} page${result.pages === 1 ? "" : "s"} cropped${
            result.skipped ? ` · ${result.skipped} left untouched` : ""
          } · page 1 is now ${Math.round(result.to.w)} × ${Math.round(result.to.h)} pt`}
          facts={[
            { label: "Was", value: `${Math.round(result.from.w)} × ${Math.round(result.from.h)} pt` },
            { label: "Now", value: `${Math.round(result.to.w)} × ${Math.round(result.to.h)} pt` },
          ]}
        />
      )}
    </div>
  );
}

/** Minimal inline text button used inside action rows. */
function Linkish({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[11.5px] font-medium text-forest underline decoration-forest/30 underline-offset-2 hover:text-forest/80"
    >
      {children}
    </button>
  );
}
