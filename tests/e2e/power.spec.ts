import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import JSZip from "jszip";
import {
  clickAction,
  fixture,
  openTool,
  pdfPages,
  pdfText,
  saveDownload,
  waitSuccess,
  zipFiles,
} from "./helpers";

/**
 * Independent verification for the 8 tools added in the 42 → 50 upgrade
 * (ask-pdf, inspect-pdf, find-redact, sanitize, bookmarks, split-bookmarks,
 * metadata, tables-to-csv) plus the offline/PWA service worker.
 *
 * These tests are deliberately adversarial: every one downloads produced bytes
 * and inspects them (page counts, extracted text, CSV/CSV quoting, metadata,
 * outlines, ZIP contents, JSON report fields) rather than trusting the UI.
 *
 * Runs against the production build served by scripts/serve-dist.cjs on :4321
 * (see playwright.config.ts).
 */

const OUT = path.resolve("tests/e2e-output");

/** The DownloadPanel button reads `Download 3.4 KB`; report buttons also start with "Download". */
const PDF_DOWNLOAD = /^Download [\d.]+ (?:B|KB|MB)$/;

/** The verbatim sensitive line planted on all three pages of tests/fixtures/sample.pdf. */
const SAMPLE_SECRET = "Sensitive: account 99887766 balance 12000 EUR";

test.setTimeout(300_000);

/* ------------------------------------------------------------------ *
 * Local helpers (kept in this spec so tests/e2e/helpers.ts stays shared
 * and owned by the rest of the suite).
 * ------------------------------------------------------------------ */

/** Collect real errors (exceptions + console.error) so tools cannot regress silently. */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return errors;
}

/**
 * Attach files to the tool interface that is actually visible.
 *
 * Tool routes are lazy-loaded, so right after a hash navigation the outgoing
 * tool's DOM can be retained hidden (`display: none`) while the new interface
 * mounts. Its stale `input[type=file]` comes first in DOM order and Playwright's
 * file inputs do not require visibility, so a generic `input[type=file]`
 * selector can silently upload into the previous tool. `:visible` auto-waits
 * for the real interface instead.
 */
async function uploadTool(page: Page, files: string | string[]) {
  const list = Array.isArray(files) ? files : [files];
  await page.locator("input[type=file]:visible").first().setInputFiles(list);
  await page.waitForTimeout(1200);
  await page.locator('[role="alert"]').first().waitFor({ state: "visible", timeout: 1200 }).catch(() => undefined);
}

/** 1-based page number for a PDF.js outline destination (string or explicit array). */
async function destinationPage(doc: pdfjs.PDFDocumentProxy, dest: unknown): Promise<number | null> {
  let target = dest;
  if (typeof target === "string") target = await doc.getDestination(target);
  if (Array.isArray(target) && target.length > 0) {
    try {
      return (await doc.getPageIndex(target[0] as never)) + 1;
    } catch {
      return null;
    }
  }
  return null;
}

/** Top-level outline entries with their resolved destination pages. */
async function pdfOutline(file: string): Promise<{ title: string; page: number | null }[]> {
  const task = pdfjs.getDocument({ data: new Uint8Array(await fs.readFile(file)), useSystemFonts: true, isEvalSupported: false });
  const doc = await task.promise;
  const outline = await doc.getOutline();
  const entries: { title: string; page: number | null }[] = [];
  for (const item of outline ?? []) entries.push({ title: item.title, page: await destinationPage(doc, item.dest) });
  await task.destroy();
  return entries;
}

/**
 * Build a real, aligned 4-column table PDF (4 rows × 4 columns, every cell filled).
 * One cell contains a comma so the RFC-4180 CSV export must quote it.
 */
async function makeTablePdf(): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  const columns = [60, 200, 330, 440];
  const rows = [
    ["Product", "Region", "Units", "Unit price"],
    ["Paper, A4", "North", "1200", "4.5"],
    ["Folders", "South", "600", "1.2"],
    ["Ink", "West", "85", "32"],
  ];
  rows.forEach((row, rowIndex) => {
    row.forEach((cell, columnIndex) => {
      page.drawText(cell, { x: columns[columnIndex], y: 760 - rowIndex * 30, size: 10, font });
    });
  });
  await fs.mkdir(OUT, { recursive: true });
  const file = path.join(OUT, `tables-input-${process.pid}.pdf`);
  await fs.writeFile(file, await doc.save());
  return file;
}

/**
 * Create a 3-page bookmarked PDF through the Edit Bookmarks UI (the real
 * hand-off path) and return the downloaded file.
 */
async function createBookmarkedSample(page: Page): Promise<string> {
  await openTool(page, "bookmarks");
  await uploadTool(page, fixture("sample.pdf"));
  await expect(page.getByText(/No bookmarks yet/)).toBeVisible({ timeout: 30_000 });
  const add = page.getByRole("button", { name: "Add bookmark", exact: true });
  for (let index = 0; index < 3; index++) await add.click();
  const chapters = ["Chapter One", "Chapter Two", "Chapter Three"];
  for (let index = 0; index < chapters.length; index++) {
    await page.getByLabel(`Bookmark ${index + 1} title`).fill(chapters[index]);
    await page.getByLabel(`Target page for bookmark ${index + 1}`).fill(String(index + 1));
  }
  await clickAction(page, "Save bookmarks");
  await waitSuccess(page, /Bookmarks saved/);
  return saveDownload(page, "bookmarks", /^Download/);
}

/* ================================================================== *
 * 1. Ask Your PDF
 * ================================================================== */

test.describe("ask-pdf", () => {
  test("answers with a verbatim passage, page citations and highlighted query terms", async ({ page }) => {
    const errors = trackErrors(page);

    await openTool(page, "ask-pdf");
    await uploadTool(page, fixture("sample.pdf"));
    // The tool indexes once the page-count probe finishes.
    await expect(page.getByText(/3 pages ·/).first()).toBeVisible({ timeout: 30_000 });

    await page.locator("#ask-question").fill("account 99887766 balance");
    await clickAction(page, "Find answer");

    await waitSuccess(page, /Answer · verbatim from your PDFs/);
    await expect(page.getByText(/^(Strong|Weak) match$/).first()).toBeVisible();
    await expect(page.getByText(/% match$/).first()).toBeVisible();

    // The exact sentence from the fixture, quoted verbatim.
    await expect(page.getByText(SAMPLE_SECRET).first()).toBeVisible();
    // Citations for the pages that contain it (the same sentence is on all 3 pages).
    await expect(page.getByText(/sample\.pdf · p\. 1/).first()).toBeVisible();
    await expect(page.getByText(/sample\.pdf · p\. 2/).first()).toBeVisible();
    // Query terms inside the answer are wrapped in <mark> for highlighting.
    await expect(page.locator("mark").filter({ hasText: "99887766" }).first()).toBeVisible();
    await expect(page.locator("mark").filter({ hasText: "account" }).first()).toBeVisible();
    // Retrieval summary proves the real text layer was indexed (3 pages → 3 passages).
    await expect(page.getByText(/Indexed 3 passages from 3 pages across 1 PDF/).first()).toBeVisible();

    // Output bytes: the Markdown answer must quote the passage verbatim with its citation.
    const markdownFile = await saveDownload(page, "ask", /^\.md$/);
    const markdown = await fs.readFile(markdownFile, "utf8");
    expect(markdown).toContain("# account 99887766 balance");
    expect(markdown).toContain(SAMPLE_SECRET);
    expect(markdown).toContain("*sample.pdf*, page 1");
    expect(markdown).toContain("**Confidence:**");
    expect(markdown).toContain("Generated locally by Paperly");

    expect(errors).toEqual([]);
  });
});

/* ================================================================== *
 * 2. Inspect PDF
 * ================================================================== */

test.describe("inspect-pdf", () => {
  test("reports page count, metadata and structural cards, then a downloadable JSON report", async ({ page }) => {
    const errors = trackErrors(page);

    await openTool(page, "inspect-pdf");
    await uploadTool(page, fixture("sample.pdf"));
    await waitSuccess(page, /Structural red flags/);

    await expect(page.getByText("3 pages").first()).toBeVisible();
    await expect(page.getByText("Not encrypted").first()).toBeVisible();
    for (const card of [
      "Document",
      "Info dictionary",
      "Page geometry",
      "Text layer",
      "Forms & signatures",
      "Annotations",
      "Scripts & actions",
      "Embedded files",
      "Bookmarks",
      "Images & fonts",
    ]) {
      await expect(page.getByRole("heading", { name: card }).first()).toBeVisible();
    }
    // Metadata values from the fixture's real Info dictionary.
    await expect(page.getByText(/pdf-lib \(https:\/\/github\.com\/Hopding\/pdf-lib\)/).first()).toBeVisible();

    const jsonFile = await saveDownload(page, "inspect", /JSON report/);
    const report = JSON.parse(await fs.readFile(jsonFile, "utf8")) as {
      file: { name: string; size: number };
      summary: { version: string; pages: number; encrypted: boolean; textPages: number; sampledPages?: number; parseError: string };
      sections: { id: string; title: string; rows: { label: string; value: string }[] }[];
      flags: { id: string; severity: string }[];
      text: { sampledPages: number; pagesWithText: number; emptyPages: number[] };
    };

    expect(report.file.name).toBe("sample.pdf");
    expect(report.summary.pages).toBe(3);
    expect(report.summary.encrypted).toBe(false);
    expect(report.summary.parseError).toBe("");
    expect(report.summary.version).toMatch(/^\d\.\d$/);
    expect(report.text.sampledPages).toBe(3);
    expect(report.text.pagesWithText).toBe(3);
    expect(report.text.emptyPages).toEqual([]);

    const rowValue = (sectionId: string, label: string) =>
      report.sections.find((section) => section.id === sectionId)?.rows.find((row) => row.label === label)?.value;
    expect(rowValue("document", "Pages")).toBe("3");
    expect(rowValue("document", "Encryption")).toBe("Not encrypted");
    expect(rowValue("pages", "Page sizes")).toContain("A4");
    expect(rowValue("metadata", "Title")).toBe("Not set");
    expect(rowValue("metadata", "Producer")).toContain("pdf-lib");
    expect(rowValue("metadata", "Creator")).toContain("pdf-lib");
    expect(report.flags.some((flag) => flag.id === "parse")).toBe(false);
    expect(report.flags.some((flag) => flag.id === "encrypted")).toBe(false);

    expect(errors).toEqual([]);
  });

  test("detects the real AcroForm fields in form.pdf", async ({ page }) => {
    await openTool(page, "inspect-pdf");
    await uploadTool(page, fixture("form.pdf"));
    await waitSuccess(page, /Structural red flags/);

    await expect(page.getByRole("heading", { name: "Forms & signatures" }).first()).toBeVisible();

    const jsonFile = await saveDownload(page, "inspect-form", /JSON report/);
    const report = JSON.parse(await fs.readFile(jsonFile, "utf8")) as {
      summary: { pages: number };
      sections: { id: string; rows: { label: string; value: string }[] }[];
    };
    expect(report.summary.pages).toBe(1);
    const forms = report.sections.find((section) => section.id === "forms");
    expect(forms).toBeTruthy();
    const rowValue = (label: string) => forms!.rows.find((row) => row.label === label)?.value ?? "";
    expect(rowValue("AcroForm fields")).toBe("4");
    // PRODUCT BUG (src/tools/Knowledge.tsx:1174): field type names are taken from
    // `field.constructor.name`, which the production minifier renames, so the report
    // shows "Xr 2 · zr 1 · pr 1" instead of "Text 2 · Dropdown 1 · CheckBox 1".
    // These assertions are intentionally left failing until the product is fixed.
    expect(rowValue("Field types")).toContain("Text 2");
    expect(rowValue("Field types")).toContain("Dropdown 1");
    expect(rowValue("Field types")).toContain("CheckBox 1");
  });
});

/* ================================================================== *
 * 3. Find & Redact
 * ================================================================== */

test.describe("find-redact", () => {
  test("scans a custom regex, truly removes the token from the flattened page and keeps untouched text", async ({ page }) => {
    await openTool(page, "find-redact");
    await uploadTool(page, fixture("sample.pdf"));
    await waitSuccess(page, /What to look for/);

    // Enable only the custom regex and target the fixture's account number.
    await page.getByRole("button", { name: "Custom", exact: true }).click();
    await page.locator("#custom-redact-pattern").fill("99887766");
    await clickAction(page, "Find matches");

    await expect(page.getByText("3 matches").first()).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText("3 selected").first()).toBeVisible();
    // Every hit is listed with the matched value highlighted in the snippet.
    await expect(page.locator("mark").filter({ hasText: "99887766" }).first()).toBeVisible();
    await expect(page.locator("mark").filter({ hasText: "99887766" })).toHaveCount(3);

    // Keep only page 1 selected so pages 2–3 stay untouched and verifiable.
    await clickAction(page, "Clear");
    await expect(page.getByText("0 selected").first()).toBeVisible();
    await page.getByRole("checkbox", { name: /on page 1$/ }).click();
    await expect(page.getByText("1 selected").first()).toBeVisible();
    const apply = page.getByRole("button", { name: /^Apply 1 redaction$/ });
    await expect(apply).toBeVisible();
    await apply.click();

    await waitSuccess(page, /Redactions applied/);
    await expect(page.getByText(/1 page flattened · 1 match permanently removed · 2 pages kept with selectable text/).first()).toBeVisible();

    const redacted = await saveDownload(page, "find-redact", PDF_DOWNLOAD);
    expect(await pdfPages(redacted)).toBe(3);
    const pages = await pdfText(redacted);
    // The affected page was rebuilt as an image: no text layer, token genuinely gone.
    expect(pages[0].replace(/\s/g, "")).toBe("");
    expect(pages[0]).not.toContain("99887766");
    // The untouched pages keep their real text — including the token we did not select.
    expect(pages[1]).toContain("Quarterly Inventory Report");
    expect(pages[1]).toContain("99887766");
    expect(pages[2]).toContain("Quarterly Inventory Report");
    expect(pages[2]).toContain(SAMPLE_SECRET);

    // The redaction report lists counts only — never the sensitive values.
    const reportFile = await saveDownload(page, "find-redact-report", /redaction report/);
    const report = await fs.readFile(reportFile, "utf8");
    expect(report).toContain("File: sample.pdf");
    expect(report).toContain("Matches removed: 1");
    expect(report).toContain("Pages affected: 1 (pages 1)");
    expect(report).toContain("Custom regular expression: 1");
    expect(report).toContain("Page 1: 1");
    expect(report).not.toContain("99887766");
    expect(report).toContain("No matched values are included in this report.");
  });
});

/* ================================================================== *
 * 4. Sanitize PDF
 * ================================================================== */

test.describe("sanitize", () => {
  test("removes only the Info metadata when toggled, verifies the report and keeps document content", async ({ page }) => {
    await openTool(page, "sanitize");
    await uploadTool(page, fixture("sample.pdf"));
    await waitSuccess(page, /What to remove/);

    // Turn everything off, then enable metadata removal only — exercises the toggles.
    await clickAction(page, "Disable all");
    await page.getByRole("switch", { name: "Document metadata", exact: true }).click();
    const run = page.getByRole("button", { name: /^Remove 1 selected structure$/ });
    await expect(run).toBeVisible();
    await run.click();

    await waitSuccess(page, /Sanitized copy ready and verified/);
    // The findings list must report what was found and removed.
    const finding = page.locator("li").filter({ hasText: "Document metadata" }).first();
    await expect(finding.getByText("1 found")).toBeVisible();
    await expect(finding.getByText("1 removed")).toBeVisible();
    await expect(finding.getByText(/Info dictionary keys: .*Producer/)).toBeVisible();

    const sanitized = await saveDownload(page, "sanitize", PDF_DOWNLOAD);
    const bytes = new Uint8Array(await fs.readFile(sanitized));
    expect(await pdfPages(sanitized)).toBe(3);

    // Reload with pdf-lib without adding metadata back: the Info dictionary is gone.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(doc.getTitle()).toBeUndefined();
    expect(doc.getAuthor()).toBeUndefined();
    expect(doc.getSubject()).toBeUndefined();
    expect(doc.getKeywords()).toBeUndefined();
    expect(doc.getCreator()).toBeUndefined();
    expect(doc.getProducer()).toBeUndefined();
    expect(doc.getCreationDate()).toBeUndefined();
    expect(doc.getModificationDate()).toBeUndefined();
    expect(Buffer.from(bytes).toString("latin1")).not.toContain("/Producer");
    expect(Buffer.from(bytes).toString("latin1")).not.toContain("Hopding");

    // Only metadata was removed: the page content text layer is untouched.
    const text = (await pdfText(sanitized)).join(" ");
    expect(text).toContain("Quarterly Inventory Report");
    expect(text).toContain(SAMPLE_SECRET);

    // The downloadable report lists the removed structure.
    const reportFile = await saveDownload(page, "sanitize-report", /sanitization report/);
    const report = await fs.readFile(reportFile, "utf8");
    expect(report).toContain("File: sample.pdf");
    expect(report).toContain("Structures found: 1");
    expect(report).toContain("Structures removed: 1");
    expect(report).toContain("Document metadata: found 1, removed 1");
    expect(report).toMatch(/Info dictionary keys: .*Producer/);
  });
});

/* ================================================================== *
 * 5. Edit Bookmarks
 * ================================================================== */

test.describe("bookmarks", () => {
  test("writes a real outline with titles and page targets, then reopens to 3 pages", async ({ page }) => {
    await openTool(page, "bookmarks");
    await uploadTool(page, fixture("sample.pdf"));
    await expect(page.getByText(/No bookmarks yet/)).toBeVisible({ timeout: 30_000 });

    // Add three hand-written bookmarks pointing at pages 1, 2 and 3.
    const add = page.getByRole("button", { name: "Add bookmark", exact: true });
    for (let index = 0; index < 3; index++) await add.click();
    const chapters = ["Chapter One", "Chapter Two", "Chapter Three"];
    for (let index = 0; index < chapters.length; index++) {
      await page.getByLabel(`Bookmark ${index + 1} title`).fill(chapters[index]);
      await page.getByLabel(`Target page for bookmark ${index + 1}`).fill(String(index + 1));
    }
    await expect(page.getByText("3 bookmarks").first()).toBeVisible();

    await clickAction(page, "Save bookmarks");
    await waitSuccess(page, /Bookmarks saved/);
    await expect(page.getByText(/3 bookmarks · 3 pages/).first()).toBeVisible();

    const bookmarked = await saveDownload(page, "bookmarks", /^Download/);
    expect(await pdfPages(bookmarked)).toBe(3);

    // Independent read of the outline with PDF.js getOutline().
    const outline = await pdfOutline(bookmarked);
    expect(outline.map((entry) => entry.title)).toEqual(chapters);
    expect(outline.map((entry) => entry.page)).toEqual([1, 2, 3]);
  });
});

/* ================================================================== *
 * 6. Split by Bookmarks
 * ================================================================== */

test.describe("split-bookmarks", () => {
  test("splits a bookmarked PDF into one section per top-level bookmark with correct page ranges", async ({ page }) => {
    const bookmarked = await createBookmarkedSample(page);

    await openTool(page, "split-bookmarks");
    await uploadTool(page, bookmarked);
    await expect(page.getByText("3 bookmarks").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("3 PDFs in the ZIP").first()).toBeVisible();
    // The computed section table shows one row per bookmark.
    for (const chapter of ["Chapter One", "Chapter Two", "Chapter Three"]) {
      await expect(page.getByRole("cell", { name: chapter }).first()).toBeVisible();
    }
    await expect(page.getByText(/3 of 3 pages included/).first()).toBeVisible();

    await clickAction(page, /^Split into 3 PDFs$/);
    await waitSuccess(page, /3 section PDFs ready/);

    const zip = await saveDownload(page, "split-bookmarks", /^Download/);
    const names = (await zipFiles(zip)).filter((name) => /\.pdf$/i.test(name));
    expect(names).toHaveLength(3);

    const archive = await JSZip.loadAsync(await fs.readFile(zip));
    for (const [index, chapter] of ["Chapter One", "Chapter Two", "Chapter Three"].entries()) {
      const entryName = names.find((name) => name.includes(chapter));
      expect(entryName, `ZIP entry for ${chapter}`).toBeTruthy();
      const bytes = await archive.files[entryName!].async("nodebuffer");
      const doc = await PDFDocument.load(bytes, { updateMetadata: false });
      // Every section covers exactly one page, in bookmark order.
      expect(doc.getPageCount()).toBe(1);
      expect(doc.getTitle()).toContain(chapter);
      // The split uses copyPages, so the page text survives byte-for-byte.
      const sectionFile = path.join(OUT, `split-section-${process.pid}-${index}.pdf`);
      await fs.writeFile(sectionFile, bytes);
      const text = (await pdfText(sectionFile)).join(" ");
      expect(text).toContain("Quarterly Inventory Report");
    }
  });

  test("shows the empty-outline state for an unbookmarked PDF", async ({ page }) => {
    await openTool(page, "split-bookmarks");
    await uploadTool(page, fixture("sample.pdf"));
    await expect(page.getByText(/This PDF has no bookmarks/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Create bookmarks for this file" })).toBeVisible();
    // No split action must be offered without an outline.
    await expect(page.getByRole("button", { name: /^Split into/ })).toHaveCount(0);
  });
});

/* ================================================================== *
 * 7. Edit Metadata
 * ================================================================== */

test.describe("metadata", () => {
  test("writes title and author into the output's Info dictionary", async ({ page }) => {
    await openTool(page, "metadata");
    await uploadTool(page, fixture("sample.pdf"));
    // Values load asynchronously; wait for the existing Producer to populate.
    await expect(page.locator("#meta-producer")).toHaveValue(/pdf-lib/, { timeout: 30_000 });

    await page.locator("#meta-title").fill("Q3 Audit Report");
    await page.locator("#meta-author").fill("Paperly QA");
    await clickAction(page, /^Save metadata & download$/);
    await waitSuccess(page, /Metadata updated/);

    const edited = await saveDownload(page, "metadata", /^Download/);
    const doc = await PDFDocument.load(new Uint8Array(await fs.readFile(edited)), { updateMetadata: false });
    expect(doc.getTitle()).toBe("Q3 Audit Report");
    expect(doc.getAuthor()).toBe("Paperly QA");
    expect(doc.getPageCount()).toBe(3);
    // Content is untouched by a metadata rewrite.
    const text = (await pdfText(edited)).join(" ");
    expect(text).toContain("Quarterly Inventory Report");
  });

  test("clear-all empties every standard Info field in the output bytes", async ({ page }) => {
    await openTool(page, "metadata");
    await uploadTool(page, fixture("sample.pdf"));
    await expect(page.locator("#meta-producer")).toHaveValue(/pdf-lib/, { timeout: 30_000 });

    await clickAction(page, "Clear all standard metadata");
    await waitSuccess(page, /Metadata updated/);
    await expect(page.getByText(/Cleared 4 standard fields/).first()).toBeVisible();

    const cleared = await saveDownload(page, "metadata-clear", /^Download/);
    const bytes = new Uint8Array(await fs.readFile(cleared));
    expect(await pdfPages(cleared)).toBe(3);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(doc.getTitle()).toBeUndefined();
    expect(doc.getAuthor()).toBeUndefined();
    expect(doc.getSubject()).toBeUndefined();
    expect(doc.getKeywords()).toBeUndefined();
    expect(doc.getCreator()).toBeUndefined();
    expect(doc.getProducer()).toBeUndefined();
    expect(doc.getCreationDate()).toBeUndefined();
    expect(doc.getModificationDate()).toBeUndefined();
    expect(Buffer.from(bytes).toString("latin1")).not.toContain("/Producer");
  });
});

/* ================================================================== *
 * 8. Tables to CSV
 * ================================================================== */

test.describe("tables-to-csv", () => {
  test("extracts a generated table, previews its cells and exports exact RFC-4180 CSV", async ({ page }) => {
    const tablePdf = await makeTablePdf();

    await openTool(page, "tables-to-csv");
    await uploadTool(page, tablePdf);
    await waitSuccess(page, /Extract tables/);
    await clickAction(page, "Extract tables");

    // Detection result: a single 4 × 4 table on page 1.
    await expect(page.getByText("Page 1 · Table 1").first()).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText("4 × 4").first()).toBeVisible();
    await expect(page.getByText("100% filled").first()).toBeVisible();
    // Preview cells contain the real values, including the comma-bearing cell.
    await expect(page.getByRole("cell", { name: "Product" }).first()).toBeVisible();
    await expect(page.getByRole("cell", { name: "Paper, A4" }).first()).toBeVisible();
    await expect(page.getByRole("cell", { name: "Unit price" }).first()).toBeVisible();
    await expect(page.getByRole("cell", { name: "32" }).first()).toBeVisible();

    const csvFile = await saveDownload(page, "tables", /^CSV$/);
    const csv = await fs.readFile(csvFile, "utf8");
    const expected = [
      "Product,Region,Units,Unit price",
      '"Paper, A4",North,1200,4.5',
      "Folders,South,600,1.2",
      "Ink,West,85,32",
    ].join("\r\n") + "\r\n";
    // Exact bytes: RFC-4180 CRLF records and a quoted comma field.
    expect(csv).toBe(expected);
    expect(csv).not.toContain("﻿"); // no BOM
  });
});

/* ================================================================== *
 * 9. Offline / PWA
 * ================================================================== */

test.describe("offline", () => {
  test("the app shell still renders after an offline reload once the service worker is ready", async ({ page, context }) => {
    await page.goto("/");
    await expect(page.locator("h1").first()).toContainText("Every PDF tool");

    // Registration is deferred to the load event; ready() resolves once the
    // worker is installed, its precache finished and it is active.
    const ready = await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) return false;
      const timeout = new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), 25_000));
      const registration = navigator.serviceWorker.ready.then(() => true).catch(() => false);
      return Promise.race([registration, timeout]);
    });
    test.skip(!ready, "No service worker registration in this browser context — offline support not testable");

    // The precache must contain the app shell and the worker must be in control
    // before we cut the network, otherwise the reload proves nothing.
    const preconditions = await page.evaluate(async () => {
      const cacheNames = await caches.keys();
      const precache = cacheNames.find((name) => name.startsWith("paperly-precache"));
      if (!precache) return { precache: false, shell: false, controlled: false };
      const cache = await caches.open(precache);
      const shell = await cache.match("/index.html");
      return { precache: true, shell: Boolean(shell), controlled: Boolean(navigator.serviceWorker.controller) };
    });
    expect(preconditions.precache).toBe(true);
    expect(preconditions.shell).toBe(true);
    if (!preconditions.controlled) await page.waitForTimeout(1500);

    await context.setOffline(true);
    try {
      await page.reload();
      await expect(page.locator("h1").first()).toContainText("Every PDF tool", { timeout: 60_000 });
      await expect(page.locator("#root")).not.toBeEmpty();
    } finally {
      await context.setOffline(false);
    }
  });
});
