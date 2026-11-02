'use strict';

/**
 * Declarative, side-effect-free condition evaluator used by workflows,
 * lead scoring and segments. Only whitelisted operators exist; there is no
 * expression language and no way to execute code.
 *
 * Condition group: { all: [cond|group...] } | { any: [cond|group...] }
 * Condition:       { field: 'status' | 'custom_fields.tier', op, value }
 */
const OPS = {
  eq: (a, b) => norm(a) === norm(b),
  ne: (a, b) => norm(a) !== norm(b),
  gt: (a, b) => num(a) > num(b),
  gte: (a, b) => num(a) >= num(b),
  lt: (a, b) => num(a) < num(b),
  lte: (a, b) => num(a) <= num(b),
  in: (a, b) => (Array.isArray(b) ? b.map(norm) : []).includes(norm(a)),
  not_in: (a, b) => !(Array.isArray(b) ? b.map(norm) : []).includes(norm(a)),
  contains: (a, b) => (Array.isArray(a) ? a.map(norm).includes(norm(b)) : String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase())),
  contains_any: (a, b) => (Array.isArray(b) ? b : [b]).some((x) => OPS.contains(a, x)),
  starts_with: (a, b) => String(a ?? '').toLowerCase().startsWith(String(b ?? '').toLowerCase()),
  is_empty: (a) => a === null || a === undefined || a === '' || (Array.isArray(a) && !a.length),
  is_not_empty: (a) => !OPS.is_empty(a),
  is_true: (a) => a === true || a === 1 || a === 'true',
  is_false: (a) => !OPS.is_true(a),
  changed: (_a, _b, ctx) => !!ctx?.changes && Object.prototype.hasOwnProperty.call(ctx.changes, ctx.field),
  changed_to: (a, b, ctx) => OPS.changed(a, b, ctx) && norm(a) === norm(b),
  older_than_days: (a, b) => !!a && Date.now() - new Date(a).getTime() > num(b) * 86400_000,
  within_next_days: (a, b) => !!a && new Date(a).getTime() - Date.now() <= num(b) * 86400_000 && new Date(a).getTime() >= Date.now() - 86400_000,
};

const OPERATORS = Object.keys(OPS);
const norm = (v) => (v === null || v === undefined ? null : typeof v === 'string' ? v.toLowerCase() : typeof v === 'number' ? String(v) : v instanceof Date ? v.toISOString() : String(v).toLowerCase());
const num = (v) => (v === null || v === undefined || v === '' ? Number.NaN : Number(v));

function getField(record, path) {
  if (!path || typeof path !== 'string' || path.length > 100) return undefined;
  const parts = path.split('.');
  if (parts.some((p) => p === '__proto__' || p === 'constructor' || p === 'prototype')) return undefined;
  let cur = record;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = Object.prototype.hasOwnProperty.call(cur, p) ? cur[p] : undefined;
  }
  return cur;
}

function evaluateCondition(cond, record, ctx = {}) {
  const fn = OPS[cond.op];
  if (!fn) throw new Error(`Unknown operator ${cond.op}`);
  return fn(getField(record, cond.field), cond.value, { ...ctx, field: cond.field });
}

function evaluate(group, record, ctx = {}, depth = 0) {
  if (!group || (Array.isArray(group.all) && !group.all.length && !group.any)) return true;
  if (depth > 5) throw new Error('Condition nesting too deep');
  const check = (c) => (c.all || c.any ? evaluate(c, record, ctx, depth + 1) : evaluateCondition(c, record, ctx));
  if (Array.isArray(group.all)) return group.all.every(check);
  if (Array.isArray(group.any)) return group.any.length === 0 || group.any.some(check);
  return check(group);
}

module.exports = { evaluate, evaluateCondition, getField, OPERATORS };
