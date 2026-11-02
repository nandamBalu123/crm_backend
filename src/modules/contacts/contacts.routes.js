'use strict';

const { entityRouter } = require('../../core/entity/routes');
const service = require('../../core/entity/service');
const { loadRelated } = require('../../core/entity/related');
const { serializeMany } = require('../../core/entity/serializer');
const { z, idParams, uuid } = require('../../utils/schemas');
const mergeService = require('../accounts/merge.service');
const { Consent, Lead } = require('../../models');
const { ok } = require('../../utils/http');
const { getContext } = require('../../context/requestContext');
const def = require('./contacts.entity');

const mergeBody = z.strictObject({ primary_id: uuid(), duplicate_ids: z.array(uuid()).min(1).max(10) });

module.exports = entityRouter(def, {
  extend(r) {
    r.get('/duplicates', {
      summary: 'Find possible duplicate contacts (and matching leads)', permission: 'contacts:read',
      query: z.object({ email: z.string().max(254).optional(), phone: z.string().max(40).optional(), exclude_id: uuid().optional() }),
    }, async (req, res) => {
      const { email, phone, exclude_id: excludeId } = req.valid.query;
      const contacts = await mergeService.findDuplicates('contact', { email, phone, excludeId });
      const leads = email || phone ? await Lead.findAll({ where: { ...(email ? { email } : { phone }), status: ['new', 'contacted', 'nurturing', 'qualified'] }, limit: 10, attributes: ['id', 'first_name', 'last_name', 'email', 'company', 'status'] }) : [];
      return ok(res, { contacts: await serializeMany(def, contacts, getContext()), leads });
    });
    r.post('/merge', { summary: 'Merge duplicate contacts into a primary contact', permission: 'contacts:merge', body: mergeBody }, async (req, res) => {
      const primary = await mergeService.merge('contact', req.valid.body, service.findScoped, def);
      return ok(res, await service.get(def, primary.id, 'all'));
    });
    r.get('/:id/related', { summary: 'Related deals, tickets, quotes and activities (360° view)', permission: 'contacts:read', params: idParams }, async (req, res) => {
      const id = req.valid.params.id;
      await service.findScoped(def, id, req.scope);
      const reg = require('../../core/entity/registry');
      return ok(res, await loadRelated([
        { key: 'opportunities', def: reg.opportunity, where: { contact_id: id } },
        { key: 'tickets', def: reg.ticket, where: { contact_id: id } },
        { key: 'quotes', def: reg.quote, where: { contact_id: id } },
        { key: 'open_activities', def: reg.activity, where: { contact_id: id, status: 'open' }, order: [['due_at', 'ASC']] },
      ]));
    });
    r.get('/:id/consents', { summary: 'Consent history', permission: 'contacts:read', params: idParams }, async (req, res) => {
      await service.findScoped(def, req.valid.params.id, req.scope);
      return ok(res, await Consent.findAll({ where: { subject_type: 'contact', subject_id: req.valid.params.id }, order: [['created_at', 'DESC']], limit: 100 }));
    });
  },
});
