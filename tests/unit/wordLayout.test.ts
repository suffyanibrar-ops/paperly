import { describe, expect, it } from "vitest";
import { buildWordBlocks } from "@/lib/wordLayout";
import type { ExtractedLine, ExtractedPage } from "@/lib/extract";

function line(text: string, options: { x?: number; y?: number; width?: number; fontSize?: number; fontName?: string } = {}): ExtractedLine {
  const x = options.x ?? 72;
  const width = options.width ?? text.length * 5;
  const fontSize = options.fontSize ?? 11;
  return {
    text,
    x,
    y: options.y ?? 700,
    width,
    height: fontSize,
    fontSize,
    fontName: options.fontName ?? "g_d0_f1",
    items: [{ str: text, x, width, fontSize, fontName: options.fontName ?? "g_d0_f1" }],
  };
}

function page(lines: ExtractedLine[]): ExtractedPage {
  return { page: 1, width: 612, height: 792, lines, text: lines.map((entry) => entry.text).join("\n") };
}

describe("Word layout reconstruction", () => {
  it("detects a large title, merged body paragraphs and a bullet", () => {
    const blocks = buildWordBlocks(
      page([
        line("Quarterly Inventory Report", { y: 740, fontSize: 24 }),
        line("The warehouse closed the quarter with more stock than", { y: 700, width: 420 }),
        line("the previous period, driven by two late deliveries.", { y: 686, width: 400 }),
        line("• Confirm the pallet count", { y: 650, width: 220 }),
      ]),
    );
    expect(blocks[0]).toMatchObject({ kind: "heading", level: 1, text: "Quarterly Inventory Report" });
    expect(blocks[1]).toMatchObject({
      kind: "paragraph",
      text: "The warehouse closed the quarter with more stock than the previous period, driven by two late deliveries.",
    });
    expect(blocks[2]).toMatchObject({ kind: "bullet", text: "Confirm the pallet count" });
  });

  it("detects a short all-caps heading and right alignment", () => {
    const blocks = buildWordBlocks(
      page([
        line("APPENDIX", { y: 700, fontSize: 11 }),
        line("Signature", { x: 470, y: 650, width: 70, fontSize: 11 }),
      ]),
    );
    expect(blocks[0]).toMatchObject({ kind: "heading", level: 3, text: "APPENDIX" });
    expect(blocks[1]).toMatchObject({ kind: "paragraph", align: "right" });
  });

  it("keeps numbered markers and joins a hyphenated line", () => {
    const blocks = buildWordBlocks(
      page([
        line("1. Open the loading bay", { y: 700 }),
        line("2. Verify the deliv-", { y: 686 }),
        line("ery note", { y: 672 }),
      ]),
    );
    expect(blocks[0]).toMatchObject({ kind: "paragraph", text: "1. Open the loading bay" });
    expect(blocks[1]).toMatchObject({ kind: "paragraph", text: "2. Verify the delivery note" });
  });

  it("preserves an indented paragraph relative to the page's left edge", () => {
    const blocks = buildWordBlocks(page([line("Body", { x: 72, y: 700 }), line("Indented note", { x: 120, y: 680 })]));
    expect(blocks[1].indent).toBeGreaterThan(30);
  });
});
