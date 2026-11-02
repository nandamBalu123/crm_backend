'use strict';

const crypto = require('node:crypto');

/** Minimal AWS Signature Version 4 signer for S3-compatible REST calls (no SDK dependency). */
const sha256hex = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function sign({ method, url, region, service = 's3', accessKeyId, secretAccessKey, headers = {}, body = '', now = new Date() }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = typeof body === 'string' || Buffer.isBuffer(body) ? sha256hex(body) : 'UNSIGNED-PAYLOAD';
  const h = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host: u.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
  const signedHeaders = Object.keys(h).sort();
  const canonicalQuery = [...u.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');
  const canonicalPath = u.pathname.split('/').map((seg) => enc(decodeURIComponent(seg))).join('/');
  const canonical = [method, canonicalPath, canonicalQuery, signedHeaders.map((k) => `${k}:${h[k]}`).join('\n') + '\n', signedHeaders.join(';'), payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}` };
}

module.exports = { sign };
