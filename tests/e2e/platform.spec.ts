import { test, expect } from "@playwright/test";
import { fixture, openTool, pdfPages, saveDownload, upload, waitSuccess } from "./helpers";

/**
 * Platform-level flows shared by every tool: locally generated sample,
 * the result panel (rename / preview / checksum), and the extended page
 * query syntax. These run against the production build.
 */
test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

test("result panel: sample, rename, preview, checksum and download name", async ({ page }) => {
  await openTool(page, "compress");
  await page.getByRole("button", { name: /try a sample pdf/i }).click();
  await page.getByText("paperly-sample.pdf").waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: /^Compress PDF$/ }).click();
  await waitSuccess(page, /smaller|highly optimized/);

  const nameInput = page.locator("#output-filename");
  await expect(nameInput).toBeVisible();
  await nameInput.fill("my-compressed-report");
  await expect(page.getByText(".pdf", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Preview" }).click();
  const dialog = page.getByRole("dialog", { name: /Preview of my-compressed-report\.pdf/i });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Checksum" }).click();
  await expect(page.locator('p[title="SHA-256 of the downloaded bytes"]')).toBeVisible({ timeout: 30_000 });

  const file = await saveDownload(page, "platform", /^Download/);
  expect(file).toContain("my-compressed-report.pdf");
  expect(await pdfPages(file)).toBe(3);
});

test("page query: odd pages are accepted everywhere parseRanges is used", async ({ page }) => {
  await openTool(page, "split");
  await upload(page, fixture("sample.pdf"));
  await page.locator("#page-range").fill("odd");
  await page.getByRole("button", { name: /^Extract pages$/ }).click();
  await waitSuccess(page, /extracted PDF is ready/);
  const file = await saveDownload(page, "platform", /^Download/);
  expect(await pdfPages(file)).toBe(2);
});

test("every tool mounts cleanly and its advanced options open without console errors", async ({ page }) => {
  const fs = await import("node:fs/promises");
  const registry = await fs.readFile("src/lib/toolRegistry.ts", "utf8");
  const ids = [...registry.matchAll(/^ {4}id: "([a-z0-9-]+)"/gm)].map((match) => match[1]);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  for (const id of ids) {
    await page.goto(`/#/tool/${id}`);
    await page.waitForTimeout(120);
    await expect(page.locator("h1").first(), `${id} should render`).toBeVisible();
    const advanced = page.getByRole("button", { name: /advanced/i }).first();
    if (await advanced.count()) {
      await advanced.click();
      await page.waitForTimeout(40);
      // Toggle each switch once: this exercises the persisted option handlers
      // that are otherwise only reachable by hand.
      const switches = page.locator('[role="switch"]');
      const count = await switches.count();
      for (let index = 0; index < Math.min(count, 8); index++) {
        const control = switches.nth(index);
        if (await control.isEnabled()) {
          await control.click();
          await page.waitForTimeout(20);
        }
      }
    }
  }
  expect(errors, errors.join("\n")).toEqual([]);
});
