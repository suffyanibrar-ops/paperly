/* ------------------------------------------------------------------ *
 * Page-query engine
 *
 * One parser for every page-range input in the app. It accepts the plain
 * syntax people already type (`1-3, 5`) and the shortcuts every competing
 * tool offers (`odd`, `even`, `last`, `last-5`, `7-`, `-4`, `>10`, `1-9:2`).
 * The function is pure and throws short, human error messages that tools
 * can show directly.
 * ------------------------------------------------------------------ */

export interface PageQueryChip {
  label: string;
  value: string;
  title: string;
}

const MAX_TOKENS = 500;

/**
 * Parse a page query into ordered, de-duplicated 1-based page numbers.
 *
 * Supported tokens (separated by commas, spaces or semicolons):
 *   all, odd, even, last, last-5, 5, 1-9, 1-9:2, 7-, -4, >10, <4
 */
export function parsePageQuery(input: string, total: number): number[] {
  if (!Number.isFinite(total) || total < 1) throw new Error("This document has no pages to select.");
  const trimmed = (input ?? "").trim();
  if (!trimmed || /^all$/i.test(trimmed)) return Array.from({ length: total }, (_, i) => i + 1);

  const parts = trimmed
    .toLowerCase()
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > MAX_TOKENS) throw new Error("That page list is too long. Use a range such as 1-50.");

  const pages: number[] = [];
  const push = (page: number) => {
    if (page >= 1 && page <= total) pages.push(page);
  };

  for (const raw of parts) {
    const token = raw.replace(/^pages?/, "").trim();
    if (!token) continue;

    if (token === "odd" || token === "even") {
      const parity = token === "odd" ? 1 : 0;
      for (let page = 1; page <= total; page++) if (page % 2 === parity) pages.push(page);
      continue;
    }

    if (token === "last") {
      pages.push(total);
      continue;
    }

    const lastMatch = token.match(/^last-(\d+)$/);
    if (lastMatch) {
      const count = Number(lastMatch[1]);
      if (count < 1) throw new Error("“last-0” isn’t a valid page count.");
      const start = Math.max(1, total - count + 1);
      for (let page = start; page <= total; page++) pages.push(page);
      continue;
    }

    // >N / <N: strictly after / before a page
    const gt = token.match(/^>(\d+)$/);
    if (gt) {
      const after = Number(gt[1]);
      let added = 0;
      for (let page = after + 1; page <= total; page++) {
        pages.push(page);
        added += 1;
      }
      if (!added) throw new Error(`There are no pages after page ${after}. This PDF has ${total}.`);
      continue;
    }
    const lt = token.match(/^<(\d+)$/);
    if (lt) {
      const before = Number(lt[1]);
      let added = 0;
      for (let page = 1; page < before && page <= total; page++) {
        pages.push(page);
        added += 1;
      }
      if (!added) throw new Error(`There are no pages before page ${before}.`);
      continue;
    }

    // N-M:step, N-M, N-, -M
    const rangeMatch = token.match(/^(\d*)\s*-\s*(\d*)(?::(\d+))?$/);
    if (rangeMatch && (rangeMatch[1] || rangeMatch[2])) {
      const rawStart = rangeMatch[1];
      const rawEnd = rangeMatch[2];
      const step = rangeMatch[3] ? Number(rangeMatch[3]) : 1;
      if (!Number.isFinite(step) || step < 1) throw new Error(`“${raw}” needs a step of 1 or more, like 1-10:2.`);
      const start = rawStart ? Number(rawStart) : 1;
      const end = rawEnd ? Number(rawEnd) : total;
      if (start < 1 || end < 1 || start > total || end > total) {
        throw new Error(`“${raw}” is outside this PDF. It has ${total} page${total === 1 ? "" : "s"}.`);
      }
      if (start <= end) for (let page = start; page <= end; page += step) push(page);
      else for (let page = start; page >= end; page -= step) push(page);
      continue;
    }

    if (/^\d+$/.test(token)) {
      const page = Number(token);
      if (page < 1 || page > total) {
        throw new Error(`Page ${page} doesn’t exist. This PDF has ${total} page${total === 1 ? "" : "s"}.`);
      }
      push(page);
      continue;
    }

    throw new Error(`“${raw}” isn’t a valid page. Try 1-3, 5, odd, even, last or >10.`);
  }

  const unique = [...new Set(pages)];
  if (!unique.length) throw new Error("Choose at least one page.");
  return unique;
}

/** Compact description used in summaries and download cards. */
export function describePageQuery(pages: number[], total: number): string {
  if (!pages.length) return "No pages selected";
  if (pages.length === total) return `All ${total} pages`;
  if (pages.length === 1) return `Page ${pages[0]}`;
  const oddOnly = pages.every((page) => page % 2 === 1) && pages.length === Math.ceil(total / 2);
  const evenOnly = pages.every((page) => page % 2 === 0) && pages.length === Math.floor(total / 2);
  if (oddOnly) return `All ${pages.length} odd pages`;
  if (evenOnly) return `All ${pages.length} even pages`;
  if (pages.length <= 4) return `Pages ${pages.join(", ")}`;
  return `${pages.length} selected pages`;
}

/** Convert an explicit page list back into a compact query string. */
export function pagesToQuery(pages: number[], total: number): string {
  if (!pages.length) return "";
  if (pages.length === total) return "all";
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const runs: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];
  const flush = () => {
    if (start === previous) runs.push(String(start));
    else if (previous === start + 1) runs.push(`${start},${previous}`);
    else runs.push(`${start}-${previous}`);
  };
  for (let i = 1; i < sorted.length; i++) {
    const page = sorted[i];
    if (page === previous + 1) {
      previous = page;
      continue;
    }
    flush();
    start = page;
    previous = page;
  }
  flush();
  return runs.join(", ");
}

/** True when the explicit list is every page in the document. */
export function isEveryPage(pages: number[], total: number): boolean {
  return total > 0 && pages.length === total;
}

/** Quick-select chips for range fields. */
export function pageQueryChips(total: number): PageQueryChip[] {
  const chips: PageQueryChip[] = [
    { label: "All", value: "", title: `All ${total} pages` },
    { label: "Odd", value: "odd", title: "Every odd page" },
    { label: "Even", value: "even", title: "Every even page" },
    { label: "Last", value: "last", title: "Only the final page" },
  ];
  if (total > 3) chips.push({ label: "Last 3", value: "last-3", title: "The final three pages" });
  return chips;
}

/** Non-throwing validation for live form feedback. */
export function validatePageQuery(input: string, total: number): string | null {
  try {
    parsePageQuery(input, total);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}
