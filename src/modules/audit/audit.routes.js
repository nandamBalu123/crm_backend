'use strict';

const { Op } = require('sequelize');
const { stringify } = require('csv-stringify');
const { createRouter } = require('../../utils/router');
const { z, uuid } = require('../../utils/schemas');
const { AuditLog, User } = require('../../models');
const audit = require('./audit.service');
const { csvSafe } = require('../../core/entity/service');
const { ok } = require('../../utils/http');

/** Read-only audit log access. There are deliberately no create/update/delete endpoints. */
const r = createRouter({ prefix: '/api/v1/audit-logs', tag: 'Audit logs' });
const query = z.object({
  action: z.string().max(80).optional(), entity_type: z.string().max(40).optional(), entity_id: uuid().optional(), actor_user_id: uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(), page: z.coerce.number().int().min(1).max(10000).optional(),
});

function where(q) {
  const w = {};
  if (q.action) w.action = q.action.endsWith('*') ? { [Op.like]: `${q.action.slice(0, -1).replace(/[%_\\]/g, '\\$&')}%` } : q.action;
  for (const k of ['entity_type', 'entity_id', 'actor_user_id']) if (q[k]) w[k] = q[k];
  if (q.from || q.to) w.created_at = { ...(q.from ? { [Op.gte]: new Date(q.from) } : {}), ...(q.to ? { [Op.lt]: new Date(q.to) } : {}) };
  return w;
}

r.get('/', { summary: 'Search the audit log', permission: 'audit:read', query }, async (req, res) => {
  const page = req.valid.query.page || 1;
  const { rows, count } = await AuditLog.findAndCountAll({ where: where(req.valid.query), order: [['created_at', 'DESC']], limit: 50, offset: (page - 1) * 50, include: [{ model: User, as: 'actor', attributes: ['id', 'first_name', 'last_name', 'email'] }] });
  return ok(res, rows.map((x) => ({ ...x.toJSON(), tenant_id: undefined })), { page, page_size: 50, total: count, total_pages: Math.ceil(count / 50) });
});

r.get('/export', { summary: 'Export audit log entries as CSV (max 50k)', permission: 'audit:read', query, produces: 'text/csv' }, async (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
  const csv = stringify({ header: true, columns: ['created_at', 'actor_type', 'actor_label', 'action', 'entity_type', 'entity_id', 'summary', 'ip', 'request_id'] });
  csv.pipe(res);
  const rows = await AuditLog.findAll({ where: where(req.valid.query), order: [['created_at', 'DESC']], limit: 50_000 });
  for (const x of rows) csv.write(['created_at', 'actor_type', 'actor_label', 'action', 'entity_type', 'entity_id', 'summary', 'ip', 'request_id'].map((c) => csvSafe(x[c])));
  csv.end();
  await audit.record({ action: 'audit.exported', summary: `Audit log exported (${rows.length} rows)` });
});

module.exports = r;
