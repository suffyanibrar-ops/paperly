#!/usr/bin/env node
/**
 * Paperly PDF — offline service worker generator.
 *
 * Runs last in `npm run build`, after Vite has emitted `dist/` and after the
 * prerender + PDF.js worker steps have populated their files. It walks the
 * finished build, derives a content hash from every asset it is about to
 * precache, and writes `dist/sw.js`:
 *
 *   - install   → precaches the app shell, hashed JS/CSS, the PDF.js worker,
 *                 self-hosted fonts, icons and static metadata, then skipWaiting.
 *                 Individual misses are tolerated (allSettled) so one flaky
 *                 asset can never fail the whole install.
 *   - activate  → deletes stale Paperly caches (old asset-hash releases) and
 *                 claims open clients.
 *   - fetch     → navigations: network-first with the cached shell as offline
 *                 fallback (per-route prerendered HTML is cached at runtime,
 *                 never precached). Same-origin static assets: cache-first with
 *                 a network fill. OCR CDN requests (pinned tesseract.js core and
 *                 language data): stale-while-revalidate.
 *
 * No runtime dependencies and no Workbox — this file is the build step.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

const CACHE_PREFIX = "paperly-precache";
const RUNTIME_CACHE = "paperly-runtime-v1";

/** Files that must exist in every build; missing entries are reported, not fatal. */
const SHELL_FILES = [
  "/index.html",
  "/pdf.worker.min.mjs",
  "/site.webmanifest",
  "/robots.txt",
  "/og-image.svg",
  "/icons/icon.svg",
  "/icons/icon-maskable.svg",
];

/** Directories whose contents are all precached, filtered by extension. */
const PRECACHE_DIRS = [
  ["assets", /\.(?:js|css|mjs|woff2|svg|png|webp|avif)$/],
  ["fonts", /\.woff2$/],
];

/**
 * Deployment base path. "/" for a normal root deploy, "/paperly/" (or any
 * sub-path) when the built app is served from a project site. "./" is a
 * relative CDN build, where the worker is not registered anyway.
 */
const RAW_BASE = process.env.PAPERLY_BASE || "/";
const BASE = RAW_BASE === "./" ? "/" : RAW_BASE.endsWith("/") ? RAW_BASE : `${RAW_BASE}/`;

const toUrl = (file) => `${BASE}${path.relative(dist, file).split(path.sep).join("/")}`;

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(absolute));
    else if (entry.isFile()) out.push(absolute);
  }
  return out;
}

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function buildPrecacheList() {
  const files = new Map();

  for (const url of SHELL_FILES) {
    const absolute = path.join(dist, url.slice(1));
    if (fs.existsSync(absolute)) files.set(url, absolute);
    else console.warn(`[sw] shell file missing at build time: ${url}`);
  }

  for (const [dir, pattern] of PRECACHE_DIRS) {
    for (const absolute of listFiles(path.join(dist, dir))) {
      if (pattern.test(absolute)) files.set(toUrl(absolute), absolute);
    }
  }

  // Remote worker sources are already content-versioned; cache them at runtime only.
  for (const url of files.keys()) {
    if (/\.map$/.test(url) || url.endsWith("/sw.js")) files.delete(url);
  }

  const entries = [...files.entries()]
    .map(([url, absolute]) => {
      const contents = fs.readFileSync(absolute);
      return { url, absolute, bytes: contents.length, digest: sha256(contents).slice(0, 16) };
    })
    .sort((a, b) => a.url.localeCompare(b.url));

  // Stable fingerprint of this exact build's asset contents.
  const fingerprint = sha256(entries.map((entry) => `${entry.url}:${entry.digest}`).join("\n")).slice(0, 12);
  return { entries, fingerprint };
}

function serviceWorkerSource(precacheUrls, cacheName) {
  const precache = JSON.stringify(precacheUrls, null, 2);

  return `/* Paperly PDF — generated offline service worker. Do not edit by hand.
 * Regenerate with: node scripts/build-sw.mjs (part of npm run build).
 * Build fingerprint: ${cacheName.replace(`${CACHE_PREFIX}-`, "")}
 */
"use strict";

const PRECACHE_URLS = ${precache};
const PRECACHE_CACHE = ${JSON.stringify(cacheName)};
const RUNTIME_CACHE = ${JSON.stringify(RUNTIME_CACHE)};
const APP_SHELL = ${JSON.stringify(`${BASE}index.html`)};
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
      "<!doctype html><meta charset=\\"utf-8\\"><title>Offline — Paperly PDF</title><p>Paperly is offline and its app shell is not cached yet. Reconnect once to enable offline use.</p>",
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
`;
}

function main() {
  if (!fs.existsSync(dist)) throw new Error("dist/ not found — run `vite build` first.");

  const { entries, fingerprint } = buildPrecacheList();
  const cacheName = `${CACHE_PREFIX}-${fingerprint}`;
  const urls = entries.map((entry) => entry.url);
  const source = serviceWorkerSource(urls, cacheName);
  const target = path.join(dist, "sw.js");
  fs.writeFileSync(target, source, "utf8");

  const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const kb = (value) => `${(value / 1024).toFixed(1)} KB`;
  console.log(
    `Generated ${path.relative(root, target)} — ${urls.length} precached files, ${kb(bytes)} total, cache "${cacheName}" (${kb(Buffer.byteLength(source))} worker)`,
  );
}

try {
  main();
} catch (error) {
  console.error("Service worker generation failed:", error.message);
  process.exit(1);
}
