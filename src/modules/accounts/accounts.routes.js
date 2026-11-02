'use strict';

const { entityRouter } = require('../../core/entity/routes');
const service = require('../../core/entity/service');
const { loadRelated } = require('../../core/entity/related');
const { serializeMany } = require('../../core/entity/serializer');
const { z, idParams, uuid } = require('../../utils/schemas');
const mergeService = require('./merge.service');
const { ok } = require('../../utils/http');
const { getContext } = require('../../context/requestContext');
const def = require('./accounts.entity');

const mergeBody = z.strictObject({ primary_id: uuid(), duplicate_ids: z.array(uuid()).min(1).max(10) });

module.exports = entityRouter(def, {
  extend(r) {
    r.get('/duplicates', {
      summary: 'Find possible duplicate accounts', permission: 'accounts:read',
      query: z.object({ name: z.string().max(200).optional(), domain: z.string().max(253).optional(), email: z.string().max(254).optional(), exclude_id: uuid().optional() }),
    }, async (req, res) => {
      const rows = await mergeService.findDuplicates('account', { ...req.valid.query, excludeId: req.valid.query.exclude_id });
      return ok(res, await serializeMany(def, rows, getContext()));
    });
    r.post('/merge', { summary: 'Merge duplicate accounts into a primary account', permission: 'accounts:merge', body: mergeBody }, async (req, res) => {
      const primary = await mergeService.merge('account', req.valid.body, service.findScoped, def);
      return ok(res, await service.get(def, primary.id, 'all'));
    });
    r.get('/:id/related', { summary: 'Related contacts, deals, tickets, quotes and child accounts (360° view)', permission: 'accounts:read', params: idParams }, async (req, res) => {
      const id = req.valid.params.id;
      await service.findScoped(def, id, req.scope);
      const reg = require('../../core/entity/registry');
      return ok(res, await loadRelated([
        { key: 'contacts', def: reg.contact, where: { account_id: id } },
        { key: 'opportunities', def: reg.opportunity, where: { account_id: id } },
        { key: 'tickets', def: reg.ticket, where: { account_id: id } },
        { key: 'quotes', def: reg.quote, where: { account_id: id } },
        { key: 'child_accounts', def, where: { parent_account_id: id } },
      ]));
    });
  },
});
