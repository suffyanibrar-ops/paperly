import { describe, expect, it } from "vitest";
import {
  chunkPages,
  extractAnswerWindows,
  highlightRanges,
  queryTerms,
  rankPassages,
  STOPWORDS,
  tokenize,
  verdict,
  type Passage,
  type RankResult,
} from "@/lib/knowledge";

function passage(overrides: Partial<Passage> & { text: string }): Passage {
  return {
    docId: "doc-1",
    docName: "Report.pdf",
    page: 1,
    start: 0,
    ...overrides,
  };
}

const SAMPLE_PASSAGES: Passage[] = [
  passage({ text: "The quarterly revenue grew twelve percent to four million dollars.", page: 4 }),
  passage({ text: "Our people team is hiring designers and engineers this spring.", page: 5 }),
  passage({ text: "Quarterly planning covers hiring, revenue forecasts and product milestones.", page: 6 }),
];

describe("tokenize", () => {
  it("lowercases, normalises apostrophes and drops single characters", () => {
    expect(tokenize("The Quarterly REVENUE grew 12% — read Bob’s notes.")).toEqual([
      "the",
      "quarterly",
      "revenue",
      "grew",
      "12",
      "read",
      "bob's",
      "notes",
    ]);
  });

  it("handles empty and punctuation-only input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("— … !!!")).toEqual([]);
  });
});

describe("queryTerms", () => {
  it("removes stopwords and de-duplicates while keeping first-seen order", () => {
    expect(queryTerms("What is the total revenue, and what was the revenue?")).toEqual(["total", "revenue"]);
  });

  it("exposes the stopword set used by ranking", () => {
    expect(STOPWORDS.has("the")).toBe(true);
    expect(STOPWORDS.has("document")).toBe(true);
    expect(STOPWORDS.has("revenue")).toBe(false);
  });
});

describe("chunkPages", () => {
  it("carries document identity and maps passage text back to a page offset", () => {
    const text = "Intro line one. Intro line two with details. Second paragraph starts here. More content follows now.";
    const chunks = chunkPages([{ page: 3, text, docId: "d1", docName: "A.pdf" }], { maxChars: 200, overlapChars: 0 });
    expect(chunks.length).toBe(1);
    const chunk = chunks[0];
    expect(chunk).toMatchObject({ docId: "d1", docName: "A.pdf", page: 3, start: 0 });
    expect(text.slice(chunk.start, chunk.start + chunk.text.length)).toBe(chunk.text);
    expect(chunk.text.length).toBeLessThanOrEqual(200);
  });

  it("splits long pages into ordered passages that never exceed the cap", () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i + 1} carries a few words about topic ${i % 5}.`).join(" ");
    const chunks = chunkPages([{ page: 1, text: long, docId: "d", docName: "Long.pdf" }], { maxChars: 240, overlapChars: 60 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(240);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].start).toBeGreaterThan(chunks[i - 1].start);
  });

  it("hard-splits a single unterminated sentence at word boundaries", () => {
    const giant = "word ".repeat(200).trim();
    const chunks = chunkPages([{ page: 1, text: giant }], { maxChars: 200, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(200);
      expect(giant.slice(chunk.start, chunk.start + chunk.text.length)).toBe(chunk.text);
    }
  });

  it("skips pages without text and applies fallback document identity", () => {
    const chunks = chunkPages(
      [
        { page: 1, text: "   \n \n" },
        { page: 2, text: "Actual words live here." },
      ],
      { docId: "fallback", docName: "Fallback.pdf" },
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ docId: "fallback", docName: "Fallback.pdf", page: 2 });
  });
});

describe("rankPassages", () => {
  it("ranks the passage that contains the query phrase first", () => {
    const passages = [
      passage({ text: "Revenue growth was strong this year.", page: 2 }),
      passage({ text: "Revenue was strong while growth slowed later.", page: 3 }),
    ];
    const result = rankPassages(passages, "revenue growth");
    expect(result.passages[0].page).toBe(2);
    expect(result.passages[0].matchedTerms).toEqual(["growth", "revenue"]);
  });

  it("returns a confident, answered result for a clear multi-term match", () => {
    const result = rankPassages(SAMPLE_PASSAGES, "quarterly revenue");
    expect(result.passages[0].page).toBe(4);
    expect(result.passages[0].matchedTerms).toEqual(["quarterly", "revenue"]);
    expect(result.confidence).toBeGreaterThan(0.55);
    expect(verdict("quarterly revenue", result).status).toBe("answered");
  });

  it("returns no passages for an unrelated query", () => {
    const result = rankPassages(SAMPLE_PASSAGES, "photosynthesis chlorophyll");
    expect(result.passages).toEqual([]);
    expect(result.confidence).toBe(0);
    expect(verdict("photosynthesis chlorophyll", result).status).toBe("not-found");
  });

  it("handles empty queries and empty corpora without throwing", () => {
    expect(rankPassages(SAMPLE_PASSAGES, "the and of").passages).toEqual([]);
    expect(rankPassages([], "revenue").confidence).toBe(0);
  });

  it("is deterministic across runs", () => {
    expect(rankPassages(SAMPLE_PASSAGES, "revenue hiring")).toEqual(rankPassages(SAMPLE_PASSAGES, "revenue hiring"));
  });

  it("keeps confidence inside 0–1 for every query", () => {
    for (const query of ["quarterly revenue", "hiring", "photosynthesis", "revenue", "people team spring"]) {
      const result = rankPassages(SAMPLE_PASSAGES, query);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe("highlightRanges", () => {
  it("highlights every whole-token match, case-insensitively", () => {
    const text = "Revenue rose; revenue targets were met. Unrelated artistry.";
    const ranges = highlightRanges(text, ["revenue"]);
    expect(ranges).toHaveLength(2);
    expect(ranges.map((range) => text.slice(range.start, range.end))).toEqual(["Revenue", "revenue"]);
  });

  it("does not match a query term inside a longer word", () => {
    const text = "earth art depart";
    const ranges = highlightRanges(text, ["art"]);
    expect(ranges).toHaveLength(1);
    expect(text.slice(ranges[0].start, ranges[0].end)).toBe("art");
  });
});

describe("extractAnswerWindows", () => {
  it("selects the sentence with query terms and returns highlight offsets", () => {
    const passages = [
      passage({ text: "The project began in March. Total revenue reached four million dollars. The team was small.", page: 2 }),
      passage({ text: "Revenue forecasts are reviewed every quarter.", page: 3, docName: "Other.pdf" }),
    ];
    const windows = extractAnswerWindows(passages, "total revenue", { maxSentences: 2 });
    expect(windows.length).toBeGreaterThan(0);
    expect(windows[0].text).toContain("revenue");
    expect(windows[0].docName).toBe("Report.pdf");
    expect(windows[0].page).toBe(2);
    const highlighted = windows[0].highlights.map((range) => windows[0].text.slice(range.start, range.end).toLowerCase());
    expect(highlighted).toContain("revenue");
    expect(highlighted).toContain("total");
  });

  it("returns nothing for an empty query or empty passage list", () => {
    expect(extractAnswerWindows([passage({ text: "Revenue is up." })], "")).toEqual([]);
    expect(extractAnswerWindows([], "revenue")).toEqual([]);
  });
});

describe("verdict", () => {
  it("marks a mid-confidence result as weak", () => {
    const manual: RankResult = {
      query: "revenue",
      terms: ["revenue"],
      passages: [{ ...passage({ text: "Revenue grew." }), score: 0.4, normalizedScore: 0.4, matchedTerms: ["revenue"] }],
      confidence: 0.4,
      candidates: 5,
    };
    expect(verdict("revenue", manual)).toEqual({ status: "weak", confidence: 0.4, matchedTerms: ["revenue"] });
  });

  it("treats stopword-only queries as not-found", () => {
    const result = rankPassages(SAMPLE_PASSAGES, "quarterly revenue");
    expect(verdict("the and of", result).status).toBe("not-found");
  });

  it("accepts a raw ranked-passage array and derives confidence", () => {
    const ranked = rankPassages(SAMPLE_PASSAGES, "quarterly revenue").passages;
    const outcome = verdict("quarterly revenue", ranked);
    expect(outcome.status).toBe("answered");
    expect(outcome.confidence).toBeGreaterThanOrEqual(0);
    expect(outcome.confidence).toBeLessThanOrEqual(1);
  });
});
