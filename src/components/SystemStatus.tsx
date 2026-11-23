import { CloudOff, Moon, ShieldCheck, Sun, Wifi } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/utils/cn";
import { useTheme } from "@/lib/theme";

/**
 * Live local-engine indicator. It reflects the browser's connectivity, not a
 * server heartbeat: Paperly has no server to ask. When the device is offline the
 * label states the stronger claim — everything still runs from the local cache.
 */
export function EngineStatus({ className }: { className?: string }) {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [offlineReady, setOfflineReady] = useState(false);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        if (!("serviceWorker" in navigator)) return;
        const registration = await navigator.serviceWorker.getRegistration();
        const ready = Boolean(registration?.active || navigator.serviceWorker.controller);
        if (alive) setOfflineReady(ready);
      } catch {
        /* the pill still reports connectivity */
      }
    };
    void check();
    const timer = window.setTimeout(check, 2500);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, []);

  const label = online ? "Local Engine Ready (0 KB Uploaded)" : "Offline Mode Active — 100% Local";

  return (
    <span
      role="status"
      aria-live="polite"
      title={
        online
          ? offlineReady
            ? "All processing happens in this tab. The offline cache is ready."
            : "All processing happens in this tab. No document bytes are uploaded."
          : "You are offline. Paperly keeps running from the local cache — nothing is sent anywhere."
      }
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] font-semibold tracking-[0.01em] whitespace-nowrap",
        online
          ? "border-forest/25 bg-lime/30 text-forest"
          : "border-lime/30 bg-ink text-lime",
        className,
      )}
    >
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", online ? "bg-forest" : "bg-lime")} aria-hidden="true" />
      {online ? <ShieldCheck className="hidden h-3 w-3 sm:block" aria-hidden="true" /> : <CloudOff className="hidden h-3 w-3 sm:block" aria-hidden="true" />}
      <span className="hidden sm:inline">{label}</span>
      <span className="sm:hidden">{online ? "Local · 0 KB" : "Offline · 100%"}</span>
    </span>
  );
}

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      className={cn(
        "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line bg-paper text-ink/75 transition-colors hover:border-forest/30 hover:text-forest",
        className,
      )}
    >
      {dark ? <Sun className="h-[17px] w-[17px]" /> : <Moon className="h-[17px] w-[17px]" />}
    </button>
  );
}

/** A small truthful network badge for the privacy and pricing pages. */
export function ConnectivityBadge({ online }: { online: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold",
        online ? "border-forest/20 bg-lime/30 text-forest" : "border-lime/30 bg-ink text-lime",
      )}
    >
      {online ? <Wifi className="h-3 w-3" /> : <CloudOff className="h-3 w-3" />}
      {online ? "Online · local engine" : "Offline · 100% local"}
    </span>
  );
}
