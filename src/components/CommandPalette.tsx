import { ArrowRight, Clock3, Command, CornerDownLeft, Search, Star, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CATEGORIES, POPULAR_IDS, TOOLS, getTool, type Tool } from "@/lib/toolRegistry";
import { readableRecent, useActivity, useFavorites, type ActivityEntry } from "@/lib/activity";
import { ToolTile } from "@/components/ui";
import { cn } from "@/utils/cn";

const PAGES = [
  { label: "All tools", href: "#/tools", keywords: "catalog index apps" },
  { label: "Why Paperly", href: "#/why", keywords: "about privacy local" },
  { label: "Pricing", href: "#/pricing", keywords: "free plan cost" },
  { label: "Privacy promise", href: "#/privacy", keywords: "security data" },
  { label: "Help & FAQ", href: "#/help", keywords: "support questions" },
  { label: "Guides", href: "#/guides", keywords: "tutorials walkthrough how to" },
  { label: "Activity", href: "#/activity", keywords: "history recent downloads" },
  { label: "About", href: "#/about", keywords: "company mission" },
  { label: "Contact", href: "#/contact", keywords: "email support feedback" },
  { label: "Sitemap", href: "#/sitemap", keywords: "all pages" },
  { label: "Terms", href: "#/terms", keywords: "legal" },
];

type Entry =
  | { kind: "tool"; tool: Tool; group: string }
  | { kind: "page"; label: string; href: string; group: string };

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { favorites } = useFavorites();
  const activity = useActivity();

  const entries = useMemo<Entry[]>(() => {
    const q = query.trim().toLowerCase();
    const matchTool = (tool: Tool) =>
      !q ||
      tool.name.toLowerCase().includes(q) ||
      tool.tagline.toLowerCase().includes(q) ||
      tool.id.includes(q) ||
      CATEGORIES[tool.category].name.toLowerCase().includes(q);

    const groups: Entry[] = [];
    if (!q) {
      readableRecent(activity, 3).forEach((tool) => groups.push({ kind: "tool", tool, group: "Recent" }));
      favorites
        .map((id) => getTool(id))
        .filter((t): t is Tool => Boolean(t))
        .forEach((tool) => groups.push({ kind: "tool", tool, group: "Pinned" }));
      POPULAR_IDS.map((id) => getTool(id))
        .filter((t): t is Tool => Boolean(t))
        .forEach((tool) => groups.push({ kind: "tool", tool, group: "Popular" }));
    } else {
      TOOLS.filter(matchTool).forEach((tool) => groups.push({ kind: "tool", tool, group: "Tools" }));
    }
    const pages = PAGES.filter(
      (page) => !q || page.label.toLowerCase().includes(q) || page.keywords.includes(q),
    );
    pages.forEach((page) => groups.push({ kind: "page", label: page.label, href: page.href, group: "Pages" }));

    // de-duplicate by href, keeping the first group a tool appears in
    const seen = new Set<string>();
    return groups.filter((entry) => {
      const key = entry.kind === "tool" ? `tool:${entry.tool.id}` : entry.href;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [query, favorites, activity]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActive(0);
      return;
    }
    const timer = setTimeout(() => inputRef.current?.focus(), 40);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((index) => Math.min(entries.length - 1, index + 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((index) => Math.max(0, index - 1));
      } else if (event.key === "Enter") {
        const entry = entries[active];
        if (!entry) return;
        event.preventDefault();
        if (entry.kind === "tool") window.location.hash = `/tool/${entry.tool.id}`;
        else window.location.hash = entry.href.replace(/^#/, "");
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, entries, active, onClose]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  let lastGroup = "";

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-ink/55 px-4 pt-[10vh] backdrop-blur-sm" onMouseDown={onClose} role="dialog" aria-modal="true" aria-label="Command palette">
      <div
        className="w-full max-w-xl animate-pop overflow-hidden rounded-2xl border border-line bg-paper shadow-lift"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Search className="h-4 w-4 shrink-0 text-ink/75" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tools and pages…"
            aria-label="Search tools and pages"
            className="h-14 w-full bg-transparent text-[14px] text-ink placeholder:text-ink/75 focus:outline-none"
          />
          <button type="button" onClick={onClose} aria-label="Close search" className="rounded-lg p-1.5 text-ink/75 hover:bg-ink/5 hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div ref={listRef} className="max-h-[min(60vh,430px)] overflow-y-auto p-2 scrollbar-thin">
          {entries.length === 0 && (
            <div className="px-4 py-10 text-center">
              <p className="text-[13px] font-medium">No results for “{query}”.</p>
              <p className="mt-1 text-[11.5px] text-muted">Try “merge”, “ocr”, “password” or “markdown”.</p>
            </div>
          )}
          {entries.map((entry, index) => {
            const showGroup = entry.group !== lastGroup;
            lastGroup = entry.group;
            const isActive = index === active;
            const href = entry.kind === "tool" ? `#/tool/${entry.tool.id}` : entry.href;
            return (
              <div key={`${entry.kind}-${href}`}>
                {showGroup && (
                  <p className={cn("px-2 pb-1 text-[9.5px] font-bold uppercase tracking-[0.12em] text-ink/75", index === 0 ? "pt-1" : "pt-3")}>
                    {entry.group === "Recent" && <Clock3 className="mr-1 inline h-2.5 w-2.5" />}
                    {entry.group === "Pinned" && <Star className="mr-1 inline h-2.5 w-2.5" />}
                    {entry.group}
                  </p>
                )}
                <a
                  href={href}
                  data-index={index}
                  onMouseEnter={() => setActive(index)}
                  onClick={onClose}
                  className={cn(
                    "flex items-center gap-3 rounded-xl px-2 py-2 transition-colors",
                    isActive ? "bg-forest text-paper" : "hover:bg-bone-deep/50",
                  )}
                >
                  {entry.kind === "tool" ? (
                    <>
                      <ToolTile tool={entry.tool} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] font-medium">{entry.tool.name}</span>
                        <span className={cn("block truncate text-[10.5px]", isActive ? "text-paper/75" : "text-muted")}>{entry.tool.tagline}</span>
                      </span>
                      <span className={cn("hidden text-[9.5px] font-semibold uppercase tracking-[0.06em] sm:block", isActive ? "text-lime" : "text-ink/70")}>
                        {CATEGORIES[entry.tool.category].name}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className={cn("flex h-9 w-9 items-center justify-center rounded-lg", isActive ? "bg-paper/10 text-lime" : "bg-bone-deep text-forest")}>
                        <ArrowRight className="h-4 w-4" />
                      </span>
                      <span className="flex-1 text-[12.5px] font-medium">{entry.label}</span>
                      <span className={cn("text-[10px]", isActive ? "text-paper/75" : "text-ink/70")}>Page</span>
                    </>
                  )}
                </a>
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-bone-deep/35 px-4 py-2.5 text-[10.5px] text-ink/75">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-line bg-paper px-1 py-0.5 font-mono text-[9px]">↑</kbd>
            <kbd className="rounded border border-line bg-paper px-1 py-0.5 font-mono text-[9px]">↓</kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <CornerDownLeft className="h-3 w-3" /> open
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-line bg-paper px-1 py-0.5 font-mono text-[9px]">esc</kbd> close
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Command className="h-3 w-3" /> K
          </span>
        </div>
      </div>
    </div>
  );
}

export function useCommandPalette() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return { open, setOpen };
}

/* Re-export the activity type so consumers need one import. */
export type { ActivityEntry };
