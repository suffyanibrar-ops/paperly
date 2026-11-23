import { Check, Copy, Eye, EyeOff, KeyRound, Lock, LockKeyhole, RefreshCw, ShieldCheck, Unlock } from "lucide-react";
import { PDFDict, PDFInvalidObject, PDFName, PDFStream, type PDFRef } from "@cantoo/pdf-lib";
import { useEffect, useState } from "react";
import { PDFDocument, baseName, formatBytes, openPdfLib, readFileBytes, sanitizeName } from "@/lib/pdf";
import { useInitialFiles, usePdfFile } from "@/lib/usePdf";
import { Alert, Button, Field, FileDrop, FileRow, Progress, Segmented, inputClass } from "@/components/ui";
import { DownloadPanel, SinglePdfInput } from "@/components/toolParts";
import { AdvancedOptions, OptionNote, OptionsGrid } from "@/components/AdvancedOptions";
import { useToolPreferences } from "@/lib/prefs";
import { useDownloadShortcut, usePrimaryShortcut } from "@/lib/hotkeys";
import { downloadOutput } from "@/lib/output";
import { cn } from "@/utils/cn";

/* ================================================================== *
 * PROTECT
 * ================================================================== */
const PASSPHRASE_WORDS = [
  "amber", "basalt", "cedar", "delta", "ember", "fjord", "garnet", "harbor", "indigo", "jungle",
  "kestrel", "lantern", "meadow", "nimbus", "onyx", "prairie", "quartz", "raven", "silver", "tundra",
  "umber", "violet", "willow", "xenon", "yarrow", "zephyr", "cobalt", "dune", "flint", "grove",
];

/** Cryptographically-random passphrase: 4 words + digits + symbol (~60 bits). */
export function generatePassphrase(): string {
  const random = (max: number) => {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return buffer[0] % max;
  };
  const words = Array.from({ length: 4 }, () => PASSPHRASE_WORDS[random(PASSPHRASE_WORDS.length)]);
  const symbol = "!@#$%&*?+"[random(9)];
  return `${words.join("-")}-${random(90) + 10}${symbol}`;
}

function passwordScore(pw: string) {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  return score;
}

type ProtectPreferences = {
  allowPrinting: boolean;
  allowCopying: boolean;
  allowModifying: boolean;
  allowAnnotating: boolean;
  allowFillingForms: boolean;
  allowAccessibility: boolean;
};

const PERMISSIONS: { key: keyof ProtectPreferences; label: string; hint: string }[] = [
  { key: "allowPrinting", label: "Printing", hint: "High-resolution printing is allowed." },
  { key: "allowCopying", label: "Copying text", hint: "Text and graphics can be copied or extracted." },
  { key: "allowModifying", label: "Editing", hint: "Pages and content can be changed." },
  { key: "allowAnnotating", label: "Commenting", hint: "Notes, highlights and markup can be added." },
  { key: "allowFillingForms", label: "Form filling", hint: "Existing form fields can be filled in." },
  { key: "allowAccessibility", label: "Accessibility", hint: "Screen readers may extract content." },
];

function permissionSummary(value: ProtectPreferences): string {
  const allowed = PERMISSIONS.filter((permission) => value[permission.key]).map((permission) => permission.label.toLowerCase());
  const blocked = PERMISSIONS.filter((permission) => !value[permission.key]).map((permission) => permission.label.toLowerCase());
  if (!blocked.length) return "Every reader permission is allowed";
  if (!allowed.length) return "No reader permission is allowed";
  return `${allowed.join(", ")} allowed · ${blocked.join(", ")} blocked`;
}

export function ProtectTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const opts = useToolPreferences("protect", {
    allowPrinting: true,
    allowCopying: false,
    allowModifying: false,
    allowAnnotating: false,
    allowFillingForms: false,
    allowAccessibility: true,
  });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [showOwner, setShowOwner] = useState(false);
  const [copiedPassword, setCopiedPassword] = useState(false);
  const [ownerPassword, setOwnerPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; pages: number; summary: string } | null>(null);

  const score = passwordScore(password);
  const strength = score <= 1 ? "Weak" : score <= 3 ? "Fair" : score === 4 ? "Strong" : "Excellent";
  const ready = Boolean(pdf.bytes) && password.length >= 4 && password === confirm && !busy;

  const protect = async () => {
    const source = pdf.bytes;
    const current = pdf.file;
    if (!source || !current || busy) return;
    setError("");
    setResult(null);
    if (password.length < 4) {
      setError("Use at least 4 characters. A passphrase of 12+ characters is much safer.");
      return;
    }
    if (password !== confirm) {
      setError("The two passwords don’t match.");
      return;
    }
    if (ownerPassword && ownerPassword.length < 4) {
      setError("The owner password needs at least 4 characters, or leave it empty to reuse the document password.");
      return;
    }
    setBusy(true);
    let doc: PDFDocument;
    try {
      doc = await openPdfLib(source);
    } catch (err) {
      setBusy(false);
      const message = (err as Error).message;
      setError(
        /encrypt|password/i.test(message)
          ? "This PDF is already protected. Unlock it first, then add your new password."
          : message,
      );
      return;
    }
    try {
      const pages = doc.getPageCount();
      const permissions = {
        printing: opts.value.allowPrinting ? ("highResolution" as const) : false,
        copying: opts.value.allowCopying,
        modifying: opts.value.allowModifying,
        annotating: opts.value.allowAnnotating,
        fillingForms: opts.value.allowFillingForms,
        documentAssembly: opts.value.allowModifying,
        contentAccessibility: opts.value.allowAccessibility,
      };
      doc.encrypt({
        userPassword: password,
        ownerPassword: ownerPassword || password,
        permissions,
        algorithm: "AES-256",
      });
      const bytes = await doc.save();
      // Verify both directions: the file must refuse to open without the
      // password, and must open with it while keeping every page.
      let blocked = false;
      try {
        await PDFDocument.load(bytes);
      } catch {
        blocked = true;
      }
      if (!blocked) throw new Error("The encrypted copy still opened without a password, so we didn’t return it. Please try again.");
      const opened = await PDFDocument.load(bytes, { password });
      if (opened.getPageCount() !== pages) {
        throw new Error("The protected copy didn’t keep all of its pages. Please try again with a copy of the original file.");
      }
      setResult({
        bytes,
        name: `${sanitizeName(baseName(current.name))}-protected.pdf`,
        pages,
        summary: permissionSummary(opts.value),
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  usePrimaryShortcut(() => void protect(), ready);
  useDownloadShortcut(
    () => {
      if (result) downloadOutput(result.bytes, result.name, "application/pdf");
    },
    Boolean(result),
  );

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to protect" />
      {pdf.bytes && (
        <>
          <div className="rounded-xl border border-lilac-ink/15 bg-lilac/40 p-3.5">
            <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-lilac-ink">
              <ShieldCheck className="h-4 w-4" /> AES-256 encryption, entirely in your browser
            </p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-lilac-ink/75">
              Your password is used locally to encrypt the file. It’s never transmitted, logged or stored. Keep it safe — there is no recovery.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Password" hint="At least 4 characters. 12+ is much safer.">
              <div className="relative">
                <input
                  type={show ? "text" : "password"}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setResult(null);
                  }}
                  className={cn(inputClass, "pr-10")}
                  placeholder="Your document password"
                  autoComplete="new-password"
                  aria-label="Document password"
                />
                <button
                  type="button"
                  onClick={() => setShow(!show)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1.5 text-ink/75 hover:text-ink"
                  aria-label={show ? "Hide password" : "Show password"}
                >
                  {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </Field>
            <Field label="Confirm password" hint={confirm && confirm !== password ? "The two passwords don’t match yet." : undefined}>
              <input
                type={show ? "text" : "password"}
                value={confirm}
                onChange={(e) => {
                  setConfirm(e.target.value);
                  setResult(null);
                }}
                className={cn(inputClass, confirm && confirm !== password && "border-clay/60 focus:border-clay")}
                placeholder="Repeat the password"
                autoComplete="new-password"
                aria-label="Confirm document password"
                aria-invalid={Boolean(confirm) && confirm !== password}
              />
            </Field>
          </div>

          {password && (
            <div>
              <div className="flex gap-1">
                {[0, 1, 2, 3, 4].map((i) => (
                  <span
                    key={i}
                    className={cn(
                      "h-1.5 flex-1 rounded-full transition-colors",
                      i < score ? (score <= 2 ? "bg-clay" : score <= 3 ? "bg-amber-400" : "bg-forest") : "bg-line",
                    )}
                  />
                ))}
              </div>
              <p className="mt-1 text-[11px] text-muted" aria-live="polite">
                {strength} · {password.length} characters{confirm && password !== confirm ? " · passwords don’t match" : ""}
                {password.length < 8 ? " · add length rather than symbols for the biggest gain" : ""}
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => {
                const generated = generatePassphrase();
                setPassword(generated);
                setConfirm(generated);
                setShow(true);
                setResult(null);
                setCopiedPassword(false);
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" /> Generate strong password
            </Button>
            {password && (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(password);
                    setCopiedPassword(true);
                  } catch {
                    /* clipboard unavailable */
                  }
                }}
              >
                {copiedPassword ? <Check className="h-3.5 w-3.5 text-forest" /> : <Copy className="h-3.5 w-3.5" />}
                {copiedPassword ? "Copied" : "Copy password"}
              </Button>
            )}
            <span className="text-[11px] text-muted">Generated locally with the Web Crypto API. Store it in your password manager.</span>
          </div>

          <AdvancedOptions
            scope="protect"
            badge="6 permissions"
            description="Owner password and what readers may do"
            onReset={opts.reset}
          >
            <div className="space-y-4">
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/55">Permissions for readers</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  {PERMISSIONS.map((permission) => {
                    const allowed = opts.value[permission.key];
                    return (
                      <button
                        key={permission.key}
                        type="button"
                        title={permission.hint}
                        onClick={() => {
                          opts.set(permission.key, !allowed);
                          setResult(null);
                        }}
                        aria-pressed={allowed}
                        className={cn(
                          "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-[12px] font-medium transition-colors",
                          allowed ? "border-forest/25 bg-lime/25 text-forest" : "border-line bg-paper text-ink/70",
                        )}
                      >
                        <span
                          className={cn(
                            "flex h-4 w-4 items-center justify-center rounded border",
                            allowed ? "border-forest bg-forest text-lime" : "border-ink/25",
                          )}
                        >
                          {allowed && <Check className="h-3 w-3" />}
                        </span>
                        {permission.label}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-[10.5px] leading-relaxed text-muted">
                  Permissions are enforced by PDF readers, not by the file itself — a determined attacker with the owner password can ignore
                  them. The password is the real protection.
                </p>
              </div>

              <OptionsGrid>
                <Field
                  label="Owner password (optional)"
                  hint="Lets you reopen the file to change permissions later. Leave empty to reuse the document password."
                >
                  <div className="relative">
                    <input
                      type={showOwner ? "text" : "password"}
                      value={ownerPassword}
                      onChange={(e) => {
                        setOwnerPassword(e.target.value);
                        setResult(null);
                      }}
                      className={cn(inputClass, "pr-10")}
                      placeholder="Optional owner password"
                      autoComplete="new-password"
                      aria-label="Owner password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowOwner(!showOwner)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1.5 text-ink/75 hover:text-ink"
                      aria-label={showOwner ? "Hide owner password" : "Show owner password"}
                    >
                      {showOwner ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </Field>
              </OptionsGrid>

              <OptionNote>
                Current reader permissions: {permissionSummary(opts.value)}.
              </OptionNote>
            </div>
          </AdvancedOptions>

          {error && <Alert tone="error">{error}</Alert>}

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={() => void protect()} loading={busy} disabled={!password || password !== confirm}>
              <LockKeyhole className="h-4 w-4" /> Protect PDF
            </Button>
            <span className="flex items-center gap-1 text-[11.5px] text-muted">
              <Lock className="h-3.5 w-3.5" /> Encrypted on this device
            </span>
          </div>
          {busy && <Progress label="Encrypting with AES-256 in your browser…" />}
        </>
      )}

      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="PDF protected"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          mime="application/pdf"
          onDownload={() => downloadOutput(result.bytes, result.name, "application/pdf")}
          description="AES-256 encryption · verified that a password is required and that it still opens with it · there is no recovery if you lose it"
          facts={[
            { label: "Encryption", value: "AES-256" },
            { label: "Permissions", value: result.summary },
          ]}
          extra={
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-lime">
              <ShieldCheck className="h-3.5 w-3.5" /> {formatBytes(result.bytes.byteLength)} · no server copy exists
            </div>
          }
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * UNLOCK
 * ================================================================== */
type UnlockMode = "all" | "restrictions";

type ProbeStatus = "checking" | "plain" | "restricted" | "password" | "unreadable";

interface ProtectionProbe {
  status: ProbeStatus;
  hasEncryption: boolean;
  pages: number;
}

/** A real trailer entry (/Encrypt 12 0 R), not just the word in a stream. */
const ENCRYPT_ENTRY = /\/Encrypt\s+(\d+\s+\d+\s+R|<<)/;

function hasEncryptEntry(bytes: Uint8Array): boolean {
  return ENCRYPT_ENTRY.test(new TextDecoder("latin1").decode(bytes));
}

/**
 * A decrypted document still carries the objects that *described* its
 * encryption: the security dictionary, the object stream it lived in and the
 * original trailer bytes the parser could not interpret. Re-serialising those
 * would emit "/Encrypt" again, so they are dropped before the clean copy is
 * written. Pages, forms, links, bookmarks and metadata are untouched.
 */
function dropStaleSecurityObjects(doc: PDFDocument): void {
  const { context } = doc;
  const doomed: PDFRef[] = [];
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (object instanceof PDFInvalidObject) {
      doomed.push(ref);
      continue;
    }
    const dict = object instanceof PDFStream ? object.dict : object instanceof PDFDict ? object : null;
    if (!dict) continue;
    const type = dict.lookup(PDFName.of("Type"));
    const typeName = type instanceof PDFName ? type.asString() : "";
    if (typeName === "/XRef" || typeName === "/ObjStm") {
      doomed.push(ref);
      continue;
    }
    // The security dictionary: /Filter /Standard, /O, /U, /R, /P.
    if (dict.has(PDFName.of("O")) && dict.has(PDFName.of("U")) && dict.has(PDFName.of("R")) && dict.has(PDFName.of("Filter"))) {
      doomed.push(ref);
    }
  }
  for (const ref of doomed) context.delete(ref);
  delete context.trailerInfo.Encrypt;
}

/** True when the bytes still require a password (or can’t be read at all). */
async function stillEncrypted(bytes: Uint8Array): Promise<boolean> {
  if (hasEncryptEntry(bytes)) return true;
  try {
    const check = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return check.isEncrypted;
  } catch {
    return true;
  }
}

/** Last resort: rebuild an unencrypted copy page by page. */
async function rebuildUnprotectedCopy(doc: PDFDocument): Promise<Uint8Array> {
  const fresh = await PDFDocument.create();
  const copies = await fresh.copyPages(doc, doc.getPageIndices());
  copies.forEach((page) => fresh.addPage(page));
  const title = doc.getTitle();
  const author = doc.getAuthor();
  const subject = doc.getSubject();
  if (title) fresh.setTitle(title);
  if (author) fresh.setAuthor(author);
  if (subject) fresh.setSubject(subject);
  return fresh.save({ useObjectStreams: true });
}

/**
 * Work out what kind of protection a file carries without ever uploading it:
 *   plain      — no encryption at all
 *   restricted — encrypted, but it opens with an empty user password
 *   password   — a user password is required to open it
 *   unreadable — the bytes aren’t a readable PDF
 */
async function detectProtection(bytes: ArrayBuffer): Promise<ProtectionProbe> {
  const header = new TextDecoder("latin1").decode(new Uint8Array(bytes).slice(0, 1024));
  let hasEncryption = hasEncryptEntry(new Uint8Array(bytes));
  let knownPages = 0;
  try {
    // With encryption ignored the parser still tells us the page count of most
    // protected files, which keeps the confirmation copy specific.
    const loose = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    if (loose.isEncrypted) hasEncryption = true;
    try {
      knownPages = loose.getPageCount();
    } catch {
      knownPages = 0;
    }
  } catch {
    /* ignore: the empty-password attempt below is authoritative */
  }
  try {
    // Authoritative: a file that opens with an empty user password is only
    // restricted by its owner permissions.
    const opened = await PDFDocument.load(bytes, { password: "", updateMetadata: false });
    return { status: hasEncryption ? "restricted" : "plain", hasEncryption, pages: opened.getPageCount() || knownPages };
  } catch {
    // A real PDF that won’t open is either password-protected or damaged — ask
    // for the password, and let the error path point at Repair PDF.
    return {
      status: header.includes("%PDF-") || knownPages > 0 ? "password" : "unreadable",
      hasEncryption,
      pages: knownPages,
    };
  }
}

interface UnlockResult {
  bytes: Uint8Array;
  name: string;
  pages: number;
  hadUserPassword: boolean;
  keptPassword: boolean;
}

export function UnlockTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const opts = useToolPreferences("unlock", { mode: "all" as UnlockMode });
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [probe, setProbe] = useState<ProtectionProbe>({ status: "checking", hasEncryption: false, pages: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<UnlockResult | null>(null);

  useEffect(() => {
    const current = pdf.file;
    setProbe({ status: "checking", hasEncryption: false, pages: 0 });
    setResult(null);
    setError("");
    setPassword("");
    if (!current) return;
    let alive = true;
    (async () => {
      const bytes = await readFileBytes(current);
      const detected = await detectProtection(bytes);
      if (alive) setProbe(detected);
    })().catch(() => {
      if (alive) setProbe({ status: "unreadable", hasEncryption: false, pages: 0 });
    });
    return () => {
      alive = false;
    };
  }, [pdf.file]);

  const needsPassword = probe.status === "password";
  const ready = Boolean(pdf.file) && !busy && (!needsPassword || password.length > 0);

  const unlock = async () => {
    const current = pdf.file;
    if (!current || busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const bytes = await readFileBytes(current);
      const attempt = password ? password : "";
      let doc: PDFDocument;
      try {
        doc = await openPdfLib(bytes, attempt);
      } catch {
        throw new Error(
          attempt
            ? "That password didn’t work. Check caps lock and try the owner password if you have it."
            : "This PDF needs a password before it will open. Enter it above, or try Repair PDF if you believe it has no password.",
        );
      }
      const pages = doc.getPageCount();
      // Report the truth: does the file open with an empty password?
      let hadUserPassword = needsPassword;
      if (!hadUserPassword) {
        try {
          await PDFDocument.load(bytes, { password: "", updateMetadata: false });
        } catch {
          hadUserPassword = true;
        }
      }

      // Remove every object that still describes the old encryption, so the
      // rewritten file is genuinely unprotected.
      dropStaleSecurityObjects(doc);

      if (opts.value.mode === "restrictions" && hadUserPassword) {
        // Keep the reader password, drop every restriction: re-encrypt the same
        // document with its user password and a full permission set.
        doc.encrypt({
          userPassword: attempt,
          ownerPassword: attempt,
          algorithm: "AES-256",
          permissions: {
            printing: "highResolution",
            copying: true,
            modifying: true,
            annotating: true,
            fillingForms: true,
            documentAssembly: true,
            contentAccessibility: true,
          },
        });
        const kept = await doc.save({ useObjectStreams: true });
        let keptPages = 0;
        try {
          const check = await PDFDocument.load(kept, { password: attempt });
          keptPages = check.getPageCount();
        } catch {
          keptPages = 0;
        }
        if (keptPages !== pages) {
          throw new Error("The rebuilt copy couldn’t be verified, so we didn’t return it. Please try again.");
        }
        setResult({
          bytes: kept,
          name: `${sanitizeName(baseName(current.name))}-unrestricted.pdf`,
          pages,
          hadUserPassword,
          keptPassword: true,
        });
        return;
      }

      // Write the decrypted document as-is first: content, forms, links,
      // bookmarks and metadata all survive untouched.
      const decrypted = await doc.save({ useObjectStreams: true });
      const out = (await stillEncrypted(decrypted)) ? await rebuildUnprotectedCopy(doc) : decrypted;
      if (hasEncryptEntry(out)) {
        throw new Error(
          "The unlocked copy still contains an encryption dictionary, so we didn’t return it. Try Repair PDF, or another copy of the document.",
        );
      }
      let verified = false;
      try {
        const check = await PDFDocument.load(out, { updateMetadata: false });
        verified = !check.isEncrypted && check.getPageCount() === pages;
      } catch {
        verified = false;
      }
      if (!verified) {
        throw new Error("The unlocked file could not be verified. It may use an unsupported encryption type.");
      }
      setResult({
        bytes: out,
        name: `${sanitizeName(baseName(current.name))}-unlocked.pdf`,
        pages,
        hadUserPassword,
        keptPassword: false,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  usePrimaryShortcut(() => void unlock(), ready);
  useDownloadShortcut(
    () => {
      if (result) downloadOutput(result.bytes, result.name, "application/pdf");
    },
    Boolean(result),
  );

  const resultCopy = result
    ? result.keptPassword
      ? "Owner restrictions removed · the reader password was kept because you asked for “Restrictions only”"
      : result.hadUserPassword
        ? "User password and owner restrictions removed · content untouched"
        : "Owner restrictions removed · the file never had a user password"
    : "";

  return (
    <div className="space-y-5">
      {!pdf.file ? (
        <FileDrop
          accept="application/pdf,.pdf"
          acceptLabel="A protected PDF"
          onFiles={(f) => pdf.setFile(f[0])}
          hint="Password-protected and restriction-only files are both fine."
        />
      ) : (
        <FileRow
          file={pdf.file}
          onRemove={pdf.clear}
          size={
            probe.status === "checking"
              ? "Checking protection…"
              : probe.pages
                ? `${probe.pages} page${probe.pages === 1 ? "" : "s"} · ${formatBytes(pdf.file.size)}`
                : formatBytes(pdf.file.size)
          }
        />
      )}

      {pdf.file && (
        <>
          {probe.status === "checking" && (
            <Alert tone="info" title="Checking your file…">
              Reading the document’s security dictionary locally.
            </Alert>
          )}

          {probe.status === "password" && (
            <Field label="Document password" hint="Checked locally against the file. Never stored or uploaded.">
              <div className="relative">
                <input
                  type={show ? "text" : "password"}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError("");
                  }}
                  className={cn(inputClass, "pr-10")}
                  placeholder="Enter the password"
                  autoComplete="off"
                  autoFocus
                  aria-label="Document password"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && password) void unlock();
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShow(!show)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1.5 text-ink/75 hover:text-ink"
                  aria-label={show ? "Hide password" : "Show password"}
                >
                  {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </Field>
          )}

          {probe.status === "restricted" && (
            <Alert tone="info" title="No password needed">
              This PDF opens without a password but carries owner restrictions. Unlock it to rebuild an identical, unrestricted copy.
            </Alert>
          )}

          {probe.status === "plain" && (
            <Alert tone="info" title="No password required">
              This file opens without a password and has no encryption. You can still rebuild a clean, unrestricted copy.
            </Alert>
          )}

          {probe.status === "unreadable" && (
            <Alert tone="error" title="This file won’t open">
              It doesn’t look like a readable PDF, so there is nothing to decrypt.{" "}
              <a href="/repair" className="font-semibold underline">
                Open Repair PDF
              </a>{" "}
              to try a structural rebuild.
            </Alert>
          )}

          {probe.status !== "unreadable" && (
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/55">What to remove</p>
              <Segmented
                value={opts.value.mode}
                onChange={(mode) => {
                  opts.set("mode", mode);
                  setResult(null);
                }}
                options={[
                  { value: "all", label: "Remove all protection", hint: "Password and every restriction" },
                  { value: "restrictions", label: "Restrictions only", hint: "Keeps a reader password, drops the limits" },
                ]}
              />
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                {needsPassword
                  ? "This file asks for a password before it will open. “Remove all protection” drops that password; “Restrictions only” keeps it and removes the printing/copying limits instead."
                  : "No password is needed to open this file, so both modes produce an unrestricted copy. “Restrictions only” exists for files that keep a reader password."}
              </p>
            </div>
          )}

          <div className="rounded-xl border border-line bg-bone-deep/30 p-3.5 text-[11.5px] leading-relaxed text-ink/70">
            <p className="flex items-center gap-1.5 font-semibold text-forest">
              <KeyRound className="h-3.5 w-3.5" /> Good to know
            </p>
            <p className="mt-1">
              Paperly decrypts the real document structure, so text stays selectable and quality is untouched. You need the correct password; we
              can’t bypass encryption. Only unlock documents you have permission to access.
            </p>
          </div>

          {error && <Alert tone="error">{error}</Alert>}

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={() => void unlock()} loading={busy} disabled={probe.status === "unreadable" || (needsPassword && !password)}>
              <Unlock className="h-4 w-4" /> Unlock PDF
            </Button>
            {(!needsPassword || password) && (
              <span className="text-[11.5px] text-muted">
                {opts.value.mode === "restrictions" && needsPassword
                  ? "Rebuilds the file with the same password and no restrictions."
                  : "Rebuilds an unrestricted copy without changing content."}
              </span>
            )}
          </div>
          {busy && <Progress label="Decrypting in your browser…" />}
        </>
      )}

      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="PDF unlocked"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          mime="application/pdf"
          onDownload={() => downloadOutput(result.bytes, result.name, "application/pdf")}
          description={`${resultCopy} · content untouched · store the unlocked copy somewhere safe`}
          facts={[
            { label: "User password", value: result.hadUserPassword ? (result.keptPassword ? "kept" : "removed") : "none found" },
            { label: "Restrictions", value: "removed" },
            { label: "Encryption", value: result.keptPassword ? "AES-256 (kept)" : "none left" },
          ]}
        />
      )}
    </div>
  );
}
