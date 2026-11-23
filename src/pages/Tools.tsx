import { ArrowRight, Check, Search, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { TOOLS } from "@/lib/toolRegistry";
import { TOOL_GROUPS, searchScore, toolGroup, type ToolGroupId } from "@/lib/groups";
import { Badge, Button } from "@/components/ui";
import { ToolCard } from "@/components/ToolCard";
import { cn } from "@/utils/cn";
import { toolPath } from "@/lib/slugs";

export default function Tools({ initialCategory = "all", initialNew = false }: { initialCategory?: ToolGroupId | "all"; initialNew?: boolean }) {
  const [category, setCategory] = useState<ToolGroupId | "all">(initialCategory);
  const [query, setQuery] = useState("");
  const [showNew, setShowNew] = useState(initialNew);

  useEffect(() => { setCategory(initialCategory); }, [initialCategory]);
  useEffect(() => { setShowNew(initialNew); }, [initialNew]);

  const q = query.trim().toLowerCase();
  const filtered = TOOLS.filter(
    (tool) =>
      (category === "all" || toolGroup(tool.id) === category) &&
      (!showNew || tool.new) &&
      (!q || searchScore(q, tool) > 0),
  );

  const activeGroups = TOOL_GROUPS.filter((group) => category === "all" || category === group.id);

  return (
    <div>
      <section className="relative overflow-hidden border-b border-line">
        <div className="hero-glow pointer-events-none absolute inset-0" />
        <div className="container-page relative pb-10 pt-12 md:pb-12 md:pt-16">
          <Badge tone="forest">
            <Sparkles className="h-3 w-3" /> {TOOLS.length} tools · all local
          </Badge>
          <h1 className="fluid-hero mt-3 max-w-[18ch] font-semibold">
            The complete <span className="font-serif font-normal italic text-forest">PDF toolkit.</span>
          </h1>
          <p className="mt-3 max-w-[52ch] text-[14px] leading-relaxed text-ink/70">
            Organize, optimize, convert, edit and secure. Every tool does real work on your device, returns a clean file and asks for nothing in
            return.
          </p>
        </div>
      </section>

      <section className="sticky top-[72px] z-30 border-b border-line bg-bone/90 py-2.5 backdrop-blur-xl sm:top-[100px]">
        <div className="container-page flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="scrollbar-none -mx-1 flex gap-2 overflow-x-auto px-1 pb-1 sm:flex-wrap">
            <FilterPill active={category === "all" && !showNew} onClick={() => { setCategory("all"); setShowNew(false); }} label="All" count={TOOLS.length} />
            <FilterPill active={showNew} onClick={() => { setShowNew(!showNew); setCategory("all"); }} label="New" count={TOOLS.filter((t) => t.new).length} dot="bg-clay" />
            {TOOL_GROUPS.map((group) => (
              <FilterPill
                key={group.id}
                active={category === group.id}
                onClick={() => setCategory(group.id)}
                label={group.label}
                count={group.ids.length}
                dot={group.dot}
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
              className="h-12 w-full rounded-xl border border-line bg-paper pl-9 pr-3 text-[16px] placeholder:text-ink/75 sm:h-10 sm:text-[13px] focus:border-forest/40 focus:outline-none focus:ring-2 focus:ring-forest/10"
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
          {activeGroups.map((group) => {
            const tools = filtered.filter((t) => toolGroup(t.id) === group.id);
            if (!tools.length) return null;
            return (
              <div key={group.id} id={group.id}>
                <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className={cn("h-2 w-2 rounded-full", group.dot)} />
                      <h2 className="text-[22px] font-semibold tracking-[-0.025em]">{group.label}</h2>
                      <span className="rounded-full bg-ink/5 px-2 py-0.5 text-[10.5px] font-semibold tabular-nums text-ink/75">{tools.length}</span>
                    </div>
                    <p className="mt-1 text-[12.5px] text-muted">{group.blurb}</p>
                  </div>
                  <span className="text-[11px] font-medium text-ink/75">All processing stays in your browser</span>
                </div>
                <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
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
                  <a key={id} href={toolPath(id)} className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-lime px-3.5 text-[12.5px] font-semibold text-ink hover:bg-[#e4f88f]">
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
      data-filter-pill
      onClick={onClick}
      className={cn(
        "flex min-h-12 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[12px] font-medium transition-colors sm:min-h-0 sm:py-1.5",
        active ? "border-forest bg-forest text-paper" : "border-line bg-paper text-ink/70 hover:border-forest/30",
      )}
    >
      {dot && <span className={cn("h-1.5 w-1.5 rounded-full", active ? "bg-lime" : dot)} />}
      {label}
      <span className={cn("tabular-nums", active ? "text-paper/80" : "text-ink/75")}>{count}</span>
    </button>
  );
}
