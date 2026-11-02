'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const { getContext } = require('../context/requestContext');

/**
 * Gap-tolerant, per-tenant counters (ticket #, quote #). Uses MySQL's
 * LAST_INSERT_ID(expr) trick for an atomic increment on one connection.
 * tenant_id comes only from the verified context and is a bound parameter.
 */
async function nextSequence(name, { transaction } = {}) {
  const tenantId = getContext()?.tenantId;
  if (!tenantId) throw new Error('nextSequence requires a tenant context');
  await sequelize.query(
    'INSERT INTO tenant_sequences (tenant_id, name, value) VALUES (?, ?, LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE value = LAST_INSERT_ID(value + 1)',
    { replacements: [tenantId, name], transaction, type: QueryTypes.INSERT }
  );
  const [row] = await sequelize.query('SELECT LAST_INSERT_ID() AS v', { transaction, type: QueryTypes.SELECT });
  return Number(row.v);
}

module.exports = { nextSequence };
