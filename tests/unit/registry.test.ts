import { describe, expect, it } from "vitest";
import { CATEGORIES, POPULAR_IDS, TOOLS, TOOL_MAP, getTool } from "@/lib/toolRegistry";
import { REGISTERED_TOOL_IDS } from "@/pages/ToolPage";

describe("tool registry", () => {
  it("contains the full advertised catalogue", () => {
    expect(TOOLS).toHaveLength(50);
    expect(Object.keys(TOOL_MAP)).toHaveLength(TOOLS.length);
  });

  it("uses unique ids", () => {
    const ids = TOOLS.map((tool) => tool.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("routes every registered tool to a renderer", () => {
    for (const tool of TOOLS) {
      expect(REGISTERED_TOOL_IDS, `missing renderer for ${tool.id}`).toContain(tool.id);
    }
    expect(new Set(REGISTERED_TOOL_IDS).size).toBe(REGISTERED_TOOL_IDS.length);
  });

  it("only references existing related tools and popular ids", () => {
    for (const tool of TOOLS) {
      for (const related of tool.related) {
        expect(getTool(related), `${tool.id} references unknown related tool ${related}`).toBeTruthy();
        expect(related).not.toBe(tool.id);
      }
    }
    for (const id of POPULAR_IDS) expect(getTool(id)).toBeTruthy();
  });

  it("gives every tool complete, well-formed metadata", () => {
    for (const tool of TOOLS) {
      expect(tool.name.length).toBeGreaterThan(2);
      expect(tool.tagline.length).toBeGreaterThan(10);
      expect(tool.description.length).toBeGreaterThan(30);
      expect(tool.steps).toHaveLength(3);
      expect(tool.steps.every((step) => step.trim().length > 8)).toBe(true);
      expect(CATEGORIES[tool.category]).toBeTruthy();
      expect(tool.accepts.length).toBeGreaterThan(0);
      expect(tool.acceptLabel.length).toBeGreaterThan(4);
      expect(["function", "object"]).toContain(typeof tool.icon);
    }
  });

  it("includes the newest capabilities", () => {
    for (const id of [
      "ask-pdf",
      "inspect-pdf",
      "find-redact",
      "sanitize",
      "bookmarks",
      "split-bookmarks",
      "metadata",
      "tables-to-csv",
    ]) {
      const tool = getTool(id);
      expect(tool, `${id} missing from registry`).toBeTruthy();
      expect(tool!.new).toBe(true);
    }
  });
});
