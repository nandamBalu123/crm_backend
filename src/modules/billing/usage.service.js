'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize, TenantUsage } = require('../../models');
const { getContext } = require('../../context/requestContext');
const { uuidv7 } = require('../../utils/ids');
const { logger } = require('../../logging/logger');

const day = () => new Date().toISOString().slice(0, 10);
const month = () => new Date().toISOString().slice(0, 7);

/**
 * Usage metering with an atomic upsert. This is one of the few raw SQL
 * statements in the codebase; tenant_id comes exclusively from the verified
 * request context and is bound as a parameter.
 */
async function increment(metric, amount = 1, { period = 'day' } = {}) {
  const tenantId = getContext()?.tenantId;
  if (!tenantId) return;
  const p = period === 'month' ? month() : day();
  try {
    await sequelize.query(
      'INSERT INTO tenant_usage (id, tenant_id, metric, period, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NOW(3), NOW(3)) ' +
        'ON DUPLICATE KEY UPDATE value = value + VALUES(value), updated_at = NOW(3)',
      { replacements: [uuidv7(), tenantId, metric, p, amount], type: QueryTypes.INSERT }
    );
  } catch (err) {
    logger.warn({ err: err.message, metric }, 'usage metering failed');
  }
}

async function summary({ days = 30 } = {}) {
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const { Op } = require('sequelize');
  return TenantUsage.findAll({ where: { period: { [Op.gte]: since } }, order: [['period', 'ASC']] });
}

/** Express middleware: meters API calls per tenant per day. */
function meterApiCalls(req, _res, next) {
  if (req.ctx?.tenantId) increment(req.ctx.apiKeyId ? 'api_calls' : 'app_requests');
  next();
}

module.exports = { increment, summary, meterApiCalls };
