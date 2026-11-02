'use strict';

const { Op } = require('sequelize');
const { Ticket, SlaPolicy, Team } = require('../../models');
const queue = require('../../jobs/queue');
const { runAsSystem, runInTenant } = require('../../context/requestContext');
const timeline = require('../timeline/timeline.service');
const notifications = require('../notifications/notifications.service');
const events = require('../../events/domainEvents');

/**
 * Every minute: find unresolved tickets whose first-response or resolution
 * deadline passed, flag the breach, bump the escalation level and notify the
 * assignee and the SLA escalation contact / team manager. Each escalation
 * level is applied once per ticket.
 */
async function checkSla() {
  const now = new Date();
  const due = await runAsSystem('sla:scan', () => Ticket.findAll({
    where: {
      status: { [Op.in]: ['new', 'open', 'pending', 'on_hold'] },
      [Op.or]: [
        { first_responded_at: null, first_response_due_at: { [Op.lt]: now }, escalation_level: 0 },
        { resolution_due_at: { [Op.lt]: now }, escalation_level: { [Op.lt]: 2 } },
      ],
    },
    attributes: ['id', 'tenant_id'],
    limit: 2000,
  }));
  let escalated = 0;
  for (const t of due) {
    await runInTenant(t.tenant_id, async () => {
      const ticket = await Ticket.findByPk(t.id);
      if (!ticket) return;
      const resolutionBreached = ticket.resolution_due_at && ticket.resolution_due_at < now;
      const level = resolutionBreached ? 2 : 1;
      if (ticket.escalation_level >= level) return;
      await ticket.update({ escalation_level: level, escalated_at: now, sla_breached: resolutionBreached || ticket.sla_breached });
      const what = resolutionBreached ? 'resolution' : 'first response';
      await timeline.add('ticket', ticket.id, 'sla_escalated', `SLA ${what} target missed — escalated to level ${level}`);
      const policy = ticket.sla_policy_id ? await SlaPolicy.findByPk(ticket.sla_policy_id) : null;
      const team = ticket.team_id ? await Team.findByPk(ticket.team_id) : null;
      const recipients = new Set([ticket.owner_id, policy?.escalate_to_user_id, team?.manager_user_id].filter(Boolean));
      for (const userId of recipients) {
        await notifications.notify(userId, { type: 'ticket.escalated', title: `SLA ${what} missed: #${ticket.number}`, body: ticket.subject, link: `/tickets/${ticket.id}`, entity_type: 'ticket', entity_id: ticket.id });
      }
      await events.publish('ticket.sla_breached', { entityType: 'ticket', entityId: ticket.id, data: { level, type: what } });
      escalated += 1;
    }, { actorLabel: 'sla-monitor' });
  }
  return { scanned: due.length, escalated };
}

queue.register('sla.check', checkSla, { maxAttempts: 2 });

module.exports = { checkSla };
