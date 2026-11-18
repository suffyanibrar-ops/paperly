import { ArrowRight, ArrowUpRight, ChevronDown, LayoutGrid, Lock, Menu, Search, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/utils/cn";
import { CATEGORIES, POPULAR_IDS, TOOLS, getTool, type ToolCategory } from "@/lib/toolRegistry";
import { CommandPalette, useCommandPalette } from "@/components/CommandPalette";
import { navigate, useRoute } from "@/lib/router";
import { ToolTile } from "@/components/ui";

export function Logo({ light = false, compact = false }: { light?: boolean; compact?: boolean }) {
  return (
    <a href="#/" className="group flex items-center gap-2.5" aria-label="Paperly home">
      <span
        className={cn(
          "relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-[11px] transition-transform duration-200 group-hover:-rotate-3",
          light ? "bg-paper" : "bg-ink",
        )}
      >
        <svg viewBox="0 0 32 32" className="h-full w-full" aria-hidden="true">
          <path d="M6 3.5h12.6L25 9.9v18.6H6z" fill={light ? "#12211a" : "#f7f4ec"} />
          <path d="M18.6 3.5v6.4H25" fill="#d9f26c" />
          <path d="M10 14h11M10 18h11M10 22h7" stroke={light ? "#f7f4ec" : "#12211a"} strokeWidth="1.9" strokeLinecap="round" />
          <circle cx="23.6" cy="23.4" r="5.4" fill="#d9f26c" stroke={light ? "#f7f4ec" : "#12211a"} strokeWidth="1.4" />
          <path d="m21.4 23.4 1.55 1.55 2.7-3" stroke="#12211a" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      {!compact && (
        <span className={cn("text-[21px] font-semibold tracking-[-0.045em]", light ? "text-paper" : "text-ink")}>
          paperly<span className={light ? "text-lime" : "text-clay-ink"}>.</span>
        </span>
      )}
    </a>
  );
}

const NAV = [
  { label: "Why Paperly", href: "#/why" },
  { label: "Compare", href: "#/vs-ilovepdf" },
  { label: "Guides", href: "#/guides" },
  { label: "Pricing", href: "#/pricing" },
  { label: "Help", href: "#/help" },
];

export function Header() {
  const route = useRoute();
  const [menuOpen, setMenuOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { open: paletteOpen, setOpen: setPaletteOpen } = useCommandPalette();

  useEffect(() => {
    setMenuOpen(false);
    setToolsOpen(false);
  }, [route]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setToolsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setToolsOpen(false);
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <header className="sticky top-0 z-50">
      <div className="bg-ink text-paper">
        <div className="container-page flex h-8 items-center justify-between text-[11px] font-medium tracking-[0.01em]">
          <p className="flex items-center gap-1.5 text-paper/75">
            <Lock className="h-3 w-3 text-lime" />
            Your documents are never uploaded. Files stay on this device.
          </p>
          <div className="hidden items-center gap-4 sm:flex">
            <span className="text-paper/75">No document uploads · No sign-up · No limits</span>
            <a href="#/why" className="flex items-center gap-1 text-lime transition-opacity hover:opacity-80">
              Why this matters <ArrowRight className="h-3 w-3" />
            </a>
          </div>
        </div>
      </div>

      <div className="border-b border-line/80 bg-bone/90 backdrop-blur-xl">
        <div ref={wrapperRef} className="container-page relative flex h-16 items-center justify-between gap-4">
          <Logo />

          <nav className="hidden items-center gap-0.5 lg:flex" aria-label="Main">
            <button
              type="button"
              aria-expanded={toolsOpen}
              onClick={() => setToolsOpen((v) => !v)}
              className={cn(
                "flex h-9 items-center gap-1.5 rounded-lg px-3 text-[13.5px] font-medium transition-colors",
                toolsOpen ? "bg-ink/[0.06] text-ink" : "text-ink/75 hover:bg-ink/[0.04] hover:text-ink",
              )}
            >
              Tools
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", toolsOpen && "rotate-180")} />
            </button>
            {NAV.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className={cn(
                  "flex h-9 items-center rounded-lg px-3 text-[13.5px] font-medium transition-colors",
                  route === item.href.replace("#", "")
                    ? "bg-ink/[0.06] text-ink"
                    : "text-ink/75 hover:bg-ink/[0.04] hover:text-ink",
                )}
              >
                {item.label}
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open search"
              className="flex h-10 items-center gap-2 rounded-xl border border-line bg-paper px-2.5 text-ink/75 transition-colors hover:border-forest/30 hover:text-forest sm:px-3"
            >
              <Search className="h-4 w-4" />
              <span className="hidden text-[12.5px] lg:inline">Search</span>
              <kbd className="hidden rounded border border-line bg-bone-deep/60 px-1.5 py-0.5 font-mono text-[9.5px] text-ink/75 lg:inline">⌘K</kbd>
            </button>
            <a
              href="#/tools"
              className="hidden h-10 items-center gap-2 rounded-xl bg-ink px-4 text-[13px] font-medium text-paper transition-colors hover:bg-forest-soft sm:inline-flex"
            >
              <LayoutGrid className="h-3.5 w-3.5 text-lime" />
              All {TOOLS.length} tools
            </a>
            <button
              type="button"
              className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-paper text-ink lg:hidden"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>

          {toolsOpen && <ToolsMegaMenu />}
        </div>

        {menuOpen && <MobileMenu />}
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </header>
  );
}

function ToolsMegaMenu() {
  return (
    <div className="absolute left-4 right-4 top-[calc(100%+1px)] z-50 mx-auto max-w-3xl animate-pop overflow-hidden rounded-2xl border border-line bg-paper shadow-lift">
      <div className="grid grid-cols-2 gap-x-2 gap-y-1 p-4 sm:grid-cols-4">
        {(Object.keys(CATEGORIES) as ToolCategory[]).map((key) => (
          <div key={key}>
            <a
              href={`#/tools?c=${key}`}
              className="mb-1 flex items-center gap-1.5 px-2 py-1 text-[10.5px] font-bold uppercase tracking-[0.11em] text-ink/75 hover:text-forest"
            >
              <span className={cn("h-1.5 w-1.5 rounded-full", CATEGORIES[key].dot)} />
              {CATEGORIES[key].name}
            </a>
            <ul>
              {TOOLS.filter((t) => t.category === key).map((tool) => (
                <li key={tool.id}>
                  <a
                    href={`#/tool/${tool.id}`}
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] font-medium text-ink/75 transition-colors hover:bg-bone-deep/60 hover:text-forest"
                  >
                    <tool.icon className="h-3.5 w-3.5 text-ink/75" />
                    {tool.name}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <a
        href="#/tools"
        className="flex items-center justify-between border-t border-line bg-bone-deep/40 px-5 py-3 text-[12.5px] font-semibold text-forest transition-colors hover:bg-lime/25"
      >
        See the whole toolbox
        <span className="flex items-center gap-1 text-[11.5px] font-medium text-ink/75">
          {TOOLS.length} tools, all free <ArrowRight className="h-3.5 w-3.5" />
        </span>
      </a>
    </div>
  );
}

function MobileMenu() {
  return (
    <div className="max-h-[calc(100vh-6rem)] overflow-y-auto border-t border-line bg-paper px-5 py-4 lg:hidden">
      <div className="grid grid-cols-2 gap-1.5">
        {POPULAR_IDS.map((id) => {
          const tool = getTool(id);
          if (!tool) return null;
          return (
            <a
              key={id}
              href={`#/tool/${id}`}
              className="flex items-center gap-2.5 rounded-xl border border-line px-2.5 py-2.5"
            >
              <ToolTile tool={tool} size="sm" />
              <span className="text-[12.5px] font-medium">{tool.name}</span>
            </a>
          );
        })}
      </div>
      <div className="mt-4 grid gap-2">
        {[...NAV, { label: "Guides", href: "#/guides" }, { label: "Activity", href: "#/activity" }, { label: "About", href: "#/about" }, { label: "Contact", href: "#/contact" }].filter((item, index, list) => list.findIndex((x) => x.href === item.href) === index).map((item) => (
          <a key={item.href} href={item.href} className="rounded-lg px-1 py-2 text-[14px] font-medium text-ink/75">
            {item.label}
          </a>
        ))}
        <a href="#/tools" className="mt-1 flex h-11 items-center justify-center gap-2 rounded-xl bg-ink text-[13.5px] font-semibold text-paper">
          <LayoutGrid className="h-4 w-4 text-lime" /> All {TOOLS.length} tools <ArrowRight className="h-4 w-4" />
        </a>
      </div>
    </div>
  );
}

export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="grain bg-ink pb-8 pt-14 text-paper">
      <div className="container-page relative">
        <div className="grid gap-10 border-b border-paper/10 pb-10 md:grid-cols-[1.5fr_1fr_1fr] lg:grid-cols-[1.7fr_1fr_1fr_1.2fr]">
          <div>
            <Logo light />
            <p className="mt-4 max-w-[30ch] text-[13px] leading-relaxed text-paper/75">
              A calmer, more private home for your PDFs. Every tool runs inside your browser — nothing is uploaded, ever.
            </p>
            <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-lime/25 bg-lime/10 px-3 py-1.5 text-[11px] font-medium text-lime">
              <ShieldCheck className="h-3.5 w-3.5" /> Verified local processing
            </div>
          </div>

          <FooterColumn
            title="Popular tools"
            links={["merge", "split", "compress", "edit", "sign", "protect"].map((id) => {
              const t = getTool(id)!;
              return { label: t.name, href: `#/tool/${id}` };
            })}
          />
          <FooterColumn
            title="Convert & edit"
            links={["ocr", "markdown-to-pdf", "pdf-to-word", "word-to-pdf", "pdf-to-excel", "excel-to-pdf"].map((id) => {
              const t = getTool(id)!;
              return { label: t.name, href: `#/tool/${id}` };
            })}
          />
          <div>
            <p className="mb-3.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-paper/70">Company</p>
            <ul className="space-y-2.5">
              {[
                { label: "Why Paperly", href: "#/why" },
                { label: "Compare with iLovePDF", href: "#/vs-ilovepdf" },
                { label: "Guides", href: "#/guides" },
                { label: "About", href: "#/about" },
                { label: "Activity", href: "#/activity" },
                { label: "Help & FAQ", href: "#/help" },
                { label: "Sitemap", href: "#/sitemap" },
                { label: "Contact", href: "#/contact" },
                { label: "Privacy", href: "#/privacy" },
                { label: "Terms", href: "#/terms" },
              ].map((link) => (
                <li key={link.label}>
                  <a href={link.href} className="text-[12.5px] text-paper/75 transition-colors hover:text-lime">
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="flex flex-col gap-4 pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11.5px] text-paper/70">
            © {year} Paperly. Made for the open web. Files stay yours.
          </p>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[11.5px] text-paper/75">
            <a href="#/vs-ilovepdf" className="hover:text-paper/70">Compare</a>
            <a href="#/guides" className="hover:text-paper/70">Guides</a>
            <a href="#/activity" className="hover:text-paper/70">Activity</a>
            <a href="#/privacy" className="hover:text-paper/70">Privacy</a>
            <a href="#/terms" className="hover:text-paper/70">Terms</a>
            <a href="#/tools" className="flex items-center gap-1 hover:text-lime">
              All tools <ArrowUpRight className="h-3 w-3" />
            </a>
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-lime" /> Documents never uploaded
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({ title, links }: { title: string; links: { label: string; href: string }[] }) {
  return (
    <div>
      <p className="mb-3.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-paper/70">{title}</p>
      <ul className="space-y-2.5">
        {links.map((link) => (
          <li key={link.label}>
            <a href={link.href} className="text-[12.5px] text-paper/75 transition-colors hover:text-lime">
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BackToTop() {
  return (
    <button
      type="button"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      className="fixed bottom-5 right-5 z-40 hidden h-10 items-center gap-1.5 rounded-full border border-line bg-paper px-3.5 text-[12px] font-medium text-ink/70 shadow-soft transition-colors hover:text-forest lg:flex"
    >
      Back to top <ChevronDown className="h-3.5 w-3.5 rotate-180" />
    </button>
  );
}

export function BrandNote() {
  return (
    <button
      type="button"
      onClick={() => navigate("/tools")}
      className="text-[12px] font-medium text-forest underline decoration-forest/30 underline-offset-2 hover:decoration-forest"
    >
      Browse the full toolbox
    </button>
  );
}
