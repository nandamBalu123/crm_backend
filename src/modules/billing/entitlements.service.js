'use strict';

const { Membership, TenantSubscription, Plan, Tenant } = require('../../models');
const { getContext } = require('../../context/requestContext');
const E = require('../../errors/AppError');
const { TtlCache } = require('../../utils/ttlCache');

const planCache = new TtlCache(30_000);

/** Loads the active subscription + plan for the current tenant (cached briefly). */
async function currentPlan({ transaction } = {}) {
  const tenantId = getContext()?.tenantId;
  const cached = !transaction && planCache.get(tenantId);
  if (cached) return cached;
  const sub = await TenantSubscription.findOne({ where: {}, order: [['created_at', 'DESC']], transaction });
  let plan = sub ? await Plan.findByPk(sub.plan_id, { transaction }) : null;
  if (!plan) {
    const tenant = await Tenant.findByPk(tenantId, { transaction });
    plan = tenant?.plan_id ? await Plan.findByPk(tenant.plan_id, { transaction }) : null;
  }
  const value = {
    subscription: sub ? sub.get({ plain: true }) : null,
    plan: plan ? plan.get({ plain: true }) : { code: 'none', limits: {}, features: [] },
  };
  if (!transaction) planCache.set(tenantId, value);
  return value;
}

function invalidatePlan(tenantId) {
  planCache.delete(tenantId);
}

async function assertSeatAvailable({ transaction } = {}) {
  const { plan, subscription } = await currentPlan({ transaction });
  const seats = Math.min(subscription?.seats ?? Infinity, plan.limits?.seats ?? Infinity);
  const used = await Membership.count({ where: { status: 'active' }, transaction });
  if (used >= seats) throw E.limit(`Your plan allows ${seats} active users. Upgrade or free a seat to add more.`);
}

/** Module entitlement = plan feature AND enabled in tenant settings. */
async function isModuleEnabled(moduleKey) {
  const ctx = getContext();
  const { plan } = await currentPlan();
  const planOk = !plan.features?.length || plan.features.includes(moduleKey);
  const tenantOk = ctx?.settings?.modules?.[moduleKey] !== false;
  return planOk && tenantOk;
}

function requireModule(moduleKey) {
  return async (_req, _res, next) => {
    if (!(await isModuleEnabled(moduleKey))) return next(E.forbidden(`The ${moduleKey} module is not enabled for this workspace`, 'MODULE_DISABLED'));
    return next();
  };
}

async function assertLimit(metric, currentCount) {
  const { plan } = await currentPlan();
  const limit = plan.limits?.[metric];
  if (limit !== undefined && currentCount >= limit) throw E.limit(`Plan limit reached for ${metric.replace(/_/g, ' ')} (${limit}).`);
}

module.exports = { currentPlan, invalidatePlan, assertSeatAvailable, isModuleEnabled, requireModule, assertLimit };
