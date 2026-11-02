'use strict';

const os = require('node:os');
const { Op, fn, col } = require('sequelize');
const { createRouter } = require('../../utils/router');
const { z, idParams, trimmed } = require('../../utils/schemas');
const { sequelize, Tenant, Plan, TenantSubscription, Membership, User, Job, PlatformAuditLog, TenantUsage } = require('../../models');
const { authenticate } = require('../../middleware/authenticate');
const { csrfProtection } = require('../../middleware/csrf');
const { requirePlatformAdmin } = require('../../middleware/platformAdmin');
const { runAsSystem, runInTenant } = require('../../context/requestContext');
const { invalidateTenant } = require('../../middleware/tenantContext');
const { invalidatePlan } = require('../billing/entitlements.service');
const audit = require('../audit/audit.service');
const { ok } = require('../../utils/http');
const E = require('../../errors/AppError');

/**
 * Platform administration. Platform admins manage tenants (status, plans,
 * usage) but have NO access to tenant CRM records through these endpoints.
 * Every call is recorded in platform_audit_logs, and tenant-affecting
 * actions are also written to that tenant's own audit log.
 */
const r = createRouter({ prefix: '/api/v1/platform', tag: 'Platform administration', auth: 'platform' });
r.router.use(authenticate(), csrfProtection, requirePlatformAdmin, (req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode < 400) {
      audit.recordPlatform({ action: `platform.${req.method.toLowerCase()}`, summary: `${req.method} ${req.originalUrl.split('?')[0]}`, targetTenantId: req.params?.id || null }).catch(() => {});
    }
  });
  next();
});

const sys = (reason, fnc) => runAsSystem(`platform:${reason}`, fnc);

r.get('/tenants', {
  summary: 'List tenants with plan and seat counts',
  query: z.object({ q: z.string().max(100).optional(), status: z.enum(['active', 'suspended', 'pending_deletion']).optional(), page: z.coerce.number().int().min(1).optional() }),
}, async (req, res) => {
  const { q, status, page = 1 } = req.valid.query;
  const where = {};
  if (status) where.status = status;
  if (q) where[Op.or] = [{ name: { [Op.like]: `%${q}%` } }, { slug: { [Op.like]: `%${q}%` } }];
  const { rows, count } = await sys('list-tenants', () => Tenant.findAndCountAll({ where, include: [{ model: Plan, as: 'plan', attributes: ['code', 'name'] }], order: [['created_at', 'DESC']], limit: 50, offset: (page - 1) * 50 }));
  const seats = await sys('seat-counts', () => Membership.findAll({ where: { tenant_id: rows.map((t) => t.id), status: 'active' }, attributes: ['tenant_id', [fn('COUNT', col('id')), 'n']], group: ['tenant_id'], raw: true }));
  const byTenant = new Map(seats.map((s) => [s.tenant_id, Number(s.n)]));
  return ok(res, rows.map((t) => ({ ...t.toJSON(), active_users: byTenant.get(t.id) || 0 })), { page, page_size: 50, total: count, total_pages: Math.ceil(count / 50) });
});

r.get('/tenants/:id', { summary: 'Tenant details, subscription and usage', params: idParams }, async (req, res) => {
  const tenant = await sys('get-tenant', () => Tenant.findByPk(req.valid.params.id, { include: [{ model: Plan, as: 'plan' }] }));
  if (!tenant) throw E.notFound('Tenant');
  const [subscription, usage, owner, members] = await sys('tenant-details', () => Promise.all([
    TenantSubscription.findOne({ where: { tenant_id: tenant.id }, order: [['created_at', 'DESC']] }),
    TenantUsage.findAll({ where: { tenant_id: tenant.id, period: { [Op.gte]: new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10) } }, order: [['period', 'ASC']] }),
    tenant.owner_user_id ? User.findByPk(tenant.owner_user_id, { attributes: ['id', 'email', 'first_name', 'last_name'] }) : null,
    Membership.count({ where: { tenant_id: tenant.id, status: 'active' } }),
  ]));
  return ok(res, { tenant, subscription, usage, owner, active_users: members });
});

async function setStatus(req, status) {
  const id = req.valid.params.id;
  const reason = req.valid.body?.reason || null;
  const tenant = await sys('set-status', () => Tenant.findByPk(id));
  if (!tenant) throw E.notFound('Tenant');
  await sys('set-status', () => tenant.update({ status, suspended_at: status === 'suspended' ? new Date() : null, suspended_reason: status === 'suspended' ? reason : null }));
  await runInTenant(id, () => audit.record({ action: `tenant.${status === 'active' ? 'reactivated' : 'suspended'}`, entityType: 'tenant', entityId: id, summary: `Workspace ${status === 'active' ? 'reactivated' : 'suspended'} by platform administrator`, metadata: { reason } }), { userId: req.ctx.userId, userEmail: req.ctx.userEmail, isPlatformAdminAction: true });
  await audit.recordPlatform({ action: `tenant.${status}`, targetTenantId: id, summary: reason });
  invalidateTenant(id);
  return tenant;
}

r.post('/tenants/:id/suspend', { summary: 'Suspend a tenant (all access blocked)', params: idParams, body: z.strictObject({ reason: trimmed(500).min(3) }) }, async (req, res) => ok(res, await setStatus(req, 'suspended')));
r.post('/tenants/:id/reactivate', { summary: 'Reactivate a suspended tenant', params: idParams }, async (req, res) => ok(res, await setStatus(req, 'active')));

r.post('/tenants/:id/plan', {
  summary: 'Change a tenant plan / seats (manual billing)', params: idParams,
  body: z.strictObject({ plan_code: z.string().max(40), seats: z.coerce.number().int().min(1).max(100000).optional(), status: z.enum(['trialing', 'active', 'past_due', 'canceled']).optional() }),
}, async (req, res) => {
  const id = req.valid.params.id;
  const plan = await Plan.findOne({ where: { code: req.valid.body.plan_code } });
  if (!plan) throw E.validation([{ path: 'plan_code', message: 'Unknown plan' }]);
  await runInTenant(id, () => sequelize.transaction(async (transaction) => {
    const sub = await TenantSubscription.findOne({ where: {}, order: [['created_at', 'DESC']], transaction });
    const values = { plan_id: plan.id, seats: req.valid.body.seats ?? plan.limits?.seats ?? 5, status: req.valid.body.status || 'active', provider: 'manual' };
    if (sub) await sub.update(values, { transaction });
    else await TenantSubscription.create(values, { transaction });
    await Tenant.update({ plan_id: plan.id }, { where: { id }, transaction });
    await audit.record({ action: 'billing.plan_changed', entityType: 'tenant', entityId: id, summary: `Plan set to ${plan.name} by platform administrator`, metadata: values }, { transaction });
  }), { userId: req.ctx.userId, userEmail: req.ctx.userEmail, isPlatformAdminAction: true });
  invalidatePlan(id);
  return ok(res, { plan: plan.code });
});

r.get('/plans', { summary: 'List plans' }, async (_req, res) => ok(res, await Plan.findAll({ order: [['sort_order', 'ASC']] })));

r.get('/health', { summary: 'Platform health overview' }, async (_req, res) => {
  const [dbOk, jobStats, tenants, users] = await sys('health', () => Promise.all([
    sequelize.query('SELECT 1').then(() => true).catch(() => false),
    Job.findAll({ attributes: ['status', [fn('COUNT', col('id')), 'n']], group: ['status'], raw: true }),
    Tenant.findAll({ attributes: ['status', [fn('COUNT', col('id')), 'n']], group: ['status'], raw: true }),
    User.count(),
  ]));
  const oldestPending = await sys('health', () => Job.findOne({ where: { status: 'pending', run_at: { [Op.lte]: new Date() } }, order: [['run_at', 'ASC']], attributes: ['run_at', 'type'] }));
  return ok(res, {
    database: dbOk ? 'ok' : 'unavailable',
    jobs: Object.fromEntries(jobStats.map((j) => [j.status, Number(j.n)])),
    oldest_pending_job_age_s: oldestPending ? Math.round((Date.now() - new Date(oldestPending.run_at)) / 1000) : 0,
    tenants: Object.fromEntries(tenants.map((t) => [t.status, Number(t.n)])),
    users,
    process: { uptime_s: Math.round(process.uptime()), rss_mb: Math.round(process.memoryUsage().rss / 1048576), node: process.version, host: os.hostname(), load: os.loadavg() },
  });
});

r.get('/jobs/failed', { summary: 'Recently dead jobs (no payloads)' }, async (_req, res) =>
  ok(res, await sys('jobs', () => Job.findAll({ where: { status: 'dead' }, order: [['updated_at', 'DESC']], limit: 100, attributes: ['id', 'tenant_id', 'type', 'attempts', 'last_error', 'updated_at'] }))));

r.get('/audit', { summary: 'Platform audit log' }, async (_req, res) => ok(res, await PlatformAuditLog.findAll({ order: [['created_at', 'DESC']], limit: 200 })));

module.exports = r.router;
