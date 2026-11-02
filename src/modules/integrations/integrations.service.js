'use strict';

const { IntegrationConnection } = require('../../models');
const { providers, oauthAvailable } = require('../../integrations/providers');
const { encryptJson, decryptJson, signPayload, verifyPayload } = require('../../utils/crypto');
const { randomToken } = require('../../utils/ids');
const { safeFetch } = require('../../utils/safeFetch');
const audit = require('../audit/audit.service');
const { getContext, runInTenant } = require('../../context/requestContext');
const { formatIssues } = require('../../middleware/validate');
const env = require('../../config/env');
const E = require('../../errors/AppError');

function provider(key) {
  const p = providers[key];
  if (!p) throw E.validation([{ path: 'provider', message: 'Unknown provider' }]);
  return p;
}

/** Public shape: never includes secrets; lists which secret fields are set. */
function present(conn) {
  const secrets = conn.credentials_encrypted ? decryptJson(conn.credentials_encrypted) : {};
  const p = providers[conn.provider];
  return {
    id: conn.id, provider: conn.provider, provider_name: p?.name, name: conn.name, status: conn.status, config: conn.config,
    secrets_set: Object.keys(secrets).filter((k) => !['access_token', 'refresh_token', 'expires_at'].includes(k)),
    oauth_connected: !!secrets.access_token,
    inbound_url: conn.inbound_key ? `${env.API_URL}/api/v1/public/inbound/${conn.inbound_key}/leads` : null,
    last_tested_at: conn.last_tested_at, last_error: conn.last_error, created_at: conn.created_at, updated_at: conn.updated_at, version: conn.version,
  };
}

function parse(schema, value, path) {
  const r = schema.safeParse(value || {});
  if (!r.success) throw E.validation(formatIssues(r.error.issues, path));
  return r.data;
}

async function list() {
  return (await IntegrationConnection.findAll({ order: [['created_at', 'ASC']] })).map(present);
}

async function create({ provider: key, name, config, secrets }) {
  const ctx = getContext();
  const p = provider(key);
  if (!oauthAvailable(p)) throw E.conflict(`${p.name} requires the platform administrator to configure ${p.envVars.join(', ')}`, 'PLATFORM_CONFIG_REQUIRED');
  const cfg = parse(p.configSchema, config, 'config');
  const sec = parse(p.secretSchema, secrets, 'secrets');
  if (p.auth === 'inbound' && !sec.signing_secret) sec.signing_secret = randomToken(32);
  const conn = await IntegrationConnection.create({
    provider: key, name: name || p.name, config: cfg, credentials_encrypted: encryptJson(sec),
    status: p.auth === 'oauth2' ? 'not_configured' : 'configured', inbound_key: p.auth === 'inbound' ? randomToken(18) : null, created_by_user_id: ctx.userId,
  });
  await audit.record({ action: 'integration.created', entityType: 'integration', entityId: conn.id, summary: `${p.name} connection created`, metadata: { provider: key, config: cfg } });
  const out = present(conn);
  // The inbound signing secret is shown once so the sender can be configured.
  if (p.auth === 'inbound') out.signing_secret = sec.signing_secret;
  return out;
}

async function load(id) {
  const conn = await IntegrationConnection.findByPk(id);
  if (!conn) throw E.notFound('Integration');
  return conn;
}

async function update(id, { name, config, secrets, status }) {
  const conn = await load(id);
  const p = provider(conn.provider);
  const changes = {};
  if (name) changes.name = name;
  if (config) changes.config = parse(p.configSchema, { ...conn.config, ...config }, 'config');
  if (secrets) {
    const current = conn.credentials_encrypted ? decryptJson(conn.credentials_encrypted) : {};
    changes.credentials_encrypted = encryptJson({ ...current, ...parse(p.secretSchema.partial(), secrets, 'secrets') });
  }
  if (status === 'disabled') changes.status = 'disabled';
  else if (status === 'enabled' || config || secrets) changes.status = p.auth === 'oauth2' && !(decryptJson(changes.credentials_encrypted || conn.credentials_encrypted).access_token) ? 'not_configured' : 'configured';
  await conn.update(changes);
  await audit.record({ action: 'integration.updated', entityType: 'integration', entityId: id, summary: `${p.name} connection updated`, metadata: { fields: Object.keys(changes).map((k) => (k === 'credentials_encrypted' ? 'secrets' : k)) } });
  return present(conn);
}

async function remove(id) {
  const conn = await load(id);
  await conn.destroy();
  await audit.record({ action: 'integration.deleted', entityType: 'integration', entityId: id, summary: `${conn.provider} connection removed` });
}

/** Calls the provider for real; records connected/error. Never fakes success. */
async function test(id) {
  const conn = await load(id);
  const p = provider(conn.provider);
  const secrets = conn.credentials_encrypted ? decryptJson(conn.credentials_encrypted) : {};
  let result;
  try {
    result = await p.test({ config: conn.config, secrets });
  } catch (err) {
    result = { ok: false, message: err.expose ? err.message : `Connection test failed: ${err.message}` };
  }
  await conn.update({ status: result.ok ? 'connected' : 'error', last_tested_at: new Date(), last_error: result.ok ? null : String(result.message).slice(0, 1000) });
  await audit.record({ action: 'integration.tested', entityType: 'integration', entityId: id, summary: `${p.name} test ${result.ok ? 'succeeded' : 'failed'}` });
  return { ...result, connection: present(conn) };
}

/** Finds the tenant's active connection supporting a capability (e.g. 'email.send'). */
async function connectionFor(capability) {
  const conns = await IntegrationConnection.findAll({ where: { status: ['connected', 'configured'] }, order: [['status', 'ASC'], ['updated_at', 'DESC']] });
  for (const c of conns) {
    const p = providers[c.provider];
    if (p?.capabilities.includes(capability)) return { conn: c, provider: p, config: c.config, secrets: decryptJson(c.credentials_encrypted) };
  }
  return null;
}

// ---- OAuth2 authorization-code flow ----
function oauthStart(id, conn) {
  const ctx = getContext();
  const p = provider(conn.provider);
  if (!p.oauth) throw E.badRequest('This provider does not use OAuth');
  if (!oauthAvailable(p)) throw E.conflict(`Platform OAuth app not configured (${p.envVars.join(', ')})`, 'PLATFORM_CONFIG_REQUIRED');
  const state = signPayload({ t: ctx.tenantId, c: id, u: ctx.userId }, 600);
  const params = new URLSearchParams({ client_id: p.oauth.clientId(), redirect_uri: `${env.API_URL}/api/v1/public/oauth/callback`, response_type: 'code', scope: p.oauth.scopes.join(' '), state, ...p.oauth.extra });
  return `${p.oauth.authorizeUrl}?${params}`;
}

async function oauthCallback({ code, state }) {
  const s = verifyPayload(state);
  if (!s) throw E.badRequest('OAuth state invalid or expired');
  return runInTenant(s.t, async () => {
    const conn = await load(s.c);
    const p = provider(conn.provider);
    const res = await safeFetch(p.oauth.tokenUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: `${env.API_URL}/api/v1/public/oauth/callback`, client_id: p.oauth.clientId(), client_secret: p.oauth.clientSecret() }).toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      await conn.update({ status: 'error', last_error: `Token exchange failed: ${body.error_description || body.error || res.status}` });
      return { ok: false, connectionId: conn.id };
    }
    const current = conn.credentials_encrypted ? decryptJson(conn.credentials_encrypted) : {};
    await conn.update({ status: 'connected', last_error: null, credentials_encrypted: encryptJson({ ...current, access_token: body.access_token, refresh_token: body.refresh_token || current.refresh_token, expires_at: Date.now() + (body.expires_in || 3600) * 1000 }) });
    await audit.record({ action: 'integration.oauth_connected', entityType: 'integration', entityId: conn.id, summary: `${p.name} account connected` });
    return { ok: true, connectionId: conn.id };
  }, { userId: s.u });
}

module.exports = { list, create, update, remove, test, load, present, connectionFor, oauthStart, oauthCallback };
