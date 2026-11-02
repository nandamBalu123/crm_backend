'use strict';

const { AuditLog, PlatformAuditLog } = require('../../models');
const { getContext } = require('../../context/requestContext');

const SENSITIVE = /pass(word)?|secret|token|api_?key|credential|mfa|hash|authorization|cookie/i;

/** Recursively replaces sensitive values so they never land in audit storage. */
function redact(value, depth = 0) {
  if (value === null || value === undefined || depth > 5) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    return out;
  }
  return value;
}

/** Field-level diff of two plain objects restricted to `fields` (or all keys). */
function diff(before = {}, after = {}, fields) {
  const keys = fields || [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];
  const changes = {};
  for (const k of keys) {
    if (['updated_at', 'created_at', 'version'].includes(k)) continue;
    const a = before?.[k];
    const b = after?.[k];
    const norm = (v) => (v instanceof Date ? v.toISOString() : v === undefined ? null : JSON.stringify(v));
    if (norm(a) !== norm(b)) changes[k] = { from: a ?? null, to: b ?? null };
  }
  return changes;
}

function actor() {
  const ctx = getContext() || {};
  if (ctx.apiKeyId) return { actor_type: 'api_key', actor_user_id: ctx.userId || null, actor_label: `api_key:${ctx.apiKeyPrefix}` };
  if (ctx.isPlatformAdminAction) return { actor_type: 'platform_admin', actor_user_id: ctx.userId, actor_label: ctx.userEmail };
  if (ctx.userId) return { actor_type: 'user', actor_user_id: ctx.userId, actor_label: ctx.userEmail || null };
  if (ctx.actorType === 'public') return { actor_type: 'public', actor_user_id: null, actor_label: ctx.actorLabel || 'public' };
  return { actor_type: 'system', actor_user_id: null, actor_label: ctx.actorLabel || 'system' };
}

/**
 * Appends an audit entry for the active tenant. Accepts an optional
 * transaction so the entry commits atomically with the business change.
 */
async function record({ action, entityType = null, entityId = null, summary = null, changes = null, metadata = null, tenantId }, { transaction } = {}) {
  const ctx = getContext() || {};
  return AuditLog.create(
    {
      ...(tenantId ? { tenant_id: tenantId } : {}),
      ...actor(),
      action,
      entity_type: entityType,
      entity_id: entityId,
      summary: summary ? String(summary).slice(0, 500) : null,
      changes: changes ? redact(changes) : null,
      metadata: metadata ? redact(metadata) : null,
      ip: ctx.ip || null,
      user_agent: ctx.userAgent ? String(ctx.userAgent).slice(0, 400) : null,
      request_id: ctx.requestId || null,
    },
    { transaction }
  );
}

async function recordPlatform({ action, targetTenantId = null, summary = null, metadata = null }) {
  const ctx = getContext() || {};
  await PlatformAuditLog.create({
    actor_user_id: ctx.userId || null,
    action,
    target_tenant_id: targetTenantId,
    summary,
    metadata: metadata ? redact(metadata) : null,
    ip: ctx.ip || null,
    user_agent: ctx.userAgent ? String(ctx.userAgent).slice(0, 400) : null,
    request_id: ctx.requestId || null,
  });
}

module.exports = { record, recordPlatform, redact, diff };
