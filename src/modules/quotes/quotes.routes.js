'use strict';

const { entityRouter } = require('../../core/entity/routes');
const service = require('../../core/entity/service');
const quotes = require('./quotes.service');
const { renderQuotePdf } = require('./pdf');
const { QuoteLineItem, QuoteTemplate, Tenant, Account, Contact } = require('../../models');
const { z, idParams, requiredText, trimmed } = require('../../utils/schemas');
const audit = require('../audit/audit.service');
const { getContext } = require('../../context/requestContext');
const { ok, created } = require('../../utils/http');
const E = require('../../errors/AppError');
const def = require('./quotes.entity');

const templateBody = z.strictObject({ name: requiredText(120), header_text: trimmed(5000).nullish(), footer_text: trimmed(2000).nullish(), terms: trimmed(10000).nullish(), accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(), is_default: z.boolean().optional() });

module.exports = entityRouter(def, {
  extend(r) {
    r.get('/templates', { summary: 'Proposal templates', permission: 'quotes:read' }, async (_req, res) => ok(res, await QuoteTemplate.findAll({ order: [['name', 'ASC']] })));
    r.post('/templates', { summary: 'Create a proposal template', permission: 'settings:manage', body: templateBody }, async (req, res) => {
      if (req.valid.body.is_default) await QuoteTemplate.update({ is_default: false }, { where: {} });
      const t = await QuoteTemplate.create(req.valid.body);
      await audit.record({ action: 'quote_template.created', entityType: 'quote_template', entityId: t.id, summary: `Template ${t.name} created` });
      return created(res, t);
    });
    r.post('/:id/submit', { summary: 'Submit a draft quote (auto-approves within discount policy)', permission: 'quotes:update', params: idParams }, async (req, res) => ok(res, await quotes.submit(req.valid.params.id, req.scope)));
    r.post('/:id/approve', { summary: 'Approve a quote awaiting approval', permission: 'quotes:approve', params: idParams, body: z.strictObject({ comment: trimmed(1000).optional() }) }, async (req, res) =>
      ok(res, await quotes.decide(req.valid.params.id, 'all', 'approved', req.valid.body.comment)));
    r.post('/:id/reject', { summary: 'Reject a quote awaiting approval', permission: 'quotes:approve', params: idParams, body: z.strictObject({ comment: trimmed(1000).min(3) }) }, async (req, res) =>
      ok(res, await quotes.decide(req.valid.params.id, 'all', 'rejected', req.valid.body.comment)));
    for (const action of ['send', 'accept', 'decline']) {
      r.post(`/:id/${action}`, { summary: `Mark quote ${action === 'send' ? 'sent' : `${action}ed`}`, permission: 'quotes:update', params: idParams }, async (req, res) => ok(res, await quotes.move(req.valid.params.id, req.scope, action)));
    }
    r.post('/:id/revise', { summary: 'Create a new revision of a quote', permission: 'quotes:create', params: idParams }, async (req, res) => created(res, await quotes.revise(req.valid.params.id, req.scope)));
    r.get('/:id/revisions', { summary: 'All revisions of a quote', permission: 'quotes:read', params: idParams }, async (req, res) => ok(res, await quotes.revisions(req.valid.params.id, req.scope)));
    r.get('/:id/pdf', { summary: 'Render the quote as PDF', permission: 'quotes:read', params: idParams, produces: 'application/pdf' }, async (req, res) => {
      const ctx = getContext();
      const quote = await service.findScoped(def, req.valid.params.id, req.scope);
      const [lines, tenant, template, account, contact] = await Promise.all([
        QuoteLineItem.findAll({ where: { quote_id: quote.id }, order: [['position', 'ASC']] }),
        Tenant.findByPk(ctx.tenantId),
        quote.template_id ? QuoteTemplate.findByPk(quote.template_id) : QuoteTemplate.findOne({ where: { is_default: true } }),
        quote.account_id ? Account.findByPk(quote.account_id, { attributes: ['name'] }) : null,
        quote.contact_id ? Contact.findByPk(quote.contact_id, { attributes: ['first_name', 'last_name', 'email'] }) : null,
      ]);
      if (!tenant) throw E.notFound('Workspace');
      await audit.record({ action: 'quote.pdf_generated', entityType: 'quote', entityId: quote.id });
      renderQuotePdf(res, { quote, lines, tenant, settings: ctx.settings, template, account, contact });
    });
  },
});
