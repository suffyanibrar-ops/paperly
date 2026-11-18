import { ArrowRight, Info, ShieldCheck } from "lucide-react";
import { Suspense, lazy, type ComponentType, type LazyExoticComponent } from "react";
import { getTool, type Tool } from "@/lib/toolRegistry";
import { Spinner, ToolShell, ToolTile } from "@/components/ui";
import { NotFoundPage } from "@/pages/Info";

/**
 * Tools are code-split. The catalogue (home, /tools, search) only needs the
 * registry metadata, so the initial bundle stays small and the heavy PDF,
 * Office, OCR and spreadsheet engines load the first time a tool is opened.
 */
function lazyTool<T extends Record<string, unknown>>(loader: () => Promise<T>, exportName: keyof T & string) {
  return lazy(async () => {
    const module = await loader();
    const component = module[exportName];
    if (typeof component !== "function") {
      throw new Error(`Paperly could not load the ${String(exportName)} interface. Please reload the page.`);
    }
    return { default: component as ComponentType };
  });
}

const TOOL_COMPONENTS: Record<string, LazyExoticComponent<ComponentType>> = {
  merge: lazyTool(() => import("@/tools/Organize"), "MergeTool"),
  split: lazyTool(() => import("@/tools/Organize"), "SplitTool"),
  organize: lazyTool(() => import("@/tools/Organize"), "OrganizeTool"),
  rotate: lazyTool(() => import("@/tools/Organize"), "RotateTool"),
  crop: lazyTool(() => import("@/tools/Organize"), "CropTool"),
  compress: lazyTool(() => import("@/tools/Optimize"), "CompressTool"),
  repair: lazyTool(() => import("@/tools/Optimize"), "RepairTool"),
  "page-numbers": lazyTool(() => import("@/tools/Optimize"), "PageNumbersTool"),
  "jpg-to-pdf": lazyTool(() => import("@/tools/ConvertImages"), "JpgToPdfTool"),
  "pdf-to-jpg": lazyTool(() => import("@/tools/ConvertImages"), "PdfToJpgTool"),
  "pdf-to-word": lazyTool(() => import("@/tools/ConvertDocs"), "PdfToWordTool"),
  "pdf-to-excel": lazyTool(() => import("@/tools/ConvertDocs"), "PdfToExcelTool"),
  "pdf-to-ppt": lazyTool(() => import("@/tools/ConvertDocs"), "PdfToPptTool"),
  "word-to-pdf": lazyTool(() => import("@/tools/ConvertDocs"), "WordToPdfTool"),
  "excel-to-pdf": lazyTool(() => import("@/tools/ConvertDocs"), "ExcelToPdfTool"),
  "ppt-to-pdf": lazyTool(() => import("@/tools/ConvertDocs"), "PptToPdfTool"),
  "extract-text": lazyTool(() => import("@/tools/ConvertDocs"), "ExtractTextTool"),
  edit: lazyTool(() => import("@/tools/Edit"), "EditPdfTool"),
  sign: lazyTool(() => import("@/tools/Edit"), "SignPdfTool"),
  watermark: lazyTool(() => import("@/tools/Edit"), "WatermarkTool"),
  protect: lazyTool(() => import("@/tools/Security"), "ProtectTool"),
  unlock: lazyTool(() => import("@/tools/Security"), "UnlockTool"),
  redact: lazyTool(() => import("@/tools/RedactCompare"), "RedactTool"),
  compare: lazyTool(() => import("@/tools/RedactCompare"), "CompareTool"),
  ocr: lazyTool(() => import("@/tools/OcrTool"), "OcrTool"),
  "markdown-to-pdf": lazyTool(() => import("@/tools/MarkdownTools"), "MarkdownToPdfTool"),
  "pdf-to-markdown": lazyTool(() => import("@/tools/MarkdownTools"), "PdfToMarkdownTool"),
  resize: lazyTool(() => import("@/tools/Advanced"), "ResizeTool"),
  "n-up": lazyTool(() => import("@/tools/Advanced"), "NUpTool"),
  "headers-footers": lazyTool(() => import("@/tools/Advanced"), "HeadersFootersTool"),
  bates: lazyTool(() => import("@/tools/Advanced"), "BatesTool"),
  "fill-forms": lazyTool(() => import("@/tools/FormsScan"), "FillFormsTool"),
  flatten: lazyTool(() => import("@/tools/Advanced"), "FlattenTool"),
  scan: lazyTool(() => import("@/tools/FormsScan"), "ScanTool"),
  "html-to-pdf": lazyTool(() => import("@/tools/HtmlArchive"), "HtmlToPdfTool"),
  archive: lazyTool(() => import("@/tools/HtmlArchive"), "ArchiveTool"),
  batch: lazyTool(() => import("@/tools/Pro"), "BatchTool"),
  "create-form": lazyTool(() => import("@/tools/Pro"), "CreateFormTool"),
  "remove-pages": lazyTool(() => import("@/tools/ProExtras"), "RemovePagesTool"),
  "extract-pages": lazyTool(() => import("@/tools/ProExtras"), "ExtractPagesTool"),
  "extract-images": lazyTool(() => import("@/tools/ProExtras"), "ExtractImagesTool"),
  summarize: lazyTool(() => import("@/tools/ProExtras"), "SummarizeTool"),
  "ask-pdf": lazyTool(() => import("@/tools/Knowledge"), "AskPdfTool"),
  "inspect-pdf": lazyTool(() => import("@/tools/Knowledge"), "InspectPdfTool"),
  "find-redact": lazyTool(() => import("@/tools/Privacy"), "FindRedactTool"),
  sanitize: lazyTool(() => import("@/tools/Privacy"), "SanitizeTool"),
  metadata: lazyTool(() => import("@/tools/MetadataEdit"), "MetadataTool"),
  bookmarks: lazyTool(() => import("@/tools/Structure"), "BookmarksTool"),
  "split-bookmarks": lazyTool(() => import("@/tools/Structure"), "SplitByBookmarksTool"),
  "tables-to-csv": lazyTool(() => import("@/tools/DataExtract"), "TablesToCsvTool"),
  workflow: lazyTool(() => import("@/tools/Workflow"), "WorkflowTool"),
};

export const REGISTERED_TOOL_IDS = Object.keys(TOOL_COMPONENTS);

const WIDE_TOOLS = new Set([
  "organize",
  "edit",
  "sign",
  "redact",
  "compare",
  "scan",
  "markdown-to-pdf",
  "pdf-to-markdown",
  "fill-forms",
  "html-to-pdf",
  "create-form",
  "extract-images",
  "ask-pdf",
  "inspect-pdf",
  "find-redact",
  "bookmarks",
  "tables-to-csv",
  "workflow",
]);

function ToolLoading() {
  return (
    <div className="flex min-h-[420px] flex-col items-center justify-center gap-3 rounded-2xl border border-line bg-paper/60">
      <Spinner className="h-6 w-6 text-forest" />
      <p className="text-[12px] font-medium text-ink/70">Loading the tool in your browser…</p>
      <p className="text-[11px] text-muted">Nothing is uploaded — the interface is fetched once and cached.</p>
    </div>
  );
}

function WideAside({ tool }: { tool: Tool }) {
  return (
    <div className="mt-6 grid gap-4 md:grid-cols-3">
      <div className="surface p-4">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink/75">How it works</p>
        <ol className="mt-2.5 space-y-2.5">
          {tool.steps.map((step, i) => (
            <li key={i} className="flex gap-2.5">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-forest text-[10px] font-bold text-lime">{i + 1}</span>
              <p className="text-[12px] leading-relaxed text-ink/75">{step}</p>
            </li>
          ))}
        </ol>
      </div>
      <div className="rounded-2xl bg-forest p-4 text-paper">
        <ShieldCheck className="h-4 w-4 text-lime" />
        <p className="mt-2 text-[13px] font-semibold">Your file stays in this tab</p>
        <p className="mt-1 text-[11.5px] leading-relaxed text-paper/70">
          Rendering, editing and saving happen on your device. No upload request, no temporary server copy and no retention.
        </p>
        <a href="#/privacy" className="mt-2 inline-flex items-center gap-1 text-[11.5px] font-semibold text-lime hover:underline">
          Privacy promise <ArrowRight className="h-3 w-3" />
        </a>
      </div>
      <div className="surface p-4">
        {tool.note ? (
          <>
            <p className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink/75">
              <Info className="h-3.5 w-3.5" /> Good to know
            </p>
            <p className="mt-2 text-[11.5px] leading-relaxed text-ink/70">{tool.note}</p>
          </>
        ) : (
          <>
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink/75">Related tools</p>
            <div className="mt-2 space-y-1">
              {tool.related.slice(0, 3).map((id) => {
                const related = getTool(id);
                if (!related) return null;
                return (
                  <a key={id} href={`#/tool/${id}`} className="flex items-center gap-2 rounded-lg px-1 py-1 text-[12px] font-medium hover:bg-bone-deep/50">
                    <ToolTile tool={related} size="sm" />
                    {related.name}
                    <ArrowRight className="ml-auto h-3 w-3 text-ink/70" />
                  </a>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function ToolPage({ toolId }: { toolId: string }) {
  const tool = getTool(toolId);
  if (!tool) return <NotFoundPage />;
  const Component = TOOL_COMPONENTS[tool.id];
  if (!Component) return <NotFoundPage />;
  const wide = WIDE_TOOLS.has(tool.id);
  return (
    <ToolShell tool={tool} wide={wide} aside={<WideAside tool={tool} />}>
      <Suspense key={tool.id} fallback={<ToolLoading />}>
        <Component />
      </Suspense>
    </ToolShell>
  );
}

