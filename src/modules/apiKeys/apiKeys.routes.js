'use strict';

const crypto = require('node:crypto');
const { createRouter } = require('../../utils/router');
const { z, idParams, requiredText } = require('../../utils/schemas');
const { ApiKey } = require('../../models');
const { assertCanGrant } = require('../rbac/escalation');
const { isModuleEnabled } = require('../billing/entitlements.service');
const { invalidateApiKey } = require('../../middleware/authenticate');
const { sha256 } = require('../../utils/crypto');
const audit = require('../audit/audit.service');
const { getContext } = require('../../context/requestContext');
const { ok, created, noContent } = require('../../utils/http');
const E = require('../../errors/AppError');

const r = createRouter({ prefix: '/api/v1/api-keys', tag: 'API keys' });
const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const prefix = () => Array.from(crypto.randomBytes(10), (b) => ALNUM[b % ALNUM.length]).join('');

r.get('/', { summary: 'List API keys (secrets are never returned)', permission: 'api_keys:manage' }, async (_req, res) =>
  ok(res, (await ApiKey.findAll({ order: [['created_at', 'DESC']] })).map((k) => ({ ...k.toJSON(), tenant_id: undefined, display: `crm_${k.prefix}_••••` }))));

r.post('/', {
  summary: 'Create an API key scoped to a subset of your permissions (shown once)', permission: 'api_keys:manage',
  body: z.strictObject({
    name: requiredText(120),
    scopes: z.record(z.string().max(80), z.enum(['own', 'team', 'all'])).refine((s) => Object.keys(s).length > 0, 'At least one scope is required'),
    expires_in_days: z.coerce.number().int().min(1).max(730).optional(),
    rate_limit_per_minute: z.coerce.number().int().min(10).max(6000).optional(),
  }),
}, async (req, res) => {
  const ctx = getContext();
  if (ctx.authType === 'api_key') throw E.forbidden('API keys cannot create API keys', 'FORBIDDEN');
  if (!(await isModuleEnabled('api'))) throw E.forbidden('API access is not included in your plan', 'MODULE_DISABLED');
  assertCanGrant(ctx, req.valid.body.scopes);
  const p = prefix();
  const raw = `crm_${p}_${crypto.randomBytes(32).toString('base64url')}`;
  const key = await ApiKey.create({
    name: req.valid.body.name, prefix: p, key_hash: sha256(raw), scopes: req.valid.body.scopes, created_by_user_id: ctx.userId,
    rate_limit_per_minute: req.valid.body.rate_limit_per_minute || 120,
    expires_at: req.valid.body.expires_in_days ? new Date(Date.now() + req.valid.body.expires_in_days * 86400_000) : null,
  });
  await audit.record({ action: 'api_key.created', entityType: 'api_key', entityId: key.id, summary: `API key ${key.name} created`, metadata: { scopes: req.valid.body.scopes, prefix: p } });
  return created(res, { ...key.toJSON(), tenant_id: undefined, key: raw, warning: 'Store this key securely. It will not be shown again.' });
});

r.delete('/:id', { summary: 'Revoke an API key', permission: 'api_keys:manage', params: idParams }, async (req, res) => {
  const key = await ApiKey.findByPk(req.valid.params.id);
  if (!key) throw E.notFound('API key');
  await key.update({ revoked_at: new Date() });
  invalidateApiKey(key.prefix);
  await audit.record({ action: 'api_key.revoked', entityType: 'api_key', entityId: key.id, summary: `API key ${key.name} revoked` });
  return noContent(res);
});

module.exports = r;
