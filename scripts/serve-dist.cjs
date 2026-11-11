#!/usr/bin/env node
/**
 * Production-parity static server for QA.
 * Serves real files first (so prerendered SEO pages are tested), applies the
 * exact security headers declared in netlify.toml, and falls back to the SPA.
 */
const http = require("node:http");
const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "dist");
const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || "127.0.0.1";

const netlify = fs.readFileSync(path.resolve(__dirname, "..", "netlify.toml"), "utf8");
const csp = (netlify.match(/Content-Security-Policy = "([^"]+)"/) || [])[1];
if (!csp) throw new Error("Content-Security-Policy not found in netlify.toml");

const headers = {
  "Content-Security-Policy": csp,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=(), usb=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "Cross-Origin-Opener-Policy": "same-origin",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".pdf": "application/pdf",
};

function safeJoin(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const resolved = path.resolve(ROOT, `.${decoded}`);
  return resolved.startsWith(ROOT) ? resolved : null;
}

const server = http.createServer((req, res) => {
  let file = safeJoin(req.url || "/");
  if (!file) {
    res.writeHead(400, headers).end("Bad request");
    return;
  }
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  } catch {
    /* fall through to SPA */
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, "index.html");
  const ext = path.extname(file);
  const isHtml = ext === ".html";
  const compressible = [".html", ".js", ".mjs", ".css", ".json", ".svg", ".txt", ".xml", ".webmanifest"].includes(ext);
  const accept = String(req.headers["accept-encoding"] || "");
  const useGzip = compressible && /gzip/.test(accept);
  const isServiceWorker = path.basename(file) === "sw.js";
  const baseHeaders = {
    ...headers,
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control":
      isHtml || isServiceWorker ? "public, max-age=0, must-revalidate" : "public, max-age=31536000, immutable",
    Vary: "Accept-Encoding",
  };
  if (useGzip) {
    // Mirror Netlify's compression so QA measurements reflect production transfer sizes.
    const body = zlib.gzipSync(fs.readFileSync(file), { level: 6 });
    res.writeHead(200, { ...baseHeaders, "Content-Encoding": "gzip", "Content-Length": body.length });
    res.end(body);
    return;
  }
  res.writeHead(200, { ...baseHeaders, "Content-Length": fs.statSync(file).size });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`Paperly production-parity server on http://${HOST}:${PORT} (CSP applied)`);
});
