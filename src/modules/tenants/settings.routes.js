'use strict';

const { createRouter } = require('../../utils/router');
const { z, trimmed, requiredText, optionalUrl } = require('../../utils/schemas');
const { sequelize, TenantSettings, Tenant, Plan, Membership } = require('../../models');
const audit = require('../audit/audit.service');
const usage = require('../billing/usage.service');
const { currentPlan, invalidatePlan } = require('../billing/entitlements.service');
const { invalidateTenant } = require('../../middleware/tenantContext');
const { ALL_MODULES } = require('../../config/plans');
const { ok } = require('../../utils/http');
const { getContext } = require('../../context/requestContext');
const E = require('../../errors/AppError');

const r = createRouter({ prefix: '/api/v1/settings', tag: 'Tenant settings' });

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex colour like #4f46e5');
const scoringRule = z.strictObject({
  field: z.string().regex(/^[a-z_][a-z0-9_.]{0,80}$/),
  op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'contains_any', 'is_empty', 'is_not_empty', 'is_true']),
  value: z.any().optional(),
  points: z.coerce.number().int().min(-100).max(100),
});
const isTimeZone = (tz) => {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const settingsBody = z.strictObject({
  branding: z.strictObject({ primary_color: color.optional(), accent_color: color.optional(), logo_url: optionalUrl(), display_name: trimmed(160).nullish() }).optional(),
  locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).optional(),
  timezone: z.string().max(64).refine(isTimeZone, 'Unknown time zone').optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  date_format: z.enum(['yyyy-MM-dd', 'dd/MM/yyyy', 'MM/dd/yyyy', 'dd.MM.yyyy']).optional(),
  fiscal_year_start_month: z.coerce.number().int().min(1).max(12).optional(),
  security: z.strictObject({
    require_mfa: z.boolean().optional(),
    password_min_length: z.coerce.number().int().min(10).max(128).optional(),
    session_max_hours: z.coerce.number().int().min(1).max(24 * 90).optional(),
    invite_expiry_days: z.coerce.number().int().min(1).max(30).optional(),
    allowed_email_domains: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).max(20).optional(),
  }).optional(),
  modules: z.record(z.enum(ALL_MODULES), z.boolean()).optional(),
  preferences: z.strictObject({
    lead_sources: z.array(trimmed(60).min(1)).max(50).optional(),
    industries: z.array(trimmed(80).min(1)).max(100).optional(),
    loss_reasons: z.array(trimmed(120).min(1)).max(50).optional(),
    quote_approval_discount_threshold: z.coerce.number().min(0).max(100).optional(),
    quote_validity_days: z.coerce.number().int().min(1).max(365).optional(),
    stalled_deal_days: z.coerce.number().int().min(1).max(365).optional(),
    audit_record_access: z.boolean().optional(),
    retention: z.strictObject({ audit_days: z.coerce.number().int().min(30).max(3650).optional(), deleted_records_days: z.coerce.number().int().min(1).max(365).optional(), workflow_runs_days: z.coerce.number().int().min(7).max(365).optional() }).optional(),
    lead_scoring: z.strictObject({ rules: z.array(scoringRule).max(50) }).optional(),
  }).optional(),
});

function present(s, tenant) {
  const plain = { ...s.get({ plain: true }) };
  delete plain.tenant_id;
  return { ...plain, tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status, created_at: tenant.created_at } };
}

r.get('/', { summary: 'Get tenant configuration', permission: 'settings:read' }, async (_req, res) => {
  const ctx = getContext();
  const s = await TenantSettings.findOne({ where: {} });
  return ok(res, present(s, await Tenant.findByPk(ctx.tenantId)));
});

r.patch('/', { summary: 'Update tenant configuration (branding, locale, security, modules, preferences)', permission: 'settings:manage', body: settingsBody }, async (req, res) => {
  const ctx = getContext();
  const body = req.valid.body;
  if (body.security && !ctx.isOwner && !ctx.permissions.has('roles:manage')) throw E.forbidden('Changing security policy requires the owner or a role manager', 'SECURITY_POLICY');
  const saved = await sequelize.transaction(async (transaction) => {
    const s = await TenantSettings.findOne({ where: {}, transaction, lock: transaction.LOCK.UPDATE });
    const before = { ...s.get({ plain: true }) };
    const merge = (key) => (body[key] ? { ...(before[key] || {}), ...body[key] } : before[key]);
    const preferences = body.preferences ? { ...(before.preferences || {}), ...body.preferences, retention: { ...(before.preferences?.retention || {}), ...(body.preferences.retention || {}) } } : before.preferences;
    await s.update({
      ...(['locale', 'timezone', 'currency', 'date_format', 'fiscal_year_start_month'].reduce((acc, k) => (body[k] !== undefined ? { ...acc, [k]: body[k] } : acc), {})),
      branding: merge('branding'), security: merge('security'), modules: merge('modules'), preferences,
    }, { transaction });
    await audit.record({ action: body.security ? 'settings.security_updated' : 'settings.updated', entityType: 'tenant', entityId: ctx.tenantId, summary: 'Workspace settings updated', changes: audit.diff(before, s.get({ plain: true }), Object.keys(body)) }, { transaction });
    return s;
  });
  invalidateTenant(ctx.tenantId);
  return ok(res, present(saved, await Tenant.findByPk(ctx.tenantId)));
});

r.patch('/profile', { summary: 'Rename the workspace', permission: 'settings:manage', body: z.strictObject({ name: requiredText(160) }) }, async (req, res) => {
  const ctx = getContext();
  await Tenant.update({ name: req.valid.body.name }, { where: { id: ctx.tenantId } });
  await audit.record({ action: 'tenant.renamed', entityType: 'tenant', entityId: ctx.tenantId, summary: `Workspace renamed to ${req.valid.body.name}` });
  invalidateTenant(ctx.tenantId);
  return ok(res, { name: req.valid.body.name });
});

r.get('/subscription', { summary: 'Plan, entitlements, seats and usage', permission: ['billing:read', 'settings:read'] }, async (_req, res) => {
  const { plan, subscription } = await currentPlan();
  const [seatsUsed, usageRows, plans] = await Promise.all([Membership.count({ where: { status: 'active' } }), usage.summary({ days: 30 }), Plan.findAll({ where: { is_active: true }, order: [['sort_order', 'ASC']] })]);
  const totals = {};
  for (const row of usageRows) totals[row.metric] = (totals[row.metric] || 0) + Number(row.value);
  return ok(res, { plan, subscription, seats_used: seatsUsed, usage_30d: totals, available_plans: plans, billing_provider_configured: !!(process.env.STRIPE_SECRET_KEY || process.env.RAZORPAY_KEY_ID) });
});

r.post('/subscription/change-plan', {
  summary: 'Change plan (manual billing). Paid providers require configuration.', permission: 'billing:manage',
  body: z.strictObject({ plan_code: z.string().max(40) }),
}, async (req, res) => {
  const ctx = getContext();
  const plan = await Plan.findOne({ where: { code: req.valid.body.plan_code, is_active: true } });
  if (!plan) throw E.validation([{ path: 'plan_code', message: 'Unknown plan' }]);
  const billing = require('../billing/billing.service');
  const result = await billing.changePlan(plan);
  invalidatePlan(ctx.tenantId);
  return ok(res, result);
});

module.exports = r;
