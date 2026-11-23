import { expect, test } from "@playwright/test";
import { clickAction, fixture, openTool, pdfPages, pdfText, saveDownload, upload, waitSuccess } from "./helpers";

test("edit: formatting, marker, note and cover-and-replace survive export", async ({ page }) => {
  await openTool(page, "edit");
  await upload(page, fixture("sample.pdf"));

  const surface = page.locator('img[alt^="Page "]').locator("..");
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.2);
  await page.locator("aside textarea").fill("EDITED TEXT 2026");
  await page.locator("aside select").first().selectOption("times");
  await page.locator("aside").getByRole("button", { name: "Toggle underline" }).click();
  await page.locator("aside").getByRole("button", { name: "Toggle strikethrough" }).click();

  await page.getByTitle("Marker").click();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.65, { steps: 6 });
  await page.mouse.up();

  await page.getByTitle("Note").click();
  await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.25);
  await page.locator("aside textarea").fill("Reviewer note");

  await page.getByRole("button", { name: "Replace existing text" }).click();
  const runs = page.locator('[aria-label^="Replace text:"]');
  await expect(runs.first()).toBeVisible({ timeout: 30_000 });
  await runs.first().click();

  await clickAction(page, "Export edited PDF");
  await waitSuccess(page, /Your edited PDF is ready/);
  const file = await saveDownload(page, "edit-v2", /^Download/);
  expect(await pdfPages(file)).toBe(3);
  const text = (await pdfText(file)).join(" ");
  expect(text).toContain("EDITED TEXT 2026");
  expect(text).toContain("Reviewer note");
});
