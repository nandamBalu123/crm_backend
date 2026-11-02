'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const env = require('../config/env');
const E = require('../errors/AppError');

/**
 * SSRF-hardened outbound HTTP for user-supplied URLs (webhooks, integration
 * endpoints): https only (http allowed only when OUTBOUND_ALLOW_HTTP), no
 * credentials in URL, DNS resolved and every address checked against
 * private/loopback/link-local/metadata ranges, redirects not followed,
 * strict timeout and response size cap.
 */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224 || (a === 198 && (b === 18 || b === 19));
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('ff');
}

async function assertSafeUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw E.validation([{ path: 'url', message: 'Invalid URL' }]);
  }
  if (url.protocol !== 'https:' && !(env.OUTBOUND_ALLOW_HTTP && url.protocol === 'http:')) throw E.validation([{ path: 'url', message: 'Only https URLs are allowed' }]);
  if (url.username || url.password) throw E.validation([{ path: 'url', message: 'Credentials in URLs are not allowed' }]);
  if (url.port && !['443', '80', '8443', ''].includes(url.port) && !env.OUTBOUND_ALLOW_PRIVATE_NETWORKS) throw E.validation([{ path: 'url', message: 'Port not allowed' }]);
  if (env.OUTBOUND_ALLOW_PRIVATE_NETWORKS) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (['localhost', 'metadata.google.internal'].includes(host.toLowerCase()) || host.endsWith('.internal') || host.endsWith('.local')) {
    throw E.validation([{ path: 'url', message: 'This host is not allowed' }]);
  }
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw E.validation([{ path: 'url', message: 'Host could not be resolved' }]);
  if (addresses.some((a) => isPrivateIp(a.address))) throw E.validation([{ path: 'url', message: 'Private or internal network addresses are not allowed' }]);
  return url;
}

async function safeFetch(rawUrl, { timeoutMs = 10_000, maxBytes = 1_000_000, ...init } = {}) {
  const url = await assertSafeUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxBytes) throw new Error('Response too large');
    return res;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { safeFetch, assertSafeUrl, isPrivateIp };

/** For non-HTTP outbound connections (e.g. tenant-supplied SMTP hosts). */
async function assertPublicHost(host) {
  if (env.OUTBOUND_ALLOW_PRIVATE_NETWORKS) return;
  const h = String(host).replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(h)) throw E.validation([{ path: 'host', message: 'This host is not allowed' }]);
  const addresses = net.isIP(h) ? [{ address: h }] : await dns.lookup(h, { all: true }).catch(() => []);
  if (!addresses.length) throw E.validation([{ path: 'host', message: 'Host could not be resolved' }]);
  if (addresses.some((a) => isPrivateIp(a.address))) throw E.validation([{ path: 'host', message: 'Private or internal network addresses are not allowed' }]);
}

module.exports.assertPublicHost = assertPublicHost;
