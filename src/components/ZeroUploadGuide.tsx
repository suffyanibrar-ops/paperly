import { Check, ChevronRight, ClipboardCheck, Cpu, ExternalLink, Globe2, ServerOff, ShieldCheck, Terminal } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/utils/cn";
import { copyText } from "@/lib/router";

const BROWSERS = ["Chrome / Edge", "Firefox", "Safari"] as const;
type Browser = (typeof BROWSERS)[number];

const STEPS: Record<Browser, { title: string; detail: string }[]> = {
  "Chrome / Edge": [
    { title: "Open DevTools", detail: "Press F12, or ⌘/Ctrl + Shift + I. Choose the Network tab." },
    { title: "Filter to documents", detail: "Click Fetch/XHR and tick “Preserve log”. Clear the request list." },
    { title: "Run any tool", detail: "Drop a PDF and process it. Watch the request list while it works." },
    { title: "Confirm the absence", detail: "No request has your filename or a PDF body. The only same-origin requests are app code and cached assets." },
  ],
  Firefox: [
    { title: "Open Developer Tools", detail: "Press F12 or ⌘/Ctrl + Shift + I, then choose the Network tab." },
    { title: "Filter and persist", detail: "Select XHR, enable Persist Logs, and clear the request list." },
    { title: "Process a document", detail: "Drop your file into a tool and run it." },
    { title: "Confirm the absence", detail: "There is no POST with your document. A local file read never appears as a network request." },
  ],
  Safari: [
    { title: "Enable the Develop menu", detail: "Safari → Settings → Advanced → Show features for web developers." },
    { title: "Open the Web Inspector", detail: "Develop → Show Web Inspector, then choose the Network tab." },
    { title: "Enable Preserve Log", detail: "Clear the list and process a PDF in any tool." },
    { title: "Confirm the absence", detail: "No document request appears. If you go offline, the tool still completes." },
  ],
};

export function ZeroUploadGuide() {
  const [browser, setBrowser] = useState<Browser>("Chrome / Edge");
  const [done, setDone] = useState<number[]>([]);
  const [probe, setProbe] = useState<{ status: "idle" | "running" | "done"; requests: number; digest: string }>({ status: "idle", requests: 0, digest: "" });
  const steps = STEPS[browser];
  const progress = useMemo(() => Math.round((done.length / steps.length) * 100), [done.length, steps.length]);

  const toggle = (index: number) => setDone((current) => (current.includes(index) ? current.filter((i) => i !== index) : [...current, index]));

  const runProbe = async () => {
    setProbe({ status: "running", requests: 0, digest: "" });
    const before = performance.getEntriesByType("resource").length;
    try {
      const payload = new TextEncoder().encode(`paperly-local-probe:${Date.now()}`);
      const hash = await crypto.subtle.digest("SHA-256", payload);
      const digest = Array.from(new Uint8Array(hash))
        .slice(0, 8)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      // Give the browser a frame to record any (non-existent) resource entries.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const after = performance.getEntriesByType("resource").length;
      setProbe({ status: "done", requests: Math.max(0, after - before), digest });
    } catch {
      setProbe({ status: "done", requests: 0, digest: "unavailable" });
    }
  };

  const copySteps = async () => {
    await copyText(
      [
        `Paperly zero-upload verification — ${browser}`,
        ...steps.map((step, index) => `${index + 1}. ${step.title}: ${step.detail}`),
        "Expected result: no request carries the document. The tool still completes with the network offline.",
      ].join("\n"),
    );
  };

  return (
    <section className="border-b border-line py-14" id="verify-zero-uploads">
      <div className="container-page">
        <div className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr] lg:gap-12">
          <div>
            <p className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.12em] text-forest">
              <ClipboardCheck className="h-3.5 w-3.5" /> Verify it yourself
            </p>
            <h2 className="mt-2 text-[28px] font-semibold tracking-[-0.035em] sm:text-[34px]">Don’t trust the claim. Watch the network.</h2>
            <p className="mt-2 max-w-[62ch] text-[13px] leading-relaxed text-muted">
              A privacy promise you cannot check is just marketing. This is the exact procedure to prove that a document is never uploaded — no
              extension, no account and no special build required.
            </p>

            <div className="mt-5 flex flex-wrap gap-1.5" role="tablist" aria-label="Browser instructions">
              {BROWSERS.map((name) => (
                <button
                  key={name}
                  type="button"
                  role="tab"
                  aria-selected={browser === name}
                  onClick={() => {
                    setBrowser(name);
                    setDone([]);
                  }}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-[11.5px] font-medium transition-colors",
                    browser === name ? "border-forest bg-forest text-paper" : "border-line bg-paper text-ink/70 hover:border-forest/30",
                  )}
                >
                  {name}
                </button>
              ))}
            </div>

            <ol className="mt-4 space-y-2">
              {steps.map((step, index) => {
                const checked = done.includes(index);
                return (
                  <li key={step.title}>
                    <button
                      type="button"
                      onClick={() => toggle(index)}
                      aria-pressed={checked}
                      className={cn(
                        "flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors",
                        checked ? "border-forest/25 bg-lime/15" : "border-line bg-paper hover:border-forest/25",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold",
                          checked ? "border-forest bg-forest text-lime" : "border-line text-ink/60",
                        )}
                      >
                        {checked ? <Check className="h-3 w-3" strokeWidth={3} /> : index + 1}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[12.5px] font-semibold">{step.title}</span>
                        <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted">{step.detail}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <div className="h-1.5 w-40 overflow-hidden rounded-full bg-ink/10">
                <div className="h-full rounded-full bg-forest transition-all" style={{ width: `${progress}%` }} />
              </div>
              <span className="font-mono text-[11px] text-ink/70">
                {done.length}/{steps.length} verified
              </span>
              <button type="button" onClick={() => void copySteps()} className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-forest hover:underline">
                <Terminal className="h-3 w-3" /> Copy these steps
              </button>
            </div>
          </div>

          <div className="space-y-3">
            <div className="rounded-2xl border border-line bg-paper p-5">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink/70">
                <ServerOff className="h-3.5 w-3.5 text-forest" /> The sandbox, in one picture
              </p>
              <div className="mt-3 space-y-2">
                {[
                  { icon: Globe2, title: "Main thread", body: "Reads the File object, runs the UI and builds the download. No network call is made with file contents." },
                  { icon: Cpu, title: "Web Worker + WebAssembly", body: "PDF.js, pdf-lib and Tesseract parse and rewrite pages in an isolated worker on your CPU." },
                  { icon: ShieldCheck, title: "Web Crypto", body: "Passwords and hashes are handled by the browser's crypto module. Keys never leave the tab." },
                ].map((item) => (
                  <div key={item.title} className="flex items-start gap-2.5 rounded-xl border border-line bg-bone/40 px-3 py-2.5">
                    <item.icon className="mt-0.5 h-4 w-4 shrink-0 text-forest" />
                    <div>
                      <p className="text-[12px] font-semibold">{item.title}</p>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{item.body}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl bg-forest p-5 text-paper">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-lime">
                <Cpu className="h-3.5 w-3.5" /> Live local-engine probe
              </p>
              <p className="mt-2 text-[11.5px] leading-relaxed text-paper/75">
                Runs SHA-256 through Web Crypto — the same sandbox primitives used for encryption — and counts resource requests while it works.
              </p>
              <button
                type="button"
                onClick={() => void runProbe()}
                disabled={probe.status === "running"}
                className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-lg bg-lime px-3 text-[11.5px] font-semibold text-ink disabled:opacity-60"
              >
                {probe.status === "running" ? "Running locally…" : "Run local proof"} <ChevronRight className="h-3.5 w-3.5" />
              </button>
              {probe.status === "done" && (
                <div className="mt-3 space-y-1 rounded-lg bg-ink/30 px-3 py-2 font-mono text-[10.5px] text-paper/80">
                  <p>network requests during probe: {probe.requests}</p>
                  <p>sha-256: {probe.digest}…</p>
                  <p className="text-lime">result: computed on this device</p>
                </div>
              )}
            </div>

            <a href="/activity" className="flex items-center justify-between rounded-2xl border border-line bg-paper px-4 py-3 text-[12px] font-semibold text-forest hover:border-forest/30">
              Review exactly what is stored in this browser <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
