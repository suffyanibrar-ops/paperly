import {
  ArrowUp,
  ArrowDown,
  ArrowUpRight,
  Bold as BoldIcon,
  BringToFront,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  Copy,
  Download,
  Eraser,
  Highlighter,
  Images,
  Italic,
  Lock,
  Maximize2,
  Minus,
  Move,
  Plus,
  Redo2,
  SendToBack,
  Signature,
  Square,
  Stamp,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignStart,
  Trash2,
  Type,
  Undo2,
  UserRound,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { PDFArray, type PDFObject, type PDFPage } from "@cantoo/pdf-lib";
import {
  StandardFonts,
  baseName,
  dataUrlToBytes,
  degrees,
  embedFonts,
  formatBytes,
  getPageDimensions,
  hexToRgb,
  openPdfJs,
  openPdfLib,
  parseRanges,
  renderPdfPage,
  rgb,
  safePdfText,
  sanitizeName,
  uniqueInOrder,
  wrapText,
} from "@/lib/pdf";
import type { RenderedPage } from "@/lib/pdf";
import { useInitialFiles, usePdfFile, usePdfThumbs } from "@/lib/usePdf";
import { SAMPLE } from "@/lib/sample";
import { friendlyProcessingError, validateUpload } from "@/lib/security";
import { useToolPreferences, readPreferences, writePreferences } from "@/lib/prefs";
import { describeJobTime, useJob } from "@/lib/job";
import { useDownloadShortcut, usePrimaryShortcut } from "@/lib/hotkeys";
import { downloadOutput } from "@/lib/output";
import {
  Alert,
  Button,
  ColorInput,
  Field,
  FileDrop,
  FileRow,
  Progress,
  Select,
  StepHeader,
  Switch,
  TextArea,
  inputClass,
} from "@/components/ui";
import { DownloadPanel, RangeField, SinglePdfInput } from "@/components/toolParts";
import { AdvancedOptions, NumberField, OptionsGrid, SliderField, OptionNote } from "@/components/AdvancedOptions";
import { cn } from "@/utils/cn";

/* ------------------------------------------------------------------ *
 * Image helpers
 * ------------------------------------------------------------------ */
interface ImageData {
  dataUrl: string;
  width: number;
  height: number;
}

async function imageFileToPng(file: File, maxDimension = 1400): Promise<ImageData> {
  const bitmap = await createImageBitmap(file);
  const ratio = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
  canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return { dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
}

function trimTransparent(canvas: HTMLCanvasElement): ImageData {
  const ctx = canvas.getContext("2d")!;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let found = false;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      if (data[(y * width + x) * 4 + 3] > 12) {
        found = true;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!found) return { dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
  const pad = 14;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width, maxX + pad);
  maxY = Math.min(height, maxY + pad);
  const out = document.createElement("canvas");
  out.width = Math.max(1, maxX - minX);
  out.height = Math.max(1, maxY - minY);
  out.getContext("2d")!.drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return { dataUrl: out.toDataURL("image/png"), width: out.width, height: out.height };
}

/** Paint a short line of text (a date stamp, initials …) into a PNG. */
function textStamp(text: string, opts: { italic?: boolean; size?: number } = {}): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = 1100;
  canvas.height = 300;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#13251d";
  ctx.font = `${opts.italic === false ? "" : "italic "}${opts.size ?? 128}px Georgia, "Times New Roman", serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2, canvas.width - 40);
  return trimTransparent(canvas);
}

/* ------------------------------------------------------------------ *
 * Signature studio
 * ------------------------------------------------------------------ */
type SignTab = "draw" | "type" | "upload";

export type SignSource = "typed" | "drawn" | "uploaded";

export interface SavedSignature {
  id: string;
  label: string;
  dataUrl: string;
  aspect: number;
}

export function SignatureStudio({
  onUse,
  onClose,
  saved = [],
  onPick,
  onForget,
}: {
  onUse: (dataUrl: string, aspect: number, label?: string, kind?: SignSource) => void;
  onClose: () => void;
  /** Signatures the visitor chose to keep in this tab. */
  saved?: SavedSignature[];
  /** Use a stored signature without editing it. */
  onPick?: (signature: SavedSignature) => void;
  /** Forget a stored signature. */
  onForget?: (id: string) => void;
}) {
  const [tab, setTab] = useState<SignTab>("draw");
  const [name, setName] = useState("");
  const [style, setStyle] = useState("serif");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [hasInk, setHasInk] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
  }, [tab]);

  const clear = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
  };

  const pos = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const startDraw = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = pos(e);
  };

  const draw = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const canvas = e.currentTarget;
    const ctx = canvas.getContext("2d")!;
    const p = pos(e);
    if (last.current) {
      ctx.strokeStyle = "#13251d";
      ctx.lineWidth = 3.4;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(last.current.x, last.current.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      setHasInk(true);
    }
    last.current = p;
  };

  const renderTyped = (): ImageData | null => {
    if (!name.trim()) return null;
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 260;
    const ctx = canvas.getContext("2d")!;
    const family =
      style === "serif" ? '"Instrument Serif", Georgia, serif' : style === "script" ? '"Segoe Script", "Brush Script MT", cursive' : "Georgia, serif";
    ctx.fillStyle = "#13251d";
    ctx.font = `italic 116px ${family}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(name.trim(), canvas.width / 2, canvas.height / 2, canvas.width - 60);
    return trimTransparent(canvas);
  };

  const useTyped = () => {
    const image = renderTyped();
    if (image) onUse(image.dataUrl, image.width / image.height, name.trim(), "typed");
  };

  const useCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas || !hasInk) return;
    const image = trimTransparent(canvas);
    onUse(image.dataUrl, image.width / image.height, "Drawn signature", "drawn");
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/55 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Create a signature">
      <div className="max-h-[92vh] w-full max-w-xl animate-pop overflow-y-auto rounded-2xl border border-line bg-paper shadow-lift">
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <div>
            <h2 className="text-[15px] font-semibold">Create your signature</h2>
            <p className="text-[11.5px] text-muted">Stored in this tab only. Never uploaded.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-2 text-ink/75 hover:bg-ink/5 hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid grid-cols-3 gap-1 border-b border-line px-5 py-2">
          {(["draw", "type", "upload"] as SignTab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "rounded-lg py-1.5 text-[12.5px] font-medium capitalize transition-colors",
                tab === t ? "bg-forest text-paper" : "text-ink/70 hover:bg-ink/5",
              )}
            >
              {t === "type" ? "Type" : t === "draw" ? "Draw" : "Upload"}
            </button>
          ))}
        </div>
        <div className="p-5">
          {tab === "draw" && (
            <>
              <div className="rounded-xl border border-dashed border-ink/20 bg-bone-deep/30 p-2">
                <canvas
                  ref={canvasRef}
                  width={1100}
                  height={330}
                  onPointerDown={startDraw}
                  onPointerMove={draw}
                  onPointerUp={() => {
                    drawing.current = false;
                    last.current = null;
                  }}
                  onPointerLeave={() => {
                    drawing.current = false;
                    last.current = null;
                  }}
                  className="h-[150px] w-full touch-none rounded-lg bg-white"
                  aria-label="Signature drawing area"
                />
              </div>
              <p className="mt-2 text-[11px] text-muted">Sign with your mouse, trackpad or finger.</p>
              <div className="mt-3 flex items-center justify-between">
                <Button variant="ghost" size="sm" onClick={clear}>
                  <Eraser className="h-3.5 w-3.5" /> Clear
                </Button>
                <Button onClick={useCanvas} disabled={!hasInk} size="sm">
                  <Check className="h-3.5 w-3.5" /> Use signature
                </Button>
              </div>
            </>
          )}
          {tab === "type" && (
            <>
              <Field label="Your name">
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Alex Morgan" className={inputClass} autoFocus />
              </Field>
              <div className="mt-3">
                <Field label="Signature style">
                  <Select value={style} onChange={(e) => setStyle(e.target.value)}>
                    <option value="serif">Editorial italic</option>
                    <option value="script">Handwritten script</option>
                    <option value="classic">Classic serif</option>
                  </Select>
                </Field>
              </div>
              <div className="mt-3 flex h-[120px] items-center justify-center rounded-xl border border-line bg-bone-deep/25 px-4">
                <span
                  className={cn(
                    "truncate text-ink",
                    style === "serif" && "font-serif text-[46px] italic",
                    style === "script" && "text-[40px] italic",
                    style === "classic" && "text-[38px]",
                  )}
                  style={style === "script" ? { fontFamily: '"Segoe Script", "Brush Script MT", cursive' } : style === "classic" ? { fontFamily: "Georgia, serif" } : undefined}
                >
                  {name || "Your name"}
                </span>
              </div>
              <div className="mt-3 flex justify-end">
                <Button onClick={useTyped} disabled={!name.trim()} size="sm">
                  <Check className="h-3.5 w-3.5" /> Use signature
                </Button>
              </div>
            </>
          )}
          {tab === "upload" && (
            <>
              <FileDrop
                accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
                acceptLabel="A signature image (PNG or JPG)"
                compact
                onFiles={async (files) => {
                  const result = await imageFileToPng(files[0], 1600);
                  onUse(result.dataUrl, result.width / result.height, files[0].name, "uploaded");
                }}
              />
              <p className="mt-2 text-[11px] text-muted">A transparent PNG works best. We remove nothing from your image.</p>
            </>
          )}

          {saved.length > 0 && (
            <div className="mt-5 border-t border-line pt-4">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/60">Signatures kept in this tab</p>
              <ul className="flex flex-wrap gap-2">
                {saved.map((entry) => (
                  <li key={entry.id} className="flex items-center gap-1 rounded-lg border border-line bg-bone-deep/30 px-2 py-1">
                    <button
                      type="button"
                      onClick={() => (onPick ? onPick(entry) : onUse(entry.dataUrl, entry.aspect, entry.label))}
                      className="flex h-9 items-center"
                      title={`Use ${entry.label}`}
                    >
                      <img src={entry.dataUrl} alt={entry.label} className="h-7 max-w-[120px] object-contain" loading="lazy" decoding="async" />
                    </button>
                    {onForget && (
                      <button
                        type="button"
                        onClick={() => onForget(entry.id)}
                        aria-label={`Forget ${entry.label}`}
                        className="rounded p-0.5 text-ink/45 hover:bg-clay/10 hover:text-clay-ink"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * EDIT PDF
 * ------------------------------------------------------------------ */
type ElType = "text" | "rect" | "ellipse" | "line" | "arrow" | "highlight" | "whiteout" | "image" | "signature";
type ElAlign = "left" | "center" | "right";

interface El {
  id: string;
  page: number;
  type: ElType;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  opacity: number;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  align: ElAlign;
  text: string;
  image?: string;
  /** Shapes only: fill the shape, or draw its outline. */
  fill: boolean;
  /** Lines, arrows and outlines. */
  strokeWidth: number;
}

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

const PALETTE: { id: ElType | "select"; label: string; icon: typeof Move }[] = [
  { id: "select", label: "Select", icon: Move },
  { id: "text", label: "Text", icon: Type },
  { id: "image", label: "Image", icon: Images },
  { id: "signature", label: "Signature", icon: Signature },
  { id: "rect", label: "Rectangle", icon: Square },
  { id: "ellipse", label: "Ellipse", icon: Circle },
  { id: "line", label: "Line", icon: Minus },
  { id: "arrow", label: "Arrow", icon: ArrowUpRight },
  { id: "highlight", label: "Highlight", icon: Highlighter },
  { id: "whiteout", label: "Whiteout", icon: Eraser },
];

const ALIGN_OPTIONS: { id: ElAlign; label: string; icon: typeof Move }[] = [
  { id: "left", label: "Left", icon: TextAlignStart },
  { id: "center", label: "Center", icon: TextAlignCenter },
  { id: "right", label: "Right", icon: TextAlignEnd },
];

interface EditResult {
  bytes: Uint8Array;
  name: string;
  pages: number;
  edits: number;
  pagesTouched: number;
}

export function EditPdfTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const prefs = useToolPreferences("edit", {
    fontSize: 14,
    color: "#12211a",
    bold: false,
    italic: false,
    align: "left" as ElAlign,
    textOpacity: 1,
    shapeColor: "#1c4c3b",
    shapeOpacity: 0.15,
    shapeFill: true,
    strokeWidth: 1.8,
    lockAspect: true,
  });
  const [pageIndex, setPageIndex] = useState(0);
  const [dims, setDims] = useState<{ width: number; height: number }[]>([]);
  const [preview, setPreview] = useState<RenderedPage | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [elements, setElements] = useState<El[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<ElType | "select">("select");
  const [imageSource, setImageSource] = useState<string | null>(null);
  const [signatureSource, setSignatureSource] = useState<{ dataUrl: string; aspect: number } | null>(null);
  const [signatureOpen, setSignatureOpen] = useState(false);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [fitWidth, setFitWidth] = useState(720);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<{ past: El[][]; future: El[][] }>({ past: [], future: [] });
  const job = useJob<EditResult>();
  const viewportRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | null>(null);
  const elementsRef = useRef<El[]>(elements);
  elementsRef.current = elements;
  const dragRef = useRef<{
    mode: "move" | "resize";
    id: string;
    startX: number;
    startY: number;
    orig: El;
  } | null>(null);

  const currentDims = dims[pageIndex] ?? { width: 612, height: 792 };
  const pageW = currentDims.width;
  const pageH = currentDims.height;
  const displayWidth = zoom === "fit" ? fitWidth : Math.max(120, (pageW * zoom) / 100);
  const scale = displayWidth / pageW;
  const selected = elements.find((el) => el.id === selectedId) ?? null;
  const pageEls = elements.filter((el) => el.page === pageIndex);
  const result = job.result;
  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;

  useEffect(() => {
    setPageIndex(0);
    setElements([]);
    setSelectedId(null);
    setHistory({ past: [], future: [] });
    job.reset();
    if (!pdf.bytes) {
      setDims([]);
      return;
    }
    const bytes = pdf.bytes;
    getPageDimensions(bytes).then(setDims).catch(() => undefined);
    // The job controller is stable; a new file simply clears the previous run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf.bytes]);

  useEffect(() => {
    if (!pdf.bytes) {
      setPreview(null);
      return;
    }
    let alive = true;
    setPreviewLoading(true);
    const bytes = pdf.bytes;
    (async () => {
      const doc = await openPdfJs(bytes);
      const rendered = await renderPdfPage(doc, pageIndex + 1, { targetWidth: 1000, type: "image/jpeg", quality: 0.9, rotation: 0 });
      await doc.destroy();
      if (alive) setPreview(rendered);
    })()
      .catch(() => undefined)
      .finally(() => alive && setPreviewLoading(false));
    return () => {
      alive = false;
    };
  }, [pdf.bytes, pageIndex]);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => setFitWidth(Math.max(160, entries[0].contentRect.width)));
    observer.observe(node);
    setFitWidth(Math.max(160, node.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, [preview, pageIndex, pdf.bytes]);

  const snapshot = () => {
    const current = elementsRef.current;
    setHistory((prev) => ({ past: [...prev.past.slice(-49), current], future: [] }));
  };

  const undo = () => {
    if (!history.past.length) return;
    const previous = history.past[history.past.length - 1];
    setHistory({ past: history.past.slice(0, -1), future: [...history.future.slice(-49), elementsRef.current] });
    setElements(previous);
    setSelectedId(null);
  };

  const redo = () => {
    if (!history.future.length) return;
    const next = history.future[history.future.length - 1];
    setHistory({ past: [...history.past.slice(-49), elementsRef.current], future: history.future.slice(0, -1) });
    setElements(next);
    setSelectedId(null);
  };

  const addEl = (partial: Partial<El> & { type: ElType; x: number; y: number }) => {
    snapshot();
    const element: El = {
      id: uid(),
      page: pageIndex,
      w: 170,
      h: 70,
      color: prefs.value.shapeColor,
      opacity: prefs.value.shapeOpacity,
      fontSize: prefs.value.fontSize,
      bold: prefs.value.bold,
      italic: prefs.value.italic,
      align: prefs.value.align,
      text: "",
      fill: prefs.value.shapeFill,
      strokeWidth: prefs.value.strokeWidth,
      ...partial,
    };
    setElements((els) => [...els, element]);
    setSelectedId(element.id);
    setActiveTool("select");
    job.reset();
  };

  const placeFromClick = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!surfaceRef.current) return;
    if (activeTool === "select") {
      setSelectedId(null);
      return;
    }
    const rect = surfaceRef.current.getBoundingClientRect();
    const x = clamp(((e.clientX - rect.left) / rect.width) * pageW, 0, pageW);
    const y = clamp(((e.clientY - rect.top) / rect.height) * pageH, 0, pageH);
    if (activeTool === "text") {
      addEl({
        type: "text",
        x,
        y,
        w: 220,
        h: 30,
        text: "Your text",
        fontSize: prefs.value.fontSize,
        color: prefs.value.color,
        opacity: prefs.value.textOpacity,
        align: prefs.value.align,
        bold: prefs.value.bold,
        italic: prefs.value.italic,
      });
    } else if (activeTool === "rect") {
      addEl({ type: "rect", x, y, w: 160, h: 80, color: prefs.value.shapeColor, opacity: prefs.value.shapeOpacity });
    } else if (activeTool === "ellipse") {
      addEl({ type: "ellipse", x, y, w: 150, h: 90, color: prefs.value.shapeColor, opacity: prefs.value.shapeOpacity });
    } else if (activeTool === "line") {
      addEl({ type: "line", x, y, w: 180, h: 40, color: prefs.value.shapeColor, opacity: 1, fill: false });
    } else if (activeTool === "arrow") {
      addEl({ type: "arrow", x, y, w: 180, h: 40, color: prefs.value.shapeColor, opacity: 1, fill: false });
    } else if (activeTool === "highlight") {
      addEl({ type: "highlight", x: x - 80, y: y - 12, w: 180, h: 26, color: "#f6e05e", opacity: 0.42 });
    } else if (activeTool === "whiteout") {
      addEl({ type: "whiteout", x: x - 70, y: y - 16, w: 150, h: 34, color: "#ffffff", opacity: 1 });
    } else if (activeTool === "image") {
      if (!imageSource) {
        replaceTarget.current = null;
        imageInput.current?.click();
        return;
      }
      addEl({ type: "image", x: x - 70, y: y - 50, w: 150, h: 100, image: imageSource, opacity: 1 });
    } else if (activeTool === "signature") {
      if (!signatureSource) {
        setSignatureOpen(true);
        return;
      }
      const w = 190;
      const h = w / signatureSource.aspect;
      addEl({ type: "signature", x: x - w / 2, y: y - h / 2, w, h, image: signatureSource.dataUrl, opacity: 1 });
    }
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      const node = surfaceRef.current;
      if (!drag || !node) return;
      const rect = node.getBoundingClientRect();
      const dx = ((e.clientX - drag.startX) / rect.width) * pageW;
      const dy = ((e.clientY - drag.startY) / rect.height) * pageH;
      setElements((els) =>
        els.map((el) => {
          if (el.id !== drag.id) return el;
          if (drag.mode === "move") {
            return { ...el, x: clamp(drag.orig.x + dx, -el.w * 0.4, pageW - el.w * 0.6), y: clamp(drag.orig.y + dy, -el.h * 0.4, pageH - el.h * 0.6) };
          }
          const width = clamp(drag.orig.w + dx, 24, pageW - el.x);
          const lockRatio = prefs.value.lockAspect && (el.type === "image" || el.type === "signature");
          const height = lockRatio
            ? clamp((width * drag.orig.h) / Math.max(1, drag.orig.w), 16, pageH - el.y)
            : clamp(drag.orig.h + dy, 16, pageH - el.y);
          return { ...el, w: width, h: height };
        }),
      );
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [pageW, pageH, prefs.value.lockAspect]);

  const duplicate = (id: string) => {
    const source = elementsRef.current.find((el) => el.id === id);
    if (!source) return;
    snapshot();
    const copy: El = { ...source, id: uid(), x: source.x + 12, y: source.y + 12 };
    setElements((els) => [...els, copy]);
    setSelectedId(copy.id);
    job.reset();
  };

  const removeEl = (id: string) => {
    snapshot();
    setElements((els) => els.filter((el) => el.id !== id));
    setSelectedId(null);
    job.reset();
  };

  const reorder = (id: string, direction: "front" | "back" | "forward" | "backward") => {
    snapshot();
    setElements((els) => {
      const index = els.findIndex((el) => el.id === id);
      if (index < 0) return els;
      const next = [...els];
      const [element] = next.splice(index, 1);
      const target =
        direction === "front"
          ? next.length
          : direction === "back"
            ? 0
            : direction === "forward"
              ? Math.min(next.length, index + 1)
              : Math.max(0, index - 1);
      next.splice(target, 0, element);
      return next;
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable === true;
      if (typing) {
        if (e.key === "Escape") (target as HTMLInputElement).blur();
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        removeEl(selectedId);
        return;
      }
      if (e.key === "Escape") {
        setSelectedId(null);
        setActiveTool("select");
        return;
      }
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (mod && e.key.toLowerCase() === "d" && selectedId) {
        e.preventDefault();
        duplicate(selectedId);
        return;
      }
      if (selectedId && e.key.startsWith("Arrow")) {
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        if (dx || dy) {
          e.preventDefault();
          setElements((els) =>
            els.map((el) =>
              el.id === selectedId
                ? { ...el, x: clamp(el.x + dx, -el.w * 0.4, pageW), y: clamp(el.y + dy, -el.h * 0.4, pageH) }
                : el,
            ),
          );
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Property edits are coalesced into one history entry while the user keeps
  // typing or dragging a slider, so ⌘Z steps back to the previous state.
  const lastEdit = useRef<{ id: string; at: number }>({ id: "", at: 0 });
  const updateSelected = (patch: Partial<El>) => {
    if (!selectedId) return;
    const now = Date.now();
    if (lastEdit.current.id !== selectedId || now - lastEdit.current.at > 700) snapshot();
    lastEdit.current = { id: selectedId, at: now };
    setElements((els) => els.map((el) => (el.id === selectedId ? { ...el, ...patch } : el)));
    job.reset();
  };

  const exportPdf = async () => {
    const source = pdf.bytes;
    const file = pdf.file;
    if (!source || !file) return;
    if (!elements.length) {
      setError("Add at least one edit before exporting.");
      return;
    }
    setError("");
    await job.run(async ({ report, step, throwIfCancelled }) => {
      const doc = await openPdfLib(source);
      const fonts = await embedFonts(doc);
      const allPages = doc.getPages();
      const imageCache = new Map<string, Awaited<ReturnType<typeof doc.embedPng>>>();
      const total = elements.length;
      for (let index = 0; index < total; index++) {
        throwIfCancelled();
        const el = elements[index];
        const page = allPages[el.page];
        if (page) {
          const pageHeight = page.getHeight();
          const y = pageHeight - el.y - el.h;
          if (el.type === "image" || el.type === "signature") {
            if (el.image) {
              let embedded = imageCache.get(el.image);
              if (!embedded) {
                embedded = await doc.embedPng(dataUrlToBytes(el.image));
                imageCache.set(el.image, embedded);
              }
              page.drawImage(embedded, { x: el.x, y: pageHeight - el.y - el.h, width: el.w, height: el.h, opacity: el.opacity });
            }
          } else if (el.type === "text") {
            const font = el.italic ? (el.bold ? fonts.boldItalic : fonts.italic) : el.bold ? fonts.bold : fonts.regular;
            const lines = wrapText(el.text || " ", {
              font,
              size: el.fontSize,
              color: el.color,
              maxWidth: Math.max(30, el.w),
            });
            lines.forEach((line, lineIndex) => {
              const lineWidth = font.widthOfTextAtSize(line, el.fontSize);
              const offset = el.align === "center" ? (el.w - lineWidth) / 2 : el.align === "right" ? el.w - lineWidth : 0;
              page.drawText(line, {
                x: el.x + Math.max(0, offset),
                y: pageHeight - el.y - el.fontSize - lineIndex * el.fontSize * 1.28,
                size: el.fontSize,
                font,
                color: hexToRgb(el.color),
                opacity: el.opacity,
              });
            });
          } else if (el.type === "rect" || el.type === "highlight" || el.type === "whiteout") {
            const outlined = !el.fill && el.type === "rect";
            page.drawRectangle({
              x: el.x,
              y,
              width: el.w,
              height: el.h,
              ...(outlined
                ? { borderColor: hexToRgb(el.color), borderWidth: Math.max(0.3, el.strokeWidth), opacity: el.opacity }
                : { color: hexToRgb(el.color), opacity: el.opacity }),
              ...(el.type === "highlight" ? { borderColor: rgb(0.95, 0.82, 0.25), borderWidth: 0.8 } : {}),
            });
          } else if (el.type === "ellipse") {
            page.drawEllipse({
              x: el.x + el.w / 2,
              y: y + el.h / 2,
              xScale: el.w / 2,
              yScale: el.h / 2,
              ...(el.fill
                ? { color: hexToRgb(el.color), opacity: el.opacity }
                : { borderColor: hexToRgb(el.color), borderWidth: Math.max(0.3, el.strokeWidth), opacity: el.opacity }),
            });
          } else if (el.type === "line" || el.type === "arrow") {
            const start = { x: el.x, y: pageHeight - el.y };
            const end = { x: el.x + el.w, y: pageHeight - el.y - el.h };
            page.drawLine({
              start,
              end,
              thickness: Math.max(0.4, el.strokeWidth),
              color: hexToRgb(el.color),
              opacity: el.opacity,
            });
            if (el.type === "arrow") {
              const angle = Math.atan2(end.y - start.y, end.x - start.x);
              const head = clamp(el.strokeWidth * 6, 8, 26);
              for (const offset of [Math.PI - 0.42, Math.PI + 0.42]) {
                page.drawLine({
                  start: end,
                  end: { x: end.x + Math.cos(angle + offset) * head, y: end.y + Math.sin(angle + offset) * head },
                  thickness: Math.max(0.4, el.strokeWidth),
                  color: hexToRgb(el.color),
                  opacity: el.opacity,
                });
              }
            }
          }
        }
        step(index + 1, total, "Writing your edits into the PDF…");
      }
      throwIfCancelled();
      report(97, "Saving the flattened copy…");
      const bytes = await doc.save();
      return {
        bytes,
        name: `${sanitizeName(baseName(file.name))}-edited.pdf`,
        pages: doc.getPageCount(),
        edits: elements.length,
        pagesTouched: new Set(elements.map((el) => el.page)).size,
      };
    });
  };

  const download = () => {
    if (result) downloadOutput(result.bytes, result.name);
  };

  usePrimaryShortcut(() => void exportPdf(), Boolean(pdf.bytes) && elements.length > 0 && !job.busy);
  useDownloadShortcut(download, Boolean(result));

  const startDrag = (e: ReactPointerEvent, el: El, mode: "move" | "resize") => {
    if (activeTool !== "select" && mode === "move") return;
    e.stopPropagation();
    e.preventDefault();
    setSelectedId(el.id);
    if (!dragRef.current) snapshot();
    dragRef.current = { mode, id: el.id, startX: e.clientX, startY: e.clientY, orig: { ...el } };
  };

  const zoomBy = (delta: number) => {
    const current = zoom === "fit" ? Math.round((fitWidth / pageW) * 100) : zoom;
    setZoom(clamp(Math.round((current + delta) / 5) * 5, 25, 300));
  };

  const hint =
    activeTool === "select"
      ? "Drag elements to move them, use the corner handle to resize, and ⌘Z steps back."
      : activeTool === "image" && !imageSource
        ? "Choose an image first."
        : activeTool === "signature" && !signatureSource
          ? "Create a signature first."
          : `Click the page to place your ${activeTool}.`;

  if (!pdf.file) {
    return (
      <div className="space-y-4">
        <FileDrop accept="application/pdf,.pdf" acceptLabel="A PDF to edit" onFiles={(f) => pdf.setFile(f[0])} sample={SAMPLE.pdf} />
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            { title: "Text & shapes", body: "Add headings, notes, rectangles, ellipses, arrows, highlights and whiteout." },
            { title: "Images & signatures", body: "Drop in a logo or draw a signature without leaving the tab." },
            { title: "Flattened export", body: "Edits are baked into a new PDF; the original is untouched." },
          ].map((f) => (
            <div key={f.title} className="rounded-xl border border-line bg-bone-deep/25 p-3.5">
              <p className="text-[12.5px] font-semibold">{f.title}</p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-muted">{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {signatureOpen && (
        <SignatureStudio
          onClose={() => setSignatureOpen(false)}
          onUse={(dataUrl, aspect) => {
            setSignatureSource({ dataUrl, aspect });
            setSignatureOpen(false);
            setActiveTool("signature");
          }}
        />
      )}
      <input
        ref={imageInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          const target = replaceTarget.current;
          replaceTarget.current = null;
          e.target.value = "";
          if (!file) return;
          try {
            await validateUpload(file, "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp");
            const image = await imageFileToPng(file, 1500);
            if (target) {
              updateSelected({ image: image.dataUrl });
            } else {
              setImageSource(image.dataUrl);
              setActiveTool("image");
            }
          } catch (err) {
            setError(friendlyProcessingError(err, "That image couldn’t be added."));
          }
        }}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <FileRow file={pdf.file} size={`${pdf.pageCount} pages · ${formatBytes(pdf.file.size)}`} onRemove={pdf.clear} />
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
          <span className="inline-flex items-center gap-1">
            <Maximize2 className="h-3 w-3" /> {Math.round((displayWidth / pageW) * 100)}% zoom
          </span>
          <span>·</span>
          <span>⌘Z undo · ⌘D duplicate · ⌘/Ctrl+Enter export</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-bone-deep/40 p-2">
        <div className="flex flex-wrap gap-1">
          {PALETTE.map((tool) => (
            <button
              key={tool.id}
              type="button"
              onClick={() => {
                if (tool.id === "image") {
                  if (imageSource) {
                    setActiveTool("image");
                  } else {
                    replaceTarget.current = null;
                    imageInput.current?.click();
                  }
                  return;
                }
                if (tool.id === "signature" && !signatureSource) {
                  setSignatureOpen(true);
                  return;
                }
                setActiveTool(tool.id);
                setSelectedId(null);
              }}
              aria-pressed={activeTool === tool.id}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11.5px] font-medium transition-colors",
                activeTool === tool.id ? "bg-forest text-paper shadow-sm" : "text-ink/70 hover:bg-paper hover:text-ink",
              )}
              title={tool.label}
            >
              <tool.icon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{tool.label}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button variant="ghost" size="sm" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">
            <Undo2 className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
            <Redo2 className="h-3.5 w-3.5" />
          </Button>
          <span className="mx-1 h-5 w-px bg-line" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => selectedId && reorder(selectedId, "forward")}
            disabled={!selected}
            title="Bring forward"
            aria-label="Bring forward"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => selectedId && reorder(selectedId, "backward")}
            disabled={!selected}
            title="Send back"
            aria-label="Send back"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => selectedId && reorder(selectedId, "front")}
            disabled={!selected}
            title="Bring to front"
            aria-label="Bring to front"
          >
            <BringToFront className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => selectedId && reorder(selectedId, "back")}
            disabled={!selected}
            title="Send to back"
            aria-label="Send to back"
          >
            <SendToBack className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => selectedId && duplicate(selectedId)} disabled={!selected} title="Duplicate (Ctrl+D)" aria-label="Duplicate">
            <Copy className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => selectedId && removeEl(selectedId)} disabled={!selected} title="Delete (Delete)" aria-label="Delete selected element">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-paper p-2">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setPageIndex((i) => Math.max(0, i - 1));
              setSelectedId(null);
            }}
            disabled={pageIndex === 0}
            title="Previous page"
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <label className="flex items-center gap-1 text-[11.5px] font-medium text-ink/70">
            <span className="sr-only">Page number</span>
            <input
              type="number"
              min={1}
              max={Math.max(1, pdf.pageCount)}
              value={pageIndex + 1}
              onChange={(e) => {
                const next = clamp(Number(e.target.value) || 1, 1, Math.max(1, pdf.pageCount));
                setPageIndex(next - 1);
                setSelectedId(null);
              }}
              className="h-7 w-12 rounded-md border border-line bg-paper px-1.5 text-center text-[11.5px] tabular-nums"
            />
            <span className="text-muted">of {pdf.pageCount}</span>
          </label>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setPageIndex((i) => Math.min(pdf.pageCount - 1, i + 1));
              setSelectedId(null);
            }}
            disabled={pageIndex >= pdf.pageCount - 1}
            title="Next page"
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => zoomBy(-10)} title="Zoom out" aria-label="Zoom out">
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setZoom("fit")}
            className={cn("min-w-[52px] text-[11px] font-semibold tabular-nums", zoom === "fit" && "text-forest")}
            title="Fit the page to the panel"
          >
            Fit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setZoom(100)}
            className={cn("min-w-[52px] text-[11px] font-semibold tabular-nums", zoom === 100 && "text-forest")}
            title="Actual size"
          >
            100%
          </Button>
          <Button variant="ghost" size="sm" onClick={() => zoomBy(10)} title="Zoom in" aria-label="Zoom in">
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[11.5px] text-muted">{hint}</p>
            {activeTool !== "select" && (
              <button type="button" onClick={() => setActiveTool("select")} className="text-[11.5px] font-medium text-forest hover:underline">
                Cancel
              </button>
            )}
          </div>
          <div className="rounded-xl border border-line bg-bone-deep/50 p-3 sm:p-5">
            <div ref={viewportRef} className={cn("w-full", zoom !== "fit" && displayWidth > fitWidth && "overflow-x-auto pb-1")}>
              <div className="mx-auto" style={{ width: `${displayWidth}px`, maxWidth: zoom === "fit" ? "100%" : undefined }}>
                <div
                  ref={surfaceRef}
                  onPointerDown={placeFromClick}
                  className={cn(
                    "relative w-full overflow-hidden rounded-sm bg-white pdf-page-shadow",
                    activeTool !== "select" && "cursor-crosshair",
                    activeTool === "select" && "cursor-default",
                  )}
                  style={{ aspectRatio: `${pageW} / ${pageH}` }}
                >
                  {preview ? (
                    <img src={preview.dataUrl} alt={`Page ${pageIndex + 1}`} className="pointer-events-none absolute inset-0 h-full w-full object-fill" loading="lazy" decoding="async" />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-[12px] text-ink/70">
                      {previewLoading ? "Rendering page…" : "Loading page…"}
                    </div>
                  )}
                  {pageEls.map((el) => (
                    <div
                      key={el.id}
                      onPointerDown={(e) => startDrag(e, el, "move")}
                      className={cn(
                        "absolute",
                        activeTool === "select" ? "cursor-move" : "cursor-crosshair",
                        selectedId === el.id && "ring-2 ring-clay ring-offset-0",
                      )}
                      style={{
                        left: el.x * scale,
                        top: el.y * scale,
                        width: el.w * scale,
                        height: el.h * scale,
                        opacity: el.opacity,
                      }}
                    >
                      {(el.type === "image" || el.type === "signature") && el.image && (
                        <img src={el.image} alt="" className="pointer-events-none h-full w-full object-contain" draggable={false} loading="lazy" decoding="async" />
                      )}
                      {el.type === "text" && (
                        <div
                          className="h-full w-full overflow-hidden whitespace-pre-wrap break-words"
                          style={{
                            color: el.color,
                            fontSize: el.fontSize * scale,
                            lineHeight: 1.28,
                            fontWeight: el.bold ? 700 : 400,
                            fontStyle: el.italic ? "italic" : "normal",
                            textAlign: el.align,
                          }}
                        >
                          {el.text || "Text"}
                        </div>
                      )}
                      {el.type === "rect" &&
                        (el.fill ? (
                          <div className="h-full w-full" style={{ background: el.color }} />
                        ) : (
                          <div className="h-full w-full" style={{ border: `${Math.max(1, el.strokeWidth * scale)}px solid ${el.color}` }} />
                        ))}
                      {el.type === "ellipse" &&
                        (el.fill ? (
                          <div className="h-full w-full rounded-full" style={{ background: el.color }} />
                        ) : (
                          <div className="h-full w-full rounded-full" style={{ border: `${Math.max(1, el.strokeWidth * scale)}px solid ${el.color}` }} />
                        ))}
                      {el.type === "highlight" && <div className="h-full w-full" style={{ background: el.color, opacity: 0.7 }} />}
                      {el.type === "whiteout" && <div className="h-full w-full border border-dashed border-ink/15 bg-white" />}
                      {(el.type === "line" || el.type === "arrow") && (
                        <svg width="100%" height="100%" viewBox={`0 0 ${Math.max(1, el.w * scale)} ${Math.max(1, el.h * scale)}`} className="overflow-visible">
                          <line
                            x1={0}
                            y1={0}
                            x2={el.w * scale}
                            y2={el.h * scale}
                            stroke={el.color}
                            strokeWidth={Math.max(1, el.strokeWidth * scale)}
                            strokeLinecap="round"
                          />
                          {el.type === "arrow" && (
                            <polygon
                              points={(() => {
                                const w = Math.max(1, el.w * scale);
                                const h = Math.max(1, el.h * scale);
                                const angle = Math.atan2(h, w);
                                const head = Math.min(Math.max(7, el.strokeWidth * scale * 5), 20);
                                const p1 = `${w - Math.cos(angle - 0.42) * head},${h - Math.sin(angle - 0.42) * head}`;
                                const p2 = `${w - Math.cos(angle + 0.42) * head},${h - Math.sin(angle + 0.42) * head}`;
                                return `${w},${h} ${p1} ${p2}`;
                              })()}
                              fill={el.color}
                            />
                          )}
                        </svg>
                      )}
                      {selectedId === el.id && (
                        <>
                          <button
                            type="button"
                            aria-label="Delete selected element"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => removeEl(el.id)}
                            className="absolute -right-2.5 -top-2.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink text-paper"
                          >
                            <X className="h-2.5 w-2.5" />
                          </button>
                          <div
                            onPointerDown={(e) => startDrag(e, el, "resize")}
                            aria-hidden
                            className="absolute -bottom-1 -right-1 h-3 w-3 cursor-se-resize rounded-sm border border-white bg-clay"
                          />
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button onClick={() => void exportPdf()} loading={job.busy}>
              <Download className="h-4 w-4" /> Export edited PDF
            </Button>
            {job.busy && (
              <Button variant="ghost" size="sm" onClick={job.cancel}>
                Cancel
              </Button>
            )}
            <span className="text-[11.5px] text-muted">
              {elements.length} edit{elements.length === 1 ? "" : "s"} across {new Set(elements.map((e) => e.page)).size || 0} page
              {new Set(elements.map((e) => e.page)).size === 1 ? "" : "s"}
            </span>
            {elements.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  snapshot();
                  setElements((els) => els.filter((el) => el.page !== pageIndex));
                  setSelectedId(null);
                  job.reset();
                }}
              >
                Clear page
              </Button>
            )}
            {elements.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  snapshot();
                  setElements([]);
                  setSelectedId(null);
                  job.reset();
                }}
              >
                Clear all
              </Button>
            )}
          </div>
          {job.busy && (
            <div className="mt-3">
              <Progress value={job.percent ?? undefined} label={job.label} detail={describeJobTime(job)} etaMs={job.etaMs} />
            </div>
          )}
          {job.status === "cancelled" && (
            <Alert tone="info" className="mt-3">
              Cancelled — nothing was downloaded. Your edits are still here.
            </Alert>
          )}
          {error && (
            <Alert tone="error" className="mt-3">
              {error}
            </Alert>
          )}
          {job.failed && (
            <Alert tone="error" className="mt-3">
              {job.error}
            </Alert>
          )}

          <div className="mt-4">
            <AdvancedOptions
              scope="edit"
              badge="10 controls"
              description="Defaults for new text, shapes and images"
              onReset={prefs.reset}
            >
              <div className="space-y-4">
                <div>
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/60">New text</p>
                  <OptionsGrid>
                    <NumberField label="Font size" value={prefs.value.fontSize} onChange={(v) => prefs.set("fontSize", v)} min={6} max={96} suffix="pt" />
                    <Field label="Colour">
                      <ColorInput value={prefs.value.color} onChange={(v) => prefs.set("color", v)} label="Default text colour" />
                    </Field>
                    <SliderField
                      label="Text opacity"
                      value={Math.round(prefs.value.textOpacity * 100)}
                      onChange={(v) => prefs.set("textOpacity", v / 100)}
                      min={10}
                      max={100}
                      format={(v) => `${v}%`}
                    />
                    <div>
                      <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink/70">Alignment</p>
                      <div className="flex gap-1">
                        {ALIGN_OPTIONS.map((option) => (
                          <button
                            key={option.id}
                            type="button"
                            aria-pressed={prefs.value.align === option.id}
                            onClick={() => prefs.set("align", option.id)}
                            className={cn(
                              "flex h-9 flex-1 items-center justify-center gap-1 rounded-lg border text-[11.5px] font-medium",
                              prefs.value.align === option.id ? "border-forest bg-forest text-paper" : "border-line bg-paper text-ink/70",
                            )}
                          >
                            <option.icon className="h-3.5 w-3.5" /> {option.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex gap-2 sm:col-span-2">
                      <button
                        type="button"
                        aria-pressed={prefs.value.bold}
                        onClick={() => prefs.set("bold", !prefs.value.bold)}
                        className={cn(
                          "flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border text-[12px] font-semibold",
                          prefs.value.bold ? "border-forest bg-forest text-paper" : "border-line bg-paper text-ink/70",
                        )}
                      >
                        <BoldIcon className="h-3.5 w-3.5" /> Bold
                      </button>
                      <button
                        type="button"
                        aria-pressed={prefs.value.italic}
                        onClick={() => prefs.set("italic", !prefs.value.italic)}
                        className={cn(
                          "flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border text-[12px] font-semibold",
                          prefs.value.italic ? "border-forest bg-forest text-paper" : "border-line bg-paper text-ink/70",
                        )}
                      >
                        <Italic className="h-3.5 w-3.5" /> Italic
                      </button>
                    </div>
                  </OptionsGrid>
                </div>
                <div>
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/60">New shapes</p>
                  <OptionsGrid>
                    <Field label="Shape colour">
                      <ColorInput value={prefs.value.shapeColor} onChange={(v) => prefs.set("shapeColor", v)} label="Default shape colour" />
                    </Field>
                    <SliderField
                      label="Shape opacity"
                      value={Math.round(prefs.value.shapeOpacity * 100)}
                      onChange={(v) => prefs.set("shapeOpacity", v / 100)}
                      min={5}
                      max={100}
                      format={(v) => `${v}%`}
                    />
                    <SliderField
                      label="Stroke width"
                      value={prefs.value.strokeWidth}
                      onChange={(v) => prefs.set("strokeWidth", v)}
                      min={0.5}
                      max={8}
                      step={0.5}
                      format={(v) => `${v}pt`}
                    />
                  </OptionsGrid>
                  <div className="mt-3">
                    <Switch
                      checked={prefs.value.shapeFill}
                      onChange={(v) => prefs.set("shapeFill", v)}
                      label="Fill new shapes"
                      description="Turn off to place outlined boxes and circles instead."
                    />
                  </div>
                </div>
                <Switch
                  checked={prefs.value.lockAspect}
                  onChange={(v) => prefs.set("lockAspect", v)}
                  label="Keep image proportions"
                  description="Images and signatures resize without stretching."
                />
                <OptionNote>PDF fonts cover Latin characters only; other scripts are left out on export.</OptionNote>
              </div>
            </AdvancedOptions>
          </div>
        </div>

        <aside className="space-y-3">
          <div className="rounded-xl border border-line bg-paper p-3.5">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">Properties</p>
            {!selected && <p className="text-[12px] leading-relaxed text-muted">Select an element to change its text, colour, opacity and size.</p>}
            {selected && (
              <div className="space-y-3">
                {selected.type === "text" && (
                  <>
                    <Field label="Text">
                      <TextArea
                        value={selected.text}
                        rows={3}
                        onChange={(e) => updateSelected({ text: e.target.value })}
                        placeholder="Type your text"
                      />
                    </Field>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Size">
                        <input
                          type="number"
                          min={6}
                          max={96}
                          value={selected.fontSize}
                          onChange={(e) => updateSelected({ fontSize: clamp(Number(e.target.value) || 12, 6, 96) })}
                          className={cn(inputClass, "h-9")}
                        />
                      </Field>
                      <Field label="Colour">
                        <ColorInput value={selected.color} onChange={(color) => updateSelected({ color })} label="Text colour" />
                      </Field>
                    </div>
                    <div className="flex gap-1">
                      {ALIGN_OPTIONS.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          aria-label={`Align ${option.id}`}
                          aria-pressed={selected.align === option.id}
                          onClick={() => updateSelected({ align: option.id })}
                          className={cn(
                            "flex h-8 flex-1 items-center justify-center rounded-lg border",
                            selected.align === option.id ? "border-forest bg-forest text-paper" : "border-line bg-paper text-ink/70",
                          )}
                        >
                          <option.icon className="h-3.5 w-3.5" />
                        </button>
                      ))}
                      <button
                        type="button"
                        aria-label="Toggle bold"
                        aria-pressed={selected.bold}
                        onClick={() => updateSelected({ bold: !selected.bold })}
                        className={cn(
                          "flex h-8 w-8 items-center justify-center rounded-lg border",
                          selected.bold ? "border-forest bg-forest text-paper" : "border-line bg-paper text-ink/70",
                        )}
                      >
                        <BoldIcon className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label="Toggle italic"
                        aria-pressed={selected.italic}
                        onClick={() => updateSelected({ italic: !selected.italic })}
                        className={cn(
                          "flex h-8 w-8 items-center justify-center rounded-lg border",
                          selected.italic ? "border-forest bg-forest text-paper" : "border-line bg-paper text-ink/70",
                        )}
                      >
                        <Italic className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </>
                )}
                {(selected.type === "rect" || selected.type === "ellipse" || selected.type === "line" || selected.type === "arrow" || selected.type === "highlight") && (
                  <Field label="Colour">
                    <ColorInput value={selected.color} onChange={(color) => updateSelected({ color })} label="Element colour" />
                  </Field>
                )}
                {(selected.type === "rect" || selected.type === "ellipse") && (
                  <Switch
                    checked={selected.fill}
                    onChange={(fill) => updateSelected({ fill })}
                    label="Filled"
                    description="Off draws an outline only."
                  />
                )}
                {(selected.type === "line" || selected.type === "arrow" || !selected.fill) && selected.type !== "text" && selected.type !== "image" && selected.type !== "signature" && (
                  <Field label={`Stroke · ${selected.strokeWidth}pt`}>
                    <input
                      type="range"
                      min={0.5}
                      max={8}
                      step={0.5}
                      value={selected.strokeWidth}
                      onChange={(e) => updateSelected({ strokeWidth: Number(e.target.value) })}
                      className="w-full accent-[#1c4c3b]"
                    />
                  </Field>
                )}
                <Field label={`Opacity · ${Math.round(selected.opacity * 100)}%`}>
                  <input
                    type="range"
                    min={5}
                    max={100}
                    value={Math.round(selected.opacity * 100)}
                    onChange={(e) => updateSelected({ opacity: Number(e.target.value) / 100 })}
                    className="w-full accent-[#1c4c3b]"
                  />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Width pt">
                    <input
                      type="number"
                      value={Math.round(selected.w)}
                      min={10}
                      onChange={(e) => updateSelected({ w: clamp(Number(e.target.value) || 20, 10, pageW - selected.x) })}
                      className={cn(inputClass, "h-9")}
                    />
                  </Field>
                  <Field label="Height pt">
                    <input
                      type="number"
                      value={Math.round(selected.h)}
                      min={8}
                      onChange={(e) => updateSelected({ h: clamp(Number(e.target.value) || 10, 8, pageH - selected.y) })}
                      className={cn(inputClass, "h-9")}
                    />
                  </Field>
                </div>
                {(selected.type === "image" || selected.type === "signature") && (
                  <div className="space-y-2">
                    <Switch checked={prefs.value.lockAspect} onChange={(v) => prefs.set("lockAspect", v)} label="Keep proportions" />
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => {
                        replaceTarget.current = selected.id;
                        imageInput.current?.click();
                      }}
                    >
                      <Images className="h-3.5 w-3.5" /> Replace image
                    </Button>
                  </div>
                )}
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="flex-1" onClick={() => duplicate(selected.id)}>
                    <Copy className="h-3.5 w-3.5" /> Duplicate
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => removeEl(selected.id)} aria-label="Delete element">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {selected.type === "text" && (
                  <p className="rounded-lg bg-lime/20 px-2 py-1.5 text-[10.5px] leading-snug text-forest">
                    Long text wraps to the element width. The built-in PDF fonts support Latin characters; other scripts are omitted on export.
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-line bg-bone-deep/30 p-3">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">On this page</p>
            {pageEls.length === 0 ? (
              <p className="text-[11.5px] text-muted">Nothing added yet.</p>
            ) : (
              <ul className="space-y-1">
                {[...pageEls].reverse().map((el) => (
                  <li key={el.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveTool("select");
                        setSelectedId(el.id);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px]",
                        selectedId === el.id ? "bg-forest text-paper" : "hover:bg-paper",
                      )}
                    >
                      <span className="capitalize">{el.type}</span>
                      <span className="ml-auto truncate text-[10px] opacity-60">
                        {el.type === "text" ? el.text.slice(0, 16) || "text" : `p.${el.page + 1}`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-xl border border-line bg-lime/15 p-3 text-[11px] leading-relaxed text-forest">
            <p className="font-semibold">Non-destructive by design</p>
            <p className="mt-1 text-forest/90">We write your edits into a copy. The original PDF on your device is never changed.</p>
          </div>
        </aside>
      </div>

      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Your edited PDF is ready"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          originalSize={pdf.file?.size}
          onDownload={download}
          description={`${result.edits} element${result.edits === 1 ? "" : "s"} written across ${result.pagesTouched} page${result.pagesTouched === 1 ? "" : "s"} · original untouched`}
          facts={[
            { label: "Edits", value: String(result.edits) },
            { label: "Edited pages", value: String(result.pagesTouched) },
          ]}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * SIGN PDF
 * ------------------------------------------------------------------ */
interface SigPlacement {
  id: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  dataUrl: string;
  aspect: number;
  /** Degrees, clockwise on screen. */
  rotation: number;
}

interface SignResult {
  bytes: Uint8Array;
  name: string;
  pages: number;
  count: number;
  pagesSigned: number;
  locked: boolean;
}

const SAVED_SCOPE = "tool.sign.saved";
const MAX_SAVED_SIGNATURES = 6;

function readSavedSignatures(): SavedSignature[] {
  const stored = readPreferences<{ items: SavedSignature[] }>(SAVED_SCOPE, { items: [] });
  if (!Array.isArray(stored.items)) return [];
  return stored.items
    .filter((item): item is SavedSignature => Boolean(item) && typeof item.dataUrl === "string" && typeof item.id === "string")
    .slice(0, MAX_SAVED_SIGNATURES);
}

function writeSavedSignatures(items: SavedSignature[]): void {
  writePreferences(SAVED_SCOPE, { items: items.slice(0, MAX_SAVED_SIGNATURES) });
}

const todayValue = () => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
};

const formatDateLabel = (value: string): string => {
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

export function SignPdfTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const prefs = useToolPreferences("sign", {
    rememberSignatures: false,
    lockAfterSigning: false,
    showBlock: false,
    showDate: false,
  });
  const [pageIndex, setPageIndex] = useState(0);
  const [dims, setDims] = useState<{ width: number; height: number }[]>([]);
  const [preview, setPreview] = useState<RenderedPage | null>(null);
  const [signature, setSignature] = useState<{ dataUrl: string; aspect: number } | null>(null);
  const [studioOpen, setStudioOpen] = useState(false);
  const [placements, setPlacements] = useState<SigPlacement[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sessionSignatures, setSessionSignatures] = useState<SavedSignature[]>([]);
  const [savedSignatures, setSavedSignatures] = useState<SavedSignature[]>(() => readSavedSignatures());
  const [signerName, setSignerName] = useState("");
  const [reason, setReason] = useState("");
  const [location, setLocation] = useState("");
  const [dateValue, setDateValue] = useState(todayValue);
  const [locked, setLocked] = useState(false);
  const [displayWidth, setDisplayWidth] = useState(720);
  const [error, setError] = useState("");
  const job = useJob<SignResult>();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; startX: number; startY: number; orig: SigPlacement } | null>(null);

  const currentDims = dims[pageIndex] ?? { width: 612, height: 792 };
  const pageW = currentDims.width;
  const pageH = currentDims.height;
  const scale = displayWidth / pageW;
  const pagePlacements = placements.filter((p) => p.page === pageIndex);
  const selected = placements.find((p) => p.id === selectedId) ?? null;
  const result = job.result;
  const library = useMemo(() => {
    const seen = new Set<string>();
    return [...sessionSignatures, ...savedSignatures].filter((entry) => {
      if (seen.has(entry.dataUrl)) return false;
      seen.add(entry.dataUrl);
      return true;
    });
  }, [sessionSignatures, savedSignatures]);

  useEffect(() => {
    if (!pdf.bytes) {
      setDims([]);
      return;
    }
    const bytes = pdf.bytes;
    getPageDimensions(bytes).then(setDims).catch(() => undefined);
  }, [pdf.bytes]);

  useEffect(() => {
    if (!pdf.bytes) return;
    let alive = true;
    const bytes = pdf.bytes;
    (async () => {
      const doc = await openPdfJs(bytes);
      const rendered = await renderPdfPage(doc, pageIndex + 1, { targetWidth: 1000, type: "image/jpeg", quality: 0.9, rotation: 0 });
      await doc.destroy();
      if (alive) setPreview(rendered);
    })().catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [pdf.bytes, pageIndex]);

  useEffect(() => {
    const node = surfaceRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => setDisplayWidth(entries[0].contentRect.width));
    observer.observe(node);
    setDisplayWidth(node.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, [preview, pdf.bytes]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      const node = surfaceRef.current;
      if (!drag || !node || locked) return;
      const rect = node.getBoundingClientRect();
      const dx = ((e.clientX - drag.startX) / rect.width) * pageW;
      const dy = ((e.clientY - drag.startY) / rect.height) * pageH;
      setPlacements((items) =>
        items.map((p) => (p.id === drag.id ? { ...p, x: clamp(drag.orig.x + dx, 0, pageW - p.w), y: clamp(drag.orig.y + dy, 0, pageH - p.h) } : p)),
      );
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [pageW, pageH, locked]);

  const place = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!signature || !surfaceRef.current || locked) return;
    const rect = surfaceRef.current.getBoundingClientRect();
    const cx = ((e.clientX - rect.left) / rect.width) * pageW;
    const cy = ((e.clientY - rect.top) / rect.height) * pageH;
    const w = 190;
    const h = w / signature.aspect;
    const next: SigPlacement = {
      id: uid(),
      page: pageIndex,
      x: clamp(cx - w / 2, 0, Math.max(0, pageW - w)),
      y: clamp(cy - h / 2, 0, Math.max(0, pageH - h)),
      w,
      h,
      dataUrl: signature.dataUrl,
      aspect: signature.aspect,
      rotation: 0,
    };
    setPlacements((p) => [...p, next]);
    setSelectedId(next.id);
    job.reset();
  };

  const toggleLock = (next: boolean) => {
    setLocked(next);
    if (next) setSelectedId(null);
  };

  const addSignatureToLibrary = (dataUrl: string, aspect: number, label?: string) => {
    const entry: SavedSignature = { id: uid(), label: label?.trim() || "Signature", dataUrl, aspect };
    setSessionSignatures((prev) => [entry, ...prev.filter((item) => item.dataUrl !== dataUrl)].slice(0, MAX_SAVED_SIGNATURES));
    if (prefs.value.rememberSignatures) {
      setSavedSignatures((prev) => {
        const next = [entry, ...prev.filter((item) => item.dataUrl !== dataUrl)].slice(0, MAX_SAVED_SIGNATURES);
        writeSavedSignatures(next);
        return next;
      });
    }
  };

  const applySignature = (dataUrl: string, aspect: number, label?: string, kind?: SignSource) => {
    setSignature({ dataUrl, aspect });
    setStudioOpen(false);
    addSignatureToLibrary(dataUrl, aspect, label);
    // A typed signature is the signer's name, so reuse it in the block.
    if (kind === "typed" && label && !signerName.trim()) setSignerName(label);
  };

  const forgetSignature = (id: string) => {
    setSessionSignatures((prev) => prev.filter((entry) => entry.id !== id));
    setSavedSignatures((prev) => {
      const next = prev.filter((entry) => entry.id !== id);
      writeSavedSignatures(next);
      return next;
    });
  };

  const addStamp = (image: ImageData, label: string) => {
    applySignature(image.dataUrl, image.width / image.height, label, "drawn");
    setStudioOpen(false);
  };

  const save = async () => {
    const source = pdf.bytes;
    const file = pdf.file;
    if (!source || !file) return;
    if (!placements.length) {
      setError("Place your signature on the document first.");
      return;
    }
    setError("");
    await job.run(async ({ report, step, throwIfCancelled }) => {
      const doc = await openPdfLib(source);
      const fonts = await embedFonts(doc);
      const allPages = doc.getPages();
      const cache = new Map<string, Awaited<ReturnType<typeof doc.embedPng>>>();
      const dateLabel = prefs.value.showDate || prefs.value.showBlock ? formatDateLabel(dateValue) : "";
      const blockLines: string[] = [];
      if (prefs.value.showBlock) {
        if (signerName.trim()) blockLines.push(safePdfText(signerName.trim()));
        if (dateLabel) blockLines.push(safePdfText(dateLabel));
        if (reason.trim()) blockLines.push(safePdfText(`Reason: ${reason.trim()}`));
        if (location.trim()) blockLines.push(safePdfText(`Location: ${location.trim()}`));
        blockLines.push("Signed electronically with Paperly");
      }
      for (let index = 0; index < placements.length; index++) {
        throwIfCancelled();
        const p = placements[index];
        const page = allPages[p.page];
        if (page) {
          let image = cache.get(p.dataUrl);
          if (!image) {
            image = await doc.embedPng(dataUrlToBytes(p.dataUrl));
            cache.set(p.dataUrl, image);
          }
          const pageHeight = page.getHeight();
          const radians = (p.rotation * Math.PI) / 180;
          const centerX = p.x + p.w / 2;
          const centerY = pageHeight - p.y - p.h / 2;
          const drawX = centerX - (p.w / 2) * Math.cos(radians) + (p.h / 2) * Math.sin(radians);
          const drawY = centerY - (p.w / 2) * Math.sin(radians) - (p.h / 2) * Math.cos(radians);
          page.drawImage(image, {
            x: drawX,
            y: drawY,
            width: p.w,
            height: p.h,
            ...(p.rotation ? { rotate: degrees(p.rotation) } : {}),
          });
          if (prefs.value.showDate && dateLabel && !prefs.value.showBlock) {
            page.drawText(safePdfText(dateLabel), {
              x: p.x,
              y: pageHeight - p.y - p.h - 12,
              size: 8.5,
              font: fonts.regular,
              color: rgb(0.35, 0.42, 0.38),
            });
          }
          if (blockLines.length) {
            let cursor = pageHeight - p.y - p.h - 12;
            for (const line of blockLines) {
              page.drawText(line, {
                x: p.x,
                y: cursor,
                size: 7.5,
                font: fonts.regular,
                color: rgb(0.35, 0.42, 0.38),
              });
              cursor -= 9.5;
            }
          }
        }
        step(index + 1, placements.length, "Applying your signature…");
      }
      throwIfCancelled();
      report(96, "Saving the signed document…");
      const bytes = await doc.save();
      return {
        bytes,
        name: `${sanitizeName(baseName(file.name))}-signed.pdf`,
        pages: doc.getPageCount(),
        count: placements.length,
        pagesSigned: new Set(placements.map((p) => p.page)).size,
        locked: prefs.value.lockAfterSigning,
      };
    });
  };

  const download = () => {
    if (result) downloadOutput(result.bytes, result.name);
  };

  usePrimaryShortcut(() => void save(), Boolean(pdf.bytes) && placements.length > 0 && !job.busy && !locked);
  useDownloadShortcut(download, Boolean(result));

  useEffect(() => {
    if (job.succeeded && result?.locked) setLocked(true);
  }, [job.succeeded, result]);

  if (!pdf.file) {
    return (
      <div className="space-y-4">
        <FileDrop accept="application/pdf,.pdf" acceptLabel="A PDF to sign" onFiles={(f) => pdf.setFile(f[0])} sample={SAMPLE.pdf} />
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            { title: "Draw, type or upload", body: "Create a signature with a trackpad, finger, your name or an image." },
            { title: "Place precisely", body: "Click any page, then drag and rotate each placement into position." },
            { title: "Never uploaded", body: "Your signature and document stay in this browser tab." },
          ].map((f) => (
            <div key={f.title} className="rounded-xl border border-line bg-bone-deep/25 p-3.5">
              <p className="text-[12.5px] font-semibold">{f.title}</p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-muted">{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {studioOpen && (
        <SignatureStudio
          onClose={() => setStudioOpen(false)}
          onUse={applySignature}
          saved={library}
          onPick={(entry) => {
            setSignature({ dataUrl: entry.dataUrl, aspect: entry.aspect });
            setStudioOpen(false);
          }}
          onForget={forgetSignature}
        />
      )}
      <FileRow file={pdf.file} onRemove={pdf.clear} size={`${pdf.pageCount} pages · ${formatBytes(pdf.file.size)}`} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-bone-deep/40 p-2">
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" disabled={pageIndex === 0} onClick={() => { setPageIndex((i) => i - 1); setSelectedId(null); }} title="Previous page" aria-label="Previous page">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="min-w-[70px] text-center text-[11.5px] font-medium tabular-nums text-ink/70">
                Page {pageIndex + 1} / {pdf.pageCount}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={pageIndex >= pdf.pageCount - 1}
                onClick={() => { setPageIndex((i) => i + 1); setSelectedId(null); }}
                title="Next page"
                aria-label="Next page"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-[11.5px] text-muted">
              {locked ? "Locked — the document has been signed and flattened." : signature ? "Click a page to place your signature." : "Create a signature to begin."}
            </p>
          </div>

          {locked && (
            <Alert tone="success" title="Signed and locked">
              This document was flattened with your signature and the editor is locked so nothing can be moved afterwards.
              <button type="button" onClick={() => toggleLock(false)} className="ml-1 font-semibold underline">
                Unlock to edit
              </button>
            </Alert>
          )}

          <div className="rounded-xl border border-line bg-bone-deep/50 p-3 sm:p-5">
            <div className="mx-auto w-full max-w-[760px]">
              <div
                ref={surfaceRef}
                onPointerDown={place}
                className={cn("relative w-full overflow-hidden rounded-sm bg-white pdf-page-shadow", signature && !locked && "cursor-copy")}
                style={{ aspectRatio: `${pageW} / ${pageH}` }}
              >
                {preview ? (
                  <img src={preview.dataUrl} alt={`Page ${pageIndex + 1}`} className="pointer-events-none absolute inset-0 h-full w-full object-fill" loading="lazy" decoding="async" />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-[12px] text-ink/70">Rendering page…</div>
                )}
                {pagePlacements.map((p) => (
                  <div
                    key={p.id}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      if (locked) return;
                      setSelectedId(p.id);
                      dragRef.current = { id: p.id, startX: e.clientX, startY: e.clientY, orig: { ...p } };
                    }}
                    className={cn("absolute", locked ? "cursor-default" : "cursor-move", selectedId === p.id && !locked && "ring-2 ring-clay")}
                    style={{
                      left: p.x * scale,
                      top: p.y * scale,
                      width: p.w * scale,
                      height: p.h * scale,
                      transform: p.rotation ? `rotate(${-p.rotation}deg)` : undefined,
                    }}
                  >
                    <img src={p.dataUrl} alt="Placed signature" className="pointer-events-none h-full w-full object-contain" loading="lazy" decoding="async" />
                    {selectedId === p.id && !locked && (
                      <button
                        type="button"
                        aria-label="Remove signature"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => {
                          setPlacements((items) => items.filter((item) => item.id !== p.id));
                          setSelectedId(null);
                          job.reset();
                        }}
                        className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-ink text-paper"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void save()} loading={job.busy} disabled={locked}>
              <Signature className="h-4 w-4" /> Save signed PDF
            </Button>
            {job.busy && (
              <Button variant="ghost" size="sm" onClick={job.cancel}>
                Cancel
              </Button>
            )}
            <Button variant="outline" onClick={() => setStudioOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> New signature
            </Button>
            <span className="text-[11.5px] text-muted">
              {placements.length} signature{placements.length === 1 ? "" : "s"} placed on {new Set(placements.map((p) => p.page)).size || 0} page
              {new Set(placements.map((p) => p.page)).size === 1 ? "" : "s"}
            </span>
          </div>
          {job.busy && <Progress value={job.percent ?? undefined} label={job.label} detail={describeJobTime(job)} etaMs={job.etaMs} />}
          {job.status === "cancelled" && (
            <Alert tone="info">Cancelled — nothing was downloaded. Your placements are still here.</Alert>
          )}
          {error && <Alert tone="error">{error}</Alert>}
          {job.failed && <Alert tone="error">{job.error}</Alert>}

          <AdvancedOptions scope="sign" badge="5 controls" description="Signature block, date and locking" onReset={prefs.reset}>
            <div className="space-y-4">
              <Switch
                checked={prefs.value.showDate}
                onChange={(v) => prefs.set("showDate", v)}
                label="Add a date under each signature"
                description="Uses the date field below."
              />
              <Field label="Date on the document">
                <input type="date" value={dateValue} onChange={(e) => setDateValue(e.target.value)} className={inputClass} />
              </Field>
              <Switch
                checked={prefs.value.showBlock}
                onChange={(v) => prefs.set("showBlock", v)}
                label="Add a signature block"
                description="Name, date, reason and location printed beneath each signature."
              />
              {prefs.value.showBlock && (
                <OptionsGrid>
                  <Field label="Reason">
                    <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Approved for payment" className={inputClass} maxLength={90} />
                  </Field>
                  <Field label="Location">
                    <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. London, UK" className={inputClass} maxLength={70} />
                  </Field>
                </OptionsGrid>
              )}
              <Switch
                checked={prefs.value.lockAfterSigning}
                onChange={(v) => prefs.set("lockAfterSigning", v)}
                label="Lock after signing"
                description="Flattens the signature and freezes the editor once the file is saved."
              />
              <Switch
                checked={prefs.value.rememberSignatures}
                onChange={(v) => prefs.set("rememberSignatures", v)}
                label="Remember signatures on this device"
                description="Stores the signature image in this browser only. Turn off and forget them at any time."
              />
              {savedSignatures.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSavedSignatures([]);
                    writeSavedSignatures([]);
                  }}
                >
                  Forget {savedSignatures.length} saved signature{savedSignatures.length === 1 ? "" : "s"}
                </Button>
              )}
            </div>
          </AdvancedOptions>
        </div>

        <aside className="space-y-3">
          <div className="rounded-xl border border-line bg-paper p-3.5">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">Your signature</p>
            {signature ? (
              <div className="space-y-3">
                <div className="flex h-[86px] items-center justify-center rounded-lg border border-line bg-bone-deep/30 p-2">
                  <img src={signature.dataUrl} alt="Your signature" className="max-h-full max-w-full object-contain" loading="lazy" decoding="async" />
                </div>
                <Button variant="outline" size="sm" className="w-full" onClick={() => setStudioOpen(true)}>
                  Replace signature
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-[12px] leading-relaxed text-muted">Draw, type or upload a signature. It stays on your device.</p>
                <Button size="sm" className="w-full" onClick={() => setStudioOpen(true)}>
                  <Signature className="h-3.5 w-3.5" /> Create signature
                </Button>
              </div>
            )}
            {library.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {library.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      onClick={() => setSignature({ dataUrl: entry.dataUrl, aspect: entry.aspect })}
                      aria-pressed={signature?.dataUrl === entry.dataUrl}
                      title={entry.label}
                      className={cn(
                        "flex h-9 items-center rounded-md border px-1.5",
                        signature?.dataUrl === entry.dataUrl ? "border-forest bg-lime/30" : "border-line bg-paper hover:border-forest/40",
                      )}
                    >
                      <img src={entry.dataUrl} alt={entry.label} className="h-6 max-w-[84px] object-contain" loading="lazy" decoding="async" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-xl border border-line bg-paper p-3.5">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">Quick stamps</p>
            <div className="space-y-2">
              <Field label="Signer name" hint="Used for the initials stamp and the signature block.">
                <input value={signerName} onChange={(e) => setSignerName(e.target.value)} placeholder="Your full name" className={inputClass} maxLength={80} />
              </Field>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  disabled={!formatDateLabel(dateValue)}
                  onClick={() => addStamp(textStamp(formatDateLabel(dateValue), { italic: false, size: 96 }), "Date stamp")}
                >
                  <CalendarDays className="h-3.5 w-3.5" /> Date stamp
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  disabled={!signerName.trim()}
                  onClick={() => {
                    const initials = signerName
                      .trim()
                      .split(/\s+/)
                      .map((part) => part[0] ?? "")
                      .join("")
                      .slice(0, 3)
                      .toUpperCase();
                    if (initials) addStamp(textStamp(initials, { italic: true, size: 150 }), "Initials");
                  }}
                  title={signerName.trim() ? "Create an initials stamp from your name" : "Type your name first"}
                >
                  <UserRound className="h-3.5 w-3.5" /> Initials
                </Button>
              </div>
            </div>
          </div>

          {selected && !locked && (
            <div className="rounded-xl border border-line bg-paper p-3.5">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">Selected signature</p>
              <div className="space-y-3">
                <Field label={`Width · ${Math.round(selected.w)}pt`}>
                  <input
                    type="range"
                    min={50}
                    max={400}
                    value={Math.round(selected.w)}
                    onChange={(e) => {
                      const width = Number(e.target.value);
                      setPlacements((items) =>
                        items.map((item) => (item.id === selected.id ? { ...item, w: width, h: width / Math.max(0.2, item.aspect) } : item)),
                      );
                    }}
                    className="w-full accent-[#1c4c3b]"
                  />
                </Field>
                <Field label={`Rotation · ${Math.round(selected.rotation)}°`}>
                  <input
                    type="range"
                    min={-45}
                    max={45}
                    step={1}
                    value={selected.rotation}
                    onChange={(e) => {
                      const rotation = Number(e.target.value);
                      setPlacements((items) => items.map((item) => (item.id === selected.id ? { ...item, rotation } : item)));
                    }}
                    className="w-full accent-[#1c4c3b]"
                  />
                </Field>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => {
                      const pageNumbers = Array.from({ length: pdf.pageCount }, (_, index) => index);
                      setPlacements((items) => {
                        const existing = new Set(items.filter((item) => item.dataUrl === selected.dataUrl).map((item) => item.page));
                        const additions = pageNumbers
                          .filter((page) => !existing.has(page))
                          .map((page) => ({ ...selected, id: uid(), page }));
                        return [...items, ...additions];
                      });
                    }}
                    title="Place the same signature on every page that has none"
                  >
                    All pages
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setPlacements((items) => items.filter((item) => item.id !== selected.id));
                      setSelectedId(null);
                      job.reset();
                    }}
                    aria-label="Remove selected signature"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          )}

          <div className="rounded-xl border border-line bg-bone-deep/30 p-3 text-[11px] leading-relaxed text-muted">
            <p className="flex items-center gap-1.5 font-semibold text-ink/70">
              <Lock className="h-3.5 w-3.5 text-forest" /> About e-signatures
            </p>
            <p className="mt-1">
              This adds a visual signature. It isn’t a certificate-backed digital signature. For contracts that require identity verification, use a
              dedicated e-signature service.
            </p>
          </div>
        </aside>
      </div>

      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Document signed"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          originalSize={pdf.file?.size}
          onDownload={download}
          description={`${result.count} signature${result.count === 1 ? "" : "s"} on ${result.pagesSigned} page${result.pagesSigned === 1 ? "" : "s"} · visual signature only · original file untouched`}
          facts={[
            { label: "Signatures", value: String(result.count) },
            { label: "Flattened", value: result.locked ? "Locked" : "Yes" },
          ]}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * WATERMARK PDF
 * ------------------------------------------------------------------ */
const MM = 2.834645669;
type WmRow = "top" | "middle" | "bottom";
type WmCol = "left" | "center" | "right";
type WmTiling = "single" | "grid" | "diagonal";
type WmFamily = "helvetica" | "times" | "courier";

/**
 * Move the content stream pdf-lib just appended for this page in front of the
 * page's original content, so the watermark sits *behind* the text. Every draw
 * call for one page shares a single content stream, so moving its last entry is
 * enough and the original text layer, links and annotations stay intact.
 */
function moveLastContentStreamToFront(page: PDFPage): boolean {
  const contents = page.node.Contents();
  if (!(contents instanceof PDFArray) || contents.size() < 2) return false;
  const last: PDFObject = contents.get(contents.size() - 1);
  contents.remove(contents.size() - 1);
  contents.insert(0, last);
  return true;
}

/** Relative luminance (0 = black, 1 = white) of a hex colour. */
function luminanceOf(hex: string): number {
  const clean = hex.replace("#", "").padEnd(6, "0");
  const value = Number.parseInt(clean.slice(0, 6), 16);
  const channel = (raw: number) => {
    const srgb = raw / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((value >> 16) & 255) + 0.7152 * channel((value >> 8) & 255) + 0.0722 * channel(value & 255);
}

interface WatermarkResult {
  bytes: Uint8Array;
  name: string;
  pages: number;
  behindPages: number;
  kind: "text" | "image";
  opacity: number;
  rotation: number;
  behind: boolean;
  layout: string;
}

const POSITION_LABELS: Record<WmRow, string> = { top: "Top", middle: "Middle", bottom: "Bottom" };
const COL_LABELS: Record<WmCol, string> = { left: "Left", center: "Centre", right: "Right" };

export function WatermarkTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const { thumbs } = usePdfThumbs(pdf.bytes, { width: 360, quality: 0.8, max: 1 });
  const prefs = useToolPreferences("watermark", {
    kind: "text" as "text" | "image",
    text: "CONFIDENTIAL",
    size: 52,
    color: "#e8613c",
    opacity: 18,
    rotation: 35,
    row: "middle" as WmRow,
    col: "center" as WmCol,
    tiling: "single" as WmTiling,
    margin: 18,
    family: "helvetica" as WmFamily,
    bold: true,
    behind: false,
    imageScale: 42,
  });
  const [imageData, setImageData] = useState<string | null>(null);
  const [imageAspect, setImageAspect] = useState(1);
  const [range, setRange] = useState("");
  const [error, setError] = useState("");
  const job = useJob<WatermarkResult>();
  const result = job.result;

  const value = prefs.value;
  const totalPages = pdf.pageCount || 0;
  const contrastWarning = (() => {
    if (value.opacity < 5) return "At this opacity the watermark is effectively invisible on any page.";
    if (value.kind === "text" && luminanceOf(value.color) > 0.92) {
      return "This colour is nearly white — on a white page the watermark won’t be visible. Pick a darker colour or raise the opacity.";
    }
    return "";
  })();

  const pagesSelected = (() => {
    if (!totalPages) return 0;
    try {
      return uniqueInOrder(parseRanges(range, totalPages)).length;
    } catch {
      return 0;
    }
  })();

  const save = async () => {
    const source = pdf.bytes;
    const file = pdf.file;
    if (!source || !file) return;
    setError("");
    try {
      if (value.kind === "text" && !value.text.trim()) throw new Error("Enter the watermark text.");
      if (value.kind === "text" && !safePdfText(value.text).trim()) {
        throw new Error("Use Latin characters for the watermark — the built-in PDF fonts can’t encode other scripts.");
      }
      if (value.kind === "image" && !imageData) throw new Error("Upload a watermark image first.");
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    let pages: number[];
    try {
      pages = uniqueInOrder(parseRanges(range, totalPages));
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    await job.run(async ({ report, step, throwIfCancelled }) => {
      const doc = await openPdfLib(source);
      const allPages = doc.getPages();
      const fonts = await embedFonts(doc);
      const font =
        value.family === "times"
          ? await doc.embedFont(value.bold ? StandardFonts.TimesRomanBold : StandardFonts.TimesRoman)
          : value.family === "courier"
            ? await doc.embedFont(value.bold ? StandardFonts.CourierBold : StandardFonts.Courier)
            : value.bold
              ? fonts.bold
              : fonts.regular;
      const text = safePdfText(value.text);
      let embedded: Awaited<ReturnType<typeof doc.embedPng>> | null = null;
      if (value.kind === "image" && imageData) embedded = await doc.embedPng(dataUrlToBytes(imageData));
      let behindPages = 0;
      for (let index = 0; index < pages.length; index++) {
        throwIfCancelled();
        const page = allPages[pages[index] - 1];
        if (page) {
          const { width, height } = page.getSize();
          const margin = value.margin * MM;
          const opacity = value.opacity / 100;
          let drew = false;
          if (value.kind === "text") {
            const textWidth = font.widthOfTextAtSize(text, value.size);
            const textHeight = value.size;
            const radians = (value.rotation * Math.PI) / 180;
            const halfWidth = (textWidth / 2) * Math.abs(Math.cos(radians)) + (textHeight / 2) * Math.abs(Math.sin(radians));
            const halfHeight = (textWidth / 2) * Math.abs(Math.sin(radians)) + (textHeight / 2) * Math.abs(Math.cos(radians));
            const centerX =
              value.col === "left" ? margin + halfWidth : value.col === "right" ? width - margin - halfWidth : width / 2;
            const centerY =
              value.row === "top" ? height - margin - halfHeight : value.row === "bottom" ? margin + halfHeight : height / 2;
            const drawAt = (cx: number, cy: number) => {
              page.drawText(text, {
                x: cx - (textWidth / 2) * Math.cos(radians) + (textHeight * 0.3) * Math.sin(radians),
                y: cy - (textWidth / 2) * Math.sin(radians) - (textHeight * 0.3) * Math.cos(radians),
                size: value.size,
                font,
                color: hexToRgb(value.color),
                opacity,
                rotate: degrees(value.rotation),
              });
            };
            if (value.tiling === "single") {
              drawAt(centerX, centerY);
              drew = true;
            } else {
              const stepX = textWidth + Math.max(40, value.size * 1.6);
              const stepY = textHeight + Math.max(30, value.size * 1.2);
              for (let y = stepY / 2; y < height + stepY; y += stepY) {
                const stagger = value.tiling === "diagonal" ? ((Math.round(y / stepY) % 2) * stepX) / 2 : 0;
                for (let x = -stepX; x < width + stepX; x += stepX) {
                  page.drawText(text, {
                    x: x + stagger,
                    y,
                    size: value.size,
                    font,
                    color: hexToRgb(value.color),
                    opacity,
                    rotate: degrees(value.tiling === "diagonal" ? Math.max(30, value.rotation) : value.rotation),
                  });
                }
              }
              drew = true;
            }
          } else if (embedded) {
            const w = width * (value.imageScale / 100) * (value.tiling === "single" ? 1 : 0.55);
            const h = w / Math.max(0.1, imageAspect);
            if (value.tiling === "single") {
              const x = value.col === "left" ? margin : value.col === "right" ? width - margin - w : (width - w) / 2;
              const y = value.row === "top" ? height - margin - h : value.row === "bottom" ? margin : (height - h) / 2;
              page.drawImage(embedded, {
                x,
                y,
                width: w,
                height: h,
                opacity,
                rotate: degrees(value.rotation),
              });
              drew = true;
            } else {
              const cols = Math.max(2, Math.floor(width / (w + margin)));
              const rows = Math.max(2, Math.floor(height / (h + margin)));
              for (let row = 0; row < rows; row++) {
                for (let col = 0; col < cols; col++) {
                  const stagger = value.tiling === "diagonal" && row % 2 ? (width / cols) / 2 : 0;
                  page.drawImage(embedded, {
                    x: (width / cols) * col + (width / cols - w) / 2 + stagger,
                    y: (height / rows) * row + (height / rows - h) / 2,
                    width: w,
                    height: h,
                    opacity,
                    rotate: degrees(value.rotation),
                  });
                }
              }
              drew = true;
            }
          }
          if (value.behind && drew && moveLastContentStreamToFront(page)) behindPages += 1;
        }
        step(index + 1, pages.length, "Stamping pages…");
      }
      throwIfCancelled();
      report(96, "Saving the watermarked copy…");
      const bytes = await doc.save();
      return {
        bytes,
        name: `${sanitizeName(baseName(file.name))}-watermarked.pdf`,
        pages: pages.length,
        behindPages,
        kind: value.kind,
        opacity: value.opacity,
        rotation: value.rotation,
        behind: value.behind,
        layout:
          value.tiling === "single"
            ? `${POSITION_LABELS[value.row]} ${COL_LABELS[value.col]}`
            : value.tiling === "grid"
              ? "Tiled"
              : "Diagonal repeat",
      };
    });
  };

  const download = () => {
    if (result) downloadOutput(result.bytes, result.name);
  };

  usePrimaryShortcut(() => void save(), Boolean(pdf.bytes) && !job.busy);
  useDownloadShortcut(download, Boolean(result));

  const previewTextStyle = {
    color: value.color,
    fontFamily:
      value.family === "times" ? "Georgia, serif" : value.family === "courier" ? '"Courier New", monospace' : "Helvetica, Arial, sans-serif",
    fontWeight: value.bold ? 700 : 400,
    fontSize: value.size * 0.34,
    whiteSpace: "nowrap" as const,
  };
  const previewImage = value.kind === "image" && imageData;
  const tileSlots = value.tiling === "diagonal" ? 9 : 6;

  return (
    <div className="space-y-5">
      <SinglePdfInput state={pdf} acceptLabel="A PDF to watermark" />
      {pdf.bytes && (
        <div className="grid gap-5 md:grid-cols-[1fr_280px]">
          <div className="space-y-4">
            <div>
              <StepHeader step={2} title="Watermark content" />
              <div className="mb-3 grid grid-cols-2 gap-2">
                {(["text", "image"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={value.kind === k}
                    onClick={() => prefs.set("kind", k)}
                    className={cn(
                      "rounded-xl border py-2 text-[12.5px] font-medium capitalize",
                      value.kind === k ? "border-forest bg-forest text-paper" : "border-line bg-paper text-ink/70",
                    )}
                  >
                    {k === "text" ? "Text watermark" : "Image / logo"}
                  </button>
                ))}
              </div>
              {value.kind === "text" ? (
                <Field label="Text">
                  <input value={value.text} onChange={(e) => prefs.set("text", e.target.value)} className={inputClass} maxLength={80} />
                </Field>
              ) : (
                <Field label="Image">
                  <div className="rounded-xl border border-dashed border-line bg-bone-deep/30 p-3">
                    {imageData ? (
                      <div className="flex items-center gap-3">
                        <img src={imageData} alt="Watermark" className="h-12 w-12 rounded border border-line bg-white object-contain" loading="lazy" decoding="async" />
                        <Button variant="ghost" size="sm" onClick={() => setImageData(null)}>
                          Remove
                        </Button>
                      </div>
                    ) : (
                      <label className="flex cursor-pointer items-center gap-2 text-[12px] font-medium text-forest">
                        <Plus className="h-4 w-4" /> Choose a PNG or JPG
                        <input
                          type="file"
                          accept="image/png,image/jpeg"
                          className="sr-only"
                          onChange={async (e) => {
                            const file = e.target.files?.[0];
                            e.target.value = "";
                            if (!file) return;
                            try {
                              await validateUpload(file, "image/png,image/jpeg,.png,.jpg,.jpeg");
                              const image = await imageFileToPng(file, 1200);
                              setImageData(image.dataUrl);
                              setImageAspect(image.width / image.height);
                            } catch (err) {
                              setError(friendlyProcessingError(err, "That image couldn’t be used as a watermark."));
                            }
                          }}
                        />
                      </label>
                    )}
                  </div>
                </Field>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              {value.kind === "text" ? (
                <>
                  <Field label={`Font size · ${value.size}pt`}>
                    <input
                      type="range"
                      min={12}
                      max={140}
                      value={value.size}
                      onChange={(e) => prefs.set("size", Number(e.target.value))}
                      className="mt-3 w-full accent-[#1c4c3b]"
                    />
                  </Field>
                  <Field label="Colour">
                    <ColorInput value={value.color} onChange={(v) => prefs.set("color", v)} label="Watermark colour" />
                  </Field>
                  <Field label="Font">
                    <Select value={value.family} onChange={(e) => prefs.set("family", e.target.value as WmFamily)}>
                      <option value="helvetica">Helvetica</option>
                      <option value="times">Times</option>
                      <option value="courier">Courier</option>
                    </Select>
                  </Field>
                  <Field label="Weight">
                    <button
                      type="button"
                      aria-pressed={value.bold}
                      onClick={() => prefs.set("bold", !value.bold)}
                      className={cn(
                        "h-11 w-full rounded-xl border text-[12.5px] font-semibold",
                        value.bold ? "border-forest bg-forest text-paper" : "border-line bg-paper text-ink/70",
                      )}
                    >
                      Bold
                    </button>
                  </Field>
                </>
              ) : (
                <Field label={`Image size · ${value.imageScale}% of page width`}>
                  <input
                    type="range"
                    min={10}
                    max={100}
                    value={value.imageScale}
                    onChange={(e) => prefs.set("imageScale", Number(e.target.value))}
                    className="mt-3 w-full accent-[#1c4c3b]"
                  />
                </Field>
              )}
              <Field label={`Opacity · ${value.opacity}%`}>
                <input
                  type="range"
                  min={3}
                  max={90}
                  value={value.opacity}
                  onChange={(e) => prefs.set("opacity", Number(e.target.value))}
                  className="mt-3 w-full accent-[#1c4c3b]"
                />
              </Field>
              <Field label={`Rotation · ${value.rotation}°`}>
                <input
                  type="range"
                  min={-90}
                  max={90}
                  step={5}
                  value={value.rotation}
                  onChange={(e) => prefs.set("rotation", Number(e.target.value))}
                  className="mt-3 w-full accent-[#1c4c3b]"
                />
              </Field>
              <Field label={`Edge margin · ${value.margin} mm`}>
                <input
                  type="range"
                  min={5}
                  max={60}
                  value={value.margin}
                  onChange={(e) => prefs.set("margin", Number(e.target.value))}
                  className="mt-3 w-full accent-[#1c4c3b]"
                />
              </Field>
            </div>

            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/55">Position</p>
              <div className="flex flex-wrap items-center gap-2">
                <div className="grid grid-cols-3 gap-1" role="group" aria-label="Watermark position">
                  {(["top", "middle", "bottom"] as WmRow[]).map((row) =>
                    (["left", "center", "right"] as WmCol[]).map((col) => {
                      const active = value.row === row && value.col === col;
                      return (
                        <button
                          key={`${row}-${col}`}
                          type="button"
                          aria-pressed={active}
                          aria-label={`${POSITION_LABELS[row]} ${COL_LABELS[col]}`}
                          title={`${POSITION_LABELS[row]} ${COL_LABELS[col]}`}
                          onClick={() => prefs.patch({ row, col })}
                          className={cn(
                            "h-7 w-7 rounded-md border text-[9px] font-semibold",
                            active ? "border-forest bg-forest text-paper" : "border-line bg-paper text-ink/50 hover:border-forest/40",
                          )}
                        >
                          {row === "top" ? "↑" : row === "middle" ? "·" : "↓"}
                          {col === "left" ? "←" : col === "center" ? "" : "→"}
                        </button>
                      );
                    }),
                  )}
                </div>
                <div className="flex flex-wrap gap-1">
                  {(
                    [
                      { id: "single", label: "Single" },
                      { id: "grid", label: "Tile" },
                      { id: "diagonal", label: "Diagonal repeat" },
                    ] as { id: WmTiling; label: string }[]
                  ).map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      aria-pressed={value.tiling === option.id}
                      onClick={() => prefs.set("tiling", option.id)}
                      className={cn(
                        "h-7 rounded-md border px-2 text-[10.5px] font-medium",
                        value.tiling === option.id ? "border-forest bg-forest text-paper" : "border-line bg-paper text-ink/60",
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="mt-1 text-[10.5px] text-muted">Tiling ignores the 9-point position and repeats the mark across the page.</p>
            </div>

            <Switch
              checked={value.behind}
              onChange={(v) => prefs.set("behind", v)}
              label="Place behind the page content"
              description="The text stays on top and selectable; links and annotations are preserved."
            />

            <RangeField value={range} onChange={setRange} total={pdf.pageCount} label="Pages" hint="Leave empty to watermark every page. Odd and even shortcuts work here." />

            {contrastWarning && (
              <Alert tone="warning" title="This watermark may be invisible">
                {contrastWarning}
              </Alert>
            )}
            {error && <Alert tone="error">{error}</Alert>}
            {job.failed && <Alert tone="error">{job.error}</Alert>}
            {job.status === "cancelled" && <Alert tone="info">Cancelled — nothing was downloaded.</Alert>}
            {job.busy && (
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <Progress value={job.percent ?? undefined} label={job.label} detail={describeJobTime(job)} etaMs={job.etaMs} />
                </div>
                <Button variant="ghost" size="sm" onClick={job.cancel}>
                  Cancel
                </Button>
              </div>
            )}

            <div className="border-t border-line pt-4">
              <Button onClick={() => void save()} loading={job.busy}>
                <Stamp className="h-4 w-4" /> Apply watermark
              </Button>
              <span className="ml-2 text-[11.5px] text-muted">
                {pagesSelected ? `${pagesSelected} page${pagesSelected === 1 ? "" : "s"}` : "Choose at least one page"}
              </span>
            </div>
          </div>

          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/75">Preview</p>
            <div className="surface overflow-hidden p-2.5">
              {thumbs[0] ? (
                <div className="relative overflow-hidden">
                  <img src={thumbs[0].dataUrl} alt="Watermark preview" className="w-full" loading="lazy" decoding="async" />
                  <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{ opacity: value.opacity / 100 }}>
                    {value.tiling === "single" ? (
                      <div
                        className="absolute"
                        style={{
                          width: previewImage ? `${value.imageScale}%` : undefined,
                          left: value.col === "left" ? "6%" : value.col === "right" ? "94%" : "50%",
                          top: value.row === "top" ? "6%" : value.row === "bottom" ? "94%" : "50%",
                          transform: `translate(-50%, -50%) rotate(${-value.rotation}deg)`,
                        }}
                      >
                        {previewImage ? (
                          <img src={imageData ?? ""} alt="" className="w-full object-contain" loading="lazy" decoding="async" />
                        ) : (
                          <span style={previewTextStyle}>{value.text || "Watermark"}</span>
                        )}
                      </div>
                    ) : (
                      <div
                        className="absolute inset-0 grid"
                        style={{
                          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                          alignContent: "space-around",
                          justifyItems: "center",
                        }}
                      >
                        {Array.from({ length: tileSlots }).map((_, index) => (
                          <span
                            key={index}
                            style={{
                              ...(previewImage ? {} : previewTextStyle),
                              width: previewImage ? "70%" : undefined,
                              transform: `rotate(${-value.rotation}deg)`,
                              marginLeft: value.tiling === "diagonal" && index % 2 ? 18 : 0,
                            }}
                          >
                            {previewImage ? (
                              <img src={imageData ?? ""} alt="" className="w-full object-contain" loading="lazy" decoding="async" />
                            ) : (
                              value.text || "Watermark"
                            )}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex aspect-[3/4] animate-pulse items-center justify-center bg-bone-deep text-[11px] text-ink/70">Rendering…</div>
              )}
            </div>
            <p className="mt-2 text-[10.5px] leading-snug text-muted">
              Preview is illustrative; the exported watermark uses precise PDF coordinates. Drag the sliders to see the effect immediately.
            </p>
            <Button variant="ghost" size="sm" className="mt-2" onClick={prefs.reset}>
              Reset options
            </Button>
          </div>
        </div>
      )}
      {result && (
        <DownloadPanel
          bytes={result.bytes}
          title="Watermark applied"
          filename={result.name}
          size={result.bytes.byteLength}
          pages={result.pages}
          originalSize={pdf.file?.size}
          onDownload={download}
          description={`${result.pages} page${result.pages === 1 ? "" : "s"} stamped · ${result.kind === "text" ? "text" : "image"} watermark · ${result.opacity}% opacity${
            result.behind && result.behindPages ? ` · behind the content on ${result.behindPages} page${result.behindPages === 1 ? "" : "s"}` : ""
          }`}
          facts={[
            { label: "Layout", value: result.layout },
            { label: "Rotation", value: `${result.rotation}°` },
          ]}
        />
      )}
    </div>
  );
}
