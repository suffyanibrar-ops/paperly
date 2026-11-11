import { AlertCircle, Camera, ClipboardCheck, FileImage, Loader2, Plus, RotateCw, Save, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PDFCheckBox, PDFDocument, PDFDropdown, PDFOptionList, PDFRadioGroup, PDFTextField } from "@cantoo/pdf-lib";
import {
  baseName,
  dataUrlToBytes,
  downloadBytes,
  formatBytes,
  imageToJpegDataUrl,
  openPdfLib,
  sanitizeName,
} from "@/lib/pdf";
import { useInitialFiles, usePdfFile } from "@/lib/usePdf";
import { friendlyProcessingError, validateUpload } from "@/lib/security";
import { Alert, Badge, Button, Field, Progress, Select, Switch, inputClass } from "@/components/ui";
import { DownloadPanel, SinglePdfInput } from "@/components/toolParts";
import { paperDimensions, type PaperKey } from "@/lib/layout";

/* ================================================================== *
 * FILL PDF FORMS
 * ================================================================== */
type FieldType = "text" | "checkbox" | "dropdown" | "radio" | "optionlist" | "signature" | "button";
interface FormFieldInfo {
  name: string;
  type: FieldType;
  required: boolean;
  options: string[];
  value: string | boolean | string[];
}
type FieldValue = string | boolean | string[];

export function FillFormsTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [fields, setFields] = useState<FormFieldInfo[]>([]);
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [loadingFields, setLoadingFields] = useState(false);
  const [flatten, setFlatten] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; pages: number; filled: number } | null>(null);

  useEffect(() => {
    if (!pdf.bytes) {
      setFields([]);
      setValues({});
      return;
    }
    let alive = true;
    setLoadingFields(true);
    setError("");
    setResult(null);
    (async () => {
      const doc = await openPdfLib(pdf.bytes as ArrayBuffer);
      const form = doc.getForm();
      const infos: FormFieldInfo[] = [];
      const initialValues: Record<string, FieldValue> = {};
      for (const field of form.getFields()) {
        const name = field.getName();
        const required = field.isRequired();
        if (field instanceof PDFTextField) {
          const value = field.getText() ?? "";
          infos.push({ name, type: "text", required, options: [], value });
          initialValues[name] = value;
        } else if (field instanceof PDFCheckBox) {
          const value = field.isChecked();
          infos.push({ name, type: "checkbox", required, options: [], value });
          initialValues[name] = value;
        } else if (field instanceof PDFDropdown) {
          const options = field.getOptions();
          const value = field.getSelected()[0] ?? "";
          infos.push({ name, type: "dropdown", required, options, value });
          initialValues[name] = value;
        } else if (field instanceof PDFRadioGroup) {
          const options = field.getOptions();
          const value = field.getSelected() ?? "";
          infos.push({ name, type: "radio", required, options, value });
          initialValues[name] = value;
        } else if (field instanceof PDFOptionList) {
          const options = field.getOptions();
          const value = field.getSelected();
          infos.push({ name, type: "optionlist", required, options, value });
          initialValues[name] = value;
        } else {
          infos.push({ name, type: "signature", required, options: [], value: "" });
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
  }, [pdf.bytes]);

  const save = async () => {
    if (!pdf.bytes || !pdf.file) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const doc = await openPdfLib(pdf.bytes);
      const form = doc.getForm();
      for (const info of fields) {
        const value = values[info.name];
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
        } catch {
          /* a field may be read-only or use an unsupported appearance; skip it */
        }
      }
      if (flatten) form.flatten();
      const bytes = await doc.save();
      setResult({
        bytes,
        name: `${sanitizeName(baseName(pdf.file.name))}-${flatten ? "filled-flat" : "filled"}.pdf`,
        pages: doc.getPageCount(),
        filled: fields.length,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const byType = (type: FieldType) => fields.filter((f) => f.type === type);

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF with form fields" />
      {loadingFields && <div className="flex items-center gap-2 text-[12px] text-muted"><Loader2 className="h-4 w-4 animate-spin" /> Reading interactive fields…</div>}

      {pdf.bytes && !loadingFields && fields.length === 0 && (
        <Alert tone="info" title="No interactive fields found">
          This PDF doesn’t contain a standard AcroForm. Paperly can’t infer a fillable form from a flat page — use the{" "}
          <a href="#/tool/edit" className="font-semibold underline">
            Edit PDF
          </a>{" "}
          or{" "}
          <a href="#/tool/sign" className="font-semibold underline">
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
            {(byType("dropdown").length || byType("radio").length || byType("optionlist").length) > 0 && (
              <Badge>{byType("dropdown").length + byType("radio").length + byType("optionlist").length} choice</Badge>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map((field) => {
              const value = values[field.name];
              const displayName = field.name
                .replace(/[._-]+/g, " ")
                .replace(/([a-z])([A-Z])/g, "$1 $2")
                .replace(/\b\w/g, (c) => c.toUpperCase())
                .trim();
              if (field.type === "checkbox") {
                return (
                  <div key={field.name} className="sm:col-span-2">
                    <Switch
                      checked={Boolean(value)}
                      onChange={(checked) => setValues((v) => ({ ...v, [field.name]: checked }))}
                      label={displayName}
                      description={`Checkbox${field.required ? " · required" : ""}`}
                    />
                  </div>
                );
              }
              if (field.type === "optionlist") {
                const selected = Array.isArray(value) ? value : value ? [String(value)] : [];
                return (
                  <Field key={field.name} label={<>{displayName} {field.required && <span className="text-clay-ink">*</span>}</>} hint="Hold Ctrl/Cmd to select more than one option.">
                    <select
                      multiple
                      size={Math.min(5, Math.max(3, field.options.length))}
                      value={selected}
                      onChange={(e) => {
                        const next = Array.from(e.target.selectedOptions).map((o) => o.value);
                        setValues((v) => ({ ...v, [field.name]: next }));
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
                );
              }
              if (field.type === "dropdown" || field.type === "radio") {
                return (
                  <Field key={field.name} label={<>{displayName} {field.required && <span className="text-clay-ink">*</span>}</>}>
                    <Select
                      value={Array.isArray(value) ? value[0] ?? "" : String(value ?? "")}
                      onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
                    >
                      <option value="">Choose…</option>
                      {field.options.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </Select>
                  </Field>
                );
              }
              if (field.type === "signature") {
                return (
                  <Field key={field.name} label={displayName} hint="Signature fields can’t be typed into. Use the Sign PDF tool to place a signature image.">
                    <div className="flex h-11 items-center rounded-xl border border-dashed border-line bg-bone-deep/30 px-3 text-[12px] text-muted">
                      Use Sign PDF
                    </div>
                  </Field>
                );
              }
              return (
                <Field key={field.name} label={<>{displayName} {field.required && <span className="text-clay-ink">*</span>}</>}>
                  <input
                    value={String(value ?? "")}
                    onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
                    className={inputClass}
                    placeholder={`Enter ${displayName.toLowerCase()}`}
                  />
                </Field>
              );
            })}
          </div>

          <Switch
            checked={flatten}
            onChange={setFlatten}
            label="Flatten after filling"
            description="Makes answers permanent — the form can no longer be edited"
          />

          {error && <Alert tone="error">{error}</Alert>}
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button onClick={save} loading={busy}>
              <ClipboardCheck className="h-4 w-4" /> Save filled PDF
            </Button>
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
          description={`${result.filled} field${result.filled === 1 ? "" : "s"} in the form · answers saved${flatten ? " · flattened and locked" : " · still editable"}`}
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

export function ScanTool() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [paper, setPaper] = useState<PaperKey | "fit">("a4");
  const [margin, setMargin] = useState(10);
  const [quality, setQuality] = useState(88);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; pages: number } | null>(null);

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
    const ctx = canvas.getContext("2d")!;
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
    setResult(null);
  };

  const addFiles = async (files: File[]) => {
    setError("");
    const accepted = files.filter((file) => file.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|avif)$/i.test(file.name));
    if (!accepted.length) {
      setError("Add photos in JPG, PNG or WebP format.");
      return;
    }
    try {
      const next: Capture[] = [];
      for (const file of accepted) {
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
      setCaptures((list) => [...list, ...next]);
      setResult(null);
    } catch (err) {
      setError(friendlyProcessingError(err, "One of those images couldn’t be read. Try a JPG or PNG photo."));
    }
  };

  const rotate = (id: string) => {
    setCaptures((list) => list.map((c) => (c.id === id ? { ...c, rotation: (c.rotation + 90) % 360 } : c)));
    setResult(null);
  };

  const create = async () => {
    if (!captures.length) {
      setError("Capture at least one page first.");
      return;
    }
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const doc = await PDFDocument.create();
      const marginPt = margin * 2.834645669;
      for (let i = 0; i < captures.length; i++) {
        const capture = captures[i];
        // Re-encode at the chosen quality and burn the rotation into the pixels.
        const bitmap = await createImageBitmap(await (await fetch(capture.dataUrl)).blob());
        const canvas = document.createElement("canvas");
        const rotated = capture.rotation === 90 || capture.rotation === 270;
        canvas.width = rotated ? bitmap.height : bitmap.width;
        canvas.height = rotated ? bitmap.width : bitmap.height;
        const ctx = canvas.getContext("2d")!;
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((capture.rotation * Math.PI) / 180);
        ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
        bitmap.close?.();
        const processed = canvas.toDataURL("image/jpeg", quality / 100);
        const jpegBytes = dataUrlToBytes(processed);
        const image = await doc.embedJpg(jpegBytes);

        if (paper === "fit") {
          const page = doc.addPage([canvas.width * 0.75, canvas.height * 0.75]);
          page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
        } else {
          const base = paperDimensions(paper, canvas.height >= canvas.width ? "portrait" : "landscape");
          const page = doc.addPage([base.w, base.h]);
          const boxW = Math.max(20, base.w - marginPt * 2);
          const boxH = Math.max(20, base.h - marginPt * 2);
          const scale = Math.min(boxW / canvas.width, boxH / canvas.height);
          const w = canvas.width * scale;
          const h = canvas.height * scale;
          page.drawImage(image, { x: (base.w - w) / 2, y: (base.h - h) / 2, width: w, height: h });
        }
        setProgress(((i + 1) / captures.length) * 100);
      }
      const bytes = await doc.save();
      setResult({
        bytes,
        name: `paperly-scan-${new Date().toISOString().slice(0, 10)}.pdf`,
        pages: captures.length,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

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
                <Button variant="accent" size="sm" onClick={startCamera} loading={starting} className="mt-1">
                  <Camera className="h-3.5 w-3.5" /> Start camera
                </Button>
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
                    accept="image/jpeg,image/png,image/webp,image/avif,.jpg,.jpeg,.png,.webp,.avif"
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
              <div className="mb-2 flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">
                  Scanned pages · {captures.length}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setCaptures([]);
                    setResult(null);
                  }}
                  className="text-[11px] font-medium text-clay-ink hover:underline"
                >
                  Clear all
                </button>
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
                      <span className="text-[10.5px] font-semibold tabular-nums text-ink/70">#{index + 1}</span>
                      <div className="flex">
                        <button type="button" onClick={() => rotate(capture.id)} aria-label={`Rotate scan ${index + 1}`} className="rounded p-1 text-ink/75 hover:bg-forest/10 hover:text-forest">
                          <RotateCw className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setCaptures((list) => list.filter((c) => c.id !== capture.id));
                            setResult(null);
                          }}
                          aria-label={`Delete scan ${index + 1}`}
                          className="rounded p-1 text-ink/75 hover:bg-clay/10 hover:text-clay-ink"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <aside className="space-y-3">
          <div className="rounded-xl border border-line bg-paper p-3.5">
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">Output</p>
            <div className="space-y-3">
              <Field label="Page size">
                <Select value={paper} onChange={(e) => setPaper(e.target.value as PaperKey | "fit")}>
                  <option value="a4">A4</option>
                  <option value="letter">US Letter</option>
                  <option value="legal">US Legal</option>
                  <option value="fit">Fit to each photo</option>
                </Select>
              </Field>
              <Field label="Margin" hint={paper === "fit" ? "No margin in fit mode" : `${margin} mm`}>
                <input
                  type="range"
                  min={0}
                  max={30}
                  value={margin}
                  disabled={paper === "fit"}
                  aria-label="Page margin in millimetres"
                  onChange={(e) => setMargin(Number(e.target.value))}
                  className="w-full accent-[#1c4c3b] disabled:opacity-40"
                />
              </Field>
              <Field label={`JPG quality · ${quality}%`}>
                <input type="range" min={55} max={100} step={1} value={quality} aria-label="JPEG quality percentage" onChange={(e) => setQuality(Number(e.target.value))} className="w-full accent-[#1c4c3b]" />
              </Field>
            </div>
          </div>
          <div className="rounded-xl border border-forest/15 bg-lime/20 p-3 text-[11px] leading-relaxed text-forest">
            <p className="font-semibold">A note on scans</p>
            <p className="mt-1 text-forest/90">
              Camera captures are images, not OCR. Add the OCR tool afterwards if you need searchable text. Keep each page flat and well lit for the
              crispest result.
            </p>
          </div>
          <Button onClick={create} loading={busy} disabled={!captures.length} className="w-full">
            <Save className="h-4 w-4" /> Create PDF
          </Button>
          {busy && <Progress value={progress} label="Building pages from your scans…" />}
        </aside>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Scan saved as PDF"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${result.pages} captured page${result.pages === 1 ? "" : "s"} · ${formatBytes(result.bytes.byteLength)} · images stay on your device`}
        />
      )}
      {!captures.length && (
        <div className="flex items-start gap-2 rounded-xl border border-dashed border-line bg-bone-deep/25 px-3.5 py-3 text-[11.5px] leading-relaxed text-muted">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Cameras require a secure (https) page and permission. If yours is unavailable, the “Add photos” option works everywhere and produces the
          same PDF.
        </div>
      )}
    </div>
  );
}
