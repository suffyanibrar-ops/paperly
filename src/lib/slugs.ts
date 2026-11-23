/**
 * Canonical public URL slugs for every tool.
 *
 * The registry id stays the stable internal key (tool components, preferences,
 * activity, tests). The slug is the crawlable, human-readable URL that appears
 * in the sitemap, canonical tags and every rendered link.
 *
 * Keep this file in sync with `TOOLS` in toolRegistry.ts — a unit test enforces
 * one unique slug per registered tool and a round-trip lookup both ways.
 */
export const TOOL_SLUGS: Record<string, string> = {
  merge: "merge-pdf",
  split: "split-pdf",
  organize: "organize-pdf",
  rotate: "rotate-pdf",
  crop: "crop-pdf",
  compress: "compress-pdf",
  repair: "repair-pdf",
  "page-numbers": "page-numbers-pdf",
  "jpg-to-pdf": "jpg-to-pdf",
  "pdf-to-jpg": "pdf-to-jpg",
  "pdf-to-word": "pdf-to-word",
  "pdf-to-excel": "pdf-to-excel",
  "pdf-to-ppt": "pdf-to-ppt",
  "word-to-pdf": "word-to-pdf",
  "excel-to-pdf": "excel-to-pdf",
  "ppt-to-pdf": "ppt-to-pdf",
  "extract-text": "extract-text-from-pdf",
  edit: "edit-pdf",
  sign: "sign-pdf",
  watermark: "watermark-pdf",
  redact: "redact-pdf",
  compare: "compare-pdf",
  protect: "protect-pdf",
  unlock: "unlock-pdf",
  ocr: "ocr-pdf",
  "markdown-to-pdf": "markdown-to-pdf",
  "pdf-to-markdown": "pdf-to-markdown",
  resize: "resize-pdf",
  "n-up": "n-up-pdf",
  "headers-footers": "headers-footers-pdf",
  bates: "bates-pdf",
  "fill-forms": "fill-forms-pdf",
  flatten: "flatten-pdf",
  scan: "scan-to-pdf",
  "html-to-pdf": "html-to-pdf",
  archive: "archive-pdf",
  batch: "batch-pdf",
  "create-form": "create-form-pdf",
  "remove-pages": "remove-pages-pdf",
  "extract-pages": "extract-pages-pdf",
  "extract-images": "extract-images-pdf",
  summarize: "summarize-pdf",
  "ask-pdf": "ask-pdf",
  "inspect-pdf": "inspect-pdf",
  "find-redact": "find-and-redact-pdf",
  sanitize: "sanitize-pdf",
  bookmarks: "edit-pdf-bookmarks",
  "split-bookmarks": "split-pdf-by-bookmarks",
  metadata: "edit-pdf-metadata",
  workflow: "workflows",
  "tables-to-csv": "pdf-tables-to-csv",
};

/** Slug → registry id. Derived once so both directions always agree. */
export const SLUG_TO_TOOL: Record<string, string> = Object.fromEntries(
  Object.entries(TOOL_SLUGS).map(([id, slug]) => [slug, id]),
);

export function toolSlug(id: string): string {
  return TOOL_SLUGS[id] ?? id;
}

/** Resolve a `/tool/:id` legacy route or a clean `/slug` path to a registry id. */
export function toolIdFromPath(path: string): string | null {
  const clean = path.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  const legacy = clean.match(/^\/(?:tool|tools)\/([a-z0-9-]+)$/i);
  if (legacy) return legacy[1];
  const slug = clean.replace(/^\//, "");
  return SLUG_TO_TOOL[slug] ?? null;
}

/** The canonical, crawlable path for a tool id (`/merge-pdf`). */
export function toolPath(id: string): string {
  return `/${toolSlug(id)}`;
}

/** Legacy path kept working for bookmarks and old inbound links. */
export function legacyToolPath(id: string): string {
  return `/tool/${id}`;
}
