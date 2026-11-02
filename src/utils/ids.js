'use strict';

const crypto = require('node:crypto');

let lastMs = 0;
let seq = 0;

/** RFC 9562 UUIDv7: 48-bit unix ms timestamp + random; monotonic within a process. */
function uuidv7() {
  let ms = Date.now();
  if (ms <= lastMs) {
    seq = (seq + 1) & 0xfff;
    if (seq === 0) lastMs += 1;
    ms = lastMs;
  } else {
    lastMs = ms;
    seq = crypto.randomInt(0, 0x800);
  }
  const bytes = crypto.randomBytes(16);
  bytes[0] = (ms / 2 ** 40) & 0xff;
  bytes[1] = (ms / 2 ** 32) & 0xff;
  bytes[2] = (ms >>> 24) & 0xff;
  bytes[3] = (ms >>> 16) & 0xff;
  bytes[4] = (ms >>> 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = 0x70 | ((seq >>> 8) & 0x0f);
  bytes[7] = seq & 0xff;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

/** URL-safe random token with the given number of bytes of entropy. */
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

module.exports = { uuidv7, isUuid, randomToken, UUID_RE };
