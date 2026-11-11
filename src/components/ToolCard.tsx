import { ArrowUpRight } from "lucide-react";
import { cn } from "@/utils/cn";
import { CATEGORIES, type Tool } from "@/lib/toolRegistry";
import { ToolTile } from "@/components/ui";

export function ToolCard({ tool, showCategory = false, className }: { tool: Tool; showCategory?: boolean; className?: string }) {
  const cat = CATEGORIES[tool.category];
  return (
    <a
      href={`#/tool/${tool.id}`}
      className={cn(
        "group relative flex flex-col rounded-2xl border border-line bg-paper p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-forest/25 hover:shadow-soft",
        className,
      )}
    >
      <div className="flex items-start justify-between">
        <ToolTile tool={tool} />
        <div className="flex items-center gap-1.5">
          {tool.new && <span className="rounded-full bg-lime/60 px-2 py-1 text-[8.5px] font-bold uppercase tracking-[0.08em] text-forest">New</span>}
          <ArrowUpRight className="h-4 w-4 text-ink/20 transition-all duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-forest" />
        </div>
      </div>
      <h3 className="mt-3.5 text-[14.5px] font-semibold leading-tight tracking-[-0.015em]">{tool.name}</h3>
      <p className="mt-1.5 text-[12px] leading-relaxed text-muted">{tool.tagline}</p>
      <div className="mt-auto flex items-center gap-1.5 pt-4">
        <span className={cn("h-1.5 w-1.5 rounded-full", cat.dot)} />
        <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-ink/75">
          {showCategory ? cat.name : "Free · local"}
        </span>
      </div>
    </a>
  );
}
