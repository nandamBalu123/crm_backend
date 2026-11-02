'use strict';

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const env = require('../../config/env');

const ISSUER = 'crm-saas';
const AUDIENCE = 'crm-saas-api';

const COOKIE = { access: 'crm_at', refresh: 'crm_rt', csrf: 'crm_csrf' };

function signAccess({ userId, sessionId, tenantId }) {
  return jwt.sign({ sid: sessionId, tid: tenantId || null, typ: 'access' }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256', subject: userId, issuer: ISSUER, audience: AUDIENCE, expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  });
}

function verifyAccess(token) {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE });
  if (payload.typ !== 'access') throw new Error('wrong token type');
  return payload;
}

function signMfaChallenge(userId) {
  return jwt.sign({ typ: 'mfa' }, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', subject: userId, issuer: ISSUER, audience: `${AUDIENCE}:mfa`, expiresIn: 300 });
}

function verifyMfaChallenge(token) {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'], issuer: ISSUER, audience: `${AUDIENCE}:mfa` });
  if (payload.typ !== 'mfa') throw new Error('wrong token type');
  return payload.sub;
}

const baseCookie = () => ({
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SAMESITE,
  domain: env.COOKIE_DOMAIN || undefined,
});

function setAuthCookies(res, { accessToken, refreshToken, refreshExpires }) {
  res.cookie(COOKIE.access, accessToken, { ...baseCookie(), path: '/api', maxAge: env.ACCESS_TOKEN_TTL_SECONDS * 1000 });
  if (refreshToken) res.cookie(COOKIE.refresh, refreshToken, { ...baseCookie(), path: '/api/v1/auth', expires: refreshExpires });
  issueCsrf(res);
}

/** Double-submit CSRF token: readable cookie that the SPA echoes in the X-CSRF-Token header. */
function issueCsrf(res) {
  const token = crypto.randomBytes(24).toString('base64url');
  res.cookie(COOKIE.csrf, token, { ...baseCookie(), httpOnly: false, path: '/' });
  return token;
}

function clearAuthCookies(res) {
  const b = baseCookie();
  res.clearCookie(COOKIE.access, { ...b, path: '/api' });
  res.clearCookie(COOKIE.refresh, { ...b, path: '/api/v1/auth' });
  res.clearCookie(COOKIE.csrf, { ...b, httpOnly: false, path: '/' });
}

module.exports = { COOKIE, signAccess, verifyAccess, signMfaChallenge, verifyMfaChallenge, setAuthCookies, clearAuthCookies, issueCsrf };
