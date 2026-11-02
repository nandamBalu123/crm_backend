'use strict';

const express = require('express');
const { sequelize, IntegrationConnection, IncomingWebhookEvent, Tenant } = require('../../models');
const { runAsSystem, runInTenant, getContext } = require('../../context/requestContext');
const { decryptJson, hmac, safeEqual } = require('../../utils/crypto');
const { loadTenant } = require('../../middleware/tenantContext');
const integrations = require('./integrations.service');
const service = require('../../core/entity/service');
const registry = require('../../core/entity/registry');
const audit = require('../audit/audit.service');
const env = require('../../config/env');
const E = require('../../errors/AppError');

const router = express.Router();
const TOLERANCE_S = 300;
const LEAD_FIELDS = ['first_name', 'last_name', 'email', 'phone', 'company', 'title', 'website', 'industry', 'city', 'country', 'description'];

/**
 * Signed inbound lead webhook:
 *   POST /api/v1/public/inbound/:key/leads
 *   X-CRM-Timestamp: <unix seconds>
 *   X-CRM-Signature: v1=<hex hmac_sha256(secret, `${timestamp}.${rawBody}`)>
 *   X-CRM-Event-Id: <unique id>   (idempotency / duplicate suppression)
 */
router.post('/api/v1/public/inbound/:key/leads', async (req, res) => {
  const key = req.params.key;
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(key)) throw E.notFound('Endpoint');
  const conn = await runAsSystem('inbound:lookup', () => IntegrationConnection.findOne({ where: { inbound_key: key, provider: 'inbound_leads' } }));
  if (!conn || conn.status === 'disabled') throw E.notFound('Endpoint');
  const tenant = await runAsSystem('inbound:tenant', () => Tenant.findByPk(conn.tenant_id, { attributes: ['id', 'status', 'owner_user_id'] }));
  if (!tenant || tenant.status !== 'active') throw E.notFound('Endpoint');

  const ts = Number(req.get('x-crm-timestamp'));
  const sig = String(req.get('x-crm-signature') || '').replace(/^v1=/, '');
  const eventId = String(req.get('x-crm-event-id') || '').slice(0, 200);
  const secret = decryptJson(conn.credentials_encrypted).signing_secret;
  if (!ts || Math.abs(Date.now() / 1000 - ts) > TOLERANCE_S) throw E.unauthorized('Missing or stale timestamp', 'SIGNATURE_INVALID');
  if (!sig || !safeEqual(sig, hmac(secret, `${ts}.${req.rawBody ? req.rawBody.toString('utf8') : ''}`))) throw E.unauthorized('Invalid signature', 'SIGNATURE_INVALID');
  if (!eventId) throw E.badRequest('X-CRM-Event-Id header is required');

  const result = await runInTenant(tenant.id, async () => {
    Object.assign(getContext(), { actorType: 'public', actorLabel: `inbound:${conn.name}`, settings: (await loadTenant(tenant.id)).settings });
    let event;
    try {
      event = await IncomingWebhookEvent.create({ connection_id: conn.id, provider: 'inbound_leads', external_event_id: eventId, event_type: 'lead.created', payload: { keys: Object.keys(req.body || {}) } });
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError') return { duplicate: true };
      throw err;
    }
    const map = conn.config.field_map || {};
    const data = {};
    for (const [src, value] of Object.entries(req.body || {})) {
      const target = map[src] || src;
      if (LEAD_FIELDS.includes(target) && value !== null && value !== undefined) data[target] = String(value).slice(0, 255);
    }
    if (data.email) data.email = data.email.toLowerCase();
    if (!data.last_name) data.last_name = data.email ? data.email.split('@')[0] : 'Unknown';
    try {
      const lead = await sequelize.transaction((transaction) => service.createRecord(registry.lead, { ...data, source: conn.config.lead_source || 'inbound_webhook', owner_id: conn.config.default_owner_id || tenant.owner_user_id }, { transaction, skipOwnerCheck: true }));
      await event.update({ status: 'processed', processed_at: new Date() });
      await audit.record({ action: 'integration.inbound_lead', entityType: 'lead', entityId: lead.id, summary: `Lead received via ${conn.name}` });
      return { lead_id: lead.id };
    } catch (err) {
      await event.update({ status: 'failed', error: String(err.message).slice(0, 1000) });
      throw err;
    }
  });
  res.status(result.duplicate ? 200 : 201).json({ data: result });
});

router.get('/api/v1/public/oauth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code || !state) return res.redirect(`${env.APP_URL}/settings/integrations?oauth=error`);
  const result = await integrations.oauthCallback({ code: String(code), state: String(state) });
  return res.redirect(`${env.APP_URL}/settings/integrations?oauth=${result.ok ? 'connected' : 'error'}&connection=${result.connectionId}`);
});

module.exports = router;
