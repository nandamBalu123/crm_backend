'use strict';

const { Op } = require('sequelize');
const { sequelize, Role, RolePermission, Permission, FieldPermission, MembershipRole } = require('../../models');
const { assertCanGrant } = require('./escalation');
const { invalidate } = require('./permission.service');
const audit = require('../audit/audit.service');
const { getContext } = require('../../context/requestContext');
const { CATALOG } = require('../../config/permissions');
const E = require('../../errors/AppError');

function roleKey(name) {
  return `custom_${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)}_${Math.random().toString(36).slice(2, 6)}`;
}

async function permissionMap(roleId, transaction) {
  const rows = await RolePermission.findAll({ where: { role_id: roleId }, include: [{ model: Permission, as: 'permission', attributes: ['key'] }], transaction });
  return Object.fromEntries(rows.map((r) => [r.permission.key, r.scope]));
}

async function serializeRole(role, transaction) {
  const [permissions, fieldPermissions, memberCount] = await Promise.all([
    permissionMap(role.id, transaction),
    FieldPermission.findAll({ where: { role_id: role.id }, attributes: ['entity_type', 'field_key', 'access'], transaction }),
    MembershipRole.count({ where: { role_id: role.id }, transaction }),
  ]);
  const plain = { ...role.get({ plain: true }) };
  delete plain.tenant_id;
  return { ...plain, permissions, field_permissions: fieldPermissions.map((f) => f.get({ plain: true })), member_count: memberCount };
}

async function list() {
  const roles = await Role.findAll({ order: [['is_system', 'DESC'], ['name', 'ASC']] });
  const counts = await MembershipRole.findAll({ attributes: ['role_id', [sequelize.fn('COUNT', sequelize.col('id')), 'n']], group: ['role_id'], raw: true });
  const byRole = new Map(counts.map((c) => [c.role_id, Number(c.n)]));
  return roles.map((r) => ({ ...r.toJSON(), tenant_id: undefined, member_count: byRole.get(r.id) || 0 }));
}

async function get(id) {
  const role = await Role.findByPk(id);
  if (!role) throw E.notFound('Role');
  return serializeRole(role);
}

async function writePermissions(role, permissions, transaction) {
  const keys = Object.keys(permissions);
  const perms = keys.length ? await Permission.findAll({ where: { key: keys }, transaction }) : [];
  const byKey = new Map(perms.map((p) => [p.key, p]));
  await RolePermission.destroy({ where: { role_id: role.id }, transaction });
  const rows = keys.map((k) => ({ role_id: role.id, permission_id: byKey.get(k).id, scope: byKey.get(k).supports_scope ? permissions[k] : 'all' }));
  if (rows.length) await RolePermission.bulkCreate(rows, { transaction });
}

async function create({ name, description, permissions = {}, clone_from_id: cloneFromId }) {
  const ctx = getContext();
  let perms = permissions;
  let fieldPerms = [];
  if (cloneFromId) {
    const source = await Role.findByPk(cloneFromId);
    if (!source) throw E.validation([{ path: 'clone_from_id', message: 'Role not found' }]);
    perms = { ...(await permissionMap(source.id)), ...permissions };
    fieldPerms = await FieldPermission.findAll({ where: { role_id: source.id } });
  }
  assertCanGrant(ctx, perms);
  const role = await sequelize.transaction(async (transaction) => {
    const r = await Role.create({ key: roleKey(name), name, description, is_system: false, cloned_from_id: cloneFromId || null }, { transaction });
    await writePermissions(r, perms, transaction);
    if (fieldPerms.length) await FieldPermission.bulkCreate(fieldPerms.map((f) => ({ role_id: r.id, entity_type: f.entity_type, field_key: f.field_key, access: f.access })), { transaction });
    await audit.record({ action: 'role.created', entityType: 'role', entityId: r.id, summary: `Role ${name} created`, metadata: { permissions: perms, cloned_from: cloneFromId || null } }, { transaction });
    return r;
  });
  return serializeRole(role);
}

async function update(id, { name, description, is_active: isActive, permissions, field_permissions: fieldPermissions }) {
  const ctx = getContext();
  await sequelize.transaction(async (transaction) => {
    const role = await Role.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!role) throw E.notFound('Role');
    if (role.is_protected) throw E.forbidden('The owner role cannot be modified', 'ROLE_PROTECTED');
    const before = await permissionMap(role.id, transaction);
    if (permissions) {
      assertCanGrant(ctx, permissions);
      // Removing permissions is also a sensitive change: only those who hold them may remove them.
      const removed = Object.fromEntries(Object.entries(before).filter(([k]) => !(k in permissions)));
      assertCanGrant(ctx, removed);
      await writePermissions(role, permissions, transaction);
    }
    if (fieldPermissions) {
      await FieldPermission.destroy({ where: { role_id: role.id }, transaction });
      if (fieldPermissions.length) await FieldPermission.bulkCreate(fieldPermissions.map((f) => ({ ...f, role_id: role.id })), { transaction });
    }
    if (isActive === false && ctx.roleIds.includes(role.id) && !ctx.isOwner) throw E.conflict('You cannot disable a role you rely on', 'ROLE_SELF_DISABLE');
    await role.update({ ...(name ? { name } : {}), ...(description !== undefined ? { description } : {}), ...(isActive !== undefined ? { is_active: isActive } : {}) }, { transaction });
    await audit.record({
      action: 'role.updated', entityType: 'role', entityId: role.id, summary: `Role ${role.name} updated`,
      changes: permissions ? { permissions: { from: before, to: permissions } } : null,
      metadata: { field_permissions: fieldPermissions || undefined, is_active: isActive },
    }, { transaction });
  });
  invalidate(ctx.tenantId);
  return get(id);
}

async function remove(id) {
  const ctx = getContext();
  await sequelize.transaction(async (transaction) => {
    const role = await Role.findByPk(id, { transaction });
    if (!role) throw E.notFound('Role');
    if (role.is_system) throw E.conflict('System roles cannot be deleted; disable them instead', 'ROLE_SYSTEM');
    const members = await MembershipRole.count({ where: { role_id: id }, transaction });
    if (members) throw E.conflict(`This role is assigned to ${members} user(s). Reassign them first.`, 'ROLE_IN_USE');
    await RolePermission.destroy({ where: { role_id: id }, transaction });
    await FieldPermission.destroy({ where: { role_id: id }, transaction });
    await role.destroy({ transaction });
    await audit.record({ action: 'role.deleted', entityType: 'role', entityId: id, summary: `Role ${role.name} deleted` }, { transaction });
  });
  invalidate(ctx.tenantId);
}

function catalog() {
  const groups = {};
  for (const p of CATALOG) (groups[p.module] = groups[p.module] || []).push(p);
  return Object.entries(groups).map(([module, permissions]) => ({ module, permissions }));
}

/** Roles a user may assign: never the owner role, never roles exceeding the assigner's permissions. */
async function assertAssignable(roleIds, { transaction } = {}) {
  const ctx = getContext();
  const roles = await Role.findAll({ where: { id: roleIds }, transaction });
  if (roles.length !== new Set(roleIds).size) throw E.validation([{ path: 'role_ids', message: 'One or more roles were not found' }]);
  for (const role of roles) {
    if (role.key === 'owner') throw E.forbidden('The owner role can only be granted through ownership transfer', 'ROLE_PROTECTED');
    if (!role.is_active) throw E.validation([{ path: 'role_ids', message: `Role ${role.name} is disabled` }]);
    assertCanGrant(ctx, await permissionMap(role.id, transaction));
  }
  return roles;
}

module.exports = { list, get, create, update, remove, catalog, assertAssignable, permissionMap, Op };
