'use strict';

const { Op, fn, col } = require('sequelize');
const models = require('../../models');
const queue = require('../queue');
const { runAsSystem, runInTenant } = require('../../context/requestContext');
const notifications = require('../../modules/notifications/notifications.service');
const { loadTenant } = require('../../middleware/tenantContext');
const { driver } = require('../../storage');
const quotes = require('../../modules/quotes/quotes.service');
const { logger } = require('../../logging/logger');

const { Activity, Opportunity, PipelineStage, AuditLog, WorkflowRun, Notification, IdempotencyKey, Job, Attachment, Tenant } = models;
const today = () => new Date().toISOString().slice(0, 10);

/** Activity reminders (every minute). */
queue.register('activities.reminders', async () => {
  const due = await runAsSystem('reminders:scan', () => Activity.findAll({ where: { status: 'open', reminder_at: { [Op.lte]: new Date() }, reminder_sent_at: null }, attributes: ['id', 'tenant_id'], limit: 1000 }));
  for (const a of due) {
    await runInTenant(a.tenant_id, async () => {
      const act = await Activity.findByPk(a.id);
      if (!act || act.reminder_sent_at) return;
      await act.update({ reminder_sent_at: new Date() }, { silent: true });
      if (act.owner_id) await notifications.notify(act.owner_id, { type: 'activity.reminder', title: `Reminder: ${act.subject}`, body: act.due_at ? `Due ${act.due_at.toISOString()}` : null, link: `/activities/${act.id}`, entity_type: 'activity', entity_id: act.id });
    });
  }
  return { reminded: due.length };
});

/** Daily overdue digest per owner (one notification per user per day). */
queue.register('activities.overdue_digest', async () => {
  const rows = await runAsSystem('overdue:scan', () => Activity.findAll({ where: { status: 'open', due_at: { [Op.lt]: new Date() }, owner_id: { [Op.ne]: null } }, attributes: ['tenant_id', 'owner_id', [fn('COUNT', col('id')), 'n']], group: ['tenant_id', 'owner_id'], raw: true }));
  for (const r of rows) {
    await runInTenant(r.tenant_id, () => notifications.notify(r.owner_id, { type: 'activity.overdue', title: `You have ${r.n} overdue activit${Number(r.n) === 1 ? 'y' : 'ies'}`, link: '/activities?filter[status]=open&overdue=1' }));
  }
  return { users: rows.length };
});

/** Daily stalled-deal alerts: open deals that stayed in their stage longer than the stage rotting days (or tenant default). */
queue.register('deals.stalled', async () => {
  const candidates = await runAsSystem('stalled:scan', () => Opportunity.findAll({
    where: { status: 'open', stage_entered_at: { [Op.lt]: new Date(Date.now() - 86400_000) } },
    include: [{ model: PipelineStage, as: 'stage', attributes: ['rotting_days', 'name'] }],
    attributes: ['id', 'tenant_id', 'owner_id', 'name', 'stage_entered_at', 'last_activity_at'], limit: 10000,
  }));
  let alerted = 0;
  const settingsCache = new Map();
  for (const o of candidates) {
    if (!settingsCache.has(o.tenant_id)) settingsCache.set(o.tenant_id, (await loadTenant(o.tenant_id))?.settings);
    const days = o.stage?.rotting_days || Number(settingsCache.get(o.tenant_id)?.preferences?.stalled_deal_days) || 14;
    const anchor = new Date(Math.max(new Date(o.stage_entered_at).getTime(), o.last_activity_at ? new Date(o.last_activity_at).getTime() : 0));
    if (Date.now() - anchor.getTime() < days * 86400_000 || !o.owner_id) continue;
    await runInTenant(o.tenant_id, () => notifications.notify(o.owner_id, { type: 'deal.stalled', title: `Stalled deal: ${o.name}`, body: `No progress in "${o.stage?.name}" for ${days}+ days`, link: `/opportunities/${o.id}`, entity_type: 'opportunity', entity_id: o.id }));
    alerted += 1;
  }
  return { alerted };
});

queue.register('quotes.expire', () => quotes.expireAll());

/**
 * Daily retention purge per tenant settings. Audit logs older than
 * retention.audit_days, workflow runs, read notifications, expired
 * idempotency keys, finished jobs, and soft-deleted attachments (file
 * content removed from storage) older than retention.deleted_records_days.
 */
queue.register('retention.purge', async () => {
  const tenants = await runAsSystem('retention:tenants', () => Tenant.findAll({ attributes: ['id'] }));
  const summary = { tenants: tenants.length, audit: 0, files: 0 };
  for (const t of tenants) {
    await runInTenant(t.id, async () => {
      const s = (await loadTenant(t.id))?.settings?.preferences?.retention || {};
      const ago = (d) => new Date(Date.now() - d * 86400_000);
      summary.audit += await AuditLog.destroy({ where: { created_at: { [Op.lt]: ago(s.audit_days || 365) } }, retentionPurge: true });
      await WorkflowRun.destroy({ where: { created_at: { [Op.lt]: ago(s.workflow_runs_days || 90) } } });
      await Notification.destroy({ where: { read_at: { [Op.lt]: ago(90) } } });
      await IdempotencyKey.destroy({ where: { expires_at: { [Op.lt]: new Date() } } });
      const files = await Attachment.findAll({ where: { deleted_at: { [Op.lt]: ago(s.deleted_records_days || 30) } }, paranoid: false, limit: 1000 });
      for (const f of files) {
        try {
          await driver(f.storage_driver).remove(f.storage_key);
          await f.destroy({ force: true });
          summary.files += 1;
        } catch (err) {
          logger.warn({ attachmentId: f.id, err: err.message }, 'file purge failed');
        }
      }
    }, { actorLabel: 'retention' });
  }
  await runAsSystem('retention:jobs', () => Job.destroy({ where: { status: 'completed', completed_at: { [Op.lt]: new Date(Date.now() - 7 * 86400_000) } } }));
  return summary;
}, { maxAttempts: 2 });

module.exports = { today };
