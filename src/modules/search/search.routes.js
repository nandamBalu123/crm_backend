'use strict';

const { Op } = require('sequelize');
const { createRouter } = require('../../utils/router');
const { z } = require('../../utils/schemas');
const registry = require('../../core/entity/registry');
const { scopeWhere } = require('../../core/entity/policy');
const { scopeFor } = require('../../middleware/authorize');
const { getContext } = require('../../context/requestContext');
const { ok } = require('../../utils/http');

const TYPES = ['lead', 'contact', 'account', 'opportunity', 'ticket', 'quote', 'product', 'campaign'];
const r = createRouter({ prefix: '/api/v1/search', tag: 'Search' });

/** Global search across modules the caller can read, honouring record scopes. */
r.get('/', { summary: 'Global search', query: z.object({ q: z.string().trim().min(2).max(100), types: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(20).optional() }) }, async (req, res) => {
  const ctx = getContext();
  const { q, limit = 5 } = req.valid.query;
  const wanted = req.valid.query.types ? req.valid.query.types.split(',').filter((t) => TYPES.includes(t)) : TYPES;
  const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
  const groups = await Promise.all(wanted.map(async (type) => {
    const def = registry.get(type);
    const scope = scopeFor(ctx, `${def.module}:read`);
    if (!scope) return null;
    const hidden = ctx.fieldAccess?.[type] || {};
    const fields = def.searchFields.filter((f) => hidden[f] !== 'hidden');
    const rows = await def.model.findAll({ where: { [Op.and]: [scopeWhere(def, ctx, scope), { [Op.or]: fields.map((f) => ({ [f]: { [Op.like]: like } })) }] }, limit, order: [['updated_at', 'DESC']] });
    return { type, label: def.plural, items: rows.map((x) => ({ id: x.id, title: def.title(x), subtitle: x.email || x.company || x.status || null, url: `/${def.route}/${x.id}` })) };
  }));
  return ok(res, groups.filter((g) => g && g.items.length));
});

module.exports = r;
