import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowRight, Check, KeyRound, Loader2, ShieldCheck, Sparkles, X } from "lucide-react";
import { cn } from "@/utils/cn";
import { formatBytes } from "@/lib/format";

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */
const env = import.meta.env as Record<string, string | undefined>;
export const PRO_DEV_MODE = String(env.VITE_PRO_DEV_MODE ?? "").toLowerCase() === "true";
const LICENSE_ENDPOINT = env.VITE_PRO_LICENSE_ENDPOINT || "https://api.lemonsqueezy.com/v1/licenses/validate";
const CHECKOUT_URL = env.VITE_PRO_CHECKOUT_URL || "";
const TOKEN_SECRET = env.VITE_PRO_TOKEN_SECRET || "paperly-pro-offline-v1";
const STORAGE_KEY = "paperly.pro.license.v1";
const TEAM_FLAG = "paperly.pro.team-pwa.v1";

export const FREE_BATCH_LIMIT = 3;
export const FREE_WORKFLOW_LIMIT = 1;

export interface ProLicense {
  active: true;
  plan: "pro";
  keyMasked: string;
  email?: string;
  product?: string;
  activatedAt: number;
  expiresAt?: number | null;
  source: "lemonsqueezy" | "dev";
}

/* ------------------------------------------------------------------ *
 * Signing helpers (Web Crypto HMAC-SHA256)
 *
 * The token is tamper-evident, not tamper-proof: a determined attacker can
 * patch client code. Offline activation is a convenience for paying customers;
 * server-side issuance is the actual authority. The signature stops casual
 * localStorage edits and accidental corruption.
 * ------------------------------------------------------------------ */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmac(data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`${TOKEN_SECRET}:${location.origin}`), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return base64Url(new Uint8Array(signature));
}

async function signLicense(license: ProLicense): Promise<string> {
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(license)));
  return `${payload}.${await hmac(payload)}`;
}

async function verifyToken(token: unknown): Promise<ProLicense | null> {
  if (typeof token !== "string") return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  try {
    const expected = await hmac(payload);
    if (expected !== signature) return null;
    const bytes = fromBase64Url(payload);
    if (!bytes) return null;
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as ProLicense;
    if (parsed?.active !== true || parsed.plan !== "pro") return null;
    if (typeof parsed.expiresAt === "number" && parsed.expiresAt > 0 && parsed.expiresAt < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function storeLicense(license: ProLicense): Promise<void> {
  const token = await signLicense(license);
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch {
    /* private mode: Pro lasts for this tab only */
  }
}

export function clearStoredLicense(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

async function readStoredLicense(): Promise<ProLicense | null> {
  try {
    return await verifyToken(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function maskKey(key: string): string {
  const clean = key.trim();
  if (clean.length <= 8) return "••••";
  return `${clean.slice(0, 4)}••••${clean.slice(-4)}`;
}

/* ------------------------------------------------------------------ *
 * Lemon Squeezy validation
 * ------------------------------------------------------------------ */
interface ValidationResponse {
  valid?: boolean;
  error?: string | null;
  license_key?: {
    status?: string;
    key?: string;
    expires_at?: string | null;
    activation_limit?: number | null;
  };
  meta?: {
    store_id?: number;
    product_name?: string;
    variant_name?: string;
    customer_email?: string;
    customer_name?: string;
  };
}

async function validateKey(key: string): Promise<ProLicense> {
  if (PRO_DEV_MODE && key.trim().toUpperCase() === "PAPERLY-DEV") {
    return {
      active: true,
      plan: "pro",
      keyMasked: "DEV-MODE",
      activatedAt: Date.now(),
      expiresAt: null,
      source: "dev",
    };
  }
  if (!LICENSE_ENDPOINT) throw new Error("No license validation endpoint is configured. Set VITE_PRO_LICENSE_ENDPOINT.");
  const body = new URLSearchParams({ license_key: key.trim() });
  let response: Response;
  try {
    response = await fetch(LICENSE_ENDPOINT, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    throw new Error("The license service couldn’t be reached. Check your connection and try again — your key is not stored.");
  }
  if (!response.ok) {
    throw new Error(`The license service returned ${response.status}. Try again in a moment.`);
  }
  const data = (await response.json()) as ValidationResponse;
  if (!data.valid) {
    throw new Error(data.error || "That license key is not valid for Paperly Pro.");
  }
  if (data.license_key?.status && data.license_key.status !== "active") {
    throw new Error(`This license is ${data.license_key.status}. Contact support or reactivate it in Lemon Squeezy.`);
  }
  const expiresAt = data.license_key?.expires_at ? new Date(data.license_key.expires_at).getTime() : null;
  if (expiresAt && expiresAt < Date.now()) {
    throw new Error("This license has expired.");
  }
  return {
    active: true,
    plan: "pro",
    keyMasked: maskKey(data.license_key?.key ?? key),
    email: data.meta?.customer_email,
    product: data.meta?.product_name || data.meta?.variant_name || "Paperly Pro",
    activatedAt: Date.now(),
    expiresAt,
    source: "lemonsqueezy",
  };
}

/* ------------------------------------------------------------------ *
 * Context + provider
 * ------------------------------------------------------------------ */
interface ProContextValue {
  ready: boolean;
  isPro: boolean;
  license: ProLicense | null;
  devMode: boolean;
  teamPwaEnabled: boolean;
  openUpgrade: (reason?: string) => void;
  openActivation: () => void;
  close: () => void;
  activate: (key: string) => Promise<void>;
  deactivate: () => void;
  enableTeamPwa: () => boolean;
}

const ProContext = createContext<ProContextValue | null>(null);

export function ProProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [license, setLicense] = useState<ProLicense | null>(null);
  const [upgradeReason, setUpgradeReason] = useState<string | null>(null);
  const [activationOpen, setActivationOpen] = useState(false);
  const [teamPwaEnabled, setTeamPwaEnabled] = useState(() => {
    try {
      return localStorage.getItem(TEAM_FLAG) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    let alive = true;
    readStoredLicense()
      .then((stored) => alive && setLicense(stored))
      .finally(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, []);

  const isPro = PRO_DEV_MODE || Boolean(license);

  const openUpgrade = useCallback((reason?: string) => {
    setUpgradeReason(reason ?? "This power feature is part of Paperly Pro.");
    setActivationOpen(false);
  }, []);

  const openActivation = useCallback(() => {
    setUpgradeReason(null);
    setActivationOpen(true);
  }, []);

  const close = useCallback(() => {
    setActivationOpen(false);
    setUpgradeReason(null);
  }, []);

  const activate = useCallback(async (key: string) => {
    const next = await validateKey(key);
    await storeLicense(next);
    setLicense(next);
    setActivationOpen(false);
    setUpgradeReason(null);
  }, []);

  const deactivate = useCallback(() => {
    clearStoredLicense();
    setLicense(null);
    try {
      localStorage.removeItem(TEAM_FLAG);
    } catch {
      /* ignore */
    }
    setTeamPwaEnabled(false);
  }, []);

  const enableTeamPwa = useCallback(() => {
    if (!isPro) {
      openUpgrade("Commercial / Offline Team PWA Mode is a Pro feature.");
      return false;
    }
    try {
      localStorage.setItem(TEAM_FLAG, "1");
    } catch {
      /* still enabled for this session */
    }
    setTeamPwaEnabled(true);
    return true;
  }, [isPro, openUpgrade]);

  const value = useMemo<ProContextValue>(
    () => ({
      ready,
      isPro,
      license,
      devMode: PRO_DEV_MODE,
      teamPwaEnabled,
      openUpgrade,
      openActivation,
      close,
      activate,
      deactivate,
      enableTeamPwa,
    }),
    [ready, isPro, license, teamPwaEnabled, openUpgrade, openActivation, close, activate, deactivate, enableTeamPwa],
  );

  return (
    <ProContext.Provider value={value}>
      {children}
      {(activationOpen || upgradeReason) && (
        <ProModal
          mode={activationOpen ? "activate" : "upgrade"}
          reason={upgradeReason ?? undefined}
          onClose={close}
          onActivate={activate}
          onOpenActivation={openActivation}
          onDeactivate={deactivate}
          license={license}
          devMode={PRO_DEV_MODE}
        />
      )}
    </ProContext.Provider>
  );
}

export function usePro(): ProContextValue {
  const context = useContext(ProContext);
  if (!context) {
    // Tools rendered outside the provider (tests, isolated stories) stay free.
    return {
      ready: true,
      isPro: PRO_DEV_MODE,
      license: null,
      devMode: PRO_DEV_MODE,
      teamPwaEnabled: false,
      openUpgrade: () => undefined,
      openActivation: () => undefined,
      close: () => undefined,
      activate: async () => undefined,
      deactivate: () => undefined,
      enableTeamPwa: () => false,
    };
  }
  return context;
}

/* ------------------------------------------------------------------ *
 * Modal
 * ------------------------------------------------------------------ */
const PRO_FEATURES = [
  "Batch more than 3 files in one run",
  "Save more than 1 custom workflow pipeline",
  "Commercial / Offline Team PWA Mode",
  "Priority support and early tool releases",
];

function ProModal({
  mode,
  reason,
  onClose,
  onActivate,
  onOpenActivation,
  onDeactivate,
  license,
  devMode,
}: {
  mode: "upgrade" | "activate";
  reason?: string;
  onClose: () => void;
  onActivate: (key: string) => Promise<void>;
  onOpenActivation: () => void;
  onDeactivate: () => void;
  license: ProLicense | null;
  devMode: boolean;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const active = Boolean(license) || devMode;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    if (!key.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await onActivate(key.trim());
      setSuccess(true);
      setKey("");
    } catch (err) {
      setError((err as { message?: string })?.message ?? "Activation failed. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-ink/60 px-4 py-10 backdrop-blur-sm" onMouseDown={onClose} role="dialog" aria-modal="true" aria-labelledby="pro-modal-title">
      <div className="w-full max-w-lg animate-pop overflow-hidden rounded-2xl border border-line bg-paper shadow-lift" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.13em] text-forest">
              <Sparkles className="h-3 w-3" /> Paperly Pro
            </p>
            <h2 id="pro-modal-title" className="mt-1 text-[20px] font-semibold tracking-[-0.025em]">
              {success || active ? "Pro is active on this device" : mode === "activate" ? "Activate your license" : "A power feature for heavy workflows"}
            </h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-ink/60 hover:bg-ink/5 hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          {success || active ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-xl border border-forest/20 bg-lime/20 px-3.5 py-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-forest text-lime">
                  <Check className="h-4 w-4" strokeWidth={3} />
                </span>
                <div>
                  <p className="text-[13px] font-semibold">License verified and cached offline</p>
                  <p className="text-[11.5px] text-muted">
                    {devMode && !license ? "Development bypass active." : `${license?.keyMasked ?? ""}${license?.email ? ` · ${license.email}` : ""}`}
                  </p>
                </div>
              </div>
              <p className="text-[12px] leading-relaxed text-muted">
                Pro now works without a connection. The signed activation token lives in this browser only — it is never sent with your documents.
              </p>
              {license && (
                <button type="button" onClick={onDeactivate} className="text-[11.5px] font-medium text-clay-ink hover:underline">
                  Deactivate this device
                </button>
              )}
            </div>
          ) : mode === "activate" ? (
            <>
              <label htmlFor="pro-key" className="block text-[11.5px] font-semibold uppercase tracking-[0.07em] text-ink/70">
                Lemon Squeezy license key
              </label>
              <div className="mt-1.5 flex gap-2">
                <div className="relative flex-1">
                  <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/40" />
                  <input
                    id="pro-key"
                    value={key}
                    onChange={(event) => setKey(event.target.value)}
                    onKeyDown={(event) => event.key === "Enter" && void submit()}
                    placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
                    autoComplete="off"
                    spellCheck={false}
                    className="h-11 w-full rounded-xl border border-line bg-bone/50 pl-9 pr-3 font-mono text-[12.5px] text-ink placeholder:text-ink/30 focus:border-forest/50 focus:outline-none focus:ring-2 focus:ring-forest/10"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={busy || !key.trim()}
                  className="inline-flex h-11 items-center gap-1.5 rounded-xl bg-ink px-4 text-[12.5px] font-semibold text-paper disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4 text-lime" />} Activate
                </button>
              </div>
              {error && <p className="mt-2 rounded-lg bg-clay/10 px-3 py-2 text-[11.5px] font-medium text-clay-ink">{error}</p>}
              <p className="mt-3 text-[11px] leading-relaxed text-muted">
                The key is validated once with Lemon Squeezy, then stored as a signed offline token. {devMode ? "Dev mode: enter PAPERLY-DEV to bypass." : "No key? Buy Pro from your Lemon Squeezy checkout, then return here."}
              </p>
              {CHECKOUT_URL && (
                <a href={CHECKOUT_URL} target="_blank" rel="noreferrer external" className="mt-3 inline-flex items-center gap-1 text-[11.5px] font-semibold text-forest hover:underline">
                  Get a license <ArrowRight className="h-3 w-3" />
                </a>
              )}
            </>
          ) : (
            <>
              <p className="text-[12px] leading-relaxed text-muted">{reason}</p>
              <ul className="mt-3 space-y-2">
                {PRO_FEATURES.map((feature) => (
                  <li key={feature} className="flex items-center gap-2 text-[12.5px]">
                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-lime text-forest">
                      <Check className="h-2.5 w-2.5" strokeWidth={3} />
                    </span>
                    {feature}
                  </li>
                ))}
              </ul>
              <div className="mt-4 rounded-xl border border-line bg-bone/40 px-3.5 py-3 text-[11.5px] leading-relaxed text-muted">
                Every one of the 51 single-document tools stays <strong className="text-ink">free and unlimited</strong>. Pro only funds high-volume and
                commercial power features.
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button type="button" onClick={onOpenActivation} className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-ink px-4 text-[12.5px] font-semibold text-paper">
                  <KeyRound className="h-3.5 w-3.5 text-lime" /> I have a license key
                </button>
                {CHECKOUT_URL ? (
                  <a href={CHECKOUT_URL} target="_blank" rel="noreferrer external" className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-line px-4 text-[12.5px] font-medium hover:border-forest/30">
                    Get Paperly Pro <ArrowRight className="h-3.5 w-3.5" />
                  </a>
                ) : (
                  <span className="text-[11px] text-muted">Your license key arrives with your Lemon Squeezy receipt.</span>
                )}
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line bg-bone/40 px-5 py-3 text-[10.5px] text-muted">
          <span className="flex items-center gap-1">
            <ShieldCheck className="h-3 w-3 text-forest" /> Offline activation · {formatBytes(0)} uploaded
          </span>
          <span className="font-mono">{devMode ? "DEV MODE" : "LICENSE v1"}</span>
        </div>
      </div>
    </div>
  );
}

/** Small inline marker used next to gated controls. */
export function ProBadge({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border border-forest/15 bg-lime/30 px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-[0.07em] text-forest", className)}>
      <Sparkles className="h-2.5 w-2.5" /> Pro
    </span>
  );
}
