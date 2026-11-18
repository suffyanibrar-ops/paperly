import { useEffect, useRef } from "react";

/* ------------------------------------------------------------------ *
 * Keyboard shortcuts
 *
 * Tools opt in to a small, consistent set: ⌘/Ctrl+Enter runs the primary
 * action, ⌘/Ctrl+S downloads the result, Escape dismisses the top layer.
 * Typing in a field never triggers a shortcut.
 * ------------------------------------------------------------------ */

export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || element.isContentEditable === true;
}

function isPrimaryModifier(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

/** Run `handler` on ⌘/Ctrl+Enter. Disabled while a job is running. */
export function usePrimaryShortcut(handler: () => void, enabled = true): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPrimaryModifier(event) || event.altKey) return;
      if (event.key !== "Enter") return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      handlerRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}

/** Run `handler` on ⌘/Ctrl+S after a result exists. */
export function useDownloadShortcut(handler: () => void, enabled = true): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPrimaryModifier(event) || event.altKey) return;
      if (event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      handlerRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}

/** Run `handler` when Escape is pressed (unless a field is focused). */
export function useEscape(handler: () => void, enabled = true): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (isTypingTarget(event.target)) return;
      handlerRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}

/** True when the visitor asks the OS/browser for reduced motion. */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
