import { useEffect, useMemo, useState } from "react";
import { FilePenLine, Info, ShieldCheck, Trash2 } from "lucide-react";
import { PDFDict, PDFName, PDFRef, PDFString } from "@cantoo/pdf-lib";
import {
  baseName,
  downloadBytes,
  formatBytes,
  openPdfLib,
  sanitizeName,
  type PDFDocument,
} from "@/lib/pdf";
import { useInitialFiles, usePdfFile } from "@/lib/usePdf";
import { useDownloadShortcut, usePrimaryShortcut } from "@/lib/hotkeys";
import { useToolPreferences } from "@/lib/prefs";
import { Alert, Badge, Button, Field, Switch, TextInput } from "@/components/ui";
import { AdvancedOptions, OptionsGrid, OptionNote } from "@/components/AdvancedOptions";
import { DownloadPanel, SinglePdfInput } from "@/components/toolParts";

interface MetaFields {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
  creationDate: string;
  modificationDate: string;
}

const EMPTY: MetaFields = {
  title: "",
  author: "",
  subject: "",
  keywords: "",
  creator: "",
  producer: "",
  creationDate: "",
  modificationDate: "",
};

const FIELD_LABELS: { key: keyof MetaFields; label: string; hint: string; placeholder: string }[] = [
  { key: "title", label: "Title", hint: "Shown in viewer tabs, search results and most document libraries.", placeholder: "Quarterly inventory report" },
  { key: "author", label: "Author", hint: "The person or team responsible for the document.", placeholder: "Finance team" },
  { key: "subject", label: "Subject", hint: "A one-line description of what the document covers.", placeholder: "Inventory reconciliation" },
  { key: "keywords", label: "Keywords", hint: "Comma-separated search terms.", placeholder: "inventory, audit, Q3" },
  { key: "creator", label: "Creator", hint: "The application that authored the original content.", placeholder: "Microsoft Word" },
  { key: "producer", label: "Producer", hint: "The library that produced the PDF file.", placeholder: "Paperly" },
];

const FIELD_NAMES: Record<keyof MetaFields, string> = {
  title: "Title",
  author: "Author",
  subject: "Subject",
  keywords: "Keywords",
  creator: "Creator",
  producer: "Producer",
  creationDate: "Creation date",
  modificationDate: "Modification date",
};

interface MetadataTemplate {
  id: string;
  label: string;
  description: string;
  title: string;
  subject: string;
  keywords: string;
  creator: string;
}

/**
 * Templates fill the identity of a document — subject, keywords and creator —
 * and the title only when it is still empty. Author is never filled
 * automatically: it is personal data that only the operator can supply.
 */
const TEMPLATES: readonly MetadataTemplate[] = [
  {
    id: "report",
    label: "Business report",
    description: "Quarterly or annual reporting documents",
    title: "Business report",
    subject: "Business performance report",
    keywords: "report, business, review",
    creator: "Paperly",
  },
  {
    id: "invoice",
    label: "Invoice",
    description: "Billing documents and receipts",
    title: "Invoice",
    subject: "Invoice for services",
    keywords: "invoice, billing, payment",
    creator: "Paperly",
  },
  {
    id: "contract",
    label: "Contract",
    description: "Agreements and signed paperwork",
    title: "Agreement",
    subject: "Signed agreement",
    keywords: "contract, agreement, legal",
    creator: "Paperly",
  },
  {
    id: "memo",
    label: "Internal memo",
    description: "Notes circulated inside a team",
    title: "Internal memo",
    subject: "Internal update",
    keywords: "memo, internal, update",
    creator: "Paperly",
  },
  {
    id: "release",
    label: "Public release",
    description: "Documents published outside the organisation",
    title: "Public document",
    subject: "Public release",
    keywords: "public, release",
    creator: "Paperly",
  },
];

interface MetadataChange {
  key: keyof MetaFields;
  before: string;
  after: string;
}

interface MetadataResult {
  bytes: Uint8Array;
  name: string;
  pages: number;
  cleared: string[];
  diff: MetadataChange[];
  strippedAll: boolean;
}

/** Convert an ISO date input value into a UTC date, or null when unset. */
export function parseDateInput(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Format a PDF-lib date as a yyyy-mm-dd date input value. */
export function toDateInput(value: Date | undefined): string {
  if (!value || Number.isNaN(value.getTime())) return "";
  const year = value.getUTCFullYear();
  const month = `${value.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${value.getUTCDate()}`.padStart(2, "0");
  if (year < 1900 || year > 3000) return "";
  return `${year}-${month}-${day}`;
}

function readMeta(doc: PDFDocument): MetaFields {
  return {
    title: doc.getTitle() ?? "",
    author: doc.getAuthor() ?? "",
    subject: doc.getSubject() ?? "",
    keywords: doc.getKeywords() ?? "",
    creator: doc.getCreator() ?? "",
    producer: doc.getProducer() ?? "",
    creationDate: toDateInput(doc.getCreationDate()),
    modificationDate: toDateInput(doc.getModificationDate()),
  };
}

/** Remove every standard Info-dictionary key the tool can rewrite. */
function clearStandardMetadata(doc: PDFDocument): string[] {
  const removed: string[] = [];
  const infoRef = doc.context.trailerInfo.Info;
  if (!infoRef) return removed;
  const info = doc.context.lookup(infoRef);
  if (!(info instanceof PDFDict)) return removed;
  for (const key of ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"]) {
    const name = PDFName.of(key);
    if (info.has(name)) {
      info.delete(name);
      removed.push(key);
    }
  }
  return removed;
}

function hasXmpMetadata(doc: PDFDocument): boolean {
  try {
    return doc.catalog.has(PDFName.of("Metadata"));
  } catch {
    return false;
  }
}

/** Detach the XMP packet from the catalog (and drop the stream object). */
function removeXmpMetadata(doc: PDFDocument): boolean {
  try {
    if (!doc.catalog.has(PDFName.of("Metadata"))) return false;
    const reference = doc.catalog.get(PDFName.of("Metadata"));
    doc.catalog.delete(PDFName.of("Metadata"));
    if (reference instanceof PDFRef) doc.context.delete(reference);
    return true;
  } catch {
    return false;
  }
}

/** Keys whose visible value changed between the two snapshots. */
function diffMetadata(before: MetaFields, after: MetaFields): MetadataChange[] {
  const changes: MetadataChange[] = [];
  for (const key of Object.keys(EMPTY) as (keyof MetaFields)[]) {
    if (before[key] === after[key]) continue;
    changes.push({ key, before: before[key], after: after[key] });
  }
  return changes;
}

export function MetadataTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const opts = useToolPreferences("metadata", {
    template: "",
    stripXmp: false,
    touchModified: false,
  });
  const [fields, setFields] = useState<MetaFields>(EMPTY);
  const [original, setOriginal] = useState<MetaFields>(EMPTY);
  const [xmp, setXmp] = useState(false);
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmStrip, setConfirmStrip] = useState(false);
  const [result, setResult] = useState<MetadataResult | null>(null);

  const stripXmp = opts.value.stripXmp;
  const touchModified = opts.value.touchModified;

  useEffect(() => {
    if (!pdf.bytes) {
      setFields(EMPTY);
      setOriginal(EMPTY);
      setXmp(false);
      return;
    }
    let alive = true;
    setLoadingMeta(true);
    setError("");
    setConfirmStrip(false);
    (async () => {
      const doc = await openPdfLib(pdf.bytes!);
      if (!alive) return;
      const meta = readMeta(doc);
      setFields(meta);
      setOriginal(meta);
      setXmp(hasXmpMetadata(doc));
    })()
      .catch((err) => alive && setError((err as Error).message))
      .finally(() => alive && setLoadingMeta(false));
    return () => {
      alive = false;
    };
  }, [pdf.bytes]);

  const dirty = useMemo(
    () => (Object.keys(EMPTY) as (keyof MetaFields)[]).some((key) => fields[key] !== original[key]),
    [fields, original],
  );

  const set = (key: keyof MetaFields, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
    setResult(null);
    setNotice("");
  };

  const applyTemplate = (template: MetadataTemplate) => {
    opts.set("template", template.id);
    setFields((prev) => ({
      ...prev,
      title: prev.title.trim() ? prev.title : template.title,
      subject: template.subject,
      keywords: template.keywords,
      creator: template.creator,
    }));
    setResult(null);
    setConfirmStrip(false);
    setNotice(`Template “${template.label}” filled subject, keywords and creator. Author is left for you to set.`);
  };

  const save = async () => {
    if (!pdf.bytes || !pdf.file || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    setResult(null);
    try {
      const doc = await openPdfLib(pdf.bytes);
      for (const entry of FIELD_LABELS) {
        const value = fields[entry.key].trim();
        if (value) {
          if (entry.key === "title") doc.setTitle(value);
          else if (entry.key === "author") doc.setAuthor(value);
          else if (entry.key === "subject") doc.setSubject(value);
          else if (entry.key === "keywords") doc.setKeywords(value.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean));
          else if (entry.key === "creator") doc.setCreator(value);
          else if (entry.key === "producer") doc.setProducer(value);
        }
      }

      const created = parseDateInput(fields.creationDate);
      const modified = parseDateInput(fields.modificationDate);
      if (created) doc.setCreationDate(created);
      if (modified) doc.setModificationDate(modified);
      else if (touchModified) doc.setModificationDate(new Date());
      // Keep the Info dictionary consistent with the edited fields.
      const infoRef = doc.context.trailerInfo.Info;
      const infoDict = infoRef ? doc.context.lookup(infoRef) : undefined;
      if (infoDict instanceof PDFDict) {
        if (fields.title.trim()) infoDict.set(PDFName.of("Title"), PDFString.of(fields.title.trim()));
        if (fields.author.trim()) infoDict.set(PDFName.of("Author"), PDFString.of(fields.author.trim()));
      }
      const xmpRemoved = stripXmp ? removeXmpMetadata(doc) : false;

      const bytes = await doc.save();
      // Self-verify: the output must reopen and expose the values we just wrote.
      const check = await openPdfLib(bytes);
      if (fields.title.trim() && check.getTitle() !== fields.title.trim()) {
        throw new Error("The document was written but the new title could not be verified. Try another file.");
      }
      if (xmpRemoved && hasXmpMetadata(check)) {
        throw new Error("The XMP packet could not be removed from the saved copy. Nothing was offered for download.");
      }
      const after = readMeta(check);
      const diff = diffMetadata(original, after);
      setResult({
        bytes,
        name: `${sanitizeName(baseName(pdf.file.name))}-metadata.pdf`,
        pages: check.getPageCount(),
        cleared: [],
        diff,
        strippedAll: false,
      });
      setOriginal(after);
      setXmp(hasXmpMetadata(check));
      setNotice(
        xmpRemoved
          ? "Metadata saved and the XMP packet removed. The document content is untouched."
          : "Metadata saved. The document content is untouched.",
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const clearAll = async () => {
    if (!pdf.bytes || !pdf.file || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    setResult(null);
    try {
      const doc = await openPdfLib(pdf.bytes);
      const cleared = clearStandardMetadata(doc);
      const bytes = await doc.save();
      const check = await openPdfLib(bytes);
      const checkMeta = readMeta(check);
      const stillThere = (Object.keys(EMPTY) as (keyof MetaFields)[]).filter((key) => key !== "creationDate" && key !== "modificationDate" && checkMeta[key]);
      const diff = diffMetadata(original, checkMeta);
      setResult({
        bytes,
        name: `${sanitizeName(baseName(pdf.file.name))}-clean-metadata.pdf`,
        pages: check.getPageCount(),
        cleared,
        diff,
        strippedAll: false,
      });
      setFields(EMPTY);
      setOriginal(EMPTY);
      setNotice(
        stillThere.length
          ? `Removed the standard Info fields, but ${stillThere.join(", ")} may still be present in XMP metadata — run Sanitize PDF to strip XMP too.`
          : "Standard metadata cleared from the document dictionary.",
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Destructive path: every Info key plus the XMP packet, behind a confirmation. */
  const stripAll = async () => {
    if (!pdf.bytes || !pdf.file || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    setResult(null);
    try {
      const doc = await openPdfLib(pdf.bytes);
      const cleared = clearStandardMetadata(doc);
      const xmpRemoved = removeXmpMetadata(doc);
      const bytes = await doc.save();
      const check = await openPdfLib(bytes);
      const after = readMeta(check);
      const leftover = (Object.keys(EMPTY) as (keyof MetaFields)[]).filter((key) => after[key]);
      if (leftover.length) {
        throw new Error(`Some fields survived the strip (${leftover.map((key) => FIELD_NAMES[key]).join(", ")}). Nothing was offered for download.`);
      }
      setResult({
        bytes,
        name: `${sanitizeName(baseName(pdf.file.name))}-stripped.pdf`,
        pages: check.getPageCount(),
        cleared,
        diff: diffMetadata(original, after),
        strippedAll: true,
      });
      setFields(EMPTY);
      setOriginal(EMPTY);
      setXmp(hasXmpMetadata(check));
      setConfirmStrip(false);
      setNotice(
        `Stripped ${cleared.length} Info field${cleared.length === 1 ? "" : "s"}${xmpRemoved ? " and the XMP packet" : ""}. The page content is untouched.`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const downloadResult = () => {
    if (!result) return;
    downloadBytes(result.bytes, result.name);
  };

  usePrimaryShortcut(() => void save(), Boolean(pdf.bytes) && !busy);
  useDownloadShortcut(downloadResult, Boolean(result));

  const activeTemplate = TEMPLATES.find((template) => template.id === opts.value.template);

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF whose metadata you want to edit" />

      {pdf.bytes && (
        <>
          {loadingMeta && <Alert tone="info">Reading the document metadata…</Alert>}

          <div className="rounded-xl border border-forest/15 bg-lime/20 p-3.5 text-[11.5px] leading-relaxed text-forest">
            <p className="flex items-center gap-1.5 font-semibold">
              <FilePenLine className="h-4 w-4" /> Edit the document’s identity, not its content
            </p>
            <p className="mt-1 text-ink/70">
              Values here live in the PDF Info dictionary — the same fields viewers show in their properties panel. Editing them rewrites a few bytes
              inline; pages, text and images are never re-encoded.
            </p>
          </div>

          <div className="rounded-xl border border-line bg-paper p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">Metadata templates</p>
              {activeTemplate && <Badge tone="forest">{activeTemplate.label}</Badge>}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {TEMPLATES.map((template) => {
                const active = template.id === opts.value.template;
                return (
                  <button
                    key={template.id}
                    type="button"
                    title={template.description}
                    aria-pressed={active}
                    onClick={() => applyTemplate(template)}
                    className={
                      active
                        ? "rounded-full border border-forest bg-forest px-3 py-1.5 text-[11.5px] font-medium text-paper"
                        : "rounded-full border border-line bg-paper px-3 py-1.5 text-[11.5px] font-medium text-ink/70 transition-colors hover:border-forest/30 hover:text-forest"
                    }
                  >
                    {template.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted">
              A template fills subject, keywords and creator, and the title only when it is still empty. Author is never filled automatically because it is
              personal data. Everything stays editable before you save.
            </p>
          </div>

          {xmp && (
            <Alert tone="warning" title="This PDF also contains XMP metadata">
              XMP is a second metadata store used by Adobe tools and archival workflows. Info fields edited here do not guarantee the XMP copy is
              updated. Use <a href="#/tool/sanitize" className="font-semibold underline">Sanitize PDF</a> to remove XMP entirely, or turn on “Strip the XMP
              packet on save” below.
            </Alert>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            {FIELD_LABELS.map((entry) => (
              <Field key={entry.key} label={entry.label} hint={entry.hint} htmlFor={`meta-${entry.key}`}>
                <TextInput
                  id={`meta-${entry.key}`}
                  value={fields[entry.key]}
                  placeholder={entry.placeholder}
                  onChange={(event) => set(entry.key, event.target.value)}
                  maxLength={512}
                />
              </Field>
            ))}
            <Field label="Creation date" hint="Stored in UTC. Leave empty to keep the file’s existing value." htmlFor="meta-created">
              <div className="flex gap-2">
                <TextInput
                  id="meta-created"
                  type="date"
                  value={fields.creationDate}
                  onChange={(event) => set("creationDate", event.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => set("creationDate", toDateInput(new Date()))}
                  className="shrink-0"
                  aria-label="Set the creation date to today"
                >
                  Today
                </Button>
              </div>
            </Field>
            <Field label="Modification date" hint="Stored in UTC. Leave empty to keep the file’s existing value." htmlFor="meta-modified">
              <div className="flex gap-2">
                <TextInput
                  id="meta-modified"
                  type="date"
                  value={fields.modificationDate}
                  onChange={(event) => set("modificationDate", event.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => set("modificationDate", toDateInput(new Date()))}
                  className="shrink-0"
                  aria-label="Set the modification date to today"
                >
                  Today
                </Button>
              </div>
            </Field>
          </div>

          <AdvancedOptions scope="metadata" badge="2 controls" description="XMP packet and automatic timestamps" onReset={opts.reset}>
            <OptionsGrid>
              <div className="flex items-end">
                <Switch
                  checked={stripXmp}
                  onChange={(value) => opts.set("stripXmp", value)}
                  label="Strip the XMP packet on save"
                  description="Removes the second metadata store, which often still carries the original author and software."
                />
              </div>
              <div className="flex items-end">
                <Switch
                  checked={touchModified}
                  onChange={(value) => opts.set("touchModified", value)}
                  label="Set the modification date to now"
                  description="Useful after an edit. Off by default so untouched timestamps stay untouched."
                />
              </div>
            </OptionsGrid>
            <div className="mt-3">
              <OptionNote>
                These two switches are remembered on this device. Field values are never stored — they belong to the document, not to Paperly.
              </OptionNote>
            </div>
          </AdvancedOptions>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={save} loading={busy} disabled={!dirty && !result}>
              <FilePenLine className="h-4 w-4" /> Save metadata & download
            </Button>            <Button variant="outline" onClick={clearAll} loading={busy} disabled={busy}>
              <Trash2 className="h-4 w-4" /> Clear all standard metadata
            </Button>
            <Button variant="ghost" onClick={() => setConfirmStrip((value) => !value)} disabled={busy} aria-expanded={confirmStrip}>
              <Trash2 className="h-4 w-4" /> Strip all metadata…
            </Button>
            <span className="text-[11.5px] text-muted">
              {dirty ? "Unsaved changes" : "No unsaved changes"} · {formatBytes(pdf.file?.size ?? 0)}
            </span>
          </div>

          {confirmStrip && (
            <div className="rounded-xl border border-clay/25 bg-clay/[0.05] p-3.5" role="alertdialog" aria-label="Confirm stripping all metadata">
              <p className="text-[12.5px] font-semibold text-clay-ink">Remove every metadata field and the XMP packet?</p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-ink/70">
                This deletes the whole Info dictionary — title, author, subject, keywords, creator, producer and both timestamps — plus the XMP packet if the
                file has one. Page content is not touched. The saved copy is verified before download and cannot be undone from this tool.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button variant="danger" onClick={stripAll} loading={busy}>
                  <Trash2 className="h-4 w-4" /> Yes, strip everything
                </Button>
                <Button variant="ghost" onClick={() => setConfirmStrip(false)} disabled={busy}>
                  Keep metadata
                </Button>
              </div>
            </div>
          )}

          {notice && <Alert tone="success">{notice}</Alert>}
          {error && <Alert tone="error" title="Couldn’t update metadata">{error}</Alert>}

          {result && (
            <DownloadPanel
              filename={result.name}
              size={result.bytes.byteLength}
              pages={result.pages}
              onDownload={() => downloadBytes(result.bytes, result.name)}
              title="Metadata updated"
              description={
                result.cleared.length
                  ? `Cleared ${result.cleared.length} standard field${result.cleared.length === 1 ? "" : "s"} · ${result.pages} page${result.pages === 1 ? "" : "s"}`
                  : `Saved · ${result.pages} page${result.pages === 1 ? "" : "s"} · content untouched`
              }
              facts={[
                { label: "Changed", value: `${result.diff.length} key${result.diff.length === 1 ? "" : "s"}` },
                ...(result.strippedAll ? [{ label: "All metadata", value: "stripped" }] : []),
              ]}
              bytes={result.bytes}
              handoffIds={["sanitize", "protect", "inspect-pdf"]}
            />
          )}

          {result && result.diff.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-line bg-paper">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-bone-deep/40 px-3.5 py-2">
                <p className="text-[12px] font-semibold">Before / after</p>
                <span className="text-[10.5px] text-muted">
                  {result.diff.length} changed key{result.diff.length === 1 ? "" : "s"} · verified in the saved bytes
                </span>
              </div>
              <ul className="divide-y divide-line/70">
                {result.diff.map((change) => (
                  <li key={change.key} className="px-3.5 py-2">
                    <p className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink/60">{FIELD_NAMES[change.key]}</p>
                    <div className="mt-0.5 grid gap-0.5 sm:grid-cols-2">
                      <p className="break-words text-[11.5px] leading-relaxed text-ink/60">
                        <span className="mr-1 font-semibold text-clay-ink">before</span>
                        {change.before || "(empty)"}
                      </p>
                      <p className="break-words text-[11.5px] leading-relaxed text-ink/80">
                        <span className="mr-1 font-semibold text-forest">after</span>
                        {change.after || "(empty)"}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result && result.diff.length === 0 && (
            <Alert tone="info">The saved copy has the same visible metadata values as before — only the file was re-written.</Alert>
          )}

          <div className="rounded-xl border border-line bg-paper p-3.5 text-[11.5px] leading-relaxed text-muted">
            <p className="flex items-center gap-1.5 font-semibold text-ink/70">
              <Info className="h-3.5 w-3.5" /> What metadata can reveal
            </p>
            <p className="mt-1">
              Author names, software versions, original file paths and timestamps frequently travel inside PDFs. If you are publishing a document,
              review these fields and consider clearing them or running Sanitize PDF before sharing.
            </p>
            <p className="mt-1">{xmp ? "This file carries an XMP packet, which can survive an Info-dictionary edit — strip it above if you need it gone." : "No XMP packet was found in this file."}</p>
            <p className="mt-1 flex items-center gap-1.5 text-forest">
              <ShieldCheck className="h-3.5 w-3.5" /> Reading and rewriting happen in this tab. Nothing is uploaded.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
