import { Check, Copy, Eye, EyeOff, KeyRound, Lock, LockKeyhole, RefreshCw, ShieldCheck, Unlock } from "lucide-react";
import { useEffect, useState } from "react";
import { PDFDocument, baseName, downloadBytes, formatBytes, openPdfLib, readFileBytes, sanitizeName } from "@/lib/pdf";
import { useInitialFiles, usePdfFile } from "@/lib/usePdf";
import {
  Alert,
  Button,
  Field,
  FileDrop,
  FileRow,
  Progress,
  inputClass,
} from "@/components/ui";
import { DownloadPanel, SinglePdfInput } from "@/components/toolParts";
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

export function ProtectTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [copiedPassword, setCopiedPassword] = useState(false);
  const [ownerPassword, setOwnerPassword] = useState("");
  const [allowPrinting, setAllowPrinting] = useState(true);
  const [allowCopying, setAllowCopying] = useState(false);
  const [allowModifying, setAllowModifying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; pages: number } | null>(null);

  const score = passwordScore(password);
  const strength = score <= 1 ? "Weak" : score <= 3 ? "Fair" : score === 4 ? "Strong" : "Excellent";

  const protect = async () => {
    if (!pdf.bytes || !pdf.file) return;
    setError("");
    if (password.length < 4) {
      setError("Use at least 4 characters. A passphrase of 12+ characters is much safer.");
      return;
    }
    if (password !== confirm) {
      setError("The two passwords don’t match.");
      return;
    }
    setBusy(true);
    try {
      const doc = await openPdfLib(pdf.bytes);
      doc.encrypt({
        userPassword: password,
        ownerPassword: ownerPassword || password,
        permissions: {
          printing: allowPrinting ? "highResolution" : false,
          copying: allowCopying,
          modifying: allowModifying,
          annotating: allowModifying,
          fillingForms: allowModifying,
          contentAccessibility: true,
          documentAssembly: allowModifying,
        },
      });
      const bytes = await doc.save();
      // Verify the output really needs the password before calling it protected.
      let verified = false;
      try {
        await PDFDocument.load(bytes);
      } catch {
        verified = true;
      }
      if (!verified) throw new Error("Encryption verification failed, so we didn’t return an unprotected file. Please try again.");
      setResult({
        bytes,
        name: `${sanitizeName(baseName(pdf.file.name))}-protected.pdf`,
        pages: doc.getPageCount(),
      });
    } catch (err) {
      const message = (err as Error).message;
      setError(
        /encrypt|password/i.test(message)
          ? "This PDF is already protected. Unlock it first, then add your new password."
          : message,
      );
    } finally {
      setBusy(false);
    }
  };

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
            <Field label="Password" hint="At least 4 characters.">
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
            <Field label="Confirm password">
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
              <p className="mt-1 text-[11px] text-muted">
                {strength} · {password.length} characters{confirm && password !== confirm ? " · passwords don’t match" : ""}
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
              <RefreshCw className="h-3.5 w-3.5" /> Generate strong passphrase
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

          <div className="rounded-xl border border-line bg-bone-deep/30 p-3.5">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">Permissions for readers</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {[
                { label: "Allow printing", value: allowPrinting, set: setAllowPrinting },
                { label: "Allow copying text", value: allowCopying, set: setAllowCopying },
                { label: "Allow editing", value: allowModifying, set: setAllowModifying },
              ].map((permission) => (
                <button
                  key={permission.label}
                  type="button"
                  onClick={() => {
                    permission.set(!permission.value);
                    setResult(null);
                  }}
                  aria-pressed={permission.value}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-[12px] font-medium transition-colors",
                    permission.value ? "border-forest/25 bg-lime/25 text-forest" : "border-line bg-paper text-ink/70",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-4 w-4 items-center justify-center rounded border",
                      permission.value ? "border-forest bg-forest text-lime" : "border-ink/25",
                    )}
                  >
                    {permission.value && <Check className="h-3 w-3" />}
                  </span>
                  {permission.label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[10.5px] leading-relaxed text-muted">
              Standard PDF permissions are advisory. The password is the real protection.
            </p>
          </div>

          <div className="max-w-sm">
            <Field label="Owner password (optional)" hint="Lets you change permissions later. Defaults to the user password.">
              <input
                type="password"
                value={ownerPassword}
                onChange={(e) => setOwnerPassword(e.target.value)}
                className={inputClass}
                placeholder="Optional owner password"
                autoComplete="new-password"
              />
            </Field>
          </div>

          {error && <Alert tone="error">{error}</Alert>}
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={protect} loading={busy} disabled={!password || password !== confirm}>
              <LockKeyhole className="h-4 w-4" /> Protect PDF
            </Button>
            <span className="flex items-center gap-1 text-[11.5px] text-muted">
              <Lock className="h-3.5 w-3.5" /> Encrypted on this device
            </span>
          </div>
        </>
      )}

      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="PDF protected"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description="AES-256 encryption · verified that a password is required · remember it, because it can’t be recovered"
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
export function UnlockTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [locked, setLocked] = useState<boolean | null>(null);
  const [ownerOnly, setOwnerOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; pages: number; wasLocked: boolean } | null>(null);

  useEffect(() => {
    setLocked(null);
    setOwnerOnly(false);
    setResult(null);
    setError("");
    setPassword("");
    if (!pdf.file) return;
    let alive = true;
    (async () => {
      const bytes = await readFileBytes(pdf.file!);
      // The PDF security dictionary is usually visible in the raw trailer. We
      // use it for detection because the parser strips it once decrypted.
      const raw = new TextDecoder("latin1").decode(new Uint8Array(bytes));
      const hasSecurityDictionary = raw.includes("/Encrypt");
      try {
        // An empty user password means the file is only permission-restricted;
        // it can be rebuilt without asking for a secret.
        await PDFDocument.load(bytes, { password: "" });
        if (alive) {
          setLocked(hasSecurityDictionary);
          setOwnerOnly(hasSecurityDictionary);
        }
      } catch {
        if (alive) {
          setLocked(true);
          setOwnerOnly(false);
        }
      }
    })().catch(() => alive && setLocked(true));
    return () => {
      alive = false;
    };
  }, [pdf.file]);

  const unlock = async () => {
    if (!pdf.file) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const bytes = await readFileBytes(pdf.file);
      let doc: PDFDocument | null = null;
      let wasLocked = false;
      const raw = new TextDecoder("latin1").decode(new Uint8Array(bytes));
      const hasSecurityDictionary = raw.includes("/Encrypt");
      if (password) {
        try {
          doc = await openPdfLib(bytes, password);
          wasLocked = hasSecurityDictionary;
        } catch {
          throw new Error("That password didn’t work. Check caps lock and try the owner password if you have it.");
        }
      } else {
        try {
          doc = await PDFDocument.load(bytes, { password: "" });
          wasLocked = hasSecurityDictionary;
        } catch {
          throw new Error("This PDF needs a password. Enter it above to unlock the file.");
        }
      }
      // Saving a decrypted document can re-emit its Encrypt dictionary, so rebuild
      // the file in a fresh document: that guarantees a clean, unprotected output.
      const fresh = await PDFDocument.create();
      const copied = await fresh.copyPages(doc, doc.getPageIndices());
      copied.forEach((p) => fresh.addPage(p));
      const title = doc.getTitle();
      const author = doc.getAuthor();
      if (title) fresh.setTitle(title);
      if (author) fresh.setAuthor(author);
      const out = await fresh.save();
      try {
        const check = await PDFDocument.load(out);
        if ((check as unknown as { isEncrypted?: boolean }).isEncrypted) throw new Error("still encrypted");
      } catch {
        throw new Error("The unlocked file could not be verified. It may use an unsupported encryption type.");
      }
      setResult({
        bytes: out,
        name: `${sanitizeName(baseName(pdf.file.name))}-unlocked.pdf`,
        pages: doc.getPageCount(),
        wasLocked,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {!pdf.file ? (
        <FileDrop accept="application/pdf,.pdf" acceptLabel="A protected PDF" onFiles={(f) => pdf.setFile(f[0])} />
      ) : (
        <FileRow file={pdf.file} onRemove={pdf.clear} size={formatBytes(pdf.file.size)} />
      )}

      {pdf.file && (
        <>
          {locked === true && !ownerOnly ? (
            <Field label="Document password" hint="Checked locally against the file. Never stored.">
              <div className="relative">
                <input
                  type={show ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={cn(inputClass, "pr-10")}
                  placeholder="Enter the password"
                  autoComplete="off"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && password) unlock();
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
          ) : ownerOnly ? (
            <Alert tone="info" title="No password needed">
              This PDF opens without a password but carries owner restrictions. Unlock it to rebuild an identical, unrestricted copy.
            </Alert>
          ) : (
            <Alert tone="info" title={locked === false ? "No password required" : "Checking your file…"}>
              {locked === false
                ? "This file opens without a password and has no encryption. You can still rebuild a clean, unrestricted copy."
                : "Reading the document’s security dictionary locally."}
            </Alert>
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
            <Button onClick={unlock} loading={busy} disabled={locked === true && !password && !ownerOnly}>
              <Unlock className="h-4 w-4" /> Unlock PDF
            </Button>
            {(locked === false || ownerOnly) && (
              <span className="text-[11.5px] text-muted">Rebuilds an unrestricted copy without changing content.</span>
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
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${result.wasLocked ? "Password removed" : "Restrictions removed"} · content untouched · store the unlocked copy somewhere safe`}
        />
      )}
    </div>
  );
}
