'use strict';

const { Membership, Role, RolePermission, Permission, FieldPermission, TeamMember } = require('../../models');

const SCOPE_RANK = { own: 1, team: 2, all: 3 };
const ACCESS_RANK = { hidden: 1, read: 2, write: 3 };

/**
 * Builds the effective authorization snapshot for a membership:
 *  - permissions: Map<'module:action', 'own'|'team'|'all'> (most permissive across roles)
 *  - fieldAccess: { [entityType]: { [fieldKey]: 'hidden'|'read' } } – a field is restricted
 *    only when every role restricts it (least restrictive wins)
 *  - teamIds and teamUserIds for 'team' record scope
 * Cached per tenant+user for a short TTL; invalidate on any RBAC change.
 */
const cache = new Map();
const TTL_MS = 15_000;

function invalidate(tenantId) {
  for (const key of cache.keys()) if (key.startsWith(`${tenantId}:`)) cache.delete(key);
}

async function loadSnapshot(tenantId, userId) {
  const key = `${tenantId}:${userId}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const membership = await Membership.findOne({
    where: { user_id: userId },
    include: [{ model: Role, as: 'roles', where: { is_active: true }, required: false, through: { attributes: [] } }],
  });
  if (!membership) return null;
  const roleIds = (membership.roles || []).map((r) => r.id);

  const permissions = new Map();
  const fieldAccess = {};
  if (roleIds.length) {
    const rps = await RolePermission.findAll({
      where: { role_id: roleIds },
      include: [{ model: Permission, as: 'permission', attributes: ['key'] }],
      attributes: ['scope', 'role_id'],
    });
    for (const rp of rps) {
      const k = rp.permission.key;
      const prev = permissions.get(k);
      if (!prev || SCOPE_RANK[rp.scope] > SCOPE_RANK[prev]) permissions.set(k, rp.scope);
    }
    const fps = await FieldPermission.findAll({ where: { role_id: roleIds }, attributes: ['role_id', 'entity_type', 'field_key', 'access'] });
    // collect per field: access by role; missing role entry = write
    const perField = {};
    for (const fp of fps) {
      const fk = `${fp.entity_type}\u0000${fp.field_key}`;
      perField[fk] = perField[fk] || {};
      perField[fk][fp.role_id] = fp.access;
    }
    for (const [fk, byRole] of Object.entries(perField)) {
      let best = 'hidden';
      for (const rid of roleIds) {
        const access = byRole[rid] || 'write';
        if (ACCESS_RANK[access] > ACCESS_RANK[best]) best = access;
      }
      if (best !== 'write') {
        const [entity, field] = fk.split('\u0000');
        fieldAccess[entity] = fieldAccess[entity] || {};
        fieldAccess[entity][field] = best;
      }
    }
  }

  const myTeams = await TeamMember.findAll({ where: { user_id: userId }, attributes: ['team_id'] });
  const teamIds = myTeams.map((t) => t.team_id);
  let teamUserIds = [userId];
  if (teamIds.length) {
    const mates = await TeamMember.findAll({ where: { team_id: teamIds }, attributes: ['user_id'] });
    teamUserIds = [...new Set([userId, ...mates.map((m) => m.user_id)])];
  }

  const value = {
    membership: { id: membership.id, status: membership.status, is_owner: membership.is_owner },
    roleIds,
    roles: (membership.roles || []).map((r) => ({ id: r.id, key: r.key, name: r.name })),
    permissions,
    fieldAccess,
    teamIds,
    teamUserIds,
  };
  cache.set(key, { value, expires: Date.now() + TTL_MS });
  return value;
}

/** Intersects a permission map with an API key's scopes (lowest scope wins). */
function intersect(perms, scopes) {
  const out = new Map();
  for (const [key, scope] of Object.entries(scopes || {})) {
    const have = perms.get(key);
    if (!have) continue;
    out.set(key, SCOPE_RANK[scope] < SCOPE_RANK[have] ? scope : have);
  }
  return out;
}

module.exports = { loadSnapshot, invalidate, intersect, SCOPE_RANK };
