'use strict';

const { entityRouter } = require('../../core/entity/routes');
const service = require('../../core/entity/service');
const { sequelize } = require('../../models');
const { z, idParams, uuid, decimalString } = require('../../utils/schemas');
const conversion = require('./conversion.service');
const { ok } = require('../../utils/http');
const def = require('./leads.entity');

const convertBody = z.strictObject({
  create_account: z.boolean().optional(),
  account_id: uuid().optional(),
  account_name: z.string().trim().max(200).optional(),
  contact_id: uuid().optional(),
  create_opportunity: z.boolean().optional(),
  owner_id: uuid().optional(),
  opportunity: z.strictObject({
    name: z.string().trim().max(200).optional(),
    amount: decimalString({ min: 0 }).optional(),
    currency: z.string().length(3).optional(),
    pipeline_id: uuid().optional(),
    stage_id: uuid().optional(),
    expected_close_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).optional(),
});

module.exports = entityRouter(def, {
  extend(r) {
    r.get('/duplicates', {
      summary: 'Find possible duplicate leads and existing contacts', permission: 'leads:read',
      query: z.object({ email: z.string().max(254).optional(), phone: z.string().max(40).optional(), company: z.string().max(200).optional(), exclude_id: uuid().optional() }),
    }, async (req, res) => ok(res, await conversion.duplicates({ ...req.valid.query, excludeId: req.valid.query.exclude_id })));
    r.post('/:id/convert', { summary: 'Convert a lead into contact / account / opportunity', permission: 'leads:convert', params: idParams, body: convertBody }, async (req, res) => {
      const updateScope = req.ctx.permissions.get('leads:update');
      return ok(res, await conversion.convert(req.valid.params.id, req.valid.body, updateScope || 'own'));
    });
    r.post('/:id/assign', {
      summary: 'Assign or reassign a lead', permission: 'leads:assign', params: idParams,
      body: z.strictObject({ owner_id: uuid(), reason: z.string().max(255).optional() }),
    }, async (req, res) => {
      const scope = req.scope;
      await sequelize.transaction((t) => service.updateRecord(def, req.valid.params.id, { owner_id: req.valid.body.owner_id }, scope, { transaction: t, reason: req.valid.body.reason }));
      return ok(res, await service.get(def, req.valid.params.id, 'all'));
    });
  },
});
