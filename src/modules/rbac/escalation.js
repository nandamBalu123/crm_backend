'use strict';

const { SCOPE_RANK } = require('./permission.service');
const { KEYS } = require('../../config/permissions');
const E = require('../../errors/AppError');

/**
 * Privilege-escalation guard: a member may only grant permissions (and record
 * scopes) they hold themselves. Tenant owners hold everything.
 */
function assertCanGrant(ctx, permissions) {
  const problems = [];
  for (const [key, scope] of Object.entries(permissions || {})) {
    if (!KEYS.has(key)) {
      problems.push({ path: `permissions.${key}`, message: 'Unknown permission' });
      continue;
    }
    if (ctx.isOwner) continue;
    const mine = ctx.permissions.get(key);
    if (!mine || SCOPE_RANK[mine] < SCOPE_RANK[scope]) problems.push({ path: `permissions.${key}`, message: 'You cannot grant a permission you do not have' });
  }
  if (problems.some((p) => p.message === 'Unknown permission')) throw E.validation(problems);
  if (problems.length) throw new E.AppError(403, 'PRIVILEGE_ESCALATION', 'You cannot grant permissions beyond your own', problems);
}

module.exports = { assertCanGrant };
