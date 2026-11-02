'use strict';

const { Op } = require('sequelize');
const { stringify } = require('csv-stringify/sync');
const { createRouter } = require('../../utils/router');
const { z, idParams, uuid, requiredText, trimmed, email } = require('../../utils/schemas');
const { Report, Membership, User } = require('../../models');
const analytics = require('./analytics.service');
const { csvSafe } = require('../../core/entity/service');
const audit = require('../audit/audit.service');
const { getContext } = require('../../context/requestContext');
const { ok, created, noContent } = require('../../utils/http');
const E = require('../../errors/AppError');

const ENTITIES = ['lead', 'contact', 'account', 'opportunity', 'activity', 'ticket', 'quote', 'campaign'];
const dateRange = z.strictObject({ preset: z.enum(['today', 'last_7_days', 'last_30_days', 'this_month', 'last_month', 'this_quarter', 'this_year', 'custom']).optional(), from: z.string().max(40).optional(), to: z.string().max(40).optional() });
const spec = {
  entity_type: z.enum(ENTITIES),
  report_type: z.enum(['table', 'summary']).default('summary'),
  columns: z.array(z.string().max(80)).max(40).optional(),
  filters: z.strictObject({ filter: z.record(z.string(), z.any()).optional(), cf: z.record(z.string(), z.any()).optional() }).optional(),
  group_by: z.string().regex(/^[a-z_]+(:(day|week|month|quarter|year))?$/).nullish(),
  metric: z.strictObject({ fn: z.enum(['count', 'sum', 'avg', 'min', 'max']), field: z.string().max(80).optional() }).nullish(),
  date_field: z.string().max(80).nullish(),
  date_range: dateRange.nullish(),
};
const reportBody = z.strictObject({
  name: requiredText(160), description: trimmed(500).nullish(), ...spec,
  chart_type: z.enum(['bar', 'line', 'pie', 'table', 'funnel']).optional(), is_shared: z.boolean().optional(),
  schedule: z.strictObject({ frequency: z.enum(['daily', 'weekly', 'monthly']), recipients: z.array(email()).min(1).max(20) }).nullish(),
});
const analyticsQuery = z.object({ preset: dateRange.shape.preset, from: z.string().max(40).optional(), to: z.string().max(40).optional(), owner_id: z.string().max(40).optional(), team_id: uuid().optional(), pipeline_id: uuid().optional() });

function nextRun(schedule, from = new Date()) {
  if (!schedule) return null;
  const d = new Date(from);
  d.setUTCHours(6, 0, 0, 0);
  if (d <= from) d.setUTCDate(d.getUTCDate() + 1);
  if (schedule.frequency === 'weekly') while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  if (schedule.frequency === 'monthly') { d.setUTCDate(1); if (d <= from) d.setUTCMonth(d.getUTCMonth() + 1); }
  return d;
}

async function assertRecipientsAreMembers(schedule) {
  if (!schedule) return;
  const users = await User.findAll({ where: { email: schedule.recipients }, attributes: ['id', 'email'] });
  const members = await Membership.findAll({ where: { user_id: users.map((u) => u.id), status: 'active' }, attributes: ['user_id'] });
  if (members.length !== new Set(schedule.recipients).size) throw E.validation([{ path: 'schedule.recipients', message: 'Scheduled reports can only be sent to active workspace members' }]);
}

function visible(ctx) {
  return { [Op.or]: [{ owner_id: ctx.userId }, { is_shared: true }] };
}

const r = createRouter({ prefix: '/api/v1/reports', tag: 'Reports & analytics' });

r.get('/dashboard', { summary: 'Role-aware dashboard: KPIs, charts, activities, leaderboard', permission: 'dashboard:read', query: analyticsQuery }, async (req, res) => ok(res, await analytics.dashboard(req.valid.query)));
for (const [path, fn] of [['funnel', analytics.funnel], ['pipeline', analytics.pipeline], ['forecast', analytics.forecast], ['conversion', analytics.conversion], ['activities', analytics.activityReport], ['sales-performance', analytics.salesPerformance]]) {
  r.get(`/analytics/${path}`, { summary: `Analytics: ${path.replace('-', ' ')}`, permission: 'reports:read', query: analyticsQuery }, async (req, res) => ok(res, await fn(req.valid.query)));
}
r.post('/run', { summary: 'Run an ad-hoc report definition', permission: 'reports:read', body: z.strictObject(spec) }, async (req, res) => ok(res, await analytics.runReport(req.valid.body)));

r.get('/', { summary: 'Saved reports (mine + shared)', permission: 'reports:read' }, async (_req, res) => ok(res, await Report.findAll({ where: visible(getContext()), order: [['name', 'ASC']] })));
r.post('/', { summary: 'Save a report', permission: 'reports:create', body: reportBody }, async (req, res) => {
  await analytics.runReport(req.valid.body); // validates the definition against permissions/fields
  await assertRecipientsAreMembers(req.valid.body.schedule);
  const rep = await Report.create({ ...req.valid.body, owner_id: getContext().userId, next_run_at: nextRun(req.valid.body.schedule) });
  await audit.record({ action: 'report.created', entityType: 'report', entityId: rep.id, summary: `Report ${rep.name} saved` });
  return created(res, rep);
});
r.get('/:id', { summary: 'Get a saved report', permission: 'reports:read', params: idParams }, async (req, res) => {
  const rep = await Report.findOne({ where: { id: req.valid.params.id, ...visible(getContext()) } });
  if (!rep) throw E.notFound('Report');
  return ok(res, rep);
});
r.put('/:id', { summary: 'Update a saved report', permission: 'reports:update', params: idParams, body: reportBody }, async (req, res) => {
  const ctx = getContext();
  const rep = await Report.findOne({ where: { id: req.valid.params.id, owner_id: ctx.userId } });
  if (!rep) throw E.notFound('Report');
  await analytics.runReport(req.valid.body);
  await assertRecipientsAreMembers(req.valid.body.schedule);
  await rep.update({ ...req.valid.body, next_run_at: nextRun(req.valid.body.schedule) });
  return ok(res, rep);
});
r.delete('/:id', { summary: 'Delete a saved report', permission: 'reports:delete', params: idParams }, async (req, res) => {
  const n = await Report.destroy({ where: { id: req.valid.params.id, owner_id: getContext().userId } });
  if (!n) throw E.notFound('Report');
  return noContent(res);
});
r.get('/:id/run', { summary: 'Run a saved report (as the current user, with their permissions)', permission: 'reports:read', params: idParams }, async (req, res) => {
  const rep = await Report.findOne({ where: { id: req.valid.params.id, ...visible(getContext()) } });
  if (!rep) throw E.notFound('Report');
  return ok(res, { report: rep, result: await analytics.runReport(rep.get({ plain: true })) });
});
r.get('/:id/export', { summary: 'Export a saved report as CSV', permission: 'reports:export', params: idParams, produces: 'text/csv' }, async (req, res) => {
  const rep = await Report.findOne({ where: { id: req.valid.params.id, ...visible(getContext()) } });
  if (!rep) throw E.notFound('Report');
  const result = await analytics.runReport(rep.get({ plain: true }));
  const csv = toCsv(result);
  await audit.record({ action: 'report.exported', entityType: 'report', entityId: rep.id, summary: `Report ${rep.name} exported` });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="report-${rep.id}.csv"`);
  res.send(csv);
});

function toCsv(result) {
  if (result.columns) return stringify([result.columns, ...result.rows.map((row) => result.columns.map((c) => csvSafe(row[c])))]);
  return stringify([['group', 'label', 'value'], ...result.rows.map((x) => [csvSafe(x.group), csvSafe(x.label || x.group), x.value])]);
}

module.exports = r;
module.exports.toCsv = toCsv;
module.exports.nextRun = nextRun;
