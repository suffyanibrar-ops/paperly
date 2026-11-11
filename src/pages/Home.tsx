import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  Cpu,
  FileCheck2,
  Fingerprint,
  Lock,
  Search,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  X,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";
import { CATEGORIES, POPULAR_IDS, TOOLS, getTool, type ToolCategory } from "@/lib/toolRegistry";
import { useFavorites, useActivity, readableRecent } from "@/lib/activity";
import { GUIDE_TEASERS } from "@/pages/More";
import { fileExt, formatBytes } from "@/lib/format";
import { startTool } from "@/lib/router";
import { Accordion, AccordionItem, Badge, FileDrop } from "@/components/ui";
import { ToolCard } from "@/components/ToolCard";
import { cn } from "@/utils/cn";

/* ------------------------------------------------------------------ *
 * Hero upload
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
  const suggestions = useMemo(() => suggestionsFor(files), [files]);

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
              <p className="mt-1 text-[10.5px] text-muted">It never leaves this browser</p>
            </div>
          </div>
          <span className="flex items-center gap-1 rounded-full bg-lime/30 px-2 py-1 text-[9.5px] font-bold uppercase tracking-[0.08em] text-forest">
            <Lock className="h-2.5 w-2.5" /> Private
          </span>
        </div>

        {files.length === 0 ? (
          <FileDrop
            accept="*"
            acceptLabel="PDF, images, Word, Excel, PowerPoint"
            multiple
            compact
            onFiles={setFiles}
          />
        ) : (
          <div className="animate-pop">
            <div className="rounded-xl border border-forest/15 bg-lime/15 px-3 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[12.5px] font-semibold">
                    {files.length === 1 ? files[0].name : `${files.length} files ready`}
                  </p>
                  <p className="mt-0.5 text-[10.5px] text-muted">
                    {formatBytes(files.reduce((sum, f) => sum + f.size, 0))} · held in browser memory
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setFiles([])}
                  aria-label="Clear selected files"
                  className="rounded p-1 text-ink/75 hover:bg-ink/5 hover:text-ink"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {files.slice(0, 4).map((file) => (
                  <span key={file.name} className="max-w-[160px] truncate rounded-full bg-paper px-2 py-0.5 text-[10px] font-medium text-ink/70">
                    {file.name}
                  </span>
                ))}
              </div>
            </div>
            <p className="mt-3 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-ink/75">
              What would you like to do?
            </p>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              {suggestions.map((id) => {
                const tool = getTool(id);
                if (!tool) return null;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => startTool(id, files)}
                    className="group flex items-center gap-2 rounded-lg border border-line bg-paper px-2 py-2 text-left transition-colors hover:border-forest/35 hover:bg-lime/10"
                  >
                    <tool.icon className="h-3.5 w-3.5 shrink-0 text-forest" />
                    <span className="truncate text-[11.5px] font-medium">{tool.name}</span>
                    <ChevronRight className="ml-auto h-3 w-3 shrink-0 text-ink/70 group-hover:text-forest" />
                  </button>
                );
              })}
            </div>
            <a href="#/tools" className="mt-2 flex items-center justify-center gap-1 py-1 text-[11px] font-medium text-forest hover:underline">
              Or choose from all {TOOLS.length} tools <ArrowRight className="h-3 w-3" />
            </a>
          </div>
        )}

        {files.length === 0 && (
          <div className="mt-3 grid grid-cols-2 gap-1.5">
            {POPULAR_IDS.slice(0, 4).map((id) => {
              const tool = getTool(id)!;
              return (
                <a
                  key={id}
                  href={`#/tool/${id}`}
                  className="group flex items-center gap-2 rounded-lg border border-line bg-bone/60 px-2 py-2 text-left transition-colors hover:border-forest/30 hover:bg-paper"
                >
                  <tool.icon className="h-3.5 w-3.5 shrink-0 text-forest" />
                  <span className="truncate text-[11.5px] font-medium">{tool.name}</span>
                </a>
              );
            })}
          </div>
        )}
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-2.5">
          <p className="flex items-center gap-1.5 text-[10px] text-muted">
            <ShieldCheck className="h-3 w-3 text-forest" /> No account. No file-size paywall.
          </p>
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-lime/40 px-2 py-1 text-[9px] font-bold uppercase tracking-[0.07em] text-forest">
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
  const [category, setCategory] = useState<ToolCategory | "all">("all");
  const [query, setQuery] = useState("");
  const { favorites } = useFavorites();
  const activity = useActivity();
  const recent = readableRecent(activity, 4);
  const pinned = favorites.map((id) => getTool(id)).filter((t): t is NonNullable<ReturnType<typeof getTool>> => Boolean(t));
  const shortcuts = [...pinned, ...recent.filter((tool) => !favorites.includes(tool.id))].slice(0, 5);

  const openPalette = () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
  };

  const filtered = TOOLS.filter((tool) => {
    const matchesCategory = category === "all" || tool.category === category;
    const q = query.trim().toLowerCase();
    const matchesQuery =
      !q ||
      tool.name.toLowerCase().includes(q) ||
      tool.tagline.toLowerCase().includes(q) ||
      CATEGORIES[tool.category].name.toLowerCase().includes(q);
    return matchesCategory && matchesQuery;
  });

  return (
    <div>
      {/* HERO */}
      <section className="relative overflow-hidden border-b border-line">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(75%_75%_at_85%_0%,#e9f6c6_0%,transparent_60%)]" />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-full opacity-[0.35] [background-image:linear-gradient(to_right,#dcd6c8_1px,transparent_1px),linear-gradient(to_bottom,#dcd6c8_1px,transparent_1px)] [background-size:72px_72px] [mask-image:radial-gradient(ellipse_at_top,black,transparent_65%)]" />
        <div className="container-page relative grid gap-12 pb-16 pt-12 md:pt-16 lg:grid-cols-[1.15fr_0.85fr] lg:items-center lg:gap-16 lg:pb-20">
          <div className="animate-rise">
            <div className="inline-flex items-center gap-2 rounded-full border border-forest/15 bg-paper/80 py-1.5 pl-1.5 pr-3 text-[11px] font-medium text-forest shadow-soft backdrop-blur">
              <span className="flex h-6 items-center gap-1 rounded-full bg-forest px-2 text-[9.5px] font-bold uppercase tracking-[0.1em] text-lime">
                <Sparkles className="h-2.5 w-2.5" /> New era
              </span>
              {TOOLS.length} PDF tools, running in your browser
            </div>
            <h1 className="mt-6 text-[42px] font-semibold leading-[0.98] tracking-[-0.045em] sm:text-[58px] lg:text-[64px]">
              Every PDF tool.
              <br />
              <span className="font-serif font-normal italic tracking-[-0.02em] text-forest">Nowhere to upload.</span>
            </h1>
            <p className="mt-5 max-w-[46ch] text-[15.5px] leading-relaxed text-ink/75 sm:text-[16.5px]">
              Merge, compress, convert, edit, sign and lock your documents right here in the tab. Nothing is sent to a server, so nothing can be
              leaked, scanned or held hostage.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-2.5">
              <a
                href="#/tools"
                className="inline-flex h-12 items-center gap-2 rounded-xl bg-ink px-6 text-[14.5px] font-medium text-paper shadow-[0_16px_32px_-18px_rgba(18,33,26,0.9)] transition-colors hover:bg-forest-soft"
              >
                Explore all {TOOLS.length} tools <ArrowRight className="h-4 w-4 text-lime" />
              </a>
              <a
                href="#/why"
                className="inline-flex h-12 items-center gap-2 rounded-xl border border-ink/15 bg-paper/70 px-5 text-[14px] font-medium transition-colors hover:border-ink/30 hover:bg-paper"
              >
                Why Paperly? <ArrowUpRight className="h-4 w-4" />
              </a>
            </div>
            <button
              type="button"
              onClick={openPalette}
              className="mt-5 inline-flex items-center gap-2 rounded-lg border border-line bg-paper/60 px-3 py-2 text-[11.5px] text-ink/70 transition-colors hover:border-forest/30 hover:text-forest"
            >
              <Search className="h-3.5 w-3.5" /> Search every tool instantly
              <kbd className="ml-1 rounded border border-line bg-bone-deep/70 px-1.5 py-0.5 font-mono text-[9.5px] text-ink/75">⌘K</kbd>
            </button>
            <ul className="mt-7 grid max-w-lg grid-cols-1 gap-2 text-[12.5px] text-ink/75 sm:grid-cols-2">
              {[
                "Free, unlimited, no watermarks",
                "Files never leave your device",
                "No sign-up or daily limits",
                "Real AES-256 protection",
              ].map((item) => (
                <li key={item} className="flex items-center gap-2">
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-forest text-lime">
                    <Check className="h-2.5 w-2.5" strokeWidth={3} />
                  </span>
                  {item}
                </li>
              ))}
            </ul>
            <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-[10.5px] font-medium uppercase tracking-[0.12em] text-ink/75">
              <span className="flex items-center gap-1.5">
                <Cpu className="h-3.5 w-3.5" /> Runs on WebAssembly
              </span>
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5" /> Web Crypto AES-256
              </span>
              <span className="flex items-center gap-1.5">
                <Zap className="h-3.5 w-3.5" /> No queue. No wait.
              </span>
            </div>
          </div>

          <div className="relative animate-rise [animation-delay:120ms]">
            <div className="absolute -left-8 -top-8 hidden h-40 w-32 rotate-[-8deg] rounded-2xl border border-forest/10 bg-lime/60 lg:block" />
            <div className="absolute -left-4 -top-4 hidden h-40 w-32 rotate-[-4deg] rounded-2xl border border-forest/10 bg-paper lg:block" />
            <HeroDrop />
          </div>
        </div>

        <div className="container-page relative pb-12">
          <div className="grid grid-cols-2 overflow-hidden rounded-2xl border border-line bg-paper/70 backdrop-blur md:grid-cols-4">
            {[
              { value: String(TOOLS.length), label: "Tools that actually work", sub: "not “coming soon”" },
              { value: "0 B", label: "Uploaded per document", sub: "processed in-tab" },
              { value: "AES-256", label: "Encryption standard", sub: "via Web Crypto" },
              { value: "∞", label: "Free conversions", sub: "no accounts, ever" },
            ].map((stat, i) => (
              <div key={stat.label} className={cn("px-5 py-4", i > 0 && "border-l border-line max-md:odd:border-l-0", i >= 2 && "max-md:border-t")}>
                <p className="text-[24px] font-semibold leading-none tracking-[-0.04em] text-forest">{stat.value}</p>
                <p className="mt-1.5 text-[11.5px] font-medium">{stat.label}</p>
                <p className="text-[10.5px] text-muted">{stat.sub}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* SHORTCUTS */}
      {shortcuts.length > 0 && (
        <section className="border-b border-line bg-paper/50 py-6">
          <div className="container-page flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink/75">
              <Sparkles className="h-3 w-3 text-forest" /> Your shortcuts
            </p>
            <div className="flex flex-wrap gap-1.5">
              {shortcuts.map((tool) => (
                <a key={tool.id} href={`#/tool/${tool.id}`} className="group flex items-center gap-2 rounded-lg border border-line bg-paper px-2.5 py-1.5 text-[11.5px] font-medium hover:border-forest/30 hover:text-forest">
                  <tool.icon className="h-3.5 w-3.5 text-forest" />
                  {tool.name}
                </a>
              ))}
              <a href="#/activity" className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11.5px] font-medium text-ink/75 hover:text-forest">
                View activity <ArrowRight className="h-3 w-3" />
              </a>
            </div>
          </div>
        </section>
      )}

      {/* WHAT'S NEW */}
      <section className="border-b border-line py-10">
        <div className="container-page">
          <div className="grid gap-3 md:grid-cols-[0.85fr_2.15fr] md:items-center">
            <div>
              <Badge tone="lime"><Sparkles className="h-3 w-3" /> New in Paperly</Badge>
              <h2 className="mt-2 text-[21px] font-semibold leading-tight tracking-[-0.03em]">A quieter, sharper PDF platform.</h2>
              <p className="mt-1 text-[11.5px] leading-relaxed text-muted">Expanded from 42 to {TOOLS.length} tools — plus full offline support, pattern-based redaction, PDF inspection, bookmark editing and table extraction. Still nothing uploaded.</p>
              <a href="#/tools?new=1" className="mt-2 inline-flex items-center gap-1 text-[11.5px] font-semibold text-forest hover:underline">
                See all {TOOLS.filter((tool) => tool.new).length} new tools <ArrowRight className="h-3 w-3" />
              </a>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { id: "ask-pdf", label: "Ask Your PDF", note: "Cited answers · fully local" },
                { id: "inspect-pdf", label: "Inspect PDF", note: "Metadata · fonts · risks" },
                { id: "find-redact", label: "Find & Redact", note: "Bulk patterns · truly gone" },
                { id: "sanitize", label: "Sanitize PDF", note: "Strip JS · XMP · embeds" },
                { id: "bookmarks", label: "Edit bookmarks", note: "Build a real outline" },
                { id: "split-bookmarks", label: "Split by bookmarks", note: "Chapters into a ZIP" },
                { id: "metadata", label: "Edit metadata", note: "Title · author · dates" },
                { id: "tables-to-csv", label: "Tables to CSV", note: "Real grids · RFC 4180" },
              ].map((item) => {
                const tool = getTool(item.id);
                if (!tool) return null;
                return (
                  <a key={item.id} href={`#/tool/${item.id}`} className="group flex flex-col rounded-xl border border-line bg-paper p-3 transition-all hover:-translate-y-0.5 hover:border-forest/30 hover:shadow-soft">
                    <div className="flex items-center justify-between">
                      <tool.icon className="h-4 w-4 text-forest" />
                      <span className="rounded-full bg-lime/50 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.07em] text-forest">New</span>
                    </div>
                    <p className="mt-2 text-[12px] font-semibold leading-tight group-hover:text-forest">{item.label}</p>
                    <p className="mt-0.5 text-[10.5px] leading-snug text-muted">{item.note}</p>
                  </a>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* TOOLS */}
      <section id="tools" className="border-b border-line py-16 md:py-20">
        <div className="container-page">
          <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
            <div>
              <Badge tone="forest">
                <span className="h-1.5 w-1.5 rounded-full bg-forest" /> The toolbox
              </Badge>
              <h2 className="mt-3 max-w-[20ch] text-[34px] font-semibold leading-[1.02] tracking-[-0.04em] sm:text-[42px]">
                Everything, <span className="font-serif font-normal italic text-forest">no asterisks.</span>
              </h2>
              <p className="mt-2.5 max-w-[52ch] text-[14px] leading-relaxed text-muted">
                Every tool below is built, working and free. Pick one — your file is read directly from your device and the result is handed
                straight back.
              </p>
            </div>
            <a href="#/tools" className="inline-flex shrink-0 items-center gap-1.5 text-[13px] font-semibold text-forest hover:underline">
              View the full catalog <ArrowRight className="h-4 w-4" />
            </a>
          </div>

          <div className="mt-7 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setCategory("all")}
                className={cn(
                  "rounded-full border px-3.5 py-1.5 text-[12px] font-medium transition-colors",
                  category === "all" ? "border-forest bg-forest text-paper" : "border-line bg-paper text-ink/70 hover:border-forest/30",
                )}
              >
                All tools <span className="ml-1 text-paper/75">{TOOLS.length}</span>
              </button>
              {(Object.keys(CATEGORIES) as ToolCategory[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setCategory(key)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[12px] font-medium transition-colors",
                    category === key ? "border-forest bg-forest text-paper" : "border-line bg-paper text-ink/70 hover:border-forest/30",
                  )}
                >
                  <span className={cn("h-1.5 w-1.5 rounded-full", category === key ? "bg-lime" : CATEGORIES[key].dot)} />
                  {CATEGORIES[key].name}
                  <span className="text-ink/75">{TOOLS.filter((t) => t.category === key).length}</span>
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
                className="h-10 w-full rounded-xl border border-line bg-paper pl-9 pr-3 text-[13px] placeholder:text-ink/75 focus:border-forest/40 focus:outline-none focus:ring-2 focus:ring-forest/10"
              />
            </label>
          </div>

          {filtered.length ? (
            <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filtered.map((tool) => (
                <ToolCard key={tool.id} tool={tool} showCategory />
              ))}
            </div>
          ) : (
            <div className="mt-6 rounded-2xl border border-dashed border-line bg-paper p-10 text-center">
              <p className="text-[14px] font-medium">No tools match “{query}”.</p>
              <button type="button" onClick={() => { setQuery(""); setCategory("all"); }} className="mt-2 text-[12px] font-semibold text-forest hover:underline">
                Clear search and filters
              </button>
            </div>
          )}
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="border-b border-line py-16 md:py-20">
        <div className="container-page">
          <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
            <div>
              <Badge tone="clay">How it works</Badge>
              <h2 className="mt-3 text-[32px] font-semibold leading-[1.04] tracking-[-0.04em] sm:text-[38px]">
                Your file never
                <br />
                <span className="font-serif font-normal italic text-clay-ink">goes anywhere.</span>
              </h2>
              <p className="mt-3 max-w-[40ch] text-[14px] leading-relaxed text-muted">
                Most “free” PDF sites upload your document first. Paperly flips that: the tools download to your browser, and your files stay
                where they belong.
              </p>
              <a href="#/privacy" className="mt-5 inline-flex items-center gap-1.5 text-[13px] font-semibold text-forest hover:underline">
                Read the privacy promise <ArrowRight className="h-4 w-4" />
              </a>
            </div>
            <ol className="relative space-y-0">
              {[
                {
                  title: "Drop your file",
                  body: "Choose a document from your device. It’s read into memory with the browser’s own file API — no upload request is made.",
                },
                {
                  title: "Work locally",
                  body: "PDF.js renders pages, pdf-lib rewrites documents, and Web Crypto encrypts passwords. All inside this tab, on your hardware.",
                },
                {
                  title: "Take it with you",
                  body: "Download the result directly from memory. Close the tab and nothing remains: no copy, no cache, no retention policy.",
                },
              ].map((step, i) => (
                <li key={step.title} className="relative flex gap-4 pb-8 last:pb-0">
                  {i < 2 && <span className="absolute left-[19px] top-10 h-[calc(100%-2.5rem)] w-px bg-line" />}
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-forest/15 bg-lime/30 text-[13px] font-bold text-forest">
                    {i + 1}
                  </span>
                  <div className="pt-1">
                    <h3 className="text-[15px] font-semibold tracking-[-0.01em]">{step.title}</h3>
                    <p className="mt-1 max-w-[46ch] text-[12.5px] leading-relaxed text-muted">{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* PRIVACY */}
      <section className="bg-ink py-16 text-paper md:py-20">
        <div className="container-page">
          <div className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center lg:gap-16">
            <div>
              <Badge className="border-lime/20 bg-lime/10 text-lime">
                <ShieldCheck className="h-3 w-3" /> Privacy by architecture
              </Badge>
              <h2 className="mt-4 text-[34px] font-semibold leading-[1.02] tracking-[-0.04em] sm:text-[44px]">
                Your document is
                <br />
                <span className="font-serif font-normal italic text-lime">none of our business.</span>
              </h2>
              <p className="mt-4 max-w-[52ch] text-[14px] leading-relaxed text-paper/70">
                Privacy usually means “we promise to delete it”. We chose a stronger option: we never have it. There is no upload endpoint, no
                processing queue and no cloud bucket. That isn’t a policy — it’s the architecture.
              </p>
              <div className="mt-6 grid gap-2.5 sm:grid-cols-2">
                {[
                  { title: "No uploads", body: "Files are read via local file APIs." },
                  { title: "No accounts", body: "Nothing to sign up for or forget." },
                  { title: "No trackers", body: "No analytics or advertising pixels." },
                  { title: "No dark patterns", body: "Every tool is free and complete." },
                ].map((item) => (
                  <div key={item.title} className="flex items-start gap-2.5 rounded-xl border border-paper/10 bg-paper/[0.04] p-3">
                    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-lime text-forest">
                      <Check className="h-2.5 w-2.5" strokeWidth={3} />
                    </span>
                    <div>
                      <p className="text-[12px] font-semibold">{item.title}</p>
                      <p className="text-[11px] text-paper/75">{item.body}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="grain rounded-2xl border border-paper/10 bg-paper/[0.045] p-5 backdrop-blur">
              <div className="flex items-center justify-between border-b border-paper/10 pb-3">
                <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-paper/70">
                  <span className="h-1.5 w-1.5 rounded-full bg-lime" /> Local processing report
                </p>
                <span className="rounded-full border border-lime/20 bg-lime/10 px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.08em] text-lime">
                  Live
                </span>
              </div>
              <div className="py-5">
                <p className="text-[11px] text-paper/75">Document data sent to a server</p>
                <p className="mt-1 text-[48px] font-semibold leading-none tracking-[-0.05em] text-lime">0 B</p>
                <p className="mt-2 text-[11.5px] text-paper/75">…because there is no server step.</p>
              </div>
              <div className="space-y-2">
                {[
                  { label: "File read", value: "Local memory" },
                  { label: "Processing", value: "This browser" },
                  { label: "Encryption", value: "Web Crypto API" },
                  { label: "Output", value: "Direct download" },
                  { label: "Retention", value: "Nothing stored" },
                ].map((row) => (
                  <div key={row.label} className="flex items-center justify-between rounded-lg border border-paper/8 bg-ink/30 px-3 py-2">
                    <span className="text-[11.5px] text-paper/70">{row.label}</span>
                    <span className="flex items-center gap-1.5 text-[11.5px] font-medium">
                      <Check className="h-3 w-3 text-lime" /> {row.value}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-4 flex items-center gap-1.5 text-[10px] text-paper/75">
                <FileCheck2 className="h-3 w-3" /> No network request is made with your document contents.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* COMPARISON */}
      <section className="border-b border-line py-16 md:py-20">
        <div className="container-page">
          <div className="mx-auto max-w-2xl text-center">
            <Badge tone="forest">A better default</Badge>
            <h2 className="mt-3 text-[32px] font-semibold leading-[1.04] tracking-[-0.04em] sm:text-[40px]">
              All the utility. <span className="font-serif font-normal italic text-forest">Less of the trade-off.</span>
            </h2>
            <p className="mt-3 text-[14px] leading-relaxed text-muted">
              No daily caps, no sign-up wall, no watermarks, no “upgrade to download”. Just the tools, doing the work.
            </p>
          </div>
          <div className="mx-auto mt-8 max-w-3xl overflow-hidden rounded-2xl border border-line bg-paper">
            <div className="grid grid-cols-[1.5fr_1fr_1fr] border-b border-line bg-bone-deep/40 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/75 sm:px-6">
              <span>What you get</span>
              <span className="text-center text-forest">Paperly</span>
              <span className="text-center">Typical cloud tool</span>
            </div>
            {[
              ["Files sent to a server", false, true],
              ["Sign-up required", false, true],
              ["Daily task limits", false, true],
              ["Watermark on free output", false, true],
              ["AES-256 password protection", true, "Paid"],
              ["Works offline after loading", true, false],
              ["Files retained after closing", false, "Often"],
            ].map(([label, paperly, cloud], i) => (
              <div key={String(label)} className={cn("grid grid-cols-[1.5fr_1fr_1fr] items-center px-4 py-3 text-[12.5px] sm:px-6", i > 0 && "border-t border-line")}>
                <span className="font-medium text-ink/75">{label}</span>
                <span className="flex justify-center">
                  {paperly === true ? (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-forest text-lime">
                      <Check className="h-3 w-3" strokeWidth={3} />
                    </span>
                  ) : (
                    <span className="text-[11px] font-semibold text-ink/75">—</span>
                  )}
                </span>
                <span className="flex justify-center text-[11px] font-medium text-ink/75">
                  {cloud === true ? <X className="h-4 w-4 text-clay-ink/60" /> : typeof cloud === "string" ? cloud : "No"}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-center text-[10.5px] text-ink/75">
            Comparison reflects common free tiers of popular online PDF services at the time of writing.
          </p>
        </div>
      </section>

      {/* COMPARISON */}
      <section className="border-b border-line bg-paper/60 py-12">
        <div className="container-page">
          <div className="overflow-hidden rounded-2xl border border-line bg-paper">
            <div className="grid gap-6 p-5 md:grid-cols-[1.25fr_0.75fr] md:items-center md:p-7">
              <div>
                <Badge tone="forest"><ShieldCheck className="h-3 w-3" /> Honest comparison</Badge>
                <h2 className="mt-3 max-w-[26ch] text-[26px] font-semibold leading-[1.06] tracking-[-0.035em] sm:text-[32px]">
                  Paperly vs iLovePDF: <span className="font-serif font-normal italic text-forest">the real difference.</span>
                </h2>
                <p className="mt-2 max-w-[62ch] text-[12.5px] leading-relaxed text-muted">
                  iLovePDF is mature and genuinely good. But it processes your document on its servers, caps free files at 15–400 MB and gates batch,
                  desktop and PDF/A behind Premium. Paperly processes locally, with no file caps and no account. We published the full comparison —
                  including the places where they are stronger.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <a href="#/vs-ilovepdf" className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink px-4 text-[12.5px] font-semibold text-paper hover:bg-forest-soft">
                    Read the comparison <ArrowRight className="h-3.5 w-3.5 text-lime" />
                  </a>
                  <a href="#/tools" className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-line px-4 text-[12.5px] font-medium hover:border-forest/30 hover:text-forest">
                    Open the toolbox
                  </a>
                </div>
              </div>
              <div className="space-y-2">
                {[
                  { feature: "Document upload", paperly: "Never", other: "Always" },
                  { feature: "Free file cap", paperly: "None", other: "15–400 MB" },
                  { feature: "Batch processing", paperly: "Unlimited", other: "Limited" },
                  { feature: "Price", paperly: "$0", other: "Up to $9/mo" },
                ].map((row) => (
                  <div key={row.feature} className="rounded-xl border border-line bg-bone/50 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink/75">{row.feature}</span>
                      <span className="text-[9.5px] font-bold uppercase tracking-[0.06em] text-ink/70">Paperly / iLovePDF</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-3 text-[12px]">
                      <span className="flex items-center gap-1 font-semibold text-forest"><Check className="h-3 w-3" /> {row.paperly}</span>
                      <span className="text-ink/75">{row.other}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* GUIDES */}
      <section className="border-b border-line py-16 md:py-20">
        <div className="container-page">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <Badge tone="forest"><BookOpen className="h-3 w-3" /> Guides</Badge>
              <h2 className="mt-2 max-w-[24ch] text-[28px] font-semibold leading-[1.05] tracking-[-0.035em] sm:text-[36px]">
                Get the result right <span className="font-serif font-normal italic text-forest">the first time.</span>
              </h2>
              <p className="mt-2 max-w-[54ch] text-[13px] leading-relaxed text-muted">Short, practical walkthroughs — including the limitations no one else prints.</p>
            </div>
            <a href="#/guides" className="inline-flex shrink-0 items-center gap-1.5 text-[12.5px] font-semibold text-forest hover:underline">
              All guides <ArrowRight className="h-3.5 w-3.5" />
            </a>
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {GUIDE_TEASERS.map((guide) => (
              <a key={guide.slug} href={`#/guides?g=${guide.slug}`} className="group rounded-xl border border-line bg-paper p-4 transition-colors hover:border-forest/30">
                <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.08em] text-forest/90">
                  {guide.category} <span className="text-ink/70">{guide.minutes} min</span>
                </div>
                <p className="mt-2 text-[13px] font-semibold leading-snug group-hover:text-forest">{guide.title}</p>
                <span className="mt-2 flex items-center gap-1 text-[11px] font-medium text-forest">Read <ArrowRight className="h-3 w-3" /></span>
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-16 md:py-20">
        <div className="container-page grid gap-10 lg:grid-cols-[0.7fr_1.3fr] lg:gap-16">
          <div>
            <Badge tone="clay">Questions</Badge>
            <h2 className="mt-3 text-[32px] font-semibold leading-[1.04] tracking-[-0.04em] sm:text-[38px]">
              The honest <span className="font-serif font-normal italic text-clay-ink">answers.</span>
            </h2>
            <p className="mt-3 max-w-[38ch] text-[13.5px] leading-relaxed text-muted">
              Including the bits other PDF sites leave out. If something isn’t clear, the Help page goes deeper.
            </p>
            <a href="#/help" className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-semibold text-forest hover:underline">
              Visit Help & FAQ <ArrowRight className="h-4 w-4" />
            </a>
          </div>
          <Accordion defaultOpen={0}>
            <AccordionItem index={0} question="Are my files really never uploaded?">
              Yes. Paperly uses the browser’s File API, PDF.js and pdf-lib to read and rewrite documents in your tab. There is no upload endpoint in
              this application. You can open your browser’s Network panel and watch it for yourself.
            </AccordionItem>
            <AccordionItem index={1} question="Is it actually free? What’s the catch?">
              Everything is free and unlimited. There’s no catch, account or paywall because there are no server processing costs — your own
              device does the work. We’d rather earn trust than rent it back to you.
            </AccordionItem>
            <AccordionItem index={2} question="How accurate are the conversions?">
              Native PDF tools (merge, split, organize, rotate, crop, page numbers, watermark, password) preserve the original document exactly.
              Image conversions are high-resolution renders. Word and Excel conversions are text-first, while PDF-to-PowerPoint and PowerPoint-to-PDF
              are respectively image-perfect and text-faithful. Each tool states its limits upfront.
            </AccordionItem>
            <AccordionItem index={3} question="Can I edit text that’s already in the PDF?">
              Paperly’s editor adds new content — text boxes, shapes, highlights, images and signatures — as a flattened layer. Reflowing existing
              text is not something browser-only tools can do reliably, so we don’t pretend otherwise. Use whiteout shapes to cover content you
              need to remove from view.
            </AccordionItem>
            <AccordionItem index={4} question="Does the password protection really encrypt the file?">
              Yes. Protect PDF uses AES-256 encryption through the Web Crypto API and verifies that the resulting file requires your password. Your
              password never leaves the tab. There is no password recovery, so store it somewhere safe.
            </AccordionItem>
            <AccordionItem index={5} question="What about big or scanned files?">
              Processing happens in memory, so very large files are limited by your device. Scanned PDFs have no text layer to extract or convert; 
              image-based tools such as Compress, PDF to JPG and PDF to PowerPoint still work well.
            </AccordionItem>
          </Accordion>
        </div>
      </section>

      {/* CTA */}
      <section className="pb-16 md:pb-20">
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
                <a href="#/tool/merge" className="inline-flex h-11 items-center gap-2 rounded-xl bg-lime px-5 text-[13.5px] font-semibold text-ink transition-colors hover:bg-[#e4f88f]">
                  Merge a PDF <ArrowRight className="h-4 w-4" />
                </a>
                <a href="#/tools" className="inline-flex h-11 items-center gap-2 rounded-xl border border-paper/20 px-5 text-[13.5px] font-medium text-paper transition-colors hover:bg-paper/10">
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
