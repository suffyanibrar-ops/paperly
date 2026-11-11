import {
  ArrowRight,
  Check,
  CloudOff,
  ExternalLink,
  Globe,
  Info,
  Layers,
  Lock,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { TOOLS } from "@/lib/toolRegistry";
import { Badge } from "@/components/ui";
import { ClosingCTA, PageHero, SectionHead } from "@/pages/Info";
import { cn } from "@/utils/cn";

type Verdict = "yes" | "no" | "partial" | "premium";

const VERIFIED = "February 2026";

interface Row {
  capability: string;
  paperly: string;
  ilovepdf: string;
  paperlyState: Verdict;
  iloveState: Verdict;
  note?: string;
}

const GROUPS: { title: string; blurb: string; rows: Row[] }[] = [
  {
    title: "Privacy & where files go",
    blurb: "The most important difference is architectural, not a policy promise.",
    rows: [
      {
        capability: "Document processing",
        paperly: "In your browser tab",
        ilovepdf: "On iLovePDF’s servers",
        paperlyState: "yes",
        iloveState: "no",
        note: "iLovePDF’s own security page describes encrypted uploads and processing on its infrastructure; Paperly has no upload step at all.",
      },
      {
        capability: "Files sent to a server",
        paperly: "Never",
        ilovepdf: "Always, to process",
        paperlyState: "yes",
        iloveState: "no",
        note: "Watch the Network panel while using Paperly: no request carries document content.",
      },
      {
        capability: "Works without an account",
        paperly: "Yes — no sign-up exists",
        ilovepdf: "Yes, with limits and ads",
        paperlyState: "yes",
        iloveState: "partial",
      },
      {
        capability: "Works after the page has loaded",
        paperly: "All tools except first-run OCR",
        ilovepdf: "Needs a connection every task",
        paperlyState: "yes",
        iloveState: "partial",
      },
      {
        capability: "Ads or tracking pixels",
        paperly: "None",
        ilovepdf: "Ads on the free tier",
        paperlyState: "yes",
        iloveState: "no",
      },
      {
        capability: "File retention",
        paperly: "Nothing to retain",
        ilovepdf: "Cloud copies, deleted on a schedule",
        paperlyState: "yes",
        iloveState: "partial",
      },
    ],
  },
  {
    title: "Limits and price",
    blurb: "Both are free to start. The difference is what “free” actually allows.",
    rows: [
      {
        capability: "Free file-size cap",
        paperly: "Device memory only",
        ilovepdf: "Per tool: 15 MB–400 MB",
        paperlyState: "yes",
        iloveState: "no",
        note: "iLovePDF’s public pricing page lists 15 MB for OCR and Office conversions, 100 MB for merge, 200 MB for compress — rising to 4 GB with Premium.",
      },
      {
        capability: "Batch processing",
        paperly: "Unlimited files",
        ilovepdf: "Limited on free",
        paperlyState: "yes",
        iloveState: "partial",
      },
      {
        capability: "OCR on the free tier",
        paperly: "Unlimited runs (50 pages each)",
        ilovepdf: "Available, capped at 15 MB",
        paperlyState: "yes",
        iloveState: "partial",
      },
      {
        capability: "PDF/A conversion",
        paperly: "Preparation + readiness audit",
        ilovepdf: "Premium only",
        paperlyState: "partial",
        iloveState: "premium",
        note: "Paperly does not claim PDF/A certification. It prepares an archival copy and reports what needs external validation.",
      },
      {
        capability: "Price",
        paperly: "$0, no paid tier",
        ilovepdf: "Free, or $9/mo monthly · $5/mo annual",
        paperlyState: "yes",
        iloveState: "partial",
      },
    ],
  },
  {
    title: "Tools",
    blurb: "iLovePDF has a mature suite. Paperly covers the same core jobs and adds several power tools.",
    rows: [
      {
        capability: "Core suite",
        paperly: `${TOOLS.length} tools, all included`,
        ilovepdf: "~27 tools, some Premium",
        paperlyState: "yes",
        iloveState: "partial",
      },
      {
        capability: "Merge, split, remove/extract pages",
        paperly: "Yes, dedicated tools",
        ilovepdf: "Yes",
        paperlyState: "yes",
        iloveState: "yes",
      },
      {
        capability: "Compress, repair, OCR",
        paperly: "Yes — local, free",
        ilovepdf: "Yes — server-side",
        paperlyState: "yes",
        iloveState: "yes",
      },
      {
        capability: "Office ↔ PDF conversion",
        paperly: "Text-first, local",
        ilovepdf: "Mature, cloud-based",
        paperlyState: "partial",
        iloveState: "yes",
        note: "iLovePDF’s server engines reproduce complex Office layout more faithfully. Paperly is honest that its browser converters are text-first.",
      },
      {
        capability: "Create + fill + flatten forms",
        paperly: "Yes, all three",
        ilovepdf: "Yes (PDF Forms)",
        paperlyState: "yes",
        iloveState: "yes",
      },
      {
        capability: "Redact, compare, sign",
        paperly: "Yes — signature is visual only",
        ilovepdf: "Yes — digital signatures are Premium",
        paperlyState: "partial",
        iloveState: "partial",
        note: "Neither free tier provides certificate-backed signatures in the browser. For legally binding e-signature workflows, use a dedicated service.",
      },
      {
        capability: "Headers/footers, Bates numbering, N-up & booklet",
        paperly: "Yes",
        ilovepdf: "Not offered",
        paperlyState: "yes",
        iloveState: "no",
      },
      {
        capability: "Extract embedded images",
        paperly: "Yes, original quality",
        ilovepdf: "Desktop/mobile app",
        paperlyState: "yes",
        iloveState: "partial",
      },
      {
        capability: "Markdown ↔ PDF",
        paperly: "Both directions",
        ilovepdf: "PDF to Markdown only",
        paperlyState: "yes",
        iloveState: "partial",
      },
      {
        capability: "PDF to PDF/A",
        paperly: "Readiness check + prep, no certification",
        ilovepdf: "Yes, Premium",
        paperlyState: "partial",
        iloveState: "premium",
      },
      {
        capability: "AI summariser / translate",
        paperly: "Local extractive summary; no AI translation",
        ilovepdf: "Generative AI summary and translation",
        paperlyState: "partial",
        iloveState: "yes",
        note: "Paperly chooses not to send documents to an AI provider. Its summariser selects verbatim sentences from your own file instead.",
      },
      {
        capability: "Batch automation / workflows",
        paperly: "Batch action on many files",
        ilovepdf: "Workflows are Premium",
        paperlyState: "yes",
        iloveState: "premium",
      },
    ],
  },
  {
    title: "Platform and trust",
    blurb: "Where a larger, longer-established provider genuinely leads.",
    rows: [
      {
        capability: "Independent security certification",
        paperly: "None claimed",
        ilovepdf: "ISO 27001 (company)",
        paperlyState: "no",
        iloveState: "yes",
        note: "Paperly avoids claiming certifications it does not hold. Its strongest control is architectural: no document upload.",
      },
      {
        capability: "Native desktop & mobile apps",
        paperly: "Browser-based, works on mobile",
        ilovepdf: "Desktop and mobile (Premium)",
        paperlyState: "partial",
        iloveState: "premium",
      },
      {
        capability: "Cloud storage integrations",
        paperly: "Local files only, by design",
        ilovepdf: "Google Drive, Dropbox",
        paperlyState: "no",
        iloveState: "yes",
      },
      {
        capability: "Interface languages",
        paperly: "English",
        ilovepdf: "26 languages",
        paperlyState: "partial",
        iloveState: "yes",
      },
      {
        capability: "Developer API",
        paperly: "Self-hostable browser build",
        ilovepdf: "Commercial iLoveAPI",
        paperlyState: "partial",
        iloveState: "yes",
      },
      {
        capability: "Established track record",
        paperly: "Independent, newer",
        ilovepdf: "Large global user base",
        paperlyState: "partial",
        iloveState: "yes",
      },
    ],
  },
];

function StateIcon({ state }: { state: Verdict }) {
  if (state === "yes")
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-forest text-lime" title="Yes">
        <Check className="h-3 w-3" strokeWidth={3} />
      </span>
    );
  if (state === "no")
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-clay/10 text-clay-ink" title="No">
        <X className="h-3.5 w-3.5" />
      </span>
    );
  if (state === "premium")
    return <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.06em] text-amber-800">Premium</span>;
  return <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.06em] text-ink/70">Partial</span>;
}

export default function VersusPage() {
  return (
    <div>
      <PageHero
        eyebrow={`Honest comparison · verified ${VERIFIED}`}
        title={
          <>
            Paperly vs iLovePDF.
            <br />
            <span className="font-serif font-normal italic text-forest">Let the architecture decide.</span>
          </>
        }
        description="iLovePDF is a mature, well-run suite with excellent brand trust, native apps and cloud AI features. Paperly is smaller and newer, but it does something iLovePDF cannot: process the document without ever uploading it. Here is the full picture, including where they are better."
      >
        <div className="mt-6 flex flex-wrap gap-2">
          <a href="#/tools" className="inline-flex h-11 items-center gap-2 rounded-xl bg-ink px-5 text-[13.5px] font-medium text-paper hover:bg-forest-soft">
            Try Paperly free <ArrowRight className="h-4 w-4 text-lime" />
          </a>
          <a href="#/pricing" className="inline-flex h-11 items-center gap-2 rounded-xl border border-ink/15 px-5 text-[13.5px] font-medium hover:bg-paper">
            See pricing
          </a>
        </div>
      </PageHero>

      <section className="border-b border-line py-12">
        <div className="container-page">
          <div className="grid gap-3 md:grid-cols-4">
            {[
              { icon: CloudOff, title: "No upload", body: "The document never leaves the tab.", tone: "forest" },
              { icon: Layers, title: "No file caps", body: "Free batch, free OCR, no per-task tiers.", tone: "forest" },
              { icon: Sparkles, title: `${TOOLS.length} tools`, body: "Including forms, Bates, N-up and marks.", tone: "forest" },
              { icon: Globe, title: "$0", body: "No account, no ads, no premium gate.", tone: "forest" },
            ].map((card) => (
              <div key={card.title} className="rounded-2xl border border-line bg-paper p-4">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-lime/40 text-forest">
                  <card.icon className="h-4 w-4" />
                </div>
                <p className="mt-2.5 text-[13px] font-semibold">{card.title}</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{card.body}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-start gap-2 rounded-xl border border-line bg-bone-deep/40 px-4 py-3 text-[11px] leading-relaxed text-muted">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-forest" />
            <p>
              Feature and pricing details for iLovePDF were checked against{" "}
              <a href="https://www.ilovepdf.com/" target="_blank" rel="noreferrer noopener" className="font-medium text-forest underline underline-offset-2">ilovepdf.com</a>{" "}
              and its public{" "}
              <a href="https://www.ilovepdf.com/pricing" target="_blank" rel="noreferrer noopener" className="font-medium text-forest underline underline-offset-2">pricing page</a>{" "}
              in {VERIFIED}. Plans and limits change; verify before making a purchasing decision. Comparison is between Paperly and iLovePDF’s web
              suite; iLoveSign is a separate product.
            </p>
          </div>
        </div>
      </section>

      {GROUPS.map((group, groupIndex) => (
        <section key={group.title} className={cn("py-12", groupIndex < GROUPS.length - 1 && "border-b border-line")}>
          <div className="container-page">
            <SectionHead eyebrow={group.title} title={group.blurb} />
            <div className="mt-6 overflow-hidden rounded-2xl border border-line bg-paper">
              <div className="grid grid-cols-[1.4fr_1fr_1fr] items-center gap-3 border-b border-line bg-bone-deep/45 px-4 py-2.5 text-[10px] font-bold uppercase tracking-[0.08em] text-ink/75 sm:px-5">
                <span>Capability</span>
                <span className="text-center text-forest">Paperly</span>
                <span className="text-center">iLovePDF</span>
              </div>
              {group.rows.map((row, index) => (
                <div key={row.capability} className={cn("px-4 py-3 sm:px-5", index > 0 && "border-t border-line")}>
                  <div className="grid grid-cols-[1.4fr_1fr_1fr] items-center gap-3">
                    <p className="text-[12.5px] font-medium text-ink/80">{row.capability}</p>
                    <div className="flex flex-col items-center gap-1 text-center">
                      <StateIcon state={row.paperlyState} />
                      <span className="text-[10.5px] leading-snug text-ink/70">{row.paperly}</span>
                    </div>
                    <div className="flex flex-col items-center gap-1 text-center">
                      <StateIcon state={row.iloveState} />
                      <span className="text-[10.5px] leading-snug text-ink/70">{row.ilovepdf}</span>
                    </div>
                  </div>
                  {row.note && (
                    <p className="mt-2 rounded-lg bg-bone-deep/40 px-2.5 py-1.5 text-[10.5px] leading-relaxed text-muted">
                      <span className="font-semibold text-ink/70">Why: </span>
                      {row.note}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>
      ))}

      <section className="border-b border-line py-12">
        <div className="container-page grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-forest/15 bg-lime/15 p-5">
            <Badge tone="forest"><ShieldCheck className="h-3 w-3" /> Choose Paperly when</Badge>
            <ul className="mt-3 space-y-2">
              {[
                "The document is confidential, client-owned or regulated, and uploading it is the problem.",
                "You need unlimited batch work, OCR or compression without a per-tool cap or subscription.",
                "You want the result now, on a locked-down or offline-capable device.",
                "You need practical power tools: Bates numbering, N-up booklets, headers/footers, image extraction or form creation.",
                "You want AES-256 protection you can verify, with a tool that tells you its limits.",
              ].map((line) => (
                <li key={line} className="flex items-start gap-2 text-[12px] leading-relaxed text-forest/85">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {line}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-2xl border border-line bg-paper p-5">
            <Badge tone="clay"><ExternalLink className="h-3 w-3" /> Choose iLovePDF when</Badge>
            <ul className="mt-3 space-y-2">
              {[
                "You need certified PDF/A conversion with a formal compliance process.",
                "You need generative AI summarisation or translation of documents.",
                "Complex Office layout fidelity matters more than local processing.",
                "You want native desktop and mobile apps plus Google Drive or Dropbox integrations.",
                "You need a 26-language interface, an ISO 27001 vendor or a commercial API with a support contract.",
                "You need certificate-backed, legally binding e-signatures (via iLoveSign or a dedicated provider).",
              ].map((line) => (
                <li key={line} className="flex items-start gap-2 text-[12px] leading-relaxed text-ink/75">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-clay-ink/70" /> {line}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="border-b border-line py-12">
        <div className="container-page">
          <SectionHead
            eyebrow="The bottom line"
            title="A different trade-off, clearly stated."
            description="iLovePDF optimises for breadth, brand and cloud AI. Paperly optimises for privacy, no limits and owning your own processing. Neither is universally better — but for confidential documents, convenience should not require a copy on someone else’s server."
          />
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {[
              { icon: Lock, title: "Privacy you can verify", body: "No upload request exists. No retention schedule to trust. No account to breach." },
              { icon: Layers, title: "Free means complete", body: "Batch, OCR, forms, redaction and locking are included for everyone." },
              { icon: ShieldCheck, title: "Claims we can defend", body: "We label the signature as visual and the archive copy as a readiness check, not a certification." },
            ].map((card) => (
              <div key={card.title} className="rounded-2xl border border-line bg-paper p-4">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-forest text-lime">
                  <card.icon className="h-4 w-4" />
                </div>
                <p className="mt-2.5 text-[13px] font-semibold">{card.title}</p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-muted">{card.body}</p>
              </div>
            ))}
          </div>
          <p className="mt-4 text-[10.5px] leading-relaxed text-ink/75">
            Paperly is independent and not affiliated with iLovePDF. All trademarks belong to their owners. This comparison is provided for
            transparency; corrections are welcome at hello@paperly.tools.
          </p>
        </div>
      </section>

      <ClosingCTA />
    </div>
  );
}
