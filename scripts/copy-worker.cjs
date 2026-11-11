#!/usr/bin/env node
/**
 * Serve the PDF.js worker as a real static asset instead of inlining its source
 * into the HTML bundle. This keeps the initial document small without changing
 * the Vite configuration, and Netlify serves the worker from the same origin so
 * the CSP `worker-src 'self'` policy is satisfied.
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
const target = path.join(root, "dist/pdf.worker.min.mjs");

if (!fs.existsSync(source)) {
  console.error("PDF.js worker not found — run npm install first.");
  process.exit(1);
}
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
console.log(`Copied PDF.js worker → dist/pdf.worker.min.mjs (${(fs.statSync(target).size / 1024).toFixed(0)} KB)`);
