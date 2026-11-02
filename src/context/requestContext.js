'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

/**
 * Request-scoped context. The tenant scoping hooks in database/tenantScope.js
 * read `tenantId` from here, so application code never passes tenant ids
 * around manually and can never accidentally omit them.
 *
 * Store shape:
 *   requestId, ip, userAgent,
 *   userId, membershipId, tenantId, sessionId, apiKeyId,
 *   permissions: Map<permissionKey, scope>, roleIds, teamIds,
 *   isPlatformAdmin, systemReason (set only via runAsSystem), workflowDepth
 */
const als = new AsyncLocalStorage();

function getContext() {
  return als.getStore();
}

function run(store, fn) {
  return als.run(store, fn);
}

/** Runs fn inside the given tenant (used by background jobs and public endpoints). */
function runInTenant(tenantId, fn, extra = {}) {
  if (!tenantId) throw new Error('runInTenant requires a tenantId');
  const parent = als.getStore() || {};
  return als.run({ requestId: parent.requestId, ip: parent.ip, userAgent: parent.userAgent, ...extra, tenantId, systemReason: undefined }, fn);
}

/**
 * Explicitly bypasses tenant scoping. Only for platform-level maintenance
 * (job polling, platform admin, retention). A reason is mandatory and is logged.
 */
function runAsSystem(reason, fn) {
  if (!reason) throw new Error('runAsSystem requires a reason');
  const parent = als.getStore() || {};
  return als.run({ requestId: parent.requestId, ip: parent.ip, userAgent: parent.userAgent, actorType: 'system', systemReason: reason }, fn);
}

module.exports = { als, getContext, run, runInTenant, runAsSystem };
