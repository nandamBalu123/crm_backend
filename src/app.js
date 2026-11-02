'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const pinoHttp = require('pino-http');
const env = require('./config/env');
const { logger } = require('./logging/logger');
const { requestContext } = require('./middleware/requestContext');
const { authenticate } = require('./middleware/authenticate');
const { csrfProtection } = require('./middleware/csrf');
const { tenantContext, requireVerifiedEmail } = require('./middleware/tenantContext');
const { globalLimiter, tenantLimiter } = require('./middleware/rateLimits');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const { meterApiCalls } = require('./modules/billing/usage.service');
const { buildOpenApi } = require('./openapi/generator');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  const tp = env.TRUST_PROXY;
  app.set('trust proxy', tp === 'true' ? true : tp === 'false' ? false : /^\d+$/.test(tp) ? Number(tp) : tp);
  app.set('query parser', 'extended');

  app.use(requestContext);
  app.use(pinoHttp({
    logger,
    genReqId: (req) => req.id,
    autoLogging: { ignore: (req) => req.url.startsWith('/health') },
    customProps: (req) => ({ tenantId: req.ctx?.tenantId, userId: req.ctx?.userId }),
    serializers: { req: (req) => ({ id: req.id, method: req.method, url: req.url.split('?')[0] }), res: (res) => ({ statusCode: res.statusCode }) },
  }));
  app.use(helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
    strictTransportSecurity: env.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
  }));
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || env.corsOrigins.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key', 'If-Match', 'Authorization', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Content-Disposition', 'RateLimit', 'RateLimit-Policy', 'Idempotent-Replayed'],
    maxAge: 600,
  }));
  app.use(cookieParser());
  // Raw body is retained for webhook signature verification.
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { if (req.originalUrl.startsWith('/api/v1/public/')) req.rawBody = buf; } }));
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use(require('./modules/health/health.routes'));
  app.use(globalLimiter);
  app.get('/api/v1/openapi.json', (_req, res) => res.json(buildOpenApi()));

  // Public endpoints (lead forms, unsubscribe, inbound webhooks, file links).
  app.use(require('./modules/public/public.routes'));

  // Authentication.
  const auth = require('./modules/auth/auth.routes');
  app.use('/api/v1/auth', auth.publicRouter);
  app.use('/api/v1/auth', auth.userRouter);

  // Platform administration (separate authorization model).
  app.use('/api/v1/platform', require('./modules/platform/platform.routes'));

  // Tenant API.
  const tenantApi = express.Router();
  tenantApi.use(authenticate(), csrfProtection, tenantContext, requireVerifiedEmail, tenantLimiter, meterApiCalls);
  for (const r of require('./routes')()) tenantApi.use(r.prefix, r.router);
  app.use(tenantApi);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
