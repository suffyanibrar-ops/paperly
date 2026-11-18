import {
  Check,
  Copy,
  Download,
  FileSearch,
  Info,
  Plus,
  RefreshCw,
  ScanText,
  Search,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
  type PDFContext,
  type PDFDocument as PDFLibDocument,
  type PDFObject,
} from "@cantoo/pdf-lib";
import { extractPage } from "@/lib/extract";
import {
  STOPWORDS,
  chunkPages,
  extractAnswerWindows,
  highlightRanges,
  rankPassages,
  tokenize,
  verdict,
  type AnswerWindow,
  type HighlightRange,
  type Passage,
  type RankResult,
  type Verdict,
  type VerdictStatus,
} from "@/lib/knowledge";
import {
  MAX_PDF_PAGES,
  baseName,
  downloadBytes,
  formatBytes,
  openPdfJs,
  openPdfLib,
  parseRanges,
  readFileBytes,
  readablePdfError,
  sanitizeName,
} from "@/lib/pdf";
import { copyText } from "@/lib/router";
import { friendlyProcessingError, validateUpload } from "@/lib/security";
import { useInitialFiles, usePdfFile } from "@/lib/usePdf";
import { useDownloadShortcut, usePrimaryShortcut } from "@/lib/hotkeys";
import { useToolPreferences } from "@/lib/prefs";
import { SAMPLE } from "@/lib/sample";
import { Alert, Badge, Button, Field, FileDrop, FileRow, Progress, Segmented, Switch, inputClass } from "@/components/ui";
import { AdvancedOptions, NumberField, OptionNote, OptionsGrid } from "@/components/AdvancedOptions";
import { DownloadPanel, SinglePdfInput } from "@/components/toolParts";
import { cn } from "@/utils/cn";

/* ================================================================== *
 * Shared helpers
 * ================================================================== */
function fileKey(file: File): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

/** Compress an ascending-ish page number list into ranges: "1–4, 7, 9–12". */
function formatPageList(pages: readonly number[], limit = 5): string {
  if (!pages.length) return "None";
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let end = sorted[0];
  const flush = () => ranges.push(start === end ? `${start}` : `${start}–${end}`);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) end = sorted[i];
    else {
      flush();
      start = sorted[i];
      end = sorted[i];
    }
  }
  flush();
  return `${ranges.slice(0, limit).join(", ")}${ranges.length > limit ? ` … (${sorted.length} total)` : ""}`;
}

function HighlightedText({ text, ranges }: { text: string; ranges: HighlightRange[] }) {
  if (!ranges.length) return <>{text}</>;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor || range.start >= text.length) continue;
    if (range.start > cursor) nodes.push(text.slice(cursor, range.start));
    const end = Math.min(text.length, range.end);
    nodes.push(
      <mark key={`${range.start}-${range.end}`} className="rounded-[3px] bg-lime/70 px-0.5 text-ink">
        {text.slice(range.start, end)}
      </mark>,
    );
    cursor = end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}

/* ================================================================== *
 * ASK YOUR PDF — local extractive retrieval
 * ================================================================== */
const MAX_DOCS = 5;
const MAX_TOTAL_PAGES = 400;
const MAX_CHUNK_CHARS = 720;
const MAX_CONVERSATION = 12;
const MAX_ANSWER_SENTENCES = 3;

const FALLBACK_SUGGESTIONS = [
  "What is this document about?",
  "What are the main findings?",
  "What dates, amounts or deadlines are mentioned?",
];

interface FileMeta {
  pages: number;
  loading: boolean;
  error: string;
}

interface KnowledgeDoc {
  id: string;
  name: string;
  pageCount: number;
  pagesRead: number;
  textChars: number;
}

interface KnowledgeIndex {
  passages: Passage[];
  docs: KnowledgeDoc[];
  pagesRead: number;
  requestedPages: number;
  capped: boolean;
  emptyTextDocs: string[];
  unreadableFiles: string[];
}

interface SearchResult {
  question: string;
  rank: RankResult;
  windows: AnswerWindow[];
  verdict: Verdict;
  index: KnowledgeIndex;
}

interface QaEntry {
  id: string;
  at: number;
  result: SearchResult;
}

/** Thrown between page reads when the visitor cancels the index build. */
class AskCancelledError extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "AskCancelledError";
  }
}

/** Load page counts for each selected PDF, one at a time. */
function useFileMetas(files: File[]): Record<string, FileMeta> {
  const [metas, setMetas] = useState<Record<string, FileMeta>>({});
  const loaded = useRef(new Set<string>());

  useEffect(() => {
    let alive = true;
    void (async () => {
      for (const file of files) {
        const key = fileKey(file);
        if (loaded.current.has(key)) continue;
        setMetas((previous) => ({ ...previous, [key]: { pages: 0, loading: true, error: "" } }));
        try {
          await validateUpload(file, "application/pdf,.pdf");
          const bytes = await readFileBytes(file);
          const doc = await openPdfJs(bytes, undefined, { maxPages: MAX_PDF_PAGES });
          const pages = doc.numPages;
          await doc.destroy();
          if (!alive) return;
          loaded.current.add(key);
          setMetas((previous) => ({ ...previous, [key]: { pages, loading: false, error: "" } }));
        } catch (err) {
          if (!alive) return;
          loaded.current.add(key);
          setMetas((previous) => ({
            ...previous,
            [key]: { pages: 0, loading: false, error: friendlyProcessingError(err, "This PDF couldn’t be read.") },
          }));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [files]);

  return metas;
}

const VERDICT_META: Record<VerdictStatus, { label: string; tone: "forest" | "neutral" | "clay"; blurb: string }> = {
  answered: { label: "Strong match", tone: "forest", blurb: "The passages below directly contain your query terms." },
  weak: { label: "Weak match", tone: "neutral", blurb: "Only part of your question matched. Try fewer or more specific words." },
  "not-found": { label: "No match", tone: "clay", blurb: "Those words don’t appear together in the searched pages." },
};

function answerAsText(result: SearchResult): string {
  const lines: string[] = [
    `Question: ${result.question}`,
    `Confidence: ${Math.round(result.verdict.confidence * 100)}% (${VERDICT_META[result.verdict.status].label})`,
    "",
  ];
  if (result.windows.length) {
    lines.push("Answer passages (verbatim):");
    result.windows.forEach((window, index) => {
      lines.push(`${index + 1}. ${window.text}`);
      lines.push(`   — ${window.docName}, page ${window.page}`);
    });
  } else {
    lines.push("No single sentence contained enough of the query terms.");
  }
  lines.push("", "Source passages:");
  result.rank.passages.forEach((passage, index) => {
    lines.push(`[${index + 1}] ${passage.docName}, page ${passage.page}: ${passage.text}`);
  });
  lines.push(
    "",
    `Searched ${result.index.pagesRead} page${result.index.pagesRead === 1 ? "" : "s"} across ${result.index.docs.length} PDF${
      result.index.docs.length === 1 ? "" : "s"
    } (${result.index.passages.length} passages indexed).`,
    "Retrieved locally by Paperly from the document text layer. Extractive only — no generative AI and nothing left this tab.",
  );
  return lines.join("\n");
}

function answerAsMarkdown(result: SearchResult): string {
  const lines: string[] = [
    `# ${result.question}`,
    "",
    `**Confidence:** ${Math.round(result.verdict.confidence * 100)}% · ${VERDICT_META[result.verdict.status].label}`,
    "",
    "## Answer passages (verbatim)",
    "",
  ];
  if (result.windows.length) {
    for (const window of result.windows) {
      lines.push(`> ${window.text}`, `>`, `> — *${window.docName}*, page ${window.page}`, "");
    }
  } else {
    lines.push("_No single sentence contained enough of the query terms._", "");
  }
  lines.push("## Sources", "");
  result.rank.passages.forEach((passage, index) => {
    lines.push(`${index + 1}. **${passage.docName}**, page ${passage.page}`, "", `   > ${passage.text}`, "");
  });
  lines.push(
    "---",
    "",
    `Searched ${result.index.pagesRead} page${result.index.pagesRead === 1 ? "" : "s"} across ${result.index.docs.length} PDF${
      result.index.docs.length === 1 ? "" : "s"
    } · ${result.index.passages.length} passages indexed.`,
    "",
    "Generated locally by Paperly from the document text layer. Extractive retrieval only: every sentence is copied verbatim. No generative AI, no upload and no model calls.",
  );
  return lines.join("\n");
}

/** Shorten a quoted sentence for a citation line. */
function quoteForCitation(text: string, max = 180): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1).trimEnd()}…` : compact;
}

/**
 * Suggest 3–4 questions built from the words that actually repeat in the
 * indexed passages, so the tool is usable without knowing what to ask.
 */
function deriveSuggestions(passages: readonly Passage[], limit = 4): string[] {
  if (!passages.length) return FALLBACK_SUGGESTIONS.slice(0, limit);
  const unigrams = new Map<string, number>();
  const bigrams = new Map<string, number>();
  for (const passage of passages) {
    const words = tokenize(passage.text).filter((word) => word.length >= 3 && !/^\d+$/.test(word) && !STOPWORDS.has(word));
    for (let index = 0; index < words.length; index++) {
      unigrams.set(words[index], (unigrams.get(words[index]) ?? 0) + 1);
      if (index + 1 < words.length) {
        const pair = `${words[index]} ${words[index + 1]}`;
        bigrams.set(pair, (bigrams.get(pair) ?? 0) + 1);
      }
    }
  }
  const topBigrams = [...bigrams.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([phrase]) => phrase);
  const topWords = [...unigrams.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([word]) => word);
  const derived: string[] = [];
  for (const phrase of topBigrams) derived.push(`What does the document say about “${phrase}”?`);
  for (const word of topWords) {
    if (derived.length >= limit) break;
    if (topBigrams.some((phrase) => phrase.split(" ").includes(word))) continue;
    derived.push(`Where is “${word}” mentioned?`);
  }
  const unique: string[] = [];
  for (const question of [...derived, ...FALLBACK_SUGGESTIONS]) {
    if (unique.includes(question)) continue;
    unique.push(question);
    if (unique.length >= limit) break;
  }
  return unique;
}

/** Whole conversation as one Markdown document, citations included. */
function conversationAsMarkdown(entries: readonly QaEntry[]): string {
  const lines: string[] = [
    "# Ask your PDF — Q&A export",
    "",
    `Exported ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC · ${entries.length} question${entries.length === 1 ? "" : "s"}`,
    "",
  ];
  entries.forEach((entry, index) => {
    const { result } = entry;
    lines.push(`## ${index + 1}. ${result.question}`, "");
    lines.push(
      `**Confidence:** ${Math.round(result.verdict.confidence * 100)}% · ${VERDICT_META[result.verdict.status].label}`,
      "",
    );
    if (result.windows.length) {
      for (const window of result.windows) {
        lines.push(`> ${window.text}`, `>`, `> — *${window.docName}*, page ${window.page}`, "");
      }
    } else {
      lines.push("_No sentence in the searched text contained enough of the query terms._", "");
    }
    lines.push("**Cited pages**", "");
    for (const window of result.windows) lines.push(`- ${window.docName}, page ${window.page}`);
    lines.push("");
  });
  lines.push(
    "---",
    "",
    "Generated locally by Paperly. Answers are verbatim sentences from your PDFs, ranked by term overlap. Extractive only — no generative AI, no upload and no model calls.",
  );
  return lines.join("\n");
}

export function AskPdfTool() {
  const initial = useInitialFiles().filter((file) => /\.pdf$/i.test(file.name) || file.type === "application/pdf");
  const [files, setFiles] = useState<File[]>(() => initial.slice(0, MAX_DOCS));
  const metas = useFileMetas(files);
  const opts = useToolPreferences("ask-pdf", {
    scope: "",
    answerSentences: MAX_ANSWER_SENTENCES,
    citations: true,
    docScope: "all" as "all" | "first",
  });

  const [query, setQuery] = useState("");
  const [index, setIndex] = useState<KnowledgeIndex | null>(null);
  const [entries, setEntries] = useState<QaEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [excludedDocs, setExcludedDocs] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const [exported, setExported] = useState<{ bytes: Uint8Array; name: string; questions: number } | null>(null);
  const cancelRef = useRef(false);
  const querySeq = useRef(0);

  const scope = opts.value.scope;
  const docScope = opts.value.docScope;

  useEffect(() => {
    setIndex(null);
    setEntries([]);
    setActiveId(null);
    setExcludedDocs(new Set());
    setError("");
    setNotice("");
    setProgress(0);
    setStage("");
    setExported(null);
  }, [files, scope]);

  const addFiles = async (picked: File[]) => {
    if (!picked.length) return;
    const problems: string[] = [];
    const valid: File[] = [];
    for (const file of picked) {
      try {
        await validateUpload(file, "application/pdf,.pdf");
        valid.push(file);
      } catch (err) {
        problems.push(friendlyProcessingError(err, `${file.name} couldn’t be accepted.`));
      }
    }
    const existing = new Set(files.map(fileKey));
    const merged = [...files];
    let dropped = 0;
    for (const file of valid) {
      const key = fileKey(file);
      if (existing.has(key)) continue;
      if (merged.length >= MAX_DOCS) {
        dropped++;
        continue;
      }
      existing.add(key);
      merged.push(file);
    }
    setError(problems.join(" "));
    setNotice(dropped ? `Paperly searches up to ${MAX_DOCS} PDFs at once. ${dropped} extra file${dropped === 1 ? " was" : "s were"} not added.` : "");
    if (merged.length !== files.length) setFiles(merged);
  };

  const removeFile = (file: File) => setFiles((previous) => previous.filter((item) => fileKey(item) !== fileKey(file)));

  const scopeSummary = useMemo(() => {
    let total = 0;
    let errorMessage = "";
    for (const file of files) {
      const meta = metas[fileKey(file)];
      if (!meta || meta.loading || !meta.pages) continue;
      try {
        total += parseRanges(scope.trim(), meta.pages).length;
      } catch (err) {
        errorMessage = `${file.name}: ${(err as Error).message}`;
        break;
      }
    }
    return { total, error: errorMessage };
  }, [files, metas, scope]);

  const buildIndex = async (): Promise<KnowledgeIndex> => {
    const usable = files
      .map((file) => ({ file, meta: metas[fileKey(file)] }))
      .filter((entry): entry is { file: File; meta: FileMeta } => Boolean(entry.meta && !entry.meta.loading && entry.meta.pages > 0));
    const unreadableFiles = files
      .filter((file) => {
        const meta = metas[fileKey(file)];
        return Boolean(meta && !meta.loading && meta.pages === 0);
      })
      .map((file) => file.name);
    if (!usable.length) throw new Error(files.length ? "None of these PDFs could be read. Try a different file." : "Add at least one PDF first.");

    const selections: { file: File; docId: string; docName: string; pages: number[]; totalPages: number }[] = [];
    let remaining = MAX_TOTAL_PAGES;
    let requestedPages = 0;
    usable.forEach((entry, position) => {
      let pages: number[] = [];
      let rangeProblem = "";
      try {
        pages = parseRanges(scope.trim(), entry.meta.pages);
      } catch (err) {
        rangeProblem = (err as Error).message;
      }
      if (rangeProblem) throw new Error(`${entry.file.name}: ${rangeProblem}`);
      requestedPages += pages.length;
      if (remaining <= 0) return;
      const take = pages.slice(0, remaining);
      remaining -= take.length;
      selections.push({
        file: entry.file,
        docId: `doc-${position + 1}`,
        docName: entry.file.name,
        pages: take,
        totalPages: entry.meta.pages,
      });
    });

    const totalToRead = selections.reduce((sum, selection) => sum + selection.pages.length, 0);
    if (!totalToRead) throw new Error("Choose at least one page to search.");

    setStage("Reading the text layer…");
    setProgress(0);
    const passages: Passage[] = [];
    const docs: KnowledgeDoc[] = [];
    const emptyTextDocs: string[] = [];
    let done = 0;

    for (const selection of selections) {
      if (cancelRef.current) throw new AskCancelledError();
      const bytes = await readFileBytes(selection.file);
      const document = await openPdfJs(bytes, undefined, { maxPages: MAX_PDF_PAGES });
      try {
        const pageTexts: { page: number; text: string; docId: string; docName: string }[] = [];
        for (const pageNumber of selection.pages) {
          if (cancelRef.current) throw new AskCancelledError();
          const page = await extractPage(document, pageNumber);
          pageTexts.push({ page: page.page, text: page.text, docId: selection.docId, docName: selection.docName });
          setProgress(((done + pageTexts.length) / totalToRead) * 100);
          setStage(`${selection.docName} · page ${pageTexts.length} of ${selection.pages.length}`);
        }
        const textChars = pageTexts.reduce((sum, page) => sum + page.text.replace(/\s/g, "").length, 0);
        if (textChars < 20) emptyTextDocs.push(selection.docName);
        passages.push(...chunkPages(pageTexts, { maxChars: MAX_CHUNK_CHARS }));
        docs.push({
          id: selection.docId,
          name: selection.docName,
          pageCount: selection.totalPages,
          pagesRead: selection.pages.length,
          textChars,
        });
      } finally {
        await document.destroy();
      }
      done += selection.pages.length;
    }

    setStage("Building the local passage index…");
    setProgress(100);
    return { passages, docs, pagesRead: done, requestedPages, capped: requestedPages > done, emptyTextDocs, unreadableFiles };
  };

  /** Document ids currently inside the search scope. */
  const scopeIds = (source: KnowledgeIndex): Set<string> => {
    const docs = source.docs.filter((doc) => !excludedDocs.has(doc.id));
    const kept = docScope === "first" ? docs.slice(0, 1) : docs;
    return new Set(kept.map((doc) => doc.id));
  };

  const runQuestion = async (override?: string) => {
    const question = (override ?? query).trim();
    if (!question) {
      setError("Type a question to search your PDFs.");
      return;
    }
    if (busy) return;
    if (files.some((file) => !metas[fileKey(file)] || metas[fileKey(file)].loading)) {
      setNotice("Still reading a PDF — try again in a moment.");
      return;
    }
    const seq = querySeq.current + 1;
    querySeq.current = seq;
    setBusy(true);
    setError("");
    setNotice("");
    setExported(null);
    cancelRef.current = false;
    try {
      let activeIndex = index;
      if (!activeIndex) {
        activeIndex = await buildIndex();
        if (seq !== querySeq.current) return;
        setIndex(activeIndex);
      }
      if (!activeIndex.passages.length) {
        setNotice("No text layer was found in the selected pages. This looks like a scanned PDF — run OCR PDF first, then come back with the searchable copy.");
        return;
      }
      const included = scopeIds(activeIndex);
      const passages = activeIndex.passages.filter((passage) => included.has(passage.docId));
      if (!passages.length) {
        setNotice("Every document is out of scope. Include at least one PDF to search it.");
        return;
      }
      const scoped: KnowledgeIndex = {
        ...activeIndex,
        passages,
        docs: activeIndex.docs.filter((doc) => included.has(doc.id)),
      };
      const rank = rankPassages(scoped.passages, question, { limit: 6 });
      const windows = extractAnswerWindows(rank.passages, question, {
        maxSentences: opts.value.answerSentences,
        maxChars: 800,
      });
      const outcome = verdict(question, rank);
      const entry: QaEntry = {
        id: `qa-${seq}-${Date.now()}`,
        at: Date.now(),
        result: { question, rank, windows, verdict: outcome, index: scoped },
      };
      setEntries((previous) => [...previous, entry].slice(-MAX_CONVERSATION));
      setActiveId(entry.id);
      if (!rank.passages.length) setNotice("No passage matched those words. Try fewer, more specific terms that appear in the document.");
    } catch (err) {
      if (err instanceof AskCancelledError) {
        setNotice("Cancelled — the index was not finished and no question was searched. Your previous answers are untouched.");
      } else {
        setError((err as Error).message);
      }
    } finally {
      if (seq === querySeq.current) {
        setBusy(false);
        setProgress(0);
        setStage("");
      }
    }
  };

  const cancelBuild = () => {
    cancelRef.current = true;
    setStage("Cancelling after this page…");
  };

  const activeEntry = entries.find((entry) => entry.id === activeId) ?? entries[entries.length - 1] ?? null;
  const result = activeEntry?.result ?? null;
  const indexed = result?.index ?? index;

  const copyAnswer = async () => {
    if (!result) return;
    const ok = await copyText(answerAsText(result));
    setCopied(ok);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const downloadAnswer = () => {
    if (!result) return;
    const name = `${sanitizeName(baseName(files[0]?.name ?? "document"))}-answer.md`;
    downloadBytes(new Uint8Array(new TextEncoder().encode(answerAsMarkdown(result))), name, "text/markdown");
  };

  const exportConversation = () => {
    if (!entries.length) return;
    const markdown = conversationAsMarkdown(entries);
    setExported({
      bytes: new Uint8Array(new TextEncoder().encode(markdown)),
      name: `${sanitizeName(baseName(files[0]?.name ?? "document"))}-qa.md`,
      questions: entries.length,
    });
  };

  const clearConversation = () => {
    setEntries([]);
    setActiveId(null);
    setExported(null);
    setNotice("Conversation cleared. The passage index is kept, so the next question is answered straight away.");
  };

  const toggleDoc = (id: string) =>
    setExcludedDocs((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const suggestions = useMemo(() => deriveSuggestions(index?.passages ?? []), [index]);
  const docRows = useMemo(
    () =>
      (index?.docs ?? []).map((doc) => ({
        ...doc,
        passages: index ? index.passages.filter((passage) => passage.docId === doc.id).length : 0,
      })),
    [index],
  );

  usePrimaryShortcut(
    () => void runQuestion(),
    Boolean(files.length) && Boolean(query.trim()) && !busy && !scopeSummary.error,
  );
  useDownloadShortcut(downloadAnswer, Boolean(result));

  const fileProblems = files
    .map((file) => ({ file, meta: metas[fileKey(file)] }))
    .filter((entry) => entry.meta?.error);

  const verdictMeta = result ? VERDICT_META[result.verdict.status] : VERDICT_META["not-found"];

  return (
    <div className="space-y-5">
      {files.length === 0 ? (
        <FileDrop
          accept="application/pdf,.pdf"
          acceptLabel={`PDF files (up to ${MAX_DOCS})`}
          multiple
          onFiles={(picked) => void addFiles(picked)}
          sample={SAMPLE.pdf}
          hint={`Up to ${MAX_DOCS} PDFs · ${MAX_TOTAL_PAGES} pages per run · read in this tab only`}
        />
      ) : (
        <div className="space-y-3">
          {files.map((file, position) => {
            const meta = metas[fileKey(file)];
            const size = !meta || meta.loading ? "Reading…" : meta.error ? "Couldn’t read file" : `${meta.pages} page${meta.pages === 1 ? "" : "s"} · ${formatBytes(file.size)}`;
            return (
              <FileRow
                key={fileKey(file)}
                file={file}
                index={position}
                size={size}
                onRemove={() => {
                  removeFile(file);
                }}
              />
            );
          })}
          <div className="flex flex-wrap items-center gap-2">
            <label className="cursor-pointer">
              <span className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-line bg-paper px-3 text-[12.5px] font-medium text-ink/75 transition-colors hover:border-forest/30 hover:text-forest">
                <Plus className="h-3.5 w-3.5" /> Add PDFs
              </span>
              <input
                type="file"
                accept="application/pdf,.pdf"
                multiple
                className="sr-only"
                onChange={(event) => {
                  const picked = Array.from(event.target.files ?? []);
                  event.target.value = "";
                  void addFiles(picked);
                }}
              />
            </label>
            <span className="text-[11px] text-muted">
              Up to {MAX_DOCS} PDFs · {MAX_TOTAL_PAGES} pages per run
            </span>
            <span className="ml-auto flex items-center gap-1 text-[11px] text-muted">
              <ShieldCheck className="h-3.5 w-3.5 text-forest" /> Read in this tab only
            </span>
          </div>
          {fileProblems.length > 0 && (
            <Alert tone="error" title="Some files couldn’t be read">
              {fileProblems.map((entry) => (
                <span key={fileKey(entry.file)} className="block">
                  {entry.file.name}: {entry.meta?.error}
                </span>
              ))}
            </Alert>
          )}
        </div>
      )}

      {files.length > 0 && (
        <>
          <div className="rounded-xl border border-forest/15 bg-lime/20 p-3.5">
            <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-forest">
              <ShieldCheck className="h-4 w-4" /> Local retrieval, not generative AI
            </p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-forest/90">
              Paperly searches the text layer on your device and shows the exact sentences that match. There is no model, no paraphrase and no upload —
              so the answer is always something the document actually says. Scanned PDFs need OCR first.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_240px]">
            <Field label="Your question" htmlFor="ask-question" hint="Use words that appear in the document. Retrieval is exact, not paraphrased.">
              <input
                id="ask-question"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void runQuestion();
                  }
                }}
                placeholder="e.g. What was the total revenue in 2025?"
                className={inputClass}
                autoComplete="off"
              />
            </Field>
            <Field
              label="Pages per PDF"
              htmlFor="ask-pages"
              hint={
                scopeSummary.error
                  ? scopeSummary.error
                  : files.some((file) => !metas[fileKey(file)] || metas[fileKey(file)].loading)
                    ? "Reading page counts…"
                    : `${scopeSummary.total} page${scopeSummary.total === 1 ? "" : "s"} selected · ${MAX_TOTAL_PAGES}-page cap`
              }
            >
              <div className="flex gap-2">
                <input
                  id="ask-pages"
                  value={scope}
                  onChange={(event) => opts.set("scope", event.target.value)}
                  placeholder="All pages"
                  className={inputClass}
                  autoComplete="off"
                />
                <Button type="button" variant="outline" size="md" onClick={() => opts.set("scope", "")} className="shrink-0">
                  All
                </Button>
              </div>
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink/75">Pages</span>
            {[
              { label: "All", value: "" },
              { label: "Odd", value: "odd" },
              { label: "Even", value: "even" },
              { label: "Last", value: "last" },
              { label: "First 10", value: "1-10" },
            ].map((chip) => (
              <button
                key={chip.label}
                type="button"
                aria-pressed={scope.trim() === chip.value}
                onClick={() => opts.set("scope", chip.value)}
                className={
                  scope.trim() === chip.value
                    ? "rounded-full border border-forest bg-forest px-2.5 py-1 text-[11px] font-medium text-paper"
                    : "rounded-full border border-line bg-paper px-2.5 py-1 text-[11px] font-medium text-ink/70 transition-colors hover:border-forest/30 hover:text-forest"
                }
              >
                {chip.label}
              </button>
            ))}
          </div>

          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/55">Documents to search</p>
            <Segmented
              value={docScope}
              onChange={(value) => opts.set("docScope", value)}
              size="sm"
              options={[
                { value: "all", label: "Every PDF" },
                { value: "first", label: "First PDF only" },
              ]}
            />
            <p className="mt-1 text-[11px] leading-relaxed text-muted">
              {docScope === "all"
                ? `Questions are answered across all ${files.length} selected PDF${files.length === 1 ? "" : "s"}.`
                : "Only the first PDF in the list is searched. Use the per-document switches below for finer control."}
            </p>
          </div>

          <AdvancedOptions
            scope="ask-pdf"
            badge="3 controls"
            description="Answer length, citations, remembered page range"
            onReset={opts.reset}
          >
            <OptionsGrid>
              <NumberField
                label="Sentences per answer"
                value={opts.value.answerSentences}
                onChange={(value) => opts.set("answerSentences", value)}
                min={1}
                max={MAX_ANSWER_SENTENCES}
                suffix="sent."
                hint="Each sentence is copied verbatim from the PDF."
              />
              <div className="flex items-end">
                <Switch
                  checked={opts.value.citations}
                  onChange={(value) => opts.set("citations", value)}
                  label="Show citations"
                  description="Quote the cited sentence with its page number under every answer."
                />
              </div>
            </OptionsGrid>
            <div className="mt-3">
              <OptionNote>
                Your page range and document scope are remembered between visits. Nothing about the documents themselves is stored.
              </OptionNote>
            </div>
          </AdvancedOptions>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink/75">Try</span>
            {suggestions.map((question) => (
              <button
                key={question}
                type="button"
                disabled={busy}
                onClick={() => {
                  setQuery(question);
                  void runQuestion(question);
                }}
                className="rounded-full border border-line bg-paper px-3 py-1.5 text-[11.5px] font-medium text-ink/70 transition-colors hover:border-forest/30 hover:text-forest disabled:opacity-50"
              >
                {question}
              </button>
            ))}
          </div>
          {index && index.passages.length > 0 && (
            <p className="-mt-2 text-[10.5px] text-muted">Suggested from the words that repeat in your indexed passages.</p>
          )}

          {scopeSummary.error && <Alert tone="error">{scopeSummary.error}</Alert>}
          {!scopeSummary.error && scopeSummary.total > MAX_TOTAL_PAGES && (
            <Alert tone="warning">
              You selected {scopeSummary.total.toLocaleString()} pages. Paperly reads the first {MAX_TOTAL_PAGES} pages across your PDFs per run — narrow the
              page ranges to reach later pages.
            </Alert>
          )}
          {error && <Alert tone="error">{error}</Alert>}
          {notice && <Alert tone="info">{notice}</Alert>}

          {docRows.length > 0 && (
            <div className="rounded-xl border border-line bg-paper p-3.5">
              <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">
                <FileSearch className="h-3.5 w-3.5 text-forest" /> Documents indexed
              </p>
              <ul className="space-y-1.5">
                {docRows.map((doc) => {
                  const included = docScope === "first" ? docRows[0]?.id === doc.id && !excludedDocs.has(doc.id) : !excludedDocs.has(doc.id);
                  return (
                    <li key={doc.id} className="flex items-start gap-2.5">
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 shrink-0 accent-forest"
                        checked={included}
                        disabled={docScope === "first"}
                        onChange={() => toggleDoc(doc.id)}
                        aria-label={`Include ${doc.name} in the search`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] font-medium text-ink/80">{doc.name}</span>
                        <span className="text-[11px] text-muted">
                          {doc.pagesRead} page{doc.pagesRead === 1 ? "" : "s"} read · {doc.passages} passage{doc.passages === 1 ? "" : "s"}
                          {doc.textChars < 20 ? " · almost no text layer" : ""}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-2 text-[10.5px] leading-relaxed text-muted">
                Unticked documents stay indexed but are left out of the ranking for your next question, so you can compare answers with and without them.
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={() => void runQuestion()} loading={busy} disabled={!query.trim() || Boolean(scopeSummary.error)}>
              <Search className="h-4 w-4" /> Find answer
            </Button>
            {busy && (
              <Button variant="outline" onClick={cancelBuild}>
                Cancel
              </Button>
            )}
            <span className="text-[11.5px] text-muted">Extractive · deterministic · nothing leaves this tab</span>
          </div>
          {busy && <Progress value={progress} label={stage || "Reading your PDFs locally…"} />}
        </>
      )}

      {files.length === 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-dashed border-line bg-bone-deep/25 px-3.5 py-3 text-[11.5px] leading-relaxed text-muted">
          <ScanText className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Scanned PDFs have no text to search. Run OCR PDF first, then ask questions about the
          searchable copy.
        </div>
      )}

      {indexed && indexed.emptyTextDocs.length > 0 && (
        <Alert tone="warning" title="Some PDFs have no text layer">
          {indexed.emptyTextDocs.join(", ")} {indexed.emptyTextDocs.length === 1 ? "has" : "have"} almost no extractable text. Run{" "}
          <a href="#/tool/ocr" className="font-semibold underline">
            OCR PDF
          </a>{" "}
          first, then add the searchable copy here.
        </Alert>
      )}

      {indexed && indexed.unreadableFiles.length > 0 && (
        <Alert tone="warning">
          Skipped unreadable file{indexed.unreadableFiles.length === 1 ? "" : "s"}: {indexed.unreadableFiles.join(", ")}.
        </Alert>
      )}

      {result && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={verdictMeta.tone}>{(result.verdict.confidence * 100).toFixed(0)}% match</Badge>
            <Badge tone="forest">{verdictMeta.label}</Badge>
            <Badge>
              {result.rank.passages.length} passage{result.rank.passages.length === 1 ? "" : "s"}
            </Badge>
            <Badge>
              {result.index.pagesRead} page{result.index.pagesRead === 1 ? "" : "s"} read
            </Badge>
            {result.index.capped && <Badge tone="clay">Page cap reached</Badge>}
          </div>
          <p className="text-[11.5px] leading-relaxed text-muted">{verdictMeta.blurb}</p>

          {result.verdict.status !== "not-found" && result.windows.length > 0 ? (
            <div className="rounded-2xl border border-forest/15 bg-lime/15 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-forest">Answer · verbatim from your PDFs</p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => void copyAnswer()}>
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy answer"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={downloadAnswer}>
                    <Download className="h-3.5 w-3.5" /> .md
                  </Button>
                </div>
              </div>
              <ol className="mt-3 space-y-2.5">
                {result.windows.map((window, position) => (
                  <li key={`${window.docId}-${window.page}-${window.start}`} className="text-[13.5px] leading-relaxed text-ink/85">
                    <span className="mr-1 text-[11px] font-bold text-forest">{position + 1}.</span>
                    <HighlightedText text={window.text} ranges={window.highlights} />{" "}
                    <span className="ml-1 inline-flex shrink-0 items-center rounded-full border border-line bg-paper px-1.5 py-0.5 align-middle text-[10px] font-medium text-ink/70">
                      {window.docName} · p. {window.page}
                    </span>
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-[10.5px] leading-relaxed text-forest/80">
                Every line is copied exactly from the document. Confidence reflects term overlap only — check the cited page before relying on it.
              </p>
            </div>
          ) : (
            <Alert tone={result.verdict.status === "weak" ? "warning" : "error"} title="No complete answer found">
              {result.verdict.status === "weak"
                ? "Some words matched, but not enough to quote a reliable answer. Try a shorter question using wording from the document."
                : "That question doesn’t match the searched text. Try fewer, more specific terms, widen the page range, or check that the PDF has a text layer."}
            </Alert>
          )}

          {opts.value.citations && result.windows.length > 0 && (
            <div className="rounded-xl border border-line bg-paper p-3.5">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">Citations</p>
              <ul className="space-y-2">
                {result.windows.map((citation, position) => (
                  <li key={`cite-${citation.docId}-${citation.page}-${citation.start}`} className="flex flex-wrap items-baseline gap-1.5">
                    <span className="rounded-full bg-forest px-1.5 py-0.5 text-[9.5px] font-bold text-lime">[{position + 1}]</span>
                    <span className="text-[11.5px] font-semibold text-ink/80">{citation.docName}</span>
                    <span className="text-[11px] text-muted">page {citation.page}</span>
                    <span className="w-full text-[11.5px] leading-relaxed text-ink/65">“{quoteForCitation(citation.text)}”</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[10.5px] leading-relaxed text-muted">
                Each citation is the sentence quoted by the answer, with the page it came from. Open that page to read the surrounding context.
              </p>
            </div>
          )}

          {entries.length > 0 && (
            <div className="rounded-xl border border-line bg-paper p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">
                  Conversation · {entries.length} question{entries.length === 1 ? "" : "s"}
                </p>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={exportConversation}>
                    <Download className="h-3.5 w-3.5" /> Export Q&amp;A
                  </Button>
                  <Button variant="ghost" size="sm" onClick={clearConversation}>
                    Clear conversation
                  </Button>
                </div>
              </div>
              {entries.length > 1 && (
                <ol className="mt-2 space-y-1">
                  {[...entries].reverse().map((entry) => {
                    const active = entry.id === activeEntry?.id;
                    return (
                      <li key={entry.id}>
                        <button
                          type="button"
                          onClick={() => setActiveId(entry.id)}
                          aria-pressed={active}
                          className={
                            active
                              ? "flex w-full items-center justify-between gap-2 rounded-lg border border-forest/25 bg-lime/25 px-2.5 py-1.5 text-left"
                              : "flex w-full items-center justify-between gap-2 rounded-lg border border-transparent px-2.5 py-1.5 text-left transition-colors hover:border-line hover:bg-bone-deep/40"
                          }
                        >
                          <span className="min-w-0 truncate text-[12px] font-medium text-ink/80">{entry.result.question}</span>
                          <span className="shrink-0 text-[10.5px] font-semibold tabular-nums text-forest">
                            {(entry.result.verdict.confidence * 100).toFixed(0)}%
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              )}
              <p className="mt-2 text-[10.5px] leading-relaxed text-muted">
                Answers stay in this tab for this visit only. Export writes the questions, the verbatim answers and the cited pages to one Markdown file.
              </p>
            </div>
          )}

          {exported && (
            <div className="space-y-2">
              <DownloadPanel
                bytes={exported.bytes}
                filename={exported.name}
                size={exported.bytes.byteLength}
                mime="text/markdown"
                title="Q&A export ready"
                description={`${exported.questions} question${exported.questions === 1 ? "" : "s"} with verbatim answers and citations · Markdown`}
                onDownload={() => downloadBytes(exported.bytes, exported.name, "text/markdown")}
              />
              <div className="flex justify-end">
                <Button variant="ghost" size="sm" onClick={() => setExported(null)}>
                  Hide export
                </Button>
              </div>
            </div>
          )}

          {result.rank.passages.length > 0 && (
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink/75">Source passages</p>
              <div className="space-y-2">
                {result.rank.passages.map((passage, position) => (
                  <article key={`${passage.docId}-${passage.page}-${passage.start}`} className="rounded-xl border border-line bg-paper p-3.5">
                    <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-forest text-[9px] font-bold text-lime">{position + 1}</span>
                      <span className="truncate text-[11.5px] font-semibold text-ink/80">{passage.docName}</span>
                      <span className="rounded-full border border-line px-1.5 py-0.5 text-[10px] font-medium text-ink/70">p. {passage.page}</span>
                      <span className="ml-auto text-[10px] font-semibold tabular-nums text-forest">
                        {Math.round(passage.normalizedScore * 100)}%
                      </span>
                    </div>
                    <p className="text-[12.5px] leading-relaxed text-ink/75">
                      <HighlightedText text={passage.text} ranges={highlightRanges(passage.text, result.rank.terms)} />
                    </p>
                  </article>
                ))}
              </div>
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-muted">
            Indexed {result.index.passages.length} passage{result.index.passages.length === 1 ? "" : "s"} from {result.index.pagesRead} page
            {result.index.pagesRead === 1 ? "" : "s"} across {result.index.docs.length} PDF{result.index.docs.length === 1 ? "" : "s"}
            {result.index.capped ? ` · capped at ${MAX_TOTAL_PAGES} pages this run` : ""}.
          </p>
        </div>
      )}
    </div>
  );
}
/* ================================================================== *
 * INSPECT PDF — structural forensics with pdf-lib + PDF.js
 * ================================================================== */
const MAX_TEXT_SCAN_PAGES = 400;
/** A page with fewer non-space characters than this is treated as image-only. */
const TEXT_PAGE_MIN_CHARS = 12;

type Severity = "high" | "medium" | "low" | "info";

interface ReportRow {
  label: string;
  value: string;
  severity?: Severity;
}

interface ReportSection {
  id: string;
  title: string;
  rows: ReportRow[];
}

interface RedFlag {
  id: string;
  label: string;
  severity: Severity;
  detail: string;
}

interface InspectCoverage {
  sampledPages: number;
  totalPages: number;
  sampledAll: boolean;
  pagesWithText: number;
  emptyPages: number[];
  averageCharsPerPage: number;
  perPage: { page: number; chars: number }[];
  note: string;
}

type RiskBand = "low" | "guarded" | "elevated" | "high";

interface RiskReason {
  id: string;
  label: string;
  detail: string;
  points: number;
}

interface RiskAssessment {
  score: number;
  band: RiskBand;
  label: string;
  summary: string;
  reasons: RiskReason[];
}

type CheckStatus = "pass" | "warn" | "fail" | "info";

interface CheckRow {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

interface PdfaClaim {
  claimed: boolean;
  xmp: boolean;
  part: string;
  conformance: string;
  outputIntent: boolean;
  note: string;
  issues: string[];
}

interface RepairSuggestion {
  id: string;
  label: string;
  detail: string;
  href?: string;
}

interface InspectReport {
  file: { name: string; size: number; modified: string };
  generated: string;
  summary: {
    version: string;
    pages: number;
    encrypted: boolean;
    linearized: boolean;
    textPages: number;
    scannedPages: number;
    parseError: string;
  };
  sections: ReportSection[];
  flags: RedFlag[];
  text: InspectCoverage;
  risk: RiskAssessment;
  accessibility: CheckRow[];
  pdfa: PdfaClaim;
  suggestions: RepairSuggestion[];
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };

const SEVERITY_BADGE: Record<Severity, string> = {
  high: "border-clay/30 bg-clay/[0.08] text-clay-ink",
  medium: "border-amber-500/30 bg-amber-50 text-amber-900",
  low: "border-line bg-bone-deep/50 text-ink/70",
  info: "border-forest/20 bg-forest/[0.05] text-forest",
};

const SEVERITY_SURFACE: Record<Severity, string> = {
  high: "border-clay/25 bg-clay/[0.05]",
  medium: "border-amber-500/25 bg-amber-50/70",
  low: "border-line bg-bone-deep/25",
  info: "border-forest/15 bg-forest/[0.035]",
};

function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.08em]",
        SEVERITY_BADGE[severity],
      )}
    >
      {severity}
    </span>
  );
}

function pdfText(value: PDFObject | undefined): string {
  try {
    if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText().trim();
    if (value instanceof PDFName) return value.asString().replace(/^\//, "");
  } catch {
    /* Malformed strings are reported as unknown by the caller. */
  }
  return "";
}

function describePageSize(width: number, height: number): string {
  const a = Math.round(width);
  const b = Math.round(height);
  const long = Math.max(a, b);
  const short = Math.min(a, b);
  const near = (value: number, target: number) => Math.abs(value - target) <= 7;
  if (near(short, 595) && near(long, 842)) return `A4 · ${a}×${b} pt`;
  if (near(short, 612) && near(long, 792)) return `Letter · ${a}×${b} pt`;
  if (near(short, 612) && near(long, 1008)) return `Legal · ${a}×${b} pt`;
  if (near(short, 420) && near(long, 595)) return `A5 · ${a}×${b} pt`;
  if (near(short, 842) && near(long, 1191)) return `A3 · ${a}×${b} pt`;
  return `${a}×${b} pt`;
}

function detectXrefRecovery(raw: string): { recovered: boolean; detail: string } {
  const marker = raw.lastIndexOf("startxref");
  if (marker < 0) return { recovered: true, detail: "No startxref marker was found, so the reader rebuilt the cross-reference table." };
  const match = raw.slice(marker).match(/^startxref\s+(\d+)/);
  if (!match) return { recovered: true, detail: "The startxref offset is missing or malformed." };
  const offset = Number(match[1]);
  if (!Number.isFinite(offset) || offset <= 0 || offset >= raw.length) {
    return { recovered: true, detail: `startxref points outside the file (offset ${Number.isFinite(offset) ? offset : "unknown"}).` };
  }
  const near = raw.slice(offset, offset + 24);
  if (!/^\s*(xref|\d+\s+\d+\s+obj)/.test(near)) {
    return { recovered: true, detail: "The declared cross-reference offset does not point at an xref table or stream." };
  }
  return { recovered: false, detail: "The cross-reference table declaration is intact." };
}

function resolveDict(node: PDFObject | undefined, context: PDFContext): PDFDict | null {
  if (!node) return null;
  try {
    const value = node instanceof PDFDict ? node : node instanceof PDFRef ? context.lookup(node) : undefined;
    return value instanceof PDFDict ? value : null;
  } catch {
    return null;
  }
}

function inspectNameTree(node: PDFObject | undefined, context: PDFContext, depth = 0): { count: number; names: string[] } {
  if (!node || depth > 12) return { count: 0, names: [] };
  const dict = resolveDict(node, context);
  if (!dict) return { count: 0, names: [] };
  let count = 0;
  const names: string[] = [];
  try {
    const entries = dict.lookup(PDFName.of("Names"));
    if (entries instanceof PDFArray) {
      for (let index = 0; index + 1 < entries.size(); index += 2) {
        count++;
        const label = pdfText(entries.get(index));
        if (label && names.length < 12) names.push(label);
      }
    }
  } catch {
    /* keep the partial count */
  }
  try {
    const kids = dict.lookup(PDFName.of("Kids"));
    if (kids instanceof PDFArray) {
      const limit = Math.min(kids.size(), 64);
      for (let index = 0; index < limit; index++) {
        const child = inspectNameTree(kids.get(index), context, depth + 1);
        count += child.count;
        for (const name of child.names) if (names.length < 12) names.push(name);
      }
    }
  } catch {
    /* keep the partial count */
  }
  return { count, names };
}

function countLinkedSiblings(start: PDFObject | undefined, context: PDFContext): number {
  const seen = new Set<string>();
  let node = start;
  let count = 0;
  while (node && count < 2000) {
    const key = node instanceof PDFRef ? node.toString() : "";
    if (key) {
      if (seen.has(key)) break;
      seen.add(key);
    }
    const dict = resolveDict(node, context);
    if (!dict) break;
    count++;
    try {
      node = dict.lookup(PDFName.of("Next"));
    } catch {
      break;
    }
  }
  return count;
}

function dateText(date: Date | undefined): string {
  if (!date || Number.isNaN(date.getTime())) return "Not set";
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/**
 * Human label for an AcroForm field from its raw /FT type and /Ff flags.
 * Deliberately avoids class names: Vite/terser rename pdf-lib classes in the
 * production bundle, which would leak labels like "Xr"/"zr" to users.
 *
 * Button flags (PDF 32000-1 §12.7.4.2.1): bit 16 = Radio, bit 17 = PushButton;
 * a plain button is a CheckBox. Choice flags: bit 18 = Combo (dropdown),
 * otherwise it is a list box.
 */
function fieldTypeLabel(typeName: string, flags: number): string {
  const hasFlag = (bit: number) => (flags & bit) !== 0;
  switch (typeName) {
    case "/Tx":
      return "Text";
    case "/Btn":
      if (hasFlag(1 << 16)) return "PushButton";
      if (hasFlag(1 << 15)) return "RadioButton";
      return "CheckBox";
    case "/Ch":
      return hasFlag(1 << 17) ? "Dropdown" : "ListBox";
    case "/Sig":
      return "Signature";
    default:
      return typeName.replace(/^\//, "") || "Unknown";
  }
}

interface InspectScanOptions {
  /** Read the text layer with PDF.js (slower, but fills the coverage rows). */
  textScan: boolean;
  /** Maximum pages sampled for the text-layer check. */
  textLimit: number;
}

const DEFAULT_SCAN_OPTIONS: InspectScanOptions = { textScan: true, textLimit: MAX_TEXT_SCAN_PAGES };

/* ------------------------------------------------------------------ *
 * Risk, accessibility, PDF/A and repair guidance
 * ------------------------------------------------------------------ */
const RISK_WEIGHTS: Record<string, number> = {
  encrypted: 26,
  parse: 22,
  javascript: 24,
  xfa: 10,
  "no-text": 12,
  "partial-scan": 5,
  geometry: 7,
  xref: 9,
  attachments: 7,
  fonts: 4,
  "open-action": 5,
  signature: 1,
};

const RISK_FALLBACK: Record<Severity, number> = { high: 18, medium: 10, low: 4, info: 1 };

const RISK_BANDS: Record<RiskBand, { label: string; summary: string }> = {
  low: {
    label: "Low concern",
    summary: "Nothing unusual surfaced in these checks. That is not a guarantee — still open files from strangers in a viewer you trust.",
  },
  guarded: {
    label: "Worth a look",
    summary: "A few things are worth reading before you share or open this file more widely.",
  },
  elevated: {
    label: "Treat with care",
    summary: "Several checks found issues that commonly travel with risky or malformed files. Review the reasons below.",
  },
  high: {
    label: "High concern",
    summary: "Structural or active-content problems were found. Inspect the reasons before trusting this file or passing it on.",
  },
};

/** Deterministic 0–100 concern score from the flags and accessibility gaps. */
function assessRisk(flags: readonly RedFlag[], accessibility: readonly CheckRow[]): RiskAssessment {
  const reasons: RiskReason[] = flags
    .map((flag) => ({
      id: flag.id,
      label: flag.label,
      detail: flag.detail,
      points: RISK_WEIGHTS[flag.id] ?? RISK_FALLBACK[flag.severity],
    }))
    .sort((a, b) => b.points - a.points || a.label.localeCompare(b.label));
  const accessibilityGaps = accessibility.filter((row) => row.status === "fail").length;
  const raw = reasons.reduce((sum, reason) => sum + reason.points, 0) + Math.min(12, accessibilityGaps * 3);
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const band: RiskBand = score >= 70 ? "high" : score >= 45 ? "elevated" : score >= 20 ? "guarded" : "low";
  return {
    score,
    band,
    label: RISK_BANDS[band].label,
    summary: RISK_BANDS[band].summary,
    reasons: reasons.slice(0, 3),
  };
}

/** Accessibility checks that can be measured without rendering the document. */
function buildAccessibilityChecks(input: {
  marked: boolean;
  hasStructTree: boolean;
  language: string;
  title: string;
  hasOutlines: boolean;
  outlineCount: number;
  displayDocTitle: boolean;
  coverage: InspectCoverage;
  textScan: boolean;
  fontResources: number;
  embeddedFonts: number;
  uniqueImages: number;
}): CheckRow[] {
  const tagged = input.hasStructTree || input.marked;
  const rows: CheckRow[] = [
    {
      id: "tagged",
      label: "Tagged structure",
      status: tagged ? "pass" : "fail",
      detail: tagged
        ? `A ${input.hasStructTree ? "structure tree" : "/MarkInfo marking"} tells screen readers how the content is organised.`
        : "No structure tree or /MarkInfo marking was found, so assistive technology sees unstructured text.",
    },
    {
      id: "language",
      label: "Document language",
      status: input.language !== "Not set" ? "pass" : "warn",
      detail:
        input.language !== "Not set"
          ? `The catalog declares ${input.language}, so screen readers can pick the right voice.`
          : "No /Lang entry was found. Screen readers then guess the language, which mispronounces text.",
    },
    {
      id: "title",
      label: "Document title",
      status: input.title !== "Not set" ? "pass" : "warn",
      detail:
        input.title !== "Not set"
          ? "A title is set in the Info dictionary, so the viewer can announce it."
          : "No title was found in the Info dictionary. Viewers then show the file name instead.",
    },
    {
      id: "bookmarks",
      label: "Bookmarks for navigation",
      status: input.hasOutlines && input.outlineCount > 0 ? "pass" : "warn",
      detail:
        input.hasOutlines && input.outlineCount > 0
          ? `${input.outlineCount} top-level bookmark${input.outlineCount === 1 ? "" : "s"} let readers jump between sections.`
          : "No outline was found. Long documents are hard to navigate with a keyboard or screen reader alone.",
    },
    {
      id: "display-title",
      label: "Title shown in the viewer",
      status: input.displayDocTitle ? "pass" : "info",
      detail: input.displayDocTitle
        ? "ViewerPreferences asks the application to show the document title in its window bar."
        : "ViewerPreferences does not ask the viewer to show the title. Many viewers fall back to the file name.",
    },
    {
      id: "text",
      label: "Text for assistive technology",
      status: !input.textScan
        ? "info"
        : input.coverage.sampledPages === 0
          ? "info"
          : input.coverage.pagesWithText === input.coverage.sampledPages
            ? "pass"
            : input.coverage.pagesWithText === 0
              ? "fail"
              : "warn",
      detail: !input.textScan
        ? "The text-layer scan was switched off, so this could not be measured."
        : input.coverage.sampledPages === 0
          ? "The text layer could not be read."
          : `${input.coverage.pagesWithText} of ${input.coverage.sampledPages} sampled page${
              input.coverage.sampledPages === 1 ? "" : "s"
            } contain selectable text. Pages without text are invisible to search and screen readers.`,
    },
    {
      id: "fonts",
      label: "Embedded fonts",
      status: input.fontResources === 0 ? "info" : input.embeddedFonts >= input.fontResources ? "pass" : "warn",
      detail:
        input.fontResources === 0
          ? "No font resources were found on the pages."
          : input.embeddedFonts >= input.fontResources
            ? `All ${input.fontResources} font resource${input.fontResources === 1 ? "" : "s"} are embedded.`
            : `${input.fontResources - input.embeddedFonts} of ${input.fontResources} font resources are not embedded, so text may reflow or drop glyphs.`,
    },
  ];
  if (input.uniqueImages > 0) {
    rows.push({
      id: "images",
      label: "Image descriptions",
      status: "info",
      detail: `${input.uniqueImages} image${input.uniqueImages === 1 ? "" : "s"} found. Alt text is stored in the tagged structure, which Paperly does not read here — check it in an accessibility checker.`,
    });
  }
  return rows;
}

/** Look for a PDF/A claim in the raw XMP packet and the output intents. */
function buildPdfaClaim(input: {
  raw: string;
  outputIntentPdfa: boolean;
  encrypted: boolean;
  fontResources: number;
  embeddedFonts: number;
  marked: boolean;
  hasStructTree: boolean;
}): PdfaClaim {
  const start = input.raw.indexOf("<x:xmpmeta");
  const slice = start >= 0 ? input.raw.slice(start, start + 80_000) : "";
  const partMatch = slice.match(/pdfaid:part\D{0,8}(\d)/);
  const conformanceMatch = slice.match(/pdfaid:conformance\D{0,8}([A-Za-z])/);
  const part = partMatch?.[1] ?? "";
  const conformance = (conformanceMatch?.[1] ?? "").toUpperCase();
  const claimed = Boolean(part) || input.outputIntentPdfa;
  const issues: string[] = [];
  if (claimed && input.encrypted) issues.push("the file is encrypted, which PDF/A forbids");
  if (claimed && input.fontResources > 0 && input.embeddedFonts < input.fontResources) {
    issues.push(`${input.fontResources - input.embeddedFonts} font resource(s) are not embedded`);
  }
  if (claimed && conformance === "A" && !input.marked && !input.hasStructTree) {
    issues.push(`the file claims PDF/A-${part || "?"}A conformance but carries no tags`);
  }
  const note = claimed
    ? "A PDF/A claim is a statement written into the file. Paperly reads it but does not validate conformance — use a veraPDF-style validator for that."
    : slice
      ? "An XMP packet is present but it makes no PDF/A claim and no GTS_PDFA1 output intent was found."
      : "No readable XMP packet was found, so there is no PDF/A claim to read. Compressed metadata cannot be checked here.";
  return {
    claimed,
    xmp: Boolean(slice),
    part: part || "—",
    conformance: conformance || "—",
    outputIntent: input.outputIntentPdfa,
    note,
    issues,
  };
}

/** Plain next-step suggestions derived from the flags that were raised. */
function buildRepairSuggestions(flags: readonly RedFlag[]): RepairSuggestion[] {
  const map: Record<string, RepairSuggestion> = {
    encrypted: {
      id: "unlock",
      label: "Unlock the file first",
      detail: "Most tools need the password removed before they can read the structure reliably.",
      href: "#/tool/unlock",
    },
    parse: {
      id: "repair",
      label: "Rebuild the damaged structure",
      detail: "Repair PDF re-writes the cross-reference table and object graph without re-encoding the pages.",
      href: "#/tool/repair",
    },
    xref: {
      id: "repair-xref",
      label: "Re-save with Repair PDF",
      detail: "A repaired cross-reference table makes the file open reliably in stricter viewers.",
      href: "#/tool/repair",
    },
    javascript: {
      id: "sanitize-scripts",
      label: "Remove scripts and actions",
      detail: "Sanitize PDF deletes open actions, additional actions and document JavaScript in one pass.",
      href: "#/tool/sanitize",
    },
    "open-action": {
      id: "sanitize-open",
      label: "Remove the automatic open action",
      detail: "Sanitize PDF strips /OpenAction so nothing runs or navigates when the file opens.",
      href: "#/tool/sanitize",
    },
    attachments: {
      id: "sanitize-files",
      label: "Strip embedded attachments",
      detail: "Attachments often carry data the author forgot about. Sanitize PDF removes them.",
      href: "#/tool/sanitize",
    },
    xfa: {
      id: "sanitize-xfa",
      label: "Flatten or remove the XFA bundle",
      detail: "Sanitize PDF removes form fields and XFA data, or flatten the form if you need to keep its appearance.",
      href: "#/tool/sanitize",
    },
    "no-text": {
      id: "ocr",
      label: "OCR the scanned pages",
      detail: "OCR PDF adds an invisible text layer so the document becomes searchable, copyable and readable aloud.",
      href: "#/tool/ocr",
    },
    "partial-scan": {
      id: "ocr-partial",
      label: "OCR the image-only pages",
      detail: "Only the pages without text need OCR; the rest keep their existing text layer.",
      href: "#/tool/ocr",
    },
    geometry: {
      id: "resize",
      label: "Resize the oversized pages",
      detail: "Very large page geometry slows viewers and can hit canvas limits. Resize PDF scales them to a print size.",
      href: "#/tool/resize",
    },
    fonts: {
      id: "embed-fonts",
      label: "Re-export with fonts embedded",
      detail: "Print to PDF with ‘embed all fonts’ enabled, or export a PDF/A copy from the authoring application.",
    },
    signature: {
      id: "verify-signature",
      label: "Verify the signature elsewhere",
      detail: "Paperly reports signature markers but cannot verify certificates or detect changes made after signing.",
    },
  };
  const seen = new Set<string>();
  const out: RepairSuggestion[] = [];
  for (const flag of flags) {
    const suggestion = map[flag.id];
    if (!suggestion || seen.has(suggestion.id)) continue;
    seen.add(suggestion.id);
    out.push(suggestion);
  }
  return out;
}

async function inspectDocument(
  bytes: ArrayBuffer,
  file: File,
  onProgress: (label: string, value: number) => void,
  options: InspectScanOptions = DEFAULT_SCAN_OPTIONS,
): Promise<InspectReport> {
  const rawBytes = new Uint8Array(bytes);
  const raw = new TextDecoder("latin1").decode(rawBytes);
  const versionFromHeader = raw.match(/%PDF-(\d\.\d)/)?.[1] ?? "";
  const linearized = raw.slice(0, 2048).includes("/Linearized");
  const encryptedByRaw = /\/Encrypt\b/.test(raw);
  const xref = detectXrefRecovery(raw);

  onProgress("Reading document structure…", 6);
  let doc: PDFLibDocument | null = null;
  let parseError = "";
  try {
    doc = await openPdfLib(bytes);
  } catch (err) {
    parseError = readablePdfError(err);
  }

  let version = versionFromHeader || "unknown";
  let pageCount = 0;
  let title = "Not set";
  let author = "Not set";
  let subject = "Not set";
  let keywords = "Not set";
  let creator = "Not set";
  let producer = "Not set";
  let created = "Not set";
  let modified = "Not set";
  let language = "Not set";
  let pageSizes: { label: string; count: number }[] = [];
  let rotations: { label: string; count: number }[] = [];
  const hugePages: number[] = [];
  let annotationTotal = 0;
  let annotationsByType = "";
  let fieldCount = 0;
  let fieldTypes = "";
  let signatureFields = 0;
  let hasXfa = false;
  let attachmentCount = 0;
  let attachmentNames: string[] = [];
  let outlineCount = 0;
  let hasOutlines = false;
  let jsNames: string[] = [];
  let xfaScriptCount = 0;
  const rawScriptMarkers = (raw.match(/\/S\s*\/JavaScript/g) ?? []).length;
  let hasOpenAction = false;
  let openActionIsJavaScript = false;
  let hasAdditionalActions = false;
  const byteRangeCount = (raw.match(/\/ByteRange/g) ?? []).length;
  let imagePlacements = 0;
  let uniqueImages = 0;
  let pagesWithImages = 0;
  let fontResources = 0;
  let embeddedFonts = 0;
  const fontNames: string[] = [];
  let marked = false;
  let hasStructTree = false;
  let displayDocTitle = false;
  let outputIntentPdfa = false;
  const imageStats: {
    largest: { width: number; height: number; pageWidth: number; page: number } | null;
    lowResolution: number;
  } = { largest: null, lowResolution: 0 };

  onProgress("Reading metadata and page structure…", 12);
  if (doc) {
    try {
      version = doc.catalog.lookup(PDFName.of("Version")) instanceof PDFName
        ? String(doc.catalog.lookup(PDFName.of("Version"))).replace("/", "")
        : version;
    } catch {
      /* keep header version */
    }
    try {
      pageCount = doc.getPageCount();
    } catch {
      pageCount = 0;
    }
    try {
      title = doc.getTitle()?.trim() || "Not set";
    } catch {
      /* unknown */
    }
    try {
      author = doc.getAuthor()?.trim() || "Not set";
    } catch {
      /* unknown */
    }
    try {
      subject = doc.getSubject()?.trim() || "Not set";
    } catch {
      /* unknown */
    }
    try {
      keywords = doc.getKeywords()?.trim() || "Not set";
    } catch {
      /* unknown */
    }
    try {
      creator = doc.getCreator()?.trim() || "Not set";
    } catch {
      /* unknown */
    }
    try {
      producer = doc.getProducer()?.trim() || "Not set";
    } catch {
      /* unknown */
    }
    try {
      created = dateText(doc.getCreationDate());
    } catch {
      /* unknown */
    }
    try {
      modified = dateText(doc.getModificationDate());
    } catch {
      /* unknown */
    }
    try {
      language = doc.getLanguage()?.trim() || "Not set";
    } catch {
      /* unknown */
    }

    const context = doc.context;
    const seenImages = new Set<string>();
    const seenFonts = new Set<string>();
    const pagesWithImagesSet = new Set<number>();
    const annotationTally = new Map<string, number>();
    const fieldTally = new Map<string, number>();

    try {
      const pages = doc.getPages();
      const sizeTally = new Map<string, { label: string; count: number }>();
      const rotationTally = new Map<number, number>();
      pages.forEach((page, index) => {
        try {
          const width = page.getWidth();
          const height = page.getHeight();
          const label = describePageSize(width, height);
          const sizeEntry = sizeTally.get(label);
          if (sizeEntry) sizeEntry.count++;
          else sizeTally.set(label, { label, count: 1 });
          const angle = ((page.getRotation().angle % 360) + 360) % 360;
          rotationTally.set(angle, (rotationTally.get(angle) ?? 0) + 1);
          if (Math.max(width, height) > 5000 || width * height > 5_000_000) hugePages.push(index + 1);
        } catch {
          /* unusual page geometry */
        }

        try {
          const annots = page.node.Annots();
          if (annots instanceof PDFArray) {
            const limit = Math.min(annots.size(), 5000);
            for (let annotIndex = 0; annotIndex < limit; annotIndex++) {
              const annot = annots.lookupMaybe(annotIndex, PDFDict);
              if (!annot) continue;
              const subtype = annot.lookup(PDFName.of("Subtype"));
              const label = subtype instanceof PDFName ? subtype.asString().replace("/", "") : "Unknown";
              annotationTally.set(label, (annotationTally.get(label) ?? 0) + 1);
              annotationTotal++;
            }
          }
        } catch {
          /* annotations unavailable */
        }

        try {
          const resources = page.node.Resources();
          if (!resources) return;
          const xObjects = resources.lookup(PDFName.of("XObject"));
          if (xObjects instanceof PDFDict) {
            for (const [name, reference] of xObjects.entries()) {
              const key = reference instanceof PDFRef ? reference.toString() : `${index}:${name.asString()}`;
              const stream = reference instanceof PDFRef ? context.lookup(reference) : reference;
              const dictionary = stream instanceof PDFRawStream ? stream.dict : stream instanceof PDFDict ? stream : null;
              if (!dictionary) continue;
              const subtype = dictionary.lookup(PDFName.of("Subtype"));
              if (!(subtype instanceof PDFName) || subtype.asString() !== "/Image") continue;
              imagePlacements++;
              const pixelWidth = dictionary.lookup(PDFName.of("Width"));
              const pixelHeight = dictionary.lookup(PDFName.of("Height"));
              if (pixelWidth instanceof PDFNumber && pixelHeight instanceof PDFNumber) {
                const width = pixelWidth.asNumber();
                const height = pixelHeight.asNumber();
                let pageWidth = 0;
                try {
                  pageWidth = page.getWidth();
                } catch {
                  pageWidth = 0;
                }
                if (width > 0 && (!imageStats.largest || width > imageStats.largest.width)) {
                  imageStats.largest = { width, height, pageWidth, page: index + 1 };
                }
                if (pageWidth > 0 && width / (pageWidth / 72) < 72) imageStats.lowResolution++;
              }
              if (!seenImages.has(key)) {
                seenImages.add(key);
                uniqueImages++;
              }
              pagesWithImagesSet.add(index + 1);
            }
          }
          const fonts = resources.lookup(PDFName.of("Font"));
          if (fonts instanceof PDFDict) {
            for (const [, reference] of fonts.entries()) {
              const key = reference instanceof PDFRef ? reference.toString() : "";
              if (key && seenFonts.has(key)) continue;
              if (key) seenFonts.add(key);
              const font = reference instanceof PDFRef ? context.lookup(reference) : reference;
              if (!(font instanceof PDFDict)) continue;
              fontResources++;
              const baseFont = pdfText(font.lookup(PDFName.of("BaseFont")));
              if (baseFont && !fontNames.includes(baseFont) && fontNames.length < 16) fontNames.push(baseFont);
              let descriptor: PDFObject | undefined;
              try {
                descriptor = font.lookup(PDFName.of("FontDescriptor"));
                if (!(descriptor instanceof PDFDict)) {
                  const descendants = font.lookup(PDFName.of("DescendantFonts"));
                  if (descendants instanceof PDFArray && descendants.size() > 0) {
                    const child = descendants.lookupMaybe(0, PDFDict);
                    descriptor = child ? child.lookup(PDFName.of("FontDescriptor")) : undefined;
                  }
                }
              } catch {
                descriptor = undefined;
              }
              const embedded =
                descriptor instanceof PDFDict &&
                (descriptor.has(PDFName.of("FontFile")) ||
                  descriptor.has(PDFName.of("FontFile2")) ||
                  descriptor.has(PDFName.of("FontFile3")));
              if (embedded) embeddedFonts++;
            }
          }
        } catch {
          /* page resources unavailable */
        }
      });
      pageSizes = [...sizeTally.values()].sort((a, b) => b.count - a.count);
      rotations = [...rotationTally.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([angle, count]) => ({ label: angle === 0 ? "0° (upright)" : `${angle}°`, count }));
      pagesWithImages = pagesWithImagesSet.size;
    } catch {
      /* page tree unreadable */
    }

    try {
      const acroForm = doc.catalog.AcroForm();
      hasXfa = Boolean(acroForm?.has(PDFName.of("XFA")));
    } catch {
      hasXfa = false;
    }

    try {
      xfaScriptCount = doc.getXFAJavaScripts().length;
    } catch {
      xfaScriptCount = 0;
    }

    try {
      const form = doc.getForm();
      const fields = form.getFields();
      fieldCount = fields.length;
      for (const field of fields) {
        try {
          const type = field.acroField.dict.lookup(PDFName.of("FT"));
          const typeName = type instanceof PDFName ? type.asString() : "";
          const label = fieldTypeLabel(typeName, field.acroField.getFlags());
          fieldTally.set(label, (fieldTally.get(label) ?? 0) + 1);
          if (typeName === "/Sig") signatureFields++;
        } catch {
          /* one unusual field must not stop the report */
        }
      }
    } catch {
      fieldCount = 0;
    }

    try {
      hasOpenAction = doc.catalog.has(PDFName.of("OpenAction"));
      const action = doc.catalog.lookup(PDFName.of("OpenAction"));
      if (action instanceof PDFDict) {
        const actionType = action.lookup(PDFName.of("S"));
        openActionIsJavaScript = actionType instanceof PDFName && actionType.asString() === "/JavaScript";
      }
    } catch {
      hasOpenAction = false;
    }
    try {
      hasAdditionalActions = doc.catalog.has(PDFName.of("AA"));
    } catch {
      hasAdditionalActions = false;
    }
    try {
      jsNames = doc.getDocumentJavaScripts().map((entry) => entry.name || "unnamed").slice(0, 10);
    } catch {
      jsNames = [];
    }
    try {
      const names = doc.catalog.Names();
      const embeddedFiles = names?.lookup(PDFName.of("EmbeddedFiles"));
      const inspection = inspectNameTree(embeddedFiles, context);
      attachmentCount = inspection.count;
      attachmentNames = inspection.names;
      const attached = doc.catalog.AttachedFiles();
      if (attached instanceof PDFArray) attachmentCount = Math.max(attachmentCount, Math.floor(attached.size() / 2));
    } catch {
      attachmentCount = 0;
    }
    try {
      const outlines = doc.catalog.lookup(PDFName.of("Outlines"));
      hasOutlines = outlines instanceof PDFDict;
      if (outlines instanceof PDFDict) outlineCount = countLinkedSiblings(outlines.lookup(PDFName.of("First")), context);
    } catch {
      hasOutlines = false;
    }
    try {
      const markInfo = resolveDict(doc.catalog.lookup(PDFName.of("MarkInfo")), context);
      const markedValue = markInfo ? markInfo.lookup(PDFName.of("Marked")) : undefined;
      marked =
        markedValue instanceof PDFBool
          ? markedValue.asBoolean()
          : markedValue instanceof PDFName
            ? markedValue.asString() === "/True"
            : false;
    } catch {
      marked = false;
    }
    try {
      hasStructTree = doc.catalog.has(PDFName.of("StructTreeRoot"));
    } catch {
      hasStructTree = false;
    }
    try {
      const viewer = resolveDict(doc.catalog.lookup(PDFName.of("ViewerPreferences")), context);
      const titleDisplay = viewer ? viewer.lookup(PDFName.of("DisplayDocTitle")) : undefined;
      displayDocTitle =
        titleDisplay instanceof PDFBool
          ? titleDisplay.asBoolean()
          : titleDisplay instanceof PDFName
            ? titleDisplay.asString() === "/True"
            : false;
    } catch {
      displayDocTitle = false;
    }
    try {
      const intents = doc.catalog.lookup(PDFName.of("OutputIntents"));
      if (intents instanceof PDFArray) {
        const limit = Math.min(intents.size(), 8);
        for (let intentIndex = 0; intentIndex < limit; intentIndex++) {
          const intent = intents.lookupMaybe(intentIndex, PDFDict);
          const subtype = intent?.lookup(PDFName.of("S"));
          if (subtype instanceof PDFName && subtype.asString() === "/GTS_PDFA1") outputIntentPdfa = true;
        }
      }
    } catch {
      outputIntentPdfa = false;
    }

    annotationsByType = [...annotationTally.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `${type} ${count}`)
      .join(" · ");
    fieldTypes = [...fieldTally.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `${type} ${count}`)
      .join(" · ");
  }

  onProgress("Checking the text layer…", 20);
  const coverage: InspectCoverage = {
    sampledPages: 0,
    totalPages: pageCount,
    sampledAll: true,
    pagesWithText: 0,
    emptyPages: [],
    averageCharsPerPage: 0,
    perPage: [],
    note: "",
  };
  const textScanLimit = Math.max(20, Math.min(2000, Math.round(options.textLimit) || MAX_TEXT_SCAN_PAGES));
  if (!options.textScan) {
    coverage.note = "The text-layer scan is switched off in Advanced options, so coverage was not measured.";
  }
  try {
    if (options.textScan) {
    const jsDoc = await openPdfJs(bytes);
    const total = jsDoc.numPages;
    if (!pageCount) pageCount = total;
    const sampled = Math.min(total, textScanLimit);
    const perPage: { page: number; chars: number }[] = [];
    const emptyPages: number[] = [];
    let charsTotal = 0;
    for (let pageNumber = 1; pageNumber <= sampled; pageNumber++) {
      try {
        const page = await jsDoc.getPage(pageNumber);
        try {
          const content = await page.getTextContent();
          let chars = 0;
          for (const item of content.items as unknown[]) {
            const value = (item as { str?: unknown }).str;
            if (typeof value === "string") chars += value.replace(/\s/g, "").length;
          }
          perPage.push({ page: pageNumber, chars });
          charsTotal += chars;
          if (chars < TEXT_PAGE_MIN_CHARS) emptyPages.push(pageNumber);
        } finally {
          page.cleanup();
        }
      } catch {
        perPage.push({ page: pageNumber, chars: 0 });
        emptyPages.push(pageNumber);
      }
      if (pageNumber % 4 === 0 || pageNumber === sampled) {
        onProgress(`Checking text layer · page ${pageNumber} of ${sampled}`, 20 + (pageNumber / sampled) * 62);
      }
    }
    await jsDoc.destroy();
    coverage.sampledPages = sampled;
    coverage.totalPages = total;
    coverage.sampledAll = sampled === total;
    coverage.pagesWithText = sampled - emptyPages.length;
    coverage.emptyPages = emptyPages;
    coverage.averageCharsPerPage = sampled ? charsTotal / sampled : 0;
    coverage.perPage = perPage;
    coverage.note = sampled === total ? "" : `Sampled the first ${sampled} of ${total} pages to keep inspection fast.`;
    }
  } catch (err) {
    coverage.note = `Text layer unavailable: ${readablePdfError(err)}`;
  }

  onProgress("Checking forms, scripts and attachments…", 88);

  const flags: RedFlag[] = [];
  if (encryptedByRaw) {
    flags.push({
      id: "encrypted",
      label: "Encrypted document",
      severity: "high",
      detail:
        "An /Encrypt dictionary is present. Permissions may restrict copying, printing or accessibility, and other tools may refuse to read it without the password.",
    });
  }
  if (parseError) {
    flags.push({ id: "parse", label: "Structure could not be fully parsed", severity: "high", detail: parseError });
  }
  if (jsNames.length > 0 || rawScriptMarkers > 0 || openActionIsJavaScript || hasAdditionalActions || xfaScriptCount > 0) {
    const parts: string[] = [];
    if (jsNames.length) parts.push(`${jsNames.length} document script${jsNames.length === 1 ? "" : "s"} (${jsNames.slice(0, 3).join(", ")})`);
    if (openActionIsJavaScript) parts.push("an automatic JavaScript open action");
    if (hasAdditionalActions) parts.push("additional-action triggers");
    if (xfaScriptCount) parts.push(`${xfaScriptCount} XFA script${xfaScriptCount === 1 ? "" : "s"}`);
    if (!parts.length) parts.push(`${rawScriptMarkers} raw /JavaScript marker${rawScriptMarkers === 1 ? "" : "s"}`);
    flags.push({
      id: "javascript",
      label: "JavaScript or automatic actions",
      severity: "high",
      detail: `Found ${parts.join(", ")}. Scripts can run when a viewer opens or interacts with the file. They are unusual in ordinary documents.`,
    });
  }
  if (hasXfa) {
    flags.push({
      id: "xfa",
      label: "XFA form data",
      severity: "medium",
      detail: "An XFA form bundle is present. XFA can carry scripts and data, and support varies across viewers.",
    });
  }
  if (coverage.sampledPages > 0 && coverage.pagesWithText === 0) {
    flags.push({
      id: "no-text",
      label: "No text layer (scanned document)",
      severity: "medium",
      detail: "No extractable text was found. Search, copy, accessibility tooling and local retrieval will not work until the pages are OCR’d.",
    });
  } else if (
    coverage.sampledPages > 0 &&
    coverage.emptyPages.length >= 3 &&
    coverage.emptyPages.length / coverage.sampledPages > 0.2
  ) {
    flags.push({
      id: "partial-scan",
      label: "Some pages are scanned images",
      severity: "low",
      detail: `${coverage.emptyPages.length} of ${coverage.sampledPages} sampled pages have little or no text: ${formatPageList(
        coverage.emptyPages,
      )}. OCR those pages if you need them searchable.`,
    });
  }
  if (hugePages.length) {
    flags.push({
      id: "geometry",
      label: "Unusually large page geometry",
      severity: "medium",
      detail: `Page${hugePages.length === 1 ? "" : "s"} ${formatPageList(
        hugePages,
        4,
      )} exceed the normal print envelope. Very large pages can slow viewers and burn memory when rendered.`,
    });
  }
  if (xref.recovered) {
    flags.push({ id: "xref", label: "Cross-reference table needed repair", severity: "medium", detail: xref.detail });
  }
  if (attachmentCount > 0) {
    flags.push({
      id: "attachments",
      label: "Embedded files",
      severity: "low",
      detail: `${attachmentCount} embedded attachment${attachmentCount === 1 ? "" : "s"} found${
        attachmentNames.length ? ` (${attachmentNames.slice(0, 3).join(", ")})` : ""
      }. Attachments can carry additional or sensitive data.`,
    });
  }
  if (fontResources > 0 && embeddedFonts < fontResources) {
    flags.push({
      id: "fonts",
      label: "Fonts not fully embedded",
      severity: "low",
      detail: `${fontResources - embeddedFonts} of ${fontResources} font resources are not embedded. Text may render differently on other devices.`,
    });
  }
  if (signatureFields > 0 || byteRangeCount > 0) {
    flags.push({
      id: "signature",
      label: "Digital signature present",
      severity: "info",
      detail: `${signatureFields} signature field${signatureFields === 1 ? "" : "s"} and ${byteRangeCount} ByteRange marker${
        byteRangeCount === 1 ? "" : "s"
      } detected. Paperly reports it but does not verify certificate trust, validity or whether the file changed after signing.`,
    });
  }
  if (openActionIsJavaScript === false && hasOpenAction && !jsNames.length) {
    flags.push({
      id: "open-action",
      label: "Automatic open action",
      severity: "low",
      detail: "An /OpenAction is present (not JavaScript). It may jump to a page, open a URI or launch a viewer action.",
    });
  }
  flags.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.label.localeCompare(b.label));

  const accessibility = buildAccessibilityChecks({
    marked,
    hasStructTree,
    language,
    title,
    hasOutlines,
    outlineCount,
    displayDocTitle,
    coverage,
    textScan: options.textScan,
    fontResources,
    embeddedFonts,
    uniqueImages,
  });
  const pdfa = buildPdfaClaim({
    raw,
    outputIntentPdfa,
    encrypted: encryptedByRaw,
    fontResources,
    embeddedFonts,
    marked,
    hasStructTree,
  });
  const risk = assessRisk(flags, accessibility);
  const suggestions = buildRepairSuggestions(flags);

  const metadataRows: ReportRow[] = [
    { label: "Title", value: title },
    { label: "Author", value: author },
    { label: "Subject", value: subject },
    { label: "Keywords", value: keywords },
    { label: "Creator", value: creator },
    { label: "Producer", value: producer },
    { label: "Created", value: created },
    { label: "Modified", value: modified },
  ];

  const sectionRows: ReportSection[] = [
    {
      id: "document",
      title: "Document",
      rows: [
        { label: "PDF version", value: version === "unknown" ? "unknown" : `PDF ${version}` },
        { label: "Pages", value: pageCount ? pageCount.toLocaleString() : "unknown" },
        { label: "Encryption", value: encryptedByRaw ? "Encrypted" : "Not encrypted", severity: encryptedByRaw ? "high" : undefined },
        { label: "Linearization", value: linearized ? "Linearized (fast web view)" : "Not linearized" },
        { label: "Cross-reference", value: xref.recovered ? "Repaired on read" : "Intact", severity: xref.recovered ? "medium" : undefined },
        { label: "Language", value: language },
        { label: "File size", value: formatBytes(file.size) },
      ],
    },
    { id: "metadata", title: "Info dictionary", rows: metadataRows },
    {
      id: "pages",
      title: "Page geometry",
      rows: [
        {
          label: "Page sizes",
          value: pageSizes.length ? pageSizes.map((entry) => `${entry.label}${entry.count > 1 ? ` × ${entry.count}` : ""}`).join(" · ") : "unknown",
        },
        {
          label: "Rotations",
          value: rotations.length ? rotations.map((entry) => `${entry.label} × ${entry.count}`).join(" · ") : "unknown",
        },
        {
          label: "Large pages",
          value: hugePages.length ? formatPageList(hugePages, 6) : "None",
          severity: hugePages.length ? "medium" : undefined,
        },
      ],
    },
    {
      id: "text",
      title: "Text layer",
      rows: [
        {
          label: "Pages with text",
          value: coverage.sampledPages
            ? `${coverage.pagesWithText} of ${coverage.sampledPages}${coverage.sampledAll ? "" : " sampled"}`
            : "unknown",
          severity: coverage.sampledPages && coverage.pagesWithText === 0 ? "medium" : undefined,
        },
        {
          label: "Scanned / empty pages",
          value: coverage.emptyPages.length ? formatPageList(coverage.emptyPages, 6) : "None",
          severity: coverage.emptyPages.length ? (coverage.pagesWithText === 0 ? "medium" : "low") : undefined,
        },
        {
          label: "Average text per page",
          value: coverage.sampledPages ? `${Math.round(coverage.averageCharsPerPage).toLocaleString()} characters` : "unknown",
        },
        ...(coverage.note ? [{ label: "Note", value: coverage.note }] : []),
      ],
    },
    {
      id: "forms",
      title: "Forms & signatures",
      rows: [
        { label: "AcroForm fields", value: fieldCount ? String(fieldCount) : "None" },
        { label: "Field types", value: fieldTypes || "—" },
        { label: "Signature fields", value: signatureFields ? String(signatureFields) : "None" },
        { label: "Signature markers", value: byteRangeCount ? `${byteRangeCount} ByteRange` : "None" },
        { label: "XFA data", value: hasXfa ? "Present" : "None", severity: hasXfa ? "medium" : undefined },
      ],
    },
    {
      id: "annotations",
      title: "Annotations",
      rows: [
        { label: "Total annotations", value: annotationTotal ? annotationTotal.toLocaleString() : "None" },
        { label: "By type", value: annotationsByType || "—" },
      ],
    },
    {
      id: "actions",
      title: "Scripts & actions",
      rows: [
        {
          label: "Open action",
          value: hasOpenAction ? (openActionIsJavaScript ? "JavaScript action" : "Present") : "None",
          severity: openActionIsJavaScript ? "high" : hasOpenAction ? "low" : undefined,
        },
        { label: "Additional actions (/AA)", value: hasAdditionalActions ? "Present" : "None", severity: hasAdditionalActions ? "medium" : undefined },
        {
          label: "Document JavaScript",
          value: jsNames.length ? `${jsNames.length} script${jsNames.length === 1 ? "" : "s"}` : "None",
          severity: jsNames.length ? "high" : undefined,
        },
        { label: "Raw /JavaScript markers", value: rawScriptMarkers ? String(rawScriptMarkers) : "None" },
        { label: "XFA scripts", value: xfaScriptCount ? String(xfaScriptCount) : "None" },
      ],
    },
    {
      id: "embedded",
      title: "Embedded files",
      rows: [
        { label: "Attachments", value: attachmentCount ? String(attachmentCount) : "None", severity: attachmentCount ? "low" : undefined },
        { label: "Names", value: attachmentNames.length ? attachmentNames.join(", ") : "—" },
      ],
    },
    {
      id: "outlines",
      title: "Bookmarks",
      rows: [
        { label: "Outline dictionary", value: hasOutlines ? "Present" : "None" },
        { label: "Top-level bookmarks", value: hasOutlines ? String(outlineCount) : "—" },
      ],
    },
    {
      id: "media",
      title: "Images & fonts",
      rows: [
        {
          label: "Images",
          value: uniqueImages ? `${uniqueImages} unique · ${imagePlacements} placement${imagePlacements === 1 ? "" : "s"}` : "None",
        },
        { label: "Pages with images", value: pagesWithImages ? String(pagesWithImages) : "None" },
        { label: "Font resources", value: fontResources ? String(fontResources) : "None" },
        {
          label: "Embedded fonts",
          value: fontResources ? `${embeddedFonts} of ${fontResources}` : "—",
          severity: fontResources && embeddedFonts < fontResources ? "low" : undefined,
        },
        { label: "Font names", value: fontNames.length ? `${fontNames.slice(0, 8).join(", ")}${fontNames.length > 8 ? " …" : ""}` : "—" },
        {
          label: "Image resolution",
          value: imageStats.largest
            ? `${imageStats.largest.width}×${imageStats.largest.height} px largest · ${
                imageStats.largest.pageWidth > 0
                  ? `≈${Math.round(imageStats.largest.width / (imageStats.largest.pageWidth / 72))} DPI`
                  : "DPI unknown"
              } if it fills page ${imageStats.largest.page}${
                imageStats.lowResolution
                  ? ` · ${imageStats.lowResolution} placement${imageStats.lowResolution === 1 ? "" : "s"} below 72 DPI`
                  : ""
              }`
            : "No image pixels found",
        },
      ],
    },
  ];

  onProgress("Building the report…", 96);

  return {
    file: { name: file.name, size: file.size, modified: dateText(file.lastModified ? new Date(file.lastModified) : undefined) },
    generated: new Date().toISOString(),
    summary: {
      version,
      pages: pageCount,
      encrypted: encryptedByRaw,
      linearized,
      textPages: coverage.pagesWithText,
      scannedPages: coverage.sampledPages ? coverage.sampledPages - coverage.pagesWithText : 0,
      parseError,
    },
    sections: sectionRows,
    flags,
    text: coverage,
    risk,
    accessibility,
    pdfa,
    suggestions,
  };
}

function reportToText(report: InspectReport): string {
  const lines: string[] = [
    `Paperly PDF inspection — ${report.file.name}`,
    `Generated: ${report.generated}`,
    `File size: ${formatBytes(report.file.size)} · modified ${report.file.modified}`,
    "",
    `Risk score: ${report.risk.score}/100 — ${report.risk.label}`,
    ...report.risk.reasons.map((reason, index) => `  ${index + 1}. ${reason.label} (+${reason.points})`),
    "",
    `PDF ${report.summary.version} · ${report.summary.pages} page${report.summary.pages === 1 ? "" : "s"} · ${
      report.summary.encrypted ? "encrypted" : "not encrypted"
    } · ${report.summary.textPages}/${report.text.sampledPages || report.summary.pages} pages with text`,
    "",
  ];
  for (const section of report.sections) {
    lines.push(section.title.toUpperCase());
    for (const row of section.rows) lines.push(`  ${row.label}: ${row.value}`);
    lines.push("");
  }
  lines.push("RED FLAGS");
  if (!report.flags.length) lines.push("  None detected by the in-browser checks.");
  else for (const flag of report.flags) lines.push(`  [${flag.severity.toUpperCase()}] ${flag.label} — ${flag.detail}`);
  lines.push("", "ACCESSIBILITY");
  for (const row of report.accessibility) lines.push(`  [${row.status.toUpperCase()}] ${row.label} — ${row.detail}`);
  lines.push("", "PDF/A & ARCHIVAL");
  lines.push(
    `  Claim: ${report.pdfa.claimed ? `PDF/A-${report.pdfa.part} (${report.pdfa.conformance})` : "none found"} · output intent: ${
      report.pdfa.outputIntent ? "GTS_PDFA1" : "none"
    }`,
  );
  if (report.pdfa.issues.length) for (const issue of report.pdfa.issues) lines.push(`  Issue: ${issue}`);
  lines.push(`  ${report.pdfa.note}`);
  lines.push("", "SUGGESTED NEXT STEPS");
  if (!report.suggestions.length) lines.push("  Nothing to repair — no corrective action was suggested by these checks.");
  else for (const suggestion of report.suggestions) lines.push(`  - ${suggestion.label} (${suggestion.href ?? "no tool"}): ${suggestion.detail}`);
  lines.push(
    "",
    "Inspection ran entirely in this tab. Checks are heuristic: an absent flag is not proof the file is safe, the risk score is a weighted summary of those checks rather than a verdict, signatures are not verified, PDF/A conformance is not validated, and metadata can be forged.",
  );
  return lines.join("\n");
}

/** Short copy-summary: the score, the band and the top reasons. */
function reportRiskSummary(report: InspectReport): string {
  const lines = [
    `${report.file.name} — risk ${report.risk.score}/100 (${report.risk.label})`,
    report.risk.summary,
    "",
  ];
  if (report.risk.reasons.length) {
    lines.push("Top reasons:");
    report.risk.reasons.forEach((reason, index) => lines.push(`${index + 1}. ${reason.label} (+${reason.points}) — ${reason.detail}`));
  } else {
    lines.push("No red flags contributed to the score.");
  }
  const gaps = report.accessibility.filter((row) => row.status === "fail" || row.status === "warn");
  if (gaps.length) {
    lines.push("", `Accessibility gaps: ${gaps.map((row) => row.label).join(", ")}`);
  }
  if (report.suggestions.length) {
    lines.push("", `Next steps: ${report.suggestions.map((suggestion) => suggestion.label).join("; ")}`);
  }
  lines.push("", "Heuristic in-browser checks, not a security guarantee or a certificate verification.");
  return lines.join("\n");
}

function reportToMarkdown(report: InspectReport): string {
  const lines: string[] = [
    `# Inspection — ${report.file.name}`,
    "",
    `Generated ${report.generated} · ${formatBytes(report.file.size)} · modified ${report.file.modified}`,
    "",
    `## Risk score: ${report.risk.score}/100 — ${report.risk.label}`,
    "",
    report.risk.summary,
    "",
  ];
  if (report.risk.reasons.length) {
    lines.push("**Top reasons**", "");
    report.risk.reasons.forEach((reason, index) => lines.push(`${index + 1}. **${reason.label}** (+${reason.points}) — ${reason.detail}`));
    lines.push("");
  }
  lines.push("## Structural red flags", "");
  if (!report.flags.length) lines.push("_No structural red flags were detected by these checks._");
  else for (const flag of report.flags) lines.push(`- \`${flag.severity.toUpperCase()}\` **${flag.label}** — ${flag.detail}`);
  lines.push("", "## Accessibility", "");
  for (const row of report.accessibility) {
    lines.push(`- **${row.label}** (${row.status}) — ${row.detail}`);
  }
  lines.push("", "## PDF/A and archival", "");
  lines.push(`- Claim: ${report.pdfa.claimed ? `PDF/A-${report.pdfa.part} (${report.pdfa.conformance})` : "none found"}`);
  lines.push(`- Output intent: ${report.pdfa.outputIntent ? "GTS_PDFA1 present" : "none"}`);
  lines.push(`- Consistency: ${report.pdfa.issues.length ? report.pdfa.issues.join("; ") : "no contradictions detected"}`);
  lines.push(`- ${report.pdfa.note}`);
  for (const section of report.sections) {
    lines.push("", `## ${section.title}`, "");
    for (const row of section.rows) lines.push(`- **${row.label}:** ${row.value}`);
  }
  lines.push("", "## Suggested next steps", "");
  if (!report.suggestions.length) lines.push("_Nothing to repair._");
  else for (const suggestion of report.suggestions) lines.push(`- **${suggestion.label}** — ${suggestion.detail}`);
  lines.push(
    "",
    "---",
    "",
    "Generated locally by Paperly. Every check ran in this tab: no upload, no network call and no model. The checks are heuristic — an absent flag is not proof the file is safe, the risk score summarises those checks rather than certifying the file, signatures are not verified and PDF/A conformance is not validated.",
  );
  return lines.join("\n");
}

export function InspectPdfTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const opts = useToolPreferences("inspect-pdf", {
    textScan: true,
    textLimit: MAX_TEXT_SCAN_PAGES,
    suggestions: true,
  });
  const [report, setReport] = useState<InspectReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [copiedSummary, setCopiedSummary] = useState(false);
  const [markdown, setMarkdown] = useState<{ bytes: Uint8Array; name: string } | null>(null);
  const [nonce, setNonce] = useState(0);

  const textScan = opts.value.textScan;
  const textLimit = opts.value.textLimit;
  const showSuggestions = opts.value.suggestions;

  useEffect(() => {
    if (!pdf.bytes || !pdf.file) {
      setReport(null);
      setBusy(false);
      setError("");
      return;
    }
    const bytes = pdf.bytes;
    const file = pdf.file;
    let alive = true;
    setBusy(true);
    setError("");
    setReport(null);
    setMarkdown(null);
    setProgress(0);
    setStage("Reading document structure…");
    void (async () => {
      try {
        const next = await inspectDocument(
          bytes,
          file,
          (label, value) => {
            if (!alive) return;
            setStage(label);
            setProgress(value);
          },
          { textScan, textLimit },
        );
        if (alive) setReport(next);
      } catch (err) {
        if (alive) setError(friendlyProcessingError(err, "This PDF couldn’t be inspected."));
      } finally {
        if (alive) {
          setBusy(false);
          setProgress(0);
          setStage("");
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [pdf.bytes, pdf.file, nonce, textScan, textLimit]);

  const copyReport = async () => {
    if (!report) return;
    const ok = await copyText(reportToText(report));
    setCopied(ok);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const copySummary = async () => {
    if (!report) return;
    const ok = await copyText(reportRiskSummary(report));
    setCopiedSummary(ok);
    window.setTimeout(() => setCopiedSummary(false), 1600);
  };

  const downloadJson = () => {
    if (!report) return;
    const name = `${sanitizeName(baseName(report.file.name))}-inspection.json`;
    downloadBytes(new Uint8Array(new TextEncoder().encode(JSON.stringify(report, null, 2))), name, "application/json");
  };

  const buildMarkdownReport = () => {
    if (!report) return;
    setMarkdown({
      bytes: new Uint8Array(new TextEncoder().encode(reportToMarkdown(report))),
      name: `${sanitizeName(baseName(report.file.name))}-inspection.md`,
    });
  };

  usePrimaryShortcut(() => setNonce((value) => value + 1), Boolean(pdf.bytes) && !busy);
  useDownloadShortcut(buildMarkdownReport, Boolean(report));

  const highFlags = report?.flags.filter((flag) => flag.severity === "high" || flag.severity === "medium").length ?? 0;
  const textPercent = report && report.text.sampledPages ? Math.round((report.text.pagesWithText / report.text.sampledPages) * 100) : 0;
  const riskTone: Record<RiskBand, { surface: string; text: string; bar: string }> = {
    low: { surface: "border-forest/25 bg-forest/[0.05]", text: "text-forest", bar: "bg-forest" },
    guarded: { surface: "border-line bg-bone-deep/30", text: "text-ink/80", bar: "bg-ink/50" },
    elevated: { surface: "border-amber-500/30 bg-amber-50/70", text: "text-amber-900", bar: "bg-amber-500" },
    high: { surface: "border-clay/30 bg-clay/[0.06]", text: "text-clay-ink", bar: "bg-clay" },
  };

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to inspect" />

      {pdf.bytes && !pdf.error && (
        <div className="rounded-xl border border-forest/15 bg-lime/20 p-3.5">
          <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-forest">
            <ShieldCheck className="h-4 w-4" /> In-tab inspection, honestly labelled
          </p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-forest/90">
            Paperly reads the PDF structure and text layer on your device. Every probe is wrapped so unusual files can’t crash the tool. Checks are
            heuristic: an absent flag is not proof the file is safe, signatures are reported but not verified, and metadata can be forged.
          </p>
        </div>
      )}

      {busy && <Progress value={progress} label={stage || "Inspecting this PDF locally…"} />}
      {error && <Alert tone="error" title="Inspection failed">{error}</Alert>}

      {pdf.bytes && !pdf.error && (
        <AdvancedOptions
          scope="inspect-pdf"
          badge="3 controls"
          description="Text-layer sampling depth, repair suggestions"
          onReset={opts.reset}
        >
          <OptionsGrid>
            <div className="flex items-end">
              <Switch
                checked={textScan}
                onChange={(value) => opts.set("textScan", value)}
                label="Measure the text layer"
                description="Turn off for a faster read of structure only — the coverage rows stay empty."
              />
            </div>
            <NumberField
              label="Pages sampled for text"
              value={textLimit}
              onChange={(value) => opts.set("textLimit", value)}
              min={20}
              max={2000}
              step={20}
              suffix="pages"
              hint="Inspection stops sampling after this many pages."
            />
            <div className="flex items-end">
              <Switch
                checked={showSuggestions}
                onChange={(value) => opts.set("suggestions", value)}
                label="Show repair suggestions"
                description="Turn the detected flags into plain next steps with links to the right tool."
              />
            </div>
          </OptionsGrid>
          <div className="mt-3">
            <OptionNote>
              Everything here runs in this tab. Raising the sample limit inspects more pages but takes proportionally longer.
            </OptionNote>
          </div>
        </AdvancedOptions>
      )}

      {report && (
        <div className="space-y-4">
          <div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone="forest">
                {report.summary.pages ? `${report.summary.pages} page${report.summary.pages === 1 ? "" : "s"}` : "—"}
              </Badge>
              <Badge>PDF {report.summary.version}</Badge>
              <Badge tone={report.summary.encrypted ? "clay" : "neutral"}>{report.summary.encrypted ? "Encrypted" : "Not encrypted"}</Badge>
              <Badge tone={report.text.sampledPages && report.text.pagesWithText === 0 ? "clay" : "neutral"}>
                {textPercent}% text layer
              </Badge>
              <Badge tone={highFlags ? "clay" : "neutral"}>{highFlags ? `${highFlags} flag${highFlags === 1 ? "" : "s"}` : "No major flags"}</Badge>
            </div>
            <p className="mt-1.5 text-[11.5px] text-muted">
              {report.file.name} · {formatBytes(report.file.size)} · inspected {new Date(report.generated).toLocaleString()}
            </p>
          </div>

          <section className={cn("rounded-2xl border p-4", riskTone[report.risk.band].surface)}>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink/60">Risk score</p>
                <p className="mt-1 flex items-baseline gap-2">
                  <span className={cn("text-[30px] font-semibold leading-none tabular-nums", riskTone[report.risk.band].text)}>
                    {report.risk.score}
                  </span>
                  <span className="text-[12px] font-medium text-muted">/ 100</span>
                  <span className={cn("rounded-full border border-current/20 px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.08em]", riskTone[report.risk.band].text)}>
                    {report.risk.label}
                  </span>
                </p>
              </div>
              <p className="max-w-md text-[11.5px] leading-relaxed text-ink/70">{report.risk.summary}</p>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-ink/10">
              <div
                className={cn("h-full rounded-full transition-all", riskTone[report.risk.band].bar)}
                style={{ width: `${Math.max(3, report.risk.score)}%` }}
              />
            </div>
            {report.risk.reasons.length > 0 && (
              <ol className="mt-3 space-y-1">
                {report.risk.reasons.map((reason, position) => (
                  <li key={reason.id} className="flex items-start gap-2 text-[11.5px] leading-relaxed text-ink/75">
                    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-ink/10 text-[9px] font-bold text-ink/70">
                      {position + 1}
                    </span>
                    <span className="min-w-0">
                      <span className="font-semibold text-ink/85">{reason.label}</span>
                      <span className="ml-1.5 text-[10.5px] font-semibold tabular-nums text-muted">+{reason.points}</span>
                      <span className="block text-[10.5px] text-ink/60">{reason.detail}</span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
            <p className="mt-2.5 text-[10.5px] leading-relaxed text-muted">
              The score is a weighted sum of the checks on this page — not a verdict and not a malware scan.
            </p>
          </section>

          <section className="rounded-2xl border border-line bg-paper p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink/75">
                <ShieldAlert className="h-3.5 w-3.5 text-clay-ink" /> Structural red flags
              </p>
              <span className="text-[10.5px] font-medium text-muted">{report.flags.length} detected</span>
            </div>
            {report.flags.length ? (
              <div className="mt-3 space-y-1.5">
                {report.flags.map((flag) => (
                  <div key={flag.id} className={cn("flex items-start gap-2 rounded-lg border px-2.5 py-2", SEVERITY_SURFACE[flag.severity])}>
                    <SeverityBadge severity={flag.severity} />
                    <div className="min-w-0">
                      <p className="text-[11.5px] font-semibold text-ink/85">{flag.label}</p>
                      <p className="text-[10.5px] leading-relaxed text-ink/65">{flag.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-2 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-forest">
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" /> No structural red flags were detected by these in-browser checks. That is not a
                guarantee — inspect files from untrusted sources in a sandboxed viewer.
              </p>
            )}
          </section>

          <div className="grid gap-3 md:grid-cols-2">
            {report.sections.map((section) => (
              <section key={section.id} className="rounded-xl border border-line bg-paper p-3.5">
                <h3 className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink/75">
                  <FileSearch className="h-3.5 w-3.5 text-forest" /> {section.title}
                </h3>
                <dl className="mt-2 space-y-1.5">
                  {section.rows.map((row) => (
                    <div key={row.label} className="flex items-start justify-between gap-3 text-[12px] leading-relaxed">
                      <dt className="shrink-0 text-muted">{row.label}</dt>
                      <dd
                        className={cn(
                          "min-w-0 break-words text-right font-medium text-ink/80",
                          row.severity === "high" && "text-clay-ink",
                          row.severity === "medium" && "text-amber-800",
                        )}
                      >
                        {row.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>

          <section className="rounded-xl border border-line bg-paper p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink/75">
                <ShieldCheck className="h-3.5 w-3.5 text-forest" /> Accessibility checks
              </p>
              <span className="text-[10.5px] font-medium text-muted">
                {report.accessibility.filter((row) => row.status === "pass").length} of {report.accessibility.length} pass
              </span>
            </div>
            <ul className="mt-2 space-y-1.5">
              {report.accessibility.map((row) => (
                <li key={row.id} className="flex items-start gap-2 rounded-lg border border-line/70 px-2.5 py-2">
                  <span
                    className={cn(
                      "mt-0.5 shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.06em]",
                      row.status === "pass"
                        ? "border-forest/25 bg-forest/[0.07] text-forest"
                        : row.status === "fail"
                          ? "border-clay/30 bg-clay/[0.08] text-clay-ink"
                          : row.status === "warn"
                            ? "border-amber-500/30 bg-amber-50 text-amber-900"
                            : "border-line bg-bone-deep/40 text-ink/60",
                    )}
                  >
                    {row.status === "pass" ? "pass" : row.status === "fail" ? "gap" : row.status === "warn" ? "check" : "info"}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[11.5px] font-semibold text-ink/85">{row.label}</span>
                    <span className="block text-[10.5px] leading-relaxed text-ink/60">{row.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[10.5px] leading-relaxed text-muted">
              These are structural checks only. Reading order, contrast and alternative text live inside the tagged content and need a dedicated
              accessibility checker.
            </p>
          </section>

          <section className="rounded-xl border border-line bg-paper p-3.5">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink/75">
              <Info className="h-3.5 w-3.5 text-forest" /> PDF/A &amp; archival claim
            </p>
            <p className="mt-2 text-[12px] leading-relaxed text-ink/80">
              {report.pdfa.claimed ? (
                <>
                  This file claims <strong>PDF/A-{report.pdfa.part}</strong>
                  {report.pdfa.conformance !== "—" ? ` with ${report.pdfa.conformance} conformance` : ""}
                  {report.pdfa.outputIntent ? " and carries a GTS_PDFA1 output intent." : "."}
                </>
              ) : (
                "The readable metadata makes no PDF/A claim and no output intent names a PDF/A profile."
              )}
            </p>
            {report.pdfa.issues.length > 0 && (
              <ul className="mt-1.5 space-y-0.5">
                {report.pdfa.issues.map((issue) => (
                  <li key={issue} className="text-[11px] leading-relaxed text-amber-900">
                    · {issue}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1.5 text-[10.5px] leading-relaxed text-muted">{report.pdfa.note}</p>
          </section>

          {showSuggestions && (
            <section className="rounded-xl border border-forest/15 bg-lime/15 p-3.5">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-forest">Repair suggestions</p>
              {report.suggestions.length ? (
                <ul className="mt-2 space-y-2">
                  {report.suggestions.map((suggestion) => (
                    <li key={suggestion.id} className="text-[11.5px] leading-relaxed text-ink/75">
                      {suggestion.href ? (
                        <a href={suggestion.href} className="font-semibold text-forest underline">
                          {suggestion.label}
                        </a>
                      ) : (
                        <span className="font-semibold text-ink/85">{suggestion.label}</span>
                      )}
                      <span className="block text-[10.5px] text-ink/60">{suggestion.detail}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-forest">
                  No corrective action was suggested by these checks — the structure looks ordinary.
                </p>
              )}
            </section>
          )}

          {report.summary.parseError && <Alert tone="warning" title="Structure could not be fully parsed">{report.summary.parseError}</Alert>}

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button variant="outline" onClick={() => void copyReport()}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? "Copied" : "Copy full report"}
            </Button>
            <Button variant="outline" onClick={() => void copySummary()}>
              {copiedSummary ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copiedSummary ? "Copied" : "Copy summary"}
            </Button>
            <Button variant="outline" onClick={downloadJson}>
              <Download className="h-4 w-4" /> JSON report
            </Button>
            <Button variant="outline" onClick={buildMarkdownReport}>
              <Download className="h-4 w-4" /> Markdown report
            </Button>
            <Button variant="ghost" onClick={() => setNonce((value) => value + 1)}>
              <RefreshCw className="h-4 w-4" /> Re-inspect
            </Button>
            <span className="text-[11px] text-muted">Inspected in this tab · nothing was uploaded</span>
          </div>

          {markdown && (
            <div className="space-y-2">
              <DownloadPanel
                bytes={markdown.bytes}
                filename={markdown.name}
                size={markdown.bytes.byteLength}
                mime="text/markdown"
                title="Markdown report ready"
                description="Risk score, red flags, accessibility, PDF/A claim, every section and the suggested next steps in one file."
                onDownload={() => downloadBytes(markdown.bytes, markdown.name, "text/markdown")}
              />
              <div className="flex justify-end">
                <Button variant="ghost" size="sm" onClick={() => setMarkdown(null)}>
                  Hide report panel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {!pdf.bytes && !pdf.loading && (
        <div className="flex items-start gap-2 rounded-xl border border-dashed border-line bg-bone-deep/25 px-3.5 py-3 text-[11.5px] leading-relaxed text-muted">
          <FileSearch className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Add a PDF to see its metadata, page geometry, text coverage, forms, scripts,
          attachments and structural flags. Everything is read in this tab.
        </div>
      )}
    </div>
  );
}
