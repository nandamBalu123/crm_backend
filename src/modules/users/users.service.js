'use strict';

const { Op } = require('sequelize');
const env = require('../../config/env');
const { sequelize, Membership, MembershipRole, Role, User, Team, TeamMember, Invitation, Tenant } = require('../../models');
const roles = require('../rbac/roles.service');
const { invalidate } = require('../rbac/permission.service');
const entitlements = require('../billing/entitlements.service');
const audit = require('../audit/audit.service');
const { queueEmail, layout } = require('../../integrations/mail/mailer');
const { getContext } = require('../../context/requestContext');
const { randomToken } = require('../../utils/ids');
const { sha256 } = require('../../utils/crypto');
const E = require('../../errors/AppError');

const userAttrs = ['id', 'email', 'first_name', 'last_name', 'avatar_url', 'last_login_at', 'mfa_enabled', 'email_verified_at'];

async function serializeMembers(memberships) {
  const userIds = memberships.map((m) => m.user_id);
  const teams = userIds.length ? await TeamMember.findAll({ where: { user_id: userIds }, attributes: ['user_id', 'team_id'] }) : [];
  return memberships.map((m) => ({
    id: m.id,
    user_id: m.user_id,
    status: m.status,
    is_owner: m.is_owner,
    title: m.title,
    joined_at: m.joined_at,
    last_active_at: m.last_active_at,
    user: m.user ? { ...m.user.toJSON(), mfa_enabled: !!m.user.mfa_enabled, email_verified: !!m.user.email_verified_at, email_verified_at: undefined } : null,
    roles: (m.roles || []).map((r) => ({ id: r.id, key: r.key, name: r.name })),
    team_ids: teams.filter((t) => t.user_id === m.user_id).map((t) => t.team_id),
  }));
}

async function list({ q, status }) {
  const where = {};
  if (status) where.status = status;
  const userWhere = q ? { [Op.or]: [{ email: { [Op.like]: `%${q}%` } }, { first_name: { [Op.like]: `%${q}%` } }, { last_name: { [Op.like]: `%${q}%` } }] } : undefined;
  const rows = await Membership.findAll({
    where,
    include: [
      { model: User, as: 'user', attributes: userAttrs, where: userWhere, required: !!userWhere },
      { model: Role, as: 'roles', through: { attributes: [] }, attributes: ['id', 'key', 'name'] },
    ],
    order: [['created_at', 'ASC']],
    limit: 1000,
  });
  return serializeMembers(rows);
}

async function get(membershipId) {
  const m = await Membership.findOne({
    where: { id: membershipId },
    include: [{ model: User, as: 'user', attributes: userAttrs }, { model: Role, as: 'roles', through: { attributes: [] }, attributes: ['id', 'key', 'name'] }],
  });
  if (!m) throw E.notFound('User');
  return (await serializeMembers([m]))[0];
}

async function update(membershipId, { role_ids: roleIds, status, title, team_ids: teamIds }) {
  const ctx = getContext();
  await sequelize.transaction(async (transaction) => {
    const m = await Membership.findByPk(membershipId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!m) throw E.notFound('User');
    if (m.is_owner && !ctx.isOwner) throw E.forbidden('Only the owner can change the owner account', 'OWNER_PROTECTED');
    if (m.user_id === ctx.userId && (status === 'disabled' || roleIds)) throw E.conflict('You cannot change your own roles or disable yourself', 'SELF_MODIFICATION');
    if (status && m.is_owner && status === 'disabled') throw E.conflict('The owner cannot be disabled. Transfer ownership first.', 'OWNER_PROTECTED');
    if (status === 'active' && m.status !== 'active') await entitlements.assertSeatAvailable({ transaction });
    if (roleIds) {
      const assigned = await roles.assertAssignable(roleIds, { transaction });
      // Removing roles is equally sensitive: you may only remove roles you could grant.
      const current = await MembershipRole.findAll({ where: { membership_id: m.id }, transaction });
      const ownerRole = await Role.findOne({ where: { key: 'owner' }, transaction });
      const removed = current.filter((c) => !roleIds.includes(c.role_id) && c.role_id !== ownerRole?.id).map((c) => c.role_id);
      if (removed.length) await roles.assertAssignable(removed, { transaction });
      await MembershipRole.destroy({ where: { membership_id: m.id, role_id: { [Op.ne]: ownerRole?.id || '' } }, transaction });
      await MembershipRole.bulkCreate(assigned.map((r) => ({ membership_id: m.id, role_id: r.id })), { transaction });
    }
    if (teamIds) {
      const teams = await Team.findAll({ where: { id: teamIds }, attributes: ['id'], transaction });
      if (teams.length !== new Set(teamIds).size) throw E.validation([{ path: 'team_ids', message: 'Team not found' }]);
      await TeamMember.destroy({ where: { user_id: m.user_id }, transaction });
      if (teamIds.length) await TeamMember.bulkCreate(teamIds.map((t) => ({ team_id: t, user_id: m.user_id })), { transaction });
    }
    await m.update({ ...(status ? { status } : {}), ...(title !== undefined ? { title } : {}) }, { transaction });
    await audit.record({ action: 'membership.updated', entityType: 'user', entityId: m.user_id, summary: 'User access updated', metadata: { role_ids: roleIds, status, team_ids: teamIds } }, { transaction });
  });
  invalidate(ctx.tenantId);
  return get(membershipId);
}

async function transferOwnership(membershipId) {
  const ctx = getContext();
  if (!ctx.isOwner) throw E.forbidden('Only the current owner can transfer ownership', 'OWNER_ONLY');
  await sequelize.transaction(async (transaction) => {
    const target = await Membership.findByPk(membershipId, { transaction });
    if (!target || target.status !== 'active') throw E.notFound('User');
    const me = await Membership.findOne({ where: { user_id: ctx.userId }, transaction });
    const ownerRole = await Role.findOne({ where: { key: 'owner' }, transaction });
    const adminRole = await Role.findOne({ where: { key: 'admin' }, transaction });
    await me.update({ is_owner: false }, { transaction });
    await MembershipRole.destroy({ where: { membership_id: me.id, role_id: ownerRole.id }, transaction });
    await MembershipRole.findOrCreate({ where: { membership_id: me.id, role_id: adminRole.id }, defaults: { membership_id: me.id, role_id: adminRole.id }, transaction });
    await target.update({ is_owner: true }, { transaction });
    await MembershipRole.findOrCreate({ where: { membership_id: target.id, role_id: ownerRole.id }, defaults: { membership_id: target.id, role_id: ownerRole.id }, transaction });
    await Tenant.update({ owner_user_id: target.user_id }, { where: { id: ctx.tenantId }, transaction });
    await audit.record({ action: 'tenant.ownership_transferred', entityType: 'user', entityId: target.user_id, summary: 'Workspace ownership transferred' }, { transaction });
  });
  invalidate(ctx.tenantId);
}

// ---------- invitations ----------

async function invite({ email, role_ids: roleIds, team_ids: teamIds = [] }) {
  const ctx = getContext();
  const allowedDomains = ctx.settings?.security?.allowed_email_domains || [];
  if (allowedDomains.length && !allowedDomains.includes(email.split('@')[1])) {
    throw E.validation([{ path: 'email', message: `Only ${allowedDomains.join(', ')} addresses can be invited` }]);
  }
  if (env.REQUIRE_EMAIL_VERIFICATION && !ctx.user.email_verified_at) throw E.forbidden('Verify your email before inviting others', 'EMAIL_NOT_VERIFIED');
  const raw = randomToken(32);
  const inv = await sequelize.transaction(async (transaction) => {
    await roles.assertAssignable(roleIds, { transaction });
    await entitlements.assertSeatAvailable({ transaction });
    const existingUser = await User.findOne({ where: { email }, transaction, attributes: ['id'] });
    if (existingUser) {
      const member = await Membership.findOne({ where: { user_id: existingUser.id, status: 'active' }, transaction });
      if (member) throw E.conflict('This person is already a member', 'ALREADY_MEMBER');
    }
    await Invitation.update({ status: 'revoked' }, { where: { email, status: 'pending' }, transaction });
    const days = Number(ctx.settings?.security?.invite_expiry_days) || 7;
    const row = await Invitation.create({ email, role_ids: roleIds, team_ids: teamIds, token_hash: sha256(raw), invited_by_user_id: ctx.userId, expires_at: new Date(Date.now() + days * 86400_000) }, { transaction });
    const { html, text } = layout({
      heading: `You're invited to ${ctx.tenant.name}`,
      intro: `${ctx.user.first_name} invited you to join ${ctx.tenant.name} on CRM SaaS. This invitation expires in ${days} days.`,
      actionUrl: `${env.APP_URL}/accept-invite?token=${raw}`,
      actionLabel: 'Accept invitation',
    });
    await queueEmail({ to: email, subject: `Invitation to join ${ctx.tenant.name}`, html, text, templateKey: 'invitation' }, { transaction });
    await audit.record({ action: 'invitation.created', entityType: 'invitation', entityId: row.id, summary: `Invited ${email}`, metadata: { role_ids: roleIds } }, { transaction });
    return row;
  });
  return inv;
}

async function listInvitations() {
  return Invitation.findAll({ where: { status: 'pending', expires_at: { [Op.gt]: new Date() } }, order: [['created_at', 'DESC']] });
}

async function revokeInvitation(id) {
  const inv = await Invitation.findByPk(id);
  if (!inv) throw E.notFound('Invitation');
  await inv.update({ status: 'revoked' });
  await audit.record({ action: 'invitation.revoked', entityType: 'invitation', entityId: id, summary: `Invitation for ${inv.email} revoked` });
}

// ---------- teams ----------

async function listTeams() {
  const teams = await Team.findAll({ include: [{ model: TeamMember, as: 'members', attributes: ['user_id'] }], order: [['name', 'ASC']] });
  return teams.map((t) => ({ id: t.id, name: t.name, description: t.description, manager_user_id: t.manager_user_id, member_user_ids: t.members.map((m) => m.user_id) }));
}

async function saveTeam(id, { name, description, manager_user_id: managerId, member_user_ids: memberIds }) {
  const ctx = getContext();
  const team = await sequelize.transaction(async (transaction) => {
    const t = id ? await Team.findByPk(id, { transaction }) : Team.build({});
    if (!t) throw E.notFound('Team');
    t.set({ ...(name ? { name } : {}), ...(description !== undefined ? { description } : {}), ...(managerId !== undefined ? { manager_user_id: managerId } : {}) });
    await t.save({ transaction });
    if (memberIds) {
      const members = await Membership.findAll({ where: { user_id: memberIds, status: 'active' }, attributes: ['user_id'], transaction });
      if (members.length !== new Set(memberIds).size) throw E.validation([{ path: 'member_user_ids', message: 'All members must be active users' }]);
      await TeamMember.destroy({ where: { team_id: t.id }, transaction });
      if (memberIds.length) await TeamMember.bulkCreate(memberIds.map((u) => ({ team_id: t.id, user_id: u })), { transaction });
    }
    await audit.record({ action: id ? 'team.updated' : 'team.created', entityType: 'team', entityId: t.id, summary: `Team ${t.name} ${id ? 'updated' : 'created'}` }, { transaction });
    return t;
  });
  invalidate(ctx.tenantId);
  return (await listTeams()).find((t) => t.id === team.id);
}

async function deleteTeam(id) {
  const ctx = getContext();
  await sequelize.transaction(async (transaction) => {
    const t = await Team.findByPk(id, { transaction });
    if (!t) throw E.notFound('Team');
    await TeamMember.destroy({ where: { team_id: id }, transaction });
    await t.destroy({ transaction });
    await audit.record({ action: 'team.deleted', entityType: 'team', entityId: id, summary: `Team ${t.name} deleted` }, { transaction });
  });
  invalidate(ctx.tenantId);
}

module.exports = { list, get, update, transferOwnership, invite, listInvitations, revokeInvitation, listTeams, saveTeam, deleteTeam };
