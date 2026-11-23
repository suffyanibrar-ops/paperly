import { useCallback, useEffect, useState } from "react";
import { toolIdFromPath, toolPath } from "@/lib/slugs";

/* ------------------------------------------------------------------ *
 * Files handed from the home page dropzone to a tool page
 * ------------------------------------------------------------------ */
interface Stash {
  id: string;
  files: File[];
  at: number;
  toolId?: string;
}

const NAV_EVENT = "paperly:navigate";
let stashed: Stash | null = null;
let lastTaken: { id: string; files: File[]; at: number; toolId?: string } | null = null;

/** Hand files to the next tool page. The handoff is one-shot and route-scoped. */
export function stashFiles(files: File[], toolId?: string) {
  stashed = files.length
    ? { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, files, at: Date.now(), toolId }
    : null;
}

/**
 * Read a pending handoff exactly once.
 * The short repeat window keeps React StrictMode's double render from losing files,
 * while the route check stops a stale handoff leaking into a different tool.
 */
export function takeStashedFiles(route = currentPath()): File[] {
  const now = Date.now();
  const target = route.replace(/^#/, "").split("?")[0];
  const matches = (toolId?: string) => !toolId || toolIdFromPath(target) === toolId;

  if (!stashed) {
    if (lastTaken && now - lastTaken.at < 1200 && matches(lastTaken.toolId)) {
      const files = lastTaken.files;
      lastTaken = null;
      return files;
    }
    return [];
  }
  if (now - stashed.at > 15_000 || !matches(stashed.toolId)) return [];
  lastTaken = { id: stashed.id, files: stashed.files, at: now, toolId: stashed.toolId };
  const files = stashed.files;
  stashed = null;
  return files;
}

export function startTool(toolId: string, files: File[] = []) {
  stashFiles(files, toolId);
  navigate(toolPath(toolId));
}

/* ------------------------------------------------------------------ *
 * History router — clean, crawlable paths with hash compatibility
 * ------------------------------------------------------------------ */
/**
 * The public build uses real path URLs (`/merge-pdf`, `/tools`, `/privacy`),
 * which are prerendered to static HTML for crawlers and served by the host with
 * a SPA fallback. Legacy `#/tool/merge` and `/tool/merge` URLs still resolve, so
 * old bookmarks and inbound links keep working.
 */
export function currentPath(): string {
  const hash = window.location.hash.replace(/^#/, "");
  if (hash.startsWith("/")) return hash;
  const base = import.meta.env.BASE_URL || "/";
  let pathname = window.location.pathname;
  // Project sites are served under a sub-path (e.g. /paperly/): strip it so the
  // same route table works for root deployments and GitHub Pages alike.
  if (base !== "/" && base !== "./" && pathname.startsWith(base)) {
    pathname = `/${pathname.slice(base.length)}`;
  }
  const search = window.location.search;
  const normalised = `${pathname}${search}` || "/";
  return normalised.startsWith("/") ? normalised : `/${normalised}`;
}

function browserPath(path: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  const base = import.meta.env.BASE_URL || "/";
  if (base === "/" || base === "./") return clean;
  return `${base.replace(/\/+$/, "")}${clean}`;
}

export function navigate(path: string) {
  const clean = path.startsWith("/") ? path : `/${path}`;
  if (currentPath() === clean) {
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  try {
    window.history.pushState({}, "", browserPath(clean));
    window.dispatchEvent(new Event(NAV_EVENT));
  } catch {
    // Extremely old/embedded webviews: fall back to the hash route.
    window.location.hash = clean;
  }
  window.scrollTo({ top: 0, behavior: "auto" });
}

export function useRoute(): string {
  const [path, setPath] = useState(() => currentPath());
  useEffect(() => {
    const onChange = () => {
      setPath(currentPath());
      window.scrollTo({ top: 0, behavior: "auto" });
    };
    window.addEventListener("hashchange", onChange);
    window.addEventListener("popstate", onChange);
    window.addEventListener(NAV_EVENT, onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
      window.removeEventListener("popstate", onChange);
      window.removeEventListener(NAV_EVENT, onChange);
    };
  }, []);
  return path;
}

export function useNavigate() {
  return useCallback((path: string) => navigate(path), []);
}

/**
 * Intercept same-origin, in-app links so static anchors can point at real
 * crawlable URLs while navigation stays instant (no full page reload).
 * Returns a cleanup function for the effect.
 */
export function installLinkInterceptor(): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element | null)?.closest?.("a");
    if (!anchor) return;
    if (anchor.target || anchor.hasAttribute("download") || anchor.getAttribute("rel")?.includes("external")) return;
    const href = anchor.getAttribute("href");
    if (!href) return;
    if (href.startsWith("#/")) {
      event.preventDefault();
      navigate(href.slice(1));
      return;
    }
    if (!href.startsWith("/") || href.startsWith("//")) return;
    // Assets and machine-readable files must load normally.
    if (/\.(?:pdf|zip|json|xml|txt|csv|png|jpe?g|svg|webp|ico|woff2?|js|css|mjs|webmanifest)$/i.test(href.split(/[?#]/)[0])) return;
    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin) return;
    event.preventDefault();
    navigate(`${url.pathname}${url.search}`);
  };
  document.addEventListener("click", onClick);
  return () => document.removeEventListener("click", onClick);
}

/* ------------------------------------------------------------------ *
 * Clipboard / small browser helpers
 * ------------------------------------------------------------------ */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
