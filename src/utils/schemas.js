'use strict';

const { z } = require('zod');
const { UUID_RE } = require('./ids');

const uuid = () => z.string().regex(UUID_RE, 'Must be a valid id');
const idParams = z.object({ id: uuid() });
const trimmed = (max = 255) => z.string().trim().max(max);
const optionalText = (max = 255) => trimmed(max).nullish().transform((v) => (v === '' ? null : v));
const requiredText = (max = 255) => trimmed(max).min(1, 'Required');
const email = () => z.string().trim().toLowerCase().max(254).email('Must be a valid email');
const optionalEmail = () => z.union([email(), z.literal(''), z.null()]).optional().transform((v) => (v === '' ? null : v));
const httpUrl = () => z.string().trim().max(1000).url().refine((v) => /^https?:\/\//i.test(v), 'Must be an http(s) URL');
const optionalUrl = () => z.union([httpUrl(), z.literal(''), z.null()]).optional().transform((v) => (v === '' ? null : v));
const decimalString = (opts = {}) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine((v) => /^-?\d{1,14}(\.\d{1,4})?$/.test(v), 'Must be a decimal number')
    .refine((v) => (opts.min === undefined ? true : Number(v) >= opts.min), `Must be ≥ ${opts.min}`)
    .refine((v) => (opts.max === undefined ? true : Number(v) <= opts.max), `Must be ≤ ${opts.max}`);
const isoDate = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');
const isoDateTime = () => z.string().datetime({ offset: true }).or(z.string().datetime());
const nullable = (schema) => schema.nullish();

const password = (min = 10) =>
  z
    .string()
    .min(min, `Password must be at least ${min} characters`)
    .max(128, 'Password must be at most 128 characters')
    .refine((v) => !COMMON_PASSWORDS.has(v.toLowerCase()), 'This password is too common');

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '123456789', '1234567890', 'qwertyuiop', '1q2w3e4r5t', 'iloveyou12', 'password12',
  'welcome123', 'admin12345', 'letmein123', 'qwerty1234', 'abc1234567', 'sunshine12', 'princess12', 'football12', 'monkey1234',
  'passw0rd123', 'changeme123', 'trustno1234', 'baseball12', 'superman12', 'dragon1234', 'master1234', '11111111111', '0000000000',
]);

module.exports = {
  z, uuid, idParams, trimmed, optionalText, requiredText, email, optionalEmail, httpUrl, optionalUrl, decimalString, isoDate,
  isoDateTime, nullable, password,
};
