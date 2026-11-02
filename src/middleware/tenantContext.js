'use strict';

const { Tenant, TenantSettings } = require('../models');
const { loadSnapshot, intersect } = require('../modules/rbac/permission.service');
const { forbidden, unauthorized } = require('../errors/AppError');
const { TtlCache } = require('../utils/ttlCache');
const { runAsSystem } = require('../context/requestContext');
const { defaultSettings } = require('../modules/tenants/settings.defaults');

const tenantCache = new TtlCache(15_000);

function invalidateTenant(tenantId) {
  tenantCache.delete(tenantId);
}

async function loadTenant(tenantId) {
  let t = tenantCache.get(tenantId);
  if (!t) {
    const tenant = await runAsSystem('tenant-context:load', () => Tenant.findByPk(tenantId));
    if (!tenant) return null;
    const settings = await runAsSystem('tenant-context:settings', () => TenantSettings.findOne({ where: { tenant_id: tenantId } }));
    t = tenantCache.set(tenantId, { tenant: tenant.get({ plain: true }), settings: settings ? settings.get({ plain: true }) : defaultSettings() });
  }
  return t;
}

// Endpoints reachable while the tenant requires MFA and the member has not enrolled yet.
const MFA_SETUP_ALLOWLIST = [/^\/api\/v1\/me(\/|$)/];

/**
 * Resolves the tenant for an authenticated request and attaches the member's
 * authorization snapshot. The tenant id originates only from the verified
 * access token or the API key record; membership is re-validated here on
 * every request (cached briefly), so removed members lose access promptly.
 */
async function tenantContext(req, _res, next) {
  const ctx = req.ctx;
  if (!ctx.userId) throw unauthorized();
  if (!ctx.tenantId) throw forbidden('No active workspace selected', 'NO_ACTIVE_TENANT');

  const loaded = await loadTenant(ctx.tenantId);
  if (!loaded) throw forbidden('Workspace not found', 'NOT_A_MEMBER');
  if (loaded.tenant.status !== 'active') throw forbidden('This workspace is suspended. Contact your administrator.', 'TENANT_SUSPENDED');

  const snapshot = await loadSnapshot(ctx.tenantId, ctx.userId);
  if (!snapshot || snapshot.membership.status !== 'active') throw forbidden('You are not a member of this workspace', 'NOT_A_MEMBER');

  ctx.tenant = loaded.tenant;
  ctx.settings = loaded.settings;
  ctx.membershipId = snapshot.membership.id;
  ctx.isOwner = snapshot.membership.is_owner;
  ctx.roleIds = snapshot.roleIds;
  ctx.roles = snapshot.roles;
  ctx.teamIds = snapshot.teamIds;
  ctx.teamUserIds = snapshot.teamUserIds;
  ctx.fieldAccess = snapshot.fieldAccess;
  ctx.permissions = ctx.apiKeyId ? intersect(snapshot.permissions, ctx.apiKeyScopes) : snapshot.permissions;

  const security = loaded.settings.security || {};
  if (security.require_mfa && ctx.authType === 'cookie' && !ctx.user.mfa_enabled && !MFA_SETUP_ALLOWLIST.some((re) => re.test(req.originalUrl))) {
    throw forbidden('This workspace requires two-factor authentication. Enable it in your profile.', 'MFA_SETUP_REQUIRED');
  }
  return next();
}

function requireVerifiedEmail(req, _res, next) {
  const env = require('../config/env');
  if (env.REQUIRE_EMAIL_VERIFICATION && req.ctx.user && !req.ctx.user.email_verified_at && req.ctx.authType === 'cookie') {
    return next(forbidden('Please verify your email address to continue', 'EMAIL_NOT_VERIFIED'));
  }
  return next();
}

module.exports = { tenantContext, requireVerifiedEmail, invalidateTenant, loadTenant };
