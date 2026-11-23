import {
  ArrowRight,
  Camera,
  ChevronRight,
  Fingerprint,
  Lock,
  Search,
  ShieldCheck,
  UploadCloud,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { POPULAR_IDS, TOOLS, getTool } from "@/lib/toolRegistry";
import { TOOL_GROUPS, searchScore, toolGroup, type ToolGroupId } from "@/lib/groups";
import { fileExt, formatBytes } from "@/lib/format";
import { startTool } from "@/lib/router";
import { inspectPdfFile, recommendationsFor, type LocalPdfInspection } from "@/lib/localInspect";
import { toolPath } from "@/lib/slugs";
import { FileDrop } from "@/components/ui";
import { ToolCard } from "@/components/ToolCard";
import { cn } from "@/utils/cn";

/* ------------------------------------------------------------------ *
 * Hero upload + local inspection
 * ------------------------------------------------------------------ */
function suggestionsFor(files: File[]): string[] {
  if (!files.length) return POPULAR_IDS;
  const exts = files.map((f) => fileExt(f.name));
  if (files.length > 1 && exts.every((e) => e === "pdf")) return ["merge", "organize", "compress", "pdf-to-word"];
  if (exts.every((e) => ["jpg", "jpeg", "png", "webp", "gif", "avif"].includes(e))) return ["jpg-to-pdf", "pdf-to-jpg", "compress"];
  if (exts.every((e) => e === "pdf") || exts[0] === "pdf") {
    return files.length > 1 ? ["merge", "organize", "extract-text", "compress"] : ["compress", "edit", "sign", "pdf-to-word", "protect"];
  }
  if (exts.every((e) => e === "docx")) return ["word-to-pdf"];
  if (exts.every((e) => ["xlsx", "xls", "csv"].includes(e))) return ["excel-to-pdf"];
  if (exts.every((e) => e === "pptx")) return ["ppt-to-pdf"];
  return ["merge", "compress", "jpg-to-pdf"];
}

function HeroDrop() {
  const [files, setFiles] = useState<File[]>([]);
  const [inspection, setInspection] = useState<LocalPdfInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const pdfFile = files.find((file) => /\.pdf$/i.test(file.name) || file.type === "application/pdf");
  const suggestions = useMemo(() => suggestionsFor(files), [files]);
  const recommendations = useMemo(() => recommendationsFor(files, inspection), [files, inspection]);

  useEffect(() => {
    if (!pdfFile) {
      setInspection(null);
      setInspecting(false);
      return;
    }
    let alive = true;
    setInspecting(true);
    setInspection(null);
    inspectPdfFile(pdfFile)
      .then((result) => alive && setInspection(result))
      .catch(() => alive && setInspection(null))
      .finally(() => alive && setInspecting(false));
    return () => {
      alive = false;
    };
  }, [pdfFile]);

  const clear = () => {
    setFiles([]);
    setInspection(null);
  };

  return (
    <div className="relative">
      <div className="surface relative overflow-hidden p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-forest text-lime">
              <UploadCloud className="h-3.5 w-3.5" />
            </div>
            <div>
              <p className="text-[12.5px] font-semibold leading-none">Drop a file, pick a tool</p>
              <p className="mt-1 text-[10.5px] text-muted">Inspected in this browser — never uploaded</p>
            </div>
          </div>
          <span className="flex items-center gap-1 rounded-full bg-lime/30 px-2 py-1 text-[9.5px] font-bold uppercase tracking-[0.08em] text-forest">
            <Lock className="h-2.5 w-2.5" /> Private
          </span>
        </div>

        {files.length === 0 ? (
          <>
            <FileDrop accept="application/pdf,image/*,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.md,.markdown,.html,.htm,.txt,.csv" acceptLabel="PDF, images, Word, Excel, PowerPoint" multiple compact onFiles={setFiles} />
            <label className="mt-2 flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-xl border border-line bg-paper px-3 text-[12px] font-semibold text-forest sm:hidden">
              <Camera className="h-4 w-4" /> Scan with camera
              <input
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                className="sr-only"
                onChange={(event) => {
                  const picked = Array.from(event.target.files ?? []);
                  event.target.value = "";
                  if (picked.length) startTool("scan", picked);
                }}
              />
            </label>
          </>
        ) : (
          <div className="animate-pop">
            <div className="rounded-xl border border-forest/15 bg-lime/15 px-3 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[12.5px] font-semibold">{files.length === 1 ? files[0].name : `${files.length} files ready`}</p>
                  <p className="mt-0.5 font-mono text-[10.5px] text-muted">
                    {formatBytes(files.reduce((sum, f) => sum + f.size, 0))} · held in browser memory
                  </p>
                </div>
                <button type="button" onClick={clear} aria-label="Clear selected files" className="rounded p-1 text-ink/75 hover:bg-ink/5 hover:text-ink">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {files.slice(0, 4).map((file) => (
                  <span key={`${file.name}-${file.size}-${file.lastModified}`} className="max-w-[160px] truncate rounded-full bg-paper px-2 py-0.5 text-[10px] font-medium text-ink/70">
                    {file.name}
                  </span>
                ))}
                {files.length > 4 && <span className="rounded-full bg-paper px-2 py-0.5 text-[10px] font-medium text-ink/70">+{files.length - 4}</span>}
              </div>
            </div>

            {pdfFile && (
              <div className="mt-2.5 rounded-xl border border-line bg-paper p-2.5">
                {inspecting ? (
                  <p className="flex items-center gap-2 text-[11px] font-medium text-forest">
                    <Zap className="h-3.5 w-3.5 animate-pulse" /> Inspecting the first PDF locally — pages, encryption and text layer…
                  </p>
                ) : inspection ? (
                  <>
                    <div className="grid grid-cols-4 gap-1.5">
                      {[
                        { label: "Pages", value: inspection.pages ? String(inspection.pages) : "—" },
                        { label: "Size", value: formatBytes(inspection.size) },
                        {
                          label: "Text layer",
                          value: inspection.needsPassword ? "Locked" : inspection.scanned ? "None" : "Yes",
                        },
                        { label: "Encryption", value: inspection.encrypted ? "Protected" : "None" },
                      ].map((stat) => (
                        <div key={stat.label} className="rounded-lg bg-bone-deep/50 px-1.5 py-1 text-center">
                          <p className="truncate font-mono text-[11px] font-semibold leading-tight text-ink">{stat.value}</p>
                          <p className="mt-0.5 text-[8.5px] font-semibold uppercase tracking-[0.05em] text-ink/60">{stat.label}</p>
                        </div>
                      ))}
                    </div>
                    {inspection.scanned && !inspection.needsPassword && (
                      <p className="mt-2 flex items-center gap-1.5 rounded-lg bg-lime/25 px-2 py-1 text-[10.5px] font-semibold text-forest">
                        <Search className="h-3 w-3" /> Scanned PDF detected — no selectable text.
                      </p>
                    )}
                    {inspection.needsPassword && (
                      <p className="mt-2 flex items-center gap-1.5 rounded-lg bg-clay/10 px-2 py-1 text-[10.5px] font-semibold text-clay-ink">
                        <Lock className="h-3 w-3" /> Password required — unlock your own copy first.
                      </p>
                    )}
                    {inspection.error && !inspection.needsPassword && (
                      <p className="mt-2 text-[10px] leading-snug text-clay-ink">{inspection.error}</p>
                    )}
                  </>
                ) : null}
              </div>
            )}

            <p className="mt-3 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-ink/75">
              {recommendations.length ? "Recommended for this file" : "What would you like to do?"}
            </p>
            <div className="mt-2 grid grid-cols-1 gap-1.5">
              {(recommendations.length
                ? recommendations.map((rec) => ({ id: rec.toolId, reason: rec.reason, tone: rec.tone }))
                : suggestions.map((id) => ({ id, reason: getTool(id)?.tagline ?? "", tone: "neutral" as const }))
              ).map((entry) => {
                const tool = getTool(entry.id);
                if (!tool) return null;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => startTool(entry.id, files)}
                    className="group flex min-h-12 items-start gap-2 rounded-lg border border-line bg-paper px-2.5 py-2 text-left transition-colors hover:border-forest/35 hover:bg-lime/10"
                  >
                    <tool.icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-forest" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11.5px] font-semibold">{tool.name}</span>
                      <span className="mt-0.5 block text-[10px] leading-snug text-muted">{entry.reason}</span>
                    </span>
                    <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-ink/50 group-hover:text-forest" />
                  </button>
                );
              })}
            </div>
            <a href="/tools" className="mt-2 flex items-center justify-center gap-1 py-1 text-[11px] font-medium text-forest hover:underline">
              Or choose from all {TOOLS.length} tools <ArrowRight className="h-3 w-3" />
            </a>
          </div>
        )}

        {files.length === 0 && (
          <div className="mt-3 hidden grid-cols-2 gap-1.5 sm:grid">
            {POPULAR_IDS.slice(0, 4).map((id) => {
              const tool = getTool(id)!;
              return (
                <a
                  key={id}
                  href={toolPath(id)}
                  className="group flex min-h-12 items-center gap-2 rounded-lg border border-line bg-bone/60 px-2 py-2 text-left transition-colors hover:border-forest/30 hover:bg-paper"
                >
                  <tool.icon className="h-3.5 w-3.5 shrink-0 text-forest" />
                  <span className="truncate text-[11.5px] font-medium">{tool.name}</span>
                </a>
              );
            })}
          </div>
        )}
        <div className="mt-3 hidden items-center justify-between gap-2 border-t border-line pt-2.5 sm:flex">
          <p className="flex items-center gap-1.5 text-[10px] text-muted">
            <ShieldCheck className="h-3 w-3 text-forest" /> No account. No file-size paywall.
          </p>
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-lime/40 px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.07em] text-forest">
            <Lock className="h-2.5 w-2.5" /> 0 KB uploaded
          </span>
        </div>
      </div>

      <div className="absolute -bottom-5 -left-4 z-20 hidden items-center gap-2 rounded-xl border border-line bg-paper px-2.5 py-2 shadow-soft sm:flex">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-forest text-lime">
          <Fingerprint className="h-3 w-3" />
        </div>
        <div>
          <p className="text-[9px] font-bold uppercase tracking-[0.08em] text-ink/75">Encryption</p>
          <p className="text-[10.5px] font-semibold leading-none">AES-256, in-tab</p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Home
 * ------------------------------------------------------------------ */
export default function Home() {
  const [category, setGroup] = useState<ToolGroupId | "all">("all");
  const [query, setQuery] = useState("");
  const openPalette = () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
  };

  const filtered = TOOLS.filter((tool) => {
    const matchesGroup = category === "all" || toolGroup(tool.id) === category;
    return matchesGroup && searchScore(query, tool) > 0;
  });

  return (
    <div>
      {/* HERO */}
      <section className="relative overflow-hidden border-b border-line">
        <div className="hero-glow pointer-events-none absolute inset-0" />
        <div className="hero-grid pointer-events-none absolute inset-x-0 top-0 h-full" />
        <div className="container-page relative grid gap-5 pb-8 pt-6 sm:gap-12 sm:pb-12 sm:pt-10 md:pt-16 lg:grid-cols-[1.15fr_0.85fr] lg:items-center lg:gap-16 lg:pb-20">
          <div className="animate-rise">
            <p className="hidden items-center gap-2 rounded-full border border-forest/15 bg-paper/80 px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.1em] text-forest sm:inline-flex">
              <Lock className="h-3 w-3" /> 51 tools · 0 bytes uploaded
            </p>
            <h1 className="fluid-hero mt-1 font-semibold text-ink sm:mt-5">
              Every PDF tool.
              <br />
              <span className="font-serif font-normal italic tracking-[-0.02em] text-forest">Nowhere to upload.</span>
            </h1>
            <p className="mt-2 max-w-[40ch] text-[14px] leading-relaxed text-ink/70 sm:mt-4 sm:text-[16px]">
              Merge, compress, OCR, redact, sign — all in this tab.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2.5 sm:mt-5">
              <a href="#tools" className="hidden h-12 items-center gap-2 rounded-xl bg-ink px-5 text-[13.5px] font-medium text-paper sm:inline-flex">
                Browse {TOOLS.length} tools <ArrowRight className="h-4 w-4 text-lime" />
              </a>
              <button type="button" onClick={openPalette} className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-xl border border-line bg-paper/70 px-4 text-[13px] font-medium text-ink/75 sm:flex-none sm:justify-start">
                <Search className="h-4 w-4" /> Search <kbd className="rounded border border-line bg-bone-deep/70 px-1 py-0.5 font-mono text-[9px] text-ink/60">⌘K</kbd>
              </button>
            </div>
          </div>

          <div className="relative animate-rise [animation-delay:120ms]">
            <div className="absolute -left-8 -top-8 hidden h-40 w-32 rotate-[-8deg] rounded-2xl border border-forest/10 bg-lime/60 lg:block" />
            <div className="absolute -left-4 -top-4 hidden h-40 w-32 rotate-[-4deg] rounded-2xl border border-forest/10 bg-paper lg:block" />
            <HeroDrop />
          </div>
        </div>

      </section>

      {/* TOOLS */}
      <section id="tools" className="scroll-mt-24 border-b border-line py-8 md:py-14">
        <div className="container-page">
          <div className="mb-4 flex items-end justify-between gap-3">
            <div>
              <p className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-forest">All {TOOLS.length} tools · free</p>
              <h2 className="mt-1 text-[26px] font-semibold leading-none tracking-[-0.035em] sm:text-[34px]">Pick a tool.</h2>
            </div>
            <a href="/tools" className="hidden shrink-0 items-center gap-1 text-[12.5px] font-semibold text-forest hover:underline sm:inline-flex">
              Full catalogue <ArrowRight className="h-3.5 w-3.5" />
            </a>
          </div>

          <div className="sticky top-[96px] z-30 -mx-4 flex flex-col gap-2 bg-bone/90 px-4 py-2.5 backdrop-blur-xl sm:top-[104px] lg:flex-row lg:items-center lg:justify-between">
            <div className="scrollbar-none -mx-1 flex gap-2 overflow-x-auto px-1 pb-1 sm:flex-wrap">
              <button
                type="button"
                onClick={() => setGroup("all")}
                className={cn(
                  "min-h-12 shrink-0 rounded-full border px-3.5 text-[12px] font-medium transition-colors sm:min-h-0 sm:py-1.5",
                  category === "all" ? "border-forest bg-forest text-paper" : "border-line bg-paper text-ink/70 hover:border-forest/30",
                )}
              >
                All {TOOLS.length} <span className="ml-1 text-paper/75">tools</span>
              </button>
              {TOOL_GROUPS.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  onClick={() => setGroup(group.id)}
                  className={cn(
                    "flex min-h-12 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[12px] font-medium transition-colors sm:min-h-0 sm:py-1.5",
                    category === group.id ? "border-forest bg-forest text-paper" : "border-line bg-paper text-ink/70 hover:border-forest/30",
                  )}
                >
                  <span className={cn("h-1.5 w-1.5 rounded-full", category === group.id ? "bg-lime" : group.dot)} />
                  {group.label}
                  <span className={cn("tabular-nums", category === group.id ? "text-paper/75" : "text-ink/75")}>{group.ids.length}</span>
                </button>
              ))}
            </div>
            <label className="relative block w-full lg:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/75" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${TOOLS.length} tools…`}
                aria-label="Search tools"
                className="h-12 w-full rounded-xl border border-line bg-paper pl-9 pr-3 text-[16px] placeholder:text-ink/75 sm:h-10 sm:text-[13px] focus:border-forest/40 focus:outline-none focus:ring-2 focus:ring-forest/10"
              />
            </label>
          </div>

          {filtered.length ? (
            <div className="mt-4 grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {filtered.map((tool) => (
                <ToolCard key={tool.id} tool={tool} showCategory />
              ))}
            </div>
          ) : (
            <div className="mt-6 rounded-2xl border border-dashed border-line bg-paper p-10 text-center">
              <p className="text-[14px] font-medium">No tools match “{query}”.</p>
              <button type="button" onClick={() => { setQuery(""); setGroup("all"); }} className="mt-2 text-[12px] font-semibold text-forest hover:underline">
                Clear search and filters
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="border-b border-line bg-paper/50 py-6">
        <div className="container-page flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[11px] font-medium text-ink/65">
          <span className="flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5 text-forest" /> 0 bytes uploaded</span>
          <span className="flex items-center gap-1.5"><Zap className="h-3.5 w-3.5 text-forest" /> Runs on-device</span>
          <span className="flex items-center gap-1.5"><Lock className="h-3.5 w-3.5 text-forest" /> No account</span>
          <a href="/privacy" className="font-semibold text-forest hover:underline">How local processing works</a>
        </div>
      </section>

      {/* CTA */}
      <section className="pb-10 md:pb-16">
        <div className="container-page">
          <div className="grain relative overflow-hidden rounded-3xl bg-forest px-6 py-12 text-paper sm:px-12 sm:py-14">
            <div className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full bg-lime/15 blur-2xl" />
            <div className="pointer-events-none absolute bottom-0 right-10 hidden rotate-6 rounded-xl border border-paper/15 bg-paper/10 p-3 lg:block">
              <div className="h-24 w-16 rounded bg-paper/80 p-2">
                <div className="h-1 w-8 rounded bg-forest/30" />
                <div className="mt-1.5 space-y-1">
                  <div className="h-0.5 w-10 rounded bg-forest/20" />
                  <div className="h-0.5 w-9 rounded bg-forest/20" />
                  <div className="h-0.5 w-11 rounded bg-forest/20" />
                </div>
                <div className="mt-3 h-4 w-10 rounded-sm bg-lime" />
              </div>
            </div>
            <div className="relative max-w-xl">
              <p className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.14em] text-lime">
                <Lock className="h-3 w-3" /> No server in the loop
              </p>
              <h2 className="mt-3 text-[30px] font-semibold leading-[1.04] tracking-[-0.04em] sm:text-[40px]">
                Ready to stop uploading
                <br />
                your PDFs?
              </h2>
              <p className="mt-3 text-[13.5px] leading-relaxed text-paper/70">
                Pick a tool and your first job can be done in under a minute. No account, no email, no trial countdown.
              </p>
              <div className="mt-6 flex flex-wrap gap-2.5">
                <a href="/merge-pdf" className="inline-flex h-11 items-center gap-2 rounded-xl bg-lime px-5 text-[13.5px] font-semibold text-ink transition-colors hover:bg-[#e4f88f]">
                  Merge a PDF <ArrowRight className="h-4 w-4" />
                </a>
                <a href="/tools" className="inline-flex h-11 items-center gap-2 rounded-xl border border-paper/20 px-5 text-[13.5px] font-medium text-paper transition-colors hover:bg-paper/10">
                  Browse all tools
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
