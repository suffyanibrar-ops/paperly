import { ChevronDown, RotateCcw, Settings2 } from "lucide-react";
import { useId, type ReactNode } from "react";
import { cn } from "@/utils/cn";
import { Field, inputClass } from "@/components/ui";
import { useStickyFlag } from "@/lib/prefs";

/* ------------------------------------------------------------------ *
 * Advanced-options surface
 *
 * Tools put their less-common controls inside one collapsible panel so the
 * first screen stays simple, while power users get density without a modal.
 * The open state is remembered per tool and never resets the tool options.
 * ------------------------------------------------------------------ */

export function AdvancedOptions({
  children,
  title = "Advanced options",
  description,
  badge,
  defaultOpen = false,
  scope,
  className,
  onReset,
}: {
  children: ReactNode;
  title?: string;
  description?: ReactNode;
  badge?: ReactNode;
  defaultOpen?: boolean;
  /** Stable id so the open state is remembered across visits. */
  scope: string;
  className?: string;
  onReset?: () => void;
}) {
  const [open, setOpen] = useStickyFlag(`advanced.${scope}`, defaultOpen);
  const panelId = useId();
  return (
    <section className={cn("overflow-hidden rounded-xl border border-line bg-bone-deep/25", className)}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2.5 px-3.5 py-3 text-left transition-colors hover:bg-bone-deep/40"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line bg-paper text-forest">
            <Settings2 className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-[13px] font-semibold">
              {title}
              {badge ? (
                <span className="rounded-full border border-forest/15 bg-lime/35 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-forest">
                  {badge}
                </span>
              ) : null}
            </span>
            {description ? <span className="mt-0.5 block truncate text-[11.5px] text-muted">{description}</span> : null}
          </span>
          <ChevronDown className={cn("h-4 w-4 shrink-0 text-ink/50 transition-transform duration-200", open && "rotate-180 text-forest")} />
        </button>
        {onReset ? (
          <button
            type="button"
            onClick={onReset}
            title="Reset these options to their defaults"
            aria-label="Reset options to defaults"
            className="mr-3 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink/45 transition-colors hover:bg-ink/5 hover:text-forest"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      <div id={panelId} hidden={!open} className="border-t border-line px-3.5 py-4">
        {children}
      </div>
    </section>
  );
}

/** Two-column option grid that collapses cleanly on small screens. */
export function OptionsGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid gap-x-4 gap-y-4 sm:grid-cols-2", className)}>{children}</div>;
}

/** Full-width option row inside OptionsGrid. */
export function OptionsRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("sm:col-span-2", className)}>{children}</div>;
}

export function NumberField({
  label,
  value,
  onChange,
  min = 0,
  max = 1000,
  step = 1,
  suffix,
  hint,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  const clamp = (next: number) => {
    if (!Number.isFinite(next)) return min;
    return Math.min(max, Math.max(min, next));
  };
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <div className="relative">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          className={cn(inputClass, "pr-14 tabular-nums")}
          value={Number.isFinite(value) ? value : min}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={(event) => onChange(clamp(Number(event.target.value)))}
        />
        {suffix ? (
          <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[11.5px] font-medium text-muted">
            {suffix}
          </span>
        ) : null}
      </div>
    </Field>
  );
}

export function SliderField({
  label,
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  format = (next) => String(next),
  hint,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  format?: (value: number) => string;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-[12px] font-semibold uppercase tracking-[0.06em] text-ink/70">
          {label}
        </label>
        <span className="rounded-md bg-forest/[0.07] px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-forest">
          {format(value)}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={format(value)}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-forest/15 accent-forest disabled:opacity-50 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-paper [&::-webkit-slider-thumb]:bg-forest [&::-webkit-slider-thumb]:shadow"
      />
      {hint ? <p className="text-[11px] leading-relaxed text-muted">{hint}</p> : null}
    </div>
  );
}

export interface OptionPreset<T extends string = string> {
  id: T;
  label: string;
  description?: string;
}

/** A row of one-click quality/size/layout presets. */
export function PresetChips<T extends string>({
  presets,
  value,
  onSelect,
  label = "Preset",
  className,
}: {
  presets: readonly OptionPreset<T>[];
  value: T | string;
  onSelect: (preset: OptionPreset<T>) => void;
  label?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/55">{label}</p>
      <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
        {presets.map((preset) => {
          const active = preset.id === value;
          return (
            <button
              key={preset.id}
              type="button"
              aria-pressed={active}
              title={preset.description}
              onClick={() => onSelect(preset)}
              className={cn(
                "min-h-8 rounded-lg border px-2.5 py-1 text-[11.5px] font-medium transition-colors",
                active
                  ? "border-forest bg-forest text-paper"
                  : "border-line bg-paper text-ink/70 hover:border-forest/35 hover:text-forest",
              )}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
      {presets.find((preset) => preset.id === value)?.description ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted">{presets.find((preset) => preset.id === value)?.description}</p>
      ) : null}
    </div>
  );
}

/** Small inline note used under an advanced panel. */
export function OptionNote({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "warn" }) {
  return (
    <p
      className={cn(
        "rounded-lg border px-2.5 py-2 text-[11.5px] leading-relaxed",
        tone === "warn" ? "border-amber-500/25 bg-amber-50 text-amber-900" : "border-line bg-paper text-muted",
      )}
    >
      {children}
    </p>
  );
}
