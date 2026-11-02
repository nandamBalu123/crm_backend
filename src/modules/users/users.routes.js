'use strict';

const { createRouter } = require('../../utils/router');
const { z, idParams, uuid, email, requiredText, trimmed } = require('../../utils/schemas');
const service = require('./users.service');
const { ok, created, noContent } = require('../../utils/http');

const users = createRouter({ prefix: '/api/v1/users', tag: 'Users & teams' });
users.get('/', { summary: 'List workspace members', permission: 'users:read', query: z.object({ q: z.string().max(100).optional(), status: z.enum(['active', 'disabled']).optional() }) }, async (req, res) => ok(res, await service.list(req.valid.query)));
users.get('/:id', { summary: 'Get a member', permission: 'users:read', params: idParams }, async (req, res) => ok(res, await service.get(req.valid.params.id)));
users.patch('/:id', {
  summary: 'Update member roles, teams, title or status', permission: 'users:manage', params: idParams,
  body: z.strictObject({ role_ids: z.array(uuid()).min(1).max(20).optional(), team_ids: z.array(uuid()).max(50).optional(), status: z.enum(['active', 'disabled']).optional(), title: trimmed(120).nullish() }),
}, async (req, res) => ok(res, await service.update(req.valid.params.id, req.valid.body)));
users.post('/:id/transfer-ownership', { summary: 'Transfer workspace ownership', permission: 'users:manage', params: idParams }, async (req, res) => {
  await service.transferOwnership(req.valid.params.id);
  return ok(res, { transferred: true });
});

const invitations = createRouter({ prefix: '/api/v1/invitations', tag: 'Users & teams' });
invitations.get('/', { summary: 'List pending invitations', permission: 'users:manage' }, async (_req, res) => ok(res, await service.listInvitations()));
invitations.post('/', {
  summary: 'Invite a user by email', permission: 'users:manage', idempotent: true,
  body: z.strictObject({ email: email(), role_ids: z.array(uuid()).min(1).max(20), team_ids: z.array(uuid()).max(50).optional() }),
}, async (req, res) => created(res, await service.invite(req.valid.body)));
invitations.delete('/:id', { summary: 'Revoke an invitation', permission: 'users:manage', params: idParams }, async (req, res) => {
  await service.revokeInvitation(req.valid.params.id);
  return noContent(res);
});

const teamBody = z.strictObject({ name: requiredText(120), description: trimmed(255).nullish(), manager_user_id: uuid().nullish(), member_user_ids: z.array(uuid()).max(500).optional() });
const teams = createRouter({ prefix: '/api/v1/teams', tag: 'Users & teams' });
teams.get('/', { summary: 'List teams', permission: 'users:read' }, async (_req, res) => ok(res, await service.listTeams()));
teams.post('/', { summary: 'Create a team', permission: 'users:manage', body: teamBody }, async (req, res) => created(res, await service.saveTeam(null, req.valid.body)));
teams.patch('/:id', { summary: 'Update a team and its members', permission: 'users:manage', params: idParams, body: teamBody.partial() }, async (req, res) => ok(res, await service.saveTeam(req.valid.params.id, req.valid.body)));
teams.delete('/:id', { summary: 'Delete a team', permission: 'users:manage', params: idParams }, async (req, res) => {
  await service.deleteTeam(req.valid.params.id);
  return noContent(res);
});

module.exports = { users, invitations, teams };
