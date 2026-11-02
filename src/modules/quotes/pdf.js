'use strict';

const PDFDocument = require('pdfkit');

const fmt = (amount, currency, locale) => {
  try {
    return new Intl.NumberFormat(locale || 'en-US', { style: 'currency', currency }).format(Number(amount));
  } catch {
    return `${currency} ${amount}`;
  }
};

/** Streams a quote/proposal PDF. Values come from the stored, server-calculated quote. */
function renderQuotePdf(res, { quote, lines, tenant, settings, template, account, contact }) {
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Quote Q-${quote.number}`, Author: tenant.name } });
  const accent = template?.accent_color || settings?.branding?.primary_color || '#4f46e5';
  const cur = quote.currency;
  const loc = settings?.locale;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Q-${quote.number}-rev${quote.revision}.pdf"`);
  doc.pipe(res);

  doc.rect(0, 0, doc.page.width, 8).fill(accent);
  doc.fillColor('#1b1f3b').fontSize(20).text(settings?.branding?.display_name || tenant.name, 48, 40);
  doc.fontSize(10).fillColor('#5b6078').text(`Quote Q-${quote.number}${quote.revision > 1 ? ` (revision ${quote.revision})` : ''}`, { align: 'right' });
  doc.text(`Date: ${new Date(quote.created_at).toISOString().slice(0, 10)}`, { align: 'right' });
  if (quote.valid_until) doc.text(`Valid until: ${quote.valid_until}`, { align: 'right' });
  doc.moveDown();
  doc.fillColor('#1b1f3b').fontSize(14).text(quote.title);
  if (template?.header_text) doc.moveDown(0.5).fontSize(10).fillColor('#454a64').text(template.header_text);
  doc.moveDown();
  if (account || contact) {
    doc.fontSize(10).fillColor('#8a8fa8').text('Prepared for');
    doc.fillColor('#1b1f3b').text([account?.name, contact ? `${contact.first_name} ${contact.last_name}`.trim() : null, contact?.email].filter(Boolean).join('\n'));
    doc.moveDown();
  }

  const cols = [48, 260, 320, 400, 450];
  const header = (y) => {
    doc.rect(48, y - 4, doc.page.width - 96, 20).fill('#f1f2f8');
    doc.fillColor('#454a64').fontSize(9);
    ['Item', 'Qty', 'Unit price', 'Disc.', 'Total'].forEach((h, i) => doc.text(h, cols[i] + 2, y, { width: i === 0 ? 200 : 80, align: i === 0 ? 'left' : 'right' }));
  };
  let y = doc.y + 6;
  header(y);
  y += 24;
  doc.fontSize(9).fillColor('#1b1f3b');
  for (const l of lines) {
    if (y > doc.page.height - 160) {
      doc.addPage();
      y = 60;
      header(y);
      y += 24;
    }
    doc.fillColor('#1b1f3b').text(l.name, cols[0] + 2, y, { width: 200 });
    const h = Math.max(doc.heightOfString(l.name, { width: 200 }), 12);
    doc.text(Number(l.quantity).toString(), cols[1], y, { width: 80, align: 'right' });
    doc.text(fmt(l.unit_price, cur, loc), cols[2], y, { width: 80, align: 'right' });
    doc.text(`${Number(l.discount_percent)}%`, cols[3], y, { width: 50, align: 'right' });
    doc.text(fmt(l.line_total, cur, loc), cols[4], y, { width: 95, align: 'right' });
    y += h + 8;
  }
  y += 10;
  for (const [label, value, bold] of [['Subtotal', quote.subtotal], ['Discount', `-${quote.discount_total}`], ['Tax', quote.tax_total], ['Total', quote.total, true]]) {
    doc.fontSize(bold ? 12 : 10).fillColor(bold ? accent : '#454a64').text(label, 330, y, { width: 100, align: 'right' });
    doc.text(fmt(String(value).replace('--', ''), cur, loc), 440, y, { width: 105, align: 'right' });
    y += bold ? 20 : 16;
  }
  const terms = quote.terms || template?.terms;
  if (terms) {
    doc.moveDown(2).fontSize(10).fillColor('#1b1f3b').text('Terms', 48);
    doc.fontSize(9).fillColor('#454a64').text(terms, { width: doc.page.width - 96 });
  }
  if (template?.footer_text) doc.moveDown().fontSize(8).fillColor('#8a8fa8').text(template.footer_text, { align: 'center' });
  doc.end();
}

module.exports = { renderQuotePdf };
