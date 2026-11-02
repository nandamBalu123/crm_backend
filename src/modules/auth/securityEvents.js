'use strict';

const { SecurityEvent } = require('../../models');
const { getContext } = require('../../context/requestContext');
const { logger } = require('../../logging/logger');

/** Records authentication/security events (user-level, independent of tenant). */
async function securityEvent(event, { userId = null, email = null, metadata = null } = {}) {
  const ctx = getContext() || {};
  try {
    await SecurityEvent.create({ event, user_id: userId, email, ip: ctx.ip, user_agent: ctx.userAgent?.slice(0, 400), metadata });
  } catch (err) {
    logger.error({ err, event }, 'failed to record security event');
  }
  logger.info({ securityEvent: event, userId, requestId: ctx.requestId }, 'security event');
}

module.exports = { securityEvent };
