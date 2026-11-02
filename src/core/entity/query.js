'use strict';

const { Op } = require('sequelize');
const cf = require('../../modules/customFields/customFields.service');
const { UUID_RE } = require('../../utils/ids');
const E = require('../../errors/AppError');

const MAX_PAGE_SIZE = 100;

const OPS_BY_TYPE = {
  string: ['eq', 'ne', 'in', 'contains', 'starts_with', 'is_empty', 'is_not_empty'],
  enum: ['eq', 'ne', 'in', 'is_empty', 'is_not_empty'],
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty'],
  date: ['eq', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty'],
  uuid: ['eq', 'ne', 'in', 'is_empty', 'is_not_empty'],
  bool: ['eq'],
};

const escapeLike = (s) => String(s).replace(/[%_\\]/g, '\\$&');

function coerce(type, raw, ctx, path) {
  const fail = (msg) => {
    throw E.validation([{ location: 'query', path, message: msg }]);
  };
  if (type === 'uuid') {
    if (raw === 'me') return ctx.userId;
    if (!UUID_RE.test(String(raw))) fail('Must be an id');
    return String(raw);
  }
  if (type === 'number') {
    if (!/^-?\d{1,14}(\.\d{1,6})?$/.test(String(raw))) fail('Must be a number');
    return String(raw);
  }
  if (type === 'date') {
    const s = String(raw);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) fail('Must be a date');
    return d;
  }
  if (type === 'bool') {
    if (!['true', 'false', true, false].includes(raw)) fail('Must be true or false');
    return raw === true || raw === 'true';
  }
  const str = String(raw);
  if (str.length > 255) fail('Value too long');
  return str;
}

function buildCondition(field, type, op, raw, ctx, enumValues) {
  const path = `filter.${field}`;
  if (!OPS_BY_TYPE[type].includes(op)) throw E.validation([{ location: 'query', path, message: `Operator ${op} not supported` }]);
  if (op === 'is_empty') return { [field]: { [Op.is]: null } };
  if (op === 'is_not_empty') return { [field]: { [Op.not]: null } };
  if (op === 'in') {
    const list = (Array.isArray(raw) ? raw : String(raw).split(',')).filter((v) => v !== '').slice(0, 100).map((v) => coerce(type, v, ctx, path));
    if (enumValues) list.forEach((v) => { if (!enumValues.includes(v)) throw E.validation([{ location: 'query', path, message: `Invalid value ${v}` }]); });
    return { [field]: { [Op.in]: list } };
  }
  const value = coerce(type, raw, ctx, path);
  if (enumValues && !enumValues.includes(value)) throw E.validation([{ location: 'query', path, message: `Invalid value ${value}` }]);
  switch (op) {
    case 'eq': return { [field]: value };
    case 'ne': return { [field]: { [Op.ne]: value } };
    case 'gt': return { [field]: { [Op.gt]: value } };
    case 'gte': return { [field]: { [Op.gte]: value } };
    case 'lt': return { [field]: { [Op.lt]: value } };
    case 'lte': return { [field]: { [Op.lte]: value } };
    case 'contains': return { [field]: { [Op.like]: `%${escapeLike(value)}%` } };
    case 'starts_with': return { [field]: { [Op.like]: `${escapeLike(value)}%` } };
    default: throw E.validation([{ location: 'query', path, message: 'Invalid operator' }]);
  }
}

/** Translates a `filters` object ({ field: value | { op: value } }) into Sequelize WHERE conditions. */
function buildFilterWhere(def, filters, ctx) {
  const and = [];
  const hidden = ctx.fieldAccess?.[def.type] || {};
  for (const [field, spec] of Object.entries(filters || {})) {
    const type = def.filterable[field];
    if (!type) throw E.validation([{ location: 'query', path: `filter.${field}`, message: 'Unknown filter field' }]);
    if (hidden[field] === 'hidden') throw E.forbidden(`You cannot filter by ${field}`, 'FIELD_HIDDEN');
    const enumValues = type === 'enum' ? def.model.rawAttributes[field]?.values : null;
    const ops = typeof spec === 'object' && spec !== null && !Array.isArray(spec) ? spec : { [Array.isArray(spec) ? 'in' : 'eq']: spec };
    for (const [op, raw] of Object.entries(ops)) and.push(buildCondition(field, type, op, raw, ctx, enumValues));
  }
  return and;
}

/**
 * Parses list query params into a safe Sequelize query:
 *   page, page_size (≤100), sort (comma list, '-' prefix desc, 'cf.key' allowed),
 *   q (search), filter[field][op]=value, cf[key][op]=value
 * Every field is checked against the entity whitelist.
 */
async function parseListQuery(def, query, ctx) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(query.page_size, 10) || 25));
  const and = buildFilterWhere(def, query.filter, ctx);

  if (query.q) {
    const q = String(query.q).trim().slice(0, 100);
    if (q) {
      const or = def.searchFields.map((f) => ({ [f]: { [Op.like]: `%${escapeLike(q)}%` } }));
      const cfSearch = await cf.buildSearch(def.type, def.model.name, q);
      if (cfSearch) or.push(cfSearch);
      and.push({ [Op.or]: or });
    }
  }
  if (query.cf) and.push(...(await cf.buildFilters(def.type, def.model.name, query.cf)));

  const order = [];
  const sortSpec = String(query.sort || def.defaultSort || '-created_at').split(',').slice(0, 3);
  for (const s of sortSpec) {
    const desc = s.startsWith('-');
    const field = desc ? s.slice(1) : s;
    if (field.startsWith('cf.')) order.push([await cf.buildSort(def.type, def.model.name, field.slice(3)), desc ? 'DESC' : 'ASC']);
    else if (def.sortable.includes(field)) order.push([field, desc ? 'DESC' : 'ASC']);
    else throw E.validation([{ location: 'query', path: 'sort', message: `Cannot sort by ${field}` }]);
  }
  order.push(['id', 'DESC']); // deterministic pagination
  return { where: and.length ? { [Op.and]: and } : {}, order, limit: pageSize, offset: (page - 1) * pageSize, page, pageSize };
}

module.exports = { parseListQuery, buildFilterWhere, MAX_PAGE_SIZE, OPS_BY_TYPE };
