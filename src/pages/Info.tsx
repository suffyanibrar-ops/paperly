import {
  ArrowRight,
  Check,
  CloudOff,
  Cpu,
  FileText,
  Fingerprint,
  Globe,
  Heart,
  KeyRound,
  Lock,
  Mail,
  Search,
  ShieldCheck,
  Sparkles,
  Layers,
  X,
  Zap,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui";
import { POPULAR_IDS, TOOLS, getTool } from "@/lib/toolRegistry";
import { cn } from "@/utils/cn";

/* ------------------------------------------------------------------ *
 * Shared hero
 * ------------------------------------------------------------------ */
export function PageHero({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  description: string;
  children?: ReactNode;
}) {
  return (
    <section className="relative overflow-hidden border-b border-line">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(75%_90%_at_85%_0%,#eef8d3_0%,transparent_60%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-30 [background-image:linear-gradient(to_right,#ded9cb_1px,transparent_1px),linear-gradient(to_bottom,#ded9cb_1px,transparent_1px)] [background-size:64px_64px] [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />
      <div className="container-page relative grid gap-8 py-14 md:py-18 lg:grid-cols-[1.2fr_0.8fr] lg:items-center">
        <div>
          <Badge tone="forest">{eyebrow}</Badge>
          <h1 className="mt-4 max-w-[24ch] text-[38px] font-semibold leading-[1] tracking-[-0.045em] sm:text-[50px]">{title}</h1>
          <p className="mt-4 max-w-[56ch] text-[14.5px] leading-relaxed text-ink/70 sm:text-[15.5px]">{description}</p>
          {children}
        </div>
        <div className="hidden justify-end lg:flex">
          <div className="relative w-full max-w-[300px]">
            <div className="absolute -right-5 -top-5 h-full w-full rotate-3 rounded-2xl border border-line bg-lime/35" />
            <div className="absolute -right-2 -top-2 h-full w-full rotate-1 rounded-2xl border border-line bg-paper" />
            <div className="relative rounded-2xl border border-line bg-paper p-4 shadow-soft">
              <div className="flex items-center justify-between border-b border-line pb-2.5">
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-clay/60" />
                  <span className="h-2 w-2 rounded-full bg-amber-400/70" />
                  <span className="h-2 w-2 rounded-full bg-forest/50" />
                </div>
                <span className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-ink/75">Local only</span>
              </div>
              <div className="mt-3 space-y-2">
                {[
                  { icon: FileText, label: "your-document.pdf", value: "read in tab" },
                  { icon: Cpu, label: "Processing engine", value: "your device" },
                  { icon: CloudOff, label: "Server upload", value: "never" },
                  { icon: Lock, label: "Password route", value: "Web Crypto" },
                ].map((row) => (
                  <div key={row.label} className="flex items-center gap-2 rounded-lg border border-line bg-bone/50 px-2.5 py-2">
                    <row.icon className="h-3.5 w-3.5 shrink-0 text-forest" />
                    <span className="min-w-0 flex-1 truncate text-[10.5px] font-medium">{row.label}</span>
                    <span className="text-[9.5px] font-semibold uppercase tracking-[0.06em] text-forest/90">{row.value}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-1.5 rounded-lg bg-lime/30 px-2.5 py-2 text-[10px] font-medium text-forest">
                <ShieldCheck className="h-3.5 w-3.5" /> 0 B leaves this browser
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function SectionHead({ eyebrow, title, description, center = false }: { eyebrow: string; title: ReactNode; description?: string; center?: boolean }) {
  return (
    <div className={cn("max-w-2xl", center && "mx-auto text-center")}>
      <p className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-clay-ink">{eyebrow}</p>
      <h2 className="mt-2 text-[28px] font-semibold leading-[1.05] tracking-[-0.035em] sm:text-[36px]">{title}</h2>
      {description && <p className="mt-3 text-[13.5px] leading-relaxed text-muted">{description}</p>}
    </div>
  );
}

export function ClosingCTA() {
  return (
    <section className="pb-16 pt-4">
      <div className="container-page">
        <div className="grain relative overflow-hidden rounded-3xl bg-forest px-6 py-10 text-paper sm:px-10">
          <div className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 rounded-full bg-lime/15 blur-2xl" />
          <div className="relative flex flex-col items-start justify-between gap-5 md:flex-row md:items-center">
            <div>
              <h2 className="text-[26px] font-semibold leading-tight tracking-[-0.03em] sm:text-[32px]">
                Try a PDF tool. <span className="font-serif font-normal italic text-lime">Keep your files.</span>
              </h2>
              <p className="mt-1.5 text-[13px] text-paper/75">No sign-up screen will interrupt you. Promise.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {POPULAR_IDS.slice(0, 3).map((id) => {
                const tool = getTool(id)!;
                return (
                  <a key={id} href={`#/tool/${id}`} className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-lime px-3.5 text-[12.5px] font-semibold text-ink hover:bg-[#e4f88f]">
                    {tool.name} <ArrowRight className="h-3.5 w-3.5" />
                  </a>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ================================================================== *
 * WHY PAPERLY
 * ================================================================== */
export function WhyPage() {
  return (
    <div>
      <PageHero
        eyebrow="Why Paperly"
        title={
          <>
            Private isn’t a feature.
            <br />
            <span className="font-serif font-normal italic text-forest">It’s the starting point.</span>
          </>
        }
        description="Online PDF tools usually ask you to upload first and trust later. We rebuilt the model: the tools run in your browser, so the question of where your file went simply doesn’t come up."
      >
        <div className="mt-6 flex flex-wrap gap-2">
          <a href="#/tools" className="inline-flex h-11 items-center gap-2 rounded-xl bg-ink px-5 text-[13.5px] font-medium text-paper hover:bg-forest-soft">
            Explore the toolkit <ArrowRight className="h-4 w-4 text-lime" />
          </a>
          <a href="#/privacy" className="inline-flex h-11 items-center gap-2 rounded-xl border border-ink/15 px-5 text-[13.5px] font-medium hover:bg-paper">
            Privacy details
          </a>
        </div>
      </PageHero>

      <section className="border-b border-line py-14">
        <div className="container-page grid gap-10 lg:grid-cols-2 lg:gap-16">
          <div>
            <SectionHead
              eyebrow="The architecture"
              title={
                <>
                  The shortest route is
                  <br />
                  <span className="font-serif font-normal italic text-forest">no route at all.</span>
                </>
              }
              description="Most PDF sites are client–server applications: upload, queue, process, download. Paperly removes the entire server leg. That’s better for privacy, and it’s faster too."
            />
            <div className="mt-6 space-y-2.5">
              {[
                { title: "Traditional cloud tool", body: "Your file leaves your device, sits in a queue and may be retained. You rely on a policy.", bad: true },
                { title: "Paperly", body: "Your file is read in memory, processed by JavaScript and WebAssembly on your hardware, and downloaded directly.", bad: false },
              ].map((item) => (
                <div key={item.title} className={cn("rounded-xl border p-3.5", item.bad ? "border-clay/20 bg-clay/[0.04]" : "border-forest/20 bg-lime/15")}>
                  <p className="flex items-center gap-1.5 text-[12.5px] font-semibold">
                    {item.bad ? <X className="h-3.5 w-3.5 text-clay-ink" /> : <Check className="h-3.5 w-3.5 text-forest" />}
                    {item.title}
                  </p>
                  <p className="mt-1 text-[12px] leading-relaxed text-ink/70">{item.body}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-line bg-paper p-5">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink/75">What happens to your file</p>
            <div className="mt-4 space-y-2.5">
              {[
                { step: "1", label: "You pick a file", detail: "A local file handle. No network request.", icon: FileText },
                { step: "2", label: "The browser reads it", detail: "ArrayBuffer in memory, accessible only to this tab.", icon: Cpu },
                { step: "3", label: "A local engine works", detail: "PDF.js + pdf-lib rewrite the document in place.", icon: Zap },
                { step: "4", label: "The result downloads", detail: "A blob URL generated on your device.", icon: Check },
              ].map((item) => (
                <div key={item.step} className="flex items-start gap-3 rounded-xl border border-line bg-bone/40 p-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-forest text-lime">
                    <item.icon className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-[12px] font-semibold">{item.label}</p>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{item.detail}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-clay/20 bg-clay/[0.05] p-3">
              <X className="h-4 w-4 shrink-0 text-clay-ink" />
              <p className="text-[11px] leading-relaxed text-ink/70">
                <span className="font-semibold">Upload step:</span> there isn’t one. This app has no API endpoint for document data.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-line py-14">
        <div className="container-page">
          <SectionHead center eyebrow="Principles" title="Four choices we refuse to compromise." />
          <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                icon: ShieldCheck,
                title: "Privacy is structural",
                body: "Not a retention window or a promise. There is simply no copy to delete.",
              },
              {
                icon: Sparkles,
                title: "Free means complete",
                body: "No watermarked output, no premium-only features, no daily task meter.",
              },
              {
                icon: Fingerprint,
                title: "Honest limitations",
                body: "If a PDF is a scan or already optimized, we tell you instead of faking a result.",
              },
              {
                icon: Heart,
                title: "Built for humans",
                body: "Clear options, sensible defaults and no countdown timers or fake urgency.",
              },
            ].map((p) => (
              <div key={p.title} className="rounded-2xl border border-line bg-paper p-4">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-lime/40 text-forest">
                  <p.icon className="h-4.5 w-4.5" />
                </div>
                <p className="mt-3 text-[13.5px] font-semibold">{p.title}</p>
                <p className="mt-1 text-[12px] leading-relaxed text-muted">{p.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-b border-line py-14">
        <div className="container-page grid gap-10 lg:grid-cols-2 lg:gap-16">
          <SectionHead
            eyebrow="The economics"
            title={
              <>
                Why is it free?
                <br />
                <span className="font-serif font-normal italic text-forest">Because you own the computer.</span>
              </>
            }
            description="Cloud PDF services pay for servers, storage and bandwidth for every file. Paperly pushes that work to the browser, so there is no per-file cost to pass on to you. No subscription means no incentive to cripple the free tier."
          />
          <div className="rounded-2xl border border-line bg-paper p-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink/75">Technology we rely on</p>
            <div className="mt-3 space-y-2">
              {[
                { name: "PDF.js", role: "Rendering pages and reading text layers", license: "Apache 2.0" },
                { name: "pdf-lib (maintained fork)", role: "Editing, merging, page geometry, AES-256 encryption", license: "MIT" },
                { name: "Web Crypto API", role: "Secure random keys and browser-native crypto", license: "Web standard" },
                { name: "JSZip, docx, SheetJS, PptxGenJS", role: "Office formats and ZIP packaging", license: "Open source" },
              ].map((tech) => (
                <div key={tech.name} className="rounded-lg border border-line bg-bone/40 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[12px] font-semibold">{tech.name}</p>
                    <span className="text-[9.5px] font-semibold uppercase tracking-[0.06em] text-ink/75">{tech.license}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted">{tech.role}</p>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[10.5px] leading-relaxed text-ink/75">
              Typography is self-hosted: Inter Tight and Instrument Serif are bundled with the app, so rendering the interface makes no request to a font CDN and no document content, filenames or conversion results are ever sent to one.
            </p>
          </div>
        </div>
      </section>

      <section className="border-b border-line py-14">
        <div className="container-page">
          <SectionHead center eyebrow="Feature truth" title="What each tool really does." description="No vague marketing. Here’s the engineering reality of the formats that involve trade-offs." />
          <div className="mt-7 overflow-hidden rounded-2xl border border-line bg-paper">
            {[
              ["Merge, split, organize, rotate, crop", "Exact", "Original pages are copied; no re-rendering or quality loss."],
              ["Compress", "Image re-encoding", "Photos are re-encoded and structure optimized. Text stays selectable. A flatten option is offered only when it saves more."],
              ["Word → PDF", "Text-first", "Headings, paragraphs, lists and tables are laid out cleanly. Complex Word layout is simplified."],
              ["PDF → Word / Excel", "Text-first", "Relies on the PDF text layer. Scans need OCR, which Paperly does not pretend to provide."],
              ["PDF ↔ PowerPoint", "Page images / text", "PDF to PPT is pixel-faithful images. PPT to PDF is a clean text layout."],
              ["Protect & unlock", "Real encryption", "AES-256 for protection; genuine decryption with the correct password."],
            ].map(([feature, level, detail], i) => (
              <div key={feature} className={cn("grid gap-1 px-4 py-3.5 sm:grid-cols-[1fr_140px_1.6fr] sm:items-center sm:gap-4 sm:px-5", i > 0 && "border-t border-line")}>
                <p className="text-[12.5px] font-medium">{feature}</p>
                <span className="w-fit rounded-full bg-forest/7 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-forest">{level}</span>
                <p className="text-[11.5px] leading-relaxed text-muted">{detail}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <ClosingCTA />
    </div>
  );
}

/* ================================================================== *
 * PRIVACY
 * ================================================================== */
export function PrivacyPage() {
  return (
    <div>
      <PageHero
        eyebrow="Privacy promise"
        title={
          <>
            We can’t lose your files.
            <br />
            <span className="font-serif font-normal italic text-forest">We never receive them.</span>
          </>
        }
        description="This page is short because there isn’t much to disclose: no accounts, no analytics, no document uploads and no tracking cookies. Fonts are bundled locally, and the only external request the app can make is the pinned OCR engine — only if you use OCR. That keeps the privacy claim precise rather than absolute."
      >
        <div className="mt-6 inline-flex items-center gap-2 rounded-xl border border-forest/15 bg-lime/25 px-3.5 py-2.5 text-[12px] font-medium text-forest">
          <ShieldCheck className="h-4 w-4" /> Last reviewed: January 2026 · applies to every tool
        </div>
      </PageHero>

      <section className="border-b border-line py-12">
        <div className="container-page">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { value: "0", label: "Documents uploaded", icon: FileText },
              { value: "0", label: "Accounts created", icon: Fingerprint },
              { value: "0", label: "Tracking cookies", icon: Globe },
              { value: "100%", label: "Processing on-device", icon: Cpu },
            ].map((stat) => (
              <div key={stat.label} className="rounded-2xl border border-line bg-paper p-4">
                <stat.icon className="h-4 w-4 text-forest" />
                <p className="mt-3 text-[30px] font-semibold leading-none tracking-[-0.04em] text-forest">{stat.value}</p>
                <p className="mt-1.5 text-[11.5px] font-medium text-ink/70">{stat.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-b border-line py-14">
        <div className="container-page grid gap-10 lg:grid-cols-[1.4fr_0.6fr] lg:gap-16">
          <div className="space-y-8">
            {[
              {
                title: "What we collect",
                body: "Nothing. Paperly has no backend database or file storage. Files you select are read directly by your browser and kept in memory for the duration of the task. Closing the tab discards them. There is no account system, so we don’t hold names or email addresses either.",
              },
              {
                title: "Do documents leave my device?",
                body: "No. Merge, split, compression, conversion, editing, signing and encryption all use browser APIs on your machine. The app ships the processing engine to your browser once; your documents are not part of any request. You can confirm this in your browser’s developer tools: watch the Network panel while converting a file — no upload occurs.",
              },
              {
                title: "Cookies and analytics",
                body: "Paperly sets no advertising or analytics cookies. We don’t use session replay, fingerprinting or third-party tracking scripts. Your downloads and tool choices stay in the page, not on a profile.",
              },
              {
                title: "The only external requests the app makes",
                body: "Paperly does not upload documents, and because typography is self-hosted there is no font CDN request during a normal page load. To be accurate rather than absolute, these are the only outbound requests the application makes: (1) the first visit downloads the app’s own code and the two bundled typefaces from this origin; (2) if you use OCR PDF, the pinned OCR engine and WebAssembly core are fetched once from cdn.jsdelivr.net and the language data from tessdata.projectnaptha.com, then cached by your browser and by the offline service worker. OCR pages are rendered locally and are never sent to those CDNs. If your network blocks them, OCR will report that it could not download the engine instead of failing silently.",
              },
              {
                title: "What is stored in your browser",
                body: "Recent activity stores only: the tool name, the output filename, page count, output size and a timestamp. It lives in this browser’s localStorage under paperly.activity.v1, never contains document contents or passwords, and is visible only to you. Pinned tools are stored under paperly.favorites.v1. Clear all activity any time from the Activity page (or by clearing site data in your browser). Nothing is sent to Paperly.",
              },
              {
                title: "Data retention, stated plainly",
                body: "There is no server-side document storage because documents are never uploaded. Files you choose are held in the tab’s memory while the tool runs and are discarded when you close or reload the tab. Downloaded results live in your device’s Downloads folder until you delete them. Local activity metadata remains until you clear it or clear site data. Paperly holds no account, name or email address for you.",
              },
              {
                title: "Security and resource limits",
                body: "Uploads are checked by size and file signature, not just their name. PDFs are limited to 1,000 pages and 200 MB, images to 40 MB, Office files to 25–80 MB, and Office archives are inspected for path traversal, encrypted entries and decompression bombs before parsing. HTML is sanitised with DOMPurify against a strict allowlist, scripts and frames are removed, remote images are blocked, and page rendering cannot execute untrusted JavaScript. These limits exist to protect your device; they are disclosed here rather than hidden behind a paywall.",
              },
              {
                title: "Encryption and passwords",
                body: "Protect PDF uses Web Crypto to generate secure keys and AES-256 to encrypt the file inside the tab. Your password is not sent anywhere and is never stored. Unlock PDF compares your password against the document locally. When you close the tab, the password is gone. We cannot recover it.",
              },
              {
                title: "Your responsibilities",
                body: "Because processing is local, the security of the device matters. Use a trusted, up-to-date browser and be careful with shared computers — downloaded files persist in your Downloads folder. Only unlock or modify documents you have the right to access.",
              },
            ].map((section) => (
              <div key={section.title}>
                <h2 className="text-[19px] font-semibold tracking-[-0.02em]">{section.title}</h2>
                <p className="mt-2 text-[13.5px] leading-relaxed text-ink/75">{section.body}</p>
              </div>
            ))}
          </div>

          <aside className="space-y-3">
            <div className="rounded-2xl bg-forest p-5 text-paper">
              <CloudOff className="h-5 w-5 text-lime" />
              <p className="mt-3 text-[15px] font-semibold">The short version</p>
              <ul className="mt-2.5 space-y-2 text-[12px] text-paper/75">
                {["No document uploads", "No file retention", "No accounts or ads", "No tracking cookies", "No hidden file sharing"].map((item) => (
                  <li key={item} className="flex items-center gap-1.5">
                    <Check className="h-3.5 w-3.5 shrink-0 text-lime" /> {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-2xl border border-line bg-paper p-4">
              <p className="flex items-center gap-1.5 text-[12px] font-semibold">
                <KeyRound className="h-3.5 w-3.5 text-forest" /> Manage local data
              </p>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">
                Review or clear filenames stored by this browser.
              </p>
              <a href="#/activity" className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] font-semibold text-forest hover:underline">
                Open Activity &amp; clear history <ArrowRight className="h-3 w-3" />
              </a>
            </div>
            <div className="rounded-2xl border border-line bg-paper p-4">
              <p className="flex items-center gap-1.5 text-[12px] font-semibold">
                <KeyRound className="h-3.5 w-3.5 text-forest" /> Passwords & files
              </p>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">
                We cannot reset a document password, recover a file, or access anything you process. That’s the point.
              </p>
            </div>
            <div className="rounded-2xl border border-line bg-paper p-4">
              <p className="flex items-center gap-1.5 text-[12px] font-semibold">
                <Mail className="h-3.5 w-3.5 text-forest" /> Questions?
              </p>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">
                Write to{" "}
                <a href="mailto:privacy@paperly.tools" className="font-medium text-forest underline underline-offset-2">
                  privacy@paperly.tools
                </a>
                . Please don’t email sensitive documents.
              </p>
            </div>
          </aside>
        </div>
      </section>

      <ClosingCTA />
    </div>
  );
}

/* ================================================================== *
 * PRICING
 * ================================================================== */
export function PricingPage() {
  return (
    <div>
      <PageHero
        eyebrow="Pricing"
        title={
          <>
            One plan. Zero dollars.
            <br />
            <span className="font-serif font-normal italic text-forest">No asterisks.</span>
          </>
        }
        description="Every tool, every option, every page — free. No trial, no credit card, no “free” tier that watermarks your work or caps you at two files a day."
      >
        <div className="mt-6 flex flex-wrap gap-2">
          <a href="#/tools" className="inline-flex h-11 items-center gap-2 rounded-xl bg-ink px-5 text-[13.5px] font-medium text-paper hover:bg-forest-soft">
            Start using the tools <ArrowRight className="h-4 w-4 text-lime" />
          </a>
          <a href="mailto:hello@paperly.tools" className="inline-flex h-11 items-center gap-2 rounded-xl border border-ink/15 px-5 text-[13.5px] font-medium hover:bg-paper">
            Talk to us
          </a>
        </div>
      </PageHero>

      <section className="border-b border-line py-14">
        <div className="container-page grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-2xl border-2 border-forest bg-paper p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-forest">Paperly</p>
                <h2 className="mt-1 text-[24px] font-semibold tracking-[-0.03em]">Everything, for everyone</h2>
              </div>
              <span className="rounded-full bg-lime/50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-forest">Free forever</span>
            </div>
            <div className="mt-5 flex items-end gap-2">
              <span className="text-[58px] font-semibold leading-none tracking-[-0.05em]">$0</span>
              <span className="pb-1.5 text-[12.5px] text-muted">/ forever · no card</span>
            </div>
            <ul className="mt-5 grid gap-2 sm:grid-cols-2">
              {[
                `All ${TOOLS.length} PDF tools`,
                "Unlimited tasks and pages",
                "No watermarks on output",
                "AES-256 password protection",
                "Merge & split any size*",
                "Local processing, always",
                "No sign-up or email",
                "No ads or trackers",
              ].map((item) => (
                <li key={item} className="flex items-start gap-2 text-[12.5px] text-ink/70">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-forest" /> {item}
                </li>
              ))}
            </ul>
            <a href="#/tools" className="mt-6 inline-flex h-12 items-center gap-2 rounded-xl bg-forest px-6 text-[14px] font-semibold text-paper hover:bg-forest-soft">
              Open the toolkit <ArrowRight className="h-4 w-4 text-lime" />
            </a>
            <p className="mt-3 text-[10.5px] leading-relaxed text-muted">* Limited only by your device’s available memory, not by a price plan.</p>
          </div>

          <div className="space-y-4">
            <div className="rounded-2xl border border-line bg-bone-deep/40 p-5">
              <p className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink/75">
                <Heart className="h-3.5 w-3.5" /> Why it can be free
              </p>
              <p className="mt-2 text-[13px] leading-relaxed text-ink/75">
                Cloud PDF services pay for storage, bandwidth and compute per file — which is why they meter usage. Paperly uses your device for
                the work, so the marginal cost of a conversion is effectively zero. There’s no reason to charge you, and no incentive to degrade
                the free version.
              </p>
            </div>
            <div className="rounded-2xl border border-line bg-paper p-5">
              <p className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink/75">For teams & integrators</p>
              <h3 className="mt-1.5 text-[17px] font-semibold tracking-[-0.02em]">Run Paperly inside your organization</h3>
              <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
                The application is a self-contained browser build. It can be hosted on your intranet with no processing server, which makes
                privacy reviews refreshingly short.
              </p>
              <a href="mailto:hello@paperly.tools?subject=Team%20deployment" className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-semibold text-forest hover:underline">
                Ask about deployment <ArrowRight className="h-3.5 w-3.5" />
              </a>
            </div>
            <div className="rounded-2xl border border-forest/15 bg-lime/20 p-5">
              <p className="flex items-center gap-1.5 text-[12px] font-semibold text-forest">
                <Sparkles className="h-3.5 w-3.5" /> No dark patterns
              </p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-forest/85">
                The download button is the download button. No countdown, no fake “premium” result, no email wall at the finish line.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-line py-14">
        <div className="container-page">
          <SectionHead center eyebrow="No surprises" title="What “free” includes." />
          <div className="mx-auto mt-7 max-w-3xl overflow-hidden rounded-2xl border border-line bg-paper">
            {[
              ["Task limits", "Unlimited. There is no counter."],
              ["File size", "Bounded by your browser memory, not a plan."],
              ["Watermarks", "Never added to your output."],
              ["Output quality", "The full-quality result is the only result."],
              ["Account", "Not required, not offered."],
              ["Payment details", "Never requested."],
            ].map(([q, a], i) => (
              <div key={q} className={cn("grid grid-cols-[1fr_1.4fr] gap-4 px-4 py-3 text-[12.5px] sm:px-5", i > 0 && "border-t border-line")}>
                <span className="font-medium text-ink/70">{q}</span>
                <span className="text-muted">{a}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <ClosingCTA />
    </div>
  );
}

/* ================================================================== *
 * HELP
 * ================================================================== */
const FAQS = [
  {
    category: "Getting started",
    items: [
      {
        q: "How do I use Paperly?",
        a: "Open the tool you need, drop your file into the page, adjust the options and press the action button. Your result is generated locally and the download begins from your browser. Nothing is queued or emailed.",
      },
      {
        q: "Do I need to create an account?",
        a: "No. There are no accounts, logins, emails or verification steps anywhere in Paperly. You can use every tool immediately.",
      },
      {
        q: "Does it work on mobile?",
        a: "Yes, on modern mobile browsers. Very large documents may be limited by available phone memory. The PDF editor and signature tools support touch input.",
      },
      {
        q: "Can I process multiple files at once?",
        a: "Merge PDF and JPG to PDF accept multiple files. Other tools process one document per run. There is no batch queue, because everything happens in real time.",
      },
    ],
  },
  {
    category: "Privacy & security",
    items: [
      {
        q: "Is my file really not uploaded?",
        a: "Correct. There is no document upload endpoint. Open your browser’s developer tools, go to the Network tab and process a file — you’ll see no request carrying the document.",
      },
      {
        q: "What happens to my file when I close the tab?",
        a: "It is discarded. Paperly holds files in the page’s memory only. There is no server copy, cache or history. Downloaded results live in your device’s Downloads folder until you delete them.",
      },
      {
        q: "How secure is the password protection?",
        a: "Protect PDF uses AES-256 encryption with keys generated by the Web Crypto API. The password is never stored or transmitted. We cannot recover a lost password, and no one at Paperly can open your protected file.",
      },
      {
        q: "Is a Paperly signature legally binding?",
        a: "It adds a visual signature, and Paperly is not a certificate authority. Whether an electronic signature is binding depends on your jurisdiction and agreement. For regulated or high-value documents, use a dedicated e-signature service with audit trails and identity checks.",
      },
    ],
  },
  {
    category: "Formats & accuracy",
    items: [
      {
        q: "Why didn’t my scanned PDF convert to Word or Excel?",
        a: "Scans are images; they contain no text layer to extract. Paperly does not perform OCR, so there is genuinely nothing to convert. PDF to JPG and PDF to PowerPoint still work, because they use images.",
      },
      {
        q: "Does PDF to Word preserve the layout?",
        a: "It preserves the words and creates sensible paragraphs and page breaks, but not pixel-perfect formatting. Complex multi-column layouts, floating images and custom fonts are simplified. That trade-off is stated before conversion.",
      },
      {
        q: "Why didn’t my file get smaller?",
        a: "If a PDF is already optimized, or contains mostly vector text with little imagery, there is nothing meaningful to remove. Paperly reports this instead of returning a file that grew.",
      },
      {
        q: "Why is PowerPoint to PDF text-only?",
        a: "Rendering a PPTX visual design accurately requires the PowerPoint engine. Paperly extracts slide titles and text into a clean landscape layout. For a pixel-perfect deck, export the PDF from PowerPoint itself.",
      },
      {
        q: "Does Paperly support OCR?",
        a: "Yes. OCR PDF renders each scanned page and runs Tesseract locally, then embeds an invisible text layer so the document becomes searchable. On first use the OCR engine and language data download from a public CDN and are cached; your pages are never uploaded. Up to 50 pages per run.",
      },
      {
        q: "How does Paperly's summariser differ from an AI summariser?",
        a: "Paperly's summariser is extractive and deterministic: it ranks sentences in your document and returns the most representative ones verbatim. It runs locally, never invents facts and sends nothing to an AI provider. It does not paraphrase or translate. iLovePDF offers generative AI summaries and translation; those require sending the document to their servers and, for advanced models, AI credits.",
      },
      {
        q: "Is there a limit on batch processing?",
        a: "No per-task file count or size tier. Batch PDF lets you compress, rotate, protect, number or watermark as many files as your device can hold, and returns a ZIP. Processing is sequential in your browser, so very large batches take longer on slower hardware. iLovePDF's free tier limits batch processing and per-tool file sizes.",
      },
      {
        q: "Does Paperly convert to PDF/A?",
        a: "Paperly prepares an archival copy — flattening forms, stripping scripts and open actions, writing metadata and optionally embedding the original — and runs a readiness audit covering encryption, fonts, colour output intents and metadata. It does not claim certified PDF/A conformance, because that requires validation with a dedicated tool such as veraPDF. iLovePDF offers PDF/A conversion on its Premium plan.",
      },
      {
        q: "Can I create a fillable PDF form?",
        a: "Yes. Create fillable form lets you place text fields, checkboxes and dropdowns on any PDF and saves them as real AcroForm widgets with names, options and required flags. You can then fill the form and flatten the answers, entirely locally.",
      },
      {
        q: "Can I edit existing text in the PDF?",
        a: "The editor adds new content — text boxes, images, shapes, highlights and signatures. Existing PDF text isn’t reflowed. Use a whiteout rectangle to cover content you don’t need, and remember that covered content may still be extractable underneath.",
      },
    ],
  },
  {
    category: "Troubleshooting",
    items: [
      {
        q: "A tool says my PDF is password-protected.",
        a: "Most tools need to read the document’s pages, which requires removing the password first. Open Unlock PDF, enter the password you own, then use the result in the tool you wanted.",
      },
      {
        q: "My browser ran out of memory with a large file.",
        a: "Close other tabs, try a lower resolution (for PDF to JPG), or split the document into smaller parts with Split PDF. Processing happens in memory, so the device is the limit.",
      },
      {
        q: "Nothing downloads when I click the button.",
        a: "Check your browser’s download permissions and whether a pop-up blocker is active. On iOS, downloads may be saved in the Files app rather than immediately shown.",
      },
      {
        q: "Can I recover a PDF I encrypted and lost the password to?",
        a: "No. AES-256 is designed to prevent exactly that. Keep protected files and their passwords in a password manager.",
      },
    ],
  },
];

export function HelpPage() {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<{ category: string; index: number } | null>({ category: "Getting started", index: 0 });

  const q = query.trim().toLowerCase();
  const filtered = FAQS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !q || item.q.toLowerCase().includes(q) || item.a.toLowerCase().includes(q)),
  })).filter((group) => group.items.length);

  return (
    <div>
      <PageHero
        eyebrow="Help & FAQ"
        title={
          <>
            Answers, without
            <br />
            <span className="font-serif font-normal italic text-forest">the runaround.</span>
          </>
        }
        description="Everything worth knowing about the tools, privacy, formats and limits — written plainly. If your question isn’t here, email us; a human replies."
      >
        <label className="relative mt-6 block max-w-md">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/75" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search help — e.g. password, scanned, Word…"
            className="h-12 w-full rounded-xl border border-line bg-paper pl-10 pr-4 text-[13.5px] placeholder:text-ink/75 shadow-soft focus:border-forest/40 focus:outline-none focus:ring-2 focus:ring-forest/10"
          />
        </label>
      </PageHero>

      <section className="border-b border-line py-12">
        <div className="container-page">
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { title: "Password-protected file?", body: "Remove the password locally, then use the document anywhere.", href: "#/tool/unlock", icon: KeyRound },
              { title: "Scanned PDF?", body: "Compress it, convert it to images, or build slides from it.", href: "#/tool/pdf-to-jpg", icon: FileText },
              { title: "Damaged file?", body: "Try the repair tool to rebuild readable pages.", href: "#/tool/repair", icon: ShieldCheck },
              { title: "Many files at once?", body: "Use unlimited local batch processing and download a ZIP.", href: "#/tool/batch", icon: Layers },
              { title: "Summarise a report?", body: "Get the key passages locally, without uploading the document.", href: "#/tool/summarize", icon: Sparkles },
            ].map((card) => (
              <a key={card.title} href={card.href} className="group rounded-xl border border-line bg-paper p-4 transition-colors hover:border-forest/30">
                <card.icon className="h-4 w-4 text-forest" />
                <p className="mt-2 text-[13px] font-semibold">{card.title}</p>
                <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted">{card.body}</p>
                <span className="mt-2 inline-flex items-center gap-1 text-[11.5px] font-medium text-forest group-hover:underline">
                  Open tool <ArrowRight className="h-3 w-3" />
                </span>
              </a>
            ))}
          </div>
        </div>
      </section>

      <section className="py-14">
        <div className="container-page grid gap-10 lg:grid-cols-[1fr_280px] lg:gap-14">
          <div>
            {filtered.length ? (
              <div className="space-y-9">
                {filtered.map((group) => (
                  <div key={group.category}>
                    <h2 className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-ink/75">{group.category}</h2>
                    <div className="divide-y divide-line rounded-2xl border border-line bg-paper px-4 sm:px-5">
                      {group.items.map((item, index) => {
                        const isOpen = q ? true : open?.category === group.category && open?.index === index;
                        return (
                          <div key={item.q}>
                            <button
                              type="button"
                              onClick={() => setOpen(isOpen && !q ? null : { category: group.category, index })}
                              aria-expanded={Boolean(isOpen)}
                              className="flex w-full items-center justify-between gap-4 py-4 text-left"
                            >
                              <span className="text-[13.5px] font-medium">{item.q}</span>
                              <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-line text-ink/75 transition-transform", isOpen && "rotate-45 border-forest text-forest")}>
                                +
                              </span>
                            </button>
                            {isOpen && <p className="max-w-2xl pb-4 pr-8 text-[12.5px] leading-relaxed text-muted">{item.a}</p>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-line bg-paper p-10 text-center">
                <p className="text-[14px] font-medium">No help article matches “{query}”.</p>
                <button type="button" onClick={() => setQuery("")} className="mt-2 text-[12px] font-semibold text-forest hover:underline">
                  Clear search
                </button>
              </div>
            )}
          </div>
          <aside className="space-y-3">
            <div className="rounded-2xl bg-forest p-5 text-paper">
              <Mail className="h-5 w-5 text-lime" />
              <p className="mt-2.5 text-[14px] font-semibold">Still stuck?</p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-paper/70">
                Tell us the tool and what happened. Don’t attach the sensitive document itself.
              </p>
              <a href="mailto:hello@paperly.tools" className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-semibold text-lime hover:underline">
                hello@paperly.tools <ArrowRight className="h-3.5 w-3.5" />
              </a>
            </div>
            <div className="rounded-2xl border border-line bg-paper p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink/75">Quick links</p>
              <ul className="mt-2 space-y-1.5">
                {["merge", "compress", "protect", "pdf-to-word", "edit"].map((id) => {
                  const tool = getTool(id)!;
                  return (
                    <li key={id}>
                      <a href={`#/tool/${id}`} className="flex items-center justify-between rounded-lg px-1 py-1.5 text-[12px] font-medium text-ink/75 hover:text-forest">
                        {tool.name} <ArrowRight className="h-3 w-3" />
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="rounded-2xl border border-line bg-bone-deep/40 p-4">
              <p className="flex items-center gap-1.5 text-[11.5px] font-semibold">
                <ShieldCheck className="h-3.5 w-3.5 text-forest" /> Privacy reminder
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted">
                Support emails are for questions, not files. Nothing you process in the app is accessible to us.
              </p>
            </div>
          </aside>
        </div>
      </section>

      <section className="border-t border-line py-14">
        <div className="container-page">
          <SectionHead eyebrow="Format guide" title="What each conversion does — and doesn’t." />
          <div className="mt-6 overflow-hidden rounded-2xl border border-line bg-paper">
            {[
              ["PDF → Word", "Editable .docx from the PDF text layer", "Scans need OCR; complex layout simplified"],
              ["Word → PDF", "Headings, paragraphs, lists, basic tables", "Text boxes, columns and tracked changes simplified"],
              ["PDF → Excel", "One sheet per page, row/column detection", "Best with consistent columns; scans unsupported"],
              ["Excel → PDF", "Clean tables, repeated headers, multiple sheets", "Charts and cell styling simplified"],
              ["PDF → PowerPoint", "One high-resolution slide per page", "Slides are images; text isn’t editable"],
              ["PowerPoint → PDF", "Slide titles and text, landscape pages", "Theme, images and animations simplified"],
              ["PDF → JPG", "Every page as JPG or PNG, up to 300 DPI", "Image size grows with resolution"],
              ["OCR PDF", "Real Tesseract OCR, searchable PDF or text", "First run downloads the engine; 50 pages per run"],
              ["PDF ↔ Markdown", "Structured Markdown with tables and YAML", "Text layer required; scans need OCR first"],
              ["HTML → PDF", "Visual page rendering at A4/Letter", "Text becomes an image; scripts are stripped"],
            ].map(([format, does, limits], i) => (
              <div key={format} className={cn("grid gap-1 px-4 py-3 sm:grid-cols-[140px_1.2fr_1.2fr] sm:gap-4 sm:px-5", i > 0 && "border-t border-line")}>
                <p className="text-[12px] font-semibold">{format}</p>
                <p className="text-[11.5px] text-ink/75">{does}</p>
                <p className="text-[11.5px] text-muted">{limits}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <ClosingCTA />
    </div>
  );
}

/* ================================================================== *
 * TERMS
 * ================================================================== */
export function TermsPage() {
  return (
    <div>
      <PageHero
        eyebrow="Terms of use"
        title={
          <>
            Plain terms for
            <br />
            <span className="font-serif font-normal italic text-forest">a simple tool.</span>
          </>
        }
        description="Paperly is a browser-based utility. Use it responsibly, keep backups of important documents, and don’t rely on it as a regulated signing service. Last updated: January 2026."
      />
      <section className="py-14">
        <div className="container-page max-w-3xl space-y-8">
          {[
            { title: "1. The service", body: "Paperly provides free, browser-based tools for processing PDF and office documents. Processing occurs on your device. We do not provide storage, hosted processing or account services." },
            { title: "2. Your files and content", body: "You retain all rights to your documents. Because files never leave your device, we receive no license to them and have no ability to access them. You are responsible for ensuring you have the right to modify, unlock or distribute any document you process." },
            { title: "3. Acceptable use", body: "Do not use Paperly to remove password protection from documents you do not own or have permission to access, to infringe intellectual property, or to create or distribute unlawful content. You are responsible for compliance with applicable law." },
            { title: "4. No warranty", body: "The tools are provided “as is” without warranties of any kind. Document formats are varied and complex; while we test carefully, output accuracy is not guaranteed. Always keep the original file and verify important results before sharing them." },
            { title: "5. Signatures and security", body: "Visual signatures created in Paperly are not certificate-backed digital signatures and do not provide identity verification, audit trails or timestamps. Password protection uses standard PDF encryption; lost passwords cannot be recovered. Permissions set in a protected PDF are advisory and depend on the reader." },
            { title: "6. Limitation of liability", body: "To the maximum extent permitted by law, Paperly is not liable for indirect, incidental or consequential damages, loss of data or loss of profits arising from use of the tools. Keep independent backups of important documents." },
            { title: "7. Open-source components", body: "Paperly builds on open-source software including PDF.js, pdf-lib, JSZip, docx, SheetJS and PptxGenJS, which remain subject to their own licenses. Attribution is retained where required." },
            { title: "8. Changes and contact", body: "These terms may be updated as the product evolves; the date above reflects the current version. Questions can be sent to hello@paperly.tools." },
          ].map((section) => (
            <div key={section.title}>
              <h2 className="text-[18px] font-semibold tracking-[-0.02em]">{section.title}</h2>
              <p className="mt-2 text-[13.5px] leading-relaxed text-ink/75">{section.body}</p>
            </div>
          ))}
          <div className="rounded-2xl border border-forest/15 bg-lime/20 p-4 text-[12px] leading-relaxed text-forest">
            <p className="flex items-center gap-1.5 font-semibold">
              <ShieldCheck className="h-4 w-4" /> Our privacy commitment remains paramount
            </p>
            <p className="mt-1 text-forest/90">Nothing in these terms changes the fact that your documents are never uploaded to us.</p>
          </div>
        </div>
      </section>
      <ClosingCTA />
    </div>
  );
}

/* ================================================================== *
 * 404
 * ================================================================== */
export function NotFoundPage() {
  return (
    <div className="container-page flex min-h-[60vh] flex-col items-center justify-center py-20 text-center">
      <Badge tone="clay">404</Badge>
      <h1 className="mt-4 text-[34px] font-semibold tracking-[-0.04em]">This page wandered off.</h1>
      <p className="mt-2 max-w-md text-[13.5px] leading-relaxed text-muted">
        The link may be old, but the tools are all still here — and they still don’t upload anything.
      </p>
      <div className="mt-6 flex gap-2">
        <a href="#/" className="inline-flex h-11 items-center rounded-xl bg-ink px-5 text-[13.5px] font-medium text-paper">Back home</a>
        <a href="#/tools" className="inline-flex h-11 items-center gap-1.5 rounded-xl border border-line bg-paper px-5 text-[13.5px] font-medium">
          All tools <ArrowRight className="h-4 w-4" />
        </a>
      </div>
    </div>
  );
}

export { ClosingCTA as InfoClosingCTA };
