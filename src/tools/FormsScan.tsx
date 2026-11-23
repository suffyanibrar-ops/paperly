import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Camera,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  FileImage,
  FileJson,
  Plus,
  RotateCw,
  Save,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
} from "@cantoo/pdf-lib";
import {
  baseName,
  dataUrlToBytes,
  downloadBlob,
  downloadBytes,
  formatBytes,
  imageToJpegDataUrl,
  openPdfJs,
  openPdfLib,
  readFileBytes,
  renderPdfPage,
  sanitizeName,
} from "@/lib/pdf";
import { useInitialFiles, usePdfFile } from "@/lib/usePdf";
import { friendlyProcessingError, validateUpload } from "@/lib/security";
import { Alert, Badge, Button, Field, Progress, Segmented, Select, Switch, inputClass } from "@/components/ui";
import { DownloadPanel, SinglePdfInput } from "@/components/toolParts";
import { AdvancedOptions, OptionNote, OptionsGrid, PresetChips, SliderField } from "@/components/AdvancedOptions";
import { SAMPLE } from "@/lib/sample";
import { describeJobTime, useJob } from "@/lib/job";
import { useDownloadShortcut, usePrimaryShortcut } from "@/lib/hotkeys";
import { useToolPreferences } from "@/lib/prefs";
import { paperDimensions, type PaperKey } from "@/lib/layout";
import { cn } from "@/utils/cn";

/* ================================================================== *
 * FILL PDF FORMS
 * ================================================================== */
type FieldType = "text" | "checkbox" | "dropdown" | "radio" | "optionlist" | "signature" | "button";
interface FormFieldInfo {
  name: string;
  type: FieldType;
  required: boolean;
  options: string[];
}
type FieldValue = string | boolean | string[];

interface FormResult {
  bytes: Uint8Array;
  name: string;
  pages: number;
  filled: number;
  flattened: boolean;
}

/** Human label for a PDF field name: `full_name` → `Full Name`. */
function fieldLabel(name: string): string {
  return (
    name
      .replace(/[._-]+/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim() || name
  );
}

function isFieldFilled(value: FieldValue | undefined): boolean {
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.length > 0;
  return String(value ?? "").trim().length > 0;
}

function emptyValueFor(field: FormFieldInfo): FieldValue {
  if (field.type === "checkbox") return false;
  if (field.type === "optionlist") return [];
  return "";
}

type Coerced = { ok: true; value: FieldValue } | { ok: false; reason: string };

/** Turn one imported JSON value into the shape this field can hold. */
function coerceImportedValue(field: FormFieldInfo, raw: unknown): Coerced {
  if (field.type === "checkbox") {
    if (typeof raw === "boolean") return { ok: true, value: raw };
    if (typeof raw === "number") return { ok: true, value: raw !== 0 };
    if (typeof raw === "string") {
      const normalised = raw.trim().toLowerCase();
      if (["true", "yes", "on", "1", "checked", "x"].includes(normalised)) return { ok: true, value: true };
      if (["false", "no", "off", "0", "", "unchecked"].includes(normalised)) return { ok: true, value: false };
    }
    return { ok: false, reason: "expected true or false" };
  }

  if (field.type === "optionlist") {
    const list = Array.isArray(raw)
      ? raw.map((entry) => String(entry))
      : typeof raw === "string"
        ? raw.split(",").map((entry) => entry.trim()).filter(Boolean)
        : null;
    if (!list) return { ok: false, reason: "expected a list of options" };
    if (field.options.length) {
      const unknown = list.find((entry) => !field.options.includes(entry));
      if (unknown) return { ok: false, reason: `“${unknown}” isn’t one of this field’s options` };
    }
    return { ok: true, value: list };
  }

  let text: string;
  if (typeof raw === "number" || typeof raw === "boolean") text = String(raw);
  else if (typeof raw === "string") text = raw;
  else if (raw === null || raw === undefined) text = "";
  else return { ok: false, reason: "expected text" };

  const trimmed = text.trim();
  if ((field.type === "dropdown" || field.type === "radio") && trimmed && field.options.length && !field.options.includes(trimmed)) {
    return { ok: false, reason: `“${trimmed}” isn’t one of this field’s options` };
  }
  return { ok: true, value: trimmed };
}

/** Accepts `{values:…}`, `{fields:…}`, `{answers:…}` or a flat name → value map. */
function readValueMap(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["values", "fields", "answers"] as const) {
    const nested = record[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested as Record<string, unknown>;
  }
  const entries = Object.entries(record);
  if (!entries.length) return null;
  const flat = entries.every(
    ([, value]) =>
      value === null || ["string", "number", "boolean"].includes(typeof value) || Array.isArray(value),
  );
  return flat ? record : null;
}

export function FillFormsTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const opts = useToolPreferences("fill-forms", { flatten: false, highlightEmpty: true });
  const job = useJob<FormResult>();

  const [fields, setFields] = useState<FormFieldInfo[]>([]);
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [loadingFields, setLoadingFields] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const fieldsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setFields([]);
    setValues({});
    setActiveIndex(0);
    setError("");
    setNotice("");
    setConfirmClear(false);
    job.reset();
    if (!pdf.bytes) {
      setLoadingFields(false);
      return;
    }
    const bytes = pdf.bytes;
    let alive = true;
    setLoadingFields(true);
    (async () => {
      const doc = await openPdfLib(bytes);
      const form = doc.getForm();
      const infos: FormFieldInfo[] = [];
      const initialValues: Record<string, FieldValue> = {};
      for (const field of form.getFields()) {
        const name = field.getName();
        const required = field.isRequired();
        if (field instanceof PDFTextField) {
          const value = field.getText() ?? "";
          infos.push({ name, type: "text", required, options: [] });
          initialValues[name] = value;
        } else if (field instanceof PDFCheckBox) {
          const value = field.isChecked();
          infos.push({ name, type: "checkbox", required, options: [] });
          initialValues[name] = value;
        } else if (field instanceof PDFDropdown) {
          const options = field.getOptions();
          const value = field.getSelected()[0] ?? "";
          infos.push({ name, type: "dropdown", required, options });
          initialValues[name] = value;
        } else if (field instanceof PDFRadioGroup) {
          const options = field.getOptions();
          const value = field.getSelected() ?? "";
          infos.push({ name, type: "radio", required, options });
          initialValues[name] = value;
        } else if (field instanceof PDFOptionList) {
          const options = field.getOptions();
          const value = field.getSelected();
          infos.push({ name, type: "optionlist", required, options });
          initialValues[name] = value;
        } else {
          infos.push({ name, type: "signature", required, options: [] });
          initialValues[name] = "";
        }
      }
      if (!alive) return;
      setFields(infos);
      setValues(initialValues);
    })()
      .catch((err) => alive && setError((err as Error).message))
      .finally(() => alive && setLoadingFields(false));
    return () => {
      alive = false;
    };
    // `job` is a stable controller instance; it is not a dependency of this load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf.bytes]);

  const filledCount = useMemo(() => fields.filter((field) => isFieldFilled(values[field.name])).length, [fields, values]);
  const requiredMissing = useMemo(
    () => fields.filter((field) => field.required && !isFieldFilled(values[field.name])),
    [fields, values],
  );
  const byType = (type: FieldType) => fields.filter((field) => field.type === type);
  const choiceCount = byType("dropdown").length + byType("radio").length + byType("optionlist").length;

  const goToField = (index: number) => {
    if (!fields.length) return;
    const next = Math.max(0, Math.min(fields.length - 1, index));
    setActiveIndex(next);
    const container = fieldsRef.current;
    if (!container) return;
    const wrapper = container.querySelector<HTMLElement>(`[data-field-index="${next}"]`);
    wrapper?.scrollIntoView({ block: "center", behavior: "smooth" });
    wrapper
      ?.querySelector<HTMLElement>('input, select, textarea, button[role="switch"]')
      ?.focus({ preventScroll: true });
  };

  const save = () => {
    if (!pdf.bytes || !pdf.file) return;
    setError("");
    setNotice("");
    if (requiredMissing.length) {
      const names = requiredMissing.slice(0, 3).map((field) => fieldLabel(field.name)).join(", ");
      const extra = requiredMissing.length > 3 ? ` and ${requiredMissing.length - 3} more` : "";
      setError(
        `Add a value for ${requiredMissing.length} required field${requiredMissing.length === 1 ? "" : "s"} first: ${names}${extra}.`,
      );
      const firstIndex = fields.findIndex((field) => field.name === requiredMissing[0].name);
      if (firstIndex >= 0) goToField(firstIndex);
      return;
    }
    const bytesSource = pdf.bytes;
    const file = pdf.file;
    const flatten = opts.value.flatten;
    const snapshot = { ...values };
    const list = [...fields];
    void job.run(async ({ report, throwIfCancelled }) => {
      report(15, "Opening the form…");
      const doc = await openPdfLib(bytesSource);
      const form = doc.getForm();
      let written = 0;
      for (let index = 0; index < list.length; index++) {
        throwIfCancelled();
        const info = list[index];
        const value = snapshot[info.name];
        try {
          const field = form.getField(info.name);
          if (field instanceof PDFTextField) field.setText(String(value ?? ""));
          else if (field instanceof PDFCheckBox) {
            if (value) field.check();
            else field.uncheck();
          } else if (field instanceof PDFDropdown) {
            if (value) field.select(String(value));
          } else if (field instanceof PDFRadioGroup) {
            if (value) field.select(String(value));
          } else if (field instanceof PDFOptionList) {
            const selected = Array.isArray(value) ? value : value ? [String(value)] : [];
            field.select(selected);
          }
          written += 1;
        } catch {
          /* a field may be read-only or use an unsupported appearance; skip it */
        }
        if (list.length > 8 && index % 8 === 0) {
          report(15 + (index / list.length) * 45, "Writing answers…", `${index + 1} of ${list.length}`);
        }
      }
      throwIfCancelled();
      if (flatten) {
        report(70, "Flattening the answers into the page…");
        form.flatten();
      }
      report(88, "Saving the PDF…");
      const bytes = await doc.save();
      return {
        bytes,
        name: `${sanitizeName(baseName(file.name))}-${flatten ? "filled-flat" : "filled"}.pdf`,
        pages: doc.getPageCount(),
        filled: written,
        flattened: flatten,
      };
    });
  };

  const clearAll = () => {
    const cleared = fields.filter((field) => isFieldFilled(values[field.name])).length;
    const next: Record<string, FieldValue> = {};
    for (const field of fields) next[field.name] = emptyValueFor(field);
    setValues(next);
    setConfirmClear(false);
    setError("");
    setNotice(`Cleared ${cleared} filled field${cleared === 1 ? "" : "s"}. The form still has every field — add new answers and save again.`);
  };

  const exportValues = () => {
    if (!pdf.file) return;
    const payload = {
      tool: "Paperly — Fill PDF forms",
      file: pdf.file.name,
      pages: pdf.pageCount,
      exportedAt: new Date().toISOString(),
      values,
    };
    const name = `${sanitizeName(baseName(pdf.file.name))}-values.json`;
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), name);
  };

  const importValues = async (file: File) => {
    setError("");
    setNotice("");
    try {
      if (file.size > 2 * 1024 * 1024) {
        throw new Error("That file is larger than 2 MB — check that you picked the values JSON.");
      }
      const payload: unknown = JSON.parse(await file.text());
      const map = readValueMap(payload);
      if (!map) {
        throw new Error('Expected a JSON object of field names to values, for example {"values": {"full_name": "Alex Morgan"}}.');
      }
      const next: Record<string, FieldValue> = { ...values };
      const skipped: string[] = [];
      let applied = 0;
      for (const field of fields) {
        if (!(field.name in map)) continue;
        const result = coerceImportedValue(field, map[field.name]);
        if (result.ok) {
          next[field.name] = result.value;
          applied += 1;
        } else {
          skipped.push(`${fieldLabel(field.name)}: ${result.reason}`);
        }
      }
      const unmatched = Object.keys(map).filter((name) => !fields.some((field) => field.name === name));
      setValues(next);
      const parts = [`Imported ${applied} value${applied === 1 ? "" : "s"}`];
      if (skipped.length) parts.push(`${skipped.length} skipped (${skipped.slice(0, 2).join("; ")})`);
      if (unmatched.length) parts.push(`${unmatched.length} name${unmatched.length === 1 ? "" : "s"} not in this form`);
      setNotice(`${parts.join(" · ")}. Review the answers, then save.`);
    } catch (err) {
      setError(`Those values couldn’t be read: ${(err as Error).message}`);
    }
  };

  const result = job.result;
  usePrimaryShortcut(save, Boolean(pdf.bytes) && fields.length > 0 && !job.busy);
  useDownloadShortcut(() => {
    if (result) downloadBytes(result.bytes, result.name);
  }, Boolean(result));

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF with form fields" />
      {loadingFields && (
        <div className="flex items-center gap-2 text-[12px] text-muted">Reading interactive fields…</div>
      )}

      {pdf.bytes && !loadingFields && fields.length === 0 && (
        <Alert tone="info" title="No interactive fields found">
          This PDF doesn’t contain a standard AcroForm. Paperly can’t infer a fillable form from a flat page — use the{" "}
          <a href="/edit-pdf" className="font-semibold underline">
            Edit PDF
          </a>{" "}
          or{" "}
          <a href="/sign-pdf" className="font-semibold underline">
            Sign PDF
          </a>{" "}
          tool to place text boxes or a signature instead.
        </Alert>
      )}

      {fields.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="forest">
              {fields.length} field{fields.length === 1 ? "" : "s"}
            </Badge>
            {byType("text").length > 0 && <Badge>{byType("text").length} text</Badge>}
            {byType("checkbox").length > 0 && <Badge>{byType("checkbox").length} checkbox</Badge>}
            {choiceCount > 0 && <Badge>{choiceCount} choice</Badge>}
            {requiredMissing.length > 0 && <Badge tone="clay">{requiredMissing.length} required empty</Badge>}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-bone-deep/30 px-3.5 py-2.5">
            <div className="min-w-0">
              <p className="text-[12.5px] font-semibold">
                {filledCount} of {fields.length} fields filled
              </p>
              <p className="mt-0.5 text-[11px] text-muted">
                {requiredMissing.length > 0
                  ? `${requiredMissing.length} required field${requiredMissing.length === 1 ? "" : "s"} still empty — fill them before saving.`
                  : fields.some((field) => field.required)
                    ? "Every required field has an answer."
                    : "This form has no required fields."}
              </p>
            </div>
            <div className="h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-forest/10" aria-hidden="true">
              <div
                className="h-full rounded-full bg-forest transition-all"
                style={{ width: `${fields.length ? Math.round((filledCount / fields.length) * 100) : 0}%` }}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => goToField(activeIndex - 1)} disabled={activeIndex <= 0}>
              <ArrowLeft className="h-3.5 w-3.5" /> Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => goToField(activeIndex + 1)}
              disabled={activeIndex >= fields.length - 1}
            >
              Next <ArrowRight className="h-3.5 w-3.5" />
            </Button>
            <span className="text-[11.5px] text-muted">
              Field {Math.min(activeIndex + 1, fields.length)} of {fields.length}
              {fields[activeIndex] ? ` · ${fieldLabel(fields[activeIndex].name)}` : ""}
            </span>
            <label className="ml-auto flex items-center gap-1.5 text-[11.5px] text-muted">
              <span className="sr-only">Jump to a field</span>
              <Select
                aria-label="Jump to a field"
                value={String(Math.min(activeIndex, fields.length - 1))}
                onChange={(event) => goToField(Number(event.target.value))}
                className="h-8 py-0 text-[12px]"
              >
                {fields.map((field, index) => (
                  <option key={field.name} value={String(index)}>
                    {index + 1}. {fieldLabel(field.name)}
                    {isFieldFilled(values[field.name]) ? " ✓" : ""}
                  </option>
                ))}
              </Select>
            </label>
          </div>

          <div ref={fieldsRef} className="grid gap-3 sm:grid-cols-2">
            {fields.map((field, index) => {
              const value = values[field.name];
              const displayName = fieldLabel(field.name);
              const unfilledRequired = field.required && !isFieldFilled(value);
              const wrapper = cn(
                "rounded-xl transition-shadow",
                (field.type === "checkbox" || field.type === "optionlist") && "sm:col-span-2",
                index === activeIndex && "ring-2 ring-forest/20",
                opts.value.highlightEmpty && unfilledRequired && "ring-1 ring-clay/40",
              );
              const onFocus = () => setActiveIndex(index);
              const requiredMark = field.required ? <span className="text-clay-ink">*</span> : null;
              if (field.type === "checkbox") {
                return (
                  <div key={field.name} data-field-index={index} className={wrapper} onFocusCapture={onFocus}>
                    <Switch
                      checked={Boolean(value)}
                      onChange={(checked) => {
                        setValues((current) => ({ ...current, [field.name]: checked }));
                        setNotice("");
                      }}
                      label={field.required ? `${displayName} *` : displayName}
                      description={`Checkbox${field.required ? " · required" : ""}`}
                    />
                  </div>
                );
              }
              if (field.type === "optionlist") {
                const selected = Array.isArray(value) ? value : value ? [String(value)] : [];
                return (
                  <div key={field.name} data-field-index={index} className={wrapper} onFocusCapture={onFocus}>
                    <Field
                      label={
                        <>
                          {displayName} {requiredMark}
                        </>
                      }
                      hint="Hold Ctrl/Cmd to select more than one option."
                    >
                      <select
                        multiple
                        size={Math.min(5, Math.max(3, field.options.length))}
                        value={selected}
                        aria-label={displayName}
                        onChange={(e) => {
                          const next = Array.from(e.target.selectedOptions).map((option) => option.value);
                          setValues((current) => ({ ...current, [field.name]: next }));
                        }}
                        className="w-full rounded-xl border border-line bg-paper px-2 py-2 text-[13px] focus:border-forest/50 focus:outline-none focus:ring-2 focus:ring-forest/10"
                      >
                        {field.options.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                );
              }
              if (field.type === "dropdown" || field.type === "radio") {
                return (
                  <div key={field.name} data-field-index={index} className={wrapper} onFocusCapture={onFocus}>
                    <Field
                      label={
                        <>
                          {displayName} {requiredMark}
                        </>
                      }
                    >
                      <Select
                        aria-label={displayName}
                        value={Array.isArray(value) ? value[0] ?? "" : String(value ?? "")}
                        onChange={(e) => setValues((current) => ({ ...current, [field.name]: e.target.value }))}
                      >
                        <option value="">Choose…</option>
                        {field.options.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                );
              }
              if (field.type === "signature") {
                return (
                  <div key={field.name} data-field-index={index} className={wrapper} onFocusCapture={onFocus}>
                    <Field
                      label={displayName}
                      hint="Signature fields can’t be typed into. Use the Sign PDF tool to place a signature image."
                    >
                      <div className="flex h-11 items-center rounded-xl border border-dashed border-line bg-bone-deep/30 px-3 text-[12px] text-muted">
                        Use Sign PDF
                      </div>
                    </Field>
                  </div>
                );
              }
              return (
                <div key={field.name} data-field-index={index} className={wrapper} onFocusCapture={onFocus}>
                  <Field
                    label={
                      <>
                        {displayName} {requiredMark}
                      </>
                    }
                  >
                    <input
                      value={String(value ?? "")}
                      onChange={(e) => setValues((current) => ({ ...current, [field.name]: e.target.value }))}
                      className={inputClass}
                      aria-label={displayName}
                      placeholder={`Enter ${displayName.toLowerCase()}`}
                    />
                  </Field>
                </div>
              );
            })}
          </div>

          <AdvancedOptions
            scope="fill-forms"
            badge="3 controls"
            description="How the filled file is saved"
            onReset={opts.reset}
          >
            <div className="space-y-3">
              <PresetChips
                label="What the saved copy is for"
                value={opts.value.flatten ? "archival" : "editable"}
                presets={[
                  {
                    id: "editable",
                    label: "Editable form",
                    description: "Answers are written into the fields; the form can still be filled in and edited.",
                  },
                  {
                    id: "archival",
                    label: "Archival copy",
                    description: "Answers are flattened into the page and locked — the archival default.",
                  },
                ]}
                onSelect={(preset) => opts.set("flatten", preset.id === "archival")}
              />
              <Switch
                checked={opts.value.flatten}
                onChange={(value) => opts.set("flatten", value)}
                label="Flatten after filling"
                description="Bakes the answers into the page so they can’t be edited again — best for archival copies"
              />
              <Switch
                checked={opts.value.highlightEmpty}
                onChange={(value) => opts.set("highlightEmpty", value)}
                label="Outline empty required fields"
                description="Draws attention to required fields that still need an answer"
              />
              <OptionNote>
                Flattening is off by default so the saved PDF stays a working form. Choose it when the copy is final.
              </OptionNote>
            </div>
          </AdvancedOptions>

          {error && <Alert tone="error">{error}</Alert>}
          {notice && <Alert tone="success">{notice}</Alert>}
          {job.failed && <Alert tone="error">{job.error}</Alert>}
          {job.status === "cancelled" && <Alert tone="info">Cancelled — the previous result is unchanged.</Alert>}

          {job.busy && (
            <Progress value={job.percent ?? undefined} label={job.label} detail={describeJobTime(job)} />
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={save} loading={job.busy} disabled={job.busy}>
              <ClipboardCheck className="h-4 w-4" /> Save filled PDF
            </Button>
            <label className="inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-xl border border-line bg-paper px-3.5 text-[12.5px] font-medium text-ink/75 transition-colors hover:border-forest/30">
              <Upload className="h-3.5 w-3.5" /> Import values
              <input
                type="file"
                accept="application/json,.json"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void importValues(file);
                }}
              />
            </label>
            <Button variant="outline" onClick={exportValues} disabled={!fields.length}>
              <FileJson className="h-4 w-4" /> Export values
            </Button>
            {confirmClear ? (
              <span className="flex flex-wrap items-center gap-1.5 rounded-xl border border-clay/30 bg-clay/[0.05] px-2 py-1.5">
                <span className="text-[11.5px] font-medium text-clay-ink">Clear every answer?</span>
                <Button variant="outline" size="sm" onClick={clearAll}>
                  Clear all answers
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmClear(false)}>
                  Keep them
                </Button>
              </span>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmClear(true)} disabled={filledCount === 0}>
                <Trash2 className="h-4 w-4" /> Clear all
              </Button>
            )}
            <span className="text-[11.5px] text-muted">Answers are written locally and never uploaded.</span>
          </div>
        </>
      )}

      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Form saved"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${result.filled} field${result.filled === 1 ? "" : "s"} in the form · answers saved${
            result.flattened ? " · flattened and locked" : " · still editable"
          }`}
          facts={[
            { label: "Fields written", value: String(result.filled) },
            { label: "Flattened", value: result.flattened ? "Yes" : "No" },
          ]}
        />
      )}
    </div>
  );
}

/* ================================================================== *
 * SCAN TO PDF
 * ================================================================== */
interface Capture {
  id: string;
  dataUrl: string;
  rotation: number;
  width: number;
  height: number;
}

type ScanFilter = "colour" | "grayscale" | "bw";
type ScanOrientation = "auto" | "portrait" | "landscape";

interface ScanResult {
  bytes: Uint8Array;
  name: string;
  pages: number;
  cleanUp: string;
  layout: string;
}

/** Apply the clean-up filters to raw canvas pixels, in place. */
function applyScanFilters(
  image: ImageData,
  filter: ScanFilter,
  threshold: number,
  contrastValue: number,
  brightnessValue: number,
): void {
  const data = image.data;
  const contrast = contrastValue * 2.55;
  const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
  const shift = brightnessValue * 2.55;
  const adjust = contrastValue !== 0 || brightnessValue !== 0;
  for (let index = 0; index < data.length; index += 4) {
    let red = data[index];
    let green = data[index + 1];
    let blue = data[index + 2];
    if (filter === "grayscale" || filter === "bw") {
      const luma = 0.299 * red + 0.587 * green + 0.114 * blue;
      if (filter === "bw") {
        const level = luma >= threshold ? 255 : 0;
        red = level;
        green = level;
        blue = level;
      } else {
        red = luma;
        green = luma;
        blue = luma;
      }
    }
    if (adjust) {
      red = Math.max(0, Math.min(255, factor * (red - 128) + 128 + shift));
      green = Math.max(0, Math.min(255, factor * (green - 128) + 128 + shift));
      blue = Math.max(0, Math.min(255, factor * (blue - 128) + 128 + shift));
    }
    data[index] = red;
    data[index + 1] = green;
    data[index + 2] = blue;
  }
}

/** Burn the per-page rotation in and apply the clean-up filters. */
async function renderCapture(
  capture: Capture,
  options: { filter: ScanFilter; threshold: number; contrast: number; brightness: number },
): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(await (await fetch(capture.dataUrl)).blob());
  const rotated = capture.rotation === 90 || capture.rotation === 270;
  const canvas = document.createElement("canvas");
  canvas.width = rotated ? bitmap.height : bitmap.width;
  canvas.height = rotated ? bitmap.width : bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close?.();
    throw new Error("This browser can’t process images. Try a recent version of Chrome, Firefox, Edge or Safari.");
  }
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((capture.rotation * Math.PI) / 180);
  ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  bitmap.close?.();
  if (options.filter !== "colour" || options.contrast !== 0 || options.brightness !== 0) {
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    applyScanFilters(image, options.filter, options.threshold, options.contrast, options.brightness);
    ctx.putImageData(image, 0, 0);
  }
  return canvas;
}

const SCAN_PRESETS = [
  { id: "colour", label: "Original colour", description: "Keeps the photo exactly as captured — good for receipts with colour marks." },
  { id: "document", label: "Document", description: "Grayscale with a gentle contrast lift. Reads well for printed pages." },
  { id: "text", label: "Black & white text", description: "Thresholds every pixel to black or white. Smallest, sharpest text scans." },
  { id: "photo", label: "Faded photo", description: "Extra contrast and brightness for washed-out phone photos." },
] as const;
type ScanPresetId = (typeof SCAN_PRESETS)[number]["id"];

export function ScanTool() {
  const initial = useInitialFiles();
  const initialLoaded = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const opts = useToolPreferences("scan", {
    paper: "a4" as PaperKey | "fit",
    orientation: "auto" as ScanOrientation,
    margin: 10,
    quality: 88,
    filter: "colour" as ScanFilter,
    threshold: 160,
    contrast: 0,
    brightness: 0,
  });
  const job = useJob<ScanResult>();

  const [cameraOn, setCameraOn] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [error, setError] = useState("");
  const [sampleBusy, setSampleBusy] = useState(false);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
  };

  useEffect(() => () => stopCamera(), []);

  const startCamera = async () => {
    setStarting(true);
    setCameraError("");
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("This browser doesn’t support camera capture. Use “Add photos” instead.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1440 } },
        audio: false,
      });
      streamRef.current = stream;
      setCameraOn(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
    } catch (err) {
      const name = (err as Error)?.name ?? "";
      setCameraError(
        name === "NotAllowedError"
          ? "Camera permission was denied. Allow camera access for this site, or add photos from your device instead."
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? "No camera was found. You can add photos or scans from your device instead."
            : (err as Error).message || "The camera couldn’t be started on this device.",
      );
      setCameraOn(false);
    } finally {
      setStarting(false);
    }
  };

  const capture = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    const ratio = Math.min(1, 2200 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * ratio);
    canvas.height = Math.round(video.videoHeight * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    setCaptures((list) => [
      ...list,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        dataUrl: canvas.toDataURL("image/jpeg", 0.92),
        rotation: 0,
        width: canvas.width,
        height: canvas.height,
      },
    ]);
  };

  const addFiles = async (files: File[]) => {
    setError("");
    const images = files.filter(
      (file) => file.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|avif)$/i.test(file.name),
    );
    const pdfs = files.filter((file) => file.type === "application/pdf" || /\.pdf$/i.test(file.name));
    if (!images.length && !pdfs.length) {
      setError("Add photos in JPG, PNG or WebP format, or a PDF.");
      return;
    }
    try {
      const next: Capture[] = [];
      for (const file of images) {
        await validateUpload(file, "image/jpeg,image/png,image/webp,image/avif,.jpg,.jpeg,.png,.webp,.avif");
        const jpeg = await imageToJpegDataUrl(file, 2400, 0.92);
        next.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          dataUrl: jpeg.dataUrl,
          rotation: 0,
          width: jpeg.width,
          height: jpeg.height,
        });
      }
      for (const file of pdfs) {
        await validateUpload(file, "application/pdf,.pdf");
        const doc = await openPdfJs(await readFileBytes(file));
        for (let page = 1; page <= Math.min(doc.numPages, 50); page++) {
          const rendered = await renderPdfPage(doc, page, { targetWidth: 1800, type: "image/jpeg", quality: 0.9 });
          next.push({
            id: `${Date.now()}-${page}-${Math.random().toString(36).slice(2, 6)}`,
            dataUrl: rendered.dataUrl,
            rotation: 0,
            width: rendered.width,
            height: rendered.height,
          });
        }
        await doc.destroy().catch(() => undefined);
      }
      setCaptures((list) => [...list, ...next]);
    } catch (err) {
      setError(friendlyProcessingError(err, "One of those files couldn’t be read. Try a JPG, PNG or PDF."));
    }
  };

  useEffect(() => {
    if (initialLoaded.current || !initial.length) return;
    initialLoaded.current = true;
    void addFiles(initial);
  }, [initial]);

  const addSampleScan = async () => {
    setSampleBusy(true);
    setError("");
    try {
      const file = await SAMPLE.image.create();
      await addFiles([file]);
    } catch (err) {
      setError(friendlyProcessingError(err, "The sample scan couldn’t be created in this browser."));
    } finally {
      setSampleBusy(false);
    }
  };

  const rotate = (id: string) => {
    setCaptures((list) => list.map((c) => (c.id === id ? { ...c, rotation: (c.rotation + 90) % 360 } : c)));
  };

  const rotateAll = () => {
    setCaptures((list) => list.map((c) => ({ ...c, rotation: (c.rotation + 90) % 360 })));
  };

  const move = (id: string, delta: -1 | 1) => {
    setCaptures((list) => {
      const index = list.findIndex((c) => c.id === id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= list.length) return list;
      const next = [...list];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
  };

  const activePreset: ScanPresetId =
    opts.value.filter === "colour"
      ? "colour"
      : opts.value.filter === "bw"
        ? "text"
        : opts.value.contrast >= 20
          ? "photo"
          : "document";

  const applyPreset = (preset: (typeof SCAN_PRESETS)[number]) => {
    if (preset.id === "colour") opts.patch({ filter: "colour", threshold: 160, contrast: 0, brightness: 0 });
    else if (preset.id === "document") opts.patch({ filter: "grayscale", threshold: 160, contrast: 12, brightness: 4 });
    else if (preset.id === "text") opts.patch({ filter: "bw", threshold: 165, contrast: 0, brightness: 0 });
    else opts.patch({ filter: "grayscale", threshold: 160, contrast: 28, brightness: 12 });
  };

  const create = () => {
    if (!captures.length) {
      setError("Capture at least one page first.");
      return;
    }
    const list = [...captures];
    const settings = {
      filter: opts.value.filter,
      threshold: opts.value.threshold,
      contrast: opts.value.contrast,
      brightness: opts.value.brightness,
    };
    const paper = opts.value.paper;
    const orientation = opts.value.orientation;
    const margin = opts.value.margin;
    const quality = opts.value.quality;
    setError("");
    void job.run(async ({ step, throwIfCancelled }) => {
      const doc = await PDFDocument.create();
      const marginPt = margin * 2.834645669;
      for (let index = 0; index < list.length; index++) {
        throwIfCancelled();
        const capture = list[index];
        const canvas = await renderCapture(capture, settings);
        throwIfCancelled();
        const processed = canvas.toDataURL("image/jpeg", quality / 100);
        const image = await doc.embedJpg(dataUrlToBytes(processed));
        if (paper === "fit") {
          const page = doc.addPage([canvas.width * 0.75, canvas.height * 0.75]);
          page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
        } else {
          const pageOrientation =
            orientation === "auto" ? (canvas.height >= canvas.width ? "portrait" : "landscape") : orientation;
          const base = paperDimensions(paper, pageOrientation);
          const page = doc.addPage([base.w, base.h]);
          const boxW = Math.max(20, base.w - marginPt * 2);
          const boxH = Math.max(20, base.h - marginPt * 2);
          const scale = Math.min(boxW / canvas.width, boxH / canvas.height);
          const width = canvas.width * scale;
          const height = canvas.height * scale;
          page.drawImage(image, { x: (base.w - width) / 2, y: (base.h - height) / 2, width, height });
        }
        step(index + 1, list.length, `Building page ${index + 1} of ${list.length}…`);
      }
      throwIfCancelled();
      const bytes = await doc.save();
      return {
        bytes,
        name: `paperly-scan-${new Date().toISOString().slice(0, 10)}.pdf`,
        pages: list.length,
        cleanUp:
          settings.filter === "bw" ? "Black & white" : settings.filter === "grayscale" ? "Grayscale" : "Colour",
        layout: paper === "fit" ? "Fit to photo" : `${paper.toUpperCase()} · ${orientation}`,
      };
    });
  };

  const result = job.result;
  usePrimaryShortcut(create, captures.length > 0 && !job.busy);
  useDownloadShortcut(() => {
    if (result) downloadBytes(result.bytes, result.name);
  }, Boolean(result));

  const cleanUpActive =
    opts.value.filter !== "colour" || opts.value.contrast !== 0 || opts.value.brightness !== 0;

  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="space-y-3">
          <div className="relative overflow-hidden rounded-xl border border-line bg-ink">
            {cameraOn ? (
              <video ref={videoRef} playsInline muted className="aspect-[4/3] w-full object-cover" aria-label="Camera preview" />
            ) : (
              <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-3 bg-ink px-6 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-lime text-forest">
                  <Camera className="h-6 w-6" />
                </div>
                <div>
                  <p className="text-[14px] font-semibold text-paper">Scan with your camera</p>
                  <p className="mx-auto mt-1 max-w-xs text-[11.5px] leading-relaxed text-paper/70">
                    Capture receipts, forms or notes and turn them into a clean PDF. Frames never leave your device.
                  </p>
                </div>
                <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
                  <Button variant="accent" size="sm" onClick={startCamera} loading={starting}>
                    <Camera className="h-3.5 w-3.5" /> Start camera
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void addSampleScan()}
                    loading={sampleBusy}
                    className="border-paper/25 bg-transparent text-paper hover:bg-paper/10"
                  >
                    Try a sample scan
                  </Button>
                </div>
              </div>
            )}
            {cameraOn && (
              <div className="pointer-events-none absolute inset-4 rounded-lg border border-lime/40" aria-hidden="true" />
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {cameraOn ? (
              <>
                <Button onClick={capture} className="gap-2">
                  <Camera className="h-4 w-4" /> Capture page
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    stopCamera();
                    setCameraError("");
                  }}
                >
                  Stop camera
                </Button>
                <span className="text-[11.5px] text-muted">Keep the page inside the frame and fill the shot.</span>
              </>
            ) : (
              <>
                <label className="inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-xl bg-ink px-4 text-[12.5px] font-medium text-paper hover:bg-forest-soft">
                  <Plus className="h-4 w-4" /> Add photos
                  <input
                    type="file"
                    accept="application/pdf,image/*,.pdf,.jpg,.jpeg,.png,.webp,.avif"
                    multiple
                    className="sr-only"
                    onChange={(e) => {
                      if (e.target.files?.length) void addFiles(Array.from(e.target.files));
                      e.target.value = "";
                    }}
                  />
                </label>
                <label className="inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-xl border border-line bg-paper px-4 text-[12.5px] font-medium">
                  <FileImage className="h-4 w-4" /> Use device camera
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="sr-only"
                    onChange={(e) => {
                      if (e.target.files?.length) void addFiles(Array.from(e.target.files));
                      e.target.value = "";
                    }}
                  />
                </label>
              </>
            )}
          </div>
          {cameraError && (
            <Alert tone="warning" title="Camera unavailable">
              {cameraError}
            </Alert>
          )}

          {captures.length > 0 && (
            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">
                  Scanned pages · {captures.length}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={rotateAll}
                    className="text-[11px] font-medium text-ink/70 hover:text-forest hover:underline"
                  >
                    Rotate all
                  </button>
                  <button
                    type="button"
                    onClick={() => setCaptures([])}
                    className="text-[11px] font-medium text-clay-ink hover:underline"
                  >
                    Clear all
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {captures.map((capture, index) => (
                  <div key={capture.id} className="group relative overflow-hidden rounded-lg border border-line bg-white">
                    <div className="flex aspect-[3/4] items-center justify-center bg-bone-deep/40 p-1.5">
                      <img
                        src={capture.dataUrl}
                        alt={`Scan ${index + 1}`}
                        className="max-h-full max-w-full object-contain transition-transform"
                        style={{ transform: `rotate(${capture.rotation}deg)` }}
                      />
                    </div>
                    <div className="flex items-center justify-between border-t border-line px-1.5 py-1">
                      <span className="text-[10.5px] font-semibold tabular-nums text-ink/70">
                        #{index + 1}
                        {capture.rotation ? ` · ${capture.rotation}°` : ""}
                      </span>
                      <div className="flex">
                        <button
                          type="button"
                          onClick={() => move(capture.id, -1)}
                          disabled={index === 0}
                          aria-label={`Move scan ${index + 1} earlier`}
                          className="rounded p-1 text-ink/75 hover:bg-forest/10 hover:text-forest disabled:opacity-30"
                        >
                          <ChevronLeft className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => move(capture.id, 1)}
                          disabled={index === captures.length - 1}
                          aria-label={`Move scan ${index + 1} later`}
                          className="rounded p-1 text-ink/75 hover:bg-forest/10 hover:text-forest disabled:opacity-30"
                        >
                          <ChevronRight className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => rotate(capture.id)}
                          aria-label={`Rotate scan ${index + 1}`}
                          className="rounded p-1 text-ink/75 hover:bg-forest/10 hover:text-forest"
                        >
                          <RotateCw className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setCaptures((list) => list.filter((c) => c.id !== capture.id))}
                          aria-label={`Delete scan ${index + 1}`}
                          className="rounded p-1 text-ink/75 hover:bg-clay/10 hover:text-clay-ink"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <AdvancedOptions
            scope="scan"
            badge="5 controls"
            description="Clean-up, contrast and threshold"
            onReset={opts.reset}
          >
            <div className="space-y-4">
              <PresetChips
                label="Clean-up preset"
                value={activePreset}
                presets={SCAN_PRESETS}
                onSelect={(preset) => {
                  const match = SCAN_PRESETS.find((item) => item.id === preset.id);
                  if (match) applyPreset(match);
                }}
              />
              <Field label="Colour treatment">
                <Segmented
                  value={opts.value.filter}
                  onChange={(value) => opts.set("filter", value)}
                  size="sm"
                  options={[
                    { value: "colour", label: "Colour" },
                    { value: "grayscale", label: "Grayscale" },
                    { value: "bw", label: "Black & white" },
                  ]}
                />
              </Field>
              <OptionsGrid>
                <SliderField
                  label="Black point"
                  value={opts.value.threshold}
                  onChange={(value) => opts.set("threshold", value)}
                  min={40}
                  max={230}
                  format={(value) => `${value}`}
                  hint="Pixels darker than this become pure black. Only used in black & white."
                  disabled={opts.value.filter !== "bw"}
                />
                <SliderField
                  label="Contrast"
                  value={opts.value.contrast}
                  onChange={(value) => opts.set("contrast", value)}
                  min={-60}
                  max={80}
                  format={(value) => `${value > 0 ? "+" : ""}${value}`}
                />
                <SliderField
                  label="Brightness"
                  value={opts.value.brightness}
                  onChange={(value) => opts.set("brightness", value)}
                  min={-60}
                  max={80}
                  format={(value) => `${value > 0 ? "+" : ""}${value}`}
                />
                <div className="flex items-end">
                  <OptionNote>{cleanUpActive ? "Clean-up is applied to every page when you create the PDF." : "No clean-up applied — the photos are converted as captured."}</OptionNote>
                </div>
              </OptionsGrid>
            </div>
          </AdvancedOptions>

          {error && <Alert tone="error">{error}</Alert>}
          {job.failed && <Alert tone="error">{job.error}</Alert>}
          {job.status === "cancelled" && <Alert tone="info">Cancelled — nothing was downloaded.</Alert>}
          {job.busy && <Progress value={job.percent ?? undefined} label={job.label} detail={describeJobTime(job)} />}
        </div>

        <aside className="space-y-3">
          <div className="rounded-xl border border-line bg-paper p-3.5">
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">Output</p>
            <div className="space-y-3">
              <Field label="Page size">
                <Select
                  value={opts.value.paper}
                  onChange={(e) => opts.set("paper", e.target.value as PaperKey | "fit")}
                >
                  <option value="a4">A4</option>
                  <option value="letter">US Letter</option>
                  <option value="legal">US Legal</option>
                  <option value="fit">Fit to each photo</option>
                </Select>
              </Field>
              <Field label="Orientation">
                <Select
                  value={opts.value.orientation}
                  disabled={opts.value.paper === "fit"}
                  onChange={(e) => opts.set("orientation", e.target.value as ScanOrientation)}
                >
                  <option value="auto">Match each photo</option>
                  <option value="portrait">Portrait</option>
                  <option value="landscape">Landscape</option>
                </Select>
              </Field>
              <Field label="Margin" hint={opts.value.paper === "fit" ? "No margin in fit mode" : `${opts.value.margin} mm`}>
                <input
                  type="range"
                  min={0}
                  max={30}
                  value={opts.value.margin}
                  disabled={opts.value.paper === "fit"}
                  aria-label="Page margin in millimetres"
                  onChange={(e) => opts.set("margin", Number(e.target.value))}
                  className="w-full accent-[#1c4c3b] disabled:opacity-40"
                />
              </Field>
              <Field label={`JPG quality · ${opts.value.quality}%`}>
                <input
                  type="range"
                  min={55}
                  max={100}
                  step={1}
                  value={opts.value.quality}
                  aria-label="JPEG quality percentage"
                  onChange={(e) => opts.set("quality", Number(e.target.value))}
                  className="w-full accent-[#1c4c3b]"
                />
              </Field>
            </div>
          </div>
          <div className="rounded-xl border border-forest/15 bg-lime/20 p-3 text-[11px] leading-relaxed text-forest">
            <p className="font-semibold">A note on scans</p>
            <p className="mt-1 text-forest/90">
              Camera captures are images, not OCR. Add the OCR tool afterwards if you need searchable text. Keep each page flat and
              well lit for the crispest result.
            </p>
          </div>
          <div className="space-y-2">
            <Button onClick={create} loading={job.busy} disabled={!captures.length || job.busy} className="w-full">
              <Save className="h-4 w-4" /> Create PDF
            </Button>
            {job.busy && (
              <Button variant="outline" onClick={job.cancel} className="w-full">
                Cancel
              </Button>
            )}
          </div>
          {captures.length > 0 && (
            <p className="text-center text-[11px] text-muted">
              {captures.length} page{captures.length === 1 ? "" : "s"} queued · ⌘/Ctrl+Enter to build
            </p>
          )}
        </aside>
      </div>

      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Scan saved as PDF"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${result.pages} captured page${result.pages === 1 ? "" : "s"} · ${formatBytes(result.bytes.byteLength)} · images stay on your device`}
          facts={[
            { label: "Clean-up", value: result.cleanUp },
            { label: "Layout", value: result.layout },
          ]}
        />
      )}
      {!captures.length && (
        <div className="flex items-start gap-2 rounded-xl border border-dashed border-line bg-bone-deep/25 px-3.5 py-3 text-[11.5px] leading-relaxed text-muted">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Cameras require a secure (https) page and permission. If yours is unavailable, the “Add photos” option works everywhere and
          produces the same PDF.
        </div>
      )}
    </div>
  );
}
