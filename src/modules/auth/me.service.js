'use strict';

const { runInTenant } = require('../../context/requestContext');
const { activeMemberships } = require('./session.service');
const { loadSnapshot } = require('../rbac/permission.service');
const { loadTenant } = require('../../middleware/tenantContext');
const { currentPlan } = require('../billing/entitlements.service');

function publicUser(user) {
  return {
    id: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name, full_name: [user.first_name, user.last_name].filter(Boolean).join(' '),
    avatar_url: user.avatar_url, phone: user.phone, locale: user.locale, timezone: user.timezone,
    email_verified: !!user.email_verified_at, mfa_enabled: !!user.mfa_enabled, is_platform_admin: !!user.is_platform_admin,
    last_login_at: user.last_login_at,
  };
}

/** Everything the SPA needs to bootstrap: user, workspaces, active tenant, permissions and entitlements. */
async function buildMe(ctx) {
  const memberships = await activeMemberships(ctx.userId);
  const out = {
    user: publicUser(ctx.user),
    workspaces: memberships.map((m) => ({ id: m.tenant.id, name: m.tenant.name, slug: m.tenant.slug, is_owner: m.is_owner })),
    tenant: null,
    membership: null,
    permissions: {},
    field_access: {},
    plan: null,
  };
  const tenantId = ctx.tenantId && memberships.some((m) => m.tenant_id === ctx.tenantId) ? ctx.tenantId : null;
  if (!tenantId) return out;
  await runInTenant(tenantId, async () => {
    const [snapshot, loaded, plan] = await Promise.all([loadSnapshot(tenantId, ctx.userId), loadTenant(tenantId), currentPlan()]);
    if (!snapshot || snapshot.membership.status !== 'active') return;
    const s = loaded.settings;
    out.tenant = {
      id: loaded.tenant.id, name: loaded.tenant.name, slug: loaded.tenant.slug, status: loaded.tenant.status,
      settings: {
        branding: s.branding, locale: s.locale, timezone: s.timezone, currency: s.currency, date_format: s.date_format,
        fiscal_year_start_month: s.fiscal_year_start_month, modules: s.modules,
        security: { require_mfa: !!s.security?.require_mfa, password_min_length: s.security?.password_min_length },
        preferences: {
          lead_sources: s.preferences?.lead_sources, industries: s.preferences?.industries, loss_reasons: s.preferences?.loss_reasons,
          quote_approval_discount_threshold: s.preferences?.quote_approval_discount_threshold,
        },
      },
    };
    out.membership = { id: snapshot.membership.id, is_owner: snapshot.membership.is_owner, roles: snapshot.roles, team_ids: snapshot.teamIds };
    out.permissions = Object.fromEntries(snapshot.permissions);
    out.field_access = snapshot.fieldAccess;
    out.plan = { code: plan.plan.code, name: plan.plan.name, features: plan.plan.features, limits: plan.plan.limits, status: plan.subscription?.status, trial_ends_at: plan.subscription?.trial_ends_at };
  });
  return out;
}

module.exports = { buildMe, publicUser };
