import { Check, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Button, Progress, inputClass } from "@/components/ui";
import { parsePageQuery, pagesToQuery } from "@/lib/pageQuery";
import { usePdfThumbs } from "@/lib/usePdf";
import { cn } from "@/utils/cn";

/* ------------------------------------------------------------------ *
 * Visual page picker
 *
 * Thumbnail selection with the shortcuts people expect: click, shift-click
 * for a range, select all/odd/even/invert, plus a typed-range fallback for
 * very large documents. Used by split, extract, remove, rotate and crop.
 * ------------------------------------------------------------------ */

export function PagePicker({
  bytes,
  pageCount,
  selected,
  onChange,
  label = "Choose pages",
  hint,
  maxThumbs = 120,
  disabled = false,
}: {
  bytes: ArrayBuffer | null;
  pageCount: number;
  selected: number[];
  onChange: (pages: number[]) => void;
  label?: string;
  hint?: string;
  maxThumbs?: number;
  disabled?: boolean;
}) {
  const { thumbs, loading, progress, error } = usePdfThumbs(bytes, { width: 132, max: maxThumbs, enabled: Boolean(bytes) && !disabled });
  const [rangeInput, setRangeInput] = useState("");
  const [rangeError, setRangeError] = useState("");
  const [mode, setMode] = useState<"replace" | "add">("replace");
  const anchor = useRef<number | null>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  // Prune selections that fall outside a replaced document.
  useEffect(() => {
    if (!pageCount) return;
    const pruned = selected.filter((page) => page >= 1 && page <= pageCount);
    if (pruned.length !== selected.length) onChange(pruned);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageCount]);

  const commit = (pages: number[]) => {
    const unique = [...new Set(pages.filter((page) => page >= 1 && page <= pageCount))];
    onChange(unique);
  };

  const toggle = (page: number, event: ReactMouseEvent) => {
    if (disabled) return;
    if (event.shiftKey && anchor.current !== null) {
      const start = Math.min(anchor.current, page);
      const end = Math.max(anchor.current, page);
      const range = Array.from({ length: end - start + 1 }, (_, index) => start + index);
      const allSelected = range.every((candidate) => selectedSet.has(candidate));
      const next = allSelected ? selected.filter((candidate) => !range.includes(candidate)) : [...selected, ...range.filter((candidate) => !selectedSet.has(candidate))];
      commit(next);
      return;
    }
    anchor.current = page;
    commit(selectedSet.has(page) ? selected.filter((candidate) => candidate !== page) : [...selected, page]);
  };

  const all = Array.from({ length: pageCount }, (_, index) => index + 1);
  const odd = all.filter((page) => page % 2 === 1);
  const even = all.filter((page) => page % 2 === 0);

  const applyRange = () => {
    setRangeError("");
    if (!rangeInput.trim()) {
      setRangeError("Type a range such as 1-3, 5 or odd.");
      return;
    }
    try {
      const pages = parsePageQuery(rangeInput, pageCount);
      commit(mode === "add" ? [...selected, ...pages] : pages);
      setRangeInput("");
    } catch (err) {
      setRangeError((err as Error).message);
    }
  };

  return (
    <div className="rounded-xl border border-line bg-paper p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-ink/70">{label}</p>
          <p className="mt-0.5 text-[11.5px] text-muted">
            {selected.length} of {pageCount} page{pageCount === 1 ? "" : "s"} selected
            {hint ? ` · ${hint}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="outline" type="button" onClick={() => commit(all)} disabled={disabled || !pageCount}>
            All
          </Button>
          <Button size="sm" variant="outline" type="button" onClick={() => commit(odd)} disabled={disabled || !pageCount}>
            Odd
          </Button>
          <Button size="sm" variant="outline" type="button" onClick={() => commit(even)} disabled={disabled || !pageCount}>
            Even
          </Button>
          <Button size="sm" variant="outline" type="button" onClick={() => commit(all.filter((page) => !selectedSet.has(page)))} disabled={disabled || !pageCount}>
            Invert
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => commit([])} disabled={disabled || !selected.length}>
            Clear
          </Button>
        </div>
      </div>

      {loading && !thumbs.length ? (
        <div className="mt-3 space-y-2">
          <Progress value={progress} label={`Rendering page thumbnails (${progress}/${Math.min(pageCount, maxThumbs)})…`} />
          <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-line py-8 text-[12px] text-muted">
            <Loader2 className="h-4 w-4 animate-spin text-forest" /> First previews appear as they render.
          </div>
        </div>
      ) : error ? (
        <p className="mt-3 rounded-lg border border-clay/20 bg-clay/[0.05] px-3 py-2 text-[11.5px] text-clay-ink">{error}</p>
      ) : (
        <div className="mt-3 grid max-h-[380px] grid-cols-3 gap-2 overflow-y-auto pr-1 sm:grid-cols-5 md:grid-cols-6">
          {thumbs.map((thumb) => {
            const active = selectedSet.has(thumb.page);
            return (
              <button
                key={thumb.page}
                type="button"
                aria-pressed={active}
                aria-label={`Page ${thumb.page}${active ? " selected" : ""}`}
                disabled={disabled}
                onClick={(event) => toggle(thumb.page, event)}
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
                {active && (
                  <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-forest text-lime">
                    <Check className="h-2.5 w-2.5" strokeWidth={3} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {pageCount > thumbs.length && thumbs.length > 0 && (
        <p className="mt-2 text-[11px] text-muted">
          Showing the first {thumbs.length} pages. Use the range field to select any page — e.g. {pagesToQuery([pageCount], pageCount)}.
        </p>
      )}

      <div className="mt-3 border-t border-line pt-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink/55">Type a range</span>
            <input
              value={rangeInput}
              onChange={(event) => {
                setRangeInput(event.target.value);
                setRangeError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  applyRange();
                }
              }}
              placeholder="1-3, 5, odd, last-2"
              className={inputClass}
              disabled={disabled}
              autoComplete="off"
            />
          </label>
          <div className="flex gap-1">
            <Button size="sm" variant={mode === "replace" ? "primary" : "outline"} type="button" onClick={() => setMode("replace")}>
              Replace
            </Button>
            <Button size="sm" variant={mode === "add" ? "primary" : "outline"} type="button" onClick={() => setMode("add")}>
              Add
            </Button>
            <Button size="sm" variant="soft" type="button" onClick={applyRange} disabled={disabled}>
              Apply
            </Button>
          </div>
        </div>
        {rangeError && (
          <p role="alert" className="mt-1.5 text-[11px] font-medium text-clay-ink">
            {rangeError}
          </p>
        )}
      </div>
    </div>
  );
}
