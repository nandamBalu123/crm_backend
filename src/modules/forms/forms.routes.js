'use strict';

const { createRouter } = require('../../utils/router');
const { z, idParams, uuid, requiredText, trimmed, optionalUrl } = require('../../utils/schemas');
const { LeadForm, FormSubmission, Campaign, Membership } = require('../../models');
const { randomToken } = require('../../utils/ids');
const audit = require('../audit/audit.service');
const env = require('../../config/env');
const { ok, created, noContent } = require('../../utils/http');
const E = require('../../errors/AppError');

const LEAD_FIELDS = ['first_name', 'last_name', 'email', 'phone', 'company', 'title', 'website', 'industry', 'city', 'country', 'description'];

const fieldSchema = z.strictObject({
  key: z.string().regex(/^(cf\.[a-z][a-z0-9_]{1,62}|[a-z_]+)$/),
  label: requiredText(120),
  type: z.enum(['text', 'email', 'phone', 'textarea', 'select', 'checkbox', 'number', 'url']),
  required: z.boolean().optional(),
  options: z.array(z.string().max(100)).max(100).optional(),
  placeholder: trimmed(200).optional(),
});
const formBody = z.strictObject({
  name: requiredText(120),
  fields: z.array(fieldSchema).min(1).max(40).refine((f) => f.some((x) => x.key === 'last_name' || x.key === 'email'), 'A form needs a last_name or email field'),
  campaign_id: uuid().nullish(),
  default_owner_id: uuid().nullish(),
  lead_source: trimmed(60).optional(),
  success_message: trimmed(500).nullish(),
  redirect_url: optionalUrl(),
  consent_text: trimmed(1000).nullish(),
  require_consent: z.boolean().optional(),
  allowed_origins: z.array(z.string().url().max(200)).max(20).optional(),
  is_active: z.boolean().optional(),
});

async function validateRefs(body) {
  for (const f of body.fields) {
    if (!f.key.startsWith('cf.') && !LEAD_FIELDS.includes(f.key)) throw E.validation([{ path: 'fields', message: `Unknown lead field ${f.key}` }]);
  }
  if (body.campaign_id && !(await Campaign.findByPk(body.campaign_id))) throw E.validation([{ path: 'campaign_id', message: 'Campaign not found' }]);
  if (body.default_owner_id && !(await Membership.findOne({ where: { user_id: body.default_owner_id, status: 'active' } }))) throw E.validation([{ path: 'default_owner_id', message: 'User not found' }]);
}

const present = (f) => ({ ...f.toJSON(), tenant_id: undefined, embed_url: `${env.API_URL}/api/v1/public/forms/${f.public_key}`, hosted_url: `${env.APP_URL}/f/${f.public_key}` });

const r = createRouter({ prefix: '/api/v1/forms', tag: 'Lead capture forms' });
r.get('/', { summary: 'List lead capture forms', permission: 'forms:read' }, async (_req, res) => ok(res, (await LeadForm.findAll({ order: [['created_at', 'DESC']] })).map(present)));
r.get('/:id', { summary: 'Get a form', permission: 'forms:read', params: idParams }, async (req, res) => {
  const f = await LeadForm.findByPk(req.valid.params.id);
  if (!f) throw E.notFound('Form');
  return ok(res, present(f));
});
r.post('/', { summary: 'Create a lead capture form', permission: 'forms:create', body: formBody }, async (req, res) => {
  await validateRefs(req.valid.body);
  const f = await LeadForm.create({ ...req.valid.body, public_key: randomToken(18) });
  await audit.record({ action: 'form.created', entityType: 'lead_form', entityId: f.id, summary: `Form ${f.name} created` });
  return created(res, present(f));
});
r.patch('/:id', { summary: 'Update a form', permission: 'forms:update', params: idParams, body: formBody.partial() }, async (req, res) => {
  const f = await LeadForm.findByPk(req.valid.params.id);
  if (!f) throw E.notFound('Form');
  await validateRefs({ fields: req.valid.body.fields || f.fields, campaign_id: req.valid.body.campaign_id, default_owner_id: req.valid.body.default_owner_id });
  await f.update(req.valid.body);
  await audit.record({ action: 'form.updated', entityType: 'lead_form', entityId: f.id, summary: `Form ${f.name} updated` });
  return ok(res, present(f));
});
r.post('/:id/rotate-key', { summary: 'Rotate the public key (old embeds stop working)', permission: 'forms:update', params: idParams }, async (req, res) => {
  const f = await LeadForm.findByPk(req.valid.params.id);
  if (!f) throw E.notFound('Form');
  await f.update({ public_key: randomToken(18) });
  return ok(res, present(f));
});
r.delete('/:id', { summary: 'Delete a form', permission: 'forms:delete', params: idParams }, async (req, res) => {
  const f = await LeadForm.findByPk(req.valid.params.id);
  if (!f) throw E.notFound('Form');
  await f.destroy();
  return noContent(res);
});
r.get('/:id/submissions', { summary: 'Recent submissions', permission: 'forms:read', params: idParams }, async (req, res) =>
  ok(res, await FormSubmission.findAll({ where: { form_id: req.valid.params.id }, order: [['created_at', 'DESC']], limit: 200, attributes: { exclude: ['ip', 'user_agent'] } })));

module.exports = r;
module.exports.LEAD_FIELDS = LEAD_FIELDS;
