import {
  AlertTriangle,
  Archive,
  Check,
  ClipboardPaste,
  Code2,
  Download,
  ExternalLink,
  FileCode2,
  Info,
  Loader2,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  X,
} from "lucide-react";
import { PDFArray, PDFDict, PDFName, PDFRef } from "@cantoo/pdf-lib";
import { useEffect, useMemo, useRef, useState } from "react";
import html2canvas from "html2canvas";
import {
  PDFDocument,
  baseName,
  dataUrlToBytes,
  downloadBytes,
  embedFonts,
  formatBytes,
  hexToRgb,
  openPdfLib,
  safePdfText,
  sanitizeName,
  type FontPack,
  type PDFDocument as PDFDocumentType,
  type PDFPage,
} from "@/lib/pdf";
import { useInitialFiles, usePdfFile } from "@/lib/usePdf";
import { Alert, Button, Field, Progress, Segmented, Select, Switch, inputClass } from "@/components/ui";
import { DownloadPanel, SinglePdfInput } from "@/components/toolParts";
import { AdvancedOptions, OptionNote, OptionsGrid, PresetChips, SliderField } from "@/components/AdvancedOptions";
import { paperDimensions, type PaperKey } from "@/lib/layout";
import { cn } from "@/utils/cn";
import { friendlyProcessingError, sanitizeHtml as sanitizeUntrustedHtml, validateUpload } from "@/lib/security";
import { writeOutline, type OutlineEntry } from "@/lib/outline";
import { SAMPLE } from "@/lib/sample";
import { useToolPreferences } from "@/lib/prefs";
import { describeJobTime, useJob } from "@/lib/job";
import { useDownloadShortcut, usePrimaryShortcut } from "@/lib/hotkeys";
import { downloadOutput } from "@/lib/output";

/* ================================================================== *
 * HTML → PDF
 * ================================================================== */
const BASE_CSS = `
.html-doc { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1f2a24; font-size: 15px; line-height: 1.6; background: #fff; }
.html-doc * { box-sizing: border-box; }
.html-doc h1 { font-size: 30px; line-height: 1.15; margin: 0 0 14px; color: #12211a; letter-spacing: -0.02em; }
.html-doc h2 { font-size: 21px; line-height: 1.25; margin: 26px 0 10px; color: #1c4c3b; }
.html-doc h3 { font-size: 17px; margin: 20px 0 8px; color: #1c4c3b; }
.html-doc p { margin: 0 0 12px; }
.html-doc ul, .html-doc ol { margin: 0 0 14px 22px; padding: 0; }
.html-doc li { margin: 0 0 5px; }
.html-doc a { color: #1c4c3b; text-decoration: underline; }
.html-doc strong { color: #12211a; }
.html-doc blockquote { margin: 14px 0; padding: 8px 14px; border-left: 3px solid #1c4c3b; background: #f4f2e9; color: #3b4a42; }
.html-doc code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; background: #f1eee4; padding: 1px 5px; border-radius: 4px; }
.html-doc pre { background: #f1eee4; padding: 12px 14px; border-radius: 8px; overflow-x: auto; }
.html-doc pre code { background: none; padding: 0; }
.html-doc table { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 13px; }
.html-doc th, .html-doc td { border: 1px solid #ddd8ca; padding: 7px 9px; text-align: left; vertical-align: top; }
.html-doc th { background: #ece9de; font-weight: 600; color: #12211a; }
.html-doc tr:nth-child(even) td { background: #faf8f2; }
.html-doc img { max-width: 100%; height: auto; }
.html-doc hr { border: 0; border-top: 1px solid #ddd8ca; margin: 22px 0; }
.html-doc .muted { color: #6b766f; }
`;

/** Print without backgrounds: drop every painted background and shadow. */
const NO_BACKGROUND_CSS = `
.html-doc, .html-doc * { background: transparent !important; box-shadow: none !important; }
`;

const TEMPLATE = `<!doctype html>
<html>
  <body>
    <h1>Project Field Report</h1>
    <p class="muted"><strong>Prepared by:</strong> Alex Morgan · <strong>Date:</strong> March 2026</p>

    <h2>Overview</h2>
    <p>
      This document was authored in HTML and converted to PDF in the browser.
      Headings, lists, tables and <strong>emphasis</strong> keep their visual hierarchy.
    </p>

    <h2>Delivery summary</h2>
    <ul>
      <li>Twelve of twelve workstreams delivered</li>
      <li>Processing time reduced by 38%</li>
      <li>All high-severity incidents closed within SLA</li>
    </ul>

    <h2>Metrics</h2>
    <table>
      <thead><tr><th>Metric</th><th>Target</th><th>Actual</th></tr></thead>
      <tbody>
        <tr><td>Workstreams</td><td>12</td><td>12</td></tr>
        <tr><td>Processing time</td><td>40 min</td><td>25 min</td></tr>
        <tr><td>Security findings closed</td><td>90%</td><td>100%</td></tr>
      </tbody>
    </table>

    <blockquote>A quiet, factual summary helps readers find the detail that matters.</blockquote>

    <h2>Next steps</h2>
    <ol>
      <li>Complete the archive migration</li>
      <li>Validate the rollback plan</li>
      <li>Prepare next quarter’s plan</li>
    </ol>
  </body>
</html>`;

/** DOMPurify + strict post-processing; resource URLs are limited to data images. */
function sanitizeHtml(input: string) {
  return sanitizeUntrustedHtml(input);
}

/** Categories of markup the sanitiser strips, counted from the raw source. */
const STRIPPED_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "script tags", pattern: /<script\b/gi },
  { label: "iframes", pattern: /<iframe\b/gi },
  { label: "forms and inputs", pattern: /<(form|input|button|select|textarea)\b/gi },
  { label: "objects and embeds", pattern: /<(object|embed|applet)\b/gi },
  { label: "style blocks", pattern: /<style\b/gi },
  { label: "document head tags", pattern: /<(link|meta|base)\b/gi },
  { label: "event handler attributes", pattern: /\son[a-z]+\s*=/gi },
  { label: "remote images", pattern: /<img\b[^>]*\bsrc\s*=\s*["']?(?!data:image\/)/gi },
  { label: "javascript: URLs", pattern: /javascript\s*:/gi },
];

interface SanitiseReportRow {
  label: string;
  count: number;
}

function describeSanitisation(raw: string, totals: { removedElements: number; removedAttributes: number; blockedImages: number }) {
  const rows: SanitiseReportRow[] = [];
  for (const { label, pattern } of STRIPPED_PATTERNS) {
    const count = (raw.match(pattern) ?? []).length;
    if (count > 0) rows.push({ label, count });
  }
  const total = totals.removedElements + totals.removedAttributes + totals.blockedImages;
  return { rows: rows.slice(0, 8), total };
}

interface HeadingMark {
  title: string;
  level: number;
  offsetPx: number;
}

async function renderHtmlToCanvas(
  html: string,
  widthPx: number,
  scale: number,
  printBackgrounds: boolean,
): Promise<{ canvas: HTMLCanvasElement; headings: HeadingMark[] }> {
  const host = document.createElement("div");
  // Isolated, inert render surface: no scripts survive sanitisation, the subtree is
  // aria-hidden, pointer-inert and never mounted inside the application shell.
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("inert", "");
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${widthPx}px;background:#ffffff;padding:0;z-index:-1;pointer-events:none;contain:strict;`;
  const style = document.createElement("style");
  style.textContent = printBackgrounds ? BASE_CSS : `${BASE_CSS}\n${NO_BACKGROUND_CSS}`;
  const doc = document.createElement("div");
  doc.className = "html-doc";
  doc.style.cssText = "width:100%;padding:0;background:#fff;";
  doc.innerHTML = html;
  host.appendChild(style);
  host.appendChild(doc);
  document.body.appendChild(host);
  try {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    // Wait for any same-origin images to settle before rasterizing.
    await Promise.all(
      Array.from(doc.querySelectorAll("img")).map(
        (image) =>
          new Promise<void>((resolve) => {
            if (image.complete) return resolve();
            image.addEventListener("load", () => resolve(), { once: true });
            image.addEventListener("error", () => resolve(), { once: true });
            setTimeout(resolve, 4000);
          }),
      ),
    );
    // Measure heading positions before rendering so they can become bookmarks.
    const docTop = doc.getBoundingClientRect().top;
    const headings: HeadingMark[] = [];
    for (const element of Array.from(doc.querySelectorAll("h1, h2, h3, h4, h5, h6")).slice(0, 240)) {
      const title = (element.textContent ?? "").replace(/\s+/g, " ").trim();
      if (title.length < 2) continue;
      headings.push({
        title,
        level: Math.min(6, Number(element.tagName.slice(1)) || 1),
        offsetPx: Math.max(0, element.getBoundingClientRect().top - docTop),
      });
    }
    const canvas = await html2canvas(doc, {
      scale,
      backgroundColor: "#ffffff",
      logging: false,
      useCORS: false,
      allowTaint: false,
      foreignObjectRendering: false,
      imageTimeout: 2000,
      windowWidth: widthPx,
    });
    return { canvas, headings };
  } finally {
    host.remove();
  }
}

const HTML_DEFAULTS = {
  paper: "a4" as PaperKey,
  orientation: "portrait" as "portrait" | "landscape",
  margin: 48,
  scale: 100,
  quality: "high" as "standard" | "high",
  printBackgrounds: true,
  embedSource: true,
  bookmarks: true,
  headerText: "",
  footerText: "",
};

interface HtmlConversionResult {
  bytes: Uint8Array;
  name: string;
  pages: number;
  removed: number;
  bookmarks: number;
  headings: number;
  /** The page setup actually used, so the result panel never drifts. */
  layout: string;
}

export function HtmlToPdfTool() {
  const opts = useToolPreferences("html-to-pdf", HTML_DEFAULTS);
  const [html, setHtml] = useState(TEMPLATE);
  const [sourceName, setSourceName] = useState("html-document");
  const [notice, setNotice] = useState("");
  const [readError, setReadError] = useState("");
  const job = useJob<HtmlConversionResult>();

  const sanitized = useMemo(() => sanitizeHtml(html), [html]);
  const sanitiseReport = useMemo(
    () =>
      describeSanitisation(html, {
        removedElements: sanitized.removedElements,
        removedAttributes: sanitized.removedAttributes,
        blockedImages: sanitized.blockedImages,
      }),
    [html, sanitized],
  );
  // The preview is embedded in an application page that already owns the single
  // <h1>. Demote authored headings in the preview only, so the document outline
  // stays correct for assistive technology; the exported PDF keeps the original
  // hierarchy.
  const previewHtml = useMemo(
    () =>
      sanitized.html
        .replace(/<h5([\s>])/gi, "<h6$1").replace(/<\/h5>/gi, "</h6>")
        .replace(/<h4([\s>])/gi, "<h5$1").replace(/<\/h4>/gi, "</h5>")
        .replace(/<h3([\s>])/gi, "<h4$1").replace(/<\/h3>/gi, "</h4>")
        .replace(/<h2([\s>])/gi, "<h3$1").replace(/<\/h2>/gi, "</h3>")
        .replace(/<h1([\s>])/gi, "<h2$1").replace(/<\/h1>/gi, "</h2>"),
    [sanitized.html],
  );
  const page = paperDimensions(opts.value.paper, opts.value.orientation);

  const updateHtml = (next: string, source?: string) => {
    setHtml(next);
    if (source) setSourceName(source);
    setReadError("");
    setNotice("");
    if (!job.busy) job.reset();
  };

  const loadSample = async () => {
    setReadError("");
    try {
      const file = await SAMPLE.html.create();
      updateHtml((await file.text()).slice(0, 2_000_000), baseName(file.name));
      setNotice("Sample page loaded. Its <style> block is stripped by the sanitiser — see the report below — exactly as any pasted page would be.");
    } catch (err) {
      setReadError(friendlyProcessingError(err, "The sample page couldn’t be prepared in this browser."));
    }
  };

  const pasteFromClipboard = async () => {
    setReadError("");
    setNotice("");
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") {
        throw new Error("unsupported");
      }
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setReadError("The clipboard is empty. Copy some HTML first, or click into the editor and press ⌘V.");
        return;
      }
      updateHtml(text.slice(0, 2_000_000));
      setNotice("Pasted from the clipboard. Check the sanitisation report before converting.");
    } catch {
      setReadError("Your browser blocked clipboard access. Click into the editor and press ⌘/Ctrl+V to paste instead.");
    }
  };

  const convert = () =>
    job.run(async ({ report: progress, throwIfCancelled }) => {
      const clean = sanitizeHtml(html);
      if (!clean.html.trim()) throw new Error("Your HTML is empty. Add some content or load the sample page.");
      const cfg = opts.value;
      const dims = paperDimensions(cfg.paper, cfg.orientation);
      const margin = cfg.margin * 0.75;
      const widthPt = dims.w - margin * 2;
      const heightPt = dims.h - margin * 2;
      const raster = cfg.quality === "high" ? 2 : 1.4;
      // CSS pixels per page point: scale 100% is the usual 96 dpi layout.
      const cssPerPoint = (4 / 3) * (100 / cfg.scale);
      const layoutWidth = Math.max(220, Math.round(widthPt * cssPerPoint));
      const sliceHeight = Math.max(1, Math.round(heightPt * cssPerPoint * raster));

      progress(6, "Laying out HTML…");
      throwIfCancelled();
      const rendered = await renderHtmlToCanvas(clean.html, layoutWidth, raster, cfg.printBackgrounds);
      throwIfCancelled();
      const canvas = rendered.canvas;
      if (!canvas.width || !canvas.height) throw new Error("Nothing visible was rendered. Check your HTML markup.");

      const pageCount = Math.max(1, Math.ceil(canvas.height / sliceHeight));
      if (pageCount > 300) throw new Error("That HTML would produce more than 300 pages. Shorten it or reduce the text scale.");
      progress(16, `Paginating ${pageCount} page${pageCount === 1 ? "" : "s"}…`);

      const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
      const documentTitle = titleTag || baseName(sourceName) || "html-document";
      const out = await PDFDocument.create();
      const needsChrome = Boolean(cfg.headerText.trim() || cfg.footerText.trim());
      const fonts: FontPack | null = needsChrome ? await embedFonts(out) : null;

      const fillTemplate = (template: string, index: number) =>
        template
          .replace(/\{page\}/gi, String(index + 1))
          .replace(/\{pages\}/gi, String(pageCount))
          .replace(/\{title\}/gi, documentTitle);

      const drawChrome = (target: PDFPage, index: number) => {
        if (!fonts) return;
        const fit = (text: string) => {
          const value = safePdfText(text);
          if (!fonts.regular.widthOfTextAtSize(value, 8.5) || fonts.regular.widthOfTextAtSize(value, 8.5) <= widthPt) return value;
          let cut = value.length;
          while (cut > 1 && fonts.regular.widthOfTextAtSize(`${value.slice(0, cut)}…`, 8.5) > widthPt) cut -= 1;
          return `${value.slice(0, cut)}…`;
        };
        const header = fillTemplate(cfg.headerText, index).trim();
        if (header) {
          const text = fit(header);
          const textWidth = fonts.regular.widthOfTextAtSize(text, 8.5);
          target.drawText(text, {
            x: margin + Math.max(0, (widthPt - textWidth) / 2),
            y: dims.h - Math.max(13, margin * 0.55),
            size: 8.5,
            font: fonts.regular,
            color: hexToRgb("#6b766f"),
          });
        }
        const footer = fillTemplate(cfg.footerText, index).trim();
        if (footer) {
          const text = fit(footer);
          const textWidth = fonts.regular.widthOfTextAtSize(text, 8.5);
          target.drawText(text, {
            x: margin + Math.max(0, (widthPt - textWidth) / 2),
            y: Math.max(13, margin * 0.5),
            size: 8.5,
            font: fonts.regular,
            color: hexToRgb("#6b766f"),
          });
        }
      };

      for (let index = 0; index < pageCount; index++) {
        throwIfCancelled();
        const from = index * sliceHeight;
        const sliceCssHeight = Math.min(sliceHeight, canvas.height - from);
        const slice = document.createElement("canvas");
        slice.width = canvas.width;
        slice.height = Math.max(1, sliceCssHeight);
        const ctx = slice.getContext("2d");
        if (!ctx) throw new Error("Your browser couldn’t create the page canvas. Try a smaller document.");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, slice.width, slice.height);
        ctx.drawImage(canvas, 0, from, canvas.width, sliceCssHeight, 0, 0, canvas.width, sliceCssHeight);
        const image = await out.embedJpg(dataUrlToBytes(slice.toDataURL("image/jpeg", cfg.quality === "high" ? 0.92 : 0.85)));
        const target = out.addPage([dims.w, dims.h]);
        const drawH = (slice.height / canvas.width) * widthPt;
        const capped = Math.min(drawH, heightPt);
        target.drawImage(image, {
          x: margin,
          y: dims.h - margin - capped,
          width: widthPt,
          height: capped,
        });
        drawChrome(target, index);
        progress(16 + ((index + 1) / pageCount) * 72, `Writing page ${index + 1} of ${pageCount}…`);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      throwIfCancelled();
      let bookmarks = 0;
      if (cfg.bookmarks && rendered.headings.length) {
        const entries: OutlineEntry[] = rendered.headings.map((heading, index) => ({
          id: `h${index}`,
          title: heading.title,
          level: heading.level,
          page: Math.min(pageCount, Math.max(1, Math.floor((heading.offsetPx * raster) / sliceHeight) + 1)),
        }));
        try {
          bookmarks = writeOutline(out, entries).nodeCount;
        } catch {
          bookmarks = 0;
        }
      }

      if (cfg.embedSource) {
        try {
          await out.attach(new TextEncoder().encode(html), "source.html", {
            mimeType: "text/html",
            description: "Original HTML source · attached by Paperly",
            creationDate: new Date(),
            modificationDate: new Date(),
          });
        } catch {
          /* attachment support is optional; the PDF is still valid */
        }
      }
      out.setTitle(documentTitle);
      out.setProducer("Paperly · local HTML rendering");
      out.setCreator("Paperly");
      progress(94, "Saving the PDF…");
      const bytes = await out.save();
      return {
        bytes,
        name: `${sanitizeName(documentTitle.slice(0, 60))}.pdf`,
        pages: pageCount,
        removed: sanitiseReport.total,
        bookmarks,
        headings: rendered.headings.length,
        layout: `${cfg.paper.toUpperCase()} ${cfg.orientation} · ${cfg.scale}% scale`,
      };
    });

  const result = job.result;
  usePrimaryShortcut(() => void convert(), Boolean(html.trim()) && !job.busy);
  useDownloadShortcut(
    () => {
      if (result) downloadOutput(result.bytes, result.name, "application/pdf");
    },
    Boolean(result),
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-ink/75">
          <Code2 className="h-3 w-3" /> HTML input
        </span>
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-line bg-paper px-3 py-1.5 text-[11.5px] font-medium hover:border-forest/35 hover:text-forest">
          <UploadCloud className="h-3 w-3" /> Upload .html
          <input
            type="file"
            accept=".html,.htm,text/html"
            className="sr-only"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              try {
                await validateUpload(file, ".html,.htm,text/html");
                const text = await file.text();
                updateHtml(text.slice(0, 2_000_000), baseName(file.name));
                setNotice(`${file.name} loaded. The sanitiser report below lists anything it removed.`);
              } catch (err) {
                setReadError(friendlyProcessingError(err, "That HTML file couldn’t be read."));
              }
            }}
          />
        </label>
        <button
          type="button"
          onClick={() => void pasteFromClipboard()}
          className="inline-flex items-center gap-1.5 rounded-full border border-line bg-paper px-3 py-1.5 text-[11.5px] font-medium text-ink/75 transition-colors hover:border-forest/35 hover:text-forest"
        >
          <ClipboardPaste className="h-3 w-3" /> Paste HTML
        </button>
        <button
          type="button"
          onClick={() => void loadSample()}
          className="inline-flex items-center gap-1.5 rounded-full border border-forest/20 bg-lime/25 px-3 py-1.5 text-[11.5px] font-medium text-forest transition-colors hover:bg-lime/40"
        >
          <Sparkles className="h-3 w-3" /> Sample page
        </button>
        <button
          type="button"
          onClick={() => updateHtml("")}
          className="ml-auto text-[11px] font-medium text-ink/75 hover:text-clay-ink"
        >
          Clear editor
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
        <div>
          <label htmlFor="html-source" className="mb-1.5 block text-[12px] font-semibold uppercase tracking-[0.06em] text-ink/70">
            HTML source
          </label>
          <textarea
            id="html-source"
            value={html}
            onChange={(e) => updateHtml(e.target.value)}
            spellCheck={false}
            className="h-[380px] w-full resize-y rounded-xl border border-line bg-paper px-3.5 py-3 font-mono text-[12px] leading-relaxed focus:border-forest/40 focus:outline-none focus:ring-2 focus:ring-forest/10"
            placeholder="<h1>Hello</h1><p>Your content…</p>"
          />
          {notice && <p className="mt-1.5 text-[10.5px] leading-relaxed text-forest">{notice}</p>}
          {readError && (
            <p role="alert" className="mt-1.5 text-[10.5px] leading-relaxed font-medium text-clay-ink">
              {readError}
            </p>
          )}
          <div className="mt-2 rounded-xl border border-line bg-bone-deep/30 p-2.5">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold text-forest">
              <ShieldCheck className="h-3.5 w-3.5" /> Sanitisation report
              {sanitiseReport.total > 0 ? (
                <span className="rounded-full border border-amber-500/25 bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.05em] text-amber-900">
                  {sanitiseReport.total} removed
                </span>
              ) : (
                <span className="rounded-full border border-forest/15 bg-lime/35 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.05em] text-forest">
                  clean
                </span>
              )}
            </p>
            {sanitiseReport.total > 0 ? (
              <>
                <p className="mt-1 text-[10.5px] leading-relaxed text-ink/75">
                  {sanitiseReport.total} unsafe item{sanitiseReport.total === 1 ? "" : "s"} were removed by the sanitiser (scripts, iframes, forms, event handlers,
                  remote images or unsafe CSS). Inline <code>style</code> rules on the allowlist still work.
                </p>
                {sanitiseReport.rows.length > 0 && (
                  <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                    {sanitiseReport.rows.map((row) => (
                      <li key={row.label} className="text-[10.5px] text-amber-900">
                        {row.count} × {row.label}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="mt-1 text-[10.5px] leading-relaxed text-muted">
                Nothing was stripped from this markup. Scripts, iframes and remote resources would be removed before rendering.
              </p>
            )}
          </div>
        </div>
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-ink/70">Preview</p>
            <span className="text-[10.5px] text-muted">Sanitised render</span>
          </div>
          <div tabIndex={0} role="region" aria-label="Sanitised HTML preview" className="h-[380px] overflow-auto rounded-xl border border-line bg-white p-5 scrollbar-thin">
            <style dangerouslySetInnerHTML={{ __html: BASE_CSS }} />
            <div className="html-doc" role="document" aria-label="Sanitised HTML preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Page size">
          <Select value={opts.value.paper} onChange={(e) => opts.set("paper", e.target.value as PaperKey)}>
            <option value="a4">A4</option>
            <option value="letter">US Letter</option>
            <option value="legal">US Legal</option>
            <option value="a5">A5</option>
            <option value="a3">A3</option>
          </Select>
        </Field>
        <Field label="Orientation">
          <Segmented
            value={opts.value.orientation}
            onChange={(value) => opts.set("orientation", value)}
            size="sm"
            options={[
              { value: "portrait", label: "Portrait" },
              { value: "landscape", label: "Landscape" },
            ]}
          />
        </Field>
      </div>

      <AdvancedOptions
        scope="html-to-pdf"
        badge="8 controls"
        description="Text scale, margins, bleed, header and footer, bookmarks, render quality"
        onReset={opts.reset}
      >
        <OptionsGrid>
          <SliderField
            label="Text scale"
            value={opts.value.scale}
            onChange={(value) => opts.set("scale", value)}
            min={40}
            max={100}
            step={5}
            format={(value) => `${value}%`}
            hint="Smaller text fits more on every page."
          />
          <SliderField
            label="Margins"
            value={opts.value.margin}
            onChange={(value) => opts.set("margin", value)}
            min={0}
            max={96}
            step={4}
            format={(value) => `${Math.round((value / 96) * 25.4)} mm`}
            hint="White space around the printed content."
          />
          <Field label="Render quality" hint="Higher quality keeps text crisper at larger file sizes.">
            <Select value={opts.value.quality} onChange={(e) => opts.set("quality", e.target.value as "standard" | "high")}>
              <option value="high">High · sharper, larger file</option>
              <option value="standard">Standard · smaller file</option>
            </Select>
          </Field>
          <Field label="Header text" hint="Optional. {page}, {pages} and {title} are filled in.">
            <input
              value={opts.value.headerText}
              maxLength={120}
              placeholder="e.g. Field report"
              onChange={(e) => opts.set("headerText", e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Footer text" hint="Optional. Use {page} of {pages} for numbering.">
            <input
              value={opts.value.footerText}
              maxLength={120}
              placeholder="e.g. Page {page} of {pages}"
              onChange={(e) => opts.set("footerText", e.target.value)}
              className={inputClass}
            />
          </Field>
        </OptionsGrid>
        <div className="mt-3 space-y-2">
          <Switch
            checked={opts.value.printBackgrounds}
            onChange={(value) => opts.set("printBackgrounds", value)}
            label="Print backgrounds"
            description="Off prints text only, with white backgrounds — the ink-saving choice"
          />
          <Switch
            checked={opts.value.bookmarks}
            onChange={(value) => opts.set("bookmarks", value)}
            label="Headings become bookmarks"
            description="Every h1–h6 in the source becomes a PDF bookmark at its page"
          />
          <Switch
            checked={opts.value.embedSource}
            onChange={(value) => opts.set("embedSource", value)}
            label="Attach the HTML source"
            description="Embeds source.html inside the PDF so the original markup is recoverable"
          />
        </div>
        <div className="mt-3">
          <OptionNote>
            The page is laid out like a web page and printed as an image, so text isn’t selectable. Headings, bookmarks and header/footer text are
            real PDF content. Nothing is uploaded.
          </OptionNote>
        </div>
      </AdvancedOptions>

      <div className="rounded-xl border border-line bg-bone-deep/35 p-3 text-[11.5px] leading-relaxed text-ink/70">
        <p className="flex items-center gap-1.5 font-semibold text-forest">
          <ShieldCheck className="h-3.5 w-3.5" /> Visual conversion, rendered locally
        </p>
        <p className="mt-1">
          Scripts never run and remote resources are never requested — the sanitiser removes them before a single pixel is drawn. Use Markdown to PDF
          or Word to PDF when you need selectable text.
        </p>
      </div>

      {job.failed && <Alert tone="error">{job.error}</Alert>}
      {job.status === "cancelled" && <Alert tone="info">Cancelled — nothing was downloaded.</Alert>}
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Button onClick={() => void convert()} loading={job.busy} disabled={!html.trim()}>
          <FileCode2 className="h-4 w-4" /> Convert HTML to PDF
        </Button>
        {job.busy && (
          <Button variant="ghost" onClick={job.cancel}>
            Cancel
          </Button>
        )}
        <span className="text-[11.5px] text-muted">
          {Math.round((page.w / 72) * 25.4)} × {Math.round((page.h / 72) * 25.4)} mm · {opts.value.quality === "high" ? "2×" : "1.4×"} raster · ⌘↵ to
          convert
        </span>
      </div>
      {job.busy && (
        <Progress value={job.percent ?? undefined} label={job.label || "Laying out HTML and paginating…"} etaMs={job.etaMs} detail={describeJobTime(job)} />
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="HTML converted to PDF"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          onDownload={() => downloadBytes(result.bytes, result.name)}
          facts={[
            { label: "Layout", value: result.layout },
            ...(result.bookmarks ? [{ label: "Bookmarks", value: String(result.bookmarks) }] : []),
          ]}
          description={`${result.pages} page${result.pages === 1 ? "" : "s"} · ${formatBytes(result.bytes.byteLength)} · rendered locally${result.removed ? ` · ${result.removed} unsafe element(s) stripped` : ""}`}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * ARCHIVE PREPARATION
 * ================================================================== */
interface AuditCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

type ArchiveProfile = "pdfa-1b" | "pdfa-2b" | "pdfa-3b";

const ARCHIVE_PROFILES: { id: ArchiveProfile; label: string; description: string; allowsAttachments: boolean }[] = [
  {
    id: "pdfa-1b",
    label: "PDF/A-1b",
    description: "The strictest baseline. Embedded files are not allowed, so the original is not attached.",
    allowsAttachments: false,
  },
  {
    id: "pdfa-2b",
    label: "PDF/A-2b",
    description: "The modern baseline. Embedded files are allowed, but they should themselves be archival.",
    allowsAttachments: true,
  },
  {
    id: "pdfa-3b",
    label: "PDF/A-3b · attachments",
    description: "The profile for documents that carry their source file. Use it when you embed the original.",
    allowsAttachments: true,
  },
];

const ARCHIVE_DEFAULTS = {
  profile: "pdfa-2b" as ArchiveProfile,
  flattenForms: true,
  stripActions: true,
  normalize: true,
  embedOriginal: true,
};

interface ArchiveResult {
  bytes: Uint8Array;
  name: string;
  pages: number;
  fields: number;
  stripped: number;
  embedded: boolean;
  profile: ArchiveProfile;
  /** Readiness checks for the source, run during preparation. */
  before: AuditCheck[];
  /** The same checks, run on the prepared copy. */
  after: AuditCheck[];
}

/** Everything the readiness check inspects, for one PDF's bytes. */
async function auditPdf(bytes: ArrayBuffer | Uint8Array): Promise<AuditCheck[]> {
  const raw = new TextDecoder("latin1").decode(new Uint8Array(bytes));
  const doc = await openPdfLib(bytes);
  const catalog = doc.catalog;
  const context = doc.context;
  const checks: AuditCheck[] = [];

  const encrypted = raw.includes("/Encrypt");
  checks.push({
    id: "encryption",
    label: "No encryption",
    status: encrypted ? "fail" : "pass",
    detail: encrypted
      ? "The file is encrypted. Archival copies should open without a password — unlock it first."
      : "The file is unencrypted and can be read without a password.",
  });

  let javascript = false;
  try {
    const names = catalog.lookup(PDFName.of("Names"));
    if (names instanceof PDFDict) javascript = names.has(PDFName.of("JavaScript"));
  } catch {
    javascript = false;
  }
  const hasOpenAction = catalog.has(PDFName.of("OpenAction"));
  checks.push({
    id: "javascript",
    label: "No scripts or automatic actions",
    status: javascript ? "fail" : hasOpenAction ? "warn" : "pass",
    detail: javascript
      ? "JavaScript was found in the document name tree; it can execute on open."
      : hasOpenAction
        ? "An open action is present. Paperly removes it in the prepared copy."
        : "No JavaScript or open actions were found.",
  });

  let embeddedFiles = 0;
  try {
    const names = catalog.lookup(PDFName.of("Names"));
    if (names instanceof PDFDict) {
      const tree = names.lookup(PDFName.of("EmbeddedFiles"));
      if (tree instanceof PDFDict) {
        const array = tree.lookup(PDFName.of("Names"));
        if (array instanceof PDFArray) embeddedFiles = Math.floor(array.size() / 2);
        else embeddedFiles = 1;
      }
    }
  } catch {
    embeddedFiles = 0;
  }
  checks.push({
    id: "attachments",
    label: "No unexpected attachments",
    status: embeddedFiles ? "warn" : "pass",
    detail: embeddedFiles
      ? `${embeddedFiles} embedded file${embeddedFiles === 1 ? "" : "s"} found. Attachments may contain additional or sensitive data.`
      : "No embedded files were found.",
  });

  let fields = 0;
  let xfa = false;
  try {
    const form = doc.getForm();
    fields = form.getFields().length;
    xfa = form.acroForm.dict.has(PDFName.of("XFA"));
  } catch {
    /* no AcroForm at all: there is nothing to flatten */
  }
  checks.push({
    id: "forms",
    label: "Interactive forms flattened",
    status: fields || xfa ? "warn" : "pass",
    detail:
      fields || xfa
        ? `${fields} interactive field${fields === 1 ? "" : "s"}${xfa ? " and XFA data" : ""} present. Flatten to freeze the values.`
        : "No interactive form fields were found.",
  });

  let totalFonts = 0;
  let unembedded = 0;
  for (const page of doc.getPages()) {
    try {
      const resources = page.node.Resources();
      const fonts = resources?.lookup(PDFName.of("Font"));
      if (!(fonts instanceof PDFDict)) continue;
      for (const [, ref] of fonts.entries()) {
        const font = context.lookup(ref as PDFRef);
        if (!(font instanceof PDFDict)) continue;
        totalFonts += 1;
        let descriptor: PDFDict | undefined;
        const direct = font.lookup(PDFName.of("FontDescriptor"));
        if (direct instanceof PDFDict) descriptor = direct;
        const descendants = font.lookup(PDFName.of("DescendantFonts"));
        if (!descriptor && descendants instanceof PDFArray) {
          const child = context.lookup(descendants.get(0) as PDFRef);
          if (child instanceof PDFDict) {
            const childDescriptor = child.lookup(PDFName.of("FontDescriptor"));
            if (childDescriptor instanceof PDFDict) descriptor = childDescriptor;
          }
        }
        const embedded =
          descriptor &&
          (descriptor.has(PDFName.of("FontFile")) || descriptor.has(PDFName.of("FontFile2")) || descriptor.has(PDFName.of("FontFile3")));
        if (!embedded) unembedded += 1;
      }
    } catch {
      continue;
    }
  }
  checks.push({
    id: "fonts",
    label: "Fonts embedded",
    status: totalFonts === 0 ? "warn" : unembedded > 0 ? "warn" : "pass",
    detail:
      totalFonts === 0
        ? "No font resources were detected. If the PDF has text, embedding cannot be confirmed."
        : unembedded > 0
          ? `${unembedded} of ${totalFonts} font resource${totalFonts === 1 ? "" : "s"} are not embedded. Appearance may change on other systems.`
          : `All ${totalFonts} font resource${totalFonts === 1 ? "" : "s"} are embedded.`,
  });

  const hasOutputIntent = catalog.has(PDFName.of("OutputIntents"));
  const hasMetadata = catalog.has(PDFName.of("Metadata"));
  checks.push({
    id: "colour",
    label: "Colour output intent",
    status: hasOutputIntent ? "pass" : "warn",
    detail: hasOutputIntent
      ? "An output intent is declared for colour reproduction."
      : "No ICC output intent is declared. Certified archival formats expect one.",
  });
  checks.push({
    id: "metadata",
    label: "XMP metadata",
    status: hasMetadata ? "pass" : "warn",
    detail: hasMetadata ? "An XMP metadata stream is present." : "No XMP packet is present. Descriptive metadata is written when you prepare the copy.",
  });
  const hasPdfaClaim = raw.includes("pdfaid");
  checks.push({
    id: "pdfa",
    label: "PDF/A claim",
    status: "warn",
    detail: hasPdfaClaim
      ? "The file declares PDF/A metadata, but claims must be validated externally (for example with veraPDF)."
      : "No PDF/A declaration. Paperly does not certify conformance; validate the output with veraPDF if you need it.",
  });
  const version = raw.match(/%PDF-(\d\.\d)/)?.[1] ?? "unknown";
  checks.push({
    id: "version",
    label: "PDF version",
    status: "pass",
    detail: `PDF ${version}. The prepared copy is saved with current metadata.`,
  });

  return checks;
}

interface AuditComparison {
  before: AuditCheck[];
  after: AuditCheck[];
}

export function ArchiveTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const opts = useToolPreferences("archive", ARCHIVE_DEFAULTS);
  const [meta, setMeta] = useState({ title: "", author: "", subject: "", keywords: "" });
  const [loadedMeta, setLoadedMeta] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const [audit, setAudit] = useState<AuditCheck[] | null>(null);
  const [comparison, setComparison] = useState<AuditComparison | null>(null);
  const [recipeError, setRecipeError] = useState("");
  const auditedBytes = useRef<ArrayBuffer | Uint8Array | null>(null);
  const job = useJob<ArchiveResult>();

  const profile = ARCHIVE_PROFILES.find((entry) => entry.id === opts.value.profile) ?? ARCHIVE_PROFILES[1];
  const willEmbed = opts.value.embedOriginal && profile.allowsAttachments;

  const inspect = async () => {
    if (!pdf.bytes) return;
    setAuditing(true);
    setRecipeError("");
    try {
      const checks = await auditPdf(pdf.bytes);
      setAudit(checks);
      auditedBytes.current = pdf.bytes;
    } catch (err) {
      setRecipeError((err as Error).message);
    } finally {
      setAuditing(false);
    }
  };

  const reportLines = (checks: AuditCheck[]) => [
    "Paperly archive readiness report",
    `File: ${pdf.file?.name ?? "document"}`,
    `Pages: ${pdf.pageCount}`,
    `Profile: ${profile.label} (preparation only, not a PDF/A certification)`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "This is a readiness check, not a PDF/A certification.",
    "",
    ...checks.map((check) => `[${check.status.toUpperCase()}] ${check.label}\n    ${check.detail}`),
    "",
    "Next steps: prepare the archive copy, then validate it with an external PDF/A validator such as veraPDF.",
  ];

  const downloadReport = (format: "md" | "json") => {
    const checks = audit ?? comparison?.before;
    if (!checks || !pdf.file) return;
    const stem = sanitizeName(baseName(pdf.file.name));
    if (format === "json") {
      const payload = {
        generator: "Paperly",
        kind: "archive-readiness-report",
        file: pdf.file.name,
        pages: pdf.pageCount,
        profile: profile.id,
        profileLabel: profile.label,
        disclaimer: "This report lists what Paperly can detect locally. It is not a PDF/A certification.",
        generatedAt: new Date().toISOString(),
        checks: checks.map((check) => ({ id: check.id, label: check.label, status: check.status, detail: check.detail })),
        after: comparison?.after.map((check) => ({ id: check.id, label: check.label, status: check.status, detail: check.detail })),
      };
      downloadBytes(new Uint8Array(new TextEncoder().encode(`${JSON.stringify(payload, null, 2)}\n`)), `${stem}-archive-readiness.json`, "application/json");
      return;
    }
    downloadBytes(new Uint8Array(new TextEncoder().encode(reportLines(checks).join("\n"))), `${stem}-archive-readiness.md`, "text/markdown");
  };

  useEffect(() => {
    setLoadedMeta(false);
    setAudit(null);
    setComparison(null);
    setRecipeError("");
    auditedBytes.current = null;
  }, [pdf.bytes]);

  useEffect(() => {
    if (!pdf.bytes || loadedMeta) return;
    let alive = true;
    setLoadedMeta(true);
    (async () => {
      try {
        const doc = await openPdfLib(pdf.bytes as ArrayBuffer);
        if (!alive) return;
        setMeta({
          title: doc.getTitle() ?? (pdf.file ? baseName(pdf.file.name) : ""),
          author: doc.getAuthor() ?? "",
          subject: doc.getSubject() ?? "",
          keywords: doc.getKeywords() ?? "",
        });
      } catch {
        /* metadata is optional */
      }
    })();
    return () => {
      alive = false;
    };
  }, [pdf.bytes, loadedMeta, pdf.file]);

  const prepare = () =>
    job.run(async ({ report, throwIfCancelled }) => {
      if (!pdf.bytes || !pdf.file) throw new Error("Add a PDF first.");
      const settings = opts.value;
      const activeProfile = ARCHIVE_PROFILES.find((entry) => entry.id === settings.profile) ?? ARCHIVE_PROFILES[1];
      const attachOriginal = settings.embedOriginal && activeProfile.allowsAttachments;

      report(6, "Checking the source file…");
      let before: AuditCheck[];
      try {
        before = auditedBytes.current === pdf.bytes && audit ? audit : await auditPdf(pdf.bytes);
      } catch {
        before = [];
      }
      throwIfCancelled();

      report(24, "Rebuilding the document…");
      const doc: PDFDocumentType = await openPdfLib(pdf.bytes);
      let stripped = 0;
      let fields = 0;
      try {
        fields = doc.getForm().getFields().length;
      } catch {
        /* unreadable AcroForm: report zero flattened fields */
      }
      throwIfCancelled();
      if (settings.flattenForms && fields) {
        try {
          doc.getForm().flatten();
        } catch {
          /* some appearances cannot be flattened; keep the original fields */
        }
      }
      report(46, "Removing actions and scripts…");
      throwIfCancelled();
      if (settings.stripActions) {
        // Remove interactive/outbound actions that don't belong in an archival copy.
        const catalog = doc.catalog;
        for (const key of ["OpenAction", "AA", "Names", "JavaScript", "Perms"]) {
          try {
            const name = (await import("@cantoo/pdf-lib")).PDFName.of(key);
            if (catalog.has(name)) {
              catalog.delete(name);
              stripped++;
            }
          } catch {
            /* ignore unusual catalog structures */
          }
        }
        try {
          doc.getForm().acroForm.dict.delete((await import("@cantoo/pdf-lib")).PDFName.of("XFA"));
        } catch {
          /* no XFA */
        }
      }
      if (meta.title.trim()) doc.setTitle(meta.title.trim());
      if (meta.author.trim()) doc.setAuthor(meta.author.trim());
      if (meta.subject.trim()) doc.setSubject(meta.subject.trim());
      if (meta.keywords.trim())
        doc.setKeywords(
          meta.keywords
            .split(/[,;]+/)
            .map((keyword) => keyword.trim())
            .filter(Boolean),
        );
      doc.setProducer("Paperly · local archive preparation");
      doc.setCreator("Paperly");
      if (settings.normalize) {
        doc.setCreationDate(new Date());
        doc.setModificationDate(new Date());
      }
      throwIfCancelled();
      let embedded = false;
      if (attachOriginal) {
        report(64, "Embedding the original file…");
        try {
          await doc.attach(new Uint8Array(pdf.bytes), pdf.file.name, {
            mimeType: "application/pdf",
            description: `Original file embedded by Paperly for archival reference (${activeProfile.label} preparation)`,
            creationDate: new Date(),
            modificationDate: new Date(),
          });
          embedded = true;
        } catch {
          /* attachments are optional */
        }
      }
      report(80, "Saving the archive copy…");
      const bytes = await doc.save({ useObjectStreams: activeProfile.id !== "pdfa-1b" });
      throwIfCancelled();
      report(90, "Re-checking the prepared copy…");
      let after: AuditCheck[];
      try {
        after = await auditPdf(bytes);
      } catch {
        after = [];
      }
      return {
        bytes,
        embedded,
        name: `${sanitizeName(baseName(pdf.file.name))}-archive.pdf`,
        pages: doc.getPageCount(),
        fields,
        stripped,
        profile: activeProfile.id,
        before,
        after,
      };
    });

  const result = job.result;
  useEffect(() => {
    if (!job.succeeded || !job.result) return;
    setComparison({ before: job.result.before, after: job.result.after });
  }, [job.succeeded, job.result]);

  usePrimaryShortcut(() => void prepare(), Boolean(pdf.bytes) && !job.busy);
  useDownloadShortcut(
    () => {
      if (result) downloadOutput(result.bytes, result.name, "application/pdf");
    },
    Boolean(result),
  );

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to prepare for archiving" />
      {pdf.bytes && (
        <>
          <div className="rounded-xl border border-forest/15 bg-lime/20 p-3.5">
            <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-forest">
              <Archive className="h-4 w-4" /> Archival preparation, honestly described
            </p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-forest/90">
              This produces a clean, unencrypted, long-lived copy: form values are flattened, scripts and open actions removed, and descriptive
              metadata written. That is most of what archival workflows need. It does <strong>not</strong> claim certified PDF/A conformance — full
              conformance requires output intents and validation (for example with veraPDF), which a browser cannot guarantee for arbitrary PDFs.
            </p>
          </div>

          <div>
            <PresetChips
              label="Archive profile"
              value={profile.id}
              presets={ARCHIVE_PROFILES.map((entry) => ({ id: entry.id, label: entry.label, description: entry.description }))}
              onSelect={(preset) => {
                const next = preset.id as ArchiveProfile;
                const allows = ARCHIVE_PROFILES.find((entry) => entry.id === next)?.allowsAttachments ?? true;
                opts.patch({ profile: next, embedOriginal: allows ? opts.value.embedOriginal : false });
              }}
            />
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
              The profile sets what Paperly prepares: {profile.allowsAttachments ? "embedded source files are allowed" : "embedded files are omitted"},
              {" "}and {profile.id === "pdfa-1b" ? "object streams are not used" : "object streams are used"}. Conformance itself is validated
              outside Paperly.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Document title">
              <input value={meta.title} onChange={(e) => setMeta({ ...meta, title: e.target.value })} className={inputClass} placeholder="Report title" />
            </Field>
            <Field label="Author">
              <input
                value={meta.author}
                onChange={(e) => setMeta({ ...meta, author: e.target.value })}
                className={inputClass}
                placeholder="Author or organisation"
              />
            </Field>
            <Field label="Subject">
              <input
                value={meta.subject}
                onChange={(e) => setMeta({ ...meta, subject: e.target.value })}
                className={inputClass}
                placeholder="Short description"
              />
            </Field>
            <Field label="Keywords" hint="Comma separated">
              <input
                value={meta.keywords}
                onChange={(e) => setMeta({ ...meta, keywords: e.target.value })}
                className={inputClass}
                placeholder="records, 2026, finance"
              />
            </Field>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <Switch
              checked={opts.value.flattenForms}
              onChange={(value) => opts.set("flattenForms", value)}
              label="Flatten form fields"
              description="Locks in current values"
            />
            <Switch
              checked={opts.value.stripActions}
              onChange={(value) => opts.set("stripActions", value)}
              label="Strip actions & scripts"
              description="Removes JS, XFA and open actions"
            />
            <Switch
              checked={opts.value.normalize}
              onChange={(value) => opts.set("normalize", value)}
              label="Normalise metadata"
              description="Sets current created / modified dates"
            />
          </div>
          <Switch
            checked={opts.value.embedOriginal}
            onChange={(value) => opts.set("embedOriginal", value)}
            label="Embed the original file"
            description={
              profile.allowsAttachments
                ? "Attaches the untouched source inside the archive copy, so the original can be recovered"
                : "Not available for PDF/A-1b: that profile does not permit embedded files"
            }
          />

          <div className="rounded-xl border border-line bg-paper p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="flex items-center gap-1.5 text-[12px] font-semibold text-forest">
                  <ShieldCheck className="h-3.5 w-3.5" /> Archive readiness check
                </p>
                <p className="mt-0.5 text-[11px] text-muted">Inspect encryption, scripts, fonts, colour intents and metadata before you archive.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={inspect} loading={auditing}>
                  {auditing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                  {audit ? "Run again" : "Run check"}
                </Button>
                {audit && (
                  <>
                    <Button variant="outline" size="sm" onClick={() => downloadReport("md")}>
                      <Download className="h-3.5 w-3.5" /> .md
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => downloadReport("json")}>
                      <Download className="h-3.5 w-3.5" /> .json
                    </Button>
                  </>
                )}
              </div>
            </div>
            {audit && (
              <div className="mt-3 space-y-1.5">
                {audit.map((check) => (
                  <div key={check.id} className="flex items-start gap-2 rounded-lg border border-line bg-bone/40 px-2.5 py-2">
                    <span
                      className={cn(
                        "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
                        check.status === "pass" ? "bg-lime text-forest" : check.status === "warn" ? "bg-amber-100 text-amber-800" : "bg-clay/15 text-clay-ink",
                      )}
                    >
                      {check.status === "pass" ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : check.status === "warn" ? <AlertTriangle className="h-2.5 w-2.5" /> : <X className="h-2.5 w-2.5" />}
                    </span>
                    <div className="min-w-0">
                      <p className="text-[11.5px] font-semibold">{check.label}</p>
                      <p className="text-[10.5px] leading-relaxed text-muted">{check.detail}</p>
                    </div>
                  </div>
                ))}
                <p className="flex items-start gap-1.5 pt-1 text-[10.5px] leading-relaxed text-ink/75">
                  <Info className="mt-0.5 h-3 w-3 shrink-0" />
                  Paperly reports what it can detect in the file. It does not claim PDF/A certification — validate the prepared copy with an external tool
                  such as veraPDF. The report exports as Markdown or JSON.
                </p>
              </div>
            )}
            {recipeError && <p role="alert" className="mt-2 text-[11px] font-medium text-clay-ink">{recipeError}</p>}
          </div>

          <div className="rounded-xl border border-line bg-bone-deep/35 p-3.5 text-[11.5px] leading-relaxed text-ink/70">
            <p className="font-semibold text-ink/70">What changes</p>
            <ul className="mt-1.5 space-y-1">
              <li>• Encryption is not applied, so the file opens without a password.</li>
              <li>• Existing values in form fields become permanent page content.</li>
              <li>• Scripts, XFA data and open actions that could alter behaviour are removed.</li>
              <li>• Title, author, subject and keywords are written to the document information dictionary.</li>
              <li>• Page content, images and resolution are left untouched.</li>
              <li>• {willEmbed ? "The untouched original is embedded as a recoverable attachment." : "The original is not embedded with this configuration."}</li>
            </ul>
          </div>

          {job.failed && <Alert tone="error">{job.error}</Alert>}
          {job.status === "cancelled" && <Alert tone="info">Cancelled — nothing was downloaded.</Alert>}
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={() => void prepare()} loading={job.busy}>
              <Archive className="h-4 w-4" /> Prepare archive PDF
            </Button>
            {job.busy && (
              <Button variant="ghost" onClick={job.cancel}>
                Cancel
              </Button>
            )}
            <a href="https://verapdf.org/" target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-[11.5px] font-medium text-forest hover:underline">
              Validate with veraPDF <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          {job.busy && (
            <Progress value={job.percent ?? undefined} label={job.label || "Preparing the archive copy…"} etaMs={job.etaMs} detail={describeJobTime(job)} />
          )}
        </>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Archive copy prepared"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          originalSize={pdf.file?.size}
          onDownload={() => downloadBytes(result.bytes, result.name)}
          facts={[
            { label: "Profile", value: ARCHIVE_PROFILES.find((entry) => entry.id === result.profile)?.label ?? "preparation" },
            { label: "Encryption", value: "none" },
          ]}
          description={`${result.pages} pages · metadata written${result.fields ? ` · ${result.fields} form field${result.fields === 1 ? "" : "s"} flattened` : ""}${result.stripped ? ` · ${result.stripped} action set${result.stripped === 1 ? "" : "s"} removed` : ""}${result.embedded ? " · original embedded" : " · original not embedded"} · unencrypted`}
        />
      )}
      {comparison && comparison.before.length > 0 && comparison.after.length > 0 && (
        <div className="rounded-xl border border-line bg-paper p-3.5">
          <p className="flex items-center gap-1.5 text-[12px] font-semibold text-forest">
            <ShieldCheck className="h-3.5 w-3.5" /> Before and after
          </p>
          <p className="mt-0.5 text-[11px] text-muted">
            The same checks, run on the source and on the copy you just prepared. A readiness summary, not a certification.
          </p>
          <div className="mt-2.5 space-y-1">
            {comparison.after.map((afterCheck) => {
              const beforeCheck = comparison.before.find((entry) => entry.id === afterCheck.id);
              const improved = beforeCheck && beforeCheck.status !== afterCheck.status;
              return (
                <div key={afterCheck.id} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg border border-line bg-bone/40 px-2.5 py-1.5">
                  <span className="truncate text-[11.5px] font-medium">{afterCheck.label}</span>
                  <StatusPill status={beforeCheck?.status ?? "warn"} />
                  <span className="flex items-center gap-1">
                    <span aria-hidden="true" className="text-[10px] text-muted">
                      →
                    </span>
                    <StatusPill status={afterCheck.status} emphasis={Boolean(improved)} />
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-[10.5px] leading-relaxed text-muted">
            {comparison.before.filter((check) => check.status !== "pass").length} item
            {comparison.before.filter((check) => check.status !== "pass").length === 1 ? "" : "s"} needed attention before preparation ·{" "}
            {comparison.after.filter((check) => check.status === "pass").length} of {comparison.after.length} checks pass afterwards. Fonts, colour
            intents and PDF/A claims can only be confirmed by an external validator.
          </p>
        </div>
      )}
      {!pdf.bytes && (
        <div className="flex items-start gap-2 rounded-xl border border-dashed border-line bg-bone-deep/25 px-3.5 py-3 text-[11.5px] leading-relaxed text-muted">
          <Download className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Keep the original source alongside the archive copy. Certification, if you need it, is a
          separate validation step.
        </div>
      )}
    </div>
  );
}

function StatusPill({ status, emphasis = false }: { status: AuditCheck["status"]; emphasis?: boolean }) {
  const tone =
    status === "pass"
      ? "border-forest/20 bg-lime/35 text-forest"
      : status === "warn"
        ? "border-amber-500/25 bg-amber-50 text-amber-900"
        : "border-clay/25 bg-clay/10 text-clay-ink";
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.05em]", tone, emphasis && "ring-1 ring-forest/20")}>
      {status === "pass" ? "pass" : status === "warn" ? "warn" : "fail"}
    </span>
  );
}
