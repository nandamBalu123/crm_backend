'use strict';

const { Op, fn, col } = require('sequelize');
const { entityRouter } = require('../../core/entity/routes');
const service = require('../../core/entity/service');
const { buildFilterWhere } = require('../../core/entity/query');
const cf = require('../customFields/customFields.service');
const registry = require('../../core/entity/registry');
const { sequelize, CampaignMember, Lead, Contact, Opportunity, Segment } = require('../../models');
const { z, idParams, uuid, requiredText, trimmed } = require('../../utils/schemas');
const audit = require('../audit/audit.service');
const { getContext } = require('../../context/requestContext');
const { ok, created, noContent } = require('../../utils/http');
const E = require('../../errors/AppError');
const def = require('./campaigns.entity');

/** Resolves a segment definition (same filter grammar as list views) to a WHERE clause. */
async function segmentWhere(entityType, filters) {
  const entityDef = registry.get(entityType);
  const ctx = getContext();
  const and = buildFilterWhere(entityDef, filters?.filter || {}, ctx);
  and.push(...(await cf.buildFilters(entityType, entityDef.model.name, filters?.cf || {})));
  if (entityType === 'contact') and.push({ email_opt_out: false });
  if (entityType === 'lead') and.push({ email_opt_out: false, status: { [Op.ne]: 'converted' } });
  return { entityDef, where: { [Op.and]: and } };
}

const segmentBody = z.strictObject({
  name: requiredText(120), entity_type: z.enum(['lead', 'contact']), description: trimmed(500).nullish(),
  filters: z.strictObject({ filter: z.record(z.string(), z.any()).optional(), cf: z.record(z.string(), z.any()).optional() }),
});

module.exports = entityRouter(def, {
  extend(r) {
    // ----- segments -----
    r.get('/segments', { summary: 'List segments', permission: 'campaigns:read' }, async (_req, res) => ok(res, await Segment.findAll({ order: [['name', 'ASC']] })));
    r.post('/segments', { summary: 'Create a segment', permission: 'campaigns:create', body: segmentBody }, async (req, res) => {
      await segmentWhere(req.valid.body.entity_type, req.valid.body.filters); // validates the filter definition
      const s = await Segment.create({ ...req.valid.body, created_by_user_id: getContext().userId });
      return created(res, s);
    });
    r.get('/segments/:id/preview', { summary: 'Preview segment members (count + first 25)', permission: 'campaigns:read', params: idParams }, async (req, res) => {
      const s = await Segment.findByPk(req.valid.params.id);
      if (!s) throw E.notFound('Segment');
      const { entityDef, where } = await segmentWhere(s.entity_type, s.filters);
      const { rows, count } = await entityDef.model.findAndCountAll({ where, limit: 25, order: [['created_at', 'DESC']] });
      return ok(res, { count, sample: rows.map((x) => ({ id: x.id, name: entityDef.title(x), email: x.email })) });
    });
    r.delete('/segments/:id', { summary: 'Delete a segment', permission: 'campaigns:delete', params: idParams }, async (req, res) => {
      if (!(await Segment.destroy({ where: { id: req.valid.params.id } }))) throw E.notFound('Segment');
      return noContent(res);
    });

    // ----- members -----
    r.get('/:id/members', { summary: 'Campaign members', permission: 'campaigns:read', params: idParams, query: z.object({ page: z.coerce.number().int().min(1).optional() }) }, async (req, res) => {
      await service.findScoped(def, req.valid.params.id, 'all');
      const page = req.valid.query.page || 1;
      const { rows, count } = await CampaignMember.findAndCountAll({
        where: { campaign_id: req.valid.params.id }, limit: 50, offset: (page - 1) * 50, order: [['created_at', 'DESC']],
        include: [{ model: Lead, as: 'lead', attributes: ['id', 'first_name', 'last_name', 'email', 'company', 'status'] }, { model: Contact, as: 'contact', attributes: ['id', 'first_name', 'last_name', 'email'] }],
      });
      return ok(res, rows, { page, page_size: 50, total: count, total_pages: Math.ceil(count / 50) });
    });
    r.post('/:id/members', {
      summary: 'Add leads/contacts (explicit ids or a whole segment) to a campaign', permission: 'campaigns:update', params: idParams,
      body: z.strictObject({ lead_ids: z.array(uuid()).max(1000).optional(), contact_ids: z.array(uuid()).max(1000).optional(), segment_id: uuid().optional() }),
    }, async (req, res) => {
      const campaignId = req.valid.params.id;
      await service.findScoped(def, campaignId, 'all');
      let { lead_ids: leadIds = [], contact_ids: contactIds = [] } = req.valid.body;
      if (req.valid.body.segment_id) {
        const s = await Segment.findByPk(req.valid.body.segment_id);
        if (!s) throw E.validation([{ path: 'segment_id', message: 'Segment not found' }]);
        const { entityDef, where } = await segmentWhere(s.entity_type, s.filters);
        const ids = (await entityDef.model.findAll({ where, attributes: ['id'], limit: 10000 })).map((x) => x.id);
        if (s.entity_type === 'lead') leadIds = [...leadIds, ...ids];
        else contactIds = [...contactIds, ...ids];
      }
      const [leads, contacts] = await Promise.all([
        leadIds.length ? Lead.findAll({ where: { id: leadIds }, attributes: ['id'] }) : [],
        contactIds.length ? Contact.findAll({ where: { id: contactIds }, attributes: ['id'] }) : [],
      ]);
      const existing = await CampaignMember.findAll({ where: { campaign_id: campaignId }, attributes: ['lead_id', 'contact_id'] });
      const haveLead = new Set(existing.map((m) => m.lead_id).filter(Boolean));
      const haveContact = new Set(existing.map((m) => m.contact_id).filter(Boolean));
      const rows = [
        ...leads.filter((l) => !haveLead.has(l.id)).map((l) => ({ campaign_id: campaignId, lead_id: l.id })),
        ...contacts.filter((c) => !haveContact.has(c.id)).map((c) => ({ campaign_id: campaignId, contact_id: c.id })),
      ];
      await sequelize.transaction(async (transaction) => {
        for (let i = 0; i < rows.length; i += 500) await CampaignMember.bulkCreate(rows.slice(i, i + 500), { transaction });
        await audit.record({ action: 'campaign.members_added', entityType: 'campaign', entityId: campaignId, metadata: { added: rows.length } }, { transaction });
      });
      return ok(res, { added: rows.length, skipped: leadIds.length + contactIds.length - rows.length });
    });
    r.delete('/:id/members/:memberId', { summary: 'Remove a campaign member', permission: 'campaigns:update', params: z.object({ id: uuid(), memberId: uuid() }) }, async (req, res) => {
      if (!(await CampaignMember.destroy({ where: { id: req.valid.params.memberId, campaign_id: req.valid.params.id } }))) throw E.notFound('Member');
      return noContent(res);
    });

    // ----- attribution -----
    r.get('/:id/performance', { summary: 'Campaign attribution: leads, conversions, pipeline and won revenue', permission: 'campaigns:read', params: idParams }, async (req, res) => {
      const c = await service.findScoped(def, req.valid.params.id, 'all');
      const [leadStats, oppStats, members] = await Promise.all([
        Lead.findAll({ where: { campaign_id: c.id }, attributes: ['status', [fn('COUNT', col('id')), 'n']], group: ['status'], raw: true }),
        Opportunity.findAll({ where: { campaign_id: c.id }, attributes: ['status', [fn('COUNT', col('id')), 'n'], [fn('SUM', col('amount')), 'amount']], group: ['status'], raw: true }),
        CampaignMember.findAll({ where: { campaign_id: c.id }, attributes: ['status', [fn('COUNT', col('id')), 'n']], group: ['status'], raw: true }),
      ]);
      const leads = leadStats.reduce((s, x) => s + Number(x.n), 0);
      const converted = Number(leadStats.find((x) => x.status === 'converted')?.n || 0);
      const won = oppStats.find((x) => x.status === 'won');
      const wonRevenue = Number(won?.amount || 0);
      const cost = Number(c.actual_cost || c.budget || 0);
      return ok(res, {
        leads, converted_leads: converted, conversion_rate: leads ? +(converted / leads).toFixed(4) : 0,
        opportunities: oppStats.reduce((s, x) => s + Number(x.n), 0),
        pipeline_amount: oppStats.filter((x) => x.status === 'open').reduce((s, x) => s + Number(x.amount || 0), 0).toFixed(2),
        won_revenue: wonRevenue.toFixed(2),
        roi: cost ? +((wonRevenue - cost) / cost).toFixed(4) : null,
        members: Object.fromEntries(members.map((m) => [m.status, Number(m.n)])),
      });
    });
  },
});
