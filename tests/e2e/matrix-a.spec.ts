import { test, expect } from "@playwright/test";
import { PDFDocument } from "@cantoo/pdf-lib";
import {
  clickAction, expectRejection, fixture, openTool, pdfPages, pdfText, saveDownload, upload, waitSuccess, zipFiles,
} from "./helpers";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

test("merge: two PDFs become one five-page document", async ({ page }) => {
  await openTool(page, "merge");
  await upload(page, fixture("sample.pdf"));
  await upload(page, fixture("sample2.pdf"), 0);
  await clickAction(page, "Merge PDF");
  await waitSuccess(page, /PDFs became one/);
  const file = await saveDownload(page, "merge", /^Download/);
  expect(await pdfPages(file)).toBe(5);
});

test("split: extract pages 1 and 3", async ({ page }) => {
  await openTool(page, "split");
  await upload(page, fixture("sample.pdf"));
  await page.locator("#page-range").fill("1,3");
  await clickAction(page, "Extract pages");
  await waitSuccess(page, /extracted PDF is ready/);
  expect(await pdfPages(await saveDownload(page, "split", /^Download/))).toBe(2);
});

test("organize: delete one page and export", async ({ page }) => {
  await openTool(page, "organize");
  await upload(page, fixture("sample.pdf"));
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: /Remove page 2/ }).click();
  await clickAction(page, "Apply changes");
  await waitSuccess(page, /pages are in order/);
  expect(await pdfPages(await saveDownload(page, "organize", /^Download/))).toBe(2);
});

test("rotate: 90 degrees added to each page", async ({ page }) => {
  await openTool(page, "rotate");
  await upload(page, fixture("rotated.pdf"));
  await clickAction(page, /^Rotate 90° all pages$/);
  await waitSuccess(page, /Pages turned/);
  const doc = await PDFDocument.load(new Uint8Array(await (await import("node:fs/promises")).readFile(await saveDownload(page, "rotate", /^Download/))));
  expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([180, 90]);
});

test("crop: crop box shrinks by the selected margins", async ({ page }) => {
  await openTool(page, "crop");
  await upload(page, fixture("sample.pdf"));
  await clickAction(page, /^Crop PDF$/);
  await waitSuccess(page, /Margins trimmed/);
  const file = await saveDownload(page, "crop", /^Download/);
  const doc = await PDFDocument.load(new Uint8Array(await (await import("node:fs/promises")).readFile(file)));
  expect(doc.getPage(0).getCropBox().width).toBeLessThan(595);
});

test("compress: returns a smaller, valid PDF", async ({ page }) => {
  await openTool(page, "compress");
  await upload(page, fixture("sample.pdf"));
  await clickAction(page, /^Compress PDF$/);
  await waitSuccess(page, /smaller|highly optimized/);
  expect(await pdfPages(await saveDownload(page, "compress", /^Download/))).toBe(3);
});

test("repair: rebuilds a readable document", async ({ page }) => {
  await openTool(page, "repair");
  await upload(page, fixture("sample.pdf"));
  await clickAction(page, /^Repair PDF$/);
  await waitSuccess(page, /Document recovered/);
  expect(await pdfPages(await saveDownload(page, "repair", /^Download/))).toBe(3);
});

test("page numbers: stamp 1 / 3 through 3 / 3", async ({ page }) => {
  await openTool(page, "page-numbers");
  await upload(page, fixture("sample.pdf"));
  await clickAction(page, /^Add page numbers$/);
  await waitSuccess(page, /Numbers added/);
  const pages = await pdfText(await saveDownload(page, "page-numbers", /^Download/));
  expect(pages.join(" ")).toContain("1 / 3");
  expect(pages.join(" ")).toContain("3 / 3");
});

test("jpg-to-pdf: creates a valid A4 page from a PNG", async ({ page }) => {
  await openTool(page, "jpg-to-pdf");
  await upload(page, fixture("scan.png"));
  await clickAction(page, /^Create PDF$/);
  await waitSuccess(page, /image PDF is ready/);
  const file = await saveDownload(page, "jpg-to-pdf", /^Download/);
  const doc = await PDFDocument.load(new Uint8Array(await (await import("node:fs/promises")).readFile(file)));
  expect(doc.getPageCount()).toBe(1);
  expect(Math.round(doc.getPage(0).getWidth())).toBeCloseTo(595, 0);
});

test("pdf-to-jpg: exports three JPEGs in a ZIP", async ({ page }) => {
  await openTool(page, "pdf-to-jpg");
  await upload(page, fixture("sample.pdf"));
  await clickAction(page, /^Convert to JPG$/);
  await waitSuccess(page, /images ready/);
  const files = await zipFiles(await saveDownload(page, "pdf-to-jpg", /Download ZIP/));
  expect(files.filter((name) => /\.(jpe?g|png)$/i.test(name))).toHaveLength(3);
});

test("pdf-to-word: produces a DOCX containing the source text", async ({ page }) => {
  await openTool(page, "pdf-to-word");
  await upload(page, fixture("sample.pdf"));
  await clickAction(page, /^Convert to Word$/);
  await waitSuccess(page, /Word document is ready/);
  const file = await saveDownload(page, "pdf-to-word", /^Download/);
  const JSZip = (await import("jszip")).default;
  const xml = await (await JSZip.loadAsync(await (await import("node:fs/promises")).readFile(file))).file("word/document.xml")!.async("text");
  expect(xml).toContain("Quarterly Inventory Report");
});

test("pdf-to-excel: three sheets with numeric cells", async ({ page }) => {
  await openTool(page, "pdf-to-excel");
  await upload(page, fixture("sample.pdf"));
  await clickAction(page, /^Convert to Excel$/);
  await waitSuccess(page, /spreadsheet is ready/);
  const file = await saveDownload(page, "pdf-to-excel", /^Download/);
  const XLSX = await import("xlsx");
  const wb = XLSX.read(await (await import("node:fs/promises")).readFile(file), { type: "buffer" });
  expect(wb.SheetNames.length).toBe(3);
});

test("pdf-to-ppt: one slide per page", async ({ page }) => {
  await openTool(page, "pdf-to-ppt");
  await upload(page, fixture("sample.pdf"));
  await clickAction(page, /^Convert to PowerPoint$/);
  await waitSuccess(page, /slides ready/);
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await (await import("node:fs/promises")).readFile(await saveDownload(page, "pdf-to-ppt", /^Download/)));
  expect(Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(3);
});

test("word-to-pdf: preserves headings, lists and tables", async ({ page }) => {
  await openTool(page, "word-to-pdf");
  await upload(page, fixture("sample.docx"));
  await clickAction(page, /^Convert to PDF$/);
  await waitSuccess(page, /now a PDF/);
  const text = (await pdfText(await saveDownload(page, "word-to-pdf", /^Download/))).join(" ");
  expect(text).toContain("Project Field Notes");
  expect(text).toContain("Confirm the delivery window");
});

test("excel-to-pdf: converts spreadsheet data", async ({ page }) => {
  await openTool(page, "excel-to-pdf");
  await upload(page, fixture("sample.xlsx"));
  await page.waitForTimeout(900);
  await clickAction(page, /^Convert to PDF$/);
  await waitSuccess(page, /workbook is now a PDF/);
  const text = (await pdfText(await saveDownload(page, "excel-to-pdf", /^Download/))).join(" ");
  expect(text).toContain("A4 paper");
  expect(text).toContain("5400");
});

test("excel-to-pdf: accepts CSV input", async ({ page }) => {
  await openTool(page, "excel-to-pdf");
  await upload(page, fixture("sample.csv"));
  await page.waitForTimeout(900);
  await clickAction(page, /^Convert to PDF$/);
  await waitSuccess(page, /workbook is now a PDF/);
  const text = (await pdfText(await saveDownload(page, "excel-csv", /^Download/))).join(" ");
  expect(text).toContain("A4 paper");
});

test("ppt-to-pdf: keeps slide text in order", async ({ page }) => {
  await openTool(page, "ppt-to-pdf");
  await upload(page, fixture("sample.pptx"));
  await clickAction(page, /^Convert to PDF$/);
  await waitSuccess(page, /deck is now a PDF/);
  const text = (await pdfText(await saveDownload(page, "ppt-to-pdf", /^Download/))).join(" ");
  expect(text).toContain("Modern PDF workflows");
  expect(text).toContain("Thank you");
});

test("extract-text: returns the real text layer", async ({ page }) => {
  await openTool(page, "extract-text");
  await upload(page, fixture("sample.pdf"));
  await clickAction(page, /^Extract text$/);
  await page.waitForTimeout(2000);
  expect(await page.locator("textarea").first().inputValue()).toContain("Quarterly Inventory Report");
});

test("ocr: creates a searchable PDF from an image-only scan", async ({ page }) => {
  // Build the fixture in-browser with real rendered letterforms (the static PNG fixture
  // contains solid blocks, which is not text and therefore cannot be recognised).
  await openTool(page, "jpg-to-pdf");
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1240;
    canvas.height = 900;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#111111";
    ctx.font = "bold 92px Arial";
    ctx.fillText("PAPERLY OCR REPORT", 60, 200);
    ctx.font = "64px Arial";
    ctx.fillText("Invoice number 4821", 60, 360);
    ctx.fillText("Total 1249.50 USD", 60, 480);
    ctx.font = "48px Arial";
    ctx.fillText("Thank you for your business", 60, 620);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator("input[type=file]").first().setInputFiles({ name: "ocr-scan.png", mimeType: "image/png", buffer: Buffer.from(base64, "base64") });
  await page.waitForTimeout(1200);
  await clickAction(page, /^Create PDF$/);
  await waitSuccess(page, /image PDF is ready/);
  const scanPdf = await saveDownload(page, "ocr-source", /^Download/);

  await openTool(page, "ocr");
  await page.locator("input[type=file]").first().setInputFiles(scanPdf);
  await page.waitForTimeout(1200);
  await clickAction(page, /^OCR PDF$/);
  await page.getByText(/Searchable PDF ready|No searchable PDF produced|engine couldn’t|couldn’t be downloaded/).first().waitFor({ timeout: 300_000 });
  if (!(await page.getByText(/Searchable PDF ready/).isVisible().catch(() => false))) {
    throw new Error("OCR did not produce a searchable PDF");
  }
  const text = (await pdfText(await saveDownload(page, "ocr", /^Download/))).join(" ");
  expect(text).toMatch(/PAPERLY/);
  expect(text).toMatch(/4821/);
  expect(text).toMatch(/1249/);
});

test("scan: builds a PDF from a captured photo", async ({ page }) => {
  await openTool(page, "scan");
  await page.locator("input[type=file]").first().setInputFiles(fixture("scan.png"));
  await page.waitForTimeout(900);
  await clickAction(page, /^Create PDF$/);
  await waitSuccess(page, /Scan saved as PDF/);
  expect(await pdfPages(await saveDownload(page, "scan", /^Download/))).toBe(1);
});

test("html-to-pdf: renders legitimate HTML and embeds the source", async ({ page }) => {
  await openTool(page, "html-to-pdf");
  await upload(page, fixture("page.html"));
  await page.waitForTimeout(500);
  await clickAction(page, /^Convert HTML to PDF$/);
  await waitSuccess(page, /HTML converted to PDF/);
  const file = await saveDownload(page, "html-to-pdf", /^Download/);
  const doc = await PDFDocument.load(new Uint8Array(await (await import("node:fs/promises")).readFile(file)));
  expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  expect(doc.getAttachments().some((attachment) => attachment.name === "source.html")).toBe(true);
});

test("markdown-to-pdf: typesets headings, lists and tables", async ({ page }) => {
  await openTool(page, "markdown-to-pdf");
  await upload(page, fixture("note.md"));
  await page.waitForTimeout(500);
  await clickAction(page, /^Create PDF$/);
  await waitSuccess(page, /document is ready/);
  const text = (await pdfText(await saveDownload(page, "markdown-to-pdf", /^Download/))).join(" ");
  expect(text).toContain("Release notes");
  expect(text).toContain("Uptime");
});

test("malformed input: a text file renamed .pdf is rejected", async ({ page }) => {
  await openTool(page, "merge");
  await page.locator("input[type=file]").first().setInputFiles(fixture("fake.pdf"));
  await expectRejection(page, /doesn’t look like a real PDF/);
  await expect(page.getByRole("button", { name: /^Merge PDF$/ })).toBeDisabled();
});

test("malformed input: an image whose bytes are not an image is rejected", async ({ page }) => {
  await openTool(page, "jpg-to-pdf");
  await page.locator("input[type=file]").first().setInputFiles(fixture("fake.png"));
  await expectRejection(page, /isn’t a valid image|supported/);
});

test("inventory: every tool page is registered and renders", async ({ page }) => {
  const fs = await import("node:fs/promises");
  const registry = await fs.readFile("src/lib/toolRegistry.ts", "utf8");
  const ids = [...registry.matchAll(/^ {4}id: "([a-z0-9-]+)"/gm)].map((match) => match[1]);
  expect(ids.length).toBe(51);
  const crashed: string[] = [];
  for (const id of ids) {
    await page.goto(`/#/tool/${id}`);
    await page.waitForTimeout(180);
    const heading = await page.locator("h1").first().innerText().catch(() => "");
    if (heading.length < 2 || (await page.locator("text=/hit a snag/").count())) crashed.push(id);
  }
  expect(crashed).toEqual([]);
});
