import { expect, test } from "@playwright/test";
import { fixture } from "./helpers";

test.describe("commercial UI, offline status and new workspaces", () => {
  test("theme persists, status pill switches offline, canonical is environment-driven", async ({ page, context }) => {
    await page.goto("/");
    await expect(page.getByText("Local Engine Ready (0 KB Uploaded)").first()).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://paperlypdf.com/");

    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", { name: "Switch to light mode" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    await context.setOffline(true);
    await expect(page.getByText("Offline Mode Active — 100% Local").first()).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByText("Local Engine Ready (0 KB Uploaded)").first()).toBeVisible();
  });

  test("homepage inspects a scanned PDF locally and recommends OCR", async ({ page }) => {
    await page.goto("/");
    await page.locator('input[type="file"]').first().setInputFiles(fixture("scan.pdf"));
    await expect(page.getByText("Scanned PDF detected").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: /OCR PDF/ }).first()).toBeVisible();
    await page.getByRole("button", { name: /OCR PDF/ }).first().click();
    await page.waitForURL("**/ocr-pdf");
    await expect(page.locator("h1").first()).toContainText("OCR");
  });

  test("homepage renders all 51 tools with the requested discovery groups", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("[data-tool-id]")).toHaveCount(51);
    await expect(page.getByRole("button", { name: /All 51/ })).toBeVisible();
    for (const label of ["Organize", "Edit & Sign", "Convert", "OCR & Extract", "Security & Redact", "Inspect & Repair"]) {
      await expect(page.getByRole("button", { name: new RegExp(`^${label}`) }).first()).toBeVisible();
    }
    await page.getByRole("button", { name: /^Security & Redact/ }).first().click();
    await expect(page.locator("[data-tool-id]")).toHaveCount(7);
  });

  test("command palette finds a tool by fuzzy alias", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
    const input = page.getByRole("textbox", { name: "Search tools and pages" });
    await expect(input).toBeVisible();
    await input.fill("rdct");
    await expect(page.getByRole("link", { name: /Redact PDF/ }).first()).toBeVisible();
  });

  test("unified organizer merges two PDFs and can mark a split", async ({ page }) => {
    await page.goto("/organize-pdf");
    await page.locator('input[type="file"]').first().setInputFiles([fixture("sample.pdf"), fixture("sample2.pdf")]);
    await expect(page.getByText(/2 sources/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Export final PDF" })).toBeVisible();
    await page.getByRole("button", { name: /Add split after page 1/ }).first().click();
    await expect(page.getByRole("button", { name: /Export 2 PDFs/ })).toBeVisible();
    await page.getByRole("button", { name: /Export 2 PDFs/ }).click();
    await expect(page.getByText(/Your split documents are ready/)).toBeVisible({ timeout: 90_000 });
  });

  test("workflow macros save locally and the second pipeline hits the Pro gate", async ({ page }) => {
    await page.goto("/workflows");
    await page.getByRole("button", { name: "Rotate pages", exact: true }).click();
    await page.getByRole("button", { name: "Compress", exact: true }).click();
    await page.getByRole("textbox", { name: "Workflow name" }).fill("Test macro");
    await page.getByRole("button", { name: "Save workflow" }).click();
    await expect(page.getByText("Saved “Test macro” to this browser.")).toBeVisible();
    const stored = await page.evaluate(() => localStorage.getItem("paperly.workflows.v1"));
    expect(stored).toContain("Test macro");

    await page.getByRole("textbox", { name: "Workflow name" }).fill("Second macro");
    await page.getByRole("button", { name: "Save workflow" }).click();
    await expect(page.getByRole("heading", { name: "A power feature for heavy workflows" })).toBeVisible();
    await expect(page.getByText(/Saving more than 1 custom workflow pipeline/)).toBeVisible();
  });

  test("batch drops over three files are gated politely", async ({ page }) => {
    await page.goto("/batch-pdf");
    await page.locator('input[type="file"]').first().setInputFiles([
      fixture("sample.pdf"),
      fixture("sample2.pdf"),
      fixture("scan.pdf"),
      fixture("sample.pdf"),
    ]);
    await expect(page.getByRole("heading", { name: "A power feature for heavy workflows" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Batch runs over 3 files are part of Paperly Pro/)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "A power feature for heavy workflows" })).toBeHidden();
  });

  test("commercial team PWA mode is gated behind Pro", async ({ page }) => {
    await page.goto("/pricing");
    await page.getByRole("button", { name: "Enable", exact: true }).click();
    await expect(page.getByRole("heading", { name: "A power feature for heavy workflows" })).toBeVisible();
  });

  test("license activation modal is reachable from pricing", async ({ page }) => {
    await page.goto("/pricing");
    await page.getByRole("button", { name: "Activate license" }).click();
    const dialog = page.getByRole("dialog", { name: /Activate your license/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Lemon Squeezy license key")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("privacy page offers an interactive zero-upload verification", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page.getByRole("heading", { name: "Don’t trust the claim. Watch the network." })).toBeVisible();
    await page.getByRole("button", { name: "Run local proof" }).click();
    await expect(page.getByText(/network requests during probe: 0/)).toBeVisible();
  });
});
