'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const env = require('../config/env');
const { sign } = require('../integrations/aws/sigv4');

/**
 * Object storage abstraction. Keys are always prefixed with the tenant id
 * (tenants/<tenantId>/...) by callers; drivers additionally refuse keys that
 * escape the root. Drivers: local filesystem (default) and S3-compatible.
 */
const localDriver = {
  name: 'local',
  resolve(key) {
    const root = path.resolve(env.STORAGE_LOCAL_PATH);
    const full = path.resolve(root, key);
    if (!full.startsWith(root + path.sep)) throw new Error('Invalid storage key');
    return full;
  },
  async put(key, buffer) {
    const full = this.resolve(key);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, buffer, { mode: 0o600 });
  },
  async get(key) {
    return fs.createReadStream(this.resolve(key));
  },
  async getBuffer(key) {
    return fsp.readFile(this.resolve(key));
  },
  async remove(key) {
    await fsp.rm(this.resolve(key), { force: true });
  },
};

const s3Driver = {
  name: 's3',
  url(key) {
    return `${env.S3_ENDPOINT.replace(/\/$/, '')}/${env.S3_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;
  },
  async request(method, key, body) {
    const url = this.url(key);
    const headers = sign({ method, url, region: env.S3_REGION, accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY, body: body || '', headers: body ? { 'content-length': body.length } : {} });
    const res = await fetch(url, { method, headers, body });
    if (!res.ok && !(method === 'DELETE' && res.status === 404)) throw new Error(`S3 ${method} failed: HTTP ${res.status}`);
    return res;
  },
  async put(key, buffer) {
    await this.request('PUT', key, buffer);
  },
  async get(key) {
    const res = await this.request('GET', key);
    return Readable.fromWeb(res.body);
  },
  async getBuffer(key) {
    const res = await this.request('GET', key);
    return Buffer.from(await res.arrayBuffer());
  },
  async remove(key) {
    await this.request('DELETE', key);
  },
};

function driver(name = env.STORAGE_DRIVER) {
  if (name === 's3') {
    if (!env.S3_ENDPOINT || !env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY || !env.S3_REGION) {
      throw new Error('STORAGE_DRIVER=s3 requires S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY');
    }
    return s3Driver;
  }
  return localDriver;
}

module.exports = { driver };
