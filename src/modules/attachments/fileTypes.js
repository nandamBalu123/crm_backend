'use strict';

/**
 * Upload allow-list verified by content (magic bytes), not by the client's
 * Content-Type. Active content types (HTML, SVG, scripts, executables) are
 * never accepted.
 */
const TYPES = [
  { ext: ['pdf'], mime: 'application/pdf', match: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { ext: ['png'], mime: 'image/png', match: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: ['jpg', 'jpeg'], mime: 'image/jpeg', match: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: ['gif'], mime: 'image/gif', match: (b) => ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')) },
  { ext: ['webp'], mime: 'image/webp', match: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { ext: ['docx'], mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', match: isZip },
  { ext: ['xlsx'], mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', match: isZip },
  { ext: ['pptx'], mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', match: isZip },
  { ext: ['csv'], mime: 'text/csv', match: isText },
  { ext: ['txt'], mime: 'text/plain', match: isText },
];

function isZip(b) {
  return b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

function isText(b) {
  const sample = b.subarray(0, 8192);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, sample.length - 4 > 0 ? sample.length - 4 : sample.length));
  } catch {
    return false;
  }
  return !/<\s*(script|html|svg|iframe)/i.test(sample.toString('utf8'));
}

function detect(filename, buffer) {
  const ext = String(filename).toLowerCase().split('.').pop();
  const type = TYPES.find((t) => t.ext.includes(ext));
  if (!type || !type.match(buffer)) return null;
  return type.mime;
}

/** Strips path components and control characters; keeps a safe display filename. */
function safeFilename(name) {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const base = String(name || 'file').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '_').trim();
  return (base || 'file').slice(0, 200);
}

const ALLOWED_EXTENSIONS = TYPES.flatMap((t) => t.ext);

module.exports = { detect, safeFilename, ALLOWED_EXTENSIONS };
