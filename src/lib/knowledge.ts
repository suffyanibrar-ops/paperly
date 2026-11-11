/* ================================================================== *
 * Knowledge helpers — deterministic, local, extractive retrieval
 *
 * Nothing in this module touches the DOM, the network or a model. It is a
 * small, dependency-free information-retrieval toolkit used by the
 * "Ask Your PDF" tool: tokenisation, page chunking, BM25-style ranking with
 * phrase/proximity boosts, answer-window selection and a confidence verdict.
 *
 * Everything is pure so it can be unit-tested without a PDF or a browser.
 * ================================================================== */

/* ------------------------------------------------------------------ *
 * Tokens & stopwords
 * ------------------------------------------------------------------ */
const TOKEN_SOURCE = "[\\p{L}\\p{N}]+(?:['’][\\p{L}\\p{N}]+)*";

/** Lowercase word/number tokens. Keeps stopwords so callers can decide. */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const matches = text.toLowerCase().match(new RegExp(TOKEN_SOURCE, "gu"));
  if (!matches) return [];
  const tokens: string[] = [];
  for (const match of matches) {
    const token = match.replace(/’/g, "'").replace(/^'+|'+$/g, "");
    if (token.length >= 2) tokens.push(token);
  }
  return tokens;
}

/** Common English stopwords plus retrieval noise that appears in most PDFs. */
export const STOPWORDS: ReadonlySet<string> = new Set(
  `a about above after again against all am an and any are aren't as at be because been before being below between both but by
  can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has
  hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in
  into is isn't it it's its itself let's me more most must mustn't my myself no nor not of off on once only or other ought our
  ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than that that's the their
  theirs them themselves then there there's these they they'd they'll they're they've this those through to too under until up
  very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why
  why's will with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves
  also any may might must shall should upon within without however therefore thus whereas among per via etc page pages figure
  fig figures table tables section sections document documents report reports shown show shows includes including included
  provided provide provides using used use based example examples note notes`
    .split(/\s+/)
    .filter(Boolean),
);

/** Distinct, meaningful query terms in first-seen order. */
export function queryTerms(query: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const token of tokenize(query)) {
    if (token.length < 2 || STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    terms.push(token);
  }
  return terms;
}

/* ------------------------------------------------------------------ *
 * Chunking
 * ------------------------------------------------------------------ */
export interface SourcePage {
  page: number;
  text: string;
  docId?: string;
  docName?: string;
}

export interface Passage {
  docId: string;
  docName: string;
  page: number;
  text: string;
  /** Character offset of the passage inside the page's extracted text. */
  start: number;
}

export interface ChunkOptions {
  /** Soft upper bound per passage. Clamped to 120–4000 characters. */
  maxChars?: number;
  /** Characters of trailing context repeated in the next passage. */
  overlapChars?: number;
  /** Fallback document identity when a page doesn't carry one. */
  docId?: string;
  docName?: string;
}

export const DEFAULT_CHUNK_CHARS = 720;
const MAX_CHUNKS_PER_PAGE = 600;

interface Span {
  start: number;
  end: number;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Split a raw extracted page into trimmed sentence/line spans. */
function unitSpans(text: string, maxUnitChars: number): Span[] {
  const spans: Span[] = [];
  let start = 0;

  const pushSpan = (rawEnd: number) => {
    let begin = start;
    let end = rawEnd;
    while (begin < end && /\s/.test(text[begin])) begin++;
    while (end > begin && /\s/.test(text[end - 1])) end--;
    if (end > begin) spans.push({ start: begin, end });
    start = rawEnd;
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\n") {
      pushSpan(i);
      start = i + 1;
      continue;
    }
    if (char === "." || char === "!" || char === "?" || char === "…") {
      let end = i + 1;
      while (end < text.length && /["'”’)\]]/.test(text[end])) end++;
      const next = text[end] ?? "";
      // "3.14" and "e.g" stay inside their sentence.
      if (end >= text.length || /\s/.test(next)) {
        pushSpan(end);
        i = end - 1;
      }
    }
  }
  pushSpan(text.length);
  return splitLongSpans(text, spans, maxUnitChars);
}

/** Break spans longer than maxUnitChars at word boundaries. */
function splitLongSpans(text: string, spans: Span[], maxUnitChars: number): Span[] {
  if (maxUnitChars <= 0) return spans;
  const out: Span[] = [];
  for (const span of spans) {
    let cursor = span.start;
    while (span.end - cursor > maxUnitChars) {
      let cut = cursor + maxUnitChars;
      while (cut > cursor && !/\s/.test(text[cut])) cut--;
      if (cut <= cursor) cut = cursor + maxUnitChars;
      let end = cut;
      while (end > cursor && /\s/.test(text[end - 1])) end--;
      if (end > cursor) out.push({ start: cursor, end });
      cursor = cut;
      while (cursor < span.end && /\s/.test(text[cursor])) cursor++;
    }
    if (span.end > cursor) out.push({ start: cursor, end: span.end });
  }
  return out;
}

/**
 * Split extracted pages into overlapping, sentence-aligned passages.
 * Empty and whitespace-only pages are skipped.
 */
export function chunkPages(pages: readonly SourcePage[], opts: ChunkOptions = {}): Passage[] {
  const maxChars = Math.round(clamp(opts.maxChars ?? DEFAULT_CHUNK_CHARS, 120, 4000));
  const overlapChars = Math.round(clamp(opts.overlapChars ?? Math.round(maxChars * 0.15), 0, Math.floor(maxChars / 3)));
  const passages: Passage[] = [];

  for (const page of pages) {
    const rawText = page.text ?? "";
    if (!tokenize(rawText).length) continue;
    const spans = unitSpans(rawText, maxChars);
    if (!spans.length) continue;
    const docId = page.docId ?? opts.docId ?? "document";
    const docName = page.docName ?? opts.docName ?? "Document";
    let cursor = 0;
    let produced = 0;

    while (cursor < spans.length && produced < MAX_CHUNKS_PER_PAGE) {
      const chunkStart = spans[cursor].start;
      let last = cursor;
      while (last + 1 < spans.length && spans[last + 1].end - chunkStart <= maxChars) last++;
      const chunkEnd = spans[last].end;
      const text = rawText.slice(chunkStart, chunkEnd);
      if (tokenize(text).length) {
        passages.push({ docId, docName, page: page.page, text, start: chunkStart });
        produced++;
      }
      if (last + 1 >= spans.length) break;

      const overlapFloor = chunkEnd - overlapChars;
      let next = cursor + 1;
      while (next < spans.length && spans[next].end <= overlapFloor) next++;
      if (next >= spans.length) break;
      // Safety: always move forward even for pathological span layouts.
      if (spans[next].start <= chunkStart) next = last + 1;
      cursor = next;
    }
  }

  return passages;
}

/* ------------------------------------------------------------------ *
 * Ranking
 * ------------------------------------------------------------------ */
export interface RankOptions {
  /** Maximum passages returned. Defaults to 8. */
  limit?: number;
  /** BM25 term-frequency saturation. Defaults to 1.2. */
  k1?: number;
  /** BM25 length normalisation. Defaults to 0.75. */
  b?: number;
  /** Disable the phrase/proximity/sentence boost for raw BM25 order. */
  phraseBoost?: boolean;
}

export interface RankedPassage extends Passage {
  score: number;
  /** Score relative to the best passage (0–1). */
  normalizedScore: number;
  matchedTerms: string[];
}

export interface RankResult {
  query: string;
  terms: string[];
  passages: RankedPassage[];
  /** 0–1 retrieval confidence. Deterministic, never a model output. */
  confidence: number;
  candidates: number;
}

/** Lowercase, strip punctuation and collapse whitespace for phrase checks. */
function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Coverage of query terms inside the single most term-dense sentence. */
function bestSentenceCoverage(text: string, terms: readonly string[]): number {
  const spans = unitSpans(text, Math.max(240, Math.ceil(text.length / 8)));
  let best = 0;
  for (const span of spans) {
    const set = new Set(tokenize(text.slice(span.start, span.end)));
    let matched = 0;
    for (const term of terms) if (set.has(term)) matched++;
    const coverage = matched / terms.length;
    if (coverage > best) best = coverage;
  }
  return best;
}

/** Positions of each query term inside a token stream. */
function termPositions(tokens: readonly string[], terms: ReadonlySet<string>): { term: string; position: number }[] {
  const positions: { term: string; position: number }[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (terms.has(token)) positions.push({ term: token, position: index });
  }
  return positions;
}

/**
 * Rank passages against a query with BM25 (TF-IDF), then boost passages that
 * contain the phrase, place query terms close together, or hold a dense
 * sentence. Returns the top passages and a bounded confidence value.
 */
export function rankPassages(passages: readonly Passage[], query: string, opts: RankOptions = {}): RankResult {
  const terms = queryTerms(query);
  const candidates = passages.length;
  const limit = Math.round(clamp(opts.limit ?? 8, 1, 50));
  const k1 = Math.max(0, opts.k1 ?? 1.2);
  const b = clamp(opts.b ?? 0.75, 0, 1);
  const phraseBoost = opts.phraseBoost !== false;

  if (!terms.length || !candidates) {
    return { query, terms, passages: [], confidence: 0, candidates };
  }

  const tokenized = passages.map((passage) => tokenize(passage.text));
  const totalLength = tokenized.reduce((sum, tokens) => sum + tokens.length, 0);
  const averageLength = totalLength > 0 ? totalLength / candidates : 1;
  const termSet = new Set(terms);

  const documentFrequency = new Map<string, number>();
  for (const tokens of tokenized) {
    const unique = new Set(tokens);
    for (const term of terms) {
      if (unique.has(term)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  for (const term of terms) {
    const df = documentFrequency.get(term) ?? 0;
    idf.set(term, Math.log(1 + (candidates - df + 0.5) / (df + 0.5)));
  }

  const phrase = terms.join(" ");
  const scored = passages
    .map((passage, index) => {
      const tokens = tokenized[index];
      const length = Math.max(1, tokens.length);
      const counts = new Map<string, number>();
      for (const token of tokens) {
        if (termSet.has(token)) counts.set(token, (counts.get(token) ?? 0) + 1);
      }
      if (!counts.size) return { passage, score: 0, matchedTerms: [] as string[] };

      let score = 0;
      for (const [term, frequency] of counts) {
        const termIdf = idf.get(term) ?? 0;
        score += termIdf * ((frequency * (k1 + 1)) / (frequency + k1 * (1 - b + (b * length) / averageLength)));
      }

      if (phraseBoost) {
        let boost = 1;
        const normalized = normalizeSearchText(passage.text);
        if (terms.length > 1 && normalized.includes(phrase)) boost += 0.5;
        const positions = termPositions(tokens, termSet);
        let minimumGap = Number.POSITIVE_INFINITY;
        for (let a = 0; a < positions.length; a++) {
          for (let c = a + 1; c < positions.length; c++) {
            if (positions[a].term === positions[c].term) continue;
            minimumGap = Math.min(minimumGap, positions[c].position - positions[a].position);
          }
        }
        if (minimumGap <= 3) boost += 0.3;
        else if (minimumGap <= 6) boost += 0.12;
        boost += 0.2 * bestSentenceCoverage(passage.text, terms);
        score *= boost;
      }

      return { passage, score, matchedTerms: [...counts.keys()].sort() };
    })
    .filter((entry) => entry.score > 0);

  if (!scored.length) {
    return { query, terms, passages: [], confidence: 0, candidates };
  }

  scored.sort((a, b2) => {
    if (b2.score !== a.score) return b2.score - a.score;
    const byDoc = a.passage.docName < b2.passage.docName ? -1 : a.passage.docName > b2.passage.docName ? 1 : 0;
    if (byDoc !== 0) return byDoc;
    if (a.passage.page !== b2.passage.page) return a.passage.page - b2.passage.page;
    return a.passage.start - b2.passage.start;
  });

  const topScore = scored[0].score;
  const totalScore = scored.reduce((sum, entry) => sum + entry.score, 0);
  const top = scored[0];
  const dominance = topScore > 0 ? topScore / totalScore : 0;
  const coverage = top.matchedTerms.length / terms.length;
  const strength = topScore / (topScore + 2);
  const confidence = clamp(0.4 * strength + 0.35 * coverage + 0.25 * dominance, 0, 1);

  const ranked: RankedPassage[] = scored.slice(0, limit).map((entry) => ({
    ...entry.passage,
    score: entry.score,
    normalizedScore: topScore > 0 ? entry.score / topScore : 0,
    matchedTerms: entry.matchedTerms,
  }));

  return { query, terms, passages: ranked, confidence, candidates };
}

/* ------------------------------------------------------------------ *
 * Highlights & answer windows
 * ------------------------------------------------------------------ */
export interface HighlightRange {
  start: number;
  end: number;
  /** The query term that produced the highlight (normalised). */
  term: string;
}

interface TokenSpan {
  token: string;
  start: number;
  end: number;
}

function tokenSpans(text: string): TokenSpan[] {
  const spans: TokenSpan[] = [];
  const regex = new RegExp(TOKEN_SOURCE, "gu");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    const token = match[0].toLowerCase().replace(/’/g, "'").replace(/^'+|'+$/g, "");
    if (token.length >= 2) spans.push({ token, start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

/** Whole-token, case-insensitive highlight ranges for a set of query terms. */
export function highlightRanges(text: string, terms: readonly string[]): HighlightRange[] {
  if (!text || !terms.length) return [];
  const wanted = new Map<string, string>();
  for (const term of terms) {
    for (const token of tokenize(term)) wanted.set(token, token);
  }
  if (!wanted.size) return [];
  const ranges: HighlightRange[] = [];
  for (const span of tokenSpans(text)) {
    const term = wanted.get(span.token);
    if (term) ranges.push({ start: span.start, end: span.end, term });
  }
  return ranges;
}

export interface AnswerWindow {
  text: string;
  docId: string;
  docName: string;
  page: number;
  /** Offset inside the page's extracted text (approximate when whitespace collapsed). */
  start: number;
  end: number;
  highlights: HighlightRange[];
  score: number;
}

export interface AnswerOptions {
  /** Maximum sentences returned. Defaults to 2. */
  maxSentences?: number;
  /** Maximum characters per sentence window. Defaults to 800. */
  maxChars?: number;
}

/**
 * Select the most informative verbatim sentence(s) for a query.
 * Passages should normally come from rankPassages, best first, but any
 * passage list works.
 */
export function extractAnswerWindows(
  passages: readonly Passage[],
  queryChars: string,
  opts: AnswerOptions = {},
): AnswerWindow[] {
  const terms = queryTerms(queryChars);
  const maxSentences = Math.round(clamp(opts.maxSentences ?? 2, 1, 5));
  const maxChars = Math.round(clamp(opts.maxChars ?? 800, 120, 2000));
  if (!terms.length || !passages.length) return [];

  const scored: AnswerWindow[] = [];
  for (const passage of passages) {
    if (!passage.text) continue;
    const spans = unitSpans(passage.text, maxChars);
    for (const span of spans) {
      const sentence = passage.text.slice(span.start, span.end);
      const tokens = tokenize(sentence);
      if (!tokens.length) continue;
      const tokenSet = new Set(tokens);
      const matched = terms.filter((term) => tokenSet.has(term));
      if (!matched.length) continue;
      const coverage = matched.length / terms.length;
      const density = matched.length / Math.sqrt(Math.max(4, tokens.length));
      const phrase = terms.length > 1 && normalizeSearchText(sentence).includes(terms.join(" ")) ? 0.25 : 0;
      const score = coverage * 2 + density + phrase;
      scored.push({
        text: sentence,
        docId: passage.docId,
        docName: passage.docName,
        page: passage.page,
        start: passage.start + span.start,
        end: passage.start + span.end,
        highlights: highlightRanges(sentence, terms),
        score,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.page - b.page || a.start - b.start);
  const picked: AnswerWindow[] = [];
  const perSource = new Map<string, number>();
  for (const window of scored) {
    const sourceKey = `${window.docId}\u0000${window.page}`;
    const used = perSource.get(sourceKey) ?? 0;
    if (used >= 2) continue;
    perSource.set(sourceKey, used + 1);
    picked.push(window);
    if (picked.length >= maxSentences) break;
  }
  return picked;
}

/* ------------------------------------------------------------------ *
 * Verdict
 * ------------------------------------------------------------------ */
export type VerdictStatus = "answered" | "weak" | "not-found";

export interface Verdict {
  status: VerdictStatus;
  confidence: number;
  matchedTerms: string[];
}

export interface VerdictThresholds {
  /** At or above this confidence a result is "answered". Defaults to 0.55. */
  answered?: number;
  /** At or above this confidence a result is "weak" rather than "not-found". Defaults to 0.32. */
  weak?: number;
}

/** Turn ranked retrieval into an honest three-way verdict. */
export function verdict(
  query: string,
  results: RankResult | readonly RankedPassage[],
  thresholds: VerdictThresholds = {},
): Verdict {
  const terms = queryTerms(query);
  const answeredAt = thresholds.answered ?? 0.55;
  const weakAt = thresholds.weak ?? 0.32;
  const rankResult = Array.isArray(results) ? null : (results as RankResult);
  const list: readonly RankedPassage[] = rankResult ? rankResult.passages : (results as readonly RankedPassage[]);

  const matched = new Set<string>();
  for (const passage of list) for (const term of passage.matchedTerms) matched.add(term);

  let confidence: number;
  if (rankResult) {
    confidence = clamp(rankResult.confidence, 0, 1);
  } else {
    const top = list[0];
    if (!top) confidence = 0;
    else {
      const total = list.reduce((sum, passage) => sum + Math.max(0, passage.score), 0);
      const dominance = total > 0 ? Math.max(0, top.score) / total : 0;
      const topCoverage = terms.length ? top.matchedTerms.length / terms.length : 0;
      confidence = clamp(0.4 * (top.score / (top.score + 2)) + 0.35 * topCoverage + 0.25 * dominance, 0, 1);
    }
  }

  if (!terms.length || !list.length || !matched.size) {
    return { status: "not-found", confidence: 0, matchedTerms: [] };
  }
  if (confidence >= answeredAt) {
    return { status: "answered", confidence, matchedTerms: [...matched].sort() };
  }
  if (confidence >= weakAt) {
    return { status: "weak", confidence, matchedTerms: [...matched].sort() };
  }
  return { status: "not-found", confidence, matchedTerms: [...matched].sort() };
}
