'use strict';

const env = require('../config/env');
const queue = require('./queue');
const scheduler = require('./scheduler');
const { logger } = require('../logging/logger');

/** Poll loop for the DB-backed job queue. Safe to run on many instances (SKIP LOCKED). */
function startWorker({ pollMs = env.JOBS_POLL_MS } = {}) {
  let stopped = false;
  let timer = null;
  let running = Promise.resolve();
  let lastRecovery = 0;

  const tick = async () => {
    if (stopped) return;
    try {
      if (Date.now() - lastRecovery > 60_000) {
        lastRecovery = Date.now();
        await queue.recoverStale();
        await scheduler.enqueueDue();
      }
      const batch = await queue.claimBatch(10);
      for (const job of batch) await queue.execute(job);
      if (batch.length && !stopped) {
        running = tick();
        return;
      }
    } catch (err) {
      logger.error({ err }, 'worker tick failed');
    }
    if (!stopped) timer = setTimeout(() => { running = tick(); }, pollMs);
  };
  timer = setTimeout(() => { running = tick(); }, 250);
  logger.info({ workerId: queue.WORKER_ID }, 'job worker started');
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
      logger.info('job worker stopped');
    },
  };
}

module.exports = { startWorker };
