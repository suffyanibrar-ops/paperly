import { AlertTriangle, Archive, Check, Code2, Download, ExternalLink, FileCode2, Info, Loader2, ShieldCheck, UploadCloud, X } from "lucide-react";
import { PDFArray, PDFDict, PDFName, PDFRef } from "@cantoo/pdf-lib";
import { useEffect, useMemo, useState } from "react";
import html2canvas from "html2canvas";
import {
  PDFDocument,
  baseName,
  dataUrlToBytes,
  downloadBytes,
  formatBytes,
  openPdfLib,
  sanitizeName,
  type PDFDocument as PDFDocumentType,
} from "@/lib/pdf";
import { useInitialFiles, usePdfFile } from "@/lib/usePdf";
import { Alert, Button, Field, Progress, Segmented, Select, Switch, inputClass } from "@/components/ui";
import { DownloadPanel, SinglePdfInput } from "@/components/toolParts";
import { paperDimensions, type PaperKey } from "@/lib/layout";
import { cn } from "@/utils/cn";
import { friendlyProcessingError, sanitizeHtml as sanitizeUntrustedHtml, validateUpload } from "@/lib/security";

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

async function renderHtmlToCanvas(html: string, widthPx: number, scale: number): Promise<HTMLCanvasElement> {
  const host = document.createElement("div");
  // Isolated, inert render surface: no scripts survive sanitisation, the subtree is
  // aria-hidden, pointer-inert and never mounted inside the application shell.
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("inert", "");
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${widthPx}px;background:#ffffff;padding:0;z-index:-1;pointer-events:none;contain:strict;`;
  const style = document.createElement("style");
  style.textContent = BASE_CSS;
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
    return await html2canvas(doc, {
      scale,
      backgroundColor: "#ffffff",
      logging: false,
      useCORS: false,
      allowTaint: false,
      foreignObjectRendering: false,
      imageTimeout: 2000,
      windowWidth: widthPx,
    });
  } finally {
    host.remove();
  }
}

export function HtmlToPdfTool() {
  const [html, setHtml] = useState(TEMPLATE);
  const [paper, setPaper] = useState<PaperKey>("a4");
  const [orientation, setOrientation] = useState<"portrait" | "landscape">("portrait");
  const [margin, setMargin] = useState(48);
  const [quality, setQuality] = useState<"standard" | "high">("high");
  const [embedSource, setEmbedSource] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; pages: number; removed: number } | null>(null);

  const sanitized = useMemo(() => sanitizeHtml(html), [html]);
  const removedTotal = sanitized.removedElements + sanitized.removedAttributes + sanitized.blockedImages;
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
  const page = paperDimensions(paper, orientation);
  const widthPx = Math.round((page.w / 72) * 96);

  const convert = async () => {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      if (!sanitized.html.trim()) throw new Error("Your HTML is empty. Add some content or choose the default template.");
      const contentWidth = Math.max(240, widthPx - margin * 2);
      setProgress(12);
      const canvas = await renderHtmlToCanvas(sanitized.html, contentWidth, quality === "high" ? 2 : 1.4);
      if (!canvas.width || !canvas.height) throw new Error("Nothing visible was rendered. Check your HTML markup.");
      // Page height in CSS pixels, minus the margins on top and bottom.
      const pageHeightPx = Math.round((page.h / 72) * 96) - margin * 2;
      const pageCanvasHeight = Math.round(pageHeightPx * (quality === "high" ? 2 : 1.4));
      const pageCount = Math.max(1, Math.ceil(canvas.height / pageCanvasHeight));
      if (pageCount > 300) throw new Error("That HTML would produce more than 300 pages. Shorten it or reduce the scale.");

      const out = await PDFDocument.create();
      const marginPt = margin * 0.75;
      for (let index = 0; index < pageCount; index++) {
        const sliceHeight = Math.min(pageCanvasHeight, canvas.height - index * pageCanvasHeight);
        const slice = document.createElement("canvas");
        slice.width = canvas.width;
        slice.height = Math.max(1, sliceHeight);
        const ctx = slice.getContext("2d")!;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, slice.width, slice.height);
        ctx.drawImage(canvas, 0, index * pageCanvasHeight, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);
        const image = await out.embedJpg(dataUrlToBytes(slice.toDataURL("image/jpeg", quality === "high" ? 0.92 : 0.85)));
        const pageOut = out.addPage([page.w, page.h]);
        const availableW = page.w - marginPt * 2;
        const drawW = availableW;
        const drawH = (slice.height / canvas.width) * drawW;
        pageOut.drawImage(image, {
          x: marginPt,
          y: page.h - marginPt - Math.min(drawH, page.h - marginPt * 2),
          width: drawW,
          height: Math.min(drawH, page.h - marginPt * 2),
        });
        setProgress(12 + ((index + 1) / pageCount) * 86);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (embedSource) {
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
      const bytes = await out.save();
      setProgress(100);
      setResult({
        bytes,
        name: `${sanitizeName((html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? "html-document").slice(0, 60))}.pdf`,
        pages: pageCount,
        removed: removedTotal,
      });
    } catch (err) {
      setError(friendlyProcessingError(err, "The HTML couldn’t be rendered."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-ink/75">
          <Code2 className="h-3 w-3" /> HTML
        </span>
        <button type="button" onClick={() => setHtml(TEMPLATE)} className="rounded-full border border-line bg-paper px-3 py-1.5 text-[11.5px] font-medium hover:border-forest/35 hover:text-forest">
          Load sample report
        </button>
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-line bg-paper px-3 py-1.5 text-[11.5px] font-medium hover:border-forest/35 hover:text-forest">
          <UploadCloud className="h-3 w-3" /> Import .html
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
                setHtml(text.slice(0, 2_000_000));
                setError("");
              } catch (err) {
                setError(friendlyProcessingError(err, "That HTML file couldn’t be read."));
              }
            }}
          />
        </label>
        <button type="button" onClick={() => setHtml("")} className="ml-auto text-[11px] font-medium text-ink/75 hover:text-clay-ink">
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
            onChange={(e) => {
              setHtml(e.target.value);
              setResult(null);
            }}
            spellCheck={false}
            className="h-[380px] w-full resize-y rounded-xl border border-line bg-paper px-3.5 py-3 font-mono text-[12px] leading-relaxed focus:border-forest/40 focus:outline-none focus:ring-2 focus:ring-forest/10"
            placeholder="<h1>Hello</h1><p>Your content…</p>"
          />
          {removedTotal > 0 && (
            <p className="mt-1.5 text-[10.5px] leading-relaxed text-amber-800">
              {removedTotal} unsafe item{removedTotal === 1 ? "" : "s"} were removed by the sanitiser (scripts, iframes, forms, event handlers, remote
              images or unsafe CSS). Inline <code>style</code> rules on an allowlist still work.
            </p>
          )}
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

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Page size">
          <Select value={paper} onChange={(e) => setPaper(e.target.value as PaperKey)}>
            <option value="a4">A4</option>
            <option value="letter">US Letter</option>
            <option value="legal">US Legal</option>
            <option value="a5">A5</option>
            <option value="a3">A3</option>
          </Select>
        </Field>
        <Field label="Orientation">
          <Segmented
            value={orientation}
            onChange={setOrientation}
            size="sm"
            options={[
              { value: "portrait", label: "Portrait" },
              { value: "landscape", label: "Landscape" },
            ]}
          />
        </Field>
        <Field label={`Margin · ${Math.round((margin / 96) * 25.4)} mm`}>
          <input type="range" min={0} max={96} value={margin} aria-label="Page margin" onChange={(e) => setMargin(Number(e.target.value))} className="mt-3 w-full accent-[#1c4c3b]" />
        </Field>
        <Field label="Render quality">
          <Select value={quality} onChange={(e) => setQuality(e.target.value as "standard" | "high")}>
            <option value="high">High · sharper, larger file</option>
            <option value="standard">Standard · smaller file</option>
          </Select>
        </Field>
      </div>
      <Switch checked={embedSource} onChange={setEmbedSource} label="Attach the HTML source" description="Embeds source.html inside the PDF so the original markup is recoverable" />

      <div className="rounded-xl border border-line bg-bone-deep/35 p-3 text-[11.5px] leading-relaxed text-ink/70">
        <p className="flex items-center gap-1.5 font-semibold text-forest">
          <ShieldCheck className="h-3.5 w-3.5" /> Visual conversion, rendered locally
        </p>
        <p className="mt-1">
          The HTML is laid out like a web page, then each A4 canvas is printed to a PDF page. Text becomes part of the page image, so it isn’t
          selectable — use Markdown to PDF or Word to PDF when you need editable or searchable text. Scripts never run and nothing is uploaded.
        </p>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Button onClick={convert} loading={busy}>
          <FileCode2 className="h-4 w-4" /> Convert HTML to PDF
        </Button>
        <span className="text-[11.5px] text-muted">
          {Math.round((page.w / 72) * 25.4)} × {Math.round((page.h / 72) * 25.4)} mm · {quality === "high" ? "2×" : "1.4×"} raster
        </span>
      </div>
      {busy && <Progress value={progress} label="Laying out HTML and paginating…" />}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="HTML converted to PDF"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          onDownload={() => downloadBytes(result.bytes, result.name)}
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

interface ArchiveOptions {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  flattenForms: boolean;
  stripActions: boolean;
  normalize: boolean;
  embedOriginal: boolean;
}

export function ArchiveTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [options, setOptions] = useState<ArchiveOptions>({
    title: "",
    author: "",
    subject: "",
    keywords: "",
    flattenForms: true,
    stripActions: true,
    normalize: true,
    embedOriginal: true,
  });
  const [loadedMeta, setLoadedMeta] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; pages: number; fields: number; stripped: number; embedded: boolean } | null>(null);
  const [audit, setAudit] = useState<AuditCheck[] | null>(null);
  const [auditing, setAuditing] = useState(false);

  const inspect = async () => {
    if (!pdf.bytes) return;
    setAuditing(true);
    setError("");
    try {
      const bytes = pdf.bytes;
      const raw = new TextDecoder("latin1").decode(new Uint8Array(bytes));
      const doc = await openPdfLib(bytes);
      const catalog = doc.catalog;
      const context = doc.context;
      const checks: AuditCheck[] = [];

      checks.push({
        id: "encryption",
        label: "No encryption",
        status: raw.includes("/Encrypt") ? "fail" : "pass",
        detail: raw.includes("/Encrypt")
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
        const acro = form.acroForm.dict;
        xfa = acro.has(PDFName.of("XFA"));
      } catch {
        fields = 0;
      }
      checks.push({
        id: "forms",
        label: "Interactive forms flattened",
        status: fields || xfa ? "warn" : "pass",
        detail: fields || xfa
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
        detail: hasOutputIntent ? "An output intent is declared for colour reproduction." : "No ICC output intent is declared. Certified archival formats expect one.",
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
        status: hasPdfaClaim ? "warn" : "warn",
        detail: hasPdfaClaim
          ? "The file declares PDF/A metadata, but claims must be validated externally (for example with veraPDF)."
          : "No PDF/A declaration. Paperly does not certify conformance; validate the output with veraPDF if you need it.",
      });
      const version = raw.match(/%PDF-(\d\.\d)/)?.[1] ?? "unknown";
      checks.push({
        id: "version",
        label: "PDF version",
        status: "pass",
        detail: `PDF ${version}. The prepared copy is saved with an object stream and current metadata.`,
      });

      setAudit(checks);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAuditing(false);
    }
  };

  const downloadReport = () => {
    if (!audit || !pdf.file) return;
    const lines = [
      "Paperly archive readiness report",
      `File: ${pdf.file.name}`,
      `Pages: ${pdf.pageCount}`,
      `Generated: ${new Date().toISOString()}`,
      "",
      "This is a readiness check, not a PDF/A certification.",
      "",
      ...audit.map((check) => `[${check.status.toUpperCase()}] ${check.label}\n    ${check.detail}`),
      "",
      "Next steps: prepare the archive copy, then validate it with an external PDF/A validator such as veraPDF.",
    ];
    downloadBytes(new Uint8Array(new TextEncoder().encode(lines.join("\n"))), `${sanitizeName(baseName(pdf.file.name))}-archive-readiness.txt`, "text/plain");
  };

  useEffect(() => {
    setLoadedMeta(false);
    setResult(null);
  }, [pdf.bytes]);

  useEffect(() => {
    if (!pdf.bytes || loadedMeta) return;
    let alive = true;
    setLoadedMeta(true);
    (async () => {
      try {
        const doc = await openPdfLib(pdf.bytes as ArrayBuffer);
        if (!alive) return;
        setOptions((value) => ({
          ...value,
          title: doc.getTitle() ?? (pdf.file ? baseName(pdf.file.name) : ""),
          author: doc.getAuthor() ?? "",
          subject: doc.getSubject() ?? "",
          keywords: doc.getKeywords() ?? "",
        }));
      } catch {
        /* metadata is optional */
      }
    })();
    return () => {
      alive = false;
    };
  }, [pdf.bytes, loadedMeta, pdf.file]);

  const prepare = async () => {
    if (!pdf.bytes || !pdf.file) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const doc: PDFDocumentType = await openPdfLib(pdf.bytes);
      let stripped = 0;
      let fields = 0;
      try {
        fields = doc.getForm().getFields().length;
      } catch {
        fields = 0;
      }
      if (options.flattenForms && fields) {
        try {
          doc.getForm().flatten();
        } catch {
          /* some appearances cannot be flattened; keep the original fields */
        }
      }
      if (options.stripActions) {
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
      if (options.title.trim()) doc.setTitle(options.title.trim());
      if (options.author.trim()) doc.setAuthor(options.author.trim());
      if (options.subject.trim()) doc.setSubject(options.subject.trim());
      if (options.keywords.trim()) doc.setKeywords(options.keywords.split(/[,;]+/).map((k) => k.trim()).filter(Boolean));
      doc.setProducer("Paperly · local archive preparation");
      doc.setCreator("Paperly");
      if (options.normalize) {
        doc.setCreationDate(new Date());
        doc.setModificationDate(new Date());
      }
      let embedded = false;
      if (options.embedOriginal) {
        try {
          await doc.attach(new Uint8Array(pdf.bytes), pdf.file.name, {
            mimeType: "application/pdf",
            description: "Original file embedded by Paperly for archival reference",
            creationDate: new Date(),
            modificationDate: new Date(),
          });
          embedded = true;
        } catch {
          /* attachments are optional */
        }
      }
      const bytes = await doc.save({ useObjectStreams: true });
      setResult({
        bytes,
        embedded,
        name: `${sanitizeName(baseName(pdf.file.name))}-archive.pdf`,
        pages: doc.getPageCount(),
        fields,
        stripped,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

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
              metadata written. That is most of what archival workflows need. It does <strong>not</strong> claim certified PDF/A conformance — that
              requires output intents, embedded fonts and validation (for example with veraPDF), which a browser cannot guarantee for arbitrary PDFs.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Document title">
              <input value={options.title} onChange={(e) => setOptions({ ...options, title: e.target.value })} className={inputClass} placeholder="Report title" />
            </Field>
            <Field label="Author">
              <input value={options.author} onChange={(e) => setOptions({ ...options, author: e.target.value })} className={inputClass} placeholder="Author or organisation" />
            </Field>
            <Field label="Subject">
              <input value={options.subject} onChange={(e) => setOptions({ ...options, subject: e.target.value })} className={inputClass} placeholder="Short description" />
            </Field>
            <Field label="Keywords" hint="Comma separated">
              <input value={options.keywords} onChange={(e) => setOptions({ ...options, keywords: e.target.value })} className={inputClass} placeholder="records, 2026, finance" />
            </Field>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <Switch checked={options.flattenForms} onChange={(v) => setOptions({ ...options, flattenForms: v })} label="Flatten form fields" description="Locks in current values" />
            <Switch checked={options.stripActions} onChange={(v) => setOptions({ ...options, stripActions: v })} label="Strip actions & scripts" description="Removes JS, XFA and open actions" />
            <Switch checked={options.normalize} onChange={(v) => setOptions({ ...options, normalize: v })} label="Normalise dates" description="Sets current created / modified dates" />
          </div>
          <Switch
            checked={options.embedOriginal}
            onChange={(v) => setOptions({ ...options, embedOriginal: v })}
            label="Embed the original file"
            description="Attaches the untouched source inside the archive copy, so the original can be recovered"
          />

          <div className="rounded-xl border border-line bg-paper p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="flex items-center gap-1.5 text-[12px] font-semibold text-forest">
                  <ShieldCheck className="h-3.5 w-3.5" /> Archive readiness check
                </p>
                <p className="mt-0.5 text-[11px] text-muted">Inspect encryption, scripts, fonts, colour intents and metadata before you archive.</p>
              </div>
              <div className="flex gap-2">
                {audit && (
                  <Button variant="outline" size="sm" onClick={downloadReport}>
                    <Download className="h-3.5 w-3.5" /> Report
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={inspect} loading={auditing}>
                  {auditing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                  {audit ? "Run again" : "Run check"}
                </Button>
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
                  such as veraPDF.
                </p>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-line bg-bone-deep/35 p-3.5 text-[11.5px] leading-relaxed text-ink/70">
            <p className="font-semibold text-ink/70">What changes</p>
            <ul className="mt-1.5 space-y-1">
              <li>• Encryption is not applied, so the file opens without a password.</li>
              <li>• Existing values in form fields become permanent page content.</li>
              <li>• Scripts, XFA data and open actions that could alter behaviour are removed.</li>
              <li>• Title, author, subject and keywords are written to the document information dictionary.</li>
              <li>• Page content, images and resolution are left untouched.</li>
              <li>• The untouched original can be embedded as a recoverable attachment.</li>
            </ul>
          </div>

          {error && <Alert tone="error">{error}</Alert>}
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={prepare} loading={busy}>
              <Archive className="h-4 w-4" /> Prepare archive PDF
            </Button>
            <a href="https://verapdf.org/" target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-[11.5px] font-medium text-forest hover:underline">
              Validate with veraPDF <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Archive copy prepared"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${result.pages} pages · metadata written${result.fields ? ` · ${result.fields} form field${result.fields === 1 ? "" : "s"} flattened` : ""}${result.stripped ? ` · ${result.stripped} action set${result.stripped === 1 ? "" : "s"} removed` : ""}${result.embedded ? " · original embedded" : ""} · unencrypted`}
        />
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
