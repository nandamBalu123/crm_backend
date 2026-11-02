'use strict';

const { Op } = require('sequelize');
const { IdempotencyKey } = require('../models');
const { sha256 } = require('../utils/crypto');
const { conflict, validation } = require('../errors/AppError');

const TTL_HOURS = 24;

/**
 * Idempotency-Key support for POST endpoints. The first request with a key
 * stores its response; retries with the same key and payload replay it;
 * the same key with a different payload is rejected.
 */
function idempotency() {
  return async (req, res, next) => {
    const key = req.get('idempotency-key');
    if (!key) return next();
    if (!/^[\w.:-]{8,120}$/.test(key)) return next(validation([{ location: 'header', path: 'Idempotency-Key', message: 'Invalid idempotency key format' }]));
    const actorId = req.ctx.apiKeyId || req.ctx.userId;
    const requestHash = sha256(JSON.stringify({ m: req.method, p: req.originalUrl, b: req.body ?? null }));

    const existing = await IdempotencyKey.findOne({ where: { actor_id: actorId, key, expires_at: { [Op.gt]: new Date() } } });
    if (existing) {
      if (existing.request_hash !== requestHash) return next(validation([{ location: 'header', path: 'Idempotency-Key', message: 'Key already used with a different request' }], 'Idempotency key reuse'));
      if (existing.status_code === null) return next(conflict('A request with this idempotency key is in progress', 'IDEMPOTENCY_IN_PROGRESS'));
      res.setHeader('Idempotent-Replayed', 'true');
      return res.status(existing.status_code).json(existing.response_body);
    }
    let row;
    try {
      row = await IdempotencyKey.create({
        key, actor_id: actorId, method: req.method, path: req.originalUrl.slice(0, 300), request_hash: requestHash,
        expires_at: new Date(Date.now() + TTL_HOURS * 3600 * 1000),
      });
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError') return next(conflict('A request with this idempotency key is in progress', 'IDEMPOTENCY_IN_PROGRESS'));
      throw err;
    }
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const status = res.statusCode;
      const persist = status < 500 ? row.update({ status_code: status, response_body: body }) : row.destroy();
      persist.catch(() => {}).finally(() => originalJson(body));
      return res;
    };
    return next();
  };
}

module.exports = { idempotency };
