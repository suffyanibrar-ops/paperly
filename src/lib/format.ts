/**
 * Tiny, dependency-free formatting helpers.
 *
 * These used to live in `@/lib/pdf`, which statically imports PDF.js, pdf-lib
 * and JSZip. Anything on the critical path (the app shell, the catalogue, the
 * homepage) must only import this module so those engines stay in lazy tool
 * chunks instead of being preloaded on first paint.
 */

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, "") || "document";
}

export function fileExt(name: string): string {
  return (name.split(".").pop() ?? "").toLowerCase();
}

export function sanitizeName(name: string, fallback = "paperly"): string {
  return (
    name
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 90) || fallback
  );
}
