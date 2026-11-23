import { CheckCircle2, Info, X } from "lucide-react";
import { useEffect } from "react";
import { cn } from "@/utils/cn";

export interface ToastMessage {
  id: number;
  text: string;
  tone?: "success" | "info";
}

/** A small auto-dismissing confirmation used by workspace actions. */
export function Toast({ message, onClose }: { message: ToastMessage; onClose: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, 3600);
    return () => window.clearTimeout(timer);
  }, [message.id, onClose]);

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "fixed bottom-5 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-2 rounded-xl border px-3.5 py-2.5 text-[12px] font-medium shadow-lift animate-pop",
        message.tone === "info" ? "border-line bg-paper text-ink" : "border-forest/20 bg-forest text-paper",
      )}
    >
      {message.tone === "info" ? <Info className="h-4 w-4 shrink-0 text-forest" /> : <CheckCircle2 className="h-4 w-4 shrink-0 text-lime" />}
      <span className="max-w-[70vw]">{message.text}</span>
      <button type="button" onClick={onClose} aria-label="Dismiss notification" className="ml-1 rounded p-0.5 opacity-70 hover:opacity-100">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
