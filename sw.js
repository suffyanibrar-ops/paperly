/* Paperly PDF — generated offline service worker. Do not edit by hand.
 * Regenerate with: node scripts/build-sw.mjs (part of npm run build).
 * Build fingerprint: 59188d24247e
 */
"use strict";

const PRECACHE_URLS = [
  "/icons/icon-maskable.svg",
  "/icons/icon.svg",
  "/index.html",
  "/og-image.svg",
  "/paperly/assets/__vite-browser-external-BIHI7g3E.js",
  "/paperly/assets/Advanced-XW7A_jjF.js",
  "/paperly/assets/arrow-up-CWTBIb-t.js",
  "/paperly/assets/chevron-right-BBgdnhGd.js",
  "/paperly/assets/ConvertDocs-DsDkMkq0.js",
  "/paperly/assets/ConvertImages-DwE8mj3X.js",
  "/paperly/assets/copy-Dg6hLC9-.js",
  "/paperly/assets/DataExtract-DB7rlD_D.js",
  "/paperly/assets/Edit-BEaV0f1j.js",
  "/paperly/assets/external-link-DwuKt9Jz.js",
  "/paperly/assets/extract-Qn2Slf5a.js",
  "/paperly/assets/file-check-corner-BBuDQ3FT.js",
  "/paperly/assets/file-search-D05Ly6V3.js",
  "/paperly/assets/FormsScan-DGYMmHt9.js",
  "/paperly/assets/Home-BM6l61Np.js",
  "/paperly/assets/HtmlArchive-CMy7ZiJi.js",
  "/paperly/assets/index-ByNXsPjL.css",
  "/paperly/assets/index-DMdh6f8x.js",
  "/paperly/assets/Info-DTje01nG.js",
  "/paperly/assets/Knowledge-G2YY9fpH.js",
  "/paperly/assets/layout-D655JFYk.js",
  "/paperly/assets/MarkdownTools-QD1EEbOi.js",
  "/paperly/assets/MetadataEdit-DKwSX-Gi.js",
  "/paperly/assets/More-wOxpkkd1.js",
  "/paperly/assets/OcrTool-x7k4BTXj.js",
  "/paperly/assets/Optimize-eMSn8pm_.js",
  "/paperly/assets/Organize-dYkOw7-m.js",
  "/paperly/assets/plus-BjfTHPN4.js",
  "/paperly/assets/Privacy-sw7VKN9s.js",
  "/paperly/assets/Pro-Cy8toVcG.js",
  "/paperly/assets/ProExtras-CzUVKRYA.js",
  "/paperly/assets/RedactCompare-DElRyUZS.js",
  "/paperly/assets/redo-2-Cvxvpjdr.js",
  "/paperly/assets/save-CGWJcgOV.js",
  "/paperly/assets/Security-DBXhgvLi.js",
  "/paperly/assets/Structure-zfz579ao.js",
  "/paperly/assets/textItems-Ea10QfGG.js",
  "/paperly/assets/ToolCard-DNl5JvTE.js",
  "/paperly/assets/ToolPage-klo_pP3w.js",
  "/paperly/assets/toolParts-D2cOMHw7.js",
  "/paperly/assets/Tools-wTRkXB_1.js",
  "/paperly/assets/type-D7VH889C.js",
  "/paperly/assets/vendor-canvas-k0ITeQhV.js",
  "/paperly/assets/vendor-docx-85t6szBA.js",
  "/paperly/assets/vendor-jszip-CPXKZsfK.js",
  "/paperly/assets/vendor-ocr-DJda1RvQ.js",
  "/paperly/assets/vendor-pdf-lib-Bvifu-WF.js",
  "/paperly/assets/vendor-pdfjs-BrePjwiw.js",
  "/paperly/assets/vendor-pptx-DqG1tvnP.js",
  "/paperly/assets/vendor-spreadsheet-MnySZTGa.js",
  "/paperly/assets/vendor-vite-preload-B-jL8wvS.js",
  "/paperly/assets/Versus-DtBB9f5i.js",
  "/paperly/assets/wand-sparkles-BGHqwbhm.js",
  "/paperly/assets/Workflow-GerdgSbq.js",
  "/paperly/assets/zap-Dvd1V7xv.js",
  "/paperly/fonts/instrument-serif-latin-ext-italic.woff2",
  "/paperly/fonts/instrument-serif-latin-ext-normal.woff2",
  "/paperly/fonts/instrument-serif-latin-italic.woff2",
  "/paperly/fonts/instrument-serif-latin-normal.woff2",
  "/paperly/fonts/inter-tight-latin-ext-italic.woff2",
  "/paperly/fonts/inter-tight-latin-ext-normal.woff2",
  "/paperly/fonts/inter-tight-latin-italic.woff2",
  "/paperly/fonts/inter-tight-latin-normal.woff2",
  "/pdf.worker.min.mjs",
  "/robots.txt",
  "/site.webmanifest"
];
const PRECACHE_CACHE = "paperly-precache-59188d24247e";
const RUNTIME_CACHE = "paperly-runtime-v1";
const APP_SHELL = "/paperly/index.html";
const KEEP_CACHES = new Set([PRECACHE_CACHE, RUNTIME_CACHE]);

// Pinned third-party hosts the OCR feature fetches its engine and language data from.
const OCR_ORIGINS = new Set(["cdn.jsdelivr.net", "tessdata.projectnaptha.com"]);

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(PRECACHE_CACHE);
    const results = await Promise.allSettled(
      PRECACHE_URLS.map(async (url) => {
        // Bypass the HTTP cache so a release never precaches stale bytes.
        const response = await fetch(new Request(url, { cache: "reload" }));
        if (!response || !response.ok) throw new Error(String(response && response.status) + " " + url);
        await cache.put(url, response);
      })
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      console.warn("[Paperly SW] " + failures.length + "/" + PRECACHE_URLS.length + " precache requests failed; offline mode may be partial.", failures);
    }
    // Take over as soon as the new release is fully precached.
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith("paperly-") && !KEEP_CACHES.has(key))
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

async function navigationResponse(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok && response.type === "basic") {
      // Deep links are cached lazily so a prerendered page you visited works offline.
      const copy = response.clone();
      caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
    }
    return response;
  } catch (error) {
    const runtime = await caches.open(RUNTIME_CACHE);
    const cachedPage = await runtime.match(request);
    if (cachedPage) return cachedPage;
    const shell = await caches.match(APP_SHELL, { cacheName: PRECACHE_CACHE });
    if (shell) return shell;
    console.warn("[Paperly SW] navigation failed offline with no shell", error);
    return new Response(
      "<!doctype html><meta charset=\"utf-8\"><title>Offline — Paperly PDF</title><p>Paperly is offline and its app shell is not cached yet. Reconnect once to enable offline use.</p>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
}

async function cacheFirstResponse(request) {
  const cache = await caches.open(PRECACHE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const runtime = await caches.open(RUNTIME_CACHE);
    const cachedRuntime = await runtime.match(request);
    if (cachedRuntime) return cachedRuntime;
    throw error;
  }
}

/**
 * Stale-while-revalidate for the OCR CDN. The function is deliberately NOT
 * async before event.waitUntil: that call must happen synchronously while the
 * fetch event is being dispatched, or browsers reject it once dispatch ends.
 */
function staleWhileRevalidateResponse(request, event) {
  const cachePromise = caches.open(RUNTIME_CACHE);
  const network = cachePromise
    .then(() => fetch(request))
    .then(async (response) => {
      if (response && response.ok) {
        const cache = await cachePromise;
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch((error) => {
      console.warn("[Paperly SW] OCR asset fetch failed", request.url, error);
      return undefined;
    });

  // Keep the worker alive long enough to refresh the stale entry.
  event.waitUntil(network);

  return cachePromise
    .then((cache) => cache.match(request))
    .then((cached) => cached || network.then((fresh) => fresh || new Response("", { status: 503, statusText: "Offline" })));
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  if (request.mode === "navigate") {
    event.respondWith(navigationResponse(request));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirstResponse(request));
    return;
  }

  if (OCR_ORIGINS.has(url.hostname)) {
    event.respondWith(staleWhileRevalidateResponse(request, event));
  }
  // Everything else (there should be nothing) falls through to the network.
});
