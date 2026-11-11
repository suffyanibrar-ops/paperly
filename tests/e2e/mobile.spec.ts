import { test, expect } from "@playwright/test";

const ROUTES = ["/", "/tools", "/tool/merge", "/tool/edit", "/tool/batch", "/tool/create-form", "/tool/summarize", "/vs-ilovepdf", "/privacy"];

test.describe("mobile usability", () => {
  test("no horizontal overflow and headings render on a phone viewport", async ({ page }) => {
    for (const route of ROUTES) {
      await page.goto(`/#${route}`);
      await page.waitForTimeout(350);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `horizontal overflow on ${route}`).toBeLessThanOrEqual(1);
      await expect(page.locator("h1").first()).toBeVisible();
    }
  });

  test("mobile menu exposes tools and navigates", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /open menu/i }).click();
    await page.getByRole("link", { name: /merge pdf/i }).first().click();
    await expect(page.locator("h1")).toContainText("Merge PDF");
  });
});
