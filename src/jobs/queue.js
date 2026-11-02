'use strict';

const os = require('node:os');
const { Op } = require('sequelize');
const { Job, sequelize } = require('../models');
const { getContext, runInTenant, runAsSystem } = require('../context/requestContext');
const { logger } = require('../logging/logger');

const handlers = new Map();
const WORKER_ID = `${os.hostname()}:${process.pid}`;
const STALE_LOCK_MS = 10 * 60 * 1000;

/** Registers a job handler: fn(payload, job) → result. */
function register(type, fn, { maxAttempts = 5 } = {}) {
  handlers.set(type, { fn, maxAttempts });
}

/**
 * Durable enqueue. Called inside a business transaction the job only becomes
 * visible if the transaction commits (transactional outbox pattern).
 * tenantId defaults to the active tenant; pass null explicitly for platform jobs.
 */
async function enqueue(type, payload = {}, opts = {}) {
  const ctx = getContext() || {};
  const tenantId = opts.tenantId !== undefined ? opts.tenantId : ctx.tenantId || null;
  const def = handlers.get(type);
  try {
    return await Job.create(
      {
        tenant_id: tenantId,
        type,
        payload,
        priority: opts.priority ?? 100,
        max_attempts: opts.maxAttempts ?? def?.maxAttempts ?? 5,
        run_at: opts.runAt || new Date(),
        unique_key: opts.uniqueKey || null,
      },
      { transaction: opts.transaction }
    );
  } catch (err) {
    if (opts.uniqueKey && err.name === 'SequelizeUniqueConstraintError') return null; // already scheduled
    throw err;
  }
}

function backoffMs(attempts) {
  return Math.min(60 * 60 * 1000, 2 ** attempts * 5000);
}

async function claimBatch(limit) {
  return runAsSystem('job-queue:claim', () =>
    sequelize.transaction(async (transaction) => {
      const rows = await Job.findAll({
        where: { status: 'pending', run_at: { [Op.lte]: new Date() } },
        order: [['priority', 'ASC'], ['run_at', 'ASC']],
        limit,
        lock: transaction.LOCK.UPDATE,
        skipLocked: true,
        transaction,
      });
      if (!rows.length) return [];
      await Job.update(
        { status: 'running', locked_at: new Date(), locked_by: WORKER_ID, attempts: sequelize.literal('attempts + 1') },
        { where: { id: rows.map((r) => r.id) }, transaction }
      );
      return rows.map((r) => ({ ...r.get({ plain: true }), attempts: r.attempts + 1 }));
    })
  );
}

async function execute(job) {
  const def = handlers.get(job.type);
  const finish = (values) => runAsSystem('job-queue:finish', () => Job.update(values, { where: { id: job.id } }));
  if (!def) {
    await finish({ status: 'dead', last_error: `No handler registered for ${job.type}`, locked_at: null });
    return;
  }
  const started = Date.now();
  try {
    const run = () => def.fn(job.payload || {}, job);
    const result = job.tenant_id
      ? await runInTenant(job.tenant_id, async () => {
          const loaded = await require('../middleware/tenantContext').loadTenant(job.tenant_id);
          if (!loaded || loaded.tenant.status !== 'active') return { skipped: 'tenant inactive' };
          getContext().settings = loaded.settings;
          return run();
        }, { actorType: 'system', actorLabel: `job:${job.type}`, jobId: job.id })
      : await runAsSystem(`job:${job.type}`, run);
    await finish({ status: 'completed', completed_at: new Date(), locked_at: null, result: result ?? null, last_error: null });
    logger.debug({ jobId: job.id, type: job.type, ms: Date.now() - started }, 'job completed');
  } catch (err) {
    const dead = job.attempts >= job.max_attempts || err.permanent;
    logger.warn({ jobId: job.id, type: job.type, attempts: job.attempts, err: err.message }, dead ? 'job dead' : 'job failed, will retry');
    await finish({
      status: dead ? 'dead' : 'pending',
      run_at: new Date(Date.now() + backoffMs(job.attempts)),
      locked_at: null,
      last_error: String(err.stack || err.message).slice(0, 4000),
    });
  }
}

async function recoverStale() {
  await runAsSystem('job-queue:recover', () =>
    Job.update(
      { status: 'pending', locked_at: null },
      { where: { status: 'running', locked_at: { [Op.lt]: new Date(Date.now() - STALE_LOCK_MS) } } }
    )
  );
}

/** Processes runnable jobs until none remain (used by tests and the CLI). */
async function drain({ maxRounds = 50 } = {}) {
  let total = 0;
  for (let i = 0; i < maxRounds; i += 1) {
    const batch = await claimBatch(20);
    if (!batch.length) break;
    for (const job of batch) await execute(job);
    total += batch.length;
  }
  return total;
}

module.exports = { register, enqueue, drain, claimBatch, execute, recoverStale, handlers, WORKER_ID };
