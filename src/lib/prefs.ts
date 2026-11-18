import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------------------------------------------ *
 * Preference engine
 *
 * A tiny, versioned, namespaced store for tool options and UI choices.
 * Only *settings* are stored — never file contents, never personal data.
 * Every read is defensive: private modes, corrupted payloads and schema
 * drift all fall back to the caller's defaults instead of throwing.
 * ------------------------------------------------------------------ */

const ROOT = "paperly.prefs.v1";
const EVENT = "paperly:prefs";
const VERSION = 1;

interface Envelope<T> {
  version: number;
  value: T;
  savedAt: number;
}

function storageKey(scope: string): string {
  return `${ROOT}.${scope}`;
}

function canStore(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
  } catch {
    return false;
  }
}

/** Read a namespaced preference object, merged over the supplied defaults. */
export function readPreferences<T extends Record<string, unknown>>(scope: string, defaults: T): T {
  if (!canStore()) return defaults;
  try {
    const raw = window.localStorage.getItem(storageKey(scope));
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<Envelope<Partial<T>>>;
    if (!parsed || parsed.version !== VERSION || !parsed.value || typeof parsed.value !== "object") return defaults;
    return { ...defaults, ...parsed.value };
  } catch {
    return defaults;
  }
}

/** Persist a namespaced preference object. Failures degrade silently. */
export function writePreferences<T extends Record<string, unknown>>(scope: string, value: T): void {
  if (!canStore()) return;
  try {
    const envelope: Envelope<T> = { version: VERSION, value, savedAt: Date.now() };
    window.localStorage.setItem(storageKey(scope), JSON.stringify(envelope));
  } catch {
    /* private mode or quota — the UI keeps working with in-memory state */
  }
  try {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: scope }));
  } catch {
    /* CustomEvent is unavailable in a few embedded webviews */
  }
}

export function clearPreferences(scope: string): void {
  if (!canStore()) return;
  try {
    window.localStorage.removeItem(storageKey(scope));
  } catch {
    /* nothing to do */
  }
  try {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: scope }));
  } catch {
    /* ignore */
  }
}

/** Names of every scope currently stored in this browser. */
export function listPreferenceScopes(): string[] {
  if (!canStore()) return [];
  try {
    const prefix = `${ROOT}.`;
    const scopes: string[] = [];
    for (let index = 0; index < window.localStorage.length; index++) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(prefix)) scopes.push(key.slice(prefix.length));
    }
    return scopes;
  } catch {
    return [];
  }
}

/** Remove every remembered setting. Returns how many scopes were cleared. */
export function clearAllPreferences(): number {
  if (!canStore()) return 0;
  const scopes = listPreferenceScopes();
  try {
    for (const scope of scopes) window.localStorage.removeItem(storageKey(scope));
  } catch {
    /* quota/private mode — best effort */
  }
  try {
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    /* ignore */
  }
  return scopes.length;
}

/** True when `scope` has a stored value for at least one key. */
export function hasPreferences(scope: string): boolean {
  if (!canStore()) return false;
  try {
    return window.localStorage.getItem(storageKey(scope)) !== null;
  } catch {
    return false;
  }
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const left = a[key];
    const right = b[key];
    if (left === right) continue;
    if (typeof left === "object" || typeof right === "object") {
      try {
        if (JSON.stringify(left) === JSON.stringify(right)) continue;
      } catch {
        return false;
      }
    }
    return false;
  }
  return true;
}

export interface PreferenceStore<T extends Record<string, unknown>> {
  value: T;
  /** Update one option. */
  set: <K extends keyof T>(key: K, next: T[K]) => void;
  /** Merge several options at once (used by presets and reset). */
  patch: (next: Partial<T>) => void;
  /** Restore every option to its default. */
  reset: () => void;
  /** True when the current value differs from the defaults. */
  changed: boolean;
  /** True when the store has something saved (survives clear()). */
  saved: boolean;
}

/**
 * A persisted option bag for one surface (usually `tool.<id>`).
 *
 * ```ts
 * const opts = usePreferences("tool.compress", { level: "balanced", grayscale: false });
 * opts.set("grayscale", true);
 * ```
 *
 * Defaults are captured on first render, so a new code release that adds an
 * option automatically supplies that option's new default.
 */
export function usePreferences<T extends Record<string, unknown>>(
  scope: string,
  defaults: T,
): PreferenceStore<T> {
  const defaultsRef = useRef(defaults);
  const [value, setValue] = useState<T>(() => readPreferences(scope, defaultsRef.current));
  const [saved, setSaved] = useState<boolean>(() => hasPreferences(scope));
  // Keep the newest value reachable synchronously so several `set()` calls in
  // one event handler compose instead of overwriting each other.
  const latestRef = useRef(value);
  latestRef.current = value;

  // Stay in sync when another component (or tab) changes the same scope.
  useEffect(() => {
    const reload = () => {
      setValue(readPreferences(scope, defaultsRef.current));
      setSaved(hasPreferences(scope));
    };
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === storageKey(scope)) reload();
    };
    const onCustom = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (!detail || detail === scope) reload();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(EVENT, onCustom);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(EVENT, onCustom);
    };
  }, [scope]);

  const persist = useCallback(
    (next: T) => {
      latestRef.current = next;
      setValue(next);
      writePreferences(scope, next);
      setSaved(true);
    },
    [scope],
  );

  const set = useCallback(
    <K extends keyof T>(key: K, next: T[K]) => {
      persist({ ...latestRef.current, [key]: next });
    },
    [persist],
  );

  const patch = useCallback(
    (next: Partial<T>) => {
      persist({ ...latestRef.current, ...next });
    },
    [persist],
  );

  const reset = useCallback(() => {
    const fresh = { ...defaultsRef.current };
    persist(fresh);
  }, [persist]);

  const changed = useMemo(() => !shallowEqual(value, defaultsRef.current), [value]);
  return { value, set, patch, reset, changed, saved };
}

/** Convenience wrapper: preferences scoped to one tool id. */
export function useToolPreferences<T extends Record<string, unknown>>(
  toolId: string,
  defaults: T,
): PreferenceStore<T> {
  return usePreferences(`tool.${toolId}`, defaults);
}

/**
 * A single persisted UI flag (an open panel, a dismissed hint…). Kept
 * separate from tool options so "reset options" never closes panels.
 */
export function useStickyFlag(scope: string, initial = false): [boolean, (next: boolean) => void] {
  const key = `ui.${scope}`;
  const [value, setValue] = useState<boolean>(() => {
    const stored = readPreferences(key, { on: initial });
    return typeof stored.on === "boolean" ? stored.on : initial;
  });
  useEffect(() => {
    const reload = () => setValue(readPreferences(key, { on: initial }).on);
    window.addEventListener(EVENT, reload);
    return () => window.removeEventListener(EVENT, reload);
  }, [key, initial]);
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      writePreferences(key, { on: next });
    },
    [key],
  );
  return [value, set];
}

/** A small persisted JSON value (last-used preset id, preferred output name…). */
export function useStickyValue<T>(scope: string, initial: T): [T, (next: T) => void] {
  const key = `ui.${scope}`;
  const [value, setValue] = useState<T>(() => readPreferences(key, { value: initial }).value ?? initial);
  const set = useCallback(
    (next: T) => {
      setValue(next);
      writePreferences(key, { value: next });
    },
    [key],
  );
  return [value, set];
}
