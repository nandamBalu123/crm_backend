'use strict';

const { Op } = require('sequelize');
const { getContext } = require('../context/requestContext');
const { TenantContextError } = require('../errors/AppError');

/**
 * Automatic tenant isolation for Sequelize models flagged with
 * `options.tenantScoped = true`.
 *
 *  - find / count / bulk update / bulk destroy: `tenant_id = ctx.tenantId` is AND-ed into WHERE
 *  - included tenant-scoped models get the same predicate
 *  - create / bulkCreate: tenant_id is set from the context; a conflicting value throws
 *  - instance update/destroy: the instance must belong to the context tenant
 *  - with no tenant context (and no explicit runAsSystem) every operation throws
 *
 * Static helpers that skip hooks (Model.sum/max/min/aggregate/increment, raw
 * sequelize.query) must not be used on tenant models; see docs/MULTI_TENANCY.md.
 */

function currentTenant(modelName, operation) {
  const ctx = getContext();
  if (ctx && ctx.tenantId) return ctx.tenantId;
  if (ctx && ctx.systemReason) return null; // explicit, audited bypass
  throw new TenantContextError(`Tenant context missing for ${operation} on ${modelName}`);
}

function andTenant(where, tenantId) {
  if (!where || (typeof where === 'object' && Object.keys(where).length === 0 && !Object.getOwnPropertySymbols(where).length)) {
    return { tenant_id: tenantId };
  }
  if (where.tenant_id !== undefined && typeof where.tenant_id !== 'object' && where.tenant_id !== tenantId) {
    throw new TenantContextError('Query tenant_id does not match the active tenant');
  }
  return { [Op.and]: [where, { tenant_id: tenantId }] };
}

function scopeIncludes(includes, tenantId) {
  if (!includes) return;
  const list = Array.isArray(includes) ? includes : [includes];
  for (const inc of list) {
    if (!inc || typeof inc !== 'object' || !inc.model) continue;
    if (inc.model.options && inc.model.options.tenantScoped) {
      const required = inc.required;
      inc.where = andTenant(inc.where, tenantId);
      // Adding a WHERE to an include flips Sequelize's default to INNER JOIN; keep caller intent.
      inc.required = required === undefined ? false : required;
    }
    scopeIncludes(inc.include, tenantId);
  }
}

function install(model) {
  const name = model.name;

  model.addHook('beforeFind', 'tenantScope', (options) => {
    const tenantId = currentTenant(name, 'find');
    if (tenantId) options.where = andTenant(options.where, tenantId);
  });
  model.addHook('beforeFindAfterExpandIncludeAll', 'tenantScopeIncludes', (options) => {
    const tenantId = currentTenant(name, 'find');
    if (tenantId) scopeIncludes(options.include, tenantId);
  });
  model.addHook('beforeCount', 'tenantScope', (options) => {
    const tenantId = currentTenant(name, 'count');
    if (tenantId) {
      options.where = andTenant(options.where, tenantId);
      scopeIncludes(options.include, tenantId);
    }
  });
  for (const hook of ['beforeBulkUpdate', 'beforeBulkDestroy', 'beforeBulkRestore']) {
    model.addHook(hook, 'tenantScope', (options) => {
      const tenantId = currentTenant(name, hook);
      if (tenantId) options.where = andTenant(options.where, tenantId);
      if (options.attributes && 'tenant_id' in options.attributes) {
        throw new TenantContextError('tenant_id cannot be changed');
      }
    });
  }
  model.addHook('beforeValidate', 'tenantScope', (instance) => {
    if (!instance.isNewRecord) return;
    const tenantId = currentTenant(name, 'create');
    if (!tenantId) {
      if (!instance.tenant_id) throw new TenantContextError(`System create on ${name} requires explicit tenant_id`);
      return;
    }
    if (instance.tenant_id && instance.tenant_id !== tenantId) {
      throw new TenantContextError('Cannot create a record for another tenant');
    }
    instance.tenant_id = tenantId;
  });
  model.addHook('beforeBulkCreate', 'tenantScope', (instances) => {
    const tenantId = currentTenant(name, 'bulkCreate');
    for (const instance of instances) {
      if (!tenantId) {
        if (!instance.tenant_id) throw new TenantContextError(`System bulkCreate on ${name} requires tenant_id`);
        continue;
      }
      if (instance.tenant_id && instance.tenant_id !== tenantId) {
        throw new TenantContextError('Cannot create a record for another tenant');
      }
      instance.tenant_id = tenantId;
    }
  });
  for (const hook of ['beforeUpdate', 'beforeDestroy', 'beforeRestore']) {
    model.addHook(hook, 'tenantScope', (instance) => {
      const tenantId = currentTenant(name, hook);
      if (instance.changed && instance.changed('tenant_id') && !instance.isNewRecord) {
        throw new TenantContextError('tenant_id cannot be changed');
      }
      if (tenantId && instance.tenant_id !== tenantId) {

        throw new TenantContextError(`Cross-tenant ${hook} blocked on ${name}`);
      }
    });
  }
  model.addHook('beforeUpsert', 'tenantScope', () => {
    throw new TenantContextError(`upsert is not supported on tenant-scoped model ${name}`);
  });
}

module.exports = { install, andTenant };
