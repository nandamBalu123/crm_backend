'use strict';

const crypto = require('node:crypto');
const env = require('../config/env');

const KEY = Buffer.from(env.ENCRYPTION_KEY, 'hex');

/** SHA-256 for high-entropy secrets (refresh tokens, API keys, one-time tokens). */
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const hmac = (secret, value) => crypto.createHmac('sha256', secret).update(value).digest('hex');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** AES-256-GCM authenticated encryption for secrets at rest (MFA seeds, integration credentials). */
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
}

function decrypt(payload) {
  const [version, iv, tag, data] = String(payload).split('.');
  if (version !== 'v1') throw new Error('Unsupported ciphertext version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

const encryptJson = (obj) => encrypt(JSON.stringify(obj));
const decryptJson = (payload) => (payload ? JSON.parse(decrypt(payload)) : {});

/** Compact signed token: base64url(json).hmac — used for download links, unsubscribe links, OAuth state. */
function signPayload(payload, ttlSeconds) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  return `${body}.${hmac(env.SIGNING_SECRET, body)}`;
}

function verifyPayload(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!safeEqual(sig, hmac(env.SIGNING_SECRET, body))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

module.exports = { sha256, hmac, safeEqual, encrypt, decrypt, encryptJson, decryptJson, signPayload, verifyPayload };
