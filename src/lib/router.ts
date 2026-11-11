import { useCallback, useEffect, useState } from "react";

/* ------------------------------------------------------------------ *
 * Files handed from the home page dropzone to a tool page
 * ------------------------------------------------------------------ */
interface Stash {
  id: string;
  files: File[];
  at: number;
  toolId?: string;
}

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
  const matches = (toolId?: string) => !toolId || target === `/tool/${toolId}`;

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
  navigate(`/tool/${toolId}`);
}

/* ------------------------------------------------------------------ *
 * Tiny hash router — refresh-safe on static hosting
 * ------------------------------------------------------------------ */
/**
 * Supports two URL forms:
 *  - hash routes used by existing in-app links (`/#/tool/merge`), which work on
 *    any static host and are the most resilient option;
 *  - real path URLs (`/tool/merge`) served by the prerendered Netlify deployment
 *    and used as canonicals for search engines.
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

export function navigate(path: string) {
  const clean = path.startsWith("/") ? path : `/${path}`;
  if (currentPath() === clean) {
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  window.location.hash = clean;
}

export function useRoute(): string {
  const [path, setPath] = useState(() => currentPath());
  useEffect(() => {
    const onChange = () => {
      setPath(currentPath());
      window.scrollTo({ top: 0, behavior: "auto" });
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return path;
}

export function useNavigate() {
  return useCallback((path: string) => navigate(path), []);
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
