'use strict';

/**
 * Fixed-point decimal arithmetic on BigInt with 6 fractional digits of
 * working precision. All monetary calculations happen server-side through
 * these helpers; results are rounded half-up (away from zero) to 2 dp for
 * amounts and 4 dp for unit prices/quantities when persisted.
 */
const SCALE = 6;
const FACTOR = 10n ** BigInt(SCALE);

function toFixedBig(value) {
  if (value === null || value === undefined || value === '') return 0n;
  if (typeof value === 'bigint') return value;
  const str = typeof value === 'number' ? value.toFixed(SCALE) : String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(str)) throw new Error(`Invalid decimal: ${value}`);
  const neg = str.startsWith('-');
  const [intPart, fracPart = ''] = str.replace('-', '').split('.');
  const frac = (fracPart + '0'.repeat(SCALE)).slice(0, SCALE);
  // round using the next digit beyond working precision
  let big = BigInt(intPart) * FACTOR + BigInt(frac);
  if (fracPart.length > SCALE && Number(fracPart[SCALE]) >= 5) big += 1n;
  return neg ? -big : big;
}

function round(big, dp) {
  const div = 10n ** BigInt(SCALE - dp);
  const neg = big < 0n;
  const abs = neg ? -big : big;
  let q = abs / div;
  if ((abs % div) * 2n >= div) q += 1n;
  return (neg ? -q : q) * div;
}

function toString(big, dp = 2) {
  const r = round(big, dp);
  const neg = r < 0n;
  const abs = neg ? -r : r;
  const intPart = abs / FACTOR;
  const frac = (abs % FACTOR).toString().padStart(SCALE, '0').slice(0, dp);
  return `${neg ? '-' : ''}${intPart}${dp > 0 ? `.${frac}` : ''}`;
}

const add = (...vals) => vals.reduce((acc, v) => acc + v, 0n);
const sub = (a, b) => a - b;
/** Integer division rounding half away from zero. */
function divRound(n, d) {
  const neg = (n < 0n) !== (d < 0n);
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  let q = an / ad;
  if ((an % ad) * 2n >= ad) q += 1n;
  return neg ? -q : q;
}
const mul = (a, b) => divRound(a * b, FACTOR);
/** percentage of an amount: amount * pct / 100 */
const pct = (amount, percent) => divRound(amount * percent, 100n * FACTOR);

function cmp(a, b) {
  return a === b ? 0 : a > b ? 1 : -1;
}

module.exports = { toFixedBig, toString, round, add, sub, mul, pct, cmp, SCALE };
