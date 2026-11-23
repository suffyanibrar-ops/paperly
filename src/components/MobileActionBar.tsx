import { SlidersHorizontal, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/utils/cn";

interface MobileAction {
  id: string;
  label: string;
  disabled: boolean;
}

let actionSequence = 0;

function collectActions(): MobileAction[] {
  const root = document.querySelector("[data-tool-workspace-content]");
  if (!root) return [];
  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>(
      '[data-paperly-primary="true"], button.bg-ink, button.bg-forest, button.bg-lime, button.bg-clay',
    ),
  ).filter((node) => {
    if ((node as HTMLButtonElement).disabled && !node.textContent?.trim()) return false;
    if (node.getAttribute("aria-disabled") === "true") return false;
    if (node.closest('[role="dialog"]') || node.closest("[data-mobile-bar-ignore]")) return false;
    if (node.hasAttribute("aria-pressed") || node.getAttribute("role") === "tab") return false;
    return node.getClientRects().length > 0;
  });

  const seen = new Set<string>();
  const actions: MobileAction[] = [];
  for (const node of nodes) {
    const label = (node.getAttribute("aria-label") || node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 42);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    if (!node.dataset.mobileActionId) node.dataset.mobileActionId = `ma-${(actionSequence += 1)}`;
    actions.push({ id: node.dataset.mobileActionId, label, disabled: Boolean((node as HTMLButtonElement).disabled) });
  }
  return actions.slice(-2);
}

/**
 * One thumb-zone bar for every tool. It mirrors the visible primary action(s)
 * rendered by the tool itself — no per-tool wiring — and exposes the shared
 * Advanced Options panel as a slide-up mobile sheet.
 */
export function MobileActionBar() {
  const [actions, setActions] = useState<MobileAction[]>([]);
  const [hasOptions, setHasOptions] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    const sync = () => {
      const next = collectActions();
      setActions((current) =>
        current.length === next.length && current.every((item, index) => item.id === next[index].id && item.label === next[index].label && item.disabled === next[index].disabled)
          ? current
          : next,
      );
      setHasOptions(Boolean(document.querySelector("[data-mobile-sheet-target]")));
    };
    sync();
    const timer = window.setInterval(sync, 700);
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled", "class", "aria-label"] });
    return () => {
      window.clearInterval(timer);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!sheetOpen) return;
    const target = document.querySelector<HTMLElement>("[data-mobile-sheet-target]");
    target?.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setSheetOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetOpen]);

  useEffect(() => {
    document.documentElement.dataset.mobileSheet = sheetOpen ? "advanced" : "";
    return () => {
      document.documentElement.dataset.mobileSheet = "";
    };
  }, [sheetOpen]);

  if (!actions.length && !hasOptions) return null;

  return (
    <>
      {sheetOpen && <button type="button" aria-label="Close options" onClick={() => setSheetOpen(false)} className="fixed inset-0 z-[68] bg-ink/50 backdrop-blur-sm md:hidden" />}
      <div
        className="fixed inset-x-0 bottom-0 z-[70] border-t border-line bg-paper/95 px-3 pt-2 shadow-[0_-12px_40px_-24px_rgba(0,0,0,0.45)] backdrop-blur-xl md:hidden"
        style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
        data-mobile-action-bar
      >
        <div className="mx-auto flex max-w-xl items-center gap-2">
          {hasOptions && (
            <button
              type="button"
              onClick={() => setSheetOpen((open) => !open)}
              aria-expanded={sheetOpen}
              className={cn(
                "flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border text-ink/75",
                sheetOpen ? "border-forest/30 bg-lime/30 text-forest" : "border-line bg-bone/60",
              )}
              aria-label="Open tool options"
            >
              {sheetOpen ? <X className="h-5 w-5" /> : <SlidersHorizontal className="h-5 w-5" />}
            </button>
          )}
          {actions.map((action, index) => (
            <button
              key={action.id}
              type="button"
              disabled={action.disabled}
              onClick={() => document.querySelector<HTMLElement>(`[data-mobile-action-id="${action.id}"]`)?.click()}
              className={cn(
                "min-h-12 min-w-0 flex-1 truncate rounded-xl px-4 text-[13px] font-semibold transition-colors disabled:opacity-45",
                index === actions.length - 1
                  ? "bg-ink text-paper"
                  : "border border-line bg-bone/70 text-ink/80",
              )}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
