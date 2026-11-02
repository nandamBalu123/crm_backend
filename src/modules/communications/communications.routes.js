'use strict';

const { createRouter } = require('../../utils/router');
const { z, idParams, uuid, requiredText, trimmed } = require('../../utils/schemas');
const service = require('./communications.service');
const { sanitizeHtml, render } = require('./templating');
const { Communication, EmailTemplate } = require('../../models');
const audit = require('../audit/audit.service');
const { ok, created, noContent } = require('../../utils/http');
const E = require('../../errors/AppError');

const comms = createRouter({ prefix: '/api/v1/communications', tag: 'Communications' });
comms.get('/', {
  summary: 'Communication history', permission: 'communications:read',
  query: z.object({ contact_id: uuid().optional(), lead_id: uuid().optional(), account_id: uuid().optional(), status: z.string().max(20).optional(), page: z.coerce.number().int().min(1).optional() }),
}, async (req, res) => {
  const { page = 1, ...f } = req.valid.query;
  const where = Object.fromEntries(Object.entries(f).filter(([, v]) => v));
  const { rows, count } = await Communication.findAndCountAll({ where, order: [['created_at', 'DESC']], limit: 50, offset: (page - 1) * 50 });
  return ok(res, rows, { page, page_size: 50, total: count, total_pages: Math.ceil(count / 50) });
});
comms.get('/:id', { summary: 'Get a communication', permission: 'communications:read', params: idParams }, async (req, res) => {
  const c = await Communication.findByPk(req.valid.params.id);
  if (!c) throw E.notFound('Communication');
  return ok(res, c);
});
comms.post('/', {
  summary: 'Send an email, SMS or WhatsApp message to a contact or lead (consent enforced)', permission: 'communications:create', idempotent: true,
  body: z.strictObject({
    channel: z.enum(['email', 'sms', 'whatsapp']).default('email'), contact_id: uuid().optional(), lead_id: uuid().optional(), opportunity_id: uuid().optional(), ticket_id: uuid().optional(),
    subject: trimmed(300).optional(), body: z.string().max(100000).optional(), template_id: uuid().optional(), variables: z.record(z.string().max(60), z.union([z.string().max(1000), z.number()])).optional(), marketing: z.boolean().optional(),
  }).refine((v) => v.body || v.template_id, { message: 'body or template_id is required', path: ['body'] }),
}, async (req, res) => created(res, await service.send(req.valid.body)));

const templateBody = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,79}$/), name: requiredText(160), subject: requiredText(300), body_html: z.string().min(1).max(100000),
  category: z.enum(['sales', 'marketing', 'support', 'system']).optional(), is_active: z.boolean().optional(),
});
const templates = createRouter({ prefix: '/api/v1/email-templates', tag: 'Communications' });
templates.get('/', { summary: 'Email templates', permission: 'communications:read' }, async (_req, res) => ok(res, await EmailTemplate.findAll({ order: [['name', 'ASC']] })));
templates.post('/', { summary: 'Create a template (HTML is sanitised)', permission: 'settings:manage', body: templateBody }, async (req, res) => {
  const t = await EmailTemplate.create({ ...req.valid.body, body_html: sanitizeHtml(req.valid.body.body_html) });
  await audit.record({ action: 'email_template.created', entityType: 'email_template', entityId: t.id, summary: `Template ${t.name} created` });
  return created(res, t);
});
templates.patch('/:id', { summary: 'Update a template', permission: 'settings:manage', params: idParams, body: templateBody.partial() }, async (req, res) => {
  const t = await EmailTemplate.findByPk(req.valid.params.id);
  if (!t) throw E.notFound('Template');
  await t.update({ ...req.valid.body, ...(req.valid.body.body_html ? { body_html: sanitizeHtml(req.valid.body.body_html) } : {}) });
  return ok(res, t);
});
templates.delete('/:id', { summary: 'Delete a template', permission: 'settings:manage', params: idParams }, async (req, res) => {
  if (!(await EmailTemplate.destroy({ where: { id: req.valid.params.id } }))) throw E.notFound('Template');
  return noContent(res);
});
templates.post('/:id/preview', { summary: 'Render a template with sample variables', permission: 'communications:read', params: idParams, body: z.strictObject({ variables: z.record(z.string(), z.any()).optional() }) }, async (req, res) => {
  const t = await EmailTemplate.findByPk(req.valid.params.id);
  if (!t) throw E.notFound('Template');
  const vars = { first_name: 'Alex', last_name: 'Sample', company: 'Example Co', sender_name: 'You', ...(req.valid.body.variables || {}) };
  return ok(res, { subject: render(t.subject, vars), html: sanitizeHtml(render(t.body_html, vars, { html: true })) });
});

module.exports = { comms, templates };
