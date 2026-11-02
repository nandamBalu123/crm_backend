'use strict';

const { Op } = require('sequelize');
const { entityRouter } = require('../../core/entity/routes');
const service = require('../../core/entity/service');
const { scopeWhere } = require('../../core/entity/policy');
const { serializeMany } = require('../../core/entity/serializer');
const { z, idParams } = require('../../utils/schemas');
const { ok } = require('../../utils/http');
const { getContext } = require('../../context/requestContext');
const def = require('./activities.entity');

module.exports = entityRouter(def, {
  extend(r) {
    r.get('/calendar', {
      summary: 'Activities in a date range (calendar view)', permission: 'activities:read',
      query: z.object({ from: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)), to: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)), owner_id: z.string().optional() }),
    }, async (req, res) => {
      const ctx = getContext();
      const from = new Date(req.valid.query.from);
      const to = new Date(req.valid.query.to);
      if (to - from > 93 * 86400_000) return ok(res, []);
      const range = { [Op.between]: [from, to] };
      const rows = await def.model.findAll({
        where: { [Op.and]: [scopeWhere(def, ctx, req.scope), { [Op.or]: [{ start_at: range }, { due_at: range }] }, req.valid.query.owner_id ? { owner_id: req.valid.query.owner_id === 'me' ? ctx.userId : req.valid.query.owner_id } : {}] },
        order: [['start_at', 'ASC'], ['due_at', 'ASC']],
        limit: 1000,
        include: def.listInclude(),
      });
      return ok(res, await serializeMany(def, rows, ctx));
    });
    r.post('/:id/complete', { summary: 'Mark an activity complete (schedules next recurrence)', permission: 'activities:update', params: idParams, body: z.strictObject({ outcome: z.string().max(80).optional() }).optional() }, async (req, res) => {
      const data = { status: 'completed', ...(req.valid.body?.outcome ? { call_outcome: req.valid.body.outcome } : {}) };
      return ok(res, await service.update(def, req.valid.params.id, data, req.scope));
    });
  },
});
