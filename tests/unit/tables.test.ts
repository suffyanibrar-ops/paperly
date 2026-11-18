import { describe, expect, it } from "vitest";
import {
  TABLE_COUNT_CAP,
  TABLE_PAGE_CAP,
  assembleTable,
  detectColumnEdges,
  detectPageTables,
  findTableRegions,
  rowsToCells,
  tableToCsv,
  tablesToZipEntries,
  validateTable,
  type Table,
} from "@/lib/tables";
import type { LineSpan, PageGeometry, TextLine, TextBox } from "@/lib/textGeometry";

/* ------------------------------------------------------------------ *
 * Geometry fixtures
 * ------------------------------------------------------------------ */

function textBox(str: string, x: number, y: number, fontSize = 10): TextBox {
  return { str, x, y, width: Math.max(1, str.length * fontSize * 0.5), height: fontSize, fontSize, fontName: "g_d0_f1" };
}

type Cell = string | { text: string; offset?: number } | null;

function line(y: number, cells: Cell[], columns: number[], fontSize = 10): TextLine {
  const items: TextBox[] = [];
  cells.forEach((cell, index) => {
    if (cell === null) return;
    const spec = typeof cell === "string" ? { text: cell } : cell;
    if (!spec.text) return;
    items.push(textBox(spec.text, columns[index] + (spec.offset ?? 0), y, fontSize));
  });
  items.sort((a, b) => a.x - b.x);

  let text = "";
  const spans: LineSpan[] = [];
  for (const item of items) {
    if (text) text += " ";
    const start = text.length;
    text += item.str;
    spans.push({ start, end: text.length, item });
  }

  const left = items.length ? Math.min(...items.map((item) => item.x)) : 0;
  const right = items.length ? Math.max(...items.map((item) => item.x + item.width)) : 0;
  return {
    text,
    x: left,
    y,
    bottom: y,
    top: y + fontSize,
    width: Math.max(0, right - left),
    height: fontSize,
    fontSize,
    items,
    spans,
  };
}

function pageOf(lines: TextLine[], page = 1, rotation = 0): PageGeometry {
  return {
    page,
    width: 595,
    height: 842,
    rotation,
    items: lines.flatMap((entry) => entry.items),
    lines,
  };
}

function tableOf(rows: string[][]): Table {
  return assembleTable(rows);
}

/* ------------------------------------------------------------------ *
 * detectColumnEdges
 * ------------------------------------------------------------------ */

describe("detectColumnEdges", () => {
  it("clusters jittered cell starts into the real column edges", () => {
    const columns = [40, 120, 200];
    const offsets = [
      [-1.5, 1.2, -0.8],
      [1.1, -1.4, 1.6],
      [-0.6, 0.9, -1.2],
      [1.4, -1.1, 0.7],
    ];
    const lines = offsets.map((rowOffsets, row) =>
      line(
        700 - row * 20,
        [
          { text: "Alpha", offset: rowOffsets[0] },
          { text: "Bravo", offset: rowOffsets[1] },
          { text: "Charlie", offset: rowOffsets[2] },
        ],
        columns,
      ),
    );

    const edges = detectColumnEdges(lines);
    expect(edges).toHaveLength(3);
    edges.forEach((edge, index) => expect(edge).toBeCloseTo(columns[index], 0));
  });

  it("drops a start position supported by only one row", () => {
    const columns = [40, 120, 200, 320];
    const lines = [
      line(700, ["Alpha", "Bravo", "Charlie"], columns.slice(0, 3)),
      line(680, ["Delta", "Echo", "Foxtrot"], columns.slice(0, 3)),
      line(660, ["Golf", "Hotel", "India", "Stray"], columns),
      line(640, ["Juliet", "Kilo", "Lima"], columns.slice(0, 3)),
    ];

    const edges = detectColumnEdges(lines);
    expect(edges).toHaveLength(3);
    expect(edges[2]).toBeLessThan(250);
  });

  it("folds right-aligned numbers into one column even when they start at different x", () => {
    // Numbers are right-aligned at x = 440, so their starts differ by width.
    const lines = [
      line(700, ["Widget", { text: "30.00", offset: 15 }], [40, 400]),
      line(680, ["Gadget", { text: "54.00", offset: 15 }], [40, 400]),
      line(660, ["Thing", { text: "1,234.56", offset: 0 }], [40, 400]),
      line(640, ["Other", { text: "2,000.00", offset: 0 }], [40, 400]),
    ];

    const edges = detectColumnEdges(lines);
    expect(edges).toHaveLength(2);
    expect(edges[0]).toBeCloseTo(40, 0);
    expect(edges[1]).toBeGreaterThan(395);
    expect(edges[1]).toBeLessThan(420);
  });

  it("returns nothing for prose where every line is a single text run", () => {
    const lines = [
      line(700, ["Quarterly inventory report"], [50]),
      line(680, ["This document has a genuine text layer."], [50]),
      line(660, ["Nothing on this page is arranged in columns."], [50]),
    ];
    expect(detectColumnEdges(lines)).toEqual([]);
  });

  it("caps the number of columns", () => {
    const columns = [40, 100, 160, 220, 280, 340];
    const lines = [
      line(700, ["A", "B", "C", "D", "E", "F"], columns),
      line(680, ["G", "H", "I", "J", "K", "L"], columns),
      line(660, ["M", "N", "O", "P", "Q", "R"], columns),
    ];
    expect(detectColumnEdges(lines, { maxColumns: 4 })).toHaveLength(4);
  });
});

/* ------------------------------------------------------------------ *
 * rowsToCells
 * ------------------------------------------------------------------ */

describe("rowsToCells", () => {
  it("keeps empty cells for missing values and absorbs sub-point jitter", () => {
    const columns = [40, 120, 200];
    const cells = rowsToCells(
      line(700, [{ text: "Alpha", offset: 1.2 }, null, { text: "Charlie", offset: -1.4 }], columns),
      columns,
    );
    expect(cells).toEqual(["Alpha", "", "Charlie"]);
  });

  it("joins several items that belong to the same cell", () => {
    const source = line(
      700,
      [{ text: "Hello" }, { text: "World", offset: 27 }, null, { text: "Charlie" }],
      [40, 40, 120, 200],
    );
    expect(rowsToCells(source, [40, 120, 200])).toEqual(["Hello World", "", "Charlie"]);
  });

  it("does not split a long multi-word cell that crosses the midpoint boundary", () => {
    const source = line(
      700,
      [
        { text: "Item" },
        { text: "A-100", offset: 23 },
        { text: "paper", offset: 51 },
        { text: "clips", offset: 79 },
      ],
      [40, 40, 40, 40],
    );
    expect(rowsToCells(source, [40, 200])).toEqual(["Item A-100 paper clips", ""]);
  });

  it("returns the whole line when no columns are supplied", () => {
    expect(rowsToCells(line(700, ["only text"], [40]), [])).toEqual(["only text"]);
  });
});

/* ------------------------------------------------------------------ *
 * assembleTable & validateTable
 * ------------------------------------------------------------------ */

describe("assembleTable", () => {
  it("pads ragged rows, drops empty rows and reports the fill ratio", () => {
    const table = assembleTable([
      ["Name", "Age", "City"],
      ["Ada", "36"],
      ["", "", ""],
    ]);
    expect(table.rows).toEqual([
      ["Name", "Age", "City"],
      ["Ada", "36", ""],
    ]);
    expect(table.rowCount).toBe(2);
    expect(table.columnCount).toBe(3);
    expect(table.raggedRows).toBe(1);
    expect(table.fillRatio).toBeCloseTo(5 / 6, 5);
  });

  it("normalises whitespace inside cells", () => {
    const table = assembleTable([["  Name  ", "New\nYork"], ["\tAda", " 36 "]]);
    expect(table.rows).toEqual([
      ["Name", "New York"],
      ["Ada", "36"],
    ]);
  });

  it("handles an empty grid", () => {
    expect(assembleTable([])).toEqual({ rows: [], rowCount: 0, columnCount: 0, fillRatio: 0, raggedRows: 0 });
  });
});

describe("validateTable", () => {
  it("accepts a clean multi-row grid", () => {
    const validation = validateTable(tableOf([["Item", "Qty", "Price"], ["Ream", "8", "6.75"], ["Clips", "12", "2.50"]]));
    expect(validation.ok).toBe(true);
    expect(validation.filledRowRatio).toBe(1);
    expect(validation.reasons).toEqual([]);
  });

  it("rejects a single column", () => {
    expect(validateTable(tableOf([["One"], ["Two"]])).ok).toBe(false);
  });

  it("rejects a single row", () => {
    expect(validateTable(tableOf([["A", "B", "C"]])).ok).toBe(false);
  });

  it("rejects a mostly empty grid", () => {
    const validation = validateTable(
      tableOf([
        ["A", "", "", ""],
        ["B", "", "", ""],
        ["C", "", "", ""],
      ]),
    );
    expect(validation.ok).toBe(false);
    expect(validation.reasons.join(" ")).toMatch(/empty cells/i);
  });

  it("rejects grids where most rows have only one filled cell", () => {
    const validation = validateTable(
      tableOf([
        ["A", "B"],
        ["C", ""],
        ["D", ""],
        ["E", ""],
      ]),
      { minFillRatio: 0 },
    );
    expect(validation.ok).toBe(false);
    expect(validation.filledRowRatio).toBeCloseTo(0.25, 5);
  });
});

/* ------------------------------------------------------------------ *
 * findTableRegions & detectPageTables
 * ------------------------------------------------------------------ */

const INVOICE_COLUMNS = [40, 200, 360];

function invoiceTable(top: number): TextLine[] {
  return [
    line(top, ["Item", "Qty", "Price"], INVOICE_COLUMNS),
    line(top - 20, ["Paper clips", "12", "2.50"], INVOICE_COLUMNS),
    line(top - 40, ["Ream", "8", "6.75"], INVOICE_COLUMNS),
  ];
}

describe("findTableRegions", () => {
  it("splits two tables separated by a large vertical gap and drops the title", () => {
    const page = pageOf([line(780, ["Inventory Report"], [40]), ...invoiceTable(700), ...invoiceTable(300)]);
    const regions = findTableRegions(page);

    expect(regions).toHaveLength(2);
    expect(regions[0].page).toBe(1);
    expect(regions[0].index).toBe(0);
    expect(regions[0].lines).toHaveLength(3);
    expect(regions[1].lines).toHaveLength(3);
    expect(regions[0].x).toBeCloseTo(40, 0);
    expect(regions[0].width).toBeCloseTo(345, 0);
  });

  it("splits on a heading-only row between two aligned tables", () => {
    const page = pageOf([
      ...invoiceTable(700),
      line(630, ["Totals"], [40]),
      line(600, ["Subtotal", "269.98", "EUR"], INVOICE_COLUMNS),
      line(580, ["Tax", "53.99", "EUR"], INVOICE_COLUMNS),
    ]);
    const regions = findTableRegions(page);

    expect(regions).toHaveLength(2);
    expect(regions[1].lines.map((entry) => entry.text)).toEqual(["Subtotal 269.98 EUR", "Tax 53.99 EUR"]);
  });

  it("returns nothing for a prose page", () => {
    const page = pageOf([
      line(780, ["Quarterly Inventory Report"], [50]),
      line(752, ["Page 1 of 3"], [50]),
      line(690, ["Sensitive: account 99887766 balance 12000 EUR"], [50]),
      line(660, ["Item A-100 paper clips quantity 12 unit price 2.50 total 30.00"], [50]),
      line(610, ["Subtotal 269.98 EUR Tax 53.99 EUR Total 323.97 EUR"], [50]),
      line(200, ["This document has a genuine text layer used for conversion tests."], [50]),
    ]);
    expect(findTableRegions(page)).toEqual([]);
  });
});

describe("detectPageTables", () => {
  it("detects a real table with its columns and rows", () => {
    const scan = detectPageTables(pageOf(invoiceTable(700)));

    expect(scan.page).toBe(1);
    expect(scan.rejectedRegions).toBe(0);
    expect(scan.tables).toHaveLength(1);
    const [table] = scan.tables;
    expect(table.id).toBe("p1-t1");
    expect(table.page).toBe(1);
    expect(table.columns).toHaveLength(3);
    expect(table.table.rows).toEqual([
      ["Item", "Qty", "Price"],
      ["Paper clips", "12", "2.50"],
      ["Ream", "8", "6.75"],
    ]);
  });

  it("never fabricates a table from prose", () => {
    const page = pageOf([
      line(780, ["Quarterly Inventory Report"], [50]),
      line(752, ["Page 1 of 3"], [50]),
      line(690, ["Sensitive: account 99887766 balance 12000 EUR"], [50]),
      line(660, ["Item A-100 paper clips quantity 12 unit price 2.50 total 30.00"], [50]),
      line(640, ["Item B-204 recycled paper ream quantity 8 unit price 6.75 total 54.00"], [50]),
      line(200, ["This document has a genuine text layer used for conversion tests."], [50]),
    ]);
    expect(detectPageTables(page).tables).toEqual([]);
  });

  it("rejects a loosely aligned block that is not a table", () => {
    const page = pageOf([
      line(700, ["Alpha", null, "Gamma"], [40, 200, 360]),
      line(680, ["Delta", null, null], [40, 200, 360]),
      line(660, [null, "Hotel", null], [40, 200, 360]),
    ]);
    const scan = detectPageTables(page);
    expect(scan.tables).toEqual([]);
  });

  it("merges a wrapped cell line back into the previous row", () => {
    const page = pageOf([
      line(700, ["Item", "Qty"], [40, 200]),
      line(688.5, ["Long description"], [40]),
      line(677, ["Widget", "5"], [40, 200]),
    ]);
    const scan = detectPageTables(page);

    expect(scan.tables).toHaveLength(1);
    expect(scan.tables[0].table.rows).toEqual([
      ["Item Long description", "Qty"],
      ["Widget", "5"],
    ]);
  });

  it("merges a wrapped continuation in a later column across normal row spacing", () => {
    const page = pageOf([
      line(700, ["Field", "Value"], [40, 200]),
      line(684, ["Supplier", "Northwind Traders"], [40, 200]),
      line(668, ["Note", "Delivered in two parts because the second"], [40, 200]),
      line(652, [{ text: "pallet arrived late.", offset: 0 }], [200]),
      line(636, ["Reference", "INV-2024-0091"], [40, 200]),
    ]);
    const scan = detectPageTables(page);

    expect(scan.tables).toHaveLength(1);
    expect(scan.tables[0].table.rows).toEqual([
      ["Field", "Value"],
      ["Supplier", "Northwind Traders"],
      ["Note", "Delivered in two parts because the second pallet arrived late."],
      ["Reference", "INV-2024-0091"],
    ]);
  });

  it("keeps two or more wrapped continuation lines attached to the same row", () => {
    const page = pageOf([
      line(700, ["Field", "Value"], [40, 200]),
      line(684, ["Note", "Line one of a long note"], [40, 200]),
      line(668, [{ text: "that continues here", offset: 0 }], [200]),
      line(652, [{ text: "and finally ends.", offset: 0 }], [200]),
      line(636, ["Reference", "INV-1"], [40, 200]),
    ]);
    const scan = detectPageTables(page);

    expect(scan.tables).toHaveLength(1);
    expect(scan.tables[0].table.rows).toEqual([
      ["Field", "Value"],
      ["Note", "Line one of a long note that continues here and finally ends."],
      ["Reference", "INV-1"],
    ]);
  });

  it("can keep wrapped lines as their own rows when merging is disabled", () => {
    const page = pageOf([
      line(700, ["Item", "Qty"], [40, 200]),
      line(688.5, ["Long description"], [40]),
      line(677, ["Widget", "5"], [40, 200]),
    ]);
    const scan = detectPageTables(page, { mergeWrappedLines: false });
    expect(scan.tables[0].table.rowCount).toBe(3);
  });
});

/* ------------------------------------------------------------------ *
 * CSV serialisation
 * ------------------------------------------------------------------ */

describe("tableToCsv", () => {
  it("writes plain rows with CRLF endings", () => {
    expect(tableToCsv(tableOf([["Name", "Age"], ["Ada", "36"]]))).toBe("Name,Age\r\nAda,36\r\n");
  });

  it("quotes delimiters, quotes and newlines and doubles inner quotes", () => {
    const csv = tableToCsv([
      ["a,b", 'say "hi"'],
      ["line\nbreak", "plain"],
    ]);
    expect(csv).toBe('"a,b","say ""hi"""\r\n"line\nbreak",plain\r\n');
  });

  it("only quotes when needed", () => {
    expect(tableToCsv([["plain", "with space"]])).toBe("plain,with space\r\n");
  });

  it("supports a custom delimiter and quote character", () => {
    const csv = tableToCsv([["a;b", "it's"]], { delimiter: ";", quote: "'" });
    expect(csv).toBe("'a;b';'it''s'\r\n");
  });

  it("quotes every field when asked", () => {
    expect(tableToCsv([["a", ""]], { quoteAll: true })).toBe('"a",""\r\n');
  });

  it("can prefix a UTF-8 BOM", () => {
    expect(tableToCsv([["é"]], { bom: true }).startsWith("\uFEFF")).toBe(true);
  });

  it("returns an empty string for an empty table", () => {
    expect(tableToCsv([])).toBe("");
  });

  it("rejects an empty delimiter", () => {
    expect(() => tableToCsv([["a"]], { delimiter: "" })).toThrow(/delimiter/i);
  });

  it("rejects a multi-character quote", () => {
    expect(() => tableToCsv([["a"]], { quote: "''" })).toThrow(/one character/i);
  });
});

/* ------------------------------------------------------------------ *
 * ZIP entries
 * ------------------------------------------------------------------ */

describe("tablesToZipEntries", () => {
  const first = { table: tableOf([["A", "B"], ["1", "2"]]), page: 3, index: 1 };
  const second = { table: tableOf([["C", "D"], ["3", "4"]]), page: 3, index: 0 };

  it("names entries by page and table number", () => {
    const entries = tablesToZipEntries([first, second]);
    expect(entries.map((entry) => entry.name)).toEqual(["page-03-table-02.csv", "page-03-table-01.csv"]);
    expect(entries[0].data).toBe("A,B\r\n1,2\r\n");
  });

  it("uses a sanitised base name and de-duplicates repeated tables", () => {
    const entries = tablesToZipEntries(
      [
        { table: first.table, page: 1, index: 0 },
        { table: second.table, page: 1, index: 0 },
      ],
      { baseName: "Q3 Report/final" },
    );
    expect(entries.map((entry) => entry.name)).toEqual([
      "Q3 Report-final-p01-t01.csv",
      "Q3 Report-final-p01-t01-2.csv",
    ]);
  });

  it("can place entries in a folder and forwards CSV options", () => {
    const entries = tablesToZipEntries([second], { folder: "nested/x", delimiter: ";" });
    expect(entries[0].name).toBe("nested-x/page-03-table-01.csv");
    expect(entries[0].data).toBe("C;D\r\n3;4\r\n");
  });
});

/* ------------------------------------------------------------------ *
 * Caps
 * ------------------------------------------------------------------ */

describe("table caps", () => {
  it("keeps the documented per-run limits", () => {
    expect(TABLE_PAGE_CAP).toBe(300);
    expect(TABLE_COUNT_CAP).toBe(120);
  });
});
