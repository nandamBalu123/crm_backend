'use strict';

const { Op } = require('sequelize');
const { createRouter } = require('../../utils/router');
const { z, idParams, uuid, requiredText } = require('../../utils/schemas');
const notifications = require('../notifications/notifications.service');
const { SavedView } = require('../../models');
const registry = require('../../core/entity/registry');
const { getContext } = require('../../context/requestContext');
const { ok, created, noContent } = require('../../utils/http');
const E = require('../../errors/AppError');

/** Per-user resources inside the active workspace. */
const r = createRouter({ prefix: '/api/v1/me', tag: 'Me' });

r.get('/notifications', {
  summary: 'My notifications', query: z.object({ unread: z.enum(['true', 'false']).optional(), before: z.string().datetime({ offset: true }).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }),
}, async (req, res) => ok(res, await notifications.list(getContext().userId, { unread: req.valid.query.unread === 'true', before: req.valid.query.before, limit: req.valid.query.limit })));
r.post('/notifications/read', { summary: 'Mark notifications read (all when ids omitted)', body: z.strictObject({ ids: z.array(uuid()).max(500).optional() }) }, async (req, res) =>
  ok(res, { updated: await notifications.markRead(getContext().userId, req.valid.body.ids) }));
r.get('/notification-preferences', { summary: 'My notification preferences' }, async (_req, res) => ok(res, await notifications.preferences(getContext().userId)));
r.put('/notification-preferences', {
  summary: 'Update notification preferences',
  body: z.strictObject({ preferences: z.array(z.strictObject({ type: z.string().max(60), in_app: z.boolean(), email: z.boolean() })).max(50) }),
}, async (req, res) => ok(res, await notifications.setPreferences(getContext().userId, req.valid.body.preferences)));

const viewBody = z.strictObject({
  entity_type: z.enum(registry.CUSTOM_FIELD_ENTITIES),
  name: requiredText(120),
  filters: z.strictObject({ filter: z.record(z.string(), z.any()).optional(), cf: z.record(z.string(), z.any()).optional(), q: z.string().max(100).optional() }).optional(),
  sort: z.string().max(80).nullish(),
  columns: z.array(z.string().max(80)).max(50).optional(),
  is_shared: z.boolean().optional(),
  is_default: z.boolean().optional(),
});

r.get('/saved-views', { summary: 'Saved list views (mine + shared)', query: z.object({ entity_type: z.enum(registry.CUSTOM_FIELD_ENTITIES) }) }, async (req, res) => {
  const ctx = getContext();
  return ok(res, await SavedView.findAll({ where: { entity_type: req.valid.query.entity_type, [Op.or]: [{ user_id: ctx.userId }, { is_shared: true }] }, order: [['name', 'ASC']] }));
});
r.post('/saved-views', { summary: 'Create a saved view', body: viewBody }, async (req, res) => {
  const ctx = getContext();
  const body = req.valid.body;
  if (body.is_shared && !ctx.permissions.has('settings:manage') && !ctx.permissions.has('reports:create')) throw E.forbidden('Sharing views requires reports:create', 'PERMISSION_DENIED');
  if (body.is_default) await SavedView.update({ is_default: false }, { where: { user_id: ctx.userId, entity_type: body.entity_type } });
  return created(res, await SavedView.create({ ...body, user_id: ctx.userId }));
});
r.patch('/saved-views/:id', { summary: 'Update my saved view', params: idParams, body: viewBody.partial() }, async (req, res) => {
  const ctx = getContext();
  const view = await SavedView.findOne({ where: { id: req.valid.params.id, user_id: ctx.userId } });
  if (!view) throw E.notFound('Saved view');
  return ok(res, await view.update(req.valid.body));
});
r.delete('/saved-views/:id', { summary: 'Delete my saved view', params: idParams }, async (req, res) => {
  const n = await SavedView.destroy({ where: { id: req.valid.params.id, user_id: getContext().userId } });
  if (!n) throw E.notFound('Saved view');
  return noContent(res);
});

module.exports = r;
