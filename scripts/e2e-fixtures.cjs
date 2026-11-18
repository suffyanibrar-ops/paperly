/* Generates every fixture used by the 42-tool Playwright matrix. */
const { PDFDocument, StandardFonts, rgb, degrees } = require('@cantoo/pdf-lib');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell } = require('docx');
const XLSX = require('xlsx');
const PptxGenJS = require('pptxgenjs');
const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const dir = path.resolve(__dirname, '..', 'tests', 'fixtures');
fs.mkdirSync(dir, { recursive: true });
const out = (name) => path.join(dir, name);

(async () => {
  const base = await PDFDocument.create();
  const font = await base.embedFont(StandardFonts.Helvetica);
  const bold = await base.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= 3; i++) {
    const page = base.addPage([595.28, 841.89]);
    page.drawText('Quarterly Inventory Report', { x: 50, y: 780, size: 19, font: bold, color: rgb(0.07, 0.13, 0.1) });
    page.drawText(`Page ${i} of 3`, { x: 50, y: 752, size: 10, font });
    page.drawText('Sensitive: account 99887766 balance 12000 EUR', { x: 50, y: 690, size: 10, font });
    page.drawText('Item A-100 paper clips quantity 12 unit price 2.50 total 30.00', { x: 50, y: 660, size: 10, font });
    page.drawText('Item B-204 recycled paper ream quantity 8 unit price 6.75 total 54.00', { x: 50, y: 640, size: 10, font });
    page.drawText('Subtotal 269.98 EUR Tax 53.99 EUR Total 323.97 EUR', { x: 50, y: 610, size: 10, font });
    page.drawText('This document has a genuine text layer used for conversion tests.', { x: 50, y: 200, size: 9, font });
  }
  fs.writeFileSync(out('sample.pdf'), await base.save());

  const appendix = await PDFDocument.create();
  const af = await appendix.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++) {
    const page = appendix.addPage([595.28, 841.89]);
    page.drawText(`Appendix A — Warehouse Notes ${i}`, { x: 50, y: 780, size: 16, font: af });
  }
  fs.writeFileSync(out('sample2.pdf'), await appendix.save());

  const rotated = await PDFDocument.create();
  const rf = await rotated.embedFont(StandardFonts.Helvetica);
  const r1 = rotated.addPage([595.28, 841.89]);
  r1.drawText('Rotated page content', { x: 50, y: 780, size: 14, font: rf });
  r1.setRotation(degrees(90));
  const r2 = rotated.addPage([595.28, 841.89]);
  r2.drawText('Upright page content', { x: 50, y: 780, size: 14, font: rf });
  fs.writeFileSync(out('rotated.pdf'), await rotated.save());

  const enc = await PDFDocument.load(fs.readFileSync(out('sample.pdf')), { updateMetadata: false });
  enc.encrypt({ userPassword: 'Secret123!', ownerPassword: 'Owner123!' });
  fs.writeFileSync(out('encrypted.pdf'), await enc.save());

  const formDoc = await PDFDocument.create();
  const fp = formDoc.addPage([595.28, 841.89]);
  fp.drawText('PAPERLY APPLICATION FORM', { x: 50, y: 780, size: 18, font: bold });
  const form = formDoc.getForm();
  form.createTextField('full_name').addToPage(fp, { x: 50, y: 690, width: 300, height: 24 });
  form.createTextField('email').addToPage(fp, { x: 50, y: 640, width: 300, height: 24 });
  const country = form.createDropdown('country');
  country.addOptions(['United Kingdom', 'Germany', 'France', 'Spain']);
  country.addToPage(fp, { x: 50, y: 590, width: 200, height: 24 });
  form.createCheckBox('accept_terms').addToPage(fp, { x: 50, y: 540, width: 18, height: 18 });
  fs.writeFileSync(out('form.pdf'), await formDoc.save());

  const docx = new Document({
    creator: 'Paperly test',
    sections: [{
      children: [
        new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: 'Project Field Notes', bold: true, size: 40 })] }),
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Overview')] }),
        new Paragraph({ children: [new TextRun('A realistic body paragraph long enough to wrap across more than one line in the generated PDF document.')] }),
        new Paragraph({ text: 'Confirm the delivery window', bullet: { level: 0 } }),
        new Paragraph({ text: 'Update the inventory sheet', bullet: { level: 0 } }),
        new Table({
          rows: [
            new TableRow({ children: ['Site', 'Visits', 'Status'].map((h) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })] })) }),
            new TableRow({ children: ['North', '12', 'Open'].map((c) => new TableCell({ children: [new Paragraph({ children: [new TextRun(c)] })] })) }),
          ],
        }),
        new Paragraph({ children: [new TextRun('End of document.')] }),
      ],
    }],
  });
  fs.writeFileSync(out('sample.docx'), await Packer.toBuffer(docx));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Product', 'Region', 'Units', 'Unit price', 'Revenue'], ['A4 paper', 'North', 1200, 4.5, 5400], ['Ink cartridge', 'North', 85, 32, 2720]]), 'Sales');
  XLSX.writeFile(wb, out('sample.xlsx'));
  fs.writeFileSync(out('sample.csv'), 'Product,Region,Units,Unit price,Revenue\nA4 paper,North,1200,4.5,5400\nFolders,South,600,1.2,720\n');

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  const s1 = pptx.addSlide();
  s1.addText('Modern PDF workflows', { x: 0.6, y: 0.6, w: 8.8, h: 0.9, fontSize: 30, bold: true });
  const s2 = pptx.addSlide();
  s2.addText('What changed', { x: 0.6, y: 0.6, w: 8.8, h: 0.8, fontSize: 28, bold: true });
  s2.addText('Browsers now run real PDF engines', { x: 0.8, y: 1.6, w: 8.4, h: 0.5, fontSize: 16, bullet: true });
  const s3 = pptx.addSlide();
  s3.addText('Thank you', { x: 0.6, y: 2.2, w: 8.8, h: 1, fontSize: 34, bold: true });
  await pptx.writeFile({ fileName: out('sample.pptx') });

  fs.writeFileSync(out('page.html'), '<!doctype html><html><head><title>Field report</title></head><body><h1>Field report</h1><p>Local HTML rendering check with <strong>markup</strong>.</p><table><tr><th>Metric</th><th>Value</th></tr><tr><td>Uptime</td><td>99.9%</td></tr></table></body></html>');
  fs.writeFileSync(out('malicious.html'), '<!doctype html><html><body onload="window.__pwned=true"><h1>Invoice</h1><script>window.__pwned=true</script><iframe src="https://evil.test/"></iframe><img src="https://evil.test/pixel.png" onerror="window.__pwned=true"><form action="https://evil.test"><input></form><a href="javascript:alert(1)">bad</a><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" alt="logo"><p>Legitimate paragraph</p></body></html>');
  fs.writeFileSync(out('note.md'), '# Release notes\n\n**Version 1.2** shipped with:\n\n- Local processing\n- Batch tools\n\n| Metric | Value |\n| --- | --- |\n| Uptime | 99.9% |\n');
  fs.writeFileSync(out('fake.pdf'), 'This is plain text pretending to be a PDF document.');
  fs.writeFileSync(out('server-error.html'), '<!doctype html><html><head><title>500</title></head><body><h1>Server error</h1></body></html>');

  // malicious docx: content types present, but a traversal entry and a duplicate
  const evilDocx = new JSZip();
  evilDocx.file('[Content_Types].xml', '<Types/>');
  evilDocx.file('word/document.xml', '<document/>');
  evilDocx.file('../escape.xml', 'x');
  fs.writeFileSync(out('evil-traversal.docx'), await evilDocx.generateAsync({ type: 'nodebuffer' }));

  // supported image and a fake image
  const W = 900;
  const H = 1200;
  const raw = Buffer.alloc((W * 3 + 1) * H, 255);
  for (let y = 0; y < H; y++) raw[y * (W * 3 + 1)] = 0;
  const bar = (y0, h, x0, x1) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x1; x++) {
      const i = y * (W * 3 + 1) + 1 + x * 3;
      raw[i] = 20; raw[i + 1] = 20; raw[i + 2] = 20;
    }
  };
  for (const [word, x, y, size] of [['PAPERLY', 80, 120, 64], ['SCAN', 620, 120, 64], ['Invoice', 80, 300, 48], ['4821', 520, 300, 48], ['Total', 80, 420, 48], ['1249.50', 520, 420, 48]]) {
    let cx = x;
    for (const ch of word) {
      if (ch !== ' ') bar(y, size, cx, cx + size * 0.6);
      cx += size * 0.78;
    }
  }
  const crc32 = (buf) => {
    let crc = 0xffffffff;
    for (const byte of buf) {
      crc ^= byte;
      for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  fs.writeFileSync(out('scan.png'), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  fs.writeFileSync(out('fake.png'), 'not actually a png');

  // image-only PDF (for OCR, extract-images and scan-style workflows)
  const scanDoc = await PDFDocument.create();
  const scanImage = await scanDoc.embedPng(fs.readFileSync(out('scan.png')));
  const scanPage = scanDoc.addPage([595.28, 841.89]);
  const scanScale = Math.min((595.28 - 30) / scanImage.width, (841.89 - 30) / scanImage.height);
  const scanW = scanImage.width * scanScale;
  const scanH = scanImage.height * scanScale;
  scanPage.drawImage(scanImage, { x: (595.28 - scanW) / 2, y: (841.89 - scanH) / 2, width: scanW, height: scanH });
  fs.writeFileSync(out('scan.pdf'), await scanDoc.save());

  // large document: 120 pages
  const large = await PDFDocument.create();
  const lf = await large.embedFont(StandardFonts.Helvetica);
  const lb = await large.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= 120; i++) {
    const p = large.addPage([595.28, 841.89]);
    p.drawText(`Large document — page ${i}`, { x: 50, y: 790, size: 15, font: lb });
    p.drawText('Generated to verify memory handling and page limits.', { x: 50, y: 760, size: 9, font: lf });
    for (let row = 0; row < 20; row++) p.drawText(`Row ${row + 1} · reference ${1000 + i * 10 + row} · quantity ${row + 1}`, { x: 50, y: 720 - row * 26, size: 9, font: lf });
    p.drawText(`Page ${i}`, { x: 50, y: 50, size: 8, font: lf });
  }
  fs.writeFileSync(out('large.pdf'), await large.save());
  console.log('fixtures ready →', fs.readdirSync(dir).sort().join(', '));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
