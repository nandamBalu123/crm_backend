'use strict';

const express = require('express');
const { validate } = require('../middleware/validate');
const { requirePermission } = require('../middleware/authorize');
const { idempotency } = require('../middleware/idempotency');

/** Global registry of every routed endpoint; consumed by the OpenAPI generator. */
const registry = [];

/**
 * Declarative route builder. Each route declares its metadata once and the
 * same declaration drives validation, authorization and API documentation.
 *
 *   r.post('/', { summary, permission: 'leads:create', body: schema, idempotent: true }, controller.create)
 */
function createRouter({ prefix, tag, auth = 'tenant' }) {
  const router = express.Router({ mergeParams: true });
  const add = (method) => (path, spec, ...handlers) => {
    const s = { auth, ...spec };
    registry.push({ method, path: `${prefix}${path === '/' ? '' : path}`, tag, ...s });
    const mws = [];
    if (s.permission) mws.push(requirePermission(s.permission));
    if (s.params || s.query || s.body) mws.push(validate(s));
    if (s.idempotent) mws.push(idempotency());
    router[method](path, ...mws, ...handlers);
  };
  return { router, prefix, get: add('get'), post: add('post'), put: add('put'), patch: add('patch'), delete: add('delete') };
}

module.exports = { createRouter, registry };
