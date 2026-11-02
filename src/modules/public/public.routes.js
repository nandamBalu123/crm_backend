'use strict';

const express = require('express');
const { publicLimiter } = require('../../middleware/rateLimits');

/**
 * Unauthenticated endpoints under /api/v1/public. Tenants are resolved only
 * from server-side lookups of high-entropy keys (form public keys, signed
 * tokens, connection keys), never from client-supplied tenant ids.
 */
const router = express.Router();
router.use('/api/v1/public', publicLimiter);
router.use(require('../forms/forms.public'));
router.use(require('../communications/unsubscribe').router);
router.use(require('../integrations/inbound.public'));
router.use(require('../attachments/attachments.routes').publicRouter);

module.exports = router;

// Document the public endpoints in the OpenAPI registry (they are plain routers).
const { registry } = require('../../utils/router');
const { z } = require('../../utils/schemas');

for (const r of [
  { method: 'get', path: '/api/v1/public/forms/:key', summary: 'Public lead form definition' },
  { method: 'post', path: '/api/v1/public/forms/:key/submit', summary: 'Submit a public lead form (honeypot, consent, origin allow-list)', body: z.object({ data: z.record(z.string(), z.any()), consent: z.boolean().optional() }) },
  { method: 'get', path: '/api/v1/public/unsubscribe/:token', summary: 'Unsubscribe link details (signed token)' },
  { method: 'post', path: '/api/v1/public/unsubscribe/:token', summary: 'Confirm unsubscribe (records consent revocation)' },
  { method: 'post', path: '/api/v1/public/inbound/:key/leads', summary: 'Signed inbound lead webhook (X-CRM-Timestamp, X-CRM-Signature, X-CRM-Event-Id)' },
  { method: 'get', path: '/api/v1/public/files/:token', summary: 'Download a file via a 5-minute signed link' },
  { method: 'get', path: '/api/v1/public/oauth/callback', summary: 'OAuth 2.0 redirect target for integrations' },
]) registry.push({ ...r, tag: 'Public', auth: 'public' });
