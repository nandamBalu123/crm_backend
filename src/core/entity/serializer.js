'use strict';

const cf = require('../../modules/customFields/customFields.service');
const { fieldRules } = require('./policy');

const ALWAYS_STRIP = ['tenant_id', 'deleted_at'];

function userRef(u) {
  if (!u) return null;
  return { id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(' '), email: u.email, avatar_url: u.avatar_url || null };
}

/**
 * Converts a model instance to API JSON, removing internal columns, model
 * hidden attributes and any field the caller's role may not see.
 */
function serialize(def, record, ctx, customValues) {
  if (!record) return null;
  const plain = typeof record.get === 'function' ? { ...record.get({ plain: true }) } : { ...record };
  const { hidden } = fieldRules(def, ctx);
  for (const k of [...ALWAYS_STRIP, ...(def.model.options.hiddenAttributes || [])]) delete plain[k];
  for (const k of hidden) if (!k.startsWith('cf.')) delete plain[k];
  if ('owner' in plain || def.ownerField) plain.owner = userRef(plain.owner);
  for (const [key, value] of Object.entries(plain)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && 'tenant_id' in value) {
      const nested = { ...value };
      delete nested.tenant_id;
      delete nested.deleted_at;
      plain[key] = nested;
    }
  }
  if (def.customFields !== false) {
    const values = { ...(customValues || {}) };
    for (const k of hidden) if (k.startsWith('cf.')) delete values[k.slice(3)];
    plain.custom_fields = values;
  }
  if (def.decorate) def.decorate(plain, ctx);
  return plain;
}

async function serializeMany(def, records, ctx) {
  const values = def.customFields !== false ? await cf.loadValues(def.type, records.map((r) => r.id)) : new Map();
  return records.map((r) => serialize(def, r, ctx, values.get(r.id)));
}

module.exports = { serialize, serializeMany, userRef };
