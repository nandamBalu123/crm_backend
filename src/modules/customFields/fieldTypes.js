'use strict';

const { UUID_RE } = require('../../utils/ids');

/**
 * Custom field type system. Each type declares:
 *  - column: the typed storage column in custom_field_values
 *  - validate(value, def) → { value } | { error }   (value already normalised)
 *  - ops: filter operators allowed for list queries
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9 ().-]{5,30}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_RE = /^-?\d{1,14}(\.\d{1,6})?$/;

const STRING_OPS = ['eq', 'ne', 'in', 'contains', 'starts_with', 'is_empty', 'is_not_empty'];
const NUMBER_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty'];
const DATE_OPS = ['eq', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty'];

function lengthCheck(str, v, defaultMax) {
  const max = Math.min(Number(v.max_length) || defaultMax, defaultMax);
  if (str.length > max) return `Must be at most ${max} characters`;
  if (v.min_length && str.length < Number(v.min_length)) return `Must be at least ${v.min_length} characters`;
  return null;
}

function rangeCheck(num, v) {
  if (v.min !== undefined && v.min !== null && num < Number(v.min)) return `Must be ≥ ${v.min}`;
  if (v.max !== undefined && v.max !== null && num > Number(v.max)) return `Must be ≤ ${v.max}`;
  return null;
}

function stringType(defaultMax, pattern, patternMessage) {
  return {
    column: defaultMax > 255 ? 'value_text' : 'value_string',
    ops: STRING_OPS,
    validate(value, def) {
      if (typeof value !== 'string' && typeof value !== 'number') return { error: 'Must be text' };
      const str = String(value).trim();
      const err = lengthCheck(str, def.validation || {}, defaultMax);
      if (err) return { error: err };
      if (pattern && str && !pattern.test(str)) return { error: patternMessage };
      return { value: str };
    },
  };
}

function numberType({ integer = false, percent = false } = {}) {
  return {
    column: 'value_number',
    ops: NUMBER_OPS,
    validate(value, def) {
      const str = String(value).trim();
      if (!DECIMAL_RE.test(str)) return { error: 'Must be a number' };
      if (integer && !/^-?\d+$/.test(str)) return { error: 'Must be a whole number' };
      const num = Number(str);
      const v = { ...(percent ? { min: 0, max: 100 } : {}), ...(def.validation || {}) };
      const err = rangeCheck(num, v);
      if (err) return { error: err };
      return { value: str };
    },
  };
}

const TYPES = {
  text: stringType(255),
  textarea: stringType(10000),
  email: stringType(254, EMAIL_RE, 'Must be a valid email'),
  phone: stringType(40, PHONE_RE, 'Must be a valid phone number'),
  url: stringType(255, /^https?:\/\/[^\s]+$/i, 'Must be an http(s) URL'),
  integer: numberType({ integer: true }),
  decimal: numberType(),
  currency: numberType(),
  percent: numberType({ percent: true }),
  boolean: {
    column: 'value_bool',
    ops: ['eq'],
    validate(value) {
      if (typeof value === 'boolean') return { value };
      if (value === 'true' || value === 'false') return { value: value === 'true' };
      return { error: 'Must be true or false' };
    },
  },
  date: {
    column: 'value_date',
    ops: DATE_OPS,
    validate(value, def) {
      if (typeof value !== 'string' || !DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) return { error: 'Must be a valid date (YYYY-MM-DD)' };
      const v = def.validation || {};
      if (v.min && value < v.min) return { error: `Must be on or after ${v.min}` };
      if (v.max && value > v.max) return { error: `Must be on or before ${v.max}` };
      return { value };
    },
  },
  datetime: {
    column: 'value_date',
    ops: DATE_OPS,
    validate(value) {
      const d = typeof value === 'string' ? new Date(value) : null;
      if (!d || Number.isNaN(d.getTime())) return { error: 'Must be a date and time (ISO 8601)' };
      return { value: d.toISOString() };
    },
  },
  select: {
    column: 'value_string',
    ops: ['eq', 'ne', 'in', 'is_empty', 'is_not_empty'],
    validate(value, def) {
      const allowed = (def.options || []).filter((o) => o.is_active !== false).map((o) => o.value);
      if (!allowed.includes(value)) return { error: 'Not an allowed option' };
      return { value };
    },
  },
  multiselect: {
    column: 'value_string',
    multi: true,
    ops: ['in', 'contains', 'is_empty', 'is_not_empty'],
    validate(value, def) {
      if (!Array.isArray(value)) return { error: 'Must be a list of options' };
      const allowed = new Set((def.options || []).filter((o) => o.is_active !== false).map((o) => o.value));
      const unique = [...new Set(value)];
      if (unique.length > 50) return { error: 'Too many options selected' };
      if (unique.some((x) => !allowed.has(x))) return { error: 'Contains an option that is not allowed' };
      const v = def.validation || {};
      if (v.max_items && unique.length > Number(v.max_items)) return { error: `Select at most ${v.max_items}` };
      return { value: unique };
    },
  },
  user: {
    column: 'value_string',
    ops: ['eq', 'ne', 'in', 'is_empty', 'is_not_empty'],
    reference: 'user',
    validate(value) {
      if (typeof value !== 'string' || !UUID_RE.test(value)) return { error: 'Must be a user id' };
      return { value };
    },
  },
  file: {
    column: 'value_string',
    ops: ['is_empty', 'is_not_empty'],
    reference: 'attachment',
    validate(value) {
      if (typeof value !== 'string' || !UUID_RE.test(value)) return { error: 'Must be a file id' };
      return { value };
    },
  },
};

const FIELD_TYPES = Object.keys(TYPES);

module.exports = { TYPES, FIELD_TYPES };
