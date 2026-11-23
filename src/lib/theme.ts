import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";
const STORAGE_KEY = "paperly.theme.v1";

function prefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

/** Current theme: explicit saved choice first, then the OS preference. */
export function getTheme(): Theme {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* private mode */
  }
  return prefersDark() ? "dark" : "light";
}

function apply(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* private mode — the in-memory choice still applies for this page */
  }
  window.dispatchEvent(new CustomEvent(STORAGE_KEY, { detail: theme }));
}

export function setTheme(theme: Theme) {
  apply(theme);
}

export function toggleTheme(): Theme {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  apply(next);
  return next;
}

/**
 * Theme state shared by the header toggle. If the user has not made an explicit
 * choice, the hook follows `prefers-color-scheme` live.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => getTheme());

  useEffect(() => {
    const sync = () => setThemeState(getTheme());
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) sync();
    };
    const onCustom = () => sync();
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onMedia = () => {
      let saved: string | null = null;
      try {
        saved = window.localStorage.getItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
      if (!saved) {
        const next = prefersDark() ? "dark" : "light";
        document.documentElement.dataset.theme = next;
        document.documentElement.style.colorScheme = next;
        setThemeState(next);
      }
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(STORAGE_KEY, onCustom);
    media?.addEventListener?.("change", onMedia);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(STORAGE_KEY, onCustom);
      media?.removeEventListener?.("change", onMedia);
    };
  }, []);

  const toggle = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    apply(next);
    setThemeState(next);
    return next;
  }, [theme]);

  return { theme, setTheme: (next: Theme) => { apply(next); setThemeState(next); }, toggle };
}

/** True when the visitor has explicitly picked a theme (vs following the OS). */
export function hasExplicitTheme(): boolean {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved === "light" || saved === "dark";
  } catch {
    return false;
  }
}
