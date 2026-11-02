'use strict';

const { Op } = require('sequelize');
const E = require('../../errors/AppError');

/**
 * Record-level access policy. Converts a granted scope into a WHERE fragment:
 *   own  → records owned by the caller
 *   team → records owned by any member of the caller's teams
 *   all  → no restriction (still tenant scoped by the data layer)
 * Entities may override via def.scopeWhere (e.g. activities also match creator).
 */
function scopeWhere(def, ctx, scope) {
  if (!def.ownerField || scope === 'all') return {};
  if (def.scopeWhere) return def.scopeWhere(ctx, scope);
  if (scope === 'team') return { [def.ownerField]: { [Op.in]: ctx.teamUserIds || [ctx.userId] } };
  if (scope === 'own') return { [def.ownerField]: ctx.userId };
  throw E.forbidden();
}

/** True if the record falls inside the scope (used for in-memory checks after load). */
function inScope(def, ctx, scope, record) {
  if (!def.ownerField || scope === 'all') return true;
  const owner = record[def.ownerField];
  if (def.inScope) return def.inScope(ctx, scope, record);
  if (scope === 'team') return (ctx.teamUserIds || [ctx.userId]).includes(owner);
  return owner === ctx.userId;
}

/** Field-level permissions for an entity: { hidden: Set, readOnly: Set } */
function fieldRules(def, ctx) {
  const rules = ctx.fieldAccess?.[def.type] || {};
  const hidden = new Set();
  const readOnly = new Set();
  for (const [field, access] of Object.entries(rules)) {
    if (access === 'hidden') hidden.add(field);
    readOnly.add(field);
  }
  return { hidden, readOnly };
}

/** Rejects writes to fields the caller may not edit (standard and custom fields). */
function assertWritableFields(def, ctx, data) {
  const { readOnly } = fieldRules(def, ctx);
  const blocked = Object.keys(data).filter((k) => readOnly.has(k));
  if (blocked.length) {
    throw new E.AppError(403, 'FIELD_READ_ONLY', 'You do not have permission to edit some fields', blocked.map((f) => ({ path: f, message: 'Read-only for your role' })));
  }
}

module.exports = { scopeWhere, inScope, fieldRules, assertWritableFields };
