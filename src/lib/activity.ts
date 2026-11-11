import { useCallback, useEffect, useState } from "react";
import { getTool } from "@/lib/toolRegistry";

/* ------------------------------------------------------------------ *
 * Local activity + favourites.
 * Only file *names* and metadata are stored — never file contents.
 * ------------------------------------------------------------------ */

export interface ActivityEntry {
  id: string;
  toolId: string;
  toolName: string;
  filename: string;
  size?: number;
  pages?: number;
  at: number;
}

const ACTIVITY_KEY = "paperly.activity.v1";
const FAVORITES_KEY = "paperly.favorites.v1";
const EVENT = "paperly:storage";
const MAX_ACTIVITY = 40;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage can be unavailable in private modes — features degrade quietly */
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

function subscribe(listener: () => void) {
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

/* -------------------------------- activity -------------------------------- */
export function readActivity(): ActivityEntry[] {
  return read<ActivityEntry[]>(ACTIVITY_KEY, []).filter((entry) => entry && entry.at && entry.toolId);
}

export function recordActivity(entry: Omit<ActivityEntry, "id" | "at">) {
  const next: ActivityEntry[] = [
    { ...entry, id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, at: Date.now() },
    ...readActivity().filter((old) => !(old.filename === entry.filename && old.toolId === entry.toolId)),
  ].slice(0, MAX_ACTIVITY);
  write(ACTIVITY_KEY, next);
}

export function clearActivity() {
  write(ACTIVITY_KEY, []);
}

export function removeActivity(id: string) {
  write(ACTIVITY_KEY, readActivity().filter((entry) => entry.id !== id));
}

export function recentToolIds(limit = 4): string[] {
  const ids: string[] = [];
  for (const entry of readActivity()) {
    if (getTool(entry.toolId) && !ids.includes(entry.toolId)) ids.push(entry.toolId);
    if (ids.length >= limit) break;
  }
  return ids;
}

export function readableRecent(entries: ActivityEntry[], limit = 4): import("@/lib/toolRegistry").Tool[] {
  const seen = new Set<string>();
  const tools: import("@/lib/toolRegistry").Tool[] = [];
  for (const entry of entries) {
    const tool = getTool(entry.toolId);
    if (tool && !seen.has(tool.id)) {
      tools.push(tool);
      seen.add(tool.id);
    }
    if (tools.length >= limit) break;
  }
  return tools;
}

export function useActivity(): ActivityEntry[] {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  useEffect(() => {
    const refresh = () => setEntries(readActivity());
    refresh();
    return subscribe(refresh);
  }, []);
  return entries;
}

export function formatWhen(at: number): string {
  const diff = Date.now() - at;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
  const days = Math.round(diff / 86_400_000);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/* -------------------------------- favourites -------------------------------- */
export function readFavorites(): string[] {
  return read<string[]>(FAVORITES_KEY, []).filter((id) => Boolean(getTool(id)));
}

export function toggleFavorite(toolId: string) {
  const next = readFavorites().includes(toolId)
    ? readFavorites().filter((id) => id !== toolId)
    : [...readFavorites(), toolId].slice(-8);
  write(FAVORITES_KEY, next);
}

export function useFavorites(): { favorites: string[]; toggle: (id: string) => void; isFavorite: (id: string) => boolean } {
  const [favorites, setFavorites] = useState<string[]>([]);
  useEffect(() => {
    const refresh = () => setFavorites(readFavorites());
    refresh();
    return subscribe(refresh);
  }, []);
  const toggle = useCallback((id: string) => toggleFavorite(id), []);
  const isFavorite = useCallback((id: string) => favorites.includes(id), [favorites]);
  return { favorites, toggle, isFavorite };
}
