import { describe, expect, it } from "vitest";
import { TOOLS } from "@/lib/toolRegistry";
import { SLUG_TO_TOOL, TOOL_SLUGS, toolIdFromPath, toolPath, toolSlug } from "@/lib/slugs";
import { TOOL_GROUPS, groupLabel, searchScore, toolGroup } from "@/lib/groups";

const STATIC_ROUTES = new Set([
  "tools",
  "privacy",
  "help",
  "why",
  "pricing",
  "terms",
  "guides",
  "activity",
  "about",
  "contact",
  "sitemap",
  "vs-ilovepdf",
]);

describe("canonical tool routes", () => {
  it("gives every registered tool exactly one unique slug", () => {
    expect(Object.keys(TOOL_SLUGS)).toHaveLength(TOOLS.length);
    for (const tool of TOOLS) expect(TOOL_SLUGS[tool.id], `missing slug for ${tool.id}`).toBeTruthy();
    const slugs = Object.values(TOOL_SLUGS);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("never collides with a static page route", () => {
    for (const slug of Object.values(TOOL_SLUGS)) expect(STATIC_ROUTES.has(slug)).toBe(false);
  });

  it("round-trips clean slugs and legacy /tool/:id paths", () => {
    for (const tool of TOOLS) {
      expect(toolIdFromPath(toolPath(tool.id))).toBe(tool.id);
      expect(toolIdFromPath(`/tool/${tool.id}`)).toBe(tool.id);
      expect(toolIdFromPath(`/tools/${tool.id}`)).toBe(tool.id);
      expect(SLUG_TO_TOOL[toolSlug(tool.id)]).toBe(tool.id);
    }
    expect(toolIdFromPath("/privacy")).toBeNull();
    expect(toolIdFromPath("/not-a-tool")).toBeNull();
    expect(toolIdFromPath("/merge-pdf?from=home")).toBe("merge");
  });

  it("uses the requested SEO URLs for named tools", () => {
    expect(toolPath("merge")).toBe("/merge-pdf");
    expect(toolPath("compress")).toBe("/compress-pdf");
    expect(toolPath("redact")).toBe("/redact-pdf");
    expect(toolPath("ocr")).toBe("/ocr-pdf");
    expect(toolPath("inspect-pdf")).toBe("/inspect-pdf");
    expect(toolPath("sanitize")).toBe("/sanitize-pdf");
    expect(toolPath("organize")).toBe("/organize-pdf");
    expect(toolPath("workflow")).toBe("/workflows");
  });
});

describe("discovery groups", () => {
  it("places every tool in exactly one public group", () => {
    const seen = new Set<string>();
    for (const group of TOOL_GROUPS) {
      for (const id of group.ids) {
        expect(seen.has(id), `${id} appears in more than one group`).toBe(false);
        seen.add(id);
      }
    }
    expect(seen.size).toBe(TOOLS.length);
    for (const tool of TOOLS) expect(seen.has(tool.id), `${tool.id} is missing from every group`).toBe(true);
  });

  it("exposes the six requested filter groups", () => {
    expect(TOOL_GROUPS.map((group) => group.label)).toEqual([
      "Organize",
      "Edit & Sign",
      "Convert",
      "OCR & Extract",
      "Security & Redact",
      "Inspect & Repair",
    ]);
    expect(toolGroup("merge")).toBe("organize");
    expect(toolGroup("sign")).toBe("edit");
    expect(toolGroup("ocr")).toBe("ocr");
    expect(toolGroup("redact")).toBe("secure");
    expect(toolGroup("repair")).toBe("inspect");
    expect(groupLabel("sanitize")).toBe("Security & Redact");
  });

  it("finds tools by aliases and fuzzy subsequences", () => {
    const merge = TOOLS.find((tool) => tool.id === "merge")!;
    expect(searchScore("combine", merge)).toBeGreaterThan(0);
    expect(searchScore("mrg", merge)).toBeGreaterThan(0);
    expect(searchScore("watermark", TOOLS.find((tool) => tool.id === "watermark")!)).toBeGreaterThan(0);
    expect(searchScore("zzzzzz", merge)).toBe(0);
  });
});
