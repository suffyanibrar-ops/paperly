import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "@cantoo/pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const fixture = (name: string) => path.resolve("tests/fixtures", name);
const OUT = path.resolve("tests/e2e-output");

async function download(page: import("@playwright/test").Page, name: RegExp) {
  const [event] = await Promise.all([
    page.waitForEvent("download", { timeout: 120_000 }),
    page.getByRole("button", { name }).last().click(),
  ]);
  await fs.mkdir(OUT, { recursive: true });
  const file = path.join(OUT, event.suggestedFilename());
  await event.saveAs(file);
  return file;
}

async function pageTexts(file: string) {
  const task = pdfjs.getDocument({ data: new Uint8Array(await fs.readFile(file)), useSystemFonts: true, isEvalSupported: false });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
  }
  await task.destroy();
  return pages;
}

test.describe("critical PDF workflows", () => {
  test("home renders the full catalogue without console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto("/");
    await expect(page.locator("h1")).toContainText("Every PDF tool");
    await page.goto("/#/tools");
    await expect(page.locator('a[href^="#/tool/"]').first()).toBeVisible();
    const unique = await page.locator('a[href^="#/tool/"]').evaluateAll((els) => new Set(els.map((el) => el.getAttribute("href"))).size);
    expect(unique).toBe(50);
    expect(errors).toEqual([]);
  });

  test("prerendered tool page is crawlable with unique metadata and structured data", async ({ request }) => {
    const response = await request.get("/tool/merge");
    expect(response.status()).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title>Merge PDF — free and private, right in your browser | Paperly PDF</title>");
    expect(html).toContain('<link rel="canonical" href="https://paperlypdf.netlify.app/tool/merge" />');
    expect(html).toMatch(/<h1>Merge PDF<\/h1>/);
    expect(html).toMatch(/application\/ld\+json/);
    expect(await (await request.get("/robots.txt")).text()).toContain("Sitemap:");
    const xml = await (await request.get("/sitemap.xml")).text();
    expect((xml.match(/<url>/g) ?? []).length).toBeGreaterThanOrEqual(62);
    const headers = (await request.get("/")).headers();
    expect(headers["content-security-policy"]).toContain("object-src 'none'");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["strict-transport-security"]).toContain("max-age=31536000");
    const bundle = await (await request.get("/")).text();
    const firstTitle = bundle.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
    expect(firstTitle).toContain("Paperly");
  });

  test("merge produces a valid five-page PDF", async ({ page }) => {
    await page.goto("/#/tool/merge");
    await expect(page.locator("h1").first()).toContainText("Merge PDF");
    await page.locator("input[type=file]").first().setInputFiles(fixture("sample.pdf"));
    await page.waitForTimeout(1500);
    await page.locator("input[type=file]").last().setInputFiles(fixture("sample2.pdf"));
    await page.waitForTimeout(1800);
    await page.getByRole("button", { name: /^Merge PDF$/ }).click();
    await expect(page.getByText(/PDFs became one/)).toBeVisible();
    const file = await download(page, /^Download/);
    const doc = await PDFDocument.load(await fs.readFile(file));
    expect(doc.getPageCount()).toBe(5);
  });

  test("a text file renamed to .pdf is rejected before parsing", async ({ page }) => {
    await page.goto("/#/tool/merge");
    await expect(page.locator("h1").first()).toContainText("Merge PDF");
    await page.locator("input[type=file]").first().setInputFiles(fixture("fake.pdf"));
    await expect(page.locator('[role="alert"]')).toContainText(/doesn’t look like a real PDF/);
    await expect(page.getByRole("button", { name: /^Merge PDF$/ })).toBeDisabled();
  });

  test("malicious HTML is sanitised and no remote resource is requested", async ({ page }) => {
    const remote: string[] = [];
    page.on("request", (request) => { if (request.url().includes("evil.test")) remote.push(request.url()); });
    await page.goto("/#/tool/html-to-pdf");
    await expect(page.locator("h1").first()).toContainText("HTML to PDF");
    await page.locator("#html-source").fill(`<h1>Quarterly report</h1><script>window.__pwned=true</script>
      <iframe src="https://evil.test/frame"></iframe>
      <img src="https://evil.test/tracker.png" onerror="window.__pwned=true">
      <div style="color:#123;position:fixed;background:url(https://evil.test/bg)">Styled</div>
      <table><tr><th>Metric</th><th>Value</th></tr><tr><td>Uptime</td><td>99.9%</td></tr></table>`);
    await expect(page.getByText(/removed by the sanitiser/i).first()).toBeVisible();
    await page.getByRole("button", { name: /^Convert HTML to PDF$/ }).click();
    await expect(page.getByText(/HTML converted to PDF/)).toBeVisible({ timeout: 120_000 });
    expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBeUndefined();
    expect(remote).toEqual([]);
    const file = await download(page, /^Download/);
    const doc = await PDFDocument.load(await fs.readFile(file));
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  test("protect uses real encryption and unlock removes it with the password", async ({ page }) => {
    await page.goto("/#/tool/protect");
    await expect(page.locator("h1").first()).toContainText("Protect PDF");
    await page.locator("input[type=file]").first().setInputFiles(fixture("sample.pdf"));
    await page.waitForTimeout(1400);
    await page.getByPlaceholder("Your document password").fill("Str0ng-Passphrase!");
    await page.getByPlaceholder("Repeat the password").fill("Str0ng-Passphrase!");
    await page.getByRole("button", { name: /^Protect PDF$/ }).click();
    await expect(page.getByText(/PDF protected/)).toBeVisible();
    const protectedFile = await download(page, /^Download/);
    let blocked = false;
    try { await PDFDocument.load(await fs.readFile(protectedFile)); } catch { blocked = true; }
    expect(blocked).toBe(true);
    const opened = await PDFDocument.load(await fs.readFile(protectedFile), { password: "Str0ng-Passphrase!" });
    expect(opened.getPageCount()).toBe(3);

    await page.goto("/#/tool/unlock");
    // Tool routes are lazy-loaded: wait for the Unlock interface before attaching
    // the file, otherwise the input belongs to the outgoing Protect page.
    await expect(page.locator("h1").first()).toContainText("Unlock PDF");
    await page.locator("input[type=file]:visible").first().setInputFiles(protectedFile);
    await page.waitForTimeout(1400);
    await page.getByPlaceholder("Enter the password").fill("Str0ng-Passphrase!");
    await page.getByRole("button", { name: /^Unlock PDF$/ }).click();
    await expect(page.getByText(/PDF unlocked/)).toBeVisible();
    const unlockedFile = await download(page, /^Download/);
    expect((await fs.readFile(unlockedFile)).toString("latin1")).not.toContain("/Encrypt");
  });

  test("redaction removes underlying text on marked pages only", async ({ page }) => {
    await page.goto("/#/tool/redact");
    await expect(page.locator("h1").first()).toContainText("Redact PDF");
    await page.locator("input[type=file]").first().setInputFiles(fixture("sample.pdf"));
    await page.waitForTimeout(2200);
    const surface = page.locator("img[alt^='Page 1']").first();
    await surface.scrollIntoViewIfNeeded();
    const box = await surface.boundingBox();
    if (!box) throw new Error("redaction surface not rendered");
    await page.mouse.move(box.x + box.width * 0.06, box.y + box.height * 0.13);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.28, { steps: 6 });
    await page.mouse.up();
    await page.getByRole("button", { name: /^Apply \d+ redaction/ }).click();
    await expect(page.getByText(/Redactions applied/)).toBeVisible({ timeout: 120_000 });
    const file = await download(page, /^Download/);
    const [first, , third] = await pageTexts(file);
    expect(first.replace(/\s/g, "")).toBe("");
    expect(third).toContain("Quarterly Inventory Report");
  });

  test("batch compress returns a two-document ZIP", async ({ page }) => {
    await page.goto("/#/tool/batch");
    await expect(page.locator("h1").first()).toContainText("Batch processing");
    await page.locator("input[type=file]").first().setInputFiles([fixture("sample.pdf"), fixture("sample2.pdf")]);
    await page.waitForTimeout(1600);
    await page.getByRole("button", { name: /^Compress$/ }).click();
    await page.getByRole("button", { name: /^Process 2 files$/ }).click();
    await expect(page.getByText(/2 files processed/)).toBeVisible({ timeout: 180_000 });
    const file = await download(page, /^Download/);
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(await fs.readFile(file));
    const pdfs = Object.keys(zip.files).filter((name) => name.endsWith(".pdf"));
    expect(pdfs).toHaveLength(2);
    const first = await PDFDocument.load(await zip.files[pdfs[0]].async("nodebuffer"));
    expect(first.getPageCount()).toBe(3);
  });
});
