'use strict';

const { WebhookEndpoint, WebhookDelivery, Tenant } = require('../../models');
const queue = require('../../jobs/queue');
const { registerDispatchTarget } = require('../../jobs/dispatch');
const { safeFetch } = require('../../utils/safeFetch');
const { decrypt, hmac } = require('../../utils/crypto');
const { uuidv7 } = require('../../utils/ids');
const { logger } = require('../../logging/logger');

const MAX_ATTEMPTS = 8;
const AUTO_DISABLE_AFTER = 20;

const EVENT_TYPES = [
  'lead.created', 'lead.updated', 'lead.deleted', 'lead.converted',
  'contact.created', 'contact.updated', 'contact.deleted',
  'account.created', 'account.updated', 'account.deleted',
  'opportunity.created', 'opportunity.updated', 'opportunity.deleted', 'opportunity.stage_changed', 'opportunity.won', 'opportunity.lost',
  'activity.created', 'activity.updated', 'ticket.created', 'ticket.updated', 'ticket.commented', 'ticket.sla_breached',
  'quote.created', 'quote.approved', 'quote.rejected', 'quote.sent', 'quote.accepted', 'quote.declined',
];

/** Signature header: X-CRM-Signature: t=<unix>,v1=<hex hmac_sha256(secret, `${t}.${body}`)> */
function signatureHeader(secret, body, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${hmac(secret, `${t}.${body}`)}`;
}

/** Event dispatch target: fan out to subscribed endpoints (idempotent per endpoint+event). */
async function fanout(event) {
  if (!EVENT_TYPES.includes(event.type)) return;
  const endpoints = await WebhookEndpoint.findAll({ where: { is_active: true } });
  for (const ep of endpoints) {
    const events = ep.events || [];
    if (!events.includes('*') && !events.includes(event.type)) continue;
    const existing = await WebhookDelivery.findOne({ where: { endpoint_id: ep.id, event_id: event.id }, attributes: ['id'] });
    if (existing) continue;
    const delivery = await WebhookDelivery.create({ endpoint_id: ep.id, event_id: event.id, event_type: event.type, payload: { id: event.id, type: event.type, created_at: event.occurred_at, data: event.data, changes: event.changes || undefined } });
    await queue.enqueue('webhooks.deliver', { delivery_id: delivery.id }, { maxAttempts: MAX_ATTEMPTS });
  }
}

async function deliver({ delivery_id: id }, job) {
  const d = await WebhookDelivery.findByPk(id);
  if (!d || d.status === 'succeeded') return { skipped: true };
  const ep = await WebhookEndpoint.findByPk(d.endpoint_id);
  if (!ep || !ep.is_active) {
    await d.update({ status: 'dead', error: 'Endpoint disabled or removed' });
    return { skipped: true };
  }
  const tenant = await Tenant.findByPk(d.tenant_id, { attributes: ['slug'] });
  const body = JSON.stringify({ ...d.payload, workspace: tenant?.slug });
  const started = Date.now();
  let status = null;
  let responseBody = null;
  let error = null;
  try {
    const res = await safeFetch(ep.url, {
      method: 'POST',
      timeoutMs: 10_000,
      headers: {
        'Content-Type': 'application/json', 'User-Agent': 'CRM-SaaS-Webhooks/1.0', 'X-CRM-Event': d.event_type, 'X-CRM-Event-Id': d.event_id,
        'X-CRM-Delivery-Id': d.id, 'X-CRM-Signature': signatureHeader(decrypt(ep.secret_encrypted), body),
      },
      body,
    });
    status = res.status;
    responseBody = (await res.text()).slice(0, 2000);
    if (status < 200 || status >= 300) error = `HTTP ${status}`;
  } catch (err) {
    error = err.expose ? err.message : err.name === 'AbortError' ? 'Timed out after 10s' : String(err.message).slice(0, 500);
  }
  const attempts = (job?.attempts || d.attempts + 1);
  if (!error) {
    await d.update({ status: 'succeeded', attempts, response_status: status, response_body: responseBody, error: null, duration_ms: Date.now() - started, next_attempt_at: null });
    await ep.update({ consecutive_failures: 0, last_delivery_at: new Date() });
    return { status };
  }
  const dead = attempts >= MAX_ATTEMPTS;
  await d.update({ status: dead ? 'dead' : 'failed', attempts, response_status: status, response_body: responseBody, error, duration_ms: Date.now() - started, next_attempt_at: dead ? null : new Date(Date.now() + 2 ** attempts * 5000) });
  const failures = ep.consecutive_failures + 1;
  await ep.update({ consecutive_failures: failures, ...(failures >= AUTO_DISABLE_AFTER ? { is_active: false, disabled_reason: `Disabled after ${failures} consecutive failures` } : {}) });
  if (failures >= AUTO_DISABLE_AFTER) logger.warn({ endpointId: ep.id }, 'webhook endpoint auto-disabled');
  throw new Error(`Webhook delivery failed: ${error}`);
}

async function sendTest(ep) {
  const d = await WebhookDelivery.create({ endpoint_id: ep.id, event_id: uuidv7(), event_type: 'ping', payload: { id: uuidv7(), type: 'ping', created_at: new Date().toISOString(), data: { message: 'Webhook test from CRM SaaS' } } });
  try {
    await deliver({ delivery_id: d.id }, { attempts: MAX_ATTEMPTS });
  } catch {
    /* result is recorded on the delivery */
  }
  return WebhookDelivery.findByPk(d.id);
}

async function redeliver(id) {
  const d = await WebhookDelivery.findByPk(id);
  if (!d) return null;
  await d.update({ status: 'pending', attempts: 0, error: null });
  await queue.enqueue('webhooks.deliver', { delivery_id: d.id }, { maxAttempts: MAX_ATTEMPTS });
  return d;
}

queue.register('webhooks.deliver', deliver, { maxAttempts: MAX_ATTEMPTS });
registerDispatchTarget('webhooks', fanout);

module.exports = { fanout, deliver, sendTest, redeliver, signatureHeader, EVENT_TYPES };
