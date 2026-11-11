import {
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  Copy,
  Download,
  Eraser,
  Highlighter,
  Images,
  Minus,
  Move,
  Plus,
  Redo2,
  Signature,
  Square,
  Stamp,
  Trash2,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  baseName,
  dataUrlToBytes,
  degrees,
  downloadBytes,
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
import { useInitialFiles, usePdfFile, usePdfThumbs } from "@/lib/usePdf";
import { friendlyProcessingError, validateUpload } from "@/lib/security";
import type { RenderedPage } from "@/lib/pdf";
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
import { cn } from "@/utils/cn";

/* ------------------------------------------------------------------ *
 * Image helpers
 * ------------------------------------------------------------------ */
async function imageFileToPng(file: File, maxDimension = 1400): Promise<{ dataUrl: string; width: number; height: number }> {
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

function trimTransparent(canvas: HTMLCanvasElement): string {
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
  if (!found) return canvas.toDataURL("image/png");
  const pad = 14;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width, maxX + pad);
  maxY = Math.min(height, maxY + pad);
  const out = document.createElement("canvas");
  out.width = maxX - minX;
  out.height = maxY - minY;
  out.getContext("2d")!.drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

/* ------------------------------------------------------------------ *
 * Signature studio
 * ------------------------------------------------------------------ */
type SignTab = "draw" | "type" | "upload";

export function SignatureStudio({
  onUse,
  onClose,
}: {
  onUse: (dataUrl: string, aspect: number) => void;
  onClose: () => void;
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

  const renderTyped = (): string | null => {
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
    const data = renderTyped();
    if (data) onUse(data, 900 / 260);
  };

  const useCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas || !hasInk) return;
    onUse(trimTransparent(canvas), canvas.width / canvas.height);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/55 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Create a signature">
      <div className="w-full max-w-xl animate-pop overflow-hidden rounded-2xl border border-line bg-paper shadow-lift">
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
                  onUse(result.dataUrl, result.width / result.height);
                }}
              />
              <p className="mt-2 text-[11px] text-muted">A transparent PNG works best. We remove nothing from your image.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * EDIT PDF
 * ------------------------------------------------------------------ */
type ElType = "text" | "rect" | "ellipse" | "line" | "highlight" | "whiteout" | "image" | "signature";
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
  text: string;
  image?: string;
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
  { id: "highlight", label: "Highlight", icon: Highlighter },
  { id: "whiteout", label: "Whiteout", icon: Eraser },
];

export function EditPdfTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
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
  const [displayWidth, setDisplayWidth] = useState(720);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; pages: number; edits: number } | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const past = useRef<El[][]>([]);
  const future = useRef<El[][]>([]);
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
  const scale = displayWidth / pageW;
  const selected = elements.find((el) => el.id === selectedId) ?? null;
  const pageEls = elements.filter((el) => el.page === pageIndex);

  useEffect(() => {
    setPageIndex(0);
    setElements([]);
    setResult(null);
    setSelectedId(null);
    if (!pdf.bytes) {
      setDims([]);
      return;
    }
    const bytes = pdf.bytes;
    getPageDimensions(bytes).then(setDims).catch(() => undefined);
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
    const node = surfaceRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => setDisplayWidth(entries[0].contentRect.width));
    observer.observe(node);
    setDisplayWidth(node.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, [preview, pageIndex, pdf.bytes]);

  const snapshot = () => {
    past.current = [...past.current.slice(-40), elements];
    future.current = [];
  };
  const undo = () => {
    const previous = past.current.pop();
    if (!previous) return;
    future.current = [...future.current.slice(-40), elements];
    setElements(previous);
    setSelectedId(null);
  };
  const redo = () => {
    const next = future.current.pop();
    if (!next) return;
    past.current = [...past.current.slice(-40), elements];
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
      color: "#12211a",
      opacity: 1,
      fontSize: 14,
      bold: false,
      text: "",
      ...partial,
    };
    setElements((els) => [...els, element]);
    setSelectedId(element.id);
    setActiveTool("select");
  };

  const placeFromClick = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (activeTool === "select" || !surfaceRef.current) return;
    const rect = surfaceRef.current.getBoundingClientRect();
    const x = clamp(((e.clientX - rect.left) / rect.width) * pageW, 0, pageW);
    const y = clamp(((e.clientY - rect.top) / rect.height) * pageH, 0, pageH);
    if (activeTool === "text") {
      addEl({ type: "text", x, y, w: 220, h: 30, text: "Your text", fontSize: 14 });
    } else if (activeTool === "rect") {
      addEl({ type: "rect", x, y, w: 160, h: 80, color: "#1c4c3b", opacity: 0.15 });
    } else if (activeTool === "ellipse") {
      addEl({ type: "ellipse", x, y, w: 150, h: 90, color: "#1c4c3b", opacity: 0.15 });
    } else if (activeTool === "line") {
      addEl({ type: "line", x, y, w: 180, h: 40, color: "#1c4c3b", opacity: 1 });
    } else if (activeTool === "highlight") {
      addEl({ type: "highlight", x: x - 80, y: y - 12, w: 180, h: 26, color: "#f6e05e", opacity: 0.42 });
    } else if (activeTool === "whiteout") {
      addEl({ type: "whiteout", x: x - 70, y: y - 16, w: 150, h: 34, color: "#ffffff", opacity: 1 });
    } else if (activeTool === "image") {
      if (!imageSource) {
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
          return { ...el, w: clamp(drag.orig.w + dx, 24, pageW - el.x), h: clamp(drag.orig.h + dy, 16, pageH - el.y) };
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
  }, [pageW, pageH]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      if (e.key === "Delete" || e.key === "Backspace") {
        if (typing || !selectedId) return;
        e.preventDefault();
        snapshot();
        setElements((els) => els.filter((el) => el.id !== selectedId));
        setSelectedId(null);
      }
      if (e.key === "Escape") setSelectedId(null);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !typing) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y" && !typing) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const updateSelected = (patch: Partial<El>) => {
    if (!selectedId) return;
    setElements((els) => els.map((el) => (el.id === selectedId ? { ...el, ...patch } : el)));
    setResult(null);
  };

  const exportPdf = async () => {
    if (!pdf.bytes || !pdf.file) return;
    if (!elements.length) {
      setError("Add at least one edit before exporting.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const doc = await openPdfLib(pdf.bytes);
      const fonts = await embedFonts(doc);
      const allPages = doc.getPages();
      const imageCache = new Map<string, Awaited<ReturnType<typeof doc.embedPng>>>();
      for (const el of elements) {
        const page = allPages[el.page];
        if (!page) continue;
        const pageHeight = page.getHeight();
        const y = pageHeight - el.y - el.h;
        if (el.type === "image" || el.type === "signature") {
          if (!el.image) continue;
          let embedded = imageCache.get(el.image);
          if (!embedded) {
            embedded = await doc.embedPng(dataUrlToBytes(el.image));
            imageCache.set(el.image, embedded);
          }
          const drawY = pageHeight - el.y - el.h;
          page.drawImage(embedded, { x: el.x, y: drawY, width: el.w, height: el.h, opacity: el.opacity });
        } else if (el.type === "text") {
          const lines = wrapText(el.text || " ", {
            font: el.bold ? fonts.bold : fonts.regular,
            size: el.fontSize,
            color: el.color,
            maxWidth: Math.max(30, el.w),
          });
          lines.forEach((line, i) => {
            page.drawText(line, {
              x: el.x,
              y: pageHeight - el.y - el.fontSize - i * el.fontSize * 1.28,
              size: el.fontSize,
              font: el.bold ? fonts.bold : fonts.regular,
              color: hexToRgb(el.color),
              opacity: el.opacity,
            });
          });
        } else if (el.type === "rect" || el.type === "highlight" || el.type === "whiteout") {
          page.drawRectangle({
            x: el.x,
            y,
            width: el.w,
            height: el.h,
            color: hexToRgb(el.color),
            opacity: el.opacity,
            ...(el.type === "highlight" ? { borderColor: rgb(0.95, 0.82, 0.25), borderWidth: 0.8 } : {}),
          });
        } else if (el.type === "ellipse") {
          page.drawEllipse({
            x: el.x + el.w / 2,
            y: y + el.h / 2,
            xScale: el.w / 2,
            yScale: el.h / 2,
            color: hexToRgb(el.color),
            opacity: el.opacity,
          });
        } else if (el.type === "line") {
          page.drawLine({
            start: { x: el.x, y: pageHeight - el.y },
            end: { x: el.x + el.w, y: pageHeight - el.y - el.h },
            thickness: 1.8,
            color: hexToRgb(el.color),
            opacity: el.opacity,
          });
        }
      }
      const bytes = await doc.save();
      setResult({
        bytes,
        name: `${sanitizeName(baseName(pdf.file.name))}-edited.pdf`,
        pages: doc.getPageCount(),
        edits: elements.length,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startDrag = (e: ReactPointerEvent, el: El, mode: "move" | "resize") => {
    if (activeTool !== "select" && mode === "move") return;
    e.stopPropagation();
    e.preventDefault();
    setSelectedId(el.id);
    if (!dragRef.current) snapshot();
    dragRef.current = { mode, id: el.id, startX: e.clientX, startY: e.clientY, orig: { ...el } };
  };

  if (!pdf.file) {
    return (
      <div className="space-y-4">
        <FileDrop accept="application/pdf,.pdf" acceptLabel="A PDF to edit" onFiles={(f) => pdf.setFile(f[0])} />
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            { title: "Text & shapes", body: "Add headings, notes, rectangles, highlights and whiteout." },
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
          e.target.value = "";
          if (!file) return;
          try {
            await validateUpload(file, "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp");
            const image = await imageFileToPng(file, 1500);
            setImageSource(image.dataUrl);
            setActiveTool("image");
          } catch (err) {
            setError(friendlyProcessingError(err, "That image couldn’t be added."));
          }
        }}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <FileRow file={pdf.file} size={`${pdf.pageCount} pages · ${formatBytes(pdf.file.size)}`} onRemove={pdf.clear} />
        {pdf.bytes && dims[pageIndex]?.width ? null : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-bone-deep/40 p-2">
        <div className="flex flex-wrap gap-1">
          {PALETTE.map((tool) => (
            <button
              key={tool.id}
              type="button"
              onClick={() => {
                if (tool.id === "image") {
                  if (imageSource) setActiveTool("image");
                  else imageInput.current?.click();
                  return;
                }
                if (tool.id === "signature" && !signatureSource) {
                  setSignatureOpen(true);
                  return;
                }
                setActiveTool(tool.id);
                setSelectedId(null);
              }}
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
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={undo} disabled={!past.current.length} title="Undo (Ctrl+Z)">
            <Undo2 className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" onClick={redo} disabled={!future.current.length} title="Redo (Ctrl+Shift+Z)">
            <Redo2 className="h-3.5 w-3.5" />
          </Button>
          <span className="mx-1 h-5 w-px bg-line" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (!pdf.pageCount) return;
              setPageIndex((i) => Math.max(0, i - 1));
              setSelectedId(null);
            }}
            disabled={pageIndex === 0}
            title="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[68px] text-center text-[11.5px] font-medium tabular-nums text-ink/70">
            {pageIndex + 1} / {pdf.pageCount}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setPageIndex((i) => Math.min(pdf.pageCount - 1, i + 1));
              setSelectedId(null);
            }}
            disabled={pageIndex >= pdf.pageCount - 1}
            title="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_250px]">
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[11.5px] text-muted">
              {activeTool === "select"
                ? "Drag elements to move. Resize with the corner handle."
                : activeTool === "image" && !imageSource
                  ? "Choose an image first."
                  : activeTool === "signature" && !signatureSource
                    ? "Create a signature first."
                    : `Click the page to place your ${activeTool}.`}
            </p>
            {activeTool !== "select" && (
              <button type="button" onClick={() => setActiveTool("select")} className="text-[11.5px] font-medium text-forest hover:underline">
                Cancel
              </button>
            )}
          </div>
          <div className="rounded-xl border border-line bg-bone-deep/50 p-3 sm:p-5">
            <div className="mx-auto w-full max-w-[760px]">
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
                        style={{ color: el.color, fontSize: el.fontSize * scale, lineHeight: 1.28, fontWeight: el.bold ? 700 : 400 }}
                      >
                        {el.text || "Text"}
                      </div>
                    )}
                    {el.type === "rect" && <div className="h-full w-full" style={{ background: el.color }} />}
                    {el.type === "ellipse" && <div className="h-full w-full rounded-full" style={{ background: el.color }} />}
                    {el.type === "highlight" && <div className="h-full w-full" style={{ background: el.color, opacity: 0.7 }} />}
                    {el.type === "whiteout" && <div className="h-full w-full border border-dashed border-ink/15 bg-white" />}
                    {el.type === "line" && (
                      <svg className="h-full w-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none">
                        <line x1="0" y1="0" x2="100" y2="100" stroke={el.color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
                      </svg>
                    )}
                    {selectedId === el.id && (
                      <>
                        <button
                          type="button"
                          aria-label="Delete selected element"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => {
                            snapshot();
                            setElements((els) => els.filter((x) => x.id !== el.id));
                            setSelectedId(null);
                          }}
                          className="absolute -right-2.5 -top-2.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink text-paper"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                        <div
                          onPointerDown={(e) => startDrag(e, el, "resize")}
                          className="absolute -bottom-1 -right-1 h-3 w-3 cursor-se-resize rounded-sm border border-white bg-clay"
                        />
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button onClick={exportPdf} loading={busy}>
              <Download className="h-4 w-4" /> Export edited PDF
            </Button>
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
                }}
              >
                Clear page
              </Button>
            )}
          </div>
          {busy && <Progress label="Writing your edits into the PDF…" />}
          {error && <Alert tone="error" className="mt-3">{error}</Alert>}
        </div>

        <aside className="space-y-3">
          <div className="rounded-xl border border-line bg-paper p-3.5">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">Properties</p>
            {!selected && <p className="text-[12px] leading-relaxed text-muted">Select an element to change its text, color, opacity and size.</p>}
            {selected && (
              <div className="space-y-3">
                {selected.type === "text" && (
                  <>
                    <Field label="Text">
                      <TextArea
                        value={selected.text}
                        rows={3}
                        onChange={(e) => {
                          updateSelected({ text: e.target.value });
                        }}
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
                      <Field label="Weight">
                        <button
                          type="button"
                          onClick={() => updateSelected({ bold: !selected.bold })}
                          className={cn(
                            "h-9 w-full rounded-lg border text-[12px] font-bold",
                            selected.bold ? "border-forest bg-forest text-paper" : "border-line bg-paper",
                          )}
                        >
                          Bold
                        </button>
                      </Field>
                    </div>
                  </>
                )}
                {(selected.type === "rect" || selected.type === "ellipse" || selected.type === "line" || selected.type === "highlight") && (
                  <Field label="Color">
                    <ColorInput value={selected.color} onChange={(color) => updateSelected({ color })} label="Element color" />
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
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => {
                      snapshot();
                      const copy = { ...selected, id: uid(), x: selected.x + 12, y: selected.y + 12 };
                      setElements((els) => [...els, copy]);
                      setSelectedId(copy.id);
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" /> Duplicate
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      snapshot();
                      setElements((els) => els.filter((el) => el.id !== selected.id));
                      setSelectedId(null);
                    }}
                  >
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
                {pageEls.map((el) => (
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
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${result.edits} element${result.edits === 1 ? "" : "s"} written across ${result.pages} pages`}
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
}

export function SignPdfTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const [pageIndex, setPageIndex] = useState(0);
  const [dims, setDims] = useState<{ width: number; height: number }[]>([]);
  const [preview, setPreview] = useState<RenderedPage | null>(null);
  const [signature, setSignature] = useState<{ dataUrl: string; aspect: number } | null>(null);
  const [studioOpen, setStudioOpen] = useState(false);
  const [placements, setPlacements] = useState<SigPlacement[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addDate, setAddDate] = useState(false);
  const [displayWidth, setDisplayWidth] = useState(720);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; pages: number; count: number } | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; startX: number; startY: number; orig: SigPlacement } | null>(null);

  const currentDims = dims[pageIndex] ?? { width: 612, height: 792 };
  const pageW = currentDims.width;
  const pageH = currentDims.height;
  const scale = displayWidth / pageW;
  const pagePlacements = placements.filter((p) => p.page === pageIndex);

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
      if (!drag || !node) return;
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
  }, [pageW, pageH]);

  const place = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!signature || !surfaceRef.current) return;
    const rect = surfaceRef.current.getBoundingClientRect();
    const cx = ((e.clientX - rect.left) / rect.width) * pageW;
    const cy = ((e.clientY - rect.top) / rect.height) * pageH;
    const w = 190;
    const h = w / signature.aspect;
    const next: SigPlacement = {
      id: uid(),
      page: pageIndex,
      x: clamp(cx - w / 2, 0, pageW - w),
      y: clamp(cy - h / 2, 0, pageH - h),
      w,
      h,
      dataUrl: signature.dataUrl,
    };
    setPlacements((p) => [...p, next]);
    setSelectedId(next.id);
    setResult(null);
  };

  const save = async () => {
    if (!pdf.bytes || !pdf.file) return;
    if (!placements.length) {
      setError("Place your signature on the document first.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const doc = await openPdfLib(pdf.bytes);
      const fonts = await embedFonts(doc);
      const allPages = doc.getPages();
      const cache = new Map<string, Awaited<ReturnType<typeof doc.embedPng>>>();
      for (const p of placements) {
        const page = allPages[p.page];
        if (!page) continue;
        let image = cache.get(p.dataUrl);
        if (!image) {
          image = await doc.embedPng(dataUrlToBytes(p.dataUrl));
          cache.set(p.dataUrl, image);
        }
        page.drawImage(image, { x: p.x, y: page.getHeight() - p.y - p.h, width: p.w, height: p.h });
        if (addDate) {
          const date = safePdfText(new Date().toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric" }));
          page.drawText(date, {
            x: p.x,
            y: page.getHeight() - p.y - p.h - 12,
            size: 8.5,
            font: fonts.regular,
            color: rgb(0.35, 0.42, 0.38),
          });
        }
      }
      const bytes = await doc.save();
      setResult({
        bytes,
        name: `${sanitizeName(baseName(pdf.file.name))}-signed.pdf`,
        pages: doc.getPageCount(),
        count: placements.length,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!pdf.file) {
    return (
      <div className="space-y-4">
        <FileDrop accept="application/pdf,.pdf" acceptLabel="A PDF to sign" onFiles={(f) => pdf.setFile(f[0])} />
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            { title: "Draw or type", body: "Create a signature with a trackpad, finger, or your name." },
            { title: "Place precisely", body: "Click the page, drag to position and resize to fit." },
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
          onUse={(dataUrl, aspect) => {
            setSignature({ dataUrl, aspect });
            setStudioOpen(false);
          }}
        />
      )}
      <FileRow file={pdf.file} onRemove={pdf.clear} size={`${pdf.pageCount} pages · ${formatBytes(pdf.file.size)}`} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-bone-deep/40 p-2">
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" disabled={pageIndex === 0} onClick={() => { setPageIndex((i) => i - 1); setSelectedId(null); }} title="Previous page">
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
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-[11.5px] text-muted">{signature ? "Click a page to place your signature." : "Create a signature to begin."}</p>
          </div>

          <div className="rounded-xl border border-line bg-bone-deep/50 p-3 sm:p-5">
            <div className="mx-auto w-full max-w-[760px]">
              <div
                ref={surfaceRef}
                onPointerDown={place}
                className={cn("relative w-full overflow-hidden rounded-sm bg-white pdf-page-shadow", signature && "cursor-copy")}
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
                      setSelectedId(p.id);
                      dragRef.current = { id: p.id, startX: e.clientX, startY: e.clientY, orig: { ...p } };
                    }}
                    className={cn("absolute cursor-move", selectedId === p.id && "ring-2 ring-clay")}
                    style={{ left: p.x * scale, top: p.y * scale, width: p.w * scale, height: p.h * scale }}
                  >
                    <img src={p.dataUrl} alt="Placed signature" className="pointer-events-none h-full w-full object-contain" loading="lazy" decoding="async" />
                    {selectedId === p.id && (
                      <button
                        type="button"
                        aria-label="Remove signature"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => {
                          setPlacements((items) => items.filter((item) => item.id !== p.id));
                          setSelectedId(null);
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
            <Button onClick={save} loading={busy}>
              <Signature className="h-4 w-4" /> Save signed PDF
            </Button>
            <Button variant="outline" onClick={() => setStudioOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> New signature
            </Button>
            <span className="text-[11.5px] text-muted">{placements.length} signature{placements.length === 1 ? "" : "s"} placed</span>
          </div>
          {busy && <Progress label="Applying your signature…" />}
          {error && <Alert tone="error">{error}</Alert>}
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
            <div className="mt-3">
              <Switch checked={addDate} onChange={setAddDate} label="Add today’s date" description="Placed beneath each signature" />
            </div>
          </div>
          {selectedId && (
            <div className="rounded-xl border border-line bg-paper p-3.5">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink/75">Selected signature</p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const p = placements.find((x) => x.id === selectedId);
                    if (!p) return;
                    setPlacements((items) =>
                      items.map((x) => (x.id === p.id ? { ...x, w: x.w * 1.15, h: x.h * 1.15 } : x)),
                    );
                  }}
                >
                  Bigger
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const p = placements.find((x) => x.id === selectedId);
                    if (!p) return;
                    setPlacements((items) =>
                      items.map((x) => (x.id === p.id ? { ...x, w: Math.max(40, x.w * 0.87), h: Math.max(20, x.h * 0.87) } : x)),
                    );
                  }}
                >
                  Smaller
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setPlacements((items) => items.filter((x) => x.id !== selectedId));
                    setSelectedId(null);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
          <div className="rounded-xl border border-line bg-bone-deep/30 p-3 text-[11px] leading-relaxed text-muted">
            <p className="font-semibold text-ink/70">About e-signatures</p>
            <p className="mt-1">This adds a visual signature. It isn’t a certificate-backed digital signature. For contracts that require identity verification, use a dedicated e-signature service.</p>
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
          onDownload={() => downloadBytes(result.bytes, result.name)}
          description={`${result.count} signature${result.count === 1 ? "" : "s"} applied · visual signature only · original file untouched`}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * WATERMARK PDF
 * ------------------------------------------------------------------ */
const MM = 2.834645669;
type WmPosition = "center" | "top" | "bottom" | "tile";

export function WatermarkTool() {
  const initial = useInitialFiles();
  const pdf = usePdfFile(initial);
  const { thumbs } = usePdfThumbs(pdf.bytes, { width: 360, quality: 0.8, max: 1 });
  const [kind, setKind] = useState<"text" | "image">("text");
  const [text, setText] = useState("CONFIDENTIAL");
  const [size, setSize] = useState(52);
  const [color, setColor] = useState("#e8613c");
  const [opacity, setOpacity] = useState(18);
  const [rotation, setRotation] = useState(35);
  const [position, setPosition] = useState<WmPosition>("center");
  const [margin, setMargin] = useState(18);
  const [imageData, setImageData] = useState<string | null>(null);
  const [imageAspect, setImageAspect] = useState(1);
  const [range, setRange] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ bytes: Uint8Array; name: string; pages: number } | null>(null);

  const save = async () => {
    if (!pdf.bytes || !pdf.file) return;
    setBusy(true);
    setError("");
    try {
      if (kind === "text" && !text.trim()) throw new Error("Enter the watermark text.");
      if (kind === "text" && !safePdfText(text).trim()) throw new Error("Use Latin characters for the watermark — the built-in PDF fonts can’t encode other scripts.");
      if (kind === "image" && !imageData) throw new Error("Upload a watermark image first.");
      const pages = uniqueInOrder(parseRanges(range, pdf.pageCount));
      const doc = await openPdfLib(pdf.bytes);
      const fonts = await embedFonts(doc);
      const allPages = doc.getPages();
      const wm = safePdfText(text);
      let embedded: Awaited<ReturnType<typeof doc.embedPng>> | null = null;
      if (kind === "image" && imageData) embedded = await doc.embedPng(dataUrlToBytes(imageData));
      for (const n of pages) {
        const page = allPages[n - 1];
        const { width, height } = page.getSize();
        if (kind === "text") {
          const font = fonts.bold;
          const textWidth = font.widthOfTextAtSize(wm, size);
          const textHeight = size;
          const drawAt = (cx: number, cy: number) => {
            const rad = (rotation * Math.PI) / 180;
            page.drawText(wm, {
              x: cx - (textWidth / 2) * Math.cos(rad) + (textHeight * 0.3) * Math.sin(rad),
              y: cy - (textWidth / 2) * Math.sin(rad) - (textHeight * 0.3) * Math.cos(rad),
              size,
              font,
              color: hexToRgb(color),
              opacity: opacity / 100,
              rotate: degrees(rotation),
            });
          };
          if (position === "tile") {
            const stepX = textWidth + 110;
            const stepY = textHeight + 90;
            for (let y = -stepY; y < height + stepY; y += stepY) {
              for (let x = -stepX; x < width + stepX; x += stepX) {
                page.drawText(wm, {
                  x,
                  y,
                  size,
                  font,
                  color: hexToRgb(color),
                  opacity: opacity / 100,
                  rotate: degrees(rotation),
                });
              }
            }
          } else if (position === "top") drawAt(width / 2, height - margin * MM - textHeight);
          else if (position === "bottom") drawAt(width / 2, margin * MM + textHeight);
          else drawAt(width / 2, height / 2);
        } else if (embedded) {
          const w = width * (position === "tile" ? 0.26 : 0.42);
          const h = w / imageAspect;
          const x = (width - w) / 2;
          const y = position === "top" ? height - h - margin * MM : position === "bottom" ? margin * MM : (height - h) / 2;
          if (position === "tile") {
            const cols = 3;
            const rows = 4;
            for (let r = 0; r < rows; r++) {
              for (let c = 0; c < cols; c++) {
                page.drawImage(embedded, {
                  x: (width / cols) * c + (width / cols - w) / 2,
                  y: (height / rows) * r + (height / rows - h) / 2,
                  width: w,
                  height: h,
                  opacity: opacity / 100,
                  rotate: degrees(rotation),
                });
              }
            }
          } else {
            page.drawImage(embedded, { x, y, width: w, height: h, opacity: opacity / 100, rotate: degrees(rotation) });
          }
        }
      }
      const bytes = await doc.save();
      setResult({ bytes, name: `${sanitizeName(baseName(pdf.file.name))}-watermarked.pdf`, pages: pages.length });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

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
                    onClick={() => setKind(k)}
                    className={cn(
                      "rounded-xl border py-2 text-[12.5px] font-medium capitalize",
                      kind === k ? "border-forest bg-forest text-paper" : "border-line bg-paper text-ink/70",
                    )}
                  >
                    {k === "text" ? "Text watermark" : "Image / logo"}
                  </button>
                ))}
              </div>
              {kind === "text" ? (
                <Field label="Text">
                  <input value={text} onChange={(e) => setText(e.target.value)} className={inputClass} maxLength={80} />
                </Field>
              ) : (
                <div>
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
                                const result = await imageFileToPng(file, 1200);
                                setImageData(result.dataUrl);
                                setImageAspect(result.width / result.height);
                              } catch (err) {
                                setError(friendlyProcessingError(err, "That image couldn’t be used as a watermark."));
                              }
                            }}
                          />
                        </label>
                      )}
                    </div>
                  </Field>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              {kind === "text" && (
                <>
                  <Field label={`Font size · ${size}pt`}>
                    <input type="range" min={12} max={140} value={size} onChange={(e) => setSize(Number(e.target.value))} className="mt-3 w-full accent-[#1c4c3b]" />
                  </Field>
                  <Field label="Color">
                    <ColorInput value={color} onChange={setColor} label="Watermark color" />
                  </Field>
                </>
              )}
              <Field label={`Opacity · ${opacity}%`}>
                <input type="range" min={3} max={90} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} className="mt-3 w-full accent-[#1c4c3b]" />
              </Field>
              <Field label={`Rotation · ${rotation}°`}>
                <input type="range" min={-90} max={90} step={5} value={rotation} onChange={(e) => setRotation(Number(e.target.value))} className="mt-3 w-full accent-[#1c4c3b]" />
              </Field>
              <Field label="Position">
                <Select value={position} onChange={(e) => setPosition(e.target.value as WmPosition)}>
                  <option value="center">Center</option>
                  <option value="top">Top</option>
                  <option value="bottom">Bottom</option>
                  <option value="tile">Tile across page</option>
                </Select>
              </Field>
              <Field label={`Edge margin · ${margin} mm`}>
                <input type="range" min={5} max={60} value={margin} onChange={(e) => setMargin(Number(e.target.value))} className="mt-3 w-full accent-[#1c4c3b]" />
              </Field>
            </div>
            <RangeField value={range} onChange={setRange} total={pdf.pageCount} label="Pages" hint="Leave empty to watermark every page." />
            {error && <Alert tone="error">{error}</Alert>}
            <div className="border-t border-line pt-4">
              <Button onClick={save} loading={busy}>
                <Stamp className="h-4 w-4" /> Apply watermark
              </Button>
            </div>
          </div>

          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink/75">Preview</p>
            <div className="surface overflow-hidden p-2.5">
              {thumbs[0] ? (
                <div className="relative overflow-hidden">
                  <img src={thumbs[0].dataUrl} alt="Watermark preview" className="w-full" loading="lazy" decoding="async" />
                  {kind === "image" && imageData ? (
                    <img
                      src={imageData}
                      alt=""
                      className="pointer-events-none absolute left-1/2 top-1/2 w-[42%] -translate-x-1/2 -translate-y-1/2 object-contain"
                      style={{ opacity: opacity / 100, transform: `translate(-50%, -50%) rotate(${rotation}deg)` }}
                    loading="lazy" decoding="async" />
                  ) : (
                    <div
                      className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden"
                      style={{ opacity: opacity / 100 }}
                    >
                      {position === "tile" ? (
                        <div className="grid grid-cols-2 gap-x-4 gap-y-8 text-center">
                          {Array.from({ length: 6 }).map((_, i) => (
                            <span key={i} className="whitespace-nowrap font-bold" style={{ color, fontSize: size * 0.3, transform: `rotate(${rotation}deg)` }}>
                              {text || "Watermark"}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span
                          className={cn("absolute whitespace-nowrap font-bold", position === "top" ? "top-4" : position === "bottom" ? "bottom-4" : "top-1/2 -translate-y-1/2")}
                          style={{ color, fontSize: size * 0.32, transform: `rotate(${rotation}deg)` }}
                        >
                          {text || "Watermark"}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex aspect-[3/4] animate-pulse items-center justify-center bg-bone-deep text-[11px] text-ink/70">Rendering…</div>
              )}
            </div>
            <p className="mt-2 text-[10.5px] leading-snug text-muted">Preview is illustrative; the exported watermark uses precise PDF coordinates.</p>
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
          onDownload={() => downloadBytes(result.bytes, result.name)}
        />
      )}
    </div>
  );
}
