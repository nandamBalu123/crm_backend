'use strict';

const { entityRouter } = require('../../core/entity/routes');
const service = require('../../core/entity/service');
const { sequelize, TicketComment, TicketCategory, SlaPolicy, User } = require('../../models');
const { z, idParams, uuid, requiredText, trimmed } = require('../../utils/schemas');
const timeline = require('../timeline/timeline.service');
const audit = require('../audit/audit.service');
const events = require('../../events/domainEvents');
const { getContext } = require('../../context/requestContext');
const { ok, created, noContent } = require('../../utils/http');
const E = require('../../errors/AppError');
const def = require('./tickets.entity');

module.exports = entityRouter(def, {
  extend(r) {
    r.get('/categories', { summary: 'Ticket categories', permission: 'tickets:read' }, async (_req, res) => ok(res, await TicketCategory.findAll({ order: [['name', 'ASC']] })));
    r.post('/categories', { summary: 'Create a ticket category', permission: 'settings:manage', body: z.strictObject({ name: requiredText(120), description: trimmed(500).nullish(), default_team_id: uuid().nullish() }) }, async (req, res) =>
      created(res, await TicketCategory.create(req.valid.body)));
    r.get('/sla-policies', { summary: 'SLA policies', permission: 'tickets:read' }, async (_req, res) => ok(res, await SlaPolicy.findAll({ order: [['first_response_minutes', 'ASC']] })));
    r.put('/sla-policies/:id', {
      summary: 'Update an SLA policy', permission: 'settings:manage', params: idParams,
      body: z.strictObject({ name: requiredText(120).optional(), first_response_minutes: z.coerce.number().int().min(1).max(525600), resolution_minutes: z.coerce.number().int().min(1).max(525600), escalate_to_user_id: uuid().nullish(), is_active: z.boolean().optional() })
        .refine((v) => v.resolution_minutes >= v.first_response_minutes, { message: 'Resolution time must be ≥ first response time', path: ['resolution_minutes'] }),
    }, async (req, res) => {
      const p = await SlaPolicy.findByPk(req.valid.params.id);
      if (!p) throw E.notFound('SLA policy');
      await p.update(req.valid.body);
      await audit.record({ action: 'sla_policy.updated', entityType: 'sla_policy', entityId: p.id, summary: `SLA ${p.name} updated` });
      return ok(res, p);
    });

    r.get('/:id/comments', { summary: 'Ticket conversation (public replies + internal notes)', permission: 'tickets:read', params: idParams }, async (req, res) => {
      await service.findScoped(def, req.valid.params.id, req.scope);
      return ok(res, await TicketComment.findAll({ where: { ticket_id: req.valid.params.id }, order: [['created_at', 'ASC']], include: [{ model: User, as: 'author', attributes: ['id', 'first_name', 'last_name'] }] }));
    });
    r.post('/:id/comments', {
      summary: 'Add a reply or internal note (first public reply stops the first-response timer)', permission: 'tickets:update', params: idParams,
      body: z.strictObject({ body: requiredText(50000), is_internal: z.boolean().optional() }),
    }, async (req, res) => {
      const ctx = getContext();
      const comment = await sequelize.transaction(async (transaction) => {
        const ticket = await service.findScoped(def, req.valid.params.id, req.scope, { transaction, lock: true });
        const c = await TicketComment.create({ ticket_id: ticket.id, author_user_id: ctx.userId, body: req.valid.body.body, is_internal: !!req.valid.body.is_internal }, { transaction });
        const updates = { last_activity_at: new Date() };
        if (!req.valid.body.is_internal && !ticket.first_responded_at) updates.first_responded_at = new Date();
        if (!req.valid.body.is_internal && ticket.status === 'new') updates.status = 'open';
        await ticket.update(updates, { transaction });
        await timeline.add('ticket', ticket.id, req.valid.body.is_internal ? 'internal_note' : 'reply', req.valid.body.is_internal ? 'Internal note added' : 'Reply sent to customer', { comment_id: c.id }, { transaction });
        await events.publish('ticket.commented', { entityType: 'ticket', entityId: ticket.id, data: { comment_id: c.id, is_internal: c.is_internal } }, { transaction });
        return c;
      });
      return created(res, comment);
    });
    r.delete('/:id/comments/:commentId', { summary: 'Delete own internal note', permission: 'tickets:update', params: z.object({ id: uuid(), commentId: uuid() }) }, async (req, res) => {
      const ctx = getContext();
      await service.findScoped(def, req.valid.params.id, req.scope);
      const n = await TicketComment.destroy({ where: { id: req.valid.params.commentId, ticket_id: req.valid.params.id, author_user_id: ctx.userId, is_internal: true } });
      if (!n) throw E.notFound('Comment');
      return noContent(res);
    });
  },
});
