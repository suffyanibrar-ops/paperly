import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Paperly ships as a normal multi-chunk SPA: the entry only carries the shell,
 * and each tool's heavy engine (PDF.js, pdf-lib, Office writers, OCR) loads on
 * demand. Vendor groups keep the cacheable pieces stable across app deploys.
 *
 * Each package is grouped separately on purpose: a shared chunk is only as lazy
 * as its most eager importer, so merging (say) `jszip` with `docx` would drag the
 * whole Office writer into the initial preload the moment one helper needs a ZIP.
 */
const VENDOR_CHUNKS: ReadonlyArray<[RegExp, string]> = [
  [/node_modules\/(?:\.pnpm\/)?pdfjs-dist\//, "vendor-pdfjs"],
  [/node_modules\/(?:\.pnpm\/)?(?:@cantoo\/pdf-lib|pdf-lib)\//, "vendor-pdf-lib"],
  [/node_modules\/(?:\.pnpm\/)?jszip\//, "vendor-jszip"],
  [/node_modules\/(?:\.pnpm\/)?tesseract\.js\//, "vendor-ocr"],
  [/node_modules\/(?:\.pnpm\/)?docx\//, "vendor-docx"],
  [/node_modules\/(?:\.pnpm\/)?pptxgenjs\//, "vendor-pptx"],
  [/node_modules\/(?:\.pnpm\/)?xlsx\//, "vendor-spreadsheet"],
  [/node_modules\/(?:\.pnpm\/)?html2canvas\//, "vendor-canvas"],
];

function vendorChunk(id: string): string | undefined {
  // Vite's dynamic-import preload helper is imported by the entry and by every
  // lazy chunk. Pin it to its own tiny chunk: otherwise Rollup parks it inside
  // the first vendor chunk that uses dynamic imports (pptxgenjs), which makes
  // the entry statically depend on — and preload — the whole 276 KB writer.
  if (id.includes("vite/preload-helper")) return "vendor-vite-preload";
  if (!id.includes("node_modules")) return undefined;
  for (const [pattern, name] of VENDOR_CHUNKS) {
    if (pattern.test(id)) return name;
  }
  return undefined;
}

// https://vite.dev/config/
export default defineConfig({
  // Absolute base for normal deployments; set PAPERLY_BASE=./ (or a subpath like
  // /paperly/) when the built app is served from a CDN subdirectory.
  base: process.env.PAPERLY_BASE || "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  build: {
    // Separate CSS so a single lazy tool never blocks first paint on its styles.
    cssCodeSplit: true,
    // Keep the warning threshold honest for the vendor chunks above.
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: vendorChunk,
      },
    },
  },
});
