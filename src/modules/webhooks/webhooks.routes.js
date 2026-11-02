'use strict';

const crypto = require('node:crypto');
const { createRouter } = require('../../utils/router');
const { z, idParams, httpUrl, trimmed } = require('../../utils/schemas');
const { WebhookEndpoint, WebhookDelivery } = require('../../models');
const service = require('./webhooks.service');
const { assertSafeUrl } = require('../../utils/safeFetch');
const { encrypt } = require('../../utils/crypto');
const audit = require('../audit/audit.service');
const { getContext } = require('../../context/requestContext');
const { ok, created, noContent } = require('../../utils/http');
const E = require('../../errors/AppError');

const r = createRouter({ prefix: '/api/v1/webhooks', tag: 'Webhooks' });
const events = z.array(z.enum([...service.EVENT_TYPES, '*'])).min(1).max(50);
const present = (ep) => ({ ...ep.toJSON(), tenant_id: undefined });

r.get('/event-types', { summary: 'Subscribable event types', permission: 'webhooks:manage' }, (_req, res) => ok(res, service.EVENT_TYPES));
r.get('/', { summary: 'List webhook endpoints', permission: 'webhooks:manage' }, async (_req, res) => ok(res, (await WebhookEndpoint.findAll({ order: [['created_at', 'DESC']] })).map(present)));
r.post('/', { summary: 'Register an endpoint (signing secret shown once)', permission: 'webhooks:manage', body: z.strictObject({ url: httpUrl(), description: trimmed(255).optional(), events }) }, async (req, res) => {
  await assertSafeUrl(req.valid.body.url);
  const secret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
  const ep = await WebhookEndpoint.create({ ...req.valid.body, secret_encrypted: encrypt(secret), created_by_user_id: getContext().userId });
  await audit.record({ action: 'webhook.created', entityType: 'webhook', entityId: ep.id, summary: `Webhook endpoint ${new URL(ep.url).host} registered`, metadata: { events: ep.events } });
  return created(res, { ...present(ep), secret });
});
r.patch('/:id', {
  summary: 'Update or re-enable an endpoint', permission: 'webhooks:manage', params: idParams,
  body: z.strictObject({ url: httpUrl().optional(), description: trimmed(255).nullish(), events: events.optional(), is_active: z.boolean().optional() }),
}, async (req, res) => {
  const ep = await WebhookEndpoint.findByPk(req.valid.params.id);
  if (!ep) throw E.notFound('Webhook endpoint');
  if (req.valid.body.url) await assertSafeUrl(req.valid.body.url);
  await ep.update({ ...req.valid.body, ...(req.valid.body.is_active ? { consecutive_failures: 0, disabled_reason: null } : {}) });
  await audit.record({ action: 'webhook.updated', entityType: 'webhook', entityId: ep.id, summary: 'Webhook endpoint updated' });
  return ok(res, present(ep));
});
r.delete('/:id', { summary: 'Delete an endpoint', permission: 'webhooks:manage', params: idParams }, async (req, res) => {
  const ep = await WebhookEndpoint.findByPk(req.valid.params.id);
  if (!ep) throw E.notFound('Webhook endpoint');
  await WebhookDelivery.destroy({ where: { endpoint_id: ep.id } });
  await ep.destroy();
  await audit.record({ action: 'webhook.deleted', entityType: 'webhook', entityId: ep.id, summary: 'Webhook endpoint deleted' });
  return noContent(res);
});
r.post('/:id/test', { summary: 'Send a signed ping event now', permission: 'webhooks:manage', params: idParams }, async (req, res) => {
  const ep = await WebhookEndpoint.findByPk(req.valid.params.id);
  if (!ep) throw E.notFound('Webhook endpoint');
  return ok(res, await service.sendTest(ep));
});
r.get('/:id/deliveries', { summary: 'Delivery history', permission: 'webhooks:manage', params: idParams }, async (req, res) =>
  ok(res, await WebhookDelivery.findAll({ where: { endpoint_id: req.valid.params.id }, order: [['created_at', 'DESC']], limit: 100, attributes: { exclude: ['payload'] } })));
r.post('/deliveries/:id/redeliver', { summary: 'Retry a delivery', permission: 'webhooks:manage', params: idParams }, async (req, res) => {
  const d = await service.redeliver(req.valid.params.id);
  if (!d) throw E.notFound('Delivery');
  return ok(res, d);
});

module.exports = r;
