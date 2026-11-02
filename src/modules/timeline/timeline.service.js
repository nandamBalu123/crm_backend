'use strict';

const { Op } = require('sequelize');
const { TimelineEvent, Activity, Communication, User } = require('../../models');
const { getContext } = require('../../context/requestContext');

async function add(entityType, entityId, eventType, summary, data = null, { transaction } = {}) {
  const ctx = getContext() || {};
  return TimelineEvent.create(
    { entity_type: entityType, entity_id: entityId, event_type: eventType, summary: String(summary).slice(0, 500), data, actor_user_id: ctx.userId || null },
    { transaction }
  );
}

const actorInclude = { model: User, as: 'actor', attributes: ['id', 'first_name', 'last_name'] };

/**
 * Unified activity timeline for a record: system events + linked activities
 * + communications, newest first, cursor-paginated by timestamp (`before`).
 */
async function feed({ entityType, entityId, relationField, limit = 30, before, includeActivities = true, includeCommunications = true }) {
  const cursor = before ? { [Op.lt]: new Date(before) } : undefined;
  const ts = (w) => (cursor ? { ...w, created_at: cursor } : w);
  const [events, activities, comms] = await Promise.all([
    TimelineEvent.findAll({ where: ts({ entity_type: entityType, entity_id: entityId }), order: [['created_at', 'DESC']], limit, include: [actorInclude] }),
    includeActivities && relationField
      ? Activity.findAll({ where: ts({ [relationField]: entityId }), order: [['created_at', 'DESC']], limit, include: [{ model: User, as: 'owner', attributes: ['id', 'first_name', 'last_name'] }] })
      : [],
    includeCommunications && relationField && Communication.rawAttributes[relationField]
      ? Communication.findAll({ where: ts({ [relationField]: entityId }), order: [['created_at', 'DESC']], limit, attributes: { exclude: ['body'] } })
      : [],
  ]);
  const items = [
    ...events.map((e) => ({ kind: 'event', id: e.id, at: e.created_at, event_type: e.event_type, summary: e.summary, data: e.data, actor: e.actor ? { id: e.actor.id, name: `${e.actor.first_name} ${e.actor.last_name}`.trim() } : null })),
    ...activities.map((a) => ({ kind: 'activity', id: a.id, at: a.created_at, activity_type: a.type, subject: a.subject, status: a.status, due_at: a.due_at, description: a.description, owner: a.owner ? { id: a.owner.id, name: `${a.owner.first_name} ${a.owner.last_name}`.trim() } : null })),
    ...comms.map((c) => ({ kind: 'communication', id: c.id, at: c.created_at, channel: c.channel, direction: c.direction, subject: c.subject, status: c.status, to: c.to_address })),
  ]
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, limit);
  return { items, next_before: items.length === limit ? new Date(items[items.length - 1].at).toISOString() : null };
}

module.exports = { add, feed };
