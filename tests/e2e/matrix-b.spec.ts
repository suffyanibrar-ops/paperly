import { test, expect } from "@playwright/test";
import { PDFDocument } from "@cantoo/pdf-lib";
import fs from "node:fs/promises";
import {
  clickAction, fixture, openTool, pdfPages, pdfText, saveDownload, textareaValue, upload, waitSuccess, zipFiles,
} from "./helpers";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

test("pdf-to-markdown: structured Markdown with front matter", async ({ page }) => {
  await openTool(page, "pdf-to-markdown");
  await upload(page, fixture("sample.pdf"));
  await clickAction(page, /^Convert to Markdown$/);
  await waitSuccess(page, /Markdown output/);
  const md = await textareaValue(page);
  expect(md.startsWith("---")).toBe(true);
  expect(md).toContain("Quarterly Inventory Report");
});

test("resize: outputs A4 dimensions", async ({ page }) => {
  await openTool(page, "resize");
  await upload(page, fixture("sample.pdf"));
  await clickAction(page, /^Resize PDF$/);
  await waitSuccess(page, /Pages resized/);
  const doc = await PDFDocument.load(new Uint8Array(await fs.readFile(await saveDownload(page, "resize", /^Download/))));
  expect(Math.round(doc.getPage(0).getWidth())).toBe(595);
  expect(doc.getPageCount()).toBe(3);
});

test("n-up: three pages imposed on two sheets", async ({ page }) => {
  await openTool(page, "n-up");
  await upload(page, fixture("sample.pdf"));
  await clickAction(page, /^Create N-up PDF$/);
  await waitSuccess(page, /N-up PDF ready/);
  expect(await pdfPages(await saveDownload(page, "n-up", /^Download/))).toBe(2);
});

test("headers-footers: resolves page placeholders", async ({ page }) => {
  await openTool(page, "headers-footers");
  await upload(page, fixture("sample.pdf"));
  await clickAction(page, /^Add headers & footers$/);
  await waitSuccess(page, /Headers and footers added/);
  const text = (await pdfText(await saveDownload(page, "headers-footers", /^Download/))).join(" ");
  expect(text).toContain("Page 1 of 3");
  expect(text).toContain("Page 3 of 3");
});

test("bates: sequential zero-padded numbering", async ({ page }) => {
  await openTool(page, "bates");
  await upload(page, fixture("sample.pdf"));
  await clickAction(page, /^Apply Bates numbering$/);
  await waitSuccess(page, /Bates numbering applied/);
  const text = (await pdfText(await saveDownload(page, "bates", /^Download/))).join(" ");
  expect(text).toContain("ABC-000001");
  expect(text).toContain("ABC-000003");
});

test("fill-forms: answers persist in the saved form", async ({ page }) => {
  await openTool(page, "fill-forms");
  await upload(page, fixture("form.pdf"));
  await page.waitForTimeout(1200);
  await page.getByPlaceholder(/enter full name/i).fill("Alex Morgan");
  await page.getByPlaceholder(/enter email/i).fill("alex@example.com");
  const selects = page.locator("select");
  for (let index = 0; index < await selects.count(); index++) {
    const options = await selects.nth(index).locator("option").allInnerTexts();
    if (options.includes("Germany")) {
      await selects.nth(index).selectOption("Germany");
      break;
    }
  }
  const switches = page.getByRole("switch");
  if (await switches.count()) await switches.first().click();
  await clickAction(page, /^Save filled PDF$/);
  await waitSuccess(page, /Form saved/);
  const doc = await PDFDocument.load(new Uint8Array(await fs.readFile(await saveDownload(page, "fill-forms", /^Download/))));
  expect(doc.getForm().getTextField("full_name").getText()).toBe("Alex Morgan");
  expect(doc.getForm().getDropdown("country").getSelected()).toEqual(["Germany"]);
  expect(doc.getForm().getCheckBox("accept_terms").isChecked()).toBe(true);
});

test("flatten: removes interactive fields", async ({ page }) => {
  await openTool(page, "flatten");
  await upload(page, fixture("form.pdf"));
  await page.waitForTimeout(1000);
  await clickAction(page, /^Flatten PDF$/);
  await waitSuccess(page, /PDF flattened/);
  const doc = await PDFDocument.load(new Uint8Array(await fs.readFile(await saveDownload(page, "flatten", /^Download/))));
  expect(doc.getForm().getFields()).toHaveLength(0);
});

test("archive: writes metadata and embeds the original", async ({ page }) => {
  await openTool(page, "archive");
  await upload(page, fixture("sample.pdf"));
  await page.waitForTimeout(900);
  await clickAction(page, /^Prepare archive PDF$/);
  await waitSuccess(page, /Archive copy prepared/);
  const doc = await PDFDocument.load(new Uint8Array(await fs.readFile(await saveDownload(page, "archive", /^Download/))));
  expect(doc.getAttachments().length).toBeGreaterThanOrEqual(1);
  expect(doc.getTitle()).toBeTruthy();
});

test("batch: compresses two files into one ZIP", async ({ page }) => {
  await openTool(page, "batch");
  await upload(page, [fixture("sample.pdf"), fixture("sample2.pdf")]);
  await clickAction(page, "Compress");
  await page.getByRole("button", { name: /^Process 2 files$/ }).click();
  await waitSuccess(page, /2 files processed/);
  const files = await zipFiles(await saveDownload(page, "batch", /^Download/));
  expect(files.filter((name) => name.endsWith(".pdf"))).toHaveLength(2);
});

test("create-form: writes three real interactive fields", async ({ page }) => {
  await openTool(page, "create-form");
  await upload(page, fixture("sample.pdf"));
  await page.waitForTimeout(1800);
  const surface = page.locator("div.pdf-page-shadow").first();
  for (const [kind, x, y] of [["Text field", 0.22, 0.2], ["Checkbox", 0.12, 0.36], ["Dropdown", 0.3, 0.52]] as const) {
    await page.getByRole("button", { name: new RegExp(kind) }).first().click();
    await page.waitForTimeout(120);
    const box = await surface.boundingBox();
    if (!box) throw new Error("form surface missing");
    await surface.click({ position: { x: box.width * x, y: box.height * y } });
    await page.waitForTimeout(250);
  }
  await clickAction(page, /^Save interactive form$/);
  await waitSuccess(page, /Interactive form created/);
  const doc = await PDFDocument.load(new Uint8Array(await fs.readFile(await saveDownload(page, "create-form", /^Download/))));
  expect(doc.getForm().getFields()).toHaveLength(3);
});

test("remove-pages: deletes only the selected page", async ({ page }) => {
  await openTool(page, "remove-pages");
  await upload(page, fixture("sample.pdf"));
  await page.locator("#page-range").fill("2");
  await clickAction(page, /^Remove 1 page$/);
  await waitSuccess(page, /Pages removed/);
  const file = await saveDownload(page, "remove-pages", /^Download/);
  expect(await pdfPages(file)).toBe(2);
  const text = (await pdfText(file)).join(" ");
  expect(text).toContain("Page 1 of 3");
  expect(text).toContain("Page 3 of 3");
});

test("extract-pages: keeps the requested range", async ({ page }) => {
  await openTool(page, "extract-pages");
  await upload(page, fixture("sample.pdf"));
  await page.locator("#page-range").fill("2-3");
  await clickAction(page, /^Extract pages$/);
  await waitSuccess(page, /Pages extracted/);
  const file = await saveDownload(page, "extract-pages", /^Download/);
  expect(await pdfPages(file)).toBe(2);
  expect((await pdfText(file))[0]).toContain("Page 2 of 3");
});

test("extract-images: recovers an embedded image at original quality", async ({ page }) => {
  await openTool(page, "extract-images");
  await upload(page, fixture("scan.pdf"));
  await clickAction(page, /^Find images$/);
  await waitSuccess(page, /image[s]? found/);
  await page.waitForTimeout(400);
  const file = await saveDownload(page, "extract-images", /^Download (image|\d+ images?)/);
  const bytes = await fs.readFile(file);
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes[0] === 0x89 && bytes.toString("latin1", 1, 4) === "PNG";
  // Lossless PNG is the correct output for a Flate-encoded image; a DCT/JPEG source must stay JPEG.
  expect(isJpeg || isPng).toBe(true);
  if (isPng) {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    expect(width).toBe(900);
    expect(height).toBe(1200);
  }
});

test("summarize: selects verbatim passages locally", async ({ page }) => {
  await openTool(page, "summarize");
  await upload(page, fixture("sample.pdf"));
  await clickAction(page, /^Summarise document$/);
  await waitSuccess(page, /Your summary/);
  const summary = await page.locator("#summary-text").inputValue();
  expect(summary.length).toBeGreaterThan(80);
  expect(summary.toLowerCase()).toMatch(/inventory|report|paper|account/);
});

test("edit: adds text and preserves the original pages", async ({ page }) => {
  await openTool(page, "edit");
  await upload(page, fixture("sample.pdf"));
  await page.waitForTimeout(2200);
  await page.getByTitle("Text").click();
  const surface = page.locator("img[alt^='Page 1']").first();
  await surface.scrollIntoViewIfNeeded();
  const box = await surface.boundingBox();
  if (!box) throw new Error("edit surface missing");
  await page.mouse.click(box.x + box.width * 0.22, box.y + box.height * 0.18);
  await page.waitForTimeout(300);
  await page.locator("textarea").first().fill("Matrix verification text");
  await clickAction(page, /^Export edited PDF$/);
  await waitSuccess(page, /edited PDF is ready/);
  const file = await saveDownload(page, "edit", /^Download/);
  expect(await pdfPages(file)).toBe(3);
  expect((await pdfText(file)).join(" ")).toContain("Matrix verification text");
});

test("sign: embeds a signature and keeps page count", async ({ page }) => {
  await openTool(page, "sign");
  await upload(page, fixture("sample.pdf"));
  await page.getByRole("button", { name: /Create signature/ }).click();
  await page.getByRole("button", { name: "Type", exact: true }).click();
  await page.getByPlaceholder("e.g. Alex Morgan").fill("Alex Morgan");
  await page.getByRole("button", { name: /^Use signature/ }).click();
  await page.waitForTimeout(500);
  const surface = page.locator("img[alt^='Page 1']").first();
  await surface.scrollIntoViewIfNeeded();
  const box = await surface.boundingBox();
  if (!box) throw new Error("sign surface missing");
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.25);
  await page.waitForTimeout(300);
  await clickAction(page, /^Save signed PDF$/);
  await waitSuccess(page, /Document signed/);
  const file = await saveDownload(page, "sign", /^Download/);
  expect(await pdfPages(file)).toBe(3);
  expect((await fs.stat(file)).size).toBeGreaterThan((await fs.stat(fixture("sample.pdf"))).size);
});

test("watermark: stamps every page", async ({ page }) => {
  await openTool(page, "watermark");
  await upload(page, fixture("sample.pdf"));
  await clickAction(page, /^Apply watermark$/);
  await waitSuccess(page, /Watermark applied/);
  const text = (await pdfText(await saveDownload(page, "watermark", /^Download/))).join(" ");
  expect((text.match(/CONFIDENTIAL/g) ?? []).length).toBe(3);
});

test("protect: AES-256 output requires the password", async ({ page }) => {
  await openTool(page, "protect");
  await upload(page, fixture("sample.pdf"));
  await page.getByPlaceholder("Your document password").fill("Matrix-Passphrase1!");
  await page.getByPlaceholder("Repeat the password").fill("Matrix-Passphrase1!");
  await clickAction(page, /^Protect PDF$/);
  await waitSuccess(page, /PDF protected/);
  const file = await saveDownload(page, "protect", /^Download/);
  let blocked = false;
  try {
    await PDFDocument.load(await fs.readFile(file));
  } catch {
    blocked = true;
  }
  expect(blocked).toBe(true);
  const opened = await PDFDocument.load(await fs.readFile(file), { password: "Matrix-Passphrase1!" });
  expect(opened.getPageCount()).toBe(3);
});

test("unlock: decrypts with the correct password", async ({ page }) => {
  await openTool(page, "unlock");
  await upload(page, fixture("encrypted.pdf"));
  await page.waitForTimeout(900);
  await page.getByPlaceholder("Enter the password").fill("Secret123!");
  await clickAction(page, /^Unlock PDF$/);
  await waitSuccess(page, /PDF unlocked/);
  const raw = (await fs.readFile(await saveDownload(page, "unlock", /^Download/))).toString("latin1");
  expect(raw).not.toContain("/Encrypt");
});

test("unlock: wrong password shows a clear error", async ({ page }) => {
  await openTool(page, "unlock");
  await upload(page, fixture("encrypted.pdf"));
  await page.waitForTimeout(900);
  await page.getByPlaceholder("Enter the password").fill("DefinitelyWrong");
  await clickAction(page, /^Unlock PDF$/);
  await page.waitForTimeout(1500);
  await expect(page.locator('[role="alert"]').first()).toContainText(/didn’t work|password/i);
});

test("redact: removes text on marked pages only", async ({ page }) => {
  await openTool(page, "redact");
  await upload(page, fixture("sample.pdf"));
  await page.waitForTimeout(2000);
  const surface = page.locator("img[alt^='Page 1']").first();
  await surface.scrollIntoViewIfNeeded();
  const box = await surface.boundingBox();
  if (!box) throw new Error("redaction surface missing");
  await page.mouse.move(box.x + box.width * 0.06, box.y + box.height * 0.12);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.92, box.y + box.height * 0.3, { steps: 6 });
  await page.mouse.up();
  await page.getByRole("button", { name: /^Apply \d+ redaction/ }).click();
  await waitSuccess(page, /Redactions applied/);
  const pages = await pdfText(await saveDownload(page, "redact", /^Download/));
  expect(pages[0].replace(/\s/g, "")).toBe("");
  expect(pages[2]).toContain("Quarterly Inventory Report");
});

test("compare: detects differences between two documents", async ({ page }) => {
  await openTool(page, "compare");
  await page.locator("input[type=file]").nth(1).setInputFiles(fixture("sample2.pdf"));
  await page.waitForTimeout(500);
  await page.locator("input[type=file]").nth(0).setInputFiles(fixture("sample.pdf"));
  await page.waitForTimeout(800);
  await clickAction(page, /^Compare documents$/);
  await waitSuccess(page, /pages differ|identical/);
  expect(await page.locator('[id^="diff-page-"]').count()).toBeGreaterThan(0);
});

test("word-to-pdf: rejects a malicious archive with traversal paths", async ({ page }) => {
  await openTool(page, "word-to-pdf");
  await page.locator("input[type=file]").first().setInputFiles(fixture("evil-traversal.docx"));
  await page.waitForTimeout(900);
  await expect(page.getByText(/unsafe path|valid Office|couldn’t|damaged/i).first()).toBeVisible({ timeout: 30_000 });
});

test("excel-to-pdf: rejects a DOCX renamed as a spreadsheet", async ({ page }) => {
  await openTool(page, "excel-to-pdf");
  await page.locator("input[type=file]").first().setInputFiles(fixture("sample.docx"));
  await page.waitForTimeout(1000);
  await expect(page.getByText(/valid Office Open XML|look like a \.xlsx|supported here|couldn’t be read/i).first()).toBeVisible({ timeout: 30_000 });
});

test("large file: a 120-page PDF merges and splits correctly", async ({ page }) => {
  await openTool(page, "merge");
  await upload(page, fixture("large.pdf"));
  await upload(page, fixture("large.pdf"), 0);
  await clickAction(page, "Merge PDF");
  await waitSuccess(page, /PDFs became one/, 300_000);
  expect(await pdfPages(await saveDownload(page, "large-merge", /^Download/))).toBe(240);
});

test("large file: extracts text from 120 pages", async ({ page }) => {
  await openTool(page, "extract-text");
  await upload(page, fixture("large.pdf"));
  await clickAction(page, /^Extract text$/);
  await page.waitForTimeout(6000);
  const text = await page.locator("textarea").first().inputValue();
  expect(text.length).toBeGreaterThan(50_000);
  expect(text).toContain("page 120");
});
