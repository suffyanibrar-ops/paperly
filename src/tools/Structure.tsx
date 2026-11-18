import {
  ArrowDown,
  ArrowUp,
  BookMarked,
  FileJson,
  FileText,
  IndentDecrease,
  IndentIncrease,
  Info,
  ListTree,
  Plus,
  Scissors,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import JSZip from "jszip";
import { PDFDocument, baseName, downloadBytes, openPdfLib, sanitizeName } from "@/lib/pdf";
import { extractDocumentGeometry } from "@/lib/textItems";
import { useInitialFiles, usePdfFile } from "@/lib/usePdf";
import { Alert, Badge, Button, EmptyHint, Field, Progress, Select, StepHeader, Switch, smallInputClass } from "@/components/ui";
import { DownloadPanel, SinglePdfInput } from "@/components/toolParts";
import { AdvancedOptions, OptionNote, PresetChips } from "@/components/AdvancedOptions";
import {
  MAX_OUTLINE_LEVELS,
  computeSplitRanges,
  countOutlineNodes,
  detectHeadings,
  entriesToTree,
  flattenOutline,
  indentEntry,
  insertEntry,
  maxOutlineDepth,
  moveEntry,
  normalizeEntries,
  outdentEntry,
  readOutline,
  readOutlineWithMeta,
  removeEntry,
  sanitizeBookmarkTitle,
  uniqueFileNames,
  writeOutline,
  type HeadingCandidate,
  type OutlineEntry,
  type OutlineNode,
  type SplitRange,
} from "@/lib/outline";
import { friendlyProcessingError } from "@/lib/security";
import { startTool } from "@/lib/router";
import { describeJobTime, useJob } from "@/lib/job";
import { useDownloadShortcut, usePrimaryShortcut } from "@/lib/hotkeys";
import { useToolPreferences } from "@/lib/prefs";
import { cn } from "@/utils/cn";

/**
 * Structure tools: the bookmark tree editor and the "split by bookmarks"
 * pipeline. Both build on `@/lib/outline`, which owns all of the low-level
 * pdf-lib reading/writing and the pure range/heading helpers.
 */

const WINDOW_STEP = 80;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/** Deterministic, UUID-free ids for local editing only — never written to the PDF. */
let entrySequence = 0;
function nextEntryId(): string {
  entrySequence += 1;
  return `n${entrySequence}`;
}

/* ------------------------------------------------------------------ *
 * Small shared bits
 * ------------------------------------------------------------------ */

function RowButton({
  label,
  onClick,
  disabled = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-transparent text-ink/55 transition-colors",
        "hover:border-line hover:bg-bone-deep/70 hover:text-forest disabled:pointer-events-none disabled:opacity-30",
      )}
    >
      {children}
    </button>
  );
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

interface ImportedBookmark {
  title: string;
  page: number;
  level: number;
}

/** Read `[{title,page,level}]` or `{bookmarks:[…]}` from untrusted JSON. */
function readImportedOutline(payload: unknown): ImportedBookmark[] | null {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { bookmarks?: unknown }).bookmarks)
      ? ((payload as { bookmarks: unknown[] }).bookmarks)
      : null;
  if (!list) return null;
  const rows: ImportedBookmark[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const page = typeof record.page === "number" ? record.page : Number(record.page);
    const level = typeof record.level === "number" ? record.level : Number(record.level);
    if (!title && !Number.isFinite(page)) continue;
    rows.push({
      title: title || "Untitled bookmark",
      page: Number.isFinite(page) ? Math.max(0, Math.round(page)) : 0,
      level: Number.isFinite(level) ? Math.max(1, Math.round(level)) : 1,
    });
  }
  return rows.length ? rows : null;
}

/* ================================================================== *
 * EDIT BOOKMARKS
 * ================================================================== */

interface BookmarkResult {
  bytes: Uint8Array;
  name: string;
  pages: number;
  count: number;
}

interface BookmarkJsonResult {
  bytes: Uint8Array;
  name: string;
}

type HeadingSensitivity = "sensitive" | "balanced" | "strict";

interface BookmarkPrefs extends Record<string, unknown> {
  sensitivity: HeadingSensitivity;
  headingLevels: number;
  skipRunningHeads: boolean;
}

const HEADING_RATIOS: Record<HeadingSensitivity, number> = {
  sensitive: 1.06,
  balanced: 1.12,
  strict: 1.2,
};

export function BookmarksTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const detectPrefs = useToolPreferences<BookmarkPrefs>("bookmarks", {
    sensitivity: "balanced",
    headingLevels: 3,
    skipRunningHeads: true,
  });
  const saveJob = useJob<BookmarkResult>();
  const detectJob = useJob<HeadingCandidate[]>();

  const [entries, setEntries] = useState<OutlineEntry[]>([]);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [outlineError, setOutlineError] = useState("");
  const [outlineTruncated, setOutlineTruncated] = useState(false);
  const [truncatedAcknowledged, setTruncatedAcknowledged] = useState(false);
  const [windowSize, setWindowSize] = useState(WINDOW_STEP);

  const [notice, setNotice] = useState("");
  const [importError, setImportError] = useState("");
  const [jsonResult, setJsonResult] = useState<BookmarkJsonResult | null>(null);
  const [confirmRemoveAll, setConfirmRemoveAll] = useState(false);

  const [headingError, setHeadingError] = useState("");
  const [candidates, setCandidates] = useState<HeadingCandidate[] | null>(null);

  // Load the existing outline whenever a new document arrives.
  useEffect(() => {
    setEntries([]);
    saveJob.reset();
    detectJob.reset();
    setImportError("");
    setNotice("");
    setHeadingError("");
    setCandidates(null);
    setJsonResult(null);
    setConfirmRemoveAll(false);
    setOutlineTruncated(false);
    setTruncatedAcknowledged(false);
    setWindowSize(WINDOW_STEP);
    if (!pdf.bytes) {
      setOutlineLoading(false);
      setOutlineError("");
      return;
    }
    let alive = true;
    setOutlineLoading(true);
    setOutlineError("");
    (async () => {
      try {
        const doc = await openPdfLib(pdf.bytes as ArrayBuffer);
        if (!alive) return;
        const read = readOutlineWithMeta(doc);
        setEntries(flattenOutline(read.nodes));
        setOutlineTruncated(read.truncated);
      } catch (err) {
        if (alive) {
          setOutlineError(
            friendlyProcessingError(err, "We couldn’t read this file’s outline. You can still add a new one below."),
          );
        }
      } finally {
        if (alive) setOutlineLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // The jobs are stable controllers; the document is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf.bytes]);

  const maxLevel = useMemo(() => entries.reduce((deepest, entry) => Math.max(deepest, entry.level), 0), [entries]);
  const visible = useMemo(() => (windowSize >= entries.length ? entries : entries.slice(0, windowSize)), [entries, windowSize]);

  /** Everything a first-time user can get wrong, stated plainly before saving. */
  const issues = useMemo(() => {
    const list: string[] = [];
    const positions = new Map<string, number[]>();
    entries.forEach((entry, index) => {
      const key = entry.title.trim().toLowerCase();
      if (!key) return;
      const rows = positions.get(key) ?? [];
      rows.push(index + 1);
      positions.set(key, rows);
    });
    positions.forEach((rows, key) => {
      if (rows.length > 1) list.push(`“${key}” appears ${rows.length} times (rows ${rows.slice(0, 6).join(", ")}).`);
    });
    const outOfRange = entries.filter((entry) => entry.page > Math.max(1, pdf.pageCount)).length;
    if (outOfRange) {
      list.push(
        `${countLabel(outOfRange, "bookmark")} target a page beyond ${Math.max(1, pdf.pageCount)} and will be clamped to the last page.`,
      );
    }
    const missingTargets = entries.filter((entry) => entry.page <= 0).length;
    if (missingTargets) {
      list.push(
        `${countLabel(missingTargets, "bookmark")} have no target page (“?”) and are saved without a destination.`,
      );
    }
    const missingTitles = entries.filter((entry) => !entry.title.trim()).length;
    if (missingTitles) {
      list.push(`${countLabel(missingTitles, "bookmark")} have no title and will be saved as “Untitled bookmark”.`);
    }
    if (maxLevel > MAX_OUTLINE_LEVELS) {
      list.push(`Nesting is deeper than ${MAX_OUTLINE_LEVELS} levels and will be flattened on save.`);
    }
    return list;
  }, [entries, pdf.pageCount, maxLevel]);

  const update = (next: OutlineEntry[], message = "") => {
    setEntries(next);
    saveJob.reset();
    setImportError("");
    if (message) setNotice(message);
    else setNotice("");
  };

  const patch = (index: number, changes: Partial<OutlineEntry>) => {
    setEntries((current) => current.map((entry, position) => (position === index ? { ...entry, ...changes } : entry)));
    saveJob.reset();
    setNotice("");
  };

  const setTargetPage = (index: number, page: number) => {
    const bounded = page <= 0 ? 0 : Math.min(Math.max(1, Math.round(page)), Math.max(1, pdf.pageCount));
    patch(index, { page: bounded });
  };

  const addBookmark = () => {
    const previous = entries[entries.length - 1];
    const page = previous && previous.page > 0 ? previous.page : 1;
    const level = previous ? previous.level : 1;
    update(insertEntry(entries, entries.length, { id: nextEntryId(), title: "New bookmark", page, level }));
    setWindowSize((size) => Math.max(size, entries.length + 1));
  };

  const removeAll = () => {
    update([], "Every bookmark was removed. Save to produce a PDF without an outline.");
  };

  const runDetection = () => {
    const source = pdf.bytes;
    if (!source) return;
    setHeadingError("");
    setCandidates(null);
    setNotice("");
    void detectJob.run(async ({ report, throwIfCancelled }) => {
      const { pages } = await extractDocumentGeometry(source, {
        onProgress: (done, total) => report((done / Math.max(1, total)) * 100, `Measuring headings… page ${done} of ${total}`),
      });
      throwIfCancelled();
      const found = detectHeadings(pages, {
        maxLevel: detectPrefs.value.headingLevels,
        minRatio: HEADING_RATIOS[detectPrefs.value.sensitivity] ?? 1.12,
        excludeRunningHeads: detectPrefs.value.skipRunningHeads,
      });
      if (!found.length) {
        setHeadingError(
          "No heading-like lines were found. This PDF may be a scan without a text layer — run OCR first, or add bookmarks by hand.",
        );
      }
      setCandidates(found.length ? found : null);
      return found;
    });
  };

  const appendCandidates = (list: HeadingCandidate[]) => {
    const seen = new Set(entries.map((entry) => `${entry.page}|${entry.title.trim().toLowerCase()}`));
    const additions: OutlineEntry[] = [];
    for (const candidate of list) {
      const key = `${candidate.page}|${candidate.title.trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      additions.push({
        id: nextEntryId(),
        title: candidate.title,
        page: Math.min(Math.max(1, candidate.page), Math.max(1, pdf.pageCount)),
        level: Math.min(MAX_OUTLINE_LEVELS, Math.max(1, candidate.level)),
      });
    }
    if (!additions.length) {
      setNotice("Those headings are already in your outline — nothing was added.");
      return;
    }
    const merged = normalizeEntries([...entries, ...additions]);
    update(merged, `Added ${countLabel(additions.length, "bookmark")} from detected headings. Review titles and targets before saving.`);
    setWindowSize((size) => Math.max(size, merged.length));
  };

  const save = () => {
    const source = pdf.bytes;
    const file = pdf.file;
    if (!source || !file) return;
    setNotice("");
    setJsonResult(null);
    void saveJob.run(async ({ report, throwIfCancelled }) => {
      report(10, "Opening the PDF…");
      const doc = await openPdfLib(source);
      const pageCount = doc.getPageCount();
      const cleaned = normalizeEntries(
        entries.map((entry) => ({
          ...entry,
          title: entry.title.trim() || "Untitled bookmark",
          page: entry.page <= 0 ? 0 : Math.min(Math.max(1, Math.round(entry.page)), pageCount),
        })),
      );
      throwIfCancelled();
      report(45, "Writing the bookmark tree…");
      const written = writeOutline(doc, cleaned);
      const bytes = await doc.save();
      report(80, "Reopening the saved file to verify…");

      // Reopen the exact bytes we are about to hand over: a broken outline must
      // never reach a download.
      const verifyDoc = await openPdfLib(bytes);
      const reread = readOutline(verifyDoc);
      const readCount = countOutlineNodes(reread);
      if (readCount !== written.nodeCount) {
        throw new Error(
          `The saved file reopened, but only ${readCount} of ${written.nodeCount} bookmarks could be read back. ` +
            "Nothing was downloaded — try shorter titles or re-save once more.",
        );
      }
      const expectedTargets = flattenOutline(entriesToTree(cleaned)).map((entry) => `${entry.level}:${entry.page}`);
      const actualTargets = flattenOutline(reread).map((entry) => `${entry.level}:${entry.page}`);
      if (expectedTargets.join("|") !== actualTargets.join("|")) {
        throw new Error("The saved outline reopened with different targets than expected. Nothing was downloaded — the original file is untouched.");
      }
      if (readCount === 0) setNotice("Saved with no bookmarks — the outline was removed from this copy.");
      return {
        bytes,
        name: `${sanitizeName(baseName(file.name))}-bookmarks.pdf`,
        pages: verifyDoc.getPageCount(),
        count: readCount,
      };
    });
  };

  const exportJson = () => {
    if (!pdf.file) return;
    const payload = {
      tool: "Paperly — Edit Bookmarks",
      file: pdf.file.name,
      pages: pdf.pageCount,
      exportedAt: new Date().toISOString(),
      bookmarks: entries.map((entry) => ({ title: entry.title, page: entry.page, level: entry.level })),
    };
    const name = `${sanitizeName(baseName(pdf.file.name))}-outline.json`;
    const bytes = new TextEncoder().encode(JSON.stringify(payload, null, 2));
    downloadBytes(bytes, name, "application/json");
    setJsonResult({ bytes, name });
  };

  const importOutline = async (file: File) => {
    setImportError("");
    setNotice("");
    try {
      if (!pdf.bytes) throw new Error("Add the PDF this outline belongs to first.");
      if (file.size > MAX_IMPORT_BYTES) throw new Error("That JSON file is larger than 2 MB — check that you picked an outline export.");
      const rows = readImportedOutline(JSON.parse(await file.text()));
      if (!rows) {
        throw new Error('Expected {"bookmarks": [{"title": "Chapter one", "page": 1, "level": 1}]} or a plain array of those objects.');
      }
      const imported = normalizeEntries(
        rows.map((row) => ({
          id: nextEntryId(),
          title: row.title,
          page: Math.max(0, row.page),
          level: row.level,
        })),
      );
      const clamped = imported.filter((entry) => entry.page > Math.max(1, pdf.pageCount)).length;
      setEntries(imported);
      saveJob.reset();
      setJsonResult(null);
      setConfirmRemoveAll(false);
      setWindowSize((size) => Math.max(WINDOW_STEP, Math.max(size, imported.length)));
      setNotice(
        `Imported ${countLabel(imported.length, "bookmark")} from ${file.name}${
          clamped ? ` · ${clamped} target${clamped === 1 ? "" : "s"} beyond page ${pdf.pageCount} will be clamped on save` : ""
        }. Review the tree, then save.`,
      );
    } catch (err) {
      setImportError(`That outline couldn’t be read: ${(err as Error).message}`);
    }
  };

  const result = saveJob.result;
  usePrimaryShortcut(save, Boolean(pdf.bytes) && !saveJob.busy);
  useDownloadShortcut(() => {
    if (result) downloadBytes(result.bytes, result.name);
  }, Boolean(result));

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to outline" />

      {pdf.bytes && (
        <>
          {outlineLoading && <Progress label="Reading the existing bookmark tree…" />}

          {outlineError && (
            <Alert tone="warning" title="This outline couldn’t be read">
              {outlineError} Saving will replace whatever outline is stored in the file — the pages themselves stay untouched.
            </Alert>
          )}

          {outlineTruncated && (
            <Alert tone="warning" title="This outline is unusually large">
              Only the first {countLabel(entries.length, "bookmark")} could be loaded, so saving this copy here would drop the rest.
              {truncatedAcknowledged
                ? " You have chosen to save the loaded subset anyway."
                : " Tick the confirmation below only if that is what you want."}
            </Alert>
          )}

          {!outlineLoading && !outlineError && (
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={entries.length ? "forest" : "neutral"}>
                <BookMarked className="h-3.5 w-3.5" />
                {countLabel(entries.length, "bookmark")}
              </Badge>
              {maxLevel > 0 && <Badge tone="neutral">{countLabel(maxLevel, "level")}</Badge>}
              <span className="text-[11.5px] text-muted">
                {entries.length
                  ? "Edit titles, targets and nesting — then save a copy that opens with this outline."
                  : "No bookmarks yet. Add one by hand, generate a starter outline from the headings, or import a JSON outline."}
              </span>
            </div>
          )}

          {notice && <Alert tone="success">{notice}</Alert>}
          {importError && <Alert tone="error">{importError}</Alert>}

          {issues.length > 0 && (
            <Alert tone="warning" title={`${issues.length} thing${issues.length === 1 ? "" : "s"} to review`}>
              <ul className="mt-1 space-y-0.5">
                {issues.slice(0, 6).map((issue) => (
                  <li key={issue}>• {issue}</li>
                ))}
              </ul>
              {issues.length > 6 && <p className="mt-1">…and {issues.length - 6} more.</p>}
            </Alert>
          )}

          <StepHeader step={2} title="Bookmark tree" hint="Use the arrows to reorder, nest and lift rows" />

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={addBookmark}>
              <Plus className="h-3.5 w-3.5" /> Add bookmark
            </Button>
            <Button variant="outline" size="sm" onClick={runDetection} loading={detectJob.busy}>
              {!detectJob.busy && <Sparkles className="h-3.5 w-3.5" />} Generate from headings
            </Button>
            {entries.length > 0 && (
              <Button variant="outline" size="sm" onClick={exportJson}>
                <FileJson className="h-3.5 w-3.5" /> Export outline as JSON
              </Button>
            )}
            <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-paper px-2.5 text-[11.5px] font-medium text-ink/70 transition-colors hover:border-forest/30 hover:text-forest">
              <Upload className="h-3.5 w-3.5" /> Import outline JSON
              <input
                type="file"
                accept="application/json,.json"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void importOutline(file);
                }}
              />
            </label>
            {entries.length > 0 &&
              (confirmRemoveAll ? (
                <span className="flex flex-wrap items-center gap-1.5 rounded-xl border border-clay/30 bg-clay/[0.05] px-2 py-1">
                  <span className="text-[11.5px] font-medium text-clay-ink">
                    Remove all {countLabel(entries.length, "bookmark")}?
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      removeAll();
                      setConfirmRemoveAll(false);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Remove all
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmRemoveAll(false)}>
                    Keep them
                  </Button>
                </span>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setConfirmRemoveAll(true)}>
                  <Trash2 className="h-3.5 w-3.5" /> Remove all
                </Button>
              ))}
          </div>

          <AdvancedOptions
            scope="bookmarks"
            badge="3 controls"
            description="How heading detection reads the page"
            onReset={detectPrefs.reset}
          >
            <div className="space-y-3">
              <PresetChips
                label="Heading sensitivity"
                value={detectPrefs.value.sensitivity}
                presets={[
                  { id: "sensitive", label: "Sensitive", description: "Finds subtler headings — more false positives on dense layouts." },
                  { id: "balanced", label: "Balanced", description: "Works well for reports, contracts and manuals." },
                  { id: "strict", label: "Strict", description: "Only clearly larger lines become bookmarks." },
                ]}
                onSelect={(preset) => detectPrefs.set("sensitivity", preset.id as HeadingSensitivity)}
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Deepest heading level" hint="Deeper outlines mean more nesting.">
                  <Select
                    value={String(detectPrefs.value.headingLevels)}
                    onChange={(event) => detectPrefs.set("headingLevels", Number(event.target.value))}
                  >
                    <option value="1">Level 1 only</option>
                    <option value="2">Up to level 2</option>
                    <option value="3">Up to level 3</option>
                  </Select>
                </Field>
                <div className="flex items-end">
                  <Switch
                    checked={detectPrefs.value.skipRunningHeads}
                    onChange={(value) => detectPrefs.set("skipRunningHeads", value)}
                    label="Skip repeated header/footer text"
                    description="Ignores lines that repeat on most pages"
                  />
                </div>
              </div>
              <OptionNote>
                Detection works on the text layer, so scanned PDFs need OCR first. Every candidate is inserted only when you choose to.
              </OptionNote>
            </div>
          </AdvancedOptions>

          {detectJob.busy && (
            <Progress value={detectJob.percent ?? undefined} label={detectJob.label} detail={describeJobTime(detectJob)} />
          )}
          {headingError && <Alert tone="warning">{headingError}</Alert>}
          {detectJob.failed && <Alert tone="error">{detectJob.error}</Alert>}

          {candidates && (
            <div className="rounded-xl border border-forest/15 bg-lime/15 p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-[12px] font-semibold text-forest">
                  <Wand2 className="h-3.5 w-3.5" /> {countLabel(candidates.length, "heading candidate")} found
                </p>
                <div className="flex items-center gap-1.5">
                  {candidates.length > 0 && (
                    <Button size="sm" variant="soft" onClick={() => appendCandidates(candidates)}>
                      Insert all
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setCandidates(null)}>
                    Hide
                  </Button>
                </div>
              </div>
              {candidates.length === 0 ? (
                <p className="mt-2 text-[11.5px] leading-relaxed text-ink/70">
                  Nothing to insert. Detection relies on the text layer and on headings being noticeably larger than body text.
                </p>
              ) : (
                <ul className="mt-2 max-h-60 space-y-1 overflow-y-auto pr-1">
                  {candidates.slice(0, 80).map((candidate, index) => (
                    <li
                      key={`${candidate.page}-${index}-${candidate.title}`}
                      className="flex items-center gap-2 rounded-lg border border-line/60 bg-paper px-2 py-1"
                    >
                      <span className="w-9 shrink-0 text-[10px] font-semibold tabular-nums text-muted">p.{candidate.page}</span>
                      <span className="shrink-0 rounded bg-forest/10 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-forest">
                        L{candidate.level}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12px]">{candidate.title}</span>
                      <Button size="sm" variant="ghost" onClick={() => appendCandidates([candidate])}>
                        Insert
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {candidates.length > 80 && (
                <p className="mt-1.5 text-[10.5px] text-muted">Showing the first 80 candidates — “Insert all” adds every one.</p>
              )}
            </div>
          )}

          {entries.length === 0 ? (
            !outlineLoading && (
              <EmptyHint>
                An outline is the navigation tree readers see beside the page. Add your first bookmark above, use heading detection
                on a document that already has a text layer, or import a JSON outline you exported earlier.
              </EmptyHint>
            )
          ) : (
            <ol className="space-y-1.5" aria-label="Bookmark tree">
              {visible.map((entry, index) => (
                <li key={entry.id}>
                  <div
                    className={cn(
                      "flex flex-wrap items-center gap-1.5 rounded-xl border border-line bg-paper px-2 py-1.5",
                      entry.level > 1 && "border-l-2 border-l-forest/25",
                    )}
                    style={{ marginLeft: `${Math.min(entry.level - 1, MAX_OUTLINE_LEVELS - 1) * 16}px` }}
                  >
                    <span className="w-5 shrink-0 text-center text-[10px] font-semibold tabular-nums text-ink/35">{index + 1}</span>
                    <input
                      value={entry.title}
                      onChange={(event) => patch(index, { title: event.target.value })}
                      aria-label={`Bookmark ${index + 1} title`}
                      placeholder="Bookmark title"
                      maxLength={200}
                      className={cn(smallInputClass, "min-w-[130px] flex-1")}
                    />
                    <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-muted">
                      <input
                        type="number"
                        min={1}
                        max={Math.max(1, pdf.pageCount)}
                        value={entry.page > 0 ? entry.page : ""}
                        placeholder="?"
                        onChange={(event) => {
                          const raw = event.target.value;
                          setTargetPage(index, raw === "" ? 0 : Number(raw));
                        }}
                        aria-label={`Target page for bookmark ${index + 1}`}
                        className={cn(smallInputClass, "w-16 px-1.5 text-center tabular-nums")}
                      />
                      <span className="whitespace-nowrap">/ {pdf.pageCount}</span>
                    </span>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <RowButton label={`Move bookmark ${index + 1} up`} disabled={index === 0} onClick={() => update(moveEntry(entries, index, "up"))}>
                        <ArrowUp className="h-3.5 w-3.5" />
                      </RowButton>
                      <RowButton
                        label={`Move bookmark ${index + 1} down`}
                        disabled={index === entries.length - 1}
                        onClick={() => update(moveEntry(entries, index, "down"))}
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </RowButton>
                      <RowButton
                        label={`Nest bookmark ${index + 1} deeper`}
                        disabled={index === 0 || entry.level >= MAX_OUTLINE_LEVELS}
                        onClick={() => update(indentEntry(entries, index))}
                      >
                        <IndentIncrease className="h-3.5 w-3.5" />
                      </RowButton>
                      <RowButton
                        label={`Lift bookmark ${index + 1} a level`}
                        disabled={entry.level <= 1}
                        onClick={() => update(outdentEntry(entries, index))}
                      >
                        <IndentDecrease className="h-3.5 w-3.5" />
                      </RowButton>
                      <RowButton label={`Delete bookmark ${index + 1}`} onClick={() => update(removeEntry(entries, index))}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </RowButton>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}

          {entries.length > visible.length && (
            <div className="flex justify-center">
              <Button variant="outline" size="sm" onClick={() => setWindowSize((size) => Math.min(entries.length, size + 200))}>
                Show more ({entries.length - visible.length} remaining)
              </Button>
            </div>
          )}

          {entries.length > 0 && (
            <div className="rounded-xl border border-line bg-bone-deep/30 p-3 text-[11.5px] leading-relaxed text-ink/70">
              <p className="flex items-center gap-1.5 font-semibold text-forest">
                <Info className="h-3.5 w-3.5" /> Bookmarks are navigation only
              </p>
              <p className="mt-1">
                Saving rewrites the document catalog and outline objects; pages, text and images are copied through untouched. Targets
                set to “?” are saved without a destination.
              </p>
            </div>
          )}

          {outlineTruncated && (
            <Switch
              checked={truncatedAcknowledged}
              onChange={setTruncatedAcknowledged}
              label="Replace the outline with the loaded bookmarks"
              description="The bookmarks beyond the read limit will not be present in the saved copy."
            />
          )}

          {saveJob.failed && (
            <Alert tone="error" title="Couldn’t save the outline">
              {saveJob.error}
            </Alert>
          )}
          {saveJob.status === "cancelled" && <Alert tone="info">Cancelled — nothing was downloaded.</Alert>}
          {saveJob.busy && (
            <Progress value={saveJob.percent ?? undefined} label={saveJob.label} detail={describeJobTime(saveJob)} />
          )}

          <div className="flex flex-wrap items-center gap-2.5 border-t border-line pt-4">
            <Button
              onClick={save}
              loading={saveJob.busy}
              disabled={saveJob.busy || outlineLoading || (outlineTruncated && !truncatedAcknowledged)}
            >
              <BookMarked className="h-4 w-4" /> Save bookmarks
            </Button>
            {saveJob.busy && (
              <Button variant="outline" onClick={saveJob.cancel}>
                Cancel
              </Button>
            )}
            <span className="text-[11.5px] text-muted">
              {entries.length ? `${countLabel(entries.length, "bookmark")} · ${pdf.pageCount} pages` : "The outline will be removed when saved."}
            </span>
          </div>
        </>
      )}

      {jsonResult && (
        <DownloadPanel
          bytes={jsonResult.bytes}
          filename={jsonResult.name}
          size={jsonResult.bytes.byteLength}
          title="Outline JSON ready"
          description={`${countLabel(entries.length, "bookmark")} exported · import this file into the same or another document`}
          mime="application/json"
          onDownload={() => downloadBytes(jsonResult.bytes, jsonResult.name, "application/json")}
          allowRename={false}
        />
      )}

      {result && (
        <DownloadPanel
          bytes={result.bytes}
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          title={result.count ? "Bookmarks saved" : "Bookmarks removed"}
          description={
            result.count
              ? `${countLabel(result.count, "bookmark")} · library opens with the outline visible · page content untouched`
              : "The saved copy has no bookmark tree. Everything else is unchanged."
          }
          onDownload={() => downloadBytes(result.bytes, result.name)}
          facts={[
            { label: "Bookmarks", value: String(result.count) },
            { label: "Depth", value: countLabel(maxLevel || 1, "level") },
          ]}
          handoffIds={["split-bookmarks", "organize", "sanitize"]}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * SPLIT BY BOOKMARKS
 * ================================================================== */

interface SplitResult {
  zipName: string;
  zipBytes: Uint8Array;
  files: { name: string; bytes: Uint8Array }[];
  totalPages: number;
}

interface SplitPrefs extends Record<string, unknown> {
  template: string;
  frontMatter: boolean;
}

const DEFAULT_TEMPLATE = "{name}-{title}";

/** Render one output name from the template tokens. */
function renderFileName(template: string, documentBase: string, range: SplitRange, index: number): string {
  const rendered = template
    .replace(/\{name\}/gi, documentBase)
    .replace(/\{title\}/gi, sanitizeBookmarkTitle(range.title))
    .replace(/\{index\}/gi, String(index + 1));
  return sanitizeName(rendered, `section-${index + 1}`);
}

export function SplitByBookmarksTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const job = useJob<SplitResult>();
  const opts = useToolPreferences<SplitPrefs>("split-bookmarks", {
    template: DEFAULT_TEMPLATE,
    frontMatter: true,
  });

  const [nodes, setNodes] = useState<OutlineNode[]>([]);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [outlineError, setOutlineError] = useState("");
  const [outlineTruncated, setOutlineTruncated] = useState(false);
  const [maxLevel, setMaxLevel] = useState(1);
  const [error, setError] = useState("");

  useEffect(() => {
    setNodes([]);
    setOutlineError("");
    setOutlineTruncated(false);
    setMaxLevel(1);
    setError("");
    job.reset();
    if (!pdf.bytes) {
      setOutlineLoading(false);
      return;
    }
    let alive = true;
    setOutlineLoading(true);
    (async () => {
      try {
        const doc = await openPdfLib(pdf.bytes as ArrayBuffer);
        if (!alive) return;
        const read = readOutlineWithMeta(doc);
        setNodes(read.nodes);
        setOutlineTruncated(read.truncated);
      } catch (err) {
        if (alive) setOutlineError(friendlyProcessingError(err, "We couldn’t read this file’s outline."));
      } finally {
        if (alive) setOutlineLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // The job is a stable controller; the document is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf.bytes]);

  const entries = useMemo(() => flattenOutline(nodes), [nodes]);
  const availableDepth = useMemo(() => Math.max(1, maxOutlineDepth(nodes)), [nodes]);
  const ranges = useMemo(
    () => computeSplitRanges(entries, pdf.pageCount, { maxLevel, includeFrontMatter: opts.value.frontMatter }),
    [entries, pdf.pageCount, maxLevel, opts.value.frontMatter],
  );
  const documentBase = pdf.file ? sanitizeName(baseName(pdf.file.name)) : "document";
  const template = opts.value.template.trim() || DEFAULT_TEMPLATE;
  const fileStems = useMemo(
    () => uniqueFileNames(ranges.map((range, index) => renderFileName(template, documentBase, range, index))),
    [ranges, template, documentBase],
  );

  const depthOptions = useMemo(() => {
    const deep = Math.min(MAX_OUTLINE_LEVELS, availableDepth);
    const options: { value: number; label: string }[] = [{ value: 1, label: "Top level only" }];
    for (let level = 2; level <= deep; level += 1) options.push({ value: level, label: `Up to level ${level}` });
    return options;
  }, [availableDepth]);

  const templateIssues = useMemo(() => {
    const list: string[] = [];
    if (!/\{(name|title|index)\}/i.test(template)) {
      list.push("The template has no token, so every section would get the same name (numbers are added automatically).");
    }
    if (/\{[^}]*\}/.test(template.replace(/\{(name|title|index)\}/gi, ""))) {
      list.push("Unknown token removed — only {name}, {title} and {index} are replaced.");
    }
    return list;
  }, [template]);

  const generate = () => {
    const source = pdf.bytes;
    const file = pdf.file;
    if (!source || !file || !ranges.length) return;
    setError("");
    void job.run(async ({ report, throwIfCancelled }) => {
      report(5, "Opening the PDF…");
      const sourceDoc = await openPdfLib(source);
      const sourcePages = sourceDoc.getPageCount();
      const files: { name: string; bytes: Uint8Array }[] = [];
      for (let index = 0; index < ranges.length; index += 1) {
        throwIfCancelled();
        const range = ranges[index];
        const indices: number[] = [];
        for (let page = range.startPage; page <= range.endPage; page += 1) {
          if (page >= 1 && page <= sourcePages) indices.push(page - 1);
        }
        if (!indices.length) continue;
        // updateMetadata: false keeps the output UUID-free and byte-deterministic
        // for the same input and settings (no "now" timestamps are written).
        const out = await PDFDocument.create({ updateMetadata: false });
        const copied = await out.copyPages(sourceDoc, indices);
        copied.forEach((page) => out.addPage(page));
        try {
          out.setTitle(`${baseName(file.name)} — ${range.title}`.slice(0, 180));
        } catch {
          /* a title is a nicety, never a failure */
        }
        files.push({
          name: `${fileStems[index] ?? `section-${index + 1}`}.pdf`,
          bytes: await out.save(),
        });
        report(((index + 1) / ranges.length) * 85, "Copying each section…", `${index + 1} of ${ranges.length}`);
      }
      if (!files.length) throw new Error("None of the bookmark targets fall inside this PDF's page range.");
      throwIfCancelled();
      report(90, "Packaging the ZIP…");
      const zip = new JSZip();
      files.forEach((entry) => zip.file(entry.name, entry.bytes));
      const zipBytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
      return { zipName: `${documentBase}-sections.zip`, zipBytes, files, totalPages: sourcePages };
    });
  };

  const openBookmarksWithSameFile = () => {
    if (!pdf.bytes || !pdf.file) return;
    const file = new File([pdf.bytes as unknown as BlobPart], pdf.file.name, { type: "application/pdf" });
    startTool("bookmarks", [file]);
  };

  const result = job.result;
  usePrimaryShortcut(generate, Boolean(pdf.bytes) && ranges.length > 0 && !job.busy);
  useDownloadShortcut(() => {
    if (result) downloadBytes(result.zipBytes, result.zipName, "application/zip");
  }, Boolean(result));

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A bookmarked PDF to split" />

      {pdf.bytes && (
        <>
          {outlineLoading && <Progress label="Reading this PDF’s outline…" />}
          {outlineError && (
            <Alert tone="error" title="That outline won’t open">
              {outlineError}
            </Alert>
          )}
          {outlineTruncated && (
            <Alert tone="warning" title="Only part of this outline was read">
              This document has an unusually large bookmark tree. Sections beyond the first {countLabel(entries.length, "bookmark")} are
              not included in the split.
            </Alert>
          )}

          {!outlineLoading && !outlineError && entries.length === 0 && (
            <div className="space-y-3">
              <Alert tone="warning" title="This PDF has no bookmarks">
                Splitting by bookmarks needs an outline: each section becomes one PDF, using the bookmark titles as file names and the
                bookmark targets as start pages. A scanned or unbookmarked PDF has no sections to split on.
              </Alert>
              <Button variant="soft" onClick={openBookmarksWithSameFile}>
                <BookMarked className="h-4 w-4" /> Create bookmarks for this file
              </Button>
            </div>
          )}

          {entries.length > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="forest">
                  <ListTree className="h-3.5 w-3.5" />
                  {countLabel(entries.length, "bookmark")}
                </Badge>
                <Badge tone="neutral">{countLabel(availableDepth, "level")} deep</Badge>
                <span className="text-[11.5px] text-muted">Sections are the bookmark targets in page order.</span>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Split depth" hint="Nested bookmarks only split when their level is included.">
                  <Select
                    value={String(maxLevel)}
                    onChange={(event) => {
                      setMaxLevel(Number(event.target.value));
                      job.reset();
                    }}
                  >
                    {depthOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="flex items-end">
                  <Switch
                    checked={opts.value.frontMatter}
                    onChange={(value) => {
                      opts.set("frontMatter", value);
                      job.reset();
                    }}
                    label="Separate front-matter file"
                    description="Pages before the first bookmark get their own PDF."
                  />
                </div>
                <div className="sm:col-span-2">
                  <Field
                    label="File name template"
                    hint="Tokens: {name} document name · {title} bookmark title · {index} section number."
                  >
                    <input
                      value={opts.value.template}
                      onChange={(event) => opts.set("template", event.target.value)}
                      placeholder={DEFAULT_TEMPLATE}
                      className={smallInputClass}
                      spellCheck={false}
                      aria-label="File name template"
                    />
                  </Field>
                  <p className="mt-1 truncate text-[11px] text-muted">
                    Example output: <span className="font-mono text-ink/70">{fileStems[0] ?? "section"}.pdf</span>
                    {fileStems.length > 1 ? (
                      <>
                        {" · "}
                        <span className="font-mono text-ink/70">{fileStems[1]}.pdf</span>
                      </>
                    ) : null}
                  </p>
                </div>
              </div>

              {templateIssues.length > 0 && (
                <Alert tone="warning" title="Check the file name template">
                  <ul className="mt-1 space-y-0.5">
                    {templateIssues.map((issue) => (
                      <li key={issue}>• {issue}</li>
                    ))}
                  </ul>
                </Alert>
              )}

              {ranges.length === 0 ? (
                <Alert tone="warning" title="No usable section targets">
                  The outline exists, but none of its bookmarks point at a page inside this PDF at the selected depth. Open{" "}
                  <a href="#/tool/bookmarks" className="font-semibold underline">
                    Edit Bookmarks
                  </a>{" "}
                  to repair the targets.
                </Alert>
              ) : (
                <>
                  <StepHeader step={3} title="Sections" hint={`${countLabel(ranges.length, "PDF")} in the ZIP`} />
                  <div className="overflow-hidden rounded-xl border border-line">
                    <table className="w-full text-[12px]">
                      <thead className="bg-bone-deep/50 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-ink/60">
                        <tr>
                          <th scope="col" className="px-3 py-2">
                            Section
                          </th>
                          <th scope="col" className="px-3 py-2">
                            Pages
                          </th>
                          <th scope="col" className="hidden px-3 py-2 sm:table-cell">
                            Output file
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {ranges.map((range, index) => (
                          <RangeRow
                            key={`${range.startPage}-${index}-${range.title}`}
                            range={range}
                            fileName={`${fileStems[index]}.pdf`}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-[11px] text-muted">
                    {ranges.reduce((sum, range) => sum + range.pages, 0)} of {pdf.pageCount} pages included
                    {opts.value.frontMatter ? "" : " (front matter skipped)"} · segments are contiguous, so no page is duplicated.
                  </p>
                </>
              )}

              {error && <Alert tone="error">{error}</Alert>}
              {job.failed && <Alert tone="error">{job.error}</Alert>}
              {job.status === "cancelled" && <Alert tone="info">Cancelled — nothing was downloaded.</Alert>}

              <div className="flex flex-wrap items-center gap-2.5 border-t border-line pt-4">
                <Button onClick={generate} loading={job.busy} disabled={job.busy || !ranges.length}>
                  <Scissors className="h-4 w-4" /> Split into {countLabel(ranges.length, "PDF")}
                </Button>
                {job.busy && (
                  <Button variant="outline" onClick={job.cancel}>
                    Cancel
                  </Button>
                )}
                <span className="flex items-center gap-1 text-[11.5px] text-muted">
                  <FileText className="h-3.5 w-3.5" /> Original page content, no re-rendering
                </span>
              </div>
              {job.busy && <Progress value={job.percent ?? undefined} label={job.label} detail={describeJobTime(job)} />}
            </>
          )}
        </>
      )}

      {result && (
        <DownloadPanel
          filename={result.zipName}
          size={result.zipBytes.byteLength}
          pages={result.totalPages}
          title={`${countLabel(result.files.length, "section PDF")} ready`}
          description={`ZIP · ${formatSections(result.files.length, result.totalPages)} · originals unchanged`}
          onDownload={() => downloadBytes(result.zipBytes, result.zipName, "application/zip")}
          bytes={result.zipBytes}
          mime="application/zip"
          facts={[
            { label: "Sections", value: String(result.files.length) },
            { label: "Depth", value: countLabel(maxLevel, "level") },
          ]}
          extra={
            <div className="mt-1 space-y-1">
              {result.files.slice(0, 8).map((file) => (
                <p key={file.name} className="flex items-center gap-1.5 text-[11px] text-paper/70">
                  <FileText className="h-3 w-3 shrink-0 text-lime" />
                  <span className="truncate">{file.name}</span>
                </p>
              ))}
              {result.files.length > 8 && (
                <p className="text-[11px] text-paper/50">…and {result.files.length - 8} more inside the ZIP</p>
              )}
            </div>
          }
        />
      )}
    </div>
  );
}

function RangeRow({ range, fileName }: { range: SplitRange; fileName: string }) {
  return (
    <tr className="bg-paper">
      <td className="px-3 py-2">
        <span className="flex items-center gap-1.5" style={{ paddingLeft: `${(range.level - 1) * 12}px` }}>
          {range.isFrontMatter ? (
            <FileText className="h-3.5 w-3.5 shrink-0 text-muted" />
          ) : (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-forest/50" />
          )}
          <span className="min-w-0 truncate font-medium">{range.title}</span>
          {range.bookmarkCount > 1 && <Badge tone="neutral">{range.bookmarkCount} merged</Badge>}
        </span>
      </td>
      <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted">
        {range.startPage === range.endPage ? range.startPage : `${range.startPage}–${range.endPage}`}
        <span className="ml-1 text-ink/35">({range.pages}p)</span>
      </td>
      <td className="hidden max-w-[220px] truncate px-3 py-2 font-mono text-[10.5px] text-muted sm:table-cell">{fileName}</td>
    </tr>
  );
}

function formatSections(files: number, pages: number): string {
  return `${files} PDF${files === 1 ? "" : "s"} from ${pages} page${pages === 1 ? "" : "s"}`;
}
