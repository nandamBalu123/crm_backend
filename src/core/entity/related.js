'use strict';

const { Op } = require('sequelize');
const { scopeFor } = require('../../middleware/authorize');
const { scopeWhere } = require('./policy');
const { serializeMany } = require('./serializer');
const { getContext } = require('../../context/requestContext');

/**
 * Loads related records for 360° views, applying the caller's read permission
 * and record scope for each related module. Modules the caller cannot read
 * are reported as { allowed: false } instead of leaking data.
 */
async function loadRelated(specs) {
  const ctx = getContext();
  const out = {};
  await Promise.all(
    specs.map(async ({ key, def, where, limit = 25, order = [['created_at', 'DESC']] }) => {
      const scope = scopeFor(ctx, `${def.module}:read`);
      if (!scope) {
        out[key] = { allowed: false, items: [], total: 0 };
        return;
      }
      const full = { [Op.and]: [where, scopeWhere(def, ctx, scope)] };
      const { rows, count } = await def.model.findAndCountAll({ where: full, order, limit, include: def.listInclude ? def.listInclude() : [], distinct: true });
      out[key] = { allowed: true, items: await serializeMany(def, rows, ctx), total: count };
    })
  );
  return out;
}

module.exports = { loadRelated };
