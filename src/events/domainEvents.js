'use strict';

const { getContext } = require('../context/requestContext');
const { uuidv7 } = require('../utils/ids');
const queue = require('../jobs/queue');
const { logger } = require('../logging/logger');

/**
 * Domain events. publish() writes a durable `events.dispatch` job in the
 * caller's transaction; the dispatcher fans the event out to workflows,
 * outgoing webhooks and notifications in the background. In-process
 * subscribers (cache invalidation etc.) run after commit.
 *
 * Event shape: { id, type, tenant_id, entity_type, entity_id, data, actor_user_id, occurred_at, workflow_depth }
 */
const subscribers = new Map();

function subscribe(type, fn) {
  if (!subscribers.has(type)) subscribers.set(type, []);
  subscribers.get(type).push(fn);
}

async function publish(type, { entityType = null, entityId = null, data = {}, changes = null } = {}, { transaction } = {}) {
  const ctx = getContext() || {};
  const event = {
    id: uuidv7(),
    type,
    tenant_id: ctx.tenantId,
    entity_type: entityType,
    entity_id: entityId,
    data,
    changes,
    actor_user_id: ctx.userId || null,
    occurred_at: new Date().toISOString(),
    workflow_depth: ctx.workflowDepth || 0,
  };
  await queue.enqueue('events.dispatch', event, { transaction, priority: 50 });
  const local = [...(subscribers.get(type) || []), ...(subscribers.get('*') || [])];
  if (local.length) {
    const runLocal = () => {
      for (const fn of local) {
        Promise.resolve()
          .then(() => fn(event))
          .catch((err) => logger.error({ err, type }, 'event subscriber failed'));
      }
    };
    if (transaction) transaction.afterCommit(runLocal);
    else runLocal();
  }
  return event;
}

module.exports = { publish, subscribe };
