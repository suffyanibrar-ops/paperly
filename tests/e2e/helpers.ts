import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { PDFDocument } from "@cantoo/pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import JSZip from "jszip";

export const OUT = path.resolve("tests/e2e-output");
export const fixture = (name: string) => path.resolve("tests/fixtures", name);

export async function openTool(page: Page, id: string) {
  await page.goto(`/#/tool/${id}`);
  await page.waitForTimeout(500);
  await page.locator("h1").first().waitFor();
}

export async function upload(page: Page, files: string | string[], index = 0) {
  const list = Array.isArray(files) ? files : [files];
  const input = page.locator("input[type=file]").nth(index);
  await input.setInputFiles(list);
  // Wait until the tool has actually read and accepted the file(s) before moving on.
  await page.waitForTimeout(1200);
  await page.locator('[role="alert"]').first().waitFor({ state: "visible", timeout: 1200 }).catch(() => undefined);
}

export async function clickAction(page: Page, name: string | RegExp) {
  const button = typeof name === "string" ? page.getByRole("button", { name, exact: true }) : page.getByRole("button", { name });
  await button.last().click();
}

export async function waitSuccess(page: Page, pattern: RegExp, timeout = 180_000) {
  await page.getByText(pattern).first().waitFor({ timeout });
}

export async function saveDownload(page: Page, tool: string, pattern: RegExp) {
  const [event] = await Promise.all([
    page.waitForEvent("download", { timeout: 180_000 }),
    page.getByRole("button", { name: pattern }).last().click(),
  ]);
  await fs.mkdir(OUT, { recursive: true });
  const file = path.join(OUT, `${tool}-${event.suggestedFilename()}`);
  await event.saveAs(file);
  return file;
}

export async function pdfPages(file: string) {
  return (await PDFDocument.load(new Uint8Array(await fs.readFile(file)), { ignoreEncryption: true })).getPageCount();
}

export async function pdfText(file: string) {
  const task = pdfjs.getDocument({ data: new Uint8Array(await fs.readFile(file)), useSystemFonts: true, isEvalSupported: false });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" ").replace(/\s+/g, " ").trim());
  }
  await task.destroy();
  return pages;
}

export async function zipFiles(file: string) {
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  return Object.keys(zip.files).filter((name) => !zip.files[name].dir);
}

export async function zipText(file: string, entry: string) {
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  const node = zip.file(entry);
  if (!node) throw new Error(`${entry} missing from archive`);
  return node.async("text");
}

export async function textareaValue(page: Page, index = -1) {
  const areas = page.locator("textarea");
  const count = await areas.count();
  if (!count) throw new Error("no textarea present");
  return areas.nth(index === -1 ? count - 1 : index).inputValue();
}

/** Assert a page-level failure message is shown and no download is offered. */
export async function expectRejection(page: Page, pattern: RegExp) {
  await page.getByText(pattern).first().waitFor({ timeout: 30_000 });
}
