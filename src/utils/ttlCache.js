'use strict';

/** Tiny in-process TTL cache (per API instance). Keys must include the tenant id when data is tenant-specific. */
class TtlCache {
  constructor(ttlMs, max = 5000) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key, value) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
    return value;
  }
  delete(key) {
    this.map.delete(key);
  }
  deletePrefix(prefix) {
    for (const k of this.map.keys()) if (k.startsWith(prefix)) this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

module.exports = { TtlCache };
