/* ------------------------------------------------------------------ *
 * Sample documents
 *
 * First-run value: every upload surface can offer a real, locally
 * generated example so a visitor can try the tool before choosing a
 * file. Nothing is fetched, nothing is uploaded. Heavy engines are
 * imported lazily so the app shell stays light.
 * ------------------------------------------------------------------ */

export interface SampleSpec {
  label: string;
  create: () => Promise<File>;
}

const A4 = { width: 595.28, height: 841.89 };
const INK = "#12211a";
const FOREST = "#1f4d3a";
const LIME = "#d9f26c";
const MUTED = "#5b6b63";
const LINE = "#d8d3c6";

function hexRgb(hex: string) {
  const num = Number.parseInt(hex.replace("#", ""), 16);
  return {
    r: ((num >> 16) & 255) / 255,
    g: ((num >> 8) & 255) / 255,
    b: (num & 255) / 255,
  };
}

function wrapLine(font: { widthOfTextAtSize: (t: string, s: number) => number }, text: string, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= maxWidth || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** A three-page, realistic sample PDF: cover, invoice table and terms. */
export async function createSamplePdf(): Promise<File> {
  const { PDFDocument, StandardFonts, rgb } = await import("@/lib/pdf");
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const color = (hex: string) => {
    const c = hexRgb(hex);
    return rgb(c.r, c.g, c.b);
  };

  doc.setTitle("Paperly sample document");
  doc.setAuthor("Paperly PDF");
  doc.setSubject("A sample PDF for trying Paperly tools locally");
  doc.setKeywords(["sample", "paperly", "invoice"]);
  doc.setProducer("Paperly PDF");
  doc.setCreator("Paperly PDF");

  /* ------------------------------- cover ------------------------------- */
  const cover = doc.addPage([A4.width, A4.height]);
  cover.drawRectangle({ x: 0, y: A4.height - 210, width: A4.width, height: 210, color: color(INK) });
  cover.drawRectangle({ x: 0, y: A4.height - 216, width: A4.width, height: 6, color: color(LIME) });
  cover.drawText("PAPERLY", { x: 56, y: A4.height - 92, size: 13, font: bold, color: color(LIME) });
  cover.drawText("Sample document", { x: 56, y: A4.height - 142, size: 34, font: bold, color: color("#f7f4ec") });
  cover.drawText("Three pages of realistic content for trying tools safely.", {
    x: 56,
    y: A4.height - 172,
    size: 12,
    font: regular,
    color: color("#c9d3cc"),
  });

  let cursor = A4.height - 280;
  cover.drawText("What is inside", { x: 56, y: cursor, size: 16, font: bold, color: color(INK) });
  cursor -= 32;
  const contents: [string, string][] = [
    ["Page 1", "Cover and contents — a title page, metadata and body copy."],
    ["Page 2", "Invoice — a real table with line items, tax and a total."],
    ["Page 3", "Terms — numbered clauses and a signature line."],
  ];
  for (const [label, description] of contents) {
    cover.drawText(label, { x: 56, y: cursor, size: 11, font: bold, color: color(FOREST) });
    cover.drawText(description, { x: 132, y: cursor, size: 11, font: regular, color: color(MUTED) });
    cover.drawLine({ start: { x: 56, y: cursor - 10 }, end: { x: A4.width - 56, y: cursor - 10 }, thickness: 0.7, color: color(LINE) });
    cursor -= 34;
  }

  const intro =
    "This document was generated in your browser by Paperly. It contains selectable text, " +
    "a ruled table and multi-page content — everything needed to try merging, splitting, " +
    "compressing, converting, redacting, signing and OCR tools without uploading a real file.";
  cursor -= 20;
  for (const line of wrapLine(regular, intro, 11, A4.width - 112)) {
    cover.drawText(line, { x: 56, y: cursor, size: 11, font: regular, color: color(MUTED) });
    cursor -= 17;
  }
  cover.drawText("Generated locally. Never uploaded.", { x: 56, y: 64, size: 9.5, font: bold, color: color(FOREST) });

  /* ------------------------------ invoice ------------------------------ */
  const invoice = doc.addPage([A4.width, A4.height]);
  invoice.drawText("INVOICE", { x: 56, y: A4.height - 86, size: 26, font: bold, color: color(INK) });
  invoice.drawText("Paperly Studio · 12 Example Street · sample@paperly.local", {
    x: 56,
    y: A4.height - 108,
    size: 9.5,
    font: regular,
    color: color(MUTED),
  });
  invoice.drawText("Invoice no. 2041", { x: A4.width - 200, y: A4.height - 72, size: 10, font: bold, color: color(INK) });
  invoice.drawText("Issued 12 March 2026", { x: A4.width - 200, y: A4.height - 88, size: 9.5, font: regular, color: color(MUTED) });
  invoice.drawText("Due 11 April 2026", { x: A4.width - 200, y: A4.height - 103, size: 9.5, font: regular, color: color(MUTED) });

  const columns = [56, 330, 412, 500];
  const headerY = A4.height - 168;
  invoice.drawRectangle({ x: 56, y: headerY - 8, width: A4.width - 112, height: 26, color: color(FOREST) });
  invoice.drawText("Description", { x: columns[0] + 10, y: headerY, size: 9.5, font: bold, color: color("#f7f4ec") });
  invoice.drawText("Qty", { x: columns[1], y: headerY, size: 9.5, font: bold, color: color("#f7f4ec") });
  invoice.drawText("Rate", { x: columns[2], y: headerY, size: 9.5, font: bold, color: color("#f7f4ec") });
  invoice.drawText("Amount", { x: columns[3], y: headerY, size: 9.5, font: bold, color: color("#f7f4ec") });

  const rows: [string, number, number][] = [
    ["Document workflow design", 1, 1200],
    ["Privacy review and redaction", 3, 240],
    ["Local OCR and indexing", 2, 180],
    ["Scan clean-up and deskew", 5, 90],
  ];
  let rowY = headerY - 38;
  rows.forEach(([label, qty, rate], index) => {
    if (index % 2 === 1) {
      invoice.drawRectangle({ x: 56, y: rowY - 8, width: A4.width - 112, height: 24, color: rgb(0.97, 0.965, 0.95) });
    }
    invoice.drawText(label, { x: columns[0] + 10, y: rowY, size: 10, font: regular, color: color(INK) });
    invoice.drawText(String(qty), { x: columns[1], y: rowY, size: 10, font: regular, color: color(INK) });
    invoice.drawText(`$${rate.toFixed(2)}`, { x: columns[2], y: rowY, size: 10, font: regular, color: color(INK) });
    invoice.drawText(`$${(qty * rate).toFixed(2)}`, { x: columns[3], y: rowY, size: 10, font: regular, color: color(INK) });
    rowY -= 24;
  });

  const subtotal = rows.reduce((sum, [, qty, rate]) => sum + qty * rate, 0);
  const tax = subtotal * 0.08;
  rowY -= 10;
  invoice.drawLine({ start: { x: columns[2], y: rowY + 12 }, end: { x: A4.width - 56, y: rowY + 12 }, thickness: 0.8, color: color(LINE) });
  invoice.drawText("Subtotal", { x: columns[2], y: rowY - 4, size: 10, font: regular, color: color(MUTED) });
  invoice.drawText(`$${subtotal.toFixed(2)}`, { x: columns[3], y: rowY - 4, size: 10, font: regular, color: color(INK) });
  invoice.drawText("Tax (8%)", { x: columns[2], y: rowY - 24, size: 10, font: regular, color: color(MUTED) });
  invoice.drawText(`$${tax.toFixed(2)}`, { x: columns[3], y: rowY - 24, size: 10, font: regular, color: color(INK) });
  invoice.drawRectangle({ x: columns[2] - 10, y: rowY - 70, width: A4.width - 56 - columns[2] + 10, height: 32, color: color(INK) });
  invoice.drawText("Total", { x: columns[2], y: rowY - 58, size: 11, font: bold, color: color(LIME) });
  invoice.drawText(`$${(subtotal + tax).toFixed(2)}`, { x: columns[3], y: rowY - 58, size: 11, font: bold, color: color(LIME) });
  invoice.drawText("Payment terms: 30 days. This is sample data, not a real invoice.", {
    x: 56,
    y: 96,
    size: 9,
    font: regular,
    color: color(MUTED),
  });

  /* ------------------------------- terms ------------------------------- */
  const terms = doc.addPage([A4.width, A4.height]);
  terms.drawText("Terms and conditions", { x: 56, y: A4.height - 86, size: 22, font: bold, color: color(INK) });
  terms.drawLine({ start: { x: 56, y: A4.height - 102 }, end: { x: A4.width - 56, y: A4.height - 102 }, thickness: 1, color: color(LIME) });
  const clauses = [
    ["1. Scope", "These sample terms exist to give the document realistic multi-paragraph content. They are not legal advice."],
    ["2. Privacy", "Everything you do with this file stays in the browser tab. No copy is uploaded to a server."],
    ["3. Processing", "Tools such as merge, split, OCR and redaction operate on the bytes you can see on your device."],
    ["4. Retention", "Paperly stores only the output filename in your local activity list. File contents are never stored."],
    ["5. Contact", "Questions about this sample can be ignored — it is generated content for testing."],
  ];
  let termY = A4.height - 150;
  for (const [heading, body] of clauses) {
    terms.drawText(heading, { x: 56, y: termY, size: 11.5, font: bold, color: color(FOREST) });
    termY -= 18;
    for (const line of wrapLine(regular, body, 10.5, A4.width - 112)) {
      terms.drawText(line, { x: 56, y: termY, size: 10.5, font: regular, color: color(MUTED) });
      termY -= 16;
    }
    termY -= 14;
  }
  terms.drawLine({ start: { x: 56, y: 180 }, end: { x: 300, y: 180 }, thickness: 0.8, color: color(LINE) });
  terms.drawText("Signature", { x: 56, y: 166, size: 9, font: regular, color: color(MUTED) });
  terms.drawLine({ start: { x: 330, y: 180 }, end: { x: A4.width - 56, y: 180 }, thickness: 0.8, color: color(LINE) });
  terms.drawText("Date", { x: 330, y: 166, size: 9, font: regular, color: color(MUTED) });

  const bytes = await doc.save();
  return new File([bytes as unknown as BlobPart], "paperly-sample.pdf", { type: "application/pdf" });
}

/** A scan-like PNG for OCR, image-to-PDF and clean-up tools. */
export async function createSampleImage(): Promise<File> {
  const width = 1240;
  const height = 1754;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser can’t create the sample image.");
  ctx.fillStyle = "#fbfaf6";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#2b2b2b";
  ctx.lineWidth = 3;
  ctx.strokeRect(60, 60, width - 120, height - 120);

  ctx.fillStyle = "#12211a";
  ctx.font = "bold 54px Helvetica, Arial, sans-serif";
  ctx.fillText("SAMPLE EXPENSE REPORT", 110, 180);
  ctx.font = "24px Helvetica, Arial, sans-serif";
  ctx.fillStyle = "#555";
  ctx.fillText("Generated in your browser — no upload", 110, 222);
  ctx.fillText("Employee: Alex Example    ·    Period: March 2026", 110, 290);

  ctx.strokeStyle = "#12211a";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(110, 340);
  ctx.lineTo(width - 110, 340);
  ctx.stroke();

  const rows = [
    ["Date", "Category", "Description", "Amount"],
    ["03 Mar", "Travel", "Rail ticket to client site", "$84.20"],
    ["05 Mar", "Meals", "Working lunch (2 people)", "$46.50"],
    ["09 Mar", "Software", "PDF toolkit licence", "$129.00"],
    ["14 Mar", "Travel", "Airport transfer", "$32.75"],
    ["21 Mar", "Office", "Printer paper and toner", "$58.40"],
  ];
  let y = 410;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (i === 0) {
      ctx.fillStyle = "#e8e3d6";
      ctx.fillRect(100, y - 36, width - 200, 52);
      ctx.fillStyle = "#12211a";
      ctx.font = "bold 24px Helvetica, Arial, sans-serif";
    } else {
      ctx.fillStyle = "#222";
      ctx.font = "24px Helvetica, Arial, sans-serif";
    }
    ctx.fillText(row[0], 120, y);
    ctx.fillText(row[1], 300, y);
    ctx.fillText(row[2], 500, y);
    ctx.fillText(row[3], 1000, y);
    y += 64;
  }

  ctx.strokeStyle = "#888";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(110, y + 10);
  ctx.lineTo(width - 110, y + 10);
  ctx.stroke();

  ctx.fillStyle = "#12211a";
  ctx.font = "bold 30px Helvetica, Arial, sans-serif";
  ctx.fillText("TOTAL", 760, y + 70);
  ctx.fillText("$350.85", 1000, y + 70);

  ctx.font = "22px Helvetica, Arial, sans-serif";
  ctx.fillStyle = "#666";
  ctx.fillText("This is sample data. OCR should read the table above.", 110, y + 170);

  ctx.strokeStyle = "#333";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(110, y + 300);
  ctx.lineTo(500, y + 300);
  ctx.stroke();
  ctx.fillStyle = "#555";
  ctx.font = "20px Helvetica, Arial, sans-serif";
  ctx.fillText("Approved by", 110, y + 330);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Your browser couldn’t produce the sample image.");
  return new File([blob], "paperly-sample-scan.png", { type: "image/png" });
}

/** A small, structured Markdown file. */
export async function createSampleMarkdown(): Promise<File> {
  const body = `# Paperly sample notes

A short document for trying Markdown to PDF.

## Why teams use Paperly

- Everything runs in the browser
- No account or upload
- Files never leave the device

## Numbers

| Tool | Runs locally | Needs an account |
| --- | --- | --- |
| Merge PDF | Yes | No |
| OCR | Yes | No |
| Redact | Yes | No |

## Code

\`\`\`ts
const output = await mergePdfs(files);
\`\`\`

> Tip: open the advanced options to change the page size and theme.
`;
  return new File([body], "paperly-sample-notes.md", { type: "text/markdown" });
}

/** A small CSV with a header row and typed values. */
export async function createSampleCsv(): Promise<File> {
  const body = `Date,Category,Description,Amount
2026-03-03,Travel,Rail ticket to client site,84.20
2026-03-05,Meals,Working lunch (2 people),46.50
2026-03-09,Software,PDF toolkit licence,129.00
2026-03-14,Travel,Airport transfer,32.75
2026-03-21,Office,Printer paper and toner,58.40
`;
  return new File([body], "paperly-sample-expenses.csv", { type: "text/csv" });
}

/** A small HTML page for HTML to PDF. */
export async function createSampleHtml(): Promise<File> {
  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Paperly sample page</title>
    <style>
      body { font: 16px/1.6 Georgia, serif; color: #12211a; margin: 48px; }
      h1 { font-size: 34px; margin: 0 0 8px; }
      .kicker { text-transform: uppercase; letter-spacing: .12em; color: #1f4d3a; font: 600 12px system-ui; }
      table { border-collapse: collapse; width: 100%; margin-top: 20px; }
      th, td { border-bottom: 1px solid #ddd; padding: 8px; text-align: left; }
    </style>
  </head>
  <body>
    <p class="kicker">Sample article</p>
    <h1>Print-ready HTML in one step</h1>
    <p>This page is generated locally and converted with the same engine as any pasted HTML.</p>
    <table>
      <tr><th>Feature</th><th>Status</th></tr>
      <tr><td>Local rendering</td><td>On</td></tr>
      <tr><td>Uploads</td><td>Never</td></tr>
    </table>
  </body>
</html>`;
  return new File([body], "paperly-sample-page.html", { type: "text/html" });
}

/** A plain-text sample for text-based tools. */
export async function createSampleText(): Promise<File> {
  const body = `Paperly sample text

This file exercises text tools such as find and redact, extract text and conversion.

Contact details used only as examples:
Email: sample.person@example.com
Phone: +1 555 0100
Card: 4242 4242 4242 4242
IBAN: GB82 WEST 1234 5698 7654 32

All values above are test data.`;
  return new File([body], "paperly-sample.txt", { type: "text/plain" });
}

export const SAMPLE = {
  pdf: { label: "Try a sample PDF", create: createSamplePdf },
  image: { label: "Try a sample scan", create: createSampleImage },
  markdown: { label: "Try sample Markdown", create: createSampleMarkdown },
  csv: { label: "Try sample CSV", create: createSampleCsv },
  html: { label: "Try sample HTML", create: createSampleHtml },
  text: { label: "Try sample text", create: createSampleText },
} satisfies Record<string, SampleSpec>;
