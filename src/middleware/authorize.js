'use strict';

const { forbidden } = require('../errors/AppError');

/** Returns the scope ('own'|'team'|'all') the caller holds for a permission, or null. */
function scopeFor(ctx, permission) {
  return ctx?.permissions?.get(permission) || null;
}

function can(ctx, permission) {
  return !!scopeFor(ctx, permission);
}

/**
 * RBAC gate. `permission` may be a string or an array (any-of). The granted
 * record scope is exposed as req.scope for record-level policy filtering.
 */
function requirePermission(permission) {
  const list = Array.isArray(permission) ? permission : [permission];
  return (req, _res, next) => {
    for (const p of list) {
      const scope = scopeFor(req.ctx, p);
      if (scope) {
        req.scope = scope;
        req.permission = p;
        return next();
      }
    }
    return next(forbidden(`Missing permission: ${list.join(' or ')}`, 'PERMISSION_DENIED'));
  };
}

function assertCan(ctx, permission) {
  if (!can(ctx, permission)) throw forbidden(`Missing permission: ${permission}`, 'PERMISSION_DENIED');
  return scopeFor(ctx, permission);
}

module.exports = { requirePermission, can, scopeFor, assertCan };
