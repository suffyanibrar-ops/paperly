import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  CloudOff,
  Download,
  File as FileIcon,
  FileText,
  Info,
  Keyboard,
  Layers,
  Loader2,
  ShieldCheck,
  Sparkles,
  Star,
  UploadCloud,
  X,
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type DragEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "@/utils/cn";
import { MobileActionBar } from "@/components/MobileActionBar";
import { CATEGORIES, getTool, type Tool } from "@/lib/toolRegistry";
import { groupLabel, toolGroup } from "@/lib/groups";
import { useFavorites } from "@/lib/activity";
import { isTypingTarget } from "@/lib/hotkeys";
import { fileExt, formatBytes } from "@/lib/format";
import { friendlyProcessingError, validateUpload } from "@/lib/security";
import type { SampleSpec } from "@/lib/sample";
import { toolPath } from "@/lib/slugs";

/* One global paste listener: the most recently mounted drop zone wins, so a
 * page with several zones never adds the same pasted file twice. */
const pasteHandlers: ((files: File[]) => void)[] = [];
let pasteInstalled = false;
function registerPaste(handler: (files: File[]) => void): () => void {
  if (!pasteInstalled && typeof window !== "undefined") {
    window.addEventListener("paste", (event) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (!files.length) return;
      const handlerAtTop = pasteHandlers[pasteHandlers.length - 1];
      handlerAtTop?.(files);
    });
    pasteInstalled = true;
  }
  pasteHandlers.push(handler);
  return () => {
    const index = pasteHandlers.lastIndexOf(handler);
    if (index >= 0) pasteHandlers.splice(index, 1);
  };
}

/* ------------------------------------------------------------------ *
 * Buttons & badges
 * ------------------------------------------------------------------ */
type ButtonVariant = "primary" | "accent" | "outline" | "ghost" | "danger" | "soft";
type ButtonSize = "sm" | "md" | "lg";

const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    "bg-ink text-paper hover:bg-forest-soft active:scale-[0.985] shadow-[0_10px_24px_-14px_rgba(18,33,26,0.8)]",
  accent:
    "bg-lime text-ink hover:bg-[#e4f88f] active:scale-[0.985] shadow-[0_10px_24px_-14px_rgba(18,33,26,0.55)]",
  outline: "border border-ink/20 bg-transparent text-ink hover:border-ink/40 hover:bg-ink/[0.035]",
  ghost: "text-ink/75 hover:bg-ink/[0.055] hover:text-ink",
  danger: "bg-clay text-white hover:bg-[#d4522e]",
  soft: "bg-forest/[0.06] text-forest hover:bg-forest/[0.11]",
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: "h-12 sm:h-9 px-3.5 text-[13px] gap-1.5 rounded-xl",
  md: "h-12 sm:h-11 px-5 text-[14px] gap-2 rounded-xl",
  lg: "h-12 px-6 text-[15px] gap-2 rounded-xl",
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  loading,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}) {
  return (
    <button
      data-paperly-primary={variant === "primary" || variant === "accent" || variant === "danger" ? "true" : undefined}
      className={cn(
        "inline-flex select-none items-center justify-center font-medium transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-45",
        buttonVariants[variant],
        buttonSizes[size],
        className,
      )}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

export function Badge({
  children,
  className,
  tone = "neutral",
}: {
  children: ReactNode;
  className?: string;
  tone?: "neutral" | "forest" | "clay" | "lime";
}) {
  const tones = {
    neutral: "bg-ink/[0.055] text-ink/75 border-transparent",
    forest: "bg-forest/[0.07] text-forest border-forest/10",
    clay: "bg-clay/[0.08] text-clay-ink border-clay/15",
    lime: "bg-lime/50 text-forest border-forest/10",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em]",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("h-4 w-4 animate-spin", className)} />;
}

/* ------------------------------------------------------------------ *
 * File drop
 * ------------------------------------------------------------------ */
export function FileDrop({
  accept,
  multiple = false,
  onFiles,
  acceptLabel = "files",
  compact = false,
  disabled = false,
  hint,
  sample,
}: {
  accept: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  acceptLabel?: string;
  compact?: boolean;
  disabled?: boolean;
  /** Extra reassurance under the drop zone (limits, formats…). */
  hint?: ReactNode;
  /** Locally generated example so the tool can be tried with zero setup. */
  sample?: SampleSpec;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [sampleBusy, setSampleBusy] = useState(false);
  const id = useId();

  const acceptFiles = async (picked: File[]) => {
    if (!picked.length) return;
    const valid: File[] = [];
    const problems: string[] = [];
    for (const file of picked) {
      try {
        await validateUpload(file, accept);
        valid.push(file);
      } catch (err) {
        problems.push(friendlyProcessingError(err, `${file.name} couldn’t be accepted.`));
      }
    }
    const shown = problems.slice(0, 2).join(" ");
    const extra = problems.length > 2 ? ` ${problems.length - 2} more file${problems.length - 2 === 1 ? "" : "s"} skipped.` : "";
    setError(shown + extra);
    if (valid.length) onFiles(multiple ? valid : valid.slice(0, 1));
  };

  // Paste a file straight from the clipboard (screenshots, copied documents).
  // Keep the newest handler in a ref so a paste always validates against the
  // current tool state, not the state captured when the zone mounted.
  const acceptFilesRef = useRef(acceptFiles);
  acceptFilesRef.current = acceptFiles;
  useEffect(() => {
    if (disabled) return;
    return registerPaste((files) => {
      void acceptFilesRef.current(files);
    });
  }, [disabled]);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!disabled) void acceptFiles(Array.from(e.dataTransfer.files));
  };

  const trySample = async () => {
    if (!sample || sampleBusy) return;
    setSampleBusy(true);
    setError("");
    try {
      const file = await sample.create();
      await acceptFiles([file]);
    } catch (err) {
      setError(friendlyProcessingError(err, "The sample couldn’t be prepared in this browser."));
    } finally {
      setSampleBusy(false);
    }
  };

  return (
    <div>
      <label
        htmlFor={id}
        data-paperly-primary="true"
        aria-label={`Choose ${acceptLabel}`}
        aria-describedby={error ? `${id}-error` : undefined}
        aria-disabled={disabled}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "group relative flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed text-center transition-all duration-200",
          compact ? "px-4 py-4 sm:px-5 sm:py-7" : "px-6 py-12 sm:py-16",
          dragging
            ? "border-forest bg-lime/20 ring-4 ring-lime/25"
            : "border-ink/20 bg-bone-deep/35 hover:border-forest/50 hover:bg-lime/[0.09]",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        <input
          ref={inputRef}
          id={id}
          type="file"
          tabIndex={-1}
          accept={accept}
          multiple={multiple}
          aria-label={`Choose ${acceptLabel}`}
          className="sr-only"
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            void acceptFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <div
          className={cn(
            "mb-4 flex items-center justify-center rounded-2xl border border-forest/10 bg-forest text-lime transition-transform duration-200 group-hover:-translate-y-0.5",
            compact ? "mb-2 h-9 w-9 sm:mb-4 sm:h-11 sm:w-11" : "mb-4 h-14 w-14",
          )}
        >
          <UploadCloud className={compact ? "h-5 w-5" : "h-6 w-6"} strokeWidth={1.9} />
        </div>
        <p className={cn("font-semibold tracking-[-0.01em]", compact ? "text-[13px] sm:text-[14px]" : "text-[17px]")}>
          {dragging ? "Drop it — it stays on your device" : "Drop your file here"}
        </p>
        <p className={cn("mt-1 text-muted", compact ? "text-xs" : "text-[13px]")}>
          or <span className="font-medium text-forest underline decoration-forest/30 underline-offset-2">browse your files</span>
          {" · "}
          <span className="whitespace-nowrap">⌘V / Ctrl+V to paste</span>
        </p>
        <p className="mt-3 text-[11px] font-medium uppercase tracking-[0.1em] text-ink/75">{acceptLabel}</p>
        {hint ? <p className="mt-2 max-w-sm text-[11px] leading-relaxed text-muted">{hint}</p> : null}
      </label>
      {sample ? (
        <div className="mt-2 flex justify-center">
          <button
            type="button"
            disabled={disabled || sampleBusy}
            onClick={() => void trySample()}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-paper px-2.5 text-[11.5px] font-medium text-forest transition-colors hover:border-forest/35 hover:bg-lime/20 disabled:opacity-50"
          >
            <Sparkles className={cn("h-3.5 w-3.5", sampleBusy && "animate-pulse")} />
            {sampleBusy ? "Preparing sample…" : sample.label}
          </button>
        </div>
      ) : null}
      {error && (
        <p id={`${id}-error`} className="mt-2 flex items-start gap-1.5 text-xs font-medium text-clay-ink" role="alert">
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" /> {error}
        </p>
      )}
    </div>
  );
}

export function fileTypeLabel(name: string) {
  const ext = fileExt(name);
  return ext ? ext.toUpperCase().slice(0, 4) : "FILE";
}

export function FileRow({
  file,
  onRemove,
  index,
  children,
  size,
}: {
  file: File;
  onRemove?: () => void;
  index?: number;
  children?: ReactNode;
  size?: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-paper px-3 py-2.5">
      {typeof index === "number" && (
        <span className="w-5 text-center text-[11px] font-semibold tabular-nums text-ink/75">{index + 1}</span>
      )}
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-bone-deep text-forest">
        <FileIcon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-semibold leading-tight">{file.name}</p>
        <p className="mt-0.5 font-mono text-[11px] text-muted">
          {fileTypeLabel(file.name)} · {size ?? formatBytes(file.size)}
        </p>
      </div>
      {children}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${file.name}`}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink/75 transition-colors hover:bg-clay/10 hover:text-clay-ink"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Feedback, progress & results
 * ------------------------------------------------------------------ */
export function Alert({
  children,
  tone = "info",
  title,
  className,
}: {
  children?: ReactNode;
  tone?: "info" | "error" | "success" | "warning";
  title?: string;
  className?: string;
}) {
  const tones = {
    info: "border-forest/15 bg-forest/[0.045] text-forest",
    error: "border-clay/20 bg-clay/[0.06] text-[#b14425]",
    success: "border-forest/20 bg-lime/25 text-forest",
    warning: "border-amber-500/25 bg-amber-50 text-amber-900",
  };
  const Icon = tone === "error" ? AlertCircle : tone === "success" ? CheckCircle2 : tone === "warning" ? AlertCircle : Info;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn("flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-[13px] leading-relaxed", tones[tone], className)}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">
        {title && <p className="mb-0.5 font-semibold">{title}</p>}
        {children}
      </div>
    </div>
  );
}

export function Progress({
  value,
  label,
  detail,
  etaMs,
}: {
  value?: number;
  label?: string;
  detail?: string;
  /** Remaining time in milliseconds, when the engine can estimate it. */
  etaMs?: number | null;
}) {
  const etaCopy =
    typeof etaMs === "number" && etaMs > 1000 ? `about ${Math.max(1, Math.round(etaMs / 1000))}s left` : "";
  return (
    <div className="w-full" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined} aria-valuetext={label ?? "Working locally"}>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[12px] font-medium text-forest">
        <span className="min-w-0">
          {label ?? "Working locally…"}
          {detail ? <span className="ml-1.5 font-normal text-muted">{detail}</span> : null}
        </span>
        <span className="flex items-center gap-2 tabular-nums text-ink/70">
          {etaCopy ? <span className="text-[11px] font-normal text-muted">{etaCopy}</span> : null}
          {typeof value === "number" && <span>{Math.round(value)}%</span>}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-forest/10">
        <div
          className={cn("h-full rounded-full bg-forest transition-all duration-300", typeof value !== "number" && "animate-pulse")}
          style={{ width: typeof value === "number" ? `${Math.max(3, Math.min(100, value))}%` : "100%" }}
        />
      </div>
    </div>
  );
}

export function SuccessPanel({
  title,
  description,
  onDownload,
  downloadLabel,
  secondary,
  children,
}: {
  title: string;
  description?: ReactNode;
  onDownload?: () => void;
  downloadLabel?: string;
  secondary?: ReactNode;
  children?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Announce the result and move focus so keyboard and screen-reader users
  // land on the download panel instead of hunting for it.
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="status"
      aria-live="polite"
      className="animate-pop rounded-2xl border border-forest/15 bg-forest p-5 text-paper outline-none sm:p-6 focus-visible:ring-2 focus-visible:ring-lime/60"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-lime text-forest">
          <Check className="h-5 w-5" strokeWidth={2.6} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[17px] font-semibold tracking-[-0.01em]">{title}</h3>
          {description && <div className="mt-1 text-[13px] leading-relaxed text-paper/70">{description}</div>}
          {children}
        </div>
      </div>
      {(onDownload || secondary) && (
        <div className="mt-5 flex flex-wrap items-center gap-2.5">
          {onDownload && (
            <Button variant="accent" onClick={onDownload}>
              <Download className="h-4 w-4" /> {downloadLabel ?? "Download"}
            </Button>
          )}
          {secondary}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Form controls
 * ------------------------------------------------------------------ */
export const inputClass =
  "h-11 w-full rounded-xl border border-line bg-paper px-3.5 text-[14px] text-ink placeholder:text-ink/75 transition-colors focus:border-forest/50 focus:outline-none focus:ring-2 focus:ring-forest/10 disabled:opacity-50";

export const smallInputClass =
  "h-9 w-full rounded-lg border border-line bg-paper px-2.5 text-[13px] text-ink placeholder:text-ink/75 focus:border-forest/50 focus:outline-none focus:ring-2 focus:ring-forest/10";

export function Field({
  label,
  htmlFor,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const autoId = useId();
  const labelId = `${autoId}-label`;
  return (
    <FieldLabelContext.Provider value={labelId}>
      <div className={cn("space-y-1.5", className)}>
        <label id={labelId} htmlFor={htmlFor} className="block text-[12px] font-semibold uppercase tracking-[0.06em] text-ink/70">
          {label}
        </label>
        {children}
        {hint && <p className="text-[11.5px] leading-relaxed text-muted">{hint}</p>}
      </div>
    </FieldLabelContext.Provider>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const labelId = useFieldLabelId();
  return <input {...props} aria-labelledby={props["aria-label"] ? undefined : props["aria-labelledby"] ?? labelId} className={cn(inputClass, props.className)} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const labelId = useFieldLabelId();
  return (
    <div className="relative">
      <select
        {...props}
        aria-labelledby={props["aria-label"] ? undefined : props["aria-labelledby"] ?? labelId}
        className={cn(inputClass, "appearance-none pr-9", props.className)}
      />
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/75" />
    </div>
  );
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const labelId = useFieldLabelId();
  return (
    <textarea
      {...props}
      aria-labelledby={props["aria-label"] ? undefined : props["aria-labelledby"] ?? labelId}
      className={cn(
        "w-full rounded-xl border border-line bg-paper px-3.5 py-2.5 text-[14px] leading-relaxed text-ink placeholder:text-ink/75 transition-colors focus:border-forest/50 focus:outline-none focus:ring-2 focus:ring-forest/10",
        props.className,
      )}
    />
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  size = "md",
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; icon?: ReactNode; hint?: string }[];
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <div className={cn("grid gap-2", className)} style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex flex-col items-center justify-center gap-1 rounded-xl border px-2 text-center transition-all",
              size === "sm" ? "min-h-9 py-1.5 text-[12px]" : "min-h-11 py-2 text-[12.5px]",
              active
                ? "border-forest bg-forest text-paper shadow-sm"
                : "border-line bg-paper text-ink/70 hover:border-forest/30 hover:bg-bone-deep/40",
            )}
          >
            <span className="flex items-center gap-1.5 font-medium">
              {option.icon}
              {option.label}
            </span>
            {option.hint && (
              <span className={cn("text-[10.5px] leading-snug", active ? "text-paper/70" : "text-ink/75")}>{option.hint}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-xl border border-line bg-paper px-3.5 py-3">
      <span>
        <span className="block text-[13px] font-medium">{label}</span>
        {description && <span className="mt-0.5 block text-[11.5px] leading-snug text-muted">{description}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 h-6 w-10 shrink-0 rounded-full transition-colors",
          checked ? "bg-forest" : "bg-ink/15",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
            checked ? "left-[18px]" : "left-0.5",
          )}
        />
      </button>
    </label>
  );
}

export function ColorInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <label className="flex h-11 items-center gap-2 rounded-xl border border-line bg-paper px-2.5">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="h-6 w-7 cursor-pointer rounded border-0 bg-transparent p-0"
      />
      <span className="text-[12px] font-medium uppercase tabular-nums text-ink/70">{value.replace("#", "")}</span>
    </label>
  );
}

/* ------------------------------------------------------------------ *
 * Tool page chrome
 * ------------------------------------------------------------------ */
export function ToolTile({ tool, size = "md" }: { tool: Tool; size?: "sm" | "md" }) {
  const Icon = tool.icon;
  const cat = CATEGORIES[tool.category];
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-xl border border-ink/5",
        cat.tile,
        size === "sm" ? "h-9 w-9" : "h-11 w-11",
      )}
    >
      <Icon className={size === "sm" ? "h-4 w-4" : "h-5 w-5"} strokeWidth={1.9} />
    </div>
  );
}

const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: "⌘K / Ctrl K", label: "Search every tool" },
  { keys: "⌘↵ / Ctrl ↵", label: "Run the main action" },
  { keys: "⌘S / Ctrl S", label: "Download the finished file" },
  { keys: "?", label: "Show this shortcut list" },
  { keys: "Esc", label: "Close a preview or dialog" },
  { keys: "⇧ + click", label: "Select a range of page thumbnails" },
];

export function ToolWorkspaceShell({
  tool,
  children,
  wide = false,
  aside,
}: {
  tool: Tool;
  children: ReactNode;
  wide?: boolean;
  aside?: ReactNode;
}) {
  const cat = CATEGORIES[tool.category];
  const batchable = ["compress", "watermark", "ocr", "sanitize"].includes(tool.id);
  const { isFavorite, toggle } = useFavorites();
  const favorite = isFavorite(tool.id);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShortcutsOpen(false);
        return;
      }
      if (event.key !== "?" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      setShortcutsOpen((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <ToolIdContext.Provider value={tool.id}>
    <div className="pb-28 pt-5 md:pb-20 md:pt-7">
      <div className="container-page">
        <nav aria-label="Breadcrumb" className="mb-4 hidden items-center gap-1.5 text-[12px] text-muted sm:flex">
          <a href="/tools" className="transition-colors hover:text-forest">
            All tools
          </a>
          <span className="text-ink/70">/</span>
          <a href={`/tools?c=${toolGroup(tool.id)}`} className="transition-colors hover:text-forest">
            {groupLabel(tool.id)}
          </a>
          <span className="text-ink/70">/</span>
          <span className="font-medium text-ink/70">{tool.name}</span>
        </nav>

        {batchable && (
          <a
            href="/batch-pdf"
            className="mb-4 hidden flex-wrap items-center gap-2 rounded-xl border border-forest/15 bg-lime/20 px-3.5 py-2.5 text-[11.5px] font-medium text-forest transition-colors hover:border-forest/35 sm:flex"
          >
            <Layers className="h-3.5 w-3.5" />
            Need this across many files? Batch PDF runs compress, watermark, OCR and sanitize on multiple PDFs and returns one ZIP.
            <span className="ml-auto inline-flex items-center gap-1 font-semibold">Open batch <ArrowRight className="h-3 w-3" /></span>
          </a>
        )}

        <div className="mb-5 flex flex-col gap-4 border-b border-line pb-5 md:mb-7 md:flex-row md:items-end md:justify-between md:pb-7">
          <div className="flex items-start gap-4">
            <div className={cn("flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-ink/5", cat.tile)}>
              <tool.icon className="h-7 w-7" strokeWidth={1.8} />
            </div>
            <div>
              <h1 className="text-[26px] font-semibold leading-[1.05] tracking-[-0.035em] sm:text-[38px]">{tool.name}</h1>
              <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-muted sm:mt-2 sm:text-[15px]">{tool.tagline}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setShortcutsOpen(true)}
              aria-label="Keyboard shortcuts"
              title="Keyboard shortcuts (?)"
              className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-paper text-ink/75 transition-colors hover:border-forest/30 hover:text-forest"
            >
              <Keyboard className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-pressed={favorite}
              aria-label={favorite ? `Unpin ${tool.name}` : `Pin ${tool.name}`}
              onClick={() => toggle(tool.id)}
              title={favorite ? "Unpin from your home page" : "Pin to your home page"}
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-full border transition-colors",
                favorite ? "border-forest/25 bg-lime/40 text-forest" : "border-line bg-paper text-ink/75 hover:border-forest/30 hover:text-forest",
              )}
            >
              <Star className={cn("h-4 w-4", favorite && "fill-forest")} />
            </button>
            <div className="hidden items-center gap-2 rounded-full border border-forest/15 bg-lime/25 px-3.5 py-2 text-[11.5px] font-semibold text-forest sm:flex">
              <ShieldCheck className="h-4 w-4" />
              Documents stay on-device
            </div>
          </div>
        </div>

        <div className={cn("grid gap-7", wide ? "grid-cols-1" : "lg:grid-cols-[minmax(0,1fr)_310px]")}>
          <div className="min-w-0">
            <div className="surface p-3 sm:p-5 md:p-6" data-tool-workspace-content>{children}</div>
            {wide && <div className="mt-16 border-t border-line pt-8">{aside}</div>}
          </div>

          {!wide && (
            <aside className="mt-16 space-y-5 border-t border-line pt-8 lg:mt-0 lg:border-0 lg:pt-0">
              <div className="surface p-5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink/75">How it works</p>
                <ol className="mt-3.5 space-y-3.5">
                  {tool.steps.map((step, i) => (
                    <li key={i} className="flex gap-3">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-forest text-[11px] font-bold text-lime">
                        {i + 1}
                      </span>
                      <p className="text-[12.5px] leading-relaxed text-ink/70">{step}</p>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="rounded-2xl bg-forest p-5 text-paper">
                <CloudOff className="h-5 w-5 text-lime" />
                <p className="mt-2.5 text-[14px] font-semibold">Your file never moves.</p>
                <p className="mt-1 text-[12px] leading-relaxed text-paper/75">
                  Paperly processes everything in this tab. There’s no upload, no server copy and no file retention to worry about.
                </p>
                <a href="/privacy" className="mt-3 inline-flex items-center gap-1 text-[12px] font-semibold text-lime hover:underline">
                  How it works <ArrowRight className="h-3.5 w-3.5" />
                </a>
              </div>

              {tool.note && (
                <div className="rounded-2xl border border-line bg-bone-deep/40 p-4">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink/75">
                    <Info className="h-3.5 w-3.5" /> Good to know
                  </p>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-ink/75">{tool.note}</p>
                </div>
              )}

              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink/75">Related tools</p>
                <div className="space-y-1.5">
                  {tool.related
                    .map((id) => getTool(id))
                    .filter((t): t is Tool => Boolean(t))
                    .map((related) => (
                      <a
                        key={related.id}
                        href={toolPath(related.id)}
                        className="group flex items-center gap-2.5 rounded-xl border border-transparent px-2 py-2 transition-colors hover:border-line hover:bg-paper"
                      >
                        <ToolTile tool={related} size="sm" />
                        <span className="flex-1 text-[12.5px] font-medium">{related.name}</span>
                        <ArrowRight className="h-3.5 w-3.5 text-ink/70 transition-transform group-hover:translate-x-0.5 group-hover:text-forest" />
                      </a>
                    ))}
                </div>
              </div>
            </aside>
          )}
        </div>

        <div className="mt-16 hidden items-center justify-center gap-2 border-t border-line pt-6 text-[12px] text-muted sm:flex">
          <ShieldCheck className="h-4 w-4 text-forest" /> No sign-up. No daily limits. No watermarks on your work.
        </div>
      </div>
      {shortcutsOpen ? (
        <div
          className="fixed inset-0 z-[85] flex items-center justify-center bg-ink/60 p-4 backdrop-blur-sm"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShortcutsOpen(false);
          }}
        >
          <div role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" className="w-full max-w-sm rounded-2xl border border-line bg-paper p-5 shadow-lift">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-[16px] font-semibold">Keyboard shortcuts</h2>
                <p className="mt-1 text-[12px] text-muted">Work faster without leaving the keyboard.</p>
              </div>
              <button
                type="button"
                onClick={() => setShortcutsOpen(false)}
                aria-label="Close shortcuts"
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-line text-ink/60 hover:border-clay/40 hover:text-clay-ink"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <dl className="mt-4 divide-y divide-line">
              {SHORTCUTS.map((item) => (
                <div key={item.keys} className="flex items-center justify-between gap-3 py-2">
                  <dt className="text-[12.5px] text-ink/75">{item.label}</dt>
                  <dd>
                    <kbd className="rounded border border-line bg-bone-deep/60 px-1.5 py-0.5 font-mono text-[10.5px] text-ink/70">{item.keys}</kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      ) : null}
      <MobileActionBar />
    </div>
    </ToolIdContext.Provider>
  );
}

/* ------------------------------------------------------------------ *
 * Accordion
 * ------------------------------------------------------------------ */
const FieldLabelContext = createContext<string | undefined>(undefined);
export function useFieldLabelId() {
  return useContext(FieldLabelContext);
}

const ToolIdContext = createContext<string | null>(null);
export function useToolId() {
  return useContext(ToolIdContext);
}

const AccordionCtx = createContext<{ open: number | null; setOpen: (n: number | null) => void } | null>(null);

export function Accordion({ children, defaultOpen = null }: { children: ReactNode; defaultOpen?: number | null }) {
  const [open, setOpen] = useState<number | null>(defaultOpen);
  return (
    <AccordionCtx.Provider value={{ open, setOpen }}>
      <div className="divide-y divide-line">{children}</div>
    </AccordionCtx.Provider>
  );
}

export function AccordionItem({ index, question, children }: { index: number; question: string; children: ReactNode }) {
  const ctx = useContext(AccordionCtx)!;
  const isOpen = ctx.open === index;
  return (
    <div>
      <button
        type="button"
        onClick={() => ctx.setOpen(isOpen ? null : index)}
        aria-expanded={isOpen}
        className="flex w-full items-center justify-between gap-4 py-4 text-left"
      >
        <span className="text-[14.5px] font-medium tracking-[-0.01em]">{question}</span>
        <ChevronDown
          className={cn("h-4 w-4 shrink-0 text-ink/75 transition-transform duration-200", isOpen && "rotate-180 text-forest")}
        />
      </button>
      <div className={cn("grid transition-all duration-300", isOpen ? "grid-rows-[1fr] pb-4" : "grid-rows-[0fr]")}>
        <div className="overflow-hidden">
          <div className="max-w-2xl text-[13.5px] leading-relaxed text-muted">{children}</div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */
export function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line px-6 py-10 text-center">
      <FileText className="h-6 w-6 text-ink/20" />
      <p className="mt-2 max-w-sm text-[12.5px] leading-relaxed text-muted">{children}</p>
    </div>
  );
}

export function StepHeader({ step, title, hint }: { step: number | string; title: string; hint?: string }) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <span className="flex h-6 w-6 items-center justify-center rounded-full border border-forest/20 bg-lime/30 text-[11px] font-bold text-forest">
        {step}
      </span>
      <h3 className="text-[14px] font-semibold tracking-[-0.01em]">{title}</h3>
      {hint && <span className="text-[11.5px] text-muted">{hint}</span>}
    </div>
  );
}
