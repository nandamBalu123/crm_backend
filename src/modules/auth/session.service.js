'use strict';

const { Op } = require('sequelize');
const { UserSession, Membership, Tenant, TenantSettings } = require('../../models');
const env = require('../../config/env');
const { sha256 } = require('../../utils/crypto');
const { randomToken } = require('../../utils/ids');
const { runAsSystem } = require('../../context/requestContext');
const { signAccess, setAuthCookies } = require('./tokens');
const { invalidateSession } = require('../../middleware/authenticate');

const REUSE_GRACE_MS = 20_000;

/** Active memberships of a user across tenants (system query: spans tenants by design). */
async function activeMemberships(userId) {
  return runAsSystem('auth:list-memberships', () =>
    Membership.findAll({
      where: { user_id: userId, status: 'active' },
      include: [{ model: Tenant, as: 'tenant', where: { status: 'active' }, attributes: ['id', 'name', 'slug', 'status'] }],
      order: [['last_active_at', 'DESC']],
    })
  );
}

async function pickTenant(userId, preferredTenantId) {
  const memberships = await activeMemberships(userId);
  if (!memberships.length) return { tenantId: null, memberships };
  const preferred = preferredTenantId && memberships.find((m) => m.tenant_id === preferredTenantId);
  return { tenantId: (preferred || memberships[0]).tenant_id, memberships };
}

async function sessionMaxHours(tenantId) {
  if (!tenantId) return env.REFRESH_TOKEN_TTL_DAYS * 24;
  const s = await runAsSystem('auth:settings', () => TenantSettings.findOne({ where: { tenant_id: tenantId }, attributes: ['security'] }));
  const hours = Number(s?.security?.session_max_hours) || env.REFRESH_TOKEN_TTL_DAYS * 24;
  return Math.min(hours, env.REFRESH_TOKEN_TTL_DAYS * 24);
}

async function createSession(res, user, req, { tenantId, mfaVerified = false } = {}) {
  const refreshToken = randomToken(32);
  const hours = await sessionMaxHours(tenantId);
  const expiresAt = new Date(Date.now() + hours * 3600_000);
  const session = await UserSession.create({
    user_id: user.id,
    active_tenant_id: tenantId,
    refresh_token_hash: sha256(refreshToken),
    user_agent: (req.get('user-agent') || '').slice(0, 400),
    ip: req.ip,
    mfa_verified: mfaVerified,
    last_used_at: new Date(),
    expires_at: expiresAt,
  });
  setAuthCookies(res, { accessToken: signAccess({ userId: user.id, sessionId: session.id, tenantId }), refreshToken, refreshExpires: expiresAt });
  return session;
}

/**
 * Refresh-token rotation with reuse detection:
 *  - current token → rotate (new refresh + access token)
 *  - previous token within a short grace window (parallel tabs) → access token only
 *  - previous token outside the grace window → token theft assumed: revoke session
 */
async function rotate(res, rawToken) {
  if (!rawToken) return { error: 'missing' };
  const hash = sha256(rawToken);
  const now = new Date();
  let session = await UserSession.findOne({ where: { refresh_token_hash: hash } });
  if (!session) {
    const reused = await UserSession.findOne({ where: { previous_token_hash: hash } });
    if (!reused) return { error: 'invalid' };
    if (!reused.revoked_at && reused.rotated_at && now - reused.rotated_at < REUSE_GRACE_MS && reused.expires_at > now) {
      setAuthCookies(res, { accessToken: signAccess({ userId: reused.user_id, sessionId: reused.id, tenantId: reused.active_tenant_id }) });
      return { session: reused, graceful: true };
    }
    await reused.update({ revoked_at: now, revoked_reason: 'refresh_token_reuse' });
    invalidateSession(reused.id);
    return { error: 'reuse', session: reused };
  }
  if (session.revoked_at || session.expires_at <= now) return { error: 'expired', session };

  const next = randomToken(32);
  await session.update({ previous_token_hash: hash, refresh_token_hash: sha256(next), rotated_at: now, last_used_at: now });
  setAuthCookies(res, {
    accessToken: signAccess({ userId: session.user_id, sessionId: session.id, tenantId: session.active_tenant_id }),
    refreshToken: next,
    refreshExpires: session.expires_at,
  });
  return { session };
}

async function revoke(sessionId, reason) {
  await UserSession.update({ revoked_at: new Date(), revoked_reason: reason }, { where: { id: sessionId, revoked_at: null } });
  invalidateSession(sessionId);
}

async function revokeAllForUser(userId, reason, { exceptSessionId } = {}) {
  const where = { user_id: userId, revoked_at: null, ...(exceptSessionId ? { id: { [Op.ne]: exceptSessionId } } : {}) };
  const sessions = await UserSession.findAll({ where, attributes: ['id'] });
  await UserSession.update({ revoked_at: new Date(), revoked_reason: reason }, { where });
  sessions.forEach((s) => invalidateSession(s.id));
}

async function switchTenant(res, session, tenantId) {
  await UserSession.update({ active_tenant_id: tenantId }, { where: { id: session.id } });
  invalidateSession(session.id);
  setAuthCookies(res, { accessToken: signAccess({ userId: session.user_id, sessionId: session.id, tenantId }) });
}

module.exports = { createSession, rotate, revoke, revokeAllForUser, switchTenant, activeMemberships, pickTenant };
