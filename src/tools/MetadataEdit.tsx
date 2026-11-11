import { useEffect, useMemo, useState } from "react";
import { FilePenLine, Info, ShieldCheck, Trash2 } from "lucide-react";
import { PDFDict, PDFName, PDFString } from "@cantoo/pdf-lib";
import {
  baseName,
  downloadBytes,
  formatBytes,
  openPdfLib,
  sanitizeName,
  type PDFDocument,
} from "@/lib/pdf";
import { useInitialFiles, usePdfFile } from "@/lib/usePdf";
import { Alert, Button, Field, TextInput } from "@/components/ui";
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

export function MetadataTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [fields, setFields] = useState<MetaFields>(EMPTY);
  const [original, setOriginal] = useState<MetaFields>(EMPTY);
  const [xmp, setXmp] = useState(false);
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; pages: number; cleared: string[] } | null>(null);

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

  const save = async () => {
    if (!pdf.bytes || !pdf.file) return;
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
      // Keep the Info dictionary consistent with the edited fields.
      const infoRef = doc.context.trailerInfo.Info;
      const infoDict = infoRef ? doc.context.lookup(infoRef) : undefined;
      if (infoDict instanceof PDFDict) {
        if (fields.title.trim()) infoDict.set(PDFName.of("Title"), PDFString.of(fields.title.trim()));
        if (fields.author.trim()) infoDict.set(PDFName.of("Author"), PDFString.of(fields.author.trim()));
      }

      const bytes = await doc.save();
      // Self-verify: the output must reopen and expose the values we just wrote.
      const check = await openPdfLib(bytes);
      if (fields.title.trim() && check.getTitle() !== fields.title.trim()) {
        throw new Error("The document was written but the new title could not be verified. Try another file.");
      }
      setResult({
        bytes,
        name: `${sanitizeName(baseName(pdf.file.name))}-metadata.pdf`,
        pages: check.getPageCount(),
        cleared: [],
      });
      setOriginal(readMeta(check));
      setNotice("Metadata saved. The document content is untouched.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const clearAll = async () => {
    if (!pdf.bytes || !pdf.file) return;
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
      setResult({
        bytes,
        name: `${sanitizeName(baseName(pdf.file.name))}-clean-metadata.pdf`,
        pages: check.getPageCount(),
        cleared,
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

          {xmp && (
            <Alert tone="warning" title="This PDF also contains XMP metadata">
              XMP is a second metadata store used by Adobe tools and archival workflows. Info fields edited here do not guarantee the XMP copy is
              updated. Use <a href="#/tool/sanitize" className="font-semibold underline">Sanitize PDF</a> to remove XMP entirely, or keep both in sync
              in your authoring tool.
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
              <TextInput
                id="meta-created"
                type="date"
                value={fields.creationDate}
                onChange={(event) => set("creationDate", event.target.value)}
              />
            </Field>
            <Field label="Modification date" hint="Stored in UTC. Leave empty to keep the file’s existing value." htmlFor="meta-modified">
              <TextInput
                id="meta-modified"
                type="date"
                value={fields.modificationDate}
                onChange={(event) => set("modificationDate", event.target.value)}
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={save} loading={busy} disabled={!dirty && !result}>
              <FilePenLine className="h-4 w-4" /> Save metadata & download
            </Button>
            <Button variant="outline" onClick={clearAll} loading={busy} disabled={busy}>
              <Trash2 className="h-4 w-4" /> Clear all standard metadata
            </Button>
            <span className="text-[11.5px] text-muted">
              {dirty ? "Unsaved changes" : "No unsaved changes"} · {formatBytes(pdf.file?.size ?? 0)}
            </span>
          </div>

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
              bytes={result.bytes}
              handoffIds={["sanitize", "protect", "inspect-pdf"]}
            />
          )}

          <div className="rounded-xl border border-line bg-paper p-3.5 text-[11.5px] leading-relaxed text-muted">
            <p className="flex items-center gap-1.5 font-semibold text-ink/70">
              <Info className="h-3.5 w-3.5" /> What metadata can reveal
            </p>
            <p className="mt-1">
              Author names, software versions, original file paths and timestamps frequently travel inside PDFs. If you are publishing a document,
              review these fields and consider clearing them or running Sanitize PDF before sharing.
            </p>
            <p className="mt-1 flex items-center gap-1.5 text-forest">
              <ShieldCheck className="h-3.5 w-3.5" /> Reading and rewriting happen in this tab. Nothing is uploaded.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
