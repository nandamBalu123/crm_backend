'use strict';

const { z, optionalText, optionalEmail, optionalUrl, decimalString, uuid } = require('../../utils/schemas');

const customFields = () => z.record(z.string().max(64), z.any()).optional();
const ref = () => uuid().nullish();
const address = () => ({
  address_line1: optionalText(200), address_line2: optionalText(200), city: optionalText(120),
  state: optionalText(120), postal_code: optionalText(30), country: optionalText(80),
});
const money = () => decimalString({ min: 0 }).nullish();
const int = (min = 0, max = 10_000_000) => z.coerce.number().int().min(min).max(max).nullish();
const dateTime = () => z.union([z.string().datetime({ offset: true }), z.string().datetime(), z.null()]).optional().transform((v) => (v ? new Date(v) : v));
const date = () => z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'), z.null()]).optional();

/** Update schema = all create fields optional (strict) + optimistic-lock version. */
function toUpdate(createShape) {
  const partial = Object.fromEntries(Object.entries(createShape).map(([k, s]) => [k, s.optional()]));
  return z.strictObject({ ...partial, version: z.coerce.number().int().min(0).optional() });
}

module.exports = { z, customFields, ref, address, money, int, dateTime, date, optionalText, optionalEmail, optionalUrl, toUpdate, uuid };
