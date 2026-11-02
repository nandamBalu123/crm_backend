'use strict';

const crypto = require('node:crypto');
const { run } = require('../context/requestContext');

/** Creates the AsyncLocalStorage store for the request and assigns a request id. */
function requestContext(req, res, next) {
  const incoming = req.get('x-request-id');
  const requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', requestId);
  req.id = requestId;
  const store = { requestId, ip: req.ip, userAgent: req.get('user-agent') || null };
  req.ctx = store;
  run(store, () => next());
}

module.exports = { requestContext };
