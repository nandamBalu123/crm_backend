'use strict';


const { createRouter } = require('../../utils/router');
const { z, idParams, requiredText, trimmed } = require('../../utils/schemas');
const { sequelize, CustomFieldDefinition, CustomFieldValue } = require('../../models');
const { TYPES, FIELD_TYPES } = require('./fieldTypes');
const cf = require('./customFields.service');
const registry = require('../../core/entity/registry');
const audit = require('../audit/audit.service');
const { assertLimit } = require('../billing/entitlements.service');
const { getContext } = require('../../context/requestContext');
const { ok, created, noContent } = require('../../utils/http');
const E = require('../../errors/AppError');

const r = createRouter({ prefix: '/api/v1/custom-fields', tag: 'Custom fields' });

const option = z.strictObject({ value: z.string().trim().min(1).max(100), label: z.string().trim().min(1).max(120), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), is_active: z.boolean().optional() });
const validation = z.strictObject({
  min: z.union([z.number(), z.string()]).nullish(),
  max: z.union([z.number(), z.string()]).nullish(),
  min_length: z.coerce.number().int().min(0).max(10000).nullish(),
  max_length: z.coerce.number().int().min(1).max(10000).nullish(),
  max_items: z.coerce.number().int().min(1).max(50).nullish(),
});
const base = {
  label: requiredText(120),
  description: trimmed(500).nullish(),
  placeholder: trimmed(200).nullish(),
  section: trimmed(80).nullish(),
  is_required: z.boolean().optional(),
  default_value: z.any().optional(),
  validation: validation.optional(),
  options: z.array(option).max(200).optional(),
  display_order: z.coerce.number().int().min(0).max(10000).optional(),
  is_active: z.boolean().optional(),
  is_searchable: z.boolean().optional(),
  is_filterable: z.boolean().optional(),
  show_in_list: z.boolean().optional(),
};
const createBody = z.strictObject({
  entity_type: z.enum(registry.CUSTOM_FIELD_ENTITIES),
  key: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, 'Lowercase letters, digits and underscores; must start with a letter').optional(),
  field_type: z.enum(FIELD_TYPES),
  ...base,
});
const updateBody = z.strictObject({ ...Object.fromEntries(Object.entries(base).map(([k, s]) => [k, s.optional()])), version: z.number().int().optional() });

function keyFromLabel(label) {
  const k = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);
  return /^[a-z]/.test(k) ? k : `f_${k}`;
}

/** Treats definitions as untrusted input: validates options, rules and default against the type. */
function validateDefinition(def) {
  const errors = [];
  const type = TYPES[def.field_type];
  if (['select', 'multiselect'].includes(def.field_type)) {
    if (!def.options?.length) errors.push({ path: 'options', message: 'Select fields need at least one option' });
    const values = (def.options || []).map((o) => o.value);
    if (new Set(values).size !== values.length) errors.push({ path: 'options', message: 'Option values must be unique' });
  } else if (def.options?.length) errors.push({ path: 'options', message: 'Options are only allowed for select fields' });
  const v = def.validation || {};
  if (v.min !== null && v.min !== undefined && v.max !== null && v.max !== undefined && Number(v.min) > Number(v.max)) errors.push({ path: 'validation.min', message: 'min must be ≤ max' });
  if (v.min_length && v.max_length && v.min_length > v.max_length) errors.push({ path: 'validation.min_length', message: 'min_length must be ≤ max_length' });
  if (def.is_searchable && type.column !== 'value_string') errors.push({ path: 'is_searchable', message: 'Only short text-like fields can be searchable' });
  if (def.default_value !== undefined && def.default_value !== null && def.default_value !== '') {
    const res = type.validate(def.default_value, def);
    if (res.error) errors.push({ path: 'default_value', message: `Default value invalid: ${res.error}` });
  }
  if (errors.length) throw E.validation(errors);
}

const present = (d) => {
  const plain = d.get ? { ...d.get({ plain: true }) } : { ...d };
  delete plain.tenant_id;
  return plain;
};

r.get('/', { summary: 'List custom field definitions', query: z.object({ entity_type: z.enum(registry.CUSTOM_FIELD_ENTITIES).optional(), include_inactive: z.enum(['true', 'false']).optional() }) }, async (req, res) => {
  const where = { archived_at: null };
  if (req.valid.query.entity_type) where.entity_type = req.valid.query.entity_type;
  if (req.valid.query.include_inactive !== 'true') where.is_active = true;
  const ctx = getContext();
  const rows = await CustomFieldDefinition.findAll({ where, order: [['entity_type', 'ASC'], ['display_order', 'ASC'], ['created_at', 'ASC']] });
  // Hide definitions of fields the caller's role cannot see.
  const visible = rows.filter((d) => ctx.fieldAccess?.[d.entity_type]?.[`cf.${d.key}`] !== 'hidden');
  return ok(res, visible.map(present));
});

r.post('/', { summary: 'Create a custom field', permission: 'custom_fields:manage', body: createBody }, async (req, res) => {
  const ctx = getContext();
  const body = { ...req.valid.body };
  body.key = body.key || keyFromLabel(body.label);
  const def = registry.get(body.entity_type);
  if (def.model.rawAttributes[body.key]) throw E.validation([{ path: 'key', message: 'This key is reserved by a standard field' }]);
  validateDefinition(body);
  const count = await CustomFieldDefinition.count({ where: { entity_type: body.entity_type, archived_at: null } });
  await assertLimit('custom_fields_per_entity', count);
  const exists = await CustomFieldDefinition.findOne({ where: { entity_type: body.entity_type, key: body.key } });
  if (exists) throw E.conflict(`A field with key "${body.key}" already exists${exists.archived_at ? ' (archived)' : ''}`, 'DUPLICATE');
  const row = await sequelize.transaction(async (transaction) => {
    const d = await CustomFieldDefinition.create({ ...body, display_order: body.display_order ?? count, created_by_user_id: ctx.userId }, { transaction });
    await audit.record({ action: 'custom_field.created', entityType: 'custom_field', entityId: d.id, summary: `Custom field ${body.label} (${body.entity_type}) created`, metadata: { field_type: body.field_type, key: body.key } }, { transaction });
    return d;
  });
  cf.invalidateDefinitions(ctx.tenantId);
  return created(res, present(row));
});

r.patch('/:id', { summary: 'Update a custom field (type and key are immutable)', permission: 'custom_fields:manage', params: idParams, body: updateBody }, async (req, res) => {
  const ctx = getContext();
  const row = await sequelize.transaction(async (transaction) => {
    const d = await CustomFieldDefinition.findOne({ where: { id: req.valid.params.id, archived_at: null }, transaction, lock: transaction.LOCK.UPDATE });
    if (!d) throw E.notFound('Custom field');
    const { version, ...changes } = req.valid.body;
    if (version !== undefined && version !== d.version) throw E.conflict('Field was changed by someone else', 'VERSION_CONFLICT');
    const merged = { ...d.get({ plain: true }), ...changes };
    if (changes.options && ['select', 'multiselect'].includes(d.field_type)) {
      // Removing an option that is in use would orphan data: keep it, inactive.
      const kept = new Set(changes.options.map((o) => o.value));
      const removed = (d.options || []).filter((o) => !kept.has(o.value));
      for (const o of removed) {
        const used = await CustomFieldValue.count({ where: { field_id: d.id, value_string: o.value }, transaction });
        if (used) changes.options.push({ ...o, is_active: false });
      }
      merged.options = changes.options;
    }
    validateDefinition(merged);
    const before = { ...d.get({ plain: true }) };
    await d.update(changes, { transaction });
    await audit.record({ action: 'custom_field.updated', entityType: 'custom_field', entityId: d.id, summary: `Custom field ${d.label} updated`, changes: audit.diff(before, d.get({ plain: true }), Object.keys(changes)) }, { transaction });
    return d;
  });
  cf.invalidateDefinitions(ctx.tenantId);
  return ok(res, present(row));
});

r.put('/reorder', {
  summary: 'Set the display order of fields for an entity', permission: 'custom_fields:manage',
  body: z.strictObject({ entity_type: z.enum(registry.CUSTOM_FIELD_ENTITIES), ids: z.array(z.string()).max(500) }),
}, async (req, res) => {
  const ctx = getContext();
  await sequelize.transaction(async (transaction) => {
    for (const [i, id] of req.valid.body.ids.entries()) {
      await CustomFieldDefinition.update({ display_order: i }, { where: { id, entity_type: req.valid.body.entity_type }, transaction });
    }
  });
  cf.invalidateDefinitions(ctx.tenantId);
  return ok(res, { reordered: req.valid.body.ids.length });
});

r.delete('/:id', {
  summary: 'Archive a custom field (values retained) or purge it with its values', permission: 'custom_fields:manage', params: idParams,
  query: z.object({ purge: z.enum(['true', 'false']).optional() }),
}, async (req, res) => {
  const ctx = getContext();
  await sequelize.transaction(async (transaction) => {
    const d = await CustomFieldDefinition.findOne({ where: { id: req.valid.params.id }, transaction });
    if (!d) throw E.notFound('Custom field');
    if (req.valid.query.purge === 'true') {
      const removed = await CustomFieldValue.destroy({ where: { field_id: d.id }, transaction });
      await d.destroy({ transaction });
      await audit.record({ action: 'custom_field.purged', entityType: 'custom_field', entityId: d.id, summary: `Custom field ${d.label} and ${removed} value(s) permanently deleted` }, { transaction });
    } else {
      await d.update({ is_active: false, archived_at: new Date(), key: `${d.key.slice(0, 40)}__archived_${Date.now().toString(36)}`.slice(0, 64) }, { transaction });
      await audit.record({ action: 'custom_field.archived', entityType: 'custom_field', entityId: d.id, summary: `Custom field ${d.label} archived (values retained)` }, { transaction });
    }
  });
  cf.invalidateDefinitions(ctx.tenantId);
  return noContent(res);
});

r.get('/types', { summary: 'Supported field types and operators' }, (_req, res) =>
  ok(res, FIELD_TYPES.map((t) => ({ type: t, operators: TYPES[t].ops, storage: TYPES[t].column, multi: !!TYPES[t].multi }))));

module.exports = r;
