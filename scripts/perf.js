'use strict';

/**
 * Basic performance smoke test against a running API.
 *   PERF_BASE=http://localhost:4000 PERF_EMAIL=… PERF_PASSWORD=… npm run test:perf
 * Reports latency percentiles and throughput for key read endpoints.
 * Note: per-user rate limits (RATE_LIMIT_MAX) apply; raise them for larger runs.
 */
const BASE = process.env.PERF_BASE || 'http://localhost:4000';
const N = Number(process.env.PERF_REQUESTS || 100);
const C = Number(process.env.PERF_CONCURRENCY || 10);

async function login() {
  const res = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: process.env.PERF_ORIGIN || 'http://localhost:5173' }, body: JSON.stringify({ email: process.env.PERF_EMAIL, password: process.env.PERF_PASSWORD }) });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

async function bench(name, path, cookie) {
  const times = [];
  let errors = 0;
  let next = 0;
  const started = Date.now();
  await Promise.all(Array.from({ length: C }, async () => {
    while (next < N) {
      next += 1;
      const t = performance.now();
      const res = await fetch(`${BASE}/api/v1${path}`, { headers: { Cookie: cookie } });
      await res.arrayBuffer();
      times.push(performance.now() - t);
      if (!res.ok) errors += 1;
    }
  }));
  times.sort((a, b) => a - b);
  const p = (q) => times[Math.min(times.length - 1, Math.floor(q * times.length))].toFixed(1);
  console.log(`${name.padEnd(22)} n=${times.length} errors=${errors} p50=${p(0.5)}ms p95=${p(0.95)}ms p99=${p(0.99)}ms rps=${(times.length / ((Date.now() - started) / 1000)).toFixed(0)}`);
  return { errors, p95: Number(p(0.95)) };
}

(async () => {
  const cookie = await login();
  const results = [];
  results.push(await bench('leads list (filtered)', '/leads?page_size=25&sort=-score&filter[status][in]=new,contacted', cookie));
  results.push(await bench('opportunity board', '/opportunities/board', cookie));
  results.push(await bench('dashboard', '/reports/dashboard?preset=this_quarter', cookie));
  results.push(await bench('global search', '/search?q=an', cookie));
  const budget = Number(process.env.PERF_P95_BUDGET_MS || 500);
  const failed = results.filter((r) => r.errors || r.p95 > budget);
  if (failed.length) {
    console.error(`FAILED: ${failed.length} endpoint(s) had errors or p95 > ${budget}ms`);
    process.exit(1);
  }
  console.log(`OK: all endpoints within p95 budget of ${budget}ms`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
