'use strict';

const { Op } = require('sequelize');
const { Report } = require('../../models');
const queue = require('../../jobs/queue');
const analytics = require('./analytics.service');
const { loadSnapshot } = require('../rbac/permission.service');
const { queueEmail, layout } = require('../../integrations/mail/mailer');
const { runAsSystem, runInTenant, getContext } = require('../../context/requestContext');
const env = require('../../config/env');

/**
 * Scheduled report delivery. Each report runs with its OWNER's current
 * permissions and record scope (never elevated), and is emailed only to
 * workspace members (validated when the schedule is saved).
 */
async function runScheduledReports() {
  const due = await runAsSystem('reports:scheduled-scan', () => Report.findAll({ where: { next_run_at: { [Op.lte]: new Date() } }, attributes: ['id', 'tenant_id'], limit: 500 }));
  let sent = 0;
  for (const d of due) {
    await runInTenant(d.tenant_id, async () => {
      const rep = await Report.findByPk(d.id);
      if (!rep?.schedule) return;
      const { toCsv, nextRun } = require('./reports.routes');
      await rep.update({ next_run_at: nextRun(rep.schedule) });
      const snap = await loadSnapshot(d.tenant_id, rep.owner_id);
      if (!snap || snap.membership.status !== 'active') return;
      Object.assign(getContext(), { userId: rep.owner_id, permissions: snap.permissions, teamUserIds: snap.teamUserIds, fieldAccess: snap.fieldAccess, isOwner: snap.membership.is_owner });
      const result = await analytics.runReport(rep.get({ plain: true }));
      const csv = toCsv(result);
      const preview = (result.rows || []).slice(0, 10).map((x) => `${x.label || x.group || ''}: ${x.value ?? ''}`).join('\n');
      for (const to of rep.schedule.recipients) {
        const { html, text } = layout({ heading: rep.name, intro: `Your scheduled report is ready (${result.rows?.length || 0} rows).\n${preview}`, actionUrl: `${env.APP_URL}/reports/${rep.id}`, actionLabel: 'Open report' });
        await queueEmail({ to, subject: `Report: ${rep.name}`, html: `${html}<pre>${csv.slice(0, 20000).replace(/</g, '&lt;')}</pre>`, text: `${text}\n\n${csv.slice(0, 20000)}`, templateKey: 'scheduled_report' });
        sent += 1;
      }
    }, { actorLabel: 'report-scheduler' });
  }
  return { reports: due.length, emails: sent };
}

queue.register('reports.scheduled', runScheduledReports, { maxAttempts: 2 });
module.exports = { runScheduledReports };
