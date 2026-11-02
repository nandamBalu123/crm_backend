'use strict';

const { Op } = require('sequelize');
const { Notification, NotificationPreference, User } = require('../../models');
const { queueEmail, layout } = require('../../integrations/mail/mailer');
const env = require('../../config/env');

/**
 * In-app notification (+ optional email per user preference). Notifications
 * are always created inside the current tenant, so they can never reach a
 * user of another tenant.
 */
async function notify(userId, { type, title, body = null, link = null, entity_type = null, entity_id = null }, { transaction } = {}) {
  const pref = await NotificationPreference.findOne({ where: { user_id: userId, type }, transaction });
  const inApp = pref ? pref.in_app : true;
  const email = pref ? pref.email : false;
  let n = null;
  if (inApp) n = await Notification.create({ user_id: userId, type, title: title.slice(0, 200), body: body ? String(body).slice(0, 1000) : null, link, entity_type, entity_id }, { transaction });
  if (email) {
    const user = await User.findByPk(userId, { transaction, attributes: ['email', 'first_name'] });
    if (user) {
      const { html, text } = layout({ heading: title, intro: body || title, actionUrl: link ? `${env.APP_URL}${link}` : null, actionLabel: 'Open in CRM' });
      await queueEmail({ to: user.email, subject: title, html, text, templateKey: `notification:${type}` }, { transaction });
    }
  }
  return n;
}

async function list(userId, { unread, limit = 30, before }) {
  const where = { user_id: userId };
  if (unread) where.read_at = null;
  if (before) where.created_at = { [Op.lt]: new Date(before) };
  const [items, unreadCount] = await Promise.all([
    Notification.findAll({ where, order: [['created_at', 'DESC']], limit: Math.min(100, limit) }),
    Notification.count({ where: { user_id: userId, read_at: null } }),
  ]);
  return { items, unread_count: unreadCount };
}

async function markRead(userId, ids) {
  const where = { user_id: userId, read_at: null };
  if (ids?.length) where.id = ids;
  const [count] = await Notification.update({ read_at: new Date() }, { where });
  return count;
}

const TYPES = [
  { type: 'record.assigned', label: 'A record is assigned to me' },
  { type: 'activity.reminder', label: 'Activity reminders' },
  { type: 'activity.overdue', label: 'Overdue activities' },
  { type: 'deal.stalled', label: 'Stalled deals' },
  { type: 'ticket.escalated', label: 'Ticket escalations' },
  { type: 'quote.approval_requested', label: 'Quote approval requests' },
  { type: 'quote.approval_decided', label: 'Quote approval decisions' },
  { type: 'workflow.notification', label: 'Workflow notifications' },
  { type: 'import.completed', label: 'Import finished' },
  { type: 'mention', label: 'Mentions' },
];

async function preferences(userId) {
  const rows = await NotificationPreference.findAll({ where: { user_id: userId } });
  const byType = new Map(rows.map((r) => [r.type, r]));
  return TYPES.map((t) => ({ ...t, in_app: byType.get(t.type)?.in_app ?? true, email: byType.get(t.type)?.email ?? false }));
}

async function setPreferences(userId, prefs) {
  const allowed = new Set(TYPES.map((t) => t.type));
  for (const p of prefs) {
    if (!allowed.has(p.type)) continue;
    const [row] = await NotificationPreference.findOrCreate({ where: { user_id: userId, type: p.type }, defaults: { user_id: userId, type: p.type } });
    await row.update({ in_app: p.in_app, email: p.email });
  }
  return preferences(userId);
}

module.exports = { notify, list, markRead, preferences, setPreferences, TYPES };
