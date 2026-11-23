#!/usr/bin/env node
/**
 * Paperly PDF — static SEO prerender.
 *
 * Reads the built `dist/index.html`, extracts the tool registry + canonical slug
 * map from source, and writes real populated HTML for every public route:
 *
 *   /  /tools  /privacy  /help  (+ secondary marketing pages)
 *   /merge-pdf  /redact-pdf  /ocr-pdf  … all 51 tools
 *
 * Each tool page gets a unique title/description, a self-referencing canonical,
 * semantic H1, a 3-step "How it works locally" section, related tool links and
 * JSON-LD (SoftwareApplication + FAQPage). It also emits sitemap.xml, robots.txt
 * and `_redirects` with 301s from the legacy `/tool/:id` and `/tools/:id` URLs.
 *
 * The origin is always environment-driven: SITE_URL (or VITE_SITE_URL), with a
 * production default. No Netlify preview URL is ever baked into a canonical.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const ORIGIN = (process.env.SITE_URL || process.env.VITE_SITE_URL || "https://paperlypdf.com").replace(/\/+$/, "");
const SITE_HOST = new URL(ORIGIN).host;
const HEAD_MARKER = "<!--SEO_HEAD-->";
const BODY_MARKER = "<!--SEO_BODY-->";
const DEFAULT_TITLE = "Paperly — Private PDF tools that work in your browser";

/* ------------------------------------------------------------------ *
 * Registry + slug parsing
 * ------------------------------------------------------------------ */
function parseRegistry(source) {
  const blocks = source.split(/\n {2}\{\n {4}id: "/).slice(1);
  return blocks
    .map((block) => {
      const body = block.slice(0, block.indexOf("\n  },") + 1);
      const read = (field) => {
        const match = body.match(new RegExp(`${field}:\\s*\\n?\\s*"((?:[^"\\\\]|\\\\.)*)"`));
        return match ? match[1].replace(/\\"/g, '"').replace(/\\n/g, " ").replace(/\s+/g, " ").trim() : "";
      };
      const steps = [];
      const stepsBlock = body.match(/steps:\s*\[([\s\S]*?)\]/);
      if (stepsBlock) {
        for (const match of stepsBlock[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
          steps.push(match[1].replace(/\\"/g, '"').trim());
        }
      }
      const related = [];
      const relatedBlock = body.match(/related:\s*\[([^\]]*)\]/);
      if (relatedBlock) for (const match of relatedBlock[1].matchAll(/"([^"]+)"/g)) related.push(match[1]);
      return {
        id: block.slice(0, block.indexOf('"')),
        name: read("name"),
        tagline: read("tagline"),
        description: read("description"),
        category: read("category"),
        acceptLabel: read("acceptLabel"),
        steps,
        related,
        note: read("note"),
        isNew: /new:\s*true/.test(body),
      };
    })
    .filter((tool) => tool.id && tool.name);
}

function parseSlugs(source) {
  const map = {};
  const block = source.match(/export const TOOL_SLUGS[^{]*\{([\s\S]*?)\}/);
  if (!block) return map;
  for (const line of block[1].split("\n")) {
    const match = line.match(/^\s*"?([a-z0-9-]+)"?:\s*"([a-z0-9-]+)"/i);
    if (match) map[match[1]] = match[2];
  }
  return map;
}

const CATEGORY_LABEL = {
  organize: "Organize",
  convert: "Convert",
  optimize: "Optimize",
  secure: "Secure",
  intelligence: "Intelligence",
};

const escape = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const toolPath = (tool) => `/${tool.slug}`;

function toolFaq(tool) {
  return [
    {
      q: `Is ${tool.name} free?`,
      a: `Yes. ${tool.name} is one of Paperly's 51 free single-document tools. There is no task limit, watermark, account or file-size tier for single-document use.`,
    },
    {
      q: `Do my files leave my device when I use ${tool.name}?`,
      a: "No. The document is read with the browser's File API and processed with PDF.js, pdf-lib and WebAssembly inside this tab. There is no upload endpoint, so no document bytes are sent to Paperly or any third party.",
    },
    {
      q: `How do I use ${tool.name}?`,
      a: tool.steps.join(" "),
    },
    {
      q: `What should I know before using ${tool.name}?`,
      a:
        tool.note ||
        "Results depend on the input document. Keep the original file until you have verified the output, and try the tool with a small sample first for unusual files.",
    },
  ];
}

function staticPages(toolCount) {
  return [
    {
      route: "/",
      title: `Paperly PDF — ${toolCount} private PDF tools that never upload your files`,
      description: `Merge, split, compress, convert, OCR, redact, sign, fill, inspect and outline PDFs entirely in your browser. No uploads, no accounts, no file-size tiers. ${toolCount} working PDF tools.`,
    },
    {
      route: "/tools",
      title: `All ${toolCount} PDF tools — Paperly PDF`,
      description: "Browse every Paperly PDF tool: organize, optimize, convert, secure and understand PDFs. All processing happens on your device.",
    },
    {
      route: "/privacy",
      title: "Privacy policy — Paperly PDF",
      description: "What stays in your browser, when the OCR engine is fetched, and how to verify zero document uploads in your browser's Network panel.",
    },
    {
      route: "/help",
      title: "Help & FAQ — Paperly PDF",
      description: "Answers about local processing, OCR, conversions, password protection, redaction, batch workflows and troubleshooting.",
    },
    {
      route: "/why",
      title: "Why Paperly PDF — privacy by architecture",
      description: "Paperly processes documents in your browser instead of on a server. Learn how local PDF processing works and where it differs from cloud tools.",
    },
    {
      route: "/vs-ilovepdf",
      title: "Paperly vs iLovePDF — honest feature comparison",
      description: "A sourced comparison of Paperly and iLovePDF: privacy, free limits, batch processing, forms, OCR, PDF/A and AI features. Includes where iLovePDF is stronger.",
    },
    {
      route: "/pricing",
      title: "Pricing — free PDF tools, with optional Pro power features",
      description: "All 51 single-document PDF tools are free and unlimited. Optional Paperly Pro unlocks high-volume batch, saved workflows and commercial offline use.",
    },
    {
      route: "/guides",
      title: "PDF guides & tutorials — Paperly PDF",
      description: "Practical guides to merging, compressing, OCR, redaction, archival preparation and password protection, including honest limitations.",
    },
    {
      route: "/about",
      title: "About Paperly PDF",
      description: "An independent, privacy-first document toolkit built on PDF.js, pdf-lib, Tesseract and the Web Crypto API.",
    },
    {
      route: "/contact",
      title: "Contact Paperly PDF",
      description: "Product support, privacy questions, security reports and feature requests. No documents are accepted by email.",
    },
    {
      route: "/terms",
      title: "Terms of use — Paperly PDF",
      description: "Plain-language terms for Paperly's browser-based PDF tools, including signature and archival limitations.",
    },
    {
      route: "/sitemap",
      title: "Sitemap — Paperly PDF",
      description: "Every Paperly tool and page in one place.",
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Page bodies (real content, not an empty SPA shell)
 * ------------------------------------------------------------------ */
function toolGrid(tools) {
  return Object.entries(CATEGORY_LABEL)
    .map(([key, label]) => {
      const group = tools.filter((tool) => tool.category === key);
      if (!group.length) return "";
      return `<section><h2>${escape(label)}</h2><ul>${group
        .map((tool) => `<li><a href="${toolPath(tool)}">${escape(tool.name)}</a> — ${escape(tool.tagline)}</li>`)
        .join("")}</ul></section>`;
    })
    .join("\n");
}

function homeBody(tools) {
  return `<main id="seo-content" style="max-width:64rem;margin:0 auto;padding:2rem 1.25rem;font-family:system-ui,sans-serif;line-height:1.65;color:#12211a">
  <header>
    <p style="text-transform:uppercase;letter-spacing:.12em;font-size:12px;font-weight:700;color:#1c4c3b">Paperly PDF · ${tools.length} tools · 100% local</p>
    <h1>Every PDF tool. Nowhere to upload.</h1>
    <p style="font-size:18px;max-width:48rem">Merge, split, compress, OCR, redact, convert, sign, fill and inspect PDFs entirely in your browser. Drop a file into the workspace and Paperly inspects it locally — page count, encryption and whether a text layer exists — before recommending the right tool.</p>
    <p><strong>0 bytes uploaded. No account. No daily limit. Works offline after the first load.</strong></p>
    <p><a href="/tools">Browse all ${tools.length} tools</a> · <a href="/privacy">Verify zero uploads</a> · <a href="/help">Help &amp; FAQ</a></p>
  </header>
  <h2>How it works locally</h2>
  <ol>
    <li><strong>Drop a file.</strong> The browser reads it into memory with the File API. No upload request is made.</li>
    <li><strong>Process in the sandbox.</strong> PDF.js renders pages, pdf-lib rewrites the document and WebAssembly/Web Workers do the heavy work on your device.</li>
    <li><strong>Download the result.</strong> The output is generated locally and saved straight from memory. Close the tab and nothing remains.</li>
  </ol>
  <h2>The complete toolbox</h2>
  ${toolGrid(tools)}
  <h2>Why people switch</h2>
  <p>Legal, tax and medical documents should not be uploaded to a stranger's server. Paperly has no document upload endpoint, no analytics profile and no file retention because the file never leaves your device. Single-file tools stay free and unlimited; optional Pro features cover high-volume batch work and saved workflows.</p>
  <p><a href="/privacy">Read the privacy architecture</a> · <a href="/pricing">See free vs Pro</a></p>
</main>`;
}

function toolsBody(tools) {
  return `<main id="seo-content" style="max-width:64rem;margin:0 auto;padding:2rem 1.25rem;font-family:system-ui,sans-serif;line-height:1.65;color:#12211a">
  <nav aria-label="Breadcrumb"><p><a href="/">Paperly PDF</a> / All tools</p></nav>
  <h1>All ${tools.length} PDF tools</h1>
  <p>Every tool below is built, working and runs entirely in your browser. Choose one to open its dedicated page; your file is read directly from your device and the result is handed straight back.</p>
  <p><a href="/privacy">How zero-upload processing works</a> · <a href="/help">Help &amp; FAQ</a></p>
  ${toolGrid(tools)}
</main>`;
}

function privacyBody() {
  return `<main id="seo-content" style="max-width:56rem;margin:0 auto;padding:2rem 1.25rem;font-family:system-ui,sans-serif;line-height:1.7;color:#12211a">
  <nav aria-label="Breadcrumb"><p><a href="/">Paperly PDF</a> / Privacy</p></nav>
  <h1>Privacy promise: we never receive your documents</h1>
  <p>Paperly is a static, client-side application. There is no document upload endpoint, no processing queue and no file storage. Your PDF is read with the browser File API and processed in this tab.</p>
  <h2>Verify zero uploads yourself</h2>
  <ol>
    <li>Open the tool you want, then open your browser's developer tools and select the <strong>Network</strong> panel. Filter by <em>Fetch/XHR</em> and enable <em>Preserve log</em>.</li>
    <li>Drop a PDF and run the tool. Watch the request list: no request carries your document, filename or page content.</li>
    <li>Open <strong>Application → Service Workers</strong> to confirm the offline worker, then switch to airplane mode and run a tool again. The engine is already cached.</li>
    <li>Open <strong>Application → Local Storage</strong>. You will find settings, favorites, activity metadata and (if activated) an offline Pro token — never document bytes or passwords.</li>
  </ol>
  <h2>How the sandbox works</h2>
  <p>Rendering and text extraction use PDF.js in a dedicated Web Worker. Editing, encryption, redaction and conversions use pdf-lib and WebAssembly in the tab. OCR runs Tesseract in a Web Worker. Passwords are used locally with the Web Crypto API and are never stored or transmitted.</p>
  <h2>The only outbound requests</h2>
  <p>On a normal page load the app fetches only its own static assets and self-hosted fonts. OCR is the one exception: the first time you use OCR, the pinned Tesseract engine and language data are fetched from a public CDN and cached by the service worker. Page images are never sent to that CDN. An optional Pro activation checks a Lemon Squeezy license once, then works offline from the signed local token.</p>
  <h2>What is stored locally</h2>
  <p>Recent activity stores only tool name, output filename, page count, output size and a timestamp. Preferences, favorites, saved workflows and an activated license token stay in this browser's localStorage. Clear them at any time from the Activity page or your browser's site-data settings.</p>
  <p><a href="/activity">Review local activity</a> · <a href="/help">Privacy FAQ</a> · <a href="/terms">Terms</a></p>
</main>`;
}

function helpBody() {
  const faqs = [
    ["Are my files really never uploaded?", "Correct. There is no document upload endpoint. Open your browser's Network panel and process a file — you will see no request carrying the document."],
    ["Is Paperly really free?", "All 51 single-document tools are free and unlimited, with no watermarks, accounts or daily caps. Optional Paperly Pro exists only for high-volume commercial features such as batch jobs over three files, saved workflow pipelines and commercial offline team use."],
    ["Does Paperly work offline?", "Yes. After the first load the service worker precaches the app shell, every tool route, the PDF.js worker and self-hosted fonts. Switch off Wi-Fi and the tools keep working. OCR language data is cached the first time you use OCR."],
    ["Why didn't my scanned PDF convert to Word?", "A scan is an image with no text layer. Run OCR PDF first, then convert the searchable result. Paperly reports when a document has no selectable text instead of returning an empty file."],
    ["How does redaction work?", "Redaction rebuilds the selected pages as images and burns the marked areas into the pixels, so the covered text cannot be copied or recovered. The sanitize tool separately removes metadata, scripts, attachments, forms and hidden annotations."],
    ["Can I process multiple files at once?", "Merge, JPG to PDF, the unified organizer, Batch PDF and the workflow builder accept multiple files. Batch results are packaged as a ZIP. All processing remains local."],
  ];
  return `<main id="seo-content" style="max-width:56rem;margin:0 auto;padding:2rem 1.25rem;font-family:system-ui,sans-serif;line-height:1.7;color:#12211a">
  <nav aria-label="Breadcrumb"><p><a href="/">Paperly PDF</a> / Help</p></nav>
  <h1>Help &amp; FAQ</h1>
  <p>Short, honest answers about local processing, formats, limits and privacy.</p>
  ${faqs.map(([q, a]) => `<section><h2>${escape(q)}</h2><p>${escape(a)}</p></section>`).join("\n")}
  <h2>Still stuck?</h2>
  <p>Use the <a href="/tools">tool catalogue</a> to find the right operation, read <a href="/privacy">how local processing works</a>, or <a href="/contact">contact support</a>. Please do not email sensitive documents.</p>
</main>`;
}

function genericBody(page, toolCount) {
  return `<main id="seo-content" style="max-width:56rem;margin:0 auto;padding:2rem 1.25rem;font-family:system-ui,sans-serif;line-height:1.65;color:#12211a">
  <nav aria-label="Breadcrumb"><p><a href="/">Paperly PDF</a> / ${escape(page.route)}</p></nav>
  <h1>${escape(page.title.split(" — ")[0])}</h1>
  <p>${escape(page.description)}</p>
  <p><a href="/tools">Browse all ${toolCount} PDF tools</a> · <a href="/privacy">Privacy model</a> · <a href="/help">Help &amp; FAQ</a></p>
</main>`;
}

function toolBody(tool, tools) {
  const related = tool.related
    .map((id) => tools.find((candidate) => candidate.id === id))
    .filter(Boolean)
    .slice(0, 4);
  const faq = toolFaq(tool);
  return `<main id="seo-content" style="max-width:56rem;margin:0 auto;padding:2rem 1.25rem;font-family:system-ui,sans-serif;line-height:1.65;color:#12211a">
  <nav aria-label="Breadcrumb"><p><a href="/">Paperly PDF</a> / <a href="/tools">All tools</a> / ${escape(CATEGORY_LABEL[tool.category] ?? "Tools")}</p></nav>
  <h1>${escape(tool.name)}</h1>
  <p><strong>${escape(tool.tagline)}</strong></p>
  <p>${escape(tool.description)}</p>
  <p>Processed entirely in your browser. Your file is not uploaded, stored or retained by Paperly — no document bytes leave this device.</p>
  <h2>How it works locally</h2>
  <ol>${tool.steps.map((step) => `<li>${escape(step)}</li>`).join("")}</ol>
  <h2>Limitations</h2>
  <p>${escape(tool.note || "Results depend on the input document. Keep the original file until you have verified the output.")}</p>
  <h2>${escape(tool.name)} FAQ</h2>
  ${faq.map((entry) => `<section><h3>${escape(entry.q)}</h3><p>${escape(entry.a)}</p></section>`).join("\n  ")}
  ${related.length ? `<h2>Related tools</h2><ul>${related.map((item) => `<li><a href="${toolPath(item)}">${escape(item.name)}</a> — ${escape(item.tagline)}</li>`).join("")}</ul>` : ""}
  <p><a href="${toolPath(tool)}">Open ${escape(tool.name)}</a> · <a href="/privacy">How your files stay private</a> · <a href="/tools">All ${tools.length} tools</a></p>
</main>`;
}

/* ------------------------------------------------------------------ *
 * Head / JSON-LD
 * ------------------------------------------------------------------ */
function headTags({ route, title, description, jsonLd }) {
  const url = `${ORIGIN}${route === "/" ? "/" : route}`;
  return `<!-- SEO: generated by scripts/prerender.mjs for ${route} -->
    <meta name="description" content="${escape(description)}" />
    <link rel="canonical" href="${url}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Paperly PDF" />
    <meta property="og:title" content="${escape(title)}" />
    <meta property="og:description" content="${escape(description)}" />
    <meta property="og:url" content="${url}" />
    <meta property="og:image" content="${ORIGIN}/og-image.svg" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escape(title)}" />
    <meta name="twitter:description" content="${escape(description)}" />
    <meta name="twitter:image" content="${ORIGIN}/og-image.svg" />
    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`;
}

async function writeRoute(template, route, title, head, body) {
  if (!template.includes(HEAD_MARKER) || !template.includes(BODY_MARKER)) {
    throw new Error("index.html is missing the SEO markers required for safe prerendering.");
  }
  // split/join avoids `$` replacement-pattern expansion inside the inlined bundle.
  const html = template
    .split(DEFAULT_TITLE)
    .join(escape(title))
    .split(HEAD_MARKER)
    .join(head)
    .split('<div id="root"><!--SEO_BODY--></div>')
    .join(`<div id="root">${body}</div>`);
  if (route === "/") {
    await fs.writeFile(path.join(dist, "index.html"), html, "utf8");
  } else {
    const dir = path.join(dist, route.replace(/^\//, ""));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "index.html"), html, "utf8");
  }
}

const appSchema = (toolCount) => ({
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "Paperly PDF",
  url: ORIGIN,
  applicationCategory: "BusinessApplication",
  operatingSystem: "Any modern browser",
  description: `${toolCount} private PDF tools that run entirely in the browser. Files are never uploaded.`,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  featureList: [
    "Merge, split and organize PDFs",
    "Compress, repair and OCR PDFs",
    "Convert PDF to Word, Excel, PowerPoint, JPG and Markdown",
    "Create and fill PDF forms",
    "Redact, sign and password-protect PDFs",
    "Ask questions, inspect, sanitize and outline PDFs",
    "Extract tables to CSV and batch processing",
  ],
});

function toolSchema(tool, route) {
  const faq = toolFaq(tool);
  return [
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: tool.name,
      applicationCategory: "BusinessApplication",
      applicationSubCategory: "PDF editor",
      operatingSystem: "Any modern browser",
      url: `${ORIGIN}${route}`,
      description: tool.description,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      isPartOf: { "@type": "WebApplication", name: "Paperly PDF", url: ORIGIN },
      featureList: tool.steps,
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faq.map((entry) => ({
        "@type": "Question",
        name: entry.q,
        acceptedAnswer: { "@type": "Answer", text: entry.a },
      })),
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Paperly PDF", item: ORIGIN },
        { "@type": "ListItem", position: 2, name: "All tools", item: `${ORIGIN}/tools` },
        { "@type": "ListItem", position: 3, name: tool.name, item: `${ORIGIN}${route}` },
      ],
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */
async function main() {
  const template = await fs.readFile(path.join(dist, "index.html"), "utf8");
  const registrySource = await fs.readFile(path.join(root, "src/lib/toolRegistry.ts"), "utf8");
  const slugSource = await fs.readFile(path.join(root, "src/lib/slugs.ts"), "utf8");
  const tools = parseRegistry(registrySource);
  if (tools.length !== 51) throw new Error(`Prerender expected 51 tools, parsed ${tools.length}.`);
  const slugs = parseSlugs(slugSource);
  for (const tool of tools) {
    tool.slug = slugs[tool.id];
    if (!tool.slug) throw new Error(`No canonical slug for tool "${tool.id}" in src/lib/slugs.ts.`);
  }
  if (new Set(tools.map((tool) => tool.slug)).size !== tools.length) {
    throw new Error("Canonical tool slugs must be unique.");
  }

  const toolCount = tools.length;
  const STATIC_PAGES = staticPages(toolCount);
  const urls = [];

  for (const page of STATIC_PAGES) {
    const jsonLd =
      page.route === "/"
        ? [appSchema(toolCount), { "@context": "https://schema.org", "@type": "Organization", name: "Paperly PDF", url: ORIGIN }]
        : page.route === "/tools"
          ? [
              {
                "@context": "https://schema.org",
                "@type": "CollectionPage",
                name: page.title,
                description: page.description,
                url: `${ORIGIN}${page.route}`,
                mainEntity: {
                  "@type": "ItemList",
                  numberOfItems: toolCount,
                  itemListElement: tools.map((tool, index) => ({
                    "@type": "ListItem",
                    position: index + 1,
                    name: tool.name,
                    url: `${ORIGIN}${toolPath(tool)}`,
                  })),
                },
              },
            ]
          : { "@context": "https://schema.org", "@type": "WebPage", name: page.title, description: page.description, url: `${ORIGIN}${page.route}` };
    const body =
      page.route === "/"
        ? homeBody(tools)
        : page.route === "/tools"
          ? toolsBody(tools)
          : page.route === "/privacy"
            ? privacyBody()
            : page.route === "/help"
              ? helpBody()
              : genericBody(page, toolCount);
    await writeRoute(template, page.route, page.title, headTags({ ...page, jsonLd }), body);
    urls.push({ loc: `${ORIGIN}${page.route}`, priority: page.route === "/" ? "1.0" : page.route === "/tools" ? "0.9" : "0.7" });
  }

  for (const tool of tools) {
    const route = toolPath(tool);
    const title = `${tool.name} — free and private, right in your browser | Paperly PDF`;
    const description = `${tool.tagline} ${tool.description}`.slice(0, 300);
    await writeRoute(template, route, title, headTags({ route, title, description, jsonLd: toolSchema(tool, route) }), toolBody(tool, tools));
    urls.push({ loc: `${ORIGIN}${route}`, priority: "0.8" });
  }

  const today = new Date().toISOString().slice(0, 10);
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (entry) =>
      `  <url><loc>${entry.loc}</loc><lastmod>${today}</lastmod><changefreq>monthly</changefreq><priority>${entry.priority}</priority></url>`,
  )
  .join("\n")}
</urlset>
`;
  await fs.writeFile(path.join(dist, "sitemap.xml"), sitemap, "utf8");

  await fs.writeFile(
    path.join(dist, "robots.txt"),
    `# Paperly PDF — crawler policy\nUser-agent: *\nAllow: /\nDisallow: /activity\n\n# No user documents are stored on any server, so there is nothing private to crawl.\nSitemap: ${ORIGIN}/sitemap.xml\n`,
    "utf8",
  );

  // Legacy `/tool/:id` and `/tools/:id` URLs redirect permanently to the clean
  // canonical slug. The catch-all keeps client routes (e.g. /activity) working.
  const legacy = [
    ...tools.flatMap((tool) => [`/tool/${tool.id}  ${toolPath(tool)}  301`, `/tools/${tool.id}  ${toolPath(tool)}  301`]),
    // The workflow tool shipped briefly at /pdf-workflow before the public
    // /workflows route; keep the old address working.
    "/pdf-workflow  /workflows  301",
  ].join("\n");
  await fs.writeFile(
    path.join(dist, "_redirects"),
    `# Generated by scripts/prerender.mjs — do not edit dist directly.\n${legacy}\n\n# SPA fallback for local-only client routes. Real prerendered files win first.\n/*  /index.html  200\n`,
    "utf8",
  );

  // A small brand image for Open Graph/Twitter cards (no fabricated content).
  const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#12211a"/>
  <rect x="72" y="72" width="88" height="88" rx="22" fill="#f7f4ec"/>
  <path d="M94 96h26l18 18v40H94z" fill="#12211a"/><path d="M120 96v18h18" fill="#d9f26c"/>
  <text x="72" y="270" font-family="Georgia,serif" font-size="70" fill="#f7f4ec">Every PDF tool.</text>
  <text x="72" y="352" font-family="Georgia,serif" font-style="italic" font-size="70" fill="#d9f26c">Nowhere to upload.</text>
  <text x="72" y="440" font-family="system-ui,sans-serif" font-size="28" fill="#c9d3cb">${tools.length} private PDF tools that run in your browser.</text>
  <text x="72" y="492" font-family="system-ui,sans-serif" font-size="24" fill="#8fa096">Merge · OCR · Redact · Forms · Ask · Inspect · Sanitize · Convert</text>
  <text x="72" y="560" font-family="system-ui,sans-serif" font-size="22" fill="#d9f26c">${escape(SITE_HOST)}</text>
</svg>`;
  await fs.writeFile(path.join(dist, "og-image.svg"), og, "utf8");

  console.log(
    `Prerendered ${urls.length} routes (${tools.length} tool slugs) + sitemap.xml + robots.txt + _redirects for ${ORIGIN}`,
  );
}

main().catch((error) => {
  console.error("Prerender failed:", error.message);
  process.exit(1);
});
