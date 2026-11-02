'use strict';

const { Op } = require('sequelize');
const { User, UserSession, ApiKey } = require('../models');
const { verifyAccess, COOKIE } = require('../modules/auth/tokens');
const { sha256, safeEqual } = require('../utils/crypto');
const { runAsSystem } = require('../context/requestContext');
const { unauthorized } = require('../errors/AppError');
const { TtlCache } = require('../utils/ttlCache');

const sessionCache = new TtlCache(10_000);
const apiKeyCache = new TtlCache(10_000);

function invalidateSession(sessionId) {
  sessionCache.delete(sessionId);
}
function invalidateUserSessions() {
  sessionCache.clear();
}
function invalidateApiKey(prefix) {
  apiKeyCache.delete(prefix);
}

async function loadSession(sessionId, userId) {
  let entry = sessionCache.get(sessionId);
  if (!entry) {
    const session = await UserSession.findOne({ where: { id: sessionId, user_id: userId, revoked_at: null, expires_at: { [Op.gt]: new Date() } } });
    if (!session) return null;
    const user = await User.findByPk(userId);
    if (!user || user.status !== 'active') return null;
    entry = sessionCache.set(sessionId, { session: session.get({ plain: true }), user });
  }
  return entry;
}

async function authenticateApiKey(req, raw) {
  // Format: crm_<prefix>_<secret>
  const m = /^crm_([A-Za-z0-9]{8,16})_([A-Za-z0-9_-]{20,})$/.exec(raw);
  if (!m) throw unauthorized('Invalid API key', 'INVALID_API_KEY');
  const prefix = m[1];
  let key = apiKeyCache.get(prefix);
  if (!key) {
    key = await runAsSystem('api-key:lookup', () => ApiKey.findOne({ where: { prefix } }));
    if (key) apiKeyCache.set(prefix, key);
  }
  if (!key || !safeEqual(key.key_hash, sha256(raw))) throw unauthorized('Invalid API key', 'INVALID_API_KEY');
  if (key.revoked_at) throw unauthorized('API key revoked', 'INVALID_API_KEY');
  if (key.expires_at && new Date(key.expires_at) < new Date()) throw unauthorized('API key expired', 'INVALID_API_KEY');
  const user = await User.findByPk(key.created_by_user_id);
  if (!user || user.status !== 'active') throw unauthorized('API key owner is inactive', 'INVALID_API_KEY');
  Object.assign(req.ctx, {
    authType: 'api_key',
    apiKeyId: key.id,
    apiKeyPrefix: key.prefix,
    apiKeyScopes: key.scopes,
    apiKeyRateLimit: key.rate_limit_per_minute,
    tenantId: key.tenant_id,
    userId: user.id,
    userEmail: user.email,
    user,
  });
  // Last-used tracking is best effort and throttled to once a minute.
  if (!key.last_used_at || Date.now() - new Date(key.last_used_at).getTime() > 60_000) {
    key.last_used_at = new Date();
    runAsSystem('api-key:touch', () => ApiKey.update({ last_used_at: key.last_used_at, last_used_ip: req.ip }, { where: { id: key.id } })).catch(() => {});
  }
}

/**
 * Establishes the caller's identity from either an API key (Authorization:
 * Bearer crm_…) or the HttpOnly access-token cookie. Never trusts tenant ids
 * from headers, query strings or bodies: the active tenant comes from the
 * signed token (cookie) or from the API key record.
 */
function authenticate({ optional = false } = {}) {
  return async (req, _res, next) => {
    const header = req.get('authorization');
    if (header && /^Bearer crm_/i.test(header)) {
      await authenticateApiKey(req, header.slice(7).trim());
      return next();
    }
    const token = req.cookies?.[COOKIE.access];
    if (!token) {
      if (optional) return next();
      throw unauthorized();
    }
    let payload;
    try {
      payload = verifyAccess(token);
    } catch (err) {
      if (err.name === 'TokenExpiredError') throw unauthorized('Access token expired', 'TOKEN_EXPIRED');
      throw unauthorized('Invalid access token', 'INVALID_TOKEN');
    }
    const entry = await loadSession(payload.sid, payload.sub);
    if (!entry) throw unauthorized('Session expired or revoked', 'SESSION_REVOKED');
    Object.assign(req.ctx, {
      authType: 'cookie',
      userId: entry.user.id,
      userEmail: entry.user.email,
      user: entry.user,
      sessionId: payload.sid,
      tenantId: payload.tid || null,
      mfaVerified: entry.session.mfa_verified,
    });
    return next();
  };
}

module.exports = { authenticate, invalidateSession, invalidateUserSessions, invalidateApiKey };
