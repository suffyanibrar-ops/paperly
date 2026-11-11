import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  Clock3,
  FileText,
  Heart,
  Lightbulb,
  Mail,
  MessageSquare,
  ScanText,
  ShieldCheck,
  Sparkles,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, ToolTile } from "@/components/ui";
import { ClosingCTA, PageHero, SectionHead } from "@/pages/Info";
import { CATEGORIES, TOOLS, getTool, type Tool } from "@/lib/toolRegistry";
import { clearActivity, formatWhen, removeActivity, useActivity, useFavorites } from "@/lib/activity";
import { cn } from "@/utils/cn";

/* ================================================================== *
 * GUIDES
 * ================================================================== */
interface Guide {
  slug: string;
  title: string;
  summary: string;
  category: string;
  minutes: number;
  tools: string[];
  sections: { heading: string; body: string[] }[];
  takeaways: string[];
}

export const GUIDE_TEASERS = [
  { slug: "merge-without-uploading", title: "Merge PDFs without uploading them", category: "Organize", minutes: 5 },
  { slug: "compress-without-ruining-text", title: "Compress without turning text to mush", category: "Optimize", minutes: 6 },
  { slug: "ocr-scans-to-searchable-pdf", title: "Make scans searchable with OCR", category: "Convert", minutes: 7 },
];

const GUIDES: Guide[] = [
  {
    slug: "merge-without-uploading",
    title: "How to merge PDFs without uploading them",
    summary: "Combine contracts, scans and reports into one document while every page stays on your own device.",
    category: "Organize",
    minutes: 5,
    tools: ["merge", "organize", "split"],
    sections: [
      {
        heading: "Why the upload step is unnecessary",
        body: [
          "Most online PDF tools are client–server applications: the browser uploads your document, a server merges it, and the result comes back. That architecture exists because older browsers could not handle complex PDF work. Modern browsers can.",
          "Paperly embeds a PDF engine that runs in your tab. When you select files, the browser reads them into memory and the merge happens on your own processor. No file content is transmitted, so there is no temporary server copy to delete.",
        ],
      },
      {
        heading: "Merging files, step by step",
        body: [
          "Open Merge PDF and add two or more PDFs. Check the order — the list is the final page order. Use the arrow buttons to move a file up or down, or add more files later. The page counter updates as each file is read.",
          "Press Merge PDF. The tool copies every page into a fresh document, preserving page geometry, links and form fields. The result is generated as a blob in memory and offered as a direct download.",
        ],
      },
      {
        heading: "What to watch for",
        body: [
          "Password-protected PDFs must be unlocked first; the merge tool cannot read encrypted pages. Use Unlock PDF with the password you own, then merge the decrypted copies.",
          "If two documents use identical AcroForm field names, their fields remain independent because the pages are copied into one document context. Keep the original files until you have verified the merged result.",
        ],
      },
    ],
    takeaways: [
      "Merging is local, so private documents never leave the device.",
      "Use the list order to control the final page sequence.",
      "Unlock protected inputs before merging.",
    ],
  },
  {
    slug: "compress-without-ruining-text",
    title: "Compress a PDF without turning text into mush",
    summary: "What actually makes a PDF large, which compression is safe, and when flattening is the right call.",
    category: "Optimize",
    minutes: 6,
    tools: ["compress", "pdf-to-jpg", "ocr"],
    sections: [
      {
        heading: "Where the megabytes come from",
        body: [
          "A typical PDF is mostly embedded images. A single phone photo can be several megabytes; text and vector drawings are usually tiny. That is why image-heavy scans shrink dramatically while a clean, text-only report barely changes.",
          "Paperly’s compressor finds embedded JPEG photos above a sensible size, re-encodes them at the chosen quality, and keeps the surrounding text and vector content untouched. The PDF structure is then optimized.",
        ],
      },
      {
        heading: "Choosing a level",
        body: [
          "Light is designed to be visually lossless for photos. Balanced offers the best size-to-quality ratio for sharing. Strong is for previews and archives where small files matter more than fine detail.",
          "If the image pass does not save meaningful space, Paperly offers an optional flattening pass that turns each page into a single high-resolution image. That usually shrinks the file further, but text becomes part of the picture and is no longer searchable.",
        ],
      },
      {
        heading: "Verify before sending",
        body: [
          "Open the compressed file and zoom into small print, signatures and barcodes. If legibility matters, re-run at Light rather than Strong. For contracts and records, keep the original alongside the compressed copy.",
          "Scans that need small text preserved benefit from OCR before compression: a searchable text layer survives re-encoding of the page image and makes the document usable.",
        ],
      },
    ],
    takeaways: [
      "Images dominate file size; text usually does not.",
      "Only flatten when searchable text is expendable.",
      "Always inspect small print after compression.",
    ],
  },
  {
    slug: "real-pdf-encryption",
    title: "Password protection that is actually encryption",
    summary: "AES-256, user and owner passwords, permissions, and the honest limits of PDF security.",
    category: "Secure",
    minutes: 6,
    tools: ["protect", "unlock", "redact"],
    sections: [
      {
        heading: "Real encryption versus a fake lock",
        body: [
          "Some online tools add a password prompt while leaving the underlying content readable — sometimes even leaving text in clear sight. Proper protection encrypts the file with a key derived from your password, using AES-256 and PDF security handler revision 6.",
          "Paperly performs this encryption with the browser’s Web Crypto API. After encrypting, it verifies that the output cannot be opened without the password before handing it to you. Your password is never sent or stored.",
        ],
      },
      {
        heading: "User password, owner password, permissions",
        body: [
          "The user password is required to open the file. The owner password controls permissions, such as printing, copying and editing. If you leave it blank, Paperly uses the user password as the owner password.",
          "Permissions in the PDF standard are advisory: a viewer is asked to respect them, but the real protection is the password itself. Do not rely on “no copying” to protect secrets; use redaction instead.",
        ],
      },
      {
        heading: "What can go wrong",
        body: [
          "Lost passwords cannot be recovered. Store them in a password manager before you close the tab. If a file is encrypted with an older or unusual security handler, Paperly will refuse rather than produce a broken, unprotected file.",
          "Encryption protects the document at rest, but not your screen or the recipient once they legitimately open it. For sharing sensitive excerpts, combine protection with redaction.",
        ],
      },
    ],
    takeaways: [
      "Protect uses genuine AES-256 and verifies the output.",
      "There is no password recovery — save it first.",
      "Permissions are not a substitute for redaction.",
    ],
  },
  {
    slug: "ocr-scans-to-searchable-pdf",
    title: "Turn a scanned PDF into searchable text with OCR",
    summary: "How OCR works, how to get accurate results, and when a searchable PDF beats a Word file.",
    category: "Convert",
    minutes: 7,
    tools: ["ocr", "scan", "pdf-to-word"],
    sections: [
      {
        heading: "Why scans have no text",
        body: [
          "A scanner is a camera, not a typist. It records an image of the page. The PDF therefore contains pixels, and search, copy and text extraction find nothing. OCR (optical character recognition) examines the image shapes and reconstructs characters.",
          "Modern OCR is accurate on clean, straight, high-contrast pages. It struggles with handwriting, skewed photos, decorative fonts and unusual layouts. Knowing this up front saves disappointment.",
        ],
      },
      {
        heading: "A reliable workflow",
        body: [
          "Capture or scan at 200–300 DPI, with the page flat and evenly lit. Crop out backgrounds where possible. Select the exact printed language; telling the engine a page is English when it is German lowers confidence.",
          "Run OCR PDF and choose the searchable output. Paperly keeps the original page image and adds an invisible text layer positioned over the words. The page looks identical but can now be searched, selected and copied.",
        ],
      },
      {
        heading: "Searchable PDF or editable text?",
        body: [
          "Choose a searchable PDF when appearance and layout matter — contracts, receipts, records. Choose text-only output when you need to reuse the wording in a document, spreadsheet or AI tool.",
          "If you need fully editable Word output, OCR first and then run PDF to Word on the searchable file. Expect the same layout limits as any text extraction: complex columns and floating elements will be simplified.",
        ],
      },
    ],
    takeaways: [
      "OCR needs clear, high-resolution input.",
      "A searchable PDF looks the same and adds hidden selectable text.",
      "Select the correct language for better accuracy.",
    ],
  },
  {
    slug: "redact-versus-black-box",
    title: "Redact versus black out: what actually removes data",
    summary: "Drawing a black rectangle is not redaction. Here is how to remove content permanently and verify it.",
    category: "Secure",
    minutes: 5,
    tools: ["redact", "flatten", "compare"],
    sections: [
      {
        heading: "The hidden-text problem",
        body: [
          "Placing a black shape over text in a PDF hides it visually but leaves the original characters in the content stream. Anyone who can select text, copy it or run extraction can recover what you thought was hidden.",
          "True redaction removes the underlying content. Depending on the tool, it may also strip metadata, annotations and embedded files that can carry the same information.",
        ],
      },
      {
        heading: "How Paperly redacts",
        body: [
          "On pages you mark, Paperly rebuilds the page as an image, burns the redaction boxes into that image, and writes a fresh page. The original text objects are not copied across, so there is nothing left to extract underneath.",
          "Pages without marks keep their original quality and searchable text. This balance matters: you get permanent removal where needed without degrading the whole document.",
        ],
      },
      {
        heading: "Verify, then verify again",
        body: [
          "After downloading, open the file and try to select the covered area. Use Ctrl/Cmd+F to search for the hidden name or number. Run Extract text on the result and confirm it does not appear.",
          "Keep the unredacted original in a controlled location. If you need to trust a recipient with the rest of the document, protect the redacted file with a password as an extra layer.",
        ],
      },
    ],
    takeaways: [
      "Black rectangles do not remove text.",
      "Paperly burns redactions into rebuilt page images.",
      "Search the output for the removed terms to verify.",
    ],
  },
  {
    slug: "pdf-a-and-archiving",
    title: "Long-term PDF archiving: what to know before you rely on it",
    summary: "Fonts, colour profiles, encryption, metadata and the practical steps for durable documents.",
    category: "Optimize",
    minutes: 6,
    tools: ["flatten", "compress", "protect"],
    sections: [
      {
        heading: "What archival really requires",
        body: [
          "An archival PDF is designed to render consistently for decades. That means every font embedded, colour characterised by an ICC output intent, no reliance on external files, no encryption or JavaScript, and structured metadata.",
          "Certified PDF/A is a strict conformance claim, usually checked by a validator such as veraPDF. Many tools advertise PDF/A without demonstrating conformance; a signed compliance claim is stronger than a marketing label.",
        ],
      },
      {
        heading: "A pragmatic archival routine",
        body: [
          "Remove encryption and scripts, flatten interactive content, and keep the page appearance stable. Store the file together with metadata (title, author, date) and a checksum, then keep two copies in different locations.",
          "Paperly can flatten forms and rasterize pages to lock appearance, and its tools never upload your document. For strict PDF/A compliance, validate the final file with a dedicated validator and keep the source if it fails.",
        ],
      },
      {
        heading: "Format does not replace process",
        body: [
          "A perfect PDF/A file on a failing disk is not an archive. Inventory your documents, record retention dates, test restoration and migrate storage media on a schedule.",
          "Prefer open, well-documented formats and keep original sources where they exist. The best archive is one you can still read in twenty years — not simply a file with a compliance badge.",
        ],
      },
    ],
    takeaways: [
      "Claiming PDF/A is easy; validating it is the real test.",
      "Flatten and remove encryption for durable copies.",
      "Archiving is a process, not a single format conversion.",
    ],
  },
];

export function GuidesPage({ initialGuide }: { initialGuide?: string }) {
  const [selected, setSelected] = useState<string | null>(
    initialGuide && GUIDES.some((guide) => guide.slug === initialGuide) ? initialGuide : null,
  );
  useEffect(() => {
    if (initialGuide && GUIDES.some((item) => item.slug === initialGuide)) setSelected(initialGuide);
  }, [initialGuide]);
  const guide = GUIDES.find((item) => item.slug === selected);

  if (guide) {
    return (
      <div>
        <div className="border-b border-line bg-paper/60">
          <div className="container-page py-5">
            <a href="#/guides" onClick={() => setSelected(null)} className="inline-flex items-center gap-1.5 text-[12px] font-medium text-forest hover:underline">
              <ArrowLeft className="h-3.5 w-3.5" /> All guides
            </a>
          </div>
        </div>
        <article className="container-page grid gap-10 py-12 lg:grid-cols-[minmax(0,1fr)_290px] lg:gap-16">
          <div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium text-muted">
              <Badge tone="forest">{guide.category}</Badge>
              <span className="flex items-center gap-1"><Clock3 className="h-3 w-3" /> {guide.minutes} min read</span>
              <span>· Updated 2026</span>
            </div>
            <h1 className="mt-4 max-w-[24ch] text-[34px] font-semibold leading-[1.03] tracking-[-0.04em] sm:text-[44px]">{guide.title}</h1>
            <p className="mt-3 max-w-[62ch] text-[15px] leading-relaxed text-ink/70">{guide.summary}</p>
            <div className="mt-8 space-y-8">
              {guide.sections.map((section) => (
                <section key={section.heading}>
                  <h2 className="text-[20px] font-semibold tracking-[-0.02em]">{section.heading}</h2>
                  {section.body.map((paragraph) => (
                    <p key={paragraph.slice(0, 40)} className="mt-2.5 text-[13.5px] leading-[1.75] text-ink/70">
                      {paragraph}
                    </p>
                  ))}
                </section>
              ))}
            </div>
            <div className="mt-8 rounded-2xl border border-forest/15 bg-lime/20 p-5">
              <p className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-forest">
                <Lightbulb className="h-3.5 w-3.5" /> Key takeaways
              </p>
              <ul className="mt-2.5 space-y-1.5">
                {guide.takeaways.map((takeaway) => (
                  <li key={takeaway} className="flex items-start gap-2 text-[12.5px] leading-relaxed text-forest/85">
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {takeaway}
                  </li>
                ))}
              </ul>
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-line pt-5">
              <span className="text-[11.5px] text-muted">Put it into practice:</span>
              {guide.tools.map((id) => {
                const tool = getTool(id);
                if (!tool) return null;
                return (
                  <a key={id} href={`#/tool/${id}`} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-paper px-3 text-[12px] font-medium hover:border-forest/35 hover:text-forest">
                    <tool.icon className="h-3.5 w-3.5" /> {tool.name} <ArrowRight className="h-3 w-3" />
                  </a>
                );
              })}
            </div>
            <p className="mt-5 text-[11px] text-muted">
              Written by the Paperly team. Spotted an error?{" "}
              <a href="mailto:guides@paperly.tools" className="font-medium text-forest underline underline-offset-2">Tell us</a>.
            </p>
          </div>
          <aside className="space-y-4">
            <div className="rounded-2xl border border-line bg-paper p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink/75">More guides</p>
              <ul className="mt-2 space-y-1">
                {GUIDES.filter((item) => item.slug !== guide.slug).slice(0, 4).map((item) => (
                  <li key={item.slug}>
                    <a href={`#/guides?g=${item.slug}`} className="flex gap-2 rounded-lg px-1 py-2 text-[12px] font-medium leading-snug text-ink/70 hover:text-forest">
                      <BookOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink/70" /> {item.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-2xl bg-forest p-5 text-paper">
              <ShieldCheck className="h-5 w-5 text-lime" />
              <p className="mt-2 text-[14px] font-semibold">No uploads, ever</p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-paper/70">Every technique here is performed in your browser. Nothing you try is stored on a server.</p>
              <a href="#/tools" className="mt-3 inline-flex items-center gap-1 text-[12px] font-semibold text-lime hover:underline">
                Try the tools <ArrowRight className="h-3.5 w-3.5" />
              </a>
            </div>
          </aside>
        </article>
      </div>
    );
  }

  return (
    <div>
      <PageHero
        eyebrow="Guides & tutorials"
        title={<>Do it once. <span className="font-serif font-normal italic text-forest">Do it right.</span></>}
        description="Practical, honest walkthroughs for the document jobs that matter — written by the people who built the tools. No fluff, no gated PDFs, no email required."
      >
        <div className="mt-6 flex flex-wrap gap-2">
          {["Organize", "Optimize", "Convert", "Secure"].map((category) => (
            <span key={category} className="rounded-full border border-line bg-paper px-3 py-1.5 text-[11.5px] font-medium text-ink/70">
              {category}
            </span>
          ))}
        </div>
      </PageHero>
      <section className="py-14">
        <div className="container-page">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {GUIDES.map((item) => (
              <a key={item.slug} href={`#/guides?g=${item.slug}`} onClick={() => setSelected(item.slug)} className="group flex flex-col rounded-2xl border border-line bg-paper p-5 transition-all hover:-translate-y-0.5 hover:border-forest/25 hover:shadow-soft">
                <div className="flex items-center justify-between">
                  <span className="rounded-full bg-forest/7 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.07em] text-forest">{item.category}</span>
                  <span className="flex items-center gap-1 text-[10.5px] text-muted"><Clock3 className="h-3 w-3" /> {item.minutes} min</span>
                </div>
                <h2 className="mt-4 text-[16px] font-semibold leading-snug tracking-[-0.015em] group-hover:text-forest">{item.title}</h2>
                <p className="mt-2 text-[12px] leading-relaxed text-muted">{item.summary}</p>
                <span className="mt-auto flex items-center gap-1.5 pt-4 text-[11.5px] font-semibold text-forest">
                  Read the guide <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </a>
            ))}
          </div>
          <div className="mt-6 rounded-2xl border border-line bg-bone-deep/35 p-5">
            <p className="flex items-center gap-1.5 text-[12px] font-semibold">
              <Sparkles className="h-3.5 w-3.5 text-forest" /> A different kind of documentation
            </p>
            <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-muted">
              We include limitations on purpose. A guide is only useful if it tells you when a conversion won’t work, how to verify the result, and
              what to do instead. If you spot something we’ve missed, write to guides@paperly.tools.
            </p>
          </div>
        </div>
      </section>
      <ClosingCTA />
    </div>
  );
}

/* ================================================================== *
 * ACTIVITY
 * ================================================================== */
export function ActivityPage() {
  const activity = useActivity();
  const { favorites, toggle } = useFavorites();

  return (
    <div>
      <PageHero
        eyebrow="Your activity"
        title={<>Only file names. <span className="font-serif font-normal italic text-forest">Never file contents.</span></>}
        description="Recent tools and output names are kept in this browser's local storage so you can pick up where you left off. Clear them at any time. Documents themselves are never stored."
      />
      <section className="py-12">
        <div className="container-page">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink/75">{activity.length} recent task{activity.length === 1 ? "" : "s"}</p>
            {activity.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => clearActivity()}>
                <Trash2 className="h-3.5 w-3.5" /> Clear history
              </Button>
            )}
          </div>

          {activity.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line bg-paper px-6 py-12 text-center">
              <FileText className="mx-auto h-7 w-7 text-ink/20" />
              <p className="mt-3 text-[15px] font-medium">No tasks yet</p>
              <p className="mx-auto mt-1 max-w-md text-[12.5px] leading-relaxed text-muted">
                When you download a result, its filename and tool appear here. Contents are never recorded, and clearing history is permanent.
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {["merge", "compress", "ocr"].map((id) => {
                  const tool = getTool(id)!;
                  return (
                    <a key={id} href={`#/tool/${id}`} className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink px-4 text-[12.5px] font-medium text-paper">
                      <tool.icon className="h-3.5 w-3.5 text-lime" /> {tool.name}
                    </a>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-line bg-paper">
              {activity.map((entry, index) => {
                const tool = getTool(entry.toolId);
                return (
                  <div key={entry.id} className={cn("flex flex-wrap items-center gap-3 px-4 py-3 sm:flex-nowrap", index > 0 && "border-t border-line")}>
                    {tool ? <ToolTile tool={tool} size="sm" /> : <div className="h-9 w-9 rounded-lg bg-bone-deep" />}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12.5px] font-medium">{entry.filename}</p>
                      <p className="text-[11px] text-muted">
                        {tool?.name ?? entry.toolName}
                        {entry.pages ? ` · ${entry.pages} page${entry.pages === 1 ? "" : "s"}` : ""}
                        {entry.size ? ` · ${(entry.size / 1024 / 1024) >= 1 ? `${(entry.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(entry.size / 1024))} KB`}` : ""}
                      </p>
                    </div>
                    <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-ink/75"><Clock3 className="h-3 w-3" /> {formatWhen(entry.at)}</span>
                    {tool && (
                      <a href={`#/tool/${tool.id}`} className="shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-[11.5px] font-medium hover:border-forest/30 hover:text-forest">
                        Open tool
                      </a>
                    )}
                    <button type="button" onClick={() => removeActivity(entry.id)} aria-label={`Remove ${entry.filename} from history`} className="shrink-0 rounded p-1.5 text-ink/70 hover:bg-clay/10 hover:text-clay-ink">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-10">
            <div className="mb-3 flex items-center justify-between">
              <SectionHead eyebrow="Shortcuts" title="Tools you’ve pinned." />
              <p className="text-[11px] text-muted">Pin a tool from its page with the star button.</p>
            </div>
            {favorites.length === 0 ? (
              <div className="rounded-xl border border-line bg-paper px-4 py-6 text-[12.5px] text-muted">
                You haven’t pinned anything yet. Open any tool and press the star near its title.
              </div>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {favorites.map((id) => {
                  const tool = getTool(id);
                  if (!tool) return null;
                  return (
                    <div key={id} className="flex items-center gap-2 rounded-xl border border-line bg-paper p-2.5">
                      <ToolTile tool={tool} size="sm" />
                      <a href={`#/tool/${id}`} className="min-w-0 flex-1 truncate text-[12px] font-medium hover:text-forest">{tool.name}</a>
                      <button type="button" onClick={() => toggle(id)} aria-label={`Unpin ${tool.name}`} className="rounded p-1 text-forest">
                        <Star className="h-3.5 w-3.5 fill-forest" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mt-8 flex items-start gap-2.5 rounded-2xl border border-forest/15 bg-lime/20 p-4 text-[12px] leading-relaxed text-forest">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              <strong>What is stored:</strong> tool name, output filename, page count, size and time — in this browser only.{" "}
              <strong>What is not stored:</strong> your documents, their contents or your passwords. Clearing your browser’s site data removes this
              history.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ================================================================== *
 * ABOUT
 * ================================================================== */
export function AboutPage() {
  return (
    <div>
      <PageHero
        eyebrow="About Paperly"
        title={<>A smaller, truer <span className="font-serif font-normal italic text-forest">document toolkit.</span></>}
        description="Paperly is an independent, privacy-first PDF workspace. It began with a simple frustration: needing to merge two confidential files and finding no reputable tool that would simply do it on the device."
      />
      <section className="border-b border-line py-14">
        <div className="container-page grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:gap-16">
          <div className="space-y-6">
            <SectionHead eyebrow="The idea" title="Utility without a privacy tax." />
            <p className="text-[13.5px] leading-[1.75] text-ink/75">
              Most online PDF suites are excellent at one thing: converting convenience into dependency. Files are uploaded, accounts are required,
              limits appear after the first success, and the download button turns into an upgrade prompt. That model works for the vendor, not the
              person holding the document.
            </p>
            <p className="text-[13.5px] leading-[1.75] text-ink/75">
              Browsers grew up. Real PDF engines now run in a tab. Encryption is available through Web Crypto. A document can be read, rewritten and
              returned without a server ever knowing it existed. Paperly is built entirely on that premise: local tools, complete results, no
              account, no metering, no watermark.
            </p>
            <p className="text-[13.5px] leading-[1.75] text-ink/75">
              We would rather tell you what a tool cannot do than hide a limitation behind marketing. Scans need OCR. Complex Word layouts cannot be
              reconstructed perfectly in a browser. Redaction must remove data, not draw over it. Those constraints are in the product copy, not in a
              support article.
            </p>
            <div className="grid grid-cols-3 gap-3 pt-2">
              {[
                { value: String(TOOLS.length), label: "working tools" },
                { value: "0 B", label: "uploaded data" },
                { value: "∞", label: "free tasks" },
              ].map((stat) => (
                <div key={stat.label} className="rounded-xl border border-line bg-paper px-3 py-3">
                  <p className="text-[24px] font-semibold leading-none tracking-[-0.04em] text-forest">{stat.value}</p>
                  <p className="mt-1 text-[10.5px] uppercase tracking-[0.06em] text-ink/75">{stat.label}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-3">
            {[
              { icon: Heart, title: "Independent", body: "No investor pressure to monetise your files or invent artificial scarcity." },
              { icon: ShieldCheck, title: "Privacy is the architecture", body: "There is no upload endpoint. The strongest privacy policy is not needing one." },
              { icon: Lightbulb, title: "Honest by default", body: "Real limitations are stated up front, and results are verified before they are offered." },
              { icon: BookOpen, title: "Open foundations", body: "Built on open-source PDF engines and web standards, so the work is auditable." },
            ].map((value) => (
              <div key={value.title} className="flex gap-3 rounded-xl border border-line bg-paper p-3.5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-lime/40 text-forest">
                  <value.icon className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-[12.5px] font-semibold">{value.title}</p>
                  <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted">{value.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="border-b border-line py-14">
        <div className="container-page">
          <SectionHead eyebrow="Technology" title="The engines behind the calm interface." description="Paperly stands on mature open-source work rather than proprietary black boxes." />
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { name: "PDF.js", role: "Rendering and text extraction", detail: "Mozilla’s PDF engine, used by Firefox." },
              { name: "pdf-lib", role: "Editing, merging, geometry, encryption", detail: "A maintained MIT-licensed fork with AES-256." },
              { name: "Tesseract.js", role: "Optical character recognition", detail: "WASM OCR, running in a local worker." },
              { name: "Web Crypto", role: "Key generation and encryption", detail: "Browser-native, standards-based cryptography." },
            ].map((tech) => (
              <div key={tech.name} className="rounded-xl border border-line bg-paper p-4">
                <p className="text-[13px] font-semibold">{tech.name}</p>
                <p className="mt-0.5 text-[11px] font-medium text-forest">{tech.role}</p>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">{tech.detail}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-line bg-bone-deep/35 p-4 text-[11.5px] leading-relaxed text-muted">
            <Mail className="mt-0.5 h-4 w-4 shrink-0 text-forest" />
            <p>
              Paperly is maintained independently. There is no advertising, no tracking and no paid tier. If you need a deployment inside an
              organisation, the build is self-contained and can be hosted without a processing backend — write to{" "}
              <a href="mailto:hello@paperly.tools" className="font-medium text-forest underline underline-offset-2">hello@paperly.tools</a>.
            </p>
          </div>
        </div>
      </section>
      <ClosingCTA />
    </div>
  );
}

/* ================================================================== *
 * CONTACT
 * ================================================================== */
export function ContactPage() {
  const channels = [
    { icon: MessageSquare, title: "Product support", email: "support@paperly.tools", body: "A tool misbehaved, or a result looks wrong? Include the tool name, your browser and the steps you took. Never attach a sensitive document." },
    { icon: ShieldCheck, title: "Privacy & security", email: "privacy@paperly.tools", body: "Questions about local processing, encryption, or our no-upload architecture. Security reports are read first." },
    { icon: Lightbulb, title: "Feature requests", email: "ideas@paperly.tools", body: "Tell us the document job you need to finish and what gets in the way. Concrete workflows make better tools." },
    { icon: BookOpen, title: "Guides & documentation", email: "guides@paperly.tools", body: "Spotted an inaccuracy in a guide or a misleading tool note? Corrections are genuinely welcome." },
  ];
  return (
    <div>
      <PageHero
        eyebrow="Contact"
        title={<>Talk to a human. <span className="font-serif font-normal italic text-forest">Not a ticket bot.</span></>}
        description="Paperly has no contact form, because a form would mean collecting your message on a server we don’t need. These links open your own mail app. Nothing is tracked."
      />
      <section className="py-14">
        <div className="container-page grid gap-10 lg:grid-cols-[1.15fr_0.85fr] lg:gap-16">
          <div className="grid gap-3 sm:grid-cols-2">
            {channels.map((channel) => (
              <a key={channel.title} href={`mailto:${channel.email}`} className="group rounded-2xl border border-line bg-paper p-5 transition-colors hover:border-forest/30">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-lime/40 text-forest">
                  <channel.icon className="h-4 w-4" />
                </div>
                <p className="mt-3 text-[13.5px] font-semibold">{channel.title}</p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-muted">{channel.body}</p>
                <span className="mt-3 flex items-center gap-1 text-[11.5px] font-semibold text-forest group-hover:underline">
                  {channel.email} <ArrowRight className="h-3 w-3" />
                </span>
              </a>
            ))}
            <div className="rounded-2xl border border-line bg-bone-deep/40 p-5 sm:col-span-2">
              <p className="text-[12.5px] font-semibold">What we can and can’t do</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {[
                  "Explain a tool’s limits before you use it",
                  "Help interpret an error message",
                  "Investigate a reproducible bug",
                  "Point you to the right tool for a job",
                  "We cannot see or recover your documents",
                  "We cannot reset a PDF password for you",
                  "We do not receive files by email",
                  "We cannot provide legal or compliance advice",
                ].map((line, index) => (
                  <p key={line} className={cn("flex items-start gap-1.5 text-[11.5px] leading-relaxed", index < 4 ? "text-ink/75" : "text-ink/75")}>
                    {index < 4 ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-forest" /> : <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-clay-ink/60" />}
                    {line}
                  </p>
                ))}
              </div>
            </div>
          </div>
          <aside className="space-y-3">
            <div className="rounded-2xl bg-forest p-5 text-paper">
              <Mail className="h-5 w-5 text-lime" />
              <p className="mt-2.5 text-[14px] font-semibold">A quick reply</p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-paper/70">
                Most messages are answered within two working days. Support is provided by the people who build the tools, so complex questions can
                take longer — but they don’t disappear.
              </p>
            </div>
            <div className="rounded-2xl border border-line bg-paper p-4">
              <p className="flex items-center gap-1.5 text-[12px] font-semibold">
                <ScanText className="h-3.5 w-3.5 text-forest" /> Before you write
              </p>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">These answers solve most messages:</p>
              <ul className="mt-2 space-y-1.5">
                {[
                  { label: "Password-protected file?", href: "#/tool/unlock" },
                  { label: "Scanned PDF has no text", href: "#/help" },
                  { label: "Why compression didn’t help", href: "#/tool/compress" },
                  { label: "How local processing works", href: "#/privacy" },
                ].map((link) => (
                  <li key={link.href}>
                    <a href={link.href} className="flex items-center justify-between rounded-lg px-1 py-1.5 text-[11.5px] font-medium text-ink/75 hover:text-forest">
                      {link.label} <ArrowRight className="h-3 w-3" />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-2xl border border-clay/20 bg-clay/[0.05] p-4 text-[11.5px] leading-relaxed text-ink/70">
              <p className="flex items-center gap-1.5 font-semibold text-[#a64127]">
                <ShieldCheck className="h-3.5 w-3.5" /> Don’t send the document
              </p>
              <p className="mt-1">We can’t access anything you process, and email is not a private document channel. Describe the problem instead.</p>
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}

/* ================================================================== *
 * SITEMAP
 * ================================================================== */
export function SitemapPage() {
  const pages = [
    { label: "Home", href: "#/" },
    { label: "All tools", href: "#/tools" },
    { label: "Why Paperly", href: "#/why" },
    { label: "Compare with iLovePDF", href: "#/vs-ilovepdf" },
    { label: "Pricing", href: "#/pricing" },
    { label: "Privacy promise", href: "#/privacy" },
    { label: "Guides", href: "#/guides" },
    { label: "Help & FAQ", href: "#/help" },
    { label: "Activity", href: "#/activity" },
    { label: "About", href: "#/about" },
    { label: "Contact", href: "#/contact" },
    { label: "Sitemap", href: "#/sitemap" },
    { label: "Terms", href: "#/terms" },
  ];
  return (
    <div>
      <PageHero eyebrow="Sitemap" title={<>Everything, in one place.</>} description="All tools and every page on Paperly. No hidden menus, no gated content." />
      <section className="py-12">
        <div className="container-page space-y-9">
          <div>
            <h2 className="mb-3 text-[11px] font-bold uppercase tracking-[0.12em] text-ink/75">Pages</h2>
            <div className="grid gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
              {pages.map((page) => (
                <a key={page.href} href={page.href} className="rounded-lg border border-line bg-paper px-3 py-2.5 text-[12px] font-medium hover:border-forest/30 hover:text-forest">
                  {page.label}
                </a>
              ))}
            </div>
          </div>
          {(Object.keys(CATEGORIES) as (keyof typeof CATEGORIES)[]).map((category) => (
            <div key={category}>
              <h2 className="mb-3 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.12em] text-ink/75">
                <span className={cn("h-1.5 w-1.5 rounded-full", CATEGORIES[category].dot)} /> {CATEGORIES[category].name} ·{" "}
                {TOOLS.filter((tool) => tool.category === category).length} tools
              </h2>
              <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {TOOLS.filter((tool) => tool.category === category).map((tool: Tool) => (
                  <a key={tool.id} href={`#/tool/${tool.id}`} className="flex items-center gap-2 rounded-lg border border-line bg-paper px-3 py-2.5 text-[12px] font-medium hover:border-forest/30 hover:text-forest">
                    <tool.icon className="h-3.5 w-3.5 text-ink/75" /> {tool.name}
                    {tool.new && <span className="ml-auto rounded-full bg-lime/45 px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-[0.06em] text-forest">New</span>}
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
