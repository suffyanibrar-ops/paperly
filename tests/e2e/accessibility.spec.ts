import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * WCAG 2.2 A/AA smoke gate for the shell and representative tool surfaces.
 * Tool canvases and file-dependent controls are exercised separately; this
 * guards navigation, filters, help and the shared tool workspace.
 */
test("shell and representative tools have no WCAG A/AA violations", async ({ page }) => {
  test.setTimeout(180_000);
  const paths = ["/", "/tools", "/#/tool/merge", "/#/tool/compress", "/activity", "/help"];
  for (const path of paths) {
    await page.goto(path);
    // Let entrance animations settle so contrast is measured on the final palette.
    await page.waitForTimeout(900);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      results.violations.map((v) => `${path} ${v.impact} ${v.id} (${v.nodes.length})`),
      `Accessibility violations on ${path}`,
    ).toEqual([]);
  }
});
