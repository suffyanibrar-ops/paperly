import {
  Check,
  Copy,
  Download,
  FileSearch,
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
  PDFDict,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFString,
  type PDFContext,
  type PDFDocument as PDFLibDocument,
  type PDFObject,
} from "@cantoo/pdf-lib";
import { extractDocument } from "@/lib/extract";
import {
  chunkPages,
  extractAnswerWindows,
  highlightRanges,
  rankPassages,
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
import { Alert, Badge, Button, Field, FileDrop, FileRow, Progress, inputClass } from "@/components/ui";
import { SinglePdfInput } from "@/components/toolParts";
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

const SUGGESTED_QUESTIONS = [
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

export function AskPdfTool() {
  const initial = useInitialFiles().filter((file) => /\.pdf$/i.test(file.name) || file.type === "application/pdf");
  const [files, setFiles] = useState<File[]>(() => initial.slice(0, MAX_DOCS));
  const metas = useFileMetas(files);

  const [scope, setScope] = useState("");
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState<KnowledgeIndex | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setIndex(null);
    setResult(null);
    setError("");
    setNotice("");
    setProgress(0);
    setStage("");
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
      const bytes = await readFileBytes(selection.file);
      const extracted = await extractDocument(bytes, {
        pages: selection.pages,
        onProgress: (pageDone, pageTotal) => {
          setProgress(((done + pageDone) / totalToRead) * 100);
          setStage(`${selection.docName} · page ${pageDone} of ${pageTotal}`);
        },
      });
      done += selection.pages.length;
      const textChars = extracted.text.replace(/\s/g, "").length;
      if (textChars < 20) emptyTextDocs.push(selection.docName);
      passages.push(
        ...chunkPages(
          extracted.pages.map((page) => ({
            page: page.page,
            text: page.text,
            docId: selection.docId,
            docName: selection.docName,
          })),
          { maxChars: MAX_CHUNK_CHARS },
        ),
      );
      docs.push({
        id: selection.docId,
        name: selection.docName,
        pageCount: selection.totalPages,
        pagesRead: selection.pages.length,
        textChars,
      });
    }

    setStage("Building the local passage index…");
    setProgress(100);
    return { passages, docs, pagesRead: done, requestedPages, capped: requestedPages > done, emptyTextDocs, unreadableFiles };
  };

  const runQuestion = async (override?: string) => {
    const question = (override ?? query).trim();
    if (!question) {
      setError("Type a question to search your PDFs.");
      return;
    }
    if (files.some((file) => !metas[fileKey(file)] || metas[fileKey(file)].loading)) {
      setNotice("Still reading a PDF — try again in a moment.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    setResult(null);
    try {
      const activeIndex = index ?? (await buildIndex());
      if (!index) setIndex(activeIndex);
      if (!activeIndex.passages.length) {
        setNotice("No text layer was found in the selected pages. This looks like a scanned PDF — run OCR PDF first, then come back with the searchable copy.");
        return;
      }
      const rank = rankPassages(activeIndex.passages, question, { limit: 6 });
      const windows = extractAnswerWindows(rank.passages, question, { maxSentences: 3, maxChars: 800 });
      const outcome = verdict(question, rank);
      setResult({ question, rank, windows, verdict: outcome, index: activeIndex });
      if (!rank.passages.length) setNotice("No passage matched those words. Try fewer, more specific terms that appear in the document.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setProgress(0);
      setStage("");
    }
  };

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

  const fileProblems = files
    .map((file) => ({ file, meta: metas[fileKey(file)] }))
    .filter((entry) => entry.meta?.error);

  const verdictMeta = result ? VERDICT_META[result.verdict.status] : VERDICT_META["not-found"];
  const indexed = result?.index ?? index;

  return (
    <div className="space-y-5">
      {files.length === 0 ? (
        <FileDrop
          accept="application/pdf,.pdf"
          acceptLabel={`PDF files (up to ${MAX_DOCS})`}
          multiple
          onFiles={(picked) => void addFiles(picked)}
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
                  onChange={(event) => setScope(event.target.value)}
                  placeholder="All pages"
                  className={inputClass}
                  autoComplete="off"
                />
                <Button type="button" variant="outline" size="md" onClick={() => setScope("")} className="shrink-0">
                  All
                </Button>
              </div>
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink/75">Try</span>
            {SUGGESTED_QUESTIONS.map((question) => (
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

          {scopeSummary.error && <Alert tone="error">{scopeSummary.error}</Alert>}
          {!scopeSummary.error && scopeSummary.total > MAX_TOTAL_PAGES && (
            <Alert tone="warning">
              You selected {scopeSummary.total.toLocaleString()} pages. Paperly reads the first {MAX_TOTAL_PAGES} pages across your PDFs per run — narrow the
              page ranges to reach later pages.
            </Alert>
          )}
          {error && <Alert tone="error">{error}</Alert>}
          {notice && <Alert tone="info">{notice}</Alert>}

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={() => void runQuestion()} loading={busy} disabled={!query.trim() || Boolean(scopeSummary.error)}>
              <Search className="h-4 w-4" /> Find answer
            </Button>
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

async function inspectDocument(
  bytes: ArrayBuffer,
  file: File,
  onProgress: (label: string, value: number) => void,
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
  try {
    const jsDoc = await openPdfJs(bytes);
    const total = jsDoc.numPages;
    if (!pageCount) pageCount = total;
    const sampled = Math.min(total, MAX_TEXT_SCAN_PAGES);
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
  };
}

function reportToText(report: InspectReport): string {
  const lines: string[] = [
    `Paperly PDF inspection — ${report.file.name}`,
    `Generated: ${report.generated}`,
    `File size: ${formatBytes(report.file.size)} · modified ${report.file.modified}`,
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
  lines.push(
    "",
    "Inspection ran entirely in this tab. Checks are heuristic: an absent flag is not proof the file is safe, signatures are not verified, and metadata can be forged.",
  );
  return lines.join("\n");
}

export function InspectPdfTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [report, setReport] = useState<InspectReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [nonce, setNonce] = useState(0);

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
    setProgress(0);
    setStage("Reading document structure…");
    void (async () => {
      try {
        const next = await inspectDocument(bytes, file, (label, value) => {
          if (!alive) return;
          setStage(label);
          setProgress(value);
        });
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
  }, [pdf.bytes, pdf.file, nonce]);

  const copyReport = async () => {
    if (!report) return;
    const ok = await copyText(reportToText(report));
    setCopied(ok);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const downloadJson = () => {
    if (!report) return;
    const name = `${sanitizeName(baseName(report.file.name))}-inspection.json`;
    downloadBytes(new Uint8Array(new TextEncoder().encode(JSON.stringify(report, null, 2))), name, "application/json");
  };

  const highFlags = report?.flags.filter((flag) => flag.severity === "high" || flag.severity === "medium").length ?? 0;
  const textPercent = report && report.text.sampledPages ? Math.round((report.text.pagesWithText / report.text.sampledPages) * 100) : 0;

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

          {report.summary.parseError && <Alert tone="warning" title="Structure could not be fully parsed">{report.summary.parseError}</Alert>}

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button variant="outline" onClick={() => void copyReport()}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? "Copied" : "Copy full report"}
            </Button>
            <Button variant="outline" onClick={downloadJson}>
              <Download className="h-4 w-4" /> JSON report
            </Button>
            <Button variant="ghost" onClick={() => setNonce((value) => value + 1)}>
              <RefreshCw className="h-4 w-4" /> Re-inspect
            </Button>
            <span className="text-[11px] text-muted">Inspected in this tab · nothing was uploaded</span>
          </div>
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
