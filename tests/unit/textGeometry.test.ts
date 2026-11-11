import { describe, expect, it } from "vitest";
import {
  boxToNormalized,
  charRangeBox,
  groupIntoLines,
  unionBox,
  type TextBox,
} from "@/lib/textGeometry";

function box(str: string, x: number, y: number, width = str.length * 5.5, height = 10, fontSize = 10): TextBox {
  return { str, x, y, width, height, fontSize, fontName: "g_d0_f1" };
}

describe("groupIntoLines", () => {
  it("groups items that share a baseline and orders lines top-to-bottom", () => {
    const items = [box("World", 60, 700), box("Hello", 20, 700), box("Title", 20, 780, 120, 19, 19), box("Second line", 20, 680)];
    const lines = groupIntoLines(items);
    expect(lines.map((line) => line.text)).toEqual(["Title", "Hello World", "Second line"]);
    expect(lines[0].fontSize).toBe(19);
  });

  it("keeps near-baseline items on one line and separates real line breaks", () => {
    const lines = groupIntoLines([box("alpha", 20, 700), box("beta", 80, 699.4), box("gamma", 20, 686)]);
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe("alpha beta");
  });

  it("inserts a space for a real gap but joins adjacent glyph runs", () => {
    const lines = groupIntoLines([box("Hel", 20, 700, 12), box("lo", 32, 700, 10), box("World", 60, 700, 30)]);
    expect(lines[0].text).toBe("Hello World");
  });

  it("maps character offsets back to the items that produced them", () => {
    const lines = groupIntoLines([box("Account", 20, 700, 40), box("1234", 70, 700, 22)]);
    const line = lines[0];
    expect(line.text).toBe("Account 1234");
    const onlyNumber = charRangeBox(line, line.text.indexOf("1234"), line.text.length);
    expect(onlyNumber).not.toBeNull();
    expect(onlyNumber!.x).toBe(70);
    expect(onlyNumber!.width).toBe(22);

    const whole = charRangeBox(line, 0, line.text.length);
    expect(whole!.x).toBe(20);
    expect(whole!.width).toBe(72);
  });

  it("drops empty and whitespace-only items without corrupting offsets", () => {
    const lines = groupIntoLines([box("  ", 20, 700, 5), box("Value", 30, 700, 30), box("", 70, 700, 0)]);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("Value");
    expect(charRangeBox(lines[0], 0, 5)!.x).toBe(30);
  });

  it("ignores non-finite coordinates and returns nothing for an empty page", () => {
    expect(groupIntoLines([])).toEqual([]);
  });
});

describe("unionBox", () => {
  it("returns the enclosing box for several items", () => {
    const result = unionBox([box("A", 20, 700, 10, 12), box("B", 60, 690, 20, 8)]);
    expect(result).toEqual({ x: 20, y: 690, width: 60, height: 22 });
  });

  it("returns null without items", () => {
    expect(unionBox([])).toBeNull();
  });
});

describe("boxToNormalized", () => {
  it("flips PDF user space into top-left normalized render space", () => {
    // A 20x10pt box hugging the top-left corner of a 200x100pt page.
    const normalized = boxToNormalized({ x: 0, y: 90, width: 20, height: 10 }, 200, 100);
    expect(normalized.x).toBeCloseTo(0);
    expect(normalized.y).toBeCloseTo(0);
    expect(normalized.w).toBeCloseTo(0.1);
    expect(normalized.h).toBeCloseTo(0.1);
  });

  it("maps a bottom-right box and clamps overflow", () => {
    const normalized = boxToNormalized({ x: 180, y: 0, width: 20, height: 10 }, 200, 100);
    expect(normalized.x).toBeCloseTo(0.9);
    expect(normalized.y).toBeCloseTo(0.9);
    expect(normalized.w).toBeCloseTo(0.1);
    expect(normalized.h).toBeCloseTo(0.1);
  });

  it("never produces negative or out-of-range geometry", () => {
    const normalized = boxToNormalized({ x: -50, y: -20, width: 500, height: 500 }, 200, 100);
    for (const value of [normalized.x, normalized.y, normalized.w, normalized.h]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});
