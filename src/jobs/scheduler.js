'use strict';

const queue = require('./queue');

/**
 * Recurring platform jobs. Each run is enqueued with a unique key per time
 * slot, so with many workers exactly one instance of each slot is created.
 * Handlers iterate tenants themselves and process each in its tenant context.
 */
const SCHEDULES = [
  { type: 'sla.check', everyMinutes: 1 },
  { type: 'activities.reminders', everyMinutes: 1 },
  { type: 'workflows.scheduled', everyMinutes: 5 },
  { type: 'webhooks.retry', everyMinutes: 1 },
  { type: 'deals.stalled', everyMinutes: 24 * 60 },
  { type: 'activities.overdue_digest', everyMinutes: 24 * 60 },
  { type: 'quotes.expire', everyMinutes: 60 },
  { type: 'reports.scheduled', everyMinutes: 15 },
  { type: 'retention.purge', everyMinutes: 24 * 60 },
];

async function enqueueDue(now = Date.now()) {
  for (const s of SCHEDULES) {
    if (!queue.handlers.has(s.type)) continue;
    const slot = Math.floor(now / (s.everyMinutes * 60_000));
    await queue.enqueue(s.type, { slot }, { tenantId: null, uniqueKey: `schedule:${s.type}:${slot}`, priority: 200, maxAttempts: 3 });
  }
}

module.exports = { enqueueDue, SCHEDULES };
