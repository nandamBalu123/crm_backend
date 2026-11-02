'use strict';

const env = require('../config/env');
const { COOKIE } = require('../modules/auth/tokens');
const { forbidden } = require('../errors/AppError');
const { safeEqual } = require('../utils/crypto');

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function originAllowed(req) {
  const origin = req.get('origin');
  if (!origin) return true; // non-browser clients; cookies still require the CSRF header below
  return env.corsOrigins.includes(origin) || origin === env.API_URL;
}

/**
 * CSRF protection for cookie-authenticated requests: unsafe methods must
 * carry X-CSRF-Token equal to the crm_csrf cookie (double submit) and come
 * from an allowed Origin. API-key requests are not cookie based and skip this.
 */
function csrfProtection(req, _res, next) {
  if (SAFE.has(req.method) || req.ctx?.authType === 'api_key') return next();
  if (!originAllowed(req)) return next(forbidden('Origin not allowed', 'CSRF_ORIGIN'));
  const cookie = req.cookies?.[COOKIE.csrf];
  const header = req.get('x-csrf-token');
  if (!cookie || !header || !safeEqual(cookie, header)) return next(forbidden('CSRF token missing or invalid', 'CSRF_INVALID'));
  return next();
}

/** For unauthenticated state-changing endpoints (login, register): Origin check only (login CSRF). */
function originCheck(req, _res, next) {
  if (SAFE.has(req.method)) return next();
  if (!originAllowed(req)) return next(forbidden('Origin not allowed', 'CSRF_ORIGIN'));
  return next();
}

module.exports = { csrfProtection, originCheck };
