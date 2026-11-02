'use strict';

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const env = require('../config/env');
const { tooMany } = require('../errors/AppError');

// In-memory stores are per instance. For multi-instance deployments put a
// shared limiter at the edge (load balancer / API gateway) — see docs/SECURITY.md.
const handler = (_req, _res, next) => next(tooMany());
const common = { standardHeaders: 'draft-8', legacyHeaders: false, handler };

const globalLimiter = rateLimit({ ...common, windowMs: env.RATE_LIMIT_WINDOW_MS, limit: env.RATE_LIMIT_MAX, keyGenerator: (req) => ipKeyGenerator(req.ip) });

const authLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: env.AUTH_RATE_LIMIT_MAX,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}|${String(req.body?.email || '').toLowerCase().slice(0, 254)}`,
});

const publicLimiter = rateLimit({ ...common, windowMs: 60 * 1000, limit: Math.min(env.RATE_LIMIT_MAX, 30), keyGenerator: (req) => ipKeyGenerator(req.ip) });

/** Per-tenant and per-API-key limits, keyed by the authenticated identity rather than IP. */
const tenantLimiter = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  limit: (req) => (req.ctx?.apiKeyId ? req.ctx.apiKeyRateLimit || 120 : env.RATE_LIMIT_MAX),
  keyGenerator: (req) => (req.ctx?.apiKeyId ? `key:${req.ctx.apiKeyId}` : `tenant:${req.ctx?.tenantId}:user:${req.ctx?.userId}`),
});

module.exports = { globalLimiter, authLimiter, publicLimiter, tenantLimiter };
