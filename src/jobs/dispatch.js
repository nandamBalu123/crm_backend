'use strict';

const queue = require('./queue');
const { logger } = require('../logging/logger');

/**
 * Fan-out of domain events (from the `events.dispatch` job) to registered
 * targets: workflow engine, outgoing webhooks, notification rules. Each target
 * runs inside the event's tenant context (set by the job runner). A failing
 * target throws so the job is retried; targets must therefore be idempotent
 * (they key their side effects on event.id).
 */
const targets = [];

function registerDispatchTarget(name, fn) {
  targets.push({ name, fn });
}

queue.register('events.dispatch', async (event) => {
  const failures = [];
  for (const t of targets) {
    try {
      await t.fn(event);
    } catch (err) {
      logger.warn({ target: t.name, eventType: event.type, err: err.message }, 'event target failed');
      failures.push(`${t.name}: ${err.message}`);
    }
  }
  if (failures.length) throw new Error(failures.join('; '));
  return { targets: targets.length };
}, { maxAttempts: 5 });

module.exports = { registerDispatchTarget };
