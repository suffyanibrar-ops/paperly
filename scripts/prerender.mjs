#!/usr/bin/env node
/**
 * Paperly PDF — static SEO prerender.
 *
 * The app is a single-file SPA. Search engines do run JavaScript, but a commercial
 * PDF platform needs unique titles, descriptions, canonicals, structured data and
 * crawlable content for every tool. This step reads the built `dist/index.html`,
 * extracts the tool registry from source, and writes real static HTML for every
 * public route while leaving the SPA behaviour untouched.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const ORIGIN = process.env.PAPERLY_ORIGIN || "https://paperlypdf.netlify.app";
const HEAD_MARKER = "<!--SEO_HEAD-->";
const BODY_MARKER = "<!--SEO_BODY-->";
const DEFAULT_TITLE = "Paperly — Private PDF tools that work in your browser";

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
        isNew: /new:\s*true/.test(body),
      };
    })
    .filter((tool) => tool.id && tool.name);
}

const staticPages = (toolCount) => [
  { route: "/", title: `Paperly PDF — ${toolCount} private PDF tools that never upload your files`, description: `Merge, split, compress, convert, OCR, redact, sign, fill, inspect and outline PDFs entirely in your browser. No uploads, no accounts, no file-size tiers. ${toolCount} working PDF tools.` },
  { route: "/tools", title: `All ${toolCount} PDF tools — Paperly PDF`, description: "Browse every Paperly PDF tool: organize, optimize, convert, secure and understand PDFs. All processing happens on your device." },
  { route: "/why", title: "Why Paperly PDF — privacy by architecture", description: "Paperly processes documents in your browser instead of on a server. Learn how local PDF processing works and where it differs from cloud tools." },
  { route: "/vs-ilovepdf", title: "Paperly vs iLovePDF — honest feature comparison", description: "A sourced comparison of Paperly and iLovePDF: privacy, free limits, batch processing, forms, OCR, PDF/A and AI features. Includes where iLovePDF is stronger." },
  { route: "/pricing", title: "Pricing — Paperly PDF is free, with no paid tier", description: "Every Paperly PDF tool is free: no watermarks, no task limits, no required account and no premium gate." },
  { route: "/privacy", title: "Privacy policy — Paperly PDF", description: "What stays in your browser, when the OCR engine is fetched, and what activity metadata is stored locally." },
  { route: "/help", title: "Help & FAQ — Paperly PDF", description: "Answers about local processing, OCR, conversions, password protection, redaction, PDF/A readiness and troubleshooting." },
  { route: "/guides", title: "PDF guides & tutorials — Paperly PDF", description: "Practical guides to merging, compressing, OCR, redaction, archival preparation and password protection, including honest limitations." },
  { route: "/about", title: "About Paperly PDF", description: "An independent, privacy-first document toolkit built on PDF.js, pdf-lib, Tesseract and the Web Crypto API." },
  { route: "/contact", title: "Contact Paperly PDF", description: "Product support, privacy questions, security reports and feature requests. No documents are accepted by email." },
  { route: "/terms", title: "Terms of use — Paperly PDF", description: "Plain-language terms for Paperly's free browser-based PDF tools, including signature and archival limitations." },
  { route: "/sitemap", title: "Sitemap — Paperly PDF", description: "Every Paperly tool and page in one place." },
];

const CATEGORY_LABEL = { organize: "Organize", convert: "Convert", optimize: "Optimize", secure: "Secure", intelligence: "Intelligence" };

const escape = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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

function toolBody(tool, tools) {
  const related = tool.related
    .map((id) => tools.find((candidate) => candidate.id === id))
    .filter(Boolean)
    .slice(0, 4);
  return `<main id="seo-content" style="max-width:56rem;margin:0 auto;padding:2rem 1.25rem;font-family:system-ui,sans-serif;line-height:1.6;color:#12211a">
  <nav aria-label="Breadcrumb"><p><a href="/">Paperly PDF</a> / <a href="/tools">All tools</a> / ${escape(CATEGORY_LABEL[tool.category] ?? "Tools")}</p></nav>
  <h1>${escape(tool.name)}</h1>
  <p><strong>${escape(tool.tagline)}</strong></p>
  <p>${escape(tool.description)}</p>
  <p>Processed entirely in your browser. Your file is not uploaded, stored or retained by Paperly.</p>
  <h2>How ${escape(tool.name)} works</h2>
  <ol>${tool.steps.map((step) => `<li>${escape(step)}</li>`).join("")}</ol>
  <h2>Limitations</h2>
  <p>${escape(tool.note || "Results depend on the input document. Always keep the original file until you have verified the output.")}</p>
  ${related.length ? `<h2>Related tools</h2><ul>${related.map((item) => `<li><a href="/tool/${item.id}">${escape(item.name)}</a> — ${escape(item.tagline)}</li>`).join("")}</ul>` : ""}
  <p><a href="/tool/${tool.id}">Open ${escape(tool.name)}</a> · <a href="/privacy">How your files stay private</a></p>
</main>`;
}

function pageBody(page, toolCount) {
  return `<main id="seo-content" style="max-width:56rem;margin:0 auto;padding:2rem 1.25rem;font-family:system-ui,sans-serif;line-height:1.6;color:#12211a">
  <h1>${escape(page.title.split(" — ")[0])}</h1>
  <p>${escape(page.description)}</p>
  <p><a href="/tools">Browse all ${toolCount} PDF tools</a> · <a href="/privacy">Privacy model</a> · <a href="/help">Help &amp; FAQ</a></p>
</main>`;
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

async function main() {
  const template = await fs.readFile(path.join(dist, "index.html"), "utf8");
  const registrySource = await fs.readFile(path.join(root, "src/lib/toolRegistry.ts"), "utf8");
  const tools = parseRegistry(registrySource);
  if (tools.length < 49) throw new Error(`Prerender could not parse the tool registry (found ${tools.length}).`);

  const toolCount = tools.length;
  const STATIC_PAGES = staticPages(toolCount);
  const urls = [];
  for (const page of STATIC_PAGES) {
    const jsonLd =
      page.route === "/"
        ? [appSchema(toolCount), { "@context": "https://schema.org", "@type": "Organization", name: "Paperly PDF", url: ORIGIN }]
        : { "@context": "https://schema.org", "@type": "WebPage", name: page.title, description: page.description, url: `${ORIGIN}${page.route}` };
    await writeRoute(template, page.route, page.title, headTags({ ...page, jsonLd }), pageBody(page, toolCount));
    urls.push({ loc: `${ORIGIN}${page.route}`, priority: page.route === "/" ? "1.0" : "0.7" });
  }

  for (const tool of tools) {
    const route = `/tool/${tool.id}`;
    const title = `${tool.name} — free and private, right in your browser | Paperly PDF`;
    const description = `${tool.tagline} ${tool.description}`.slice(0, 300);
    const jsonLd = [
      {
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: tool.name,
        applicationCategory: "BusinessApplication",
        operatingSystem: "Any modern browser",
        url: `${ORIGIN}${route}`,
        description: tool.description,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        isPartOf: { "@type": "WebApplication", name: "Paperly PDF", url: ORIGIN },
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
      {
        "@context": "https://schema.org",
        "@type": "HowTo",
        name: `How to use ${tool.name}`,
        step: tool.steps.map((step, index) => ({ "@type": "HowToStep", position: index + 1, text: step })),
      },
    ];
    await writeRoute(template, route, title, headTags({ route, title, description, jsonLd }), toolBody(tool, tools));
    urls.push({ loc: `${ORIGIN}${route}`, priority: "0.8" });
  }

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (entry) =>
      `  <url><loc>${entry.loc}</loc><lastmod>${new Date().toISOString().slice(0, 10)}</lastmod><changefreq>monthly</changefreq><priority>${entry.priority}</priority></url>`,
  )
  .join("\n")}
</urlset>
`;
  await fs.writeFile(path.join(dist, "sitemap.xml"), sitemap, "utf8");

  // A small brand image for Open Graph/Twitter cards (no fabricated content).
  const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#12211a"/>
  <rect x="72" y="72" width="88" height="88" rx="22" fill="#f7f4ec"/>
  <path d="M94 96h26l18 18v40H94z" fill="#12211a"/><path d="M120 96v18h18" fill="#d9f26c"/>
  <text x="72" y="270" font-family="Georgia,serif" font-size="70" fill="#f7f4ec">Every PDF tool.</text>
  <text x="72" y="352" font-family="Georgia,serif" font-style="italic" font-size="70" fill="#d9f26c">Nowhere to upload.</text>
  <text x="72" y="440" font-family="system-ui,sans-serif" font-size="28" fill="#c9d3cb">${tools.length} private PDF tools that run in your browser.</text>
  <text x="72" y="492" font-family="system-ui,sans-serif" font-size="24" fill="#8fa096">Merge · OCR · Redact · Forms · Ask · Inspect · Sanitize · Convert</text>
  <text x="72" y="560" font-family="system-ui,sans-serif" font-size="22" fill="#d9f26c">paperlypdf.netlify.app</text>
</svg>`;
  await fs.writeFile(path.join(dist, "og-image.svg"), og, "utf8");

  console.log(`Prerendered ${urls.length} routes (${tools.length} tools) + sitemap.xml + og-image.svg`);
}

main().catch((error) => {
  console.error("Prerender failed:", error.message);
  process.exit(1);
});
