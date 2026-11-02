'use strict';

const { createRouter } = require('../../utils/router');
const { z, idParams, trimmed } = require('../../utils/schemas');
const service = require('./integrations.service');
const { catalog } = require('../../integrations/providers');
const { IncomingWebhookEvent } = require('../../models');
const { ok, created, noContent } = require('../../utils/http');

const r = createRouter({ prefix: '/api/v1/integrations', tag: 'Integrations' });
r.get('/providers', { summary: 'Integration catalog with configuration schemas', permission: 'integrations:read' }, (_req, res) => ok(res, catalog()));
r.get('/', { summary: 'Configured connections (secrets never returned)', permission: 'integrations:read' }, async (_req, res) => ok(res, await service.list()));
r.post('/', {
  summary: 'Create a connection', permission: 'integrations:manage',
  body: z.strictObject({ provider: z.string().max(40), name: trimmed(120).optional(), config: z.record(z.string(), z.any()).optional(), secrets: z.record(z.string(), z.any()).optional() }),
}, async (req, res) => created(res, await service.create(req.valid.body)));
r.patch('/:id', {
  summary: 'Update connection config/secrets or enable/disable', permission: 'integrations:manage', params: idParams,
  body: z.strictObject({ name: trimmed(120).optional(), config: z.record(z.string(), z.any()).optional(), secrets: z.record(z.string(), z.any()).optional(), status: z.enum(['enabled', 'disabled']).optional() }),
}, async (req, res) => ok(res, await service.update(req.valid.params.id, req.valid.body)));
r.delete('/:id', { summary: 'Delete a connection', permission: 'integrations:manage', params: idParams }, async (req, res) => {
  await service.remove(req.valid.params.id);
  return noContent(res);
});
r.post('/:id/test', { summary: 'Run a live connection test against the provider', permission: 'integrations:manage', params: idParams }, async (req, res) => ok(res, await service.test(req.valid.params.id)));
r.post('/:id/oauth/start', { summary: 'Begin the OAuth authorization flow', permission: 'integrations:manage', params: idParams }, async (req, res) => {
  const conn = await service.load(req.valid.params.id);
  return ok(res, { authorize_url: service.oauthStart(conn.id, conn) });
});
r.get('/:id/events', { summary: 'Recent inbound webhook events for a connection', permission: 'integrations:read', params: idParams }, async (req, res) =>
  ok(res, await IncomingWebhookEvent.findAll({ where: { connection_id: req.valid.params.id }, order: [['created_at', 'DESC']], limit: 100, attributes: { exclude: ['payload'] } })));

module.exports = r;
