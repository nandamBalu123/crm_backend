'use strict';

const { Op } = require('sequelize');
const { sequelize, CustomFieldDefinition, CustomFieldValue, Membership, Attachment } = require('../../models');
const { TYPES } = require('./fieldTypes');
const { getContext } = require('../../context/requestContext');
const { TtlCache } = require('../../utils/ttlCache');
const E = require('../../errors/AppError');

const defsCache = new TtlCache(30_000);

function invalidateDefinitions(tenantId) {
  defsCache.deletePrefix(`${tenantId}:`);
}

/** Active definitions for an entity type, ordered for forms. */
async function getDefinitions(entityType, { includeInactive = false } = {}) {
  const tenantId = getContext().tenantId;
  const key = `${tenantId}:${entityType}:${includeInactive}`;
  const hit = defsCache.get(key);
  if (hit) return hit;
  const where = { entity_type: entityType, archived_at: null, ...(includeInactive ? {} : { is_active: true }) };
  const defs = await CustomFieldDefinition.findAll({ where, order: [['display_order', 'ASC'], ['created_at', 'ASC']] });
  return defsCache.set(key, defs.map((d) => d.get({ plain: true })));
}

function isEmpty(v) {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

/**
 * Validates untrusted custom-field input against the tenant's definitions.
 * Returns the normalised map { key: value|null }. Unknown keys are rejected.
 */
async function validateValues(entityType, input, { mode = 'create', fieldAccess = {} } = {}) {
  const defs = await getDefinitions(entityType);
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const errors = [];
  const out = {};
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};

  for (const key of Object.keys(raw)) {
    if (!byKey.has(key)) errors.push({ path: `custom_fields.${key}`, message: 'Unknown custom field' });
    const access = fieldAccess[`cf.${key}`];
    if (access) errors.push({ path: `custom_fields.${key}`, message: 'You cannot edit this field', code: 'FIELD_READ_ONLY' });
  }
  const userRefs = [];
  const fileRefs = [];
  for (const def of defs) {
    const provided = Object.prototype.hasOwnProperty.call(raw, def.key);
    let value = provided ? raw[def.key] : undefined;
    if (!provided && mode === 'create' && !isEmpty(def.default_value)) value = def.default_value;
    if (isEmpty(value)) {
      if (def.is_required && (mode === 'create' || provided)) errors.push({ path: `custom_fields.${def.key}`, message: `${def.label} is required` });
      else if (provided) out[def.key] = null;
      continue;
    }
    const result = TYPES[def.field_type].validate(value, def);
    if (result.error) errors.push({ path: `custom_fields.${def.key}`, message: result.error });
    else {
      out[def.key] = result.value;
      if (def.field_type === 'user') userRefs.push([def.key, result.value]);
      if (def.field_type === 'file') fileRefs.push([def.key, result.value]);
    }
  }
  if (userRefs.length) {
    const ids = userRefs.map(([, id]) => id);
    const found = new Set((await Membership.findAll({ where: { user_id: ids, status: 'active' }, attributes: ['user_id'] })).map((m) => m.user_id));
    for (const [key, id] of userRefs) if (!found.has(id)) errors.push({ path: `custom_fields.${key}`, message: 'User is not a member of this workspace' });
  }
  if (fileRefs.length) {
    const ids = fileRefs.map(([, id]) => id);
    const found = new Set((await Attachment.findAll({ where: { id: ids }, attributes: ['id'] })).map((a) => a.id));
    for (const [key, id] of fileRefs) if (!found.has(id)) errors.push({ path: `custom_fields.${key}`, message: 'File not found' });
  }
  if (errors.length) throw E.validation(errors);
  return out;
}

function toRows(def, entityType, entityId, value) {
  const type = TYPES[def.field_type];
  const values = type.multi ? value : [value];
  return values.map((v, ordinal) => {
    const row = { entity_type: entityType, entity_id: entityId, field_id: def.id, ordinal };
    if (type.column === 'value_date') row.value_date = new Date(def.field_type === 'date' ? `${v}T00:00:00.000Z` : v);
    else row[type.column] = v;
    return row;
  });
}

/** Persists normalised values (replace semantics per field). Must run inside the record's transaction. */
async function saveValues(entityType, entityId, values, { transaction } = {}) {
  const keys = Object.keys(values || {});
  if (!keys.length) return;
  const defs = (await getDefinitions(entityType)).filter((d) => keys.includes(d.key));
  const fieldIds = defs.map((d) => d.id);
  await CustomFieldValue.destroy({ where: { entity_id: entityId, field_id: fieldIds }, transaction });
  const rows = defs.flatMap((def) => (isEmpty(values[def.key]) ? [] : toRows(def, entityType, entityId, values[def.key])));
  if (rows.length) await CustomFieldValue.bulkCreate(rows, { transaction });
}

function fromRow(def, row) {
  const type = TYPES[def.field_type];
  switch (type.column) {
    case 'value_number':
      return row.value_number === null ? null : def.field_type === 'integer' ? String(Math.trunc(Number(row.value_number))) : String(Number(row.value_number));
    case 'value_date':
      if (!row.value_date) return null;
      return def.field_type === 'date' ? new Date(row.value_date).toISOString().slice(0, 10) : new Date(row.value_date).toISOString();
    case 'value_bool':
      return row.value_bool === null ? null : !!row.value_bool;
    default:
      return row[type.column];
  }
}

/** Loads values for many records in one query (no N+1). Returns Map<entityId, {key: value}>. */
async function loadValues(entityType, entityIds) {
  const result = new Map(entityIds.map((id) => [id, {}]));
  if (!entityIds.length) return result;
  const defs = await getDefinitions(entityType);
  if (!defs.length) return result;
  const byId = new Map(defs.map((d) => [d.id, d]));
  const rows = await CustomFieldValue.findAll({
    where: { entity_id: entityIds, field_id: [...byId.keys()] },
    order: [['ordinal', 'ASC']],
    attributes: ['entity_id', 'field_id', 'ordinal', 'value_string', 'value_text', 'value_number', 'value_date', 'value_bool'],
  });
  for (const row of rows) {
    const def = byId.get(row.field_id);
    const bag = result.get(row.entity_id);
    if (!bag) continue;
    const v = fromRow(def, row);
    if (TYPES[def.field_type].multi) (bag[def.key] = bag[def.key] || []).push(v);
    else bag[def.key] = v;
  }
  return result;
}

async function deleteValuesFor(entityId, { transaction } = {}) {
  await CustomFieldValue.destroy({ where: { entity_id: entityId }, transaction });
}

// ---------- query helpers (filters / sorting / search) ----------

const SQL_OPS = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

function cfValueLiteral(def, value) {
  const col = TYPES[def.field_type].column;
  if (col === 'value_date') return sequelize.escape(new Date(def.field_type === 'date' ? `${value}T00:00:00.000Z` : value));
  if (col === 'value_bool') return value === true || value === 'true' ? '1' : '0';
  if (col === 'value_number') {
    if (!/^-?\d{1,14}(\.\d{1,6})?$/.test(String(value))) throw E.validation([{ path: `cf.${def.key}`, message: 'Must be a number' }]);
    return String(value);
  }
  return sequelize.escape(String(value));
}

/**
 * Builds `id IN (subquery)` predicates for custom-field filters. tenant_id is
 * always bound explicitly because literals bypass the model hooks.
 */
async function buildFilters(entityType, tableAlias, cfFilters) {
  if (!cfFilters || !Object.keys(cfFilters).length) return [];
  const defs = await getDefinitions(entityType);
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const tenant = sequelize.escape(getContext().tenantId);
  const preds = [];
  for (const [key, spec] of Object.entries(cfFilters)) {
    const def = byKey.get(key);
    if (!def || !def.is_filterable) throw E.validation([{ path: `cf.${key}`, message: 'Unknown or non-filterable custom field' }]);
    const type = TYPES[def.field_type];
    const col = type.column;
    const ops = typeof spec === 'object' && spec !== null && !Array.isArray(spec) ? spec : { eq: spec };
    for (const [op, raw] of Object.entries(ops)) {
      if (!type.ops.includes(op)) throw E.validation([{ path: `cf.${key}`, message: `Operator ${op} not supported for this field` }]);
      const base = `SELECT cfv.entity_id FROM custom_field_values cfv WHERE cfv.tenant_id = ${tenant} AND cfv.field_id = ${sequelize.escape(def.id)}`;
      const id = `\`${tableAlias}\`.\`id\``;
      let pred;
      if (op === 'is_empty') pred = `${id} NOT IN (${base})`;
      else if (op === 'is_not_empty') pred = `${id} IN (${base})`;
      else if (op === 'in' || (op === 'contains' && type.multi)) {
        const list = (Array.isArray(raw) ? raw : String(raw).split(',')).slice(0, 100).map((v) => cfValueLiteral(def, v));
        pred = `${id} IN (${base} AND cfv.${col} IN (${list.join(',')}))`;
      } else if (op === 'contains') pred = `${id} IN (${base} AND cfv.${col} LIKE ${sequelize.escape(`%${String(raw).replace(/[%_\\]/g, '\\$&')}%`)})`;
      else if (op === 'starts_with') pred = `${id} IN (${base} AND cfv.${col} LIKE ${sequelize.escape(`${String(raw).replace(/[%_\\]/g, '\\$&')}%`)})`;
      else pred = `${id} IN (${base} AND cfv.${col} ${SQL_OPS[op]} ${cfValueLiteral(def, raw)})`;
      preds.push(sequelize.literal(pred));
    }
  }
  return preds;
}

async function buildSearch(entityType, tableAlias, q) {
  const defs = (await getDefinitions(entityType)).filter((d) => d.is_searchable && TYPES[d.field_type].column === 'value_string');
  if (!defs.length) return null;
  const tenant = sequelize.escape(getContext().tenantId);
  const ids = defs.map((d) => sequelize.escape(d.id)).join(',');
  const like = sequelize.escape(`%${String(q).replace(/[%_\\]/g, '\\$&')}%`);
  return sequelize.literal(`\`${tableAlias}\`.\`id\` IN (SELECT cfv.entity_id FROM custom_field_values cfv WHERE cfv.tenant_id = ${tenant} AND cfv.field_id IN (${ids}) AND cfv.value_string LIKE ${like})`);
}

async function buildSort(entityType, tableAlias, key) {
  const def = (await getDefinitions(entityType)).find((d) => d.key === key);
  if (!def || TYPES[def.field_type].multi) throw E.validation([{ path: 'sort', message: `Cannot sort by custom field ${key}` }]);
  const col = TYPES[def.field_type].column;
  if (col === 'value_text') throw E.validation([{ path: 'sort', message: 'Cannot sort by long text fields' }]);
  const tenant = sequelize.escape(getContext().tenantId);
  return sequelize.literal(`(SELECT cfv.${col} FROM custom_field_values cfv WHERE cfv.tenant_id = ${tenant} AND cfv.field_id = ${sequelize.escape(def.id)} AND cfv.entity_id = \`${tableAlias}\`.\`id\` AND cfv.ordinal = 0 LIMIT 1)`);
}

module.exports = {
  getDefinitions, invalidateDefinitions, validateValues, saveValues, loadValues, deleteValuesFor, buildFilters, buildSearch, buildSort, isEmpty, Op,
};
