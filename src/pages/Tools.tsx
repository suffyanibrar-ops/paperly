import { ArrowRight, Check, Cpu, Search, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { CATEGORIES, TOOLS, type ToolCategory } from "@/lib/toolRegistry";
import { Badge, Button } from "@/components/ui";
import { ToolCard } from "@/components/ToolCard";
import { cn } from "@/utils/cn";

export default function Tools({ initialCategory = "all", initialNew = false }: { initialCategory?: ToolCategory | "all"; initialNew?: boolean }) {
  const [category, setCategory] = useState<ToolCategory | "all">(initialCategory);
  const [query, setQuery] = useState("");
  const [showNew, setShowNew] = useState(initialNew);

  useEffect(() => { setCategory(initialCategory); }, [initialCategory]);
  useEffect(() => { setShowNew(initialNew); }, [initialNew]);

  const q = query.trim().toLowerCase();
  const filtered = TOOLS.filter(
    (tool) =>
      (category === "all" || tool.category === category) &&
      (!showNew || tool.new) &&
      (!q || tool.name.toLowerCase().includes(q) || tool.tagline.toLowerCase().includes(q) || CATEGORIES[tool.category].name.toLowerCase().includes(q)),
  );

  const activeCategories = (Object.keys(CATEGORIES) as ToolCategory[]).filter((key) => category === "all" || category === key);

  return (
    <div>
      <section className="relative overflow-hidden border-b border-line">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_90%_at_90%_0%,#eef8d3_0%,transparent_65%)]" />
        <div className="container-page relative pb-10 pt-12 md:pb-12 md:pt-16">
          <Badge tone="forest">
            <Sparkles className="h-3 w-3" /> {TOOLS.length} tools · all local
          </Badge>
          <h1 className="mt-4 max-w-[18ch] text-[40px] font-semibold leading-[0.98] tracking-[-0.045em] sm:text-[54px]">
            The complete <span className="font-serif font-normal italic text-forest">PDF toolkit.</span>
          </h1>
          <p className="mt-4 max-w-[58ch] text-[14.5px] leading-relaxed text-ink/70 sm:text-[15.5px]">
            Organize, optimize, convert, edit and secure. Every tool does real work on your device, returns a clean file and asks for nothing in
            return.
          </p>
          <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-[11.5px] font-medium text-ink/70">
            <span className="flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5 text-forest" /> Files never uploaded</span>
            <span className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-forest" /> No account or daily limit</span>
            <span className="flex items-center gap-1.5"><Zap className="h-3.5 w-3.5 text-forest" /> Instant local processing</span>
            <span className="flex items-center gap-1.5"><Cpu className="h-3.5 w-3.5 text-forest" /> No watermarks</span>
            <span className="flex items-center gap-1.5 text-forest"><Sparkles className="h-3.5 w-3.5" /> {TOOLS.filter((t) => t.new).length} new tools</span>
          </div>
        </div>
      </section>

      <section className="sticky top-[100px] z-30 border-b border-line bg-bone/90 py-3 backdrop-blur-xl">
        <div className="container-page flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-1 overflow-x-auto pb-1 scrollbar-thin sm:pb-0">
            <FilterPill active={category === "all" && !showNew} onClick={() => { setCategory("all"); setShowNew(false); }} label="All" count={TOOLS.length} />
            <FilterPill active={showNew} onClick={() => { setShowNew(!showNew); setCategory("all"); }} label="New" count={TOOLS.filter((t) => t.new).length} dot="bg-clay" />
            {(Object.keys(CATEGORIES) as ToolCategory[]).map((key) => (
              <FilterPill
                key={key}
                active={category === key}
                onClick={() => setCategory(key)}
                label={CATEGORIES[key].name}
                count={TOOLS.filter((t) => t.category === key).length}
                dot={CATEGORIES[key].dot}
              />
            ))}
          </div>
          <label className="relative block w-full sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/75" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tools…"
              aria-label="Search tools"
              className="h-10 w-full rounded-xl border border-line bg-paper pl-9 pr-3 text-[13px] placeholder:text-ink/75 focus:border-forest/40 focus:outline-none focus:ring-2 focus:ring-forest/10"
            />
          </label>
        </div>
      </section>

      <section className="pb-16 pt-10">
        <div className="container-page space-y-12">
          {showNew && filtered.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-forest/15 bg-lime/20 px-4 py-3">
              <Sparkles className="h-4 w-4 text-forest" />
              <p className="text-[12.5px] font-medium text-forest">
                {filtered.length} tools added in the latest release — OCR, redaction, comparison, forms, imposition and more.
              </p>
              <button type="button" onClick={() => setShowNew(false)} className="ml-auto text-[11.5px] font-semibold text-forest underline underline-offset-2">
                Show everything
              </button>
            </div>
          )}
          {activeCategories.map((key) => {
            const tools = filtered.filter((t) => t.category === key);
            if (!tools.length) return null;
            return (
              <div key={key} id={key}>
                <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className={cn("h-2 w-2 rounded-full", CATEGORIES[key].dot)} />
                      <h2 className="text-[22px] font-semibold tracking-[-0.025em]">{CATEGORIES[key].name}</h2>
                      <span className="rounded-full bg-ink/5 px-2 py-0.5 text-[10.5px] font-semibold tabular-nums text-ink/75">{tools.length}</span>
                    </div>
                    <p className="mt-1 text-[12.5px] text-muted">{CATEGORIES[key].blurb}</p>
                  </div>
                  <span className="text-[11px] font-medium text-ink/75">All processing stays in your browser</span>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {tools.map((tool) => (
                    <ToolCard key={tool.id} tool={tool} />
                  ))}
                </div>
              </div>
            );
          })}

          {!filtered.length && (
            <div className="rounded-2xl border border-dashed border-line bg-paper p-12 text-center">
              <p className="text-[15px] font-medium">No tool matches “{query}”.</p>
              <p className="mt-1 text-[12.5px] text-muted">Try “merge”, “word”, “compress” or “protect”.</p>
              <Button variant="outline" className="mt-4" onClick={() => { setQuery(""); setCategory("all"); }}>
                Show all {TOOLS.length} tools
              </Button>
            </div>
          )}

          <div className="grid gap-3 rounded-2xl border border-line bg-paper p-5 sm:grid-cols-3">
            {[
              { title: "One job, one tool", body: "No hidden sub-menus or surprise paywalls halfway through." },
              { title: "Honest output", body: "We tell you when a file is already optimized or a scan has no text." },
              { title: "Nothing installed", body: "Works on desktop and mobile in a modern browser." },
            ].map((item) => (
              <div key={item.title} className="flex gap-2.5">
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-lime text-forest">
                  <Check className="h-2.5 w-2.5" strokeWidth={3} />
                </span>
                <div>
                  <p className="text-[12.5px] font-semibold">{item.title}</p>
                  <p className="text-[11.5px] leading-relaxed text-muted">{item.body}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-col items-start justify-between gap-4 rounded-2xl bg-forest px-6 py-7 text-paper sm:flex-row sm:items-center">
            <div>
              <h2 className="text-[21px] font-semibold tracking-[-0.02em]">Not sure which tool you need?</h2>
              <p className="mt-1 text-[12.5px] text-paper/70">Start with the most popular three. They solve most PDF problems.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {["merge", "compress", "edit"].map((id) => {
                const tool = TOOLS.find((t) => t.id === id)!;
                return (
                  <a key={id} href={`#/tool/${id}`} className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-lime px-3.5 text-[12.5px] font-semibold text-ink hover:bg-[#e4f88f]">
                    {tool.name} <ArrowRight className="h-3.5 w-3.5" />
                  </a>
                );
              })}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function FilterPill({ active, onClick, label, count, dot }: { active: boolean; onClick: () => void; label: string; count: number; dot?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[12px] font-medium transition-colors",
        active ? "border-forest bg-forest text-paper" : "border-line bg-paper text-ink/70 hover:border-forest/30",
      )}
    >
      {dot && <span className={cn("h-1.5 w-1.5 rounded-full", active ? "bg-lime" : dot)} />}
      {label}
      <span className="text-ink/75">{count}</span>
    </button>
  );
}
