'use strict';

const { Activity } = require('../../models');

function addInterval(date, freq, interval) {
  const d = new Date(date);
  if (freq === 'daily') d.setUTCDate(d.getUTCDate() + interval);
  else if (freq === 'weekly') d.setUTCDate(d.getUTCDate() + 7 * interval);
  else d.setUTCMonth(d.getUTCMonth() + interval);
  return d;
}

/** When a recurring activity is completed, create the next occurrence (bounded by count/until). */
async function scheduleNext(record, transaction) {
  const rule = record.recurrence;
  const parentId = record.recurrence_parent_id || record.id;
  const done = await Activity.count({ where: { recurrence_parent_id: parentId }, transaction });
  if (rule.count && done + 1 >= rule.count) return null;
  const anchor = record.due_at || record.start_at || new Date();
  const nextDue = addInterval(anchor, rule.freq, rule.interval || 1);
  if (rule.until && nextDue > new Date(`${rule.until}T23:59:59Z`)) return null;
  const shift = (d) => (d ? new Date(new Date(d).getTime() + (nextDue - new Date(anchor))) : null);
  return Activity.create({
    type: record.type, subject: record.subject, description: record.description, priority: record.priority, owner_id: record.owner_id,
    created_by_user_id: record.created_by_user_id, lead_id: record.lead_id, contact_id: record.contact_id, account_id: record.account_id,
    opportunity_id: record.opportunity_id, ticket_id: record.ticket_id, recurrence: rule, recurrence_parent_id: parentId,
    due_at: record.due_at ? nextDue : null, start_at: shift(record.start_at), end_at: shift(record.end_at), reminder_at: shift(record.reminder_at),
    location: record.location, all_day: record.all_day,
  }, { transaction });
}

module.exports = { scheduleNext, addInterval };
