import type { ToolCategory } from "@/lib/toolRegistry";

/**
 * Public discovery groups used by the homepage and /tools filter pills.
 *
 * These are deliberately different from the internal five storage categories:
 * they match what a visitor is trying to do ("redact a contract", "get text out
 * of a scan") and every one of the 51 tools belongs to exactly one group.
 */
export type ToolGroupId = "organize" | "edit" | "convert" | "ocr" | "secure" | "inspect";

export interface ToolGroup {
  id: ToolGroupId;
  label: string;
  blurb: string;
  dot: string;
  ids: readonly string[];
}

export const TOOL_GROUPS: readonly ToolGroup[] = [
  {
    id: "organize",
    label: "Organize",
    blurb: "Reorder, merge, split, rotate and impose pages.",
    dot: "bg-forest",
    ids: [
      "merge",
      "split",
      "organize",
      "rotate",
      "crop",
      "page-numbers",
      "resize",
      "n-up",
      "headers-footers",
      "bates",
      "remove-pages",
      "extract-pages",
      "bookmarks",
      "split-bookmarks",
      "workflow",
    ],
  },
  {
    id: "edit",
    label: "Edit & Sign",
    blurb: "Add text, signatures, watermarks and form fields.",
    dot: "bg-clay",
    ids: ["edit", "sign", "watermark", "fill-forms", "create-form", "flatten"],
  },
  {
    id: "convert",
    label: "Convert",
    blurb: "Move between PDF, Office, images, HTML and Markdown.",
    dot: "bg-sky-ink",
    ids: [
      "jpg-to-pdf",
      "pdf-to-jpg",
      "pdf-to-word",
      "pdf-to-excel",
      "pdf-to-ppt",
      "word-to-pdf",
      "excel-to-pdf",
      "ppt-to-pdf",
      "markdown-to-pdf",
      "pdf-to-markdown",
      "html-to-pdf",
      "archive",
    ],
  },
  {
    id: "ocr",
    label: "OCR & Extract",
    blurb: "Make scans searchable and pull out text, tables and images.",
    dot: "bg-lilac-ink",
    ids: ["ocr", "extract-text", "scan", "extract-images", "summarize", "tables-to-csv"],
  },
  {
    id: "secure",
    label: "Security & Redact",
    blurb: "Encrypt, unlock, redact, sanitise and strip metadata.",
    dot: "bg-clay-ink",
    ids: ["protect", "unlock", "redact", "find-redact", "sanitize", "metadata", "batch"],
  },
  {
    id: "inspect",
    label: "Inspect & Repair",
    blurb: "Diagnose, compare, compress and rebuild documents.",
    dot: "bg-amber-600",
    ids: ["compress", "repair", "compare", "ask-pdf", "inspect-pdf"],
  },
] as const;

const GROUP_BY_TOOL = new Map<string, ToolGroupId>();
for (const group of TOOL_GROUPS) {
  for (const id of group.ids) GROUP_BY_TOOL.set(id, group.id);
}

export function toolGroup(id: string): ToolGroupId {
  return GROUP_BY_TOOL.get(id) ?? "inspect";
}

/** Discovery label for a tool, used on cards and in the palette. */
export function groupLabel(id: string): string {
  const id_ = toolGroup(id);
  return TOOL_GROUPS.find((group) => group.id === id_)?.label ?? "Tools";
}

/**
 * Extra search terms so Cmd/Ctrl+K finds tools by the words people actually use
 * ("combine", "password", "scan", "Excel") rather than only the registry name.
 */
export const TOOL_ALIASES: Record<string, string> = {
  merge: "combine join concatenate append stitch",
  split: "cut divide extract pages separate",
  organize: "reorder sort pages move delete rotate",
  rotate: "turn sideways orientation landscape",
  crop: "trim margins borders cut",
  compress: "reduce size shrink optimise optimize smaller",
  repair: "fix broken damaged corrupt recover",
  "page-numbers": "numbering pagination footer",
  "jpg-to-pdf": "image photo png jpeg convert",
  "pdf-to-jpg": "image photo png jpeg export",
  "pdf-to-word": "docx office editable",
  "pdf-to-excel": "xlsx spreadsheet table cells",
  "pdf-to-ppt": "powerpoint slides presentation deck",
  "word-to-pdf": "docx office convert",
  "excel-to-pdf": "xlsx spreadsheet convert",
  "ppt-to-pdf": "powerpoint slides presentation convert",
  "extract-text": "copy text content plain txt",
  edit: "annotate text box highlight draw type",
  sign: "signature esign initials",
  watermark: "stamp brand draft confidential",
  redact: "black out censor hide remove sensitive",
  compare: "diff differences versions changes",
  protect: "password encrypt secure lock",
  unlock: "password remove decrypt open",
  ocr: "scan text recognition searchable tesseract",
  "markdown-to-pdf": "md convert notes readme",
  "pdf-to-markdown": "md convert export text",
  resize: "page size scale a4 letter",
  "n-up": "imposition multiple pages per sheet booklet",
  "headers-footers": "header footer margin stamp",
  bates: "numbering legal discovery stamp",
  "fill-forms": "form fields fill questionnaire",
  flatten: "flatten forms annotations merge layers",
  scan: "camera phone capture document",
  "html-to-pdf": "webpage website url convert",
  archive: "pdf/a archival long term",
  batch: "bulk multiple files zip queue",
  "create-form": "form builder fields checkbox dropdown",
  "remove-pages": "delete pages cut",
  "extract-pages": "select split pull pages",
  "extract-images": "photos pictures embedded export",
  summarize: "summary tldr key points",
  "ask-pdf": "question chat search document",
  "inspect-pdf": "metadata fonts structure risk audit",
  "find-redact": "patterns bulk email phone ssn card redact",
  sanitize: "clean metadata xmp javascript attachments hidden",
  bookmarks: "outline toc table of contents",
  "split-bookmarks": "chapters outline split",
  metadata: "title author subject keywords xmp",
  workflow: "pipeline macro chain automate",
  "tables-to-csv": "table grid spreadsheet csv extract",
};

/** Score a tool against a query. Higher is better; 0 means no match. */
export function searchScore(query: string, tool: { id: string; name: string; tagline: string; description: string; category: ToolCategory }): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const name = tool.name.toLowerCase();
  const haystack = `${name} ${tool.id} ${tool.tagline} ${tool.description} ${tool.category} ${TOOL_ALIASES[tool.id] ?? ""}`.toLowerCase();
  if (name === q) return 100;
  if (name.startsWith(q)) return 80;
  if (name.includes(q)) return 60;
  if (tool.id.includes(q)) return 55;
  if ((TOOL_ALIASES[tool.id] ?? "").includes(q)) return 45;
  if (haystack.includes(q)) return 30;
  // Fuzzy subsequence: "rdct" → "redact", "cmp" → "compress".
  let index = 0;
  for (const char of q.replace(/\s+/g, "")) {
    index = haystack.indexOf(char, index);
    if (index < 0) return 0;
    index += 1;
  }
  return 10;
}
