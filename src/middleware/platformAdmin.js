'use strict';

const env = require('../config/env');
const { forbidden } = require('../errors/AppError');

/**
 * Platform super-admin gate. Platform admins are flagged only via the CLI
 * (`npm run platform:grant-admin`), must use cookie auth (no API keys) and,
 * in production, must have MFA enabled and verified for the session.
 * Every platform route writes a platform audit log entry.
 */
function requirePlatformAdmin(req, _res, next) {
  const ctx = req.ctx;
  if (!ctx.user?.is_platform_admin || ctx.authType !== 'cookie') return next(forbidden('Platform administrator access required', 'PLATFORM_ADMIN_REQUIRED'));
  if (env.isProd && (!ctx.user.mfa_enabled || !ctx.mfaVerified)) return next(forbidden('Platform administrators must use MFA', 'MFA_REQUIRED'));
  ctx.isPlatformAdminAction = true;
  return next();
}

module.exports = { requirePlatformAdmin };
