import { ArrowLeftRight, Download, EyeOff, FileSearch, Redo2, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  PDFDocument,
  baseName,
  dataUrlToBytes,
  downloadBytes,
  degrees,
  formatBytes,
  getPageDimensions,
  openPdfJs,
  openPdfLib,
  readFileBytes,
  renderPdfPage,
  sanitizeName,
} from "@/lib/pdf";
import { extractDocument } from "@/lib/extract";
import { useInitialFiles, usePdfFile } from "@/lib/usePdf";
import { Alert, Badge, Button, ColorInput, Field, FileDrop, FileRow, Progress, Select } from "@/components/ui";
import { DownloadPanel, SinglePdfInput } from "@/components/toolParts";
import { cn } from "@/utils/cn";

/* ================================================================== *
 * REDACT PDF — true redaction by rasterizing affected pages
 * ================================================================== */
interface Rect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

async function burnRedactions(
  dataUrl: string,
  rects: Rect[],
  color: string,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  ctx.fillStyle = color;
  for (const r of rects) {
    ctx.fillRect(
      Math.round(r.x * canvas.width),
      Math.round(r.y * canvas.height),
      Math.max(1, Math.round(r.w * canvas.width)),
      Math.max(1, Math.round(r.h * canvas.height)),
    );
  }
  bitmap.close?.();
  return { dataUrl: canvas.toDataURL("image/jpeg", 0.92), width: canvas.width, height: canvas.height };
}

export function RedactTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [pageIndex, setPageIndex] = useState(0);
  const [dims, setDims] = useState<{ width: number; height: number }[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [rects, setRects] = useState<Record<number, Rect[]>>({});
  const [draft, setDraft] = useState<Rect | null>(null);
  const [color, setColor] = useState("#000000");
  const [dpi, setDpi] = useState(150);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; pages: number; redactedPages: number } | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  const pageRects = rects[pageIndex] ?? [];
  const totalRects = Object.values(rects).reduce((sum, list) => sum + list.length, 0);

  useEffect(() => {
    if (!pdf.bytes) {
      setDims([]);
      return;
    }
    const bytes = pdf.bytes;
    getPageDimensions(bytes).then(setDims).catch(() => undefined);
  }, [pdf.bytes]);

  useEffect(() => {
    if (!pdf.bytes) {
      setPreview(null);
      return;
    }
    let alive = true;
    const bytes = pdf.bytes;
    (async () => {
      const doc = await openPdfJs(bytes);
      const rendered = await renderPdfPage(doc, pageIndex + 1, { targetWidth: 1000, quality: 0.9, rotation: 0 });
      await doc.destroy();
      if (alive) setPreview(rendered.dataUrl);
    })().catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [pdf.bytes, pageIndex]);

  const norm = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = surfaceRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!surfaceRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = norm(e);
    startRef.current = p;
    setDraft({ id: "draft", x: p.x, y: p.y, w: 0, h: 0 });
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!startRef.current) return;
    const p = norm(e);
    const start = startRef.current;
    setDraft({
      id: "draft",
      x: Math.min(start.x, p.x),
      y: Math.min(start.y, p.y),
      w: Math.abs(p.x - start.x),
      h: Math.abs(p.y - start.y),
    });
  };
  const onUp = () => {
    if (draft && draft.w > 0.008 && draft.h > 0.008) {
      setRects((prev) => ({ ...prev, [pageIndex]: [...(prev[pageIndex] ?? []), { ...draft, id: uid() }] }));
      setResult(null);
    }
    setDraft(null);
    startRef.current = null;
  };

  const applyRedactions = async () => {
    if (!pdf.bytes || !pdf.file) return;
    if (!totalRects) {
      setError("Draw at least one redaction box first.");
      return;
    }
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const src = await openPdfLib(pdf.bytes);
      const out = await PDFDocument.create();
      const doc = await openPdfJs(pdf.bytes);
      const allPages = src.getPages();
      const total = src.getPageCount();
      for (let i = 0; i < total; i++) {
        const marks = rects[i] ?? [];
        if (marks.length) {
          const original = allPages[i];
          const { width, height } = original.getSize();
          // Render unrotated, then re-apply /Rotate so the page looks identical
          // to the source while the redaction boxes stay aligned with the preview.
          const rendered = await renderPdfPage(doc, i + 1, { scale: dpi / 72, type: "image/jpeg", quality: 0.92, rotation: 0 });
          const burned = await burnRedactions(rendered.dataUrl, marks, color);
          const page = out.addPage([width, height]);
          const rotation = original.getRotation().angle;
          if (rotation) page.setRotation(degrees(rotation));
          const image = await out.embedJpg(dataUrlToBytes(burned.dataUrl));
          page.drawImage(image, { x: 0, y: 0, width, height });
        } else {
          const [copied] = await out.copyPages(src, [i]);
          out.addPage(copied);
        }
        setProgress(((i + 1) / total) * 95);
      }
      await doc.destroy();
      const bytes = await out.save();
      const redactedPages = Object.keys(rects).filter((k) => (rects[Number(k)] ?? []).length > 0).length;
      setProgress(100);
      setResult({
        bytes,
        name: `${sanitizeName(baseName(pdf.file.name))}-redacted.pdf`,
        pages: total,
        redactedPages,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to redact" />
      {pdf.bytes && (
        <>
          <div className="rounded-xl border border-clay/20 bg-clay/[0.05] p-3.5">
            <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[#b14425]">
              <EyeOff className="h-4 w-4" /> Real redaction, not a black box drawn on top
            </p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-ink/70">
              Pages with redactions are rebuilt as images with the marked areas permanently burned in, so the covered text can’t be copied or
              extracted. Other pages stay untouched with their original, selectable text.
            </p>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_250px]">
            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-bone-deep/40 px-2 py-1.5">
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" disabled={pageIndex === 0} onClick={() => setPageIndex((i) => i - 1)} aria-label="Previous page">
                    <Redo2 className="h-3.5 w-3.5 -scale-x-100" />
                  </Button>
                  <span className="min-w-[74px] text-center text-[11.5px] font-medium tabular-nums text-ink/70">
                    Page {pageIndex + 1} / {pdf.pageCount}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pageIndex >= pdf.pageCount - 1}
                    onClick={() => setPageIndex((i) => i + 1)}
                    aria-label="Next page"
                  >
                    <Redo2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <p className="px-2 text-[11px] text-muted">Drag across the page to mark content for removal.</p>
              </div>

              <div className="rounded-xl border border-line bg-bone-deep/50 p-3 sm:p-5">
                <div className="mx-auto w-full max-w-[720px]">
                  <div
                    ref={surfaceRef}
                    onPointerDown={onDown}
                    onPointerMove={onMove}
                    onPointerUp={onUp}
                    className="relative w-full cursor-crosshair touch-none select-none overflow-hidden rounded-sm bg-white pdf-page-shadow"
                    style={{ aspectRatio: dims[pageIndex] ? `${dims[pageIndex].width} / ${dims[pageIndex].height}` : "3 / 4" }}
                  >
                    {preview ? (
                      <img src={preview} alt={`Page ${pageIndex + 1}`} className="pointer-events-none absolute inset-0 h-full w-full object-fill" draggable={false} />
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center text-[12px] text-ink/70">Rendering page…</div>
                    )}
                    {pageRects.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        aria-label="Remove redaction box"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => {
                          setRects((prev) => ({ ...prev, [pageIndex]: (prev[pageIndex] ?? []).filter((x) => x.id !== r.id) }));
                          setResult(null);
                        }}
                        className="group absolute cursor-pointer border border-white/40"
                        style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%`, background: color }}
                      >
                        <span className="absolute -right-2 -top-2 hidden h-4 w-4 items-center justify-center rounded-full bg-paper text-ink shadow group-hover:flex">
                          <X className="h-2.5 w-2.5" />
                        </span>
                      </button>
                    ))}
                    {draft && (
                      <div
                        className="pointer-events-none absolute border border-dashed border-clay bg-clay/25"
                        style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%` }}
                      />
                    )}
                  </div>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button onClick={applyRedactions} loading={busy}>
                  <EyeOff className="h-4 w-4" /> Apply {totalRects} redaction{totalRects === 1 ? "" : "s"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setRects((prev) => ({ ...prev, [pageIndex]: [] }));
                    setResult(null);
                  }}
                  disabled={!pageRects.length}
                >
                  Clear this page
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setRects({});
                    setResult(null);
                  }}
                  disabled={!totalRects}
                >
                  Clear all
                </Button>
                <span className="text-[11.5px] text-muted">
                  {totalRects} mark{totalRects === 1 ? "" : "s"} on {Object.values(rects).filter((r) => r.length).length} page
                  {Object.values(rects).filter((r) => r.length).length === 1 ? "" : "s"}
                </span>
              </div>
              {busy && <Progress value={progress} label="Burning redactions into new page images…" />}
              {error && <Alert tone="error" className="mt-3">{error}</Alert>}
            </div>

            <aside className="space-y-3">
              <div className="rounded-xl border border-line bg-paper p-3.5">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">Redaction settings</p>
                <Field label="Box color">
                  <ColorInput value={color} onChange={setColor} label="Redaction color" />
                </Field>
                <div className="mt-3">
                  <Field label="Output resolution" hint="Higher keeps small text crisper; files get larger.">
                    <Select value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
                      <option value={110}>Standard · 110 DPI</option>
                      <option value={150}>High · 150 DPI</option>
                      <option value={220}>Print · 220 DPI</option>
                      <option value={300}>Maximum · 300 DPI</option>
                    </Select>
                  </Field>
                </div>
              </div>
              <div className="rounded-xl border border-line bg-bone-deep/30 p-3 text-[11px] leading-relaxed text-muted">
                <p className="flex items-center gap-1.5 font-semibold text-ink/70">
                  <ShieldCheck className="h-3.5 w-3.5 text-forest" /> Verify before sharing
                </p>
                <p className="mt-1">
                  Open the downloaded file and try to select the covered area. Because the affected pages are flattened, the original text beneath is
                  gone — not merely hidden. Always keep the unredacted original in a safe place.
                </p>
              </div>
            </aside>
          </div>
        </>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Redactions applied"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${result.redactedPages} page${result.redactedPages === 1 ? "" : "s"} flattened · ${totalRects} marked area${totalRects === 1 ? "" : "s"} permanently removed · other pages untouched`}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * COMPARE PDF — line-level text diff
 * ================================================================== */
type DiffKind = "same" | "added" | "removed";
interface DiffLine {
  kind: DiffKind;
  text: string;
}
interface PageDiff {
  page: number;
  lines: DiffLine[];
  added: number;
  removed: number;
}

function diffLines(left: string[], right: string[]): DiffLine[] {
  const n = left.length;
  const m = right.length;
  if (n * m > 1_200_000) {
    // Very large pages: fall back to a set-based comparison to stay responsive.
    const rightSet = new Set(right.map((l) => l.trim()));
    const leftSet = new Set(left.map((l) => l.trim()));
    const out: DiffLine[] = [];
    left.forEach((l) => out.push({ kind: rightSet.has(l.trim()) ? "same" : "removed", text: l }));
    right.forEach((l) => {
      if (!leftSet.has(l.trim())) out.push({ kind: "added", text: l });
    });
    return out;
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = left[i].trim() === right[j].trim() ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (left[i].trim() === right[j].trim()) {
      out.push({ kind: "same", text: left[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "removed", text: left[i++] });
    } else {
      out.push({ kind: "added", text: right[j++] });
    }
  }
  while (i < n) out.push({ kind: "removed", text: left[i++] });
  while (j < m) out.push({ kind: "added", text: right[j++] });
  return out;
}

export function CompareTool() {
  const initial = useInitialFiles().filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
  const [leftFile, setLeftFile] = useState<File | null>(initial[0] ?? null);
  const [rightFile, setRightFile] = useState<File | null>(initial[1] ?? null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [pages, setPages] = useState<PageDiff[] | null>(null);
  const [showSame, setShowSame] = useState(false);
  const [summary, setSummary] = useState<{ added: number; removed: number; changedPages: number; totalPages: number } | null>(null);

  const compare = async () => {
    if (!leftFile || !rightFile) {
      setError("Add both PDFs to compare.");
      return;
    }
    setBusy(true);
    setError("");
    setPages(null);
    try {
      const [left, right] = await Promise.all([
        extractDocument(await readFileBytes(leftFile), { onProgress: (d, t) => setProgress((d / t) * 35) }),
        extractDocument(await readFileBytes(rightFile), { onProgress: (d, t) => setProgress(35 + (d / t) * 35) }),
      ]);
      const total = Math.max(left.pages.length, right.pages.length);
      const result: PageDiff[] = [];
      for (let i = 0; i < total; i++) {
        const a = left.pages[i]?.lines.map((l) => l.text) ?? [];
        const b = right.pages[i]?.lines.map((l) => l.text) ?? [];
        const lines = diffLines(a, b);
        result.push({
          page: i + 1,
          lines,
          added: lines.filter((l) => l.kind === "added").length,
          removed: lines.filter((l) => l.kind === "removed").length,
        });
        setProgress(70 + ((i + 1) / total) * 30);
      }
      setPages(result);
      setSummary({
        added: result.reduce((s, p) => s + p.added, 0),
        removed: result.reduce((s, p) => s + p.removed, 0),
        changedPages: result.filter((p) => p.added || p.removed).length,
        totalPages: total,
      });
      setProgress(100);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const downloadReport = () => {
    if (!pages) return;
    const lines: string[] = [
      `Paperly PDF comparison`,
      `Left:  ${leftFile?.name}`,
      `Right: ${rightFile?.name}`,
      `Summary: ${summary?.added ?? 0} added lines, ${summary?.removed ?? 0} removed lines across ${summary?.totalPages ?? 0} pages`,
      "",
    ];
    pages.forEach((p) => {
      if (!p.added && !p.removed) return;
      lines.push(`── Page ${p.page} ──`);
      p.lines.forEach((l) => {
        if (l.kind === "same") return;
        lines.push(`${l.kind === "added" ? "+" : "-"} ${l.text}`);
      });
      lines.push("");
    });
    downloadBytes(new Uint8Array(new TextEncoder().encode(lines.join("\n"))), `paperly-compare.txt`, "text/plain");
  };

  const visible = pages?.filter((p) => showSame || p.added || p.removed) ?? [];

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        {[
          { label: "Original PDF", file: leftFile, set: setLeftFile, tone: "clay" as const },
          { label: "Revised PDF", file: rightFile, set: setRightFile, tone: "forest" as const },
        ].map((slot) => (
          <div key={slot.label}>
            <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">
              <span className={cn("h-1.5 w-1.5 rounded-full", slot.tone === "clay" ? "bg-clay" : "bg-forest")} /> {slot.label}
            </p>
            {slot.file ? (
              <FileRow file={slot.file} onRemove={() => { slot.set(null); setPages(null); }} size={formatBytes(slot.file.size)} />
            ) : (
              <FileDrop
                accept="application/pdf,.pdf"
                acceptLabel="A PDF file"
                compact
                onFiles={(files) => {
                  slot.set(files[0]);
                  setPages(null);
                }}
              />
            )}
          </div>
        ))}
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <Button onClick={compare} loading={busy} disabled={!leftFile || !rightFile}>
          <ArrowLeftRight className="h-4 w-4" /> Compare documents
        </Button>
        {pages && (
          <Button variant="outline" onClick={() => setShowSame((v) => !v)}>
            {showSame ? "Hide unchanged lines" : "Show unchanged lines"}
          </Button>
        )}
        <span className="text-[11.5px] text-muted">Compares the text layer, page by page.</span>
      </div>
      {busy && <Progress value={progress} label="Reading both documents and building the diff…" />}

      {summary && pages && (
        <div className="space-y-4">
          <div className={cn("rounded-2xl border p-5", summary.added + summary.removed === 0 ? "border-forest/20 bg-lime/20" : "border-line bg-paper")}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-[16px] font-semibold">
                  {summary.added + summary.removed === 0 ? "The text is identical" : `${summary.changedPages} of ${summary.totalPages} pages differ`}
                </h3>
                <p className="mt-0.5 text-[12px] text-muted">
                  {summary.added} added line{summary.added === 1 ? "" : "s"} · {summary.removed} removed line{summary.removed === 1 ? "" : "s"}
                </p>
              </div>
              <div className="flex gap-2">
                <Badge tone="forest">+{summary.added}</Badge>
                <Badge tone="clay">−{summary.removed}</Badge>
                <Button variant="outline" size="sm" onClick={downloadReport}>
                  <Download className="h-3.5 w-3.5" /> Report
                </Button>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {pages.map((p) => (
                <a
                  key={p.page}
                  href={`#diff-page-${p.page}`}
                  className={cn(
                    "rounded-md border px-2 py-1 text-[10.5px] font-semibold tabular-nums",
                    p.added || p.removed ? "border-clay/25 bg-clay/[0.07] text-clay-ink" : "border-line bg-bone text-ink/75",
                  )}
                >
                  p.{p.page}
                </a>
              ))}
            </div>
          </div>

          {visible.length === 0 && (
            <div className="rounded-xl border border-line bg-paper p-6 text-center text-[12.5px] text-muted">
              No differences found in the text layer. Layout-only changes (images, spacing) aren’t detected by this tool.
            </div>
          )}

          <div className="space-y-4">
            {visible.map((page) => (
              <div key={page.page} id={`diff-page-${page.page}`} className="overflow-hidden rounded-xl border border-line bg-paper">
                <div className="flex items-center justify-between border-b border-line bg-bone-deep/40 px-3.5 py-2">
                  <p className="flex items-center gap-1.5 text-[12px] font-semibold">
                    <FileSearch className="h-3.5 w-3.5 text-forest" /> Page {page.page}
                  </p>
                  <span className="text-[10.5px] font-medium text-muted">
                    <span className="text-forest">+{page.added}</span> · <span className="text-clay-ink">−{page.removed}</span>
                  </span>
                </div>
                <div className="max-h-[340px] overflow-y-auto p-2 scrollbar-thin">
                  {page.lines
                    .filter((l) => showSame || l.kind !== "same")
                    .map((line, i) => (
                      <div
                        key={`${page.page}-${i}`}
                        className={cn(
                          "flex gap-2 rounded px-2 py-[3px] font-mono text-[11px] leading-relaxed",
                          line.kind === "added" && "bg-lime/25 text-forest",
                          line.kind === "removed" && "bg-clay/[0.08] text-[#a64127]",
                          line.kind === "same" && "text-ink/75",
                        )}
                      >
                        <span className="w-3 shrink-0 select-none text-center">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : ""}</span>
                        <span className="whitespace-pre-wrap break-words">{line.text || " "}</span>
                      </div>
                    ))}
                </div>
              </div>
            ))}
          </div>
          <p className="flex items-center gap-1.5 text-[11px] text-muted">
            <ShieldCheck className="h-3.5 w-3.5 text-forest" /> Each comparison is computed from the PDF text layer in this tab. Scanned pages have no
            text to compare.
          </p>
        </div>
      )}
    </div>
  );
}

