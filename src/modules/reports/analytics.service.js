'use strict';

const { Op, fn, col, literal } = require('sequelize');
const { Lead, Opportunity, PipelineStage, Pipeline, Activity, Ticket, User } = require('../../models');
const registry = require('../../core/entity/registry');
const { scopeWhere, fieldRules } = require('../../core/entity/policy');
const { buildFilterWhere } = require('../../core/entity/query');
const cf = require('../customFields/customFields.service');
const { scopeFor } = require('../../middleware/authorize');
const { getContext } = require('../../context/requestContext');
const E = require('../../errors/AppError');

/**
 * All aggregates go through tenant-scoped models (hooks) AND the caller's
 * record scope for the module, so a sales rep's dashboard only aggregates
 * the records that rep may read.
 */
function scoped(type) {
  const ctx = getContext();
  const def = registry.get(type);
  const scope = scopeFor(ctx, `${def.module}:read`);
  if (!scope) return null;
  return { def, where: scopeWhere(def, ctx, scope) };
}

function presetRange(preset, fiscalStartMonth = 1) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start = (yy, mm, dd = 1) => new Date(Date.UTC(yy, mm, dd));
  switch (preset) {
    case 'today': return [start(y, m, now.getUTCDate()), start(y, m, now.getUTCDate() + 1)];
    case 'last_7_days': return [new Date(now - 7 * 86400_000), now];
    case 'last_30_days': return [new Date(now - 30 * 86400_000), now];
    case 'this_month': return [start(y, m), start(y, m + 1)];
    case 'last_month': return [start(y, m - 1), start(y, m)];
    case 'this_quarter': {
      const q = Math.floor(((m - (fiscalStartMonth - 1) + 12) % 12) / 3);
      const qs = (fiscalStartMonth - 1 + q * 3) % 12;
      const qy = qs > m ? y - 1 : y;
      return [start(qy, qs), start(qy, qs + 3)];
    }
    case 'this_year': {
      const fy = m >= fiscalStartMonth - 1 ? y : y - 1;
      return [start(fy, fiscalStartMonth - 1), start(fy + 1, fiscalStartMonth - 1)];
    }
    default: return null;
  }
}

function range({ from, to, preset } = {}) {
  const ctx = getContext();
  if (preset && preset !== 'custom') return presetRange(preset, ctx.settings?.fiscal_year_start_month || 1);
  if (from || to) return [from ? new Date(from) : new Date(0), to ? new Date(to) : new Date()];
  return null;
}

const dateWhere = (field, r) => (r ? { [field]: { [Op.gte]: r[0], [Op.lt]: r[1] } } : {});
const ownerFilter = (f) => {
  const ctx = getContext();
  if (f.owner_id) return { owner_id: f.owner_id === 'me' ? ctx.userId : f.owner_id };
  if (f.team_user_ids) return { owner_id: { [Op.in]: f.team_user_ids } };
  return {};
};
const num = (v) => Number(v || 0);

async function funnel(f = {}) {
  const s = scoped('lead');
  if (!s) throw E.forbidden('Missing permission: leads:read', 'PERMISSION_DENIED');
  const r = range(f);
  const rows = await Lead.findAll({ where: { [Op.and]: [s.where, dateWhere('created_at', r), ownerFilter(f)] }, attributes: ['status', [fn('COUNT', col('id')), 'n']], group: ['status'], raw: true });
  const by = Object.fromEntries(rows.map((x) => [x.status, num(x.n)]));
  const total = rows.reduce((a, x) => a + num(x.n), 0);
  const order = ['new', 'contacted', 'nurturing', 'qualified', 'converted'];
  // cumulative funnel: a lead that reached a later stage also passed earlier ones
  const stages = order.map((st, i) => ({ stage: st, count: order.slice(i).reduce((a, k) => a + (by[k] || 0), 0) }));
  return { total, unqualified: by.unqualified || 0, stages, conversion_rate: total ? +((by.converted || 0) / total).toFixed(4) : 0 };
}

async function pipeline(f = {}) {
  const s = scoped('opportunity');
  if (!s) throw E.forbidden('Missing permission: opportunities:read', 'PERMISSION_DENIED');
  const pipe = f.pipeline_id ? await Pipeline.findByPk(f.pipeline_id) : await Pipeline.findOne({ where: { is_default: true } });
  if (!pipe) return { pipeline: null, stages: [] };
  const stages = await PipelineStage.findAll({ where: { pipeline_id: pipe.id, is_active: true }, order: [['display_order', 'ASC']] });
  const rows = await Opportunity.findAll({
    where: { [Op.and]: [s.where, { pipeline_id: pipe.id, status: 'open' }, ownerFilter(f)] },
    attributes: ['stage_id', [fn('COUNT', col('id')), 'n'], [fn('SUM', col('amount')), 'amount'], [fn('SUM', literal('amount * probability / 100')), 'weighted']],
    group: ['stage_id'], raw: true,
  });
  const by = new Map(rows.map((x) => [x.stage_id, x]));
  return {
    pipeline: { id: pipe.id, name: pipe.name },
    stages: stages.filter((st) => st.category === 'open').map((st) => ({ stage_id: st.id, name: st.name, probability: st.probability, count: num(by.get(st.id)?.n), amount: num(by.get(st.id)?.amount).toFixed(2), weighted: num(by.get(st.id)?.weighted).toFixed(2) })),
  };
}

async function forecast(f = {}) {
  const s = scoped('opportunity');
  if (!s) throw E.forbidden('Missing permission: opportunities:read', 'PERMISSION_DENIED');
  const r = range({ preset: 'this_year', ...f });
  const month = fn('DATE_FORMAT', col('expected_close_date'), '%Y-%m');
  const open = await Opportunity.findAll({
    where: { [Op.and]: [s.where, { status: 'open' }, dateWhere('expected_close_date', r), ownerFilter(f)] },
    attributes: [[month, 'month'], 'forecast_category', [fn('SUM', col('amount')), 'amount'], [fn('SUM', literal('amount * probability / 100')), 'weighted']],
    group: [month, 'forecast_category'], raw: true,
  });
  const won = await Opportunity.findAll({
    where: { [Op.and]: [s.where, { status: 'won' }, dateWhere('closed_at', r), ownerFilter(f)] },
    attributes: [[fn('DATE_FORMAT', col('closed_at'), '%Y-%m'), 'month'], [fn('SUM', col('amount')), 'amount']],
    group: [fn('DATE_FORMAT', col('closed_at'), '%Y-%m')], raw: true,
  });
  const months = {};
  const bucket = (m) => (months[m] = months[m] || { month: m, closed_won: 0, commit: 0, best_case: 0, pipeline: 0, weighted: 0 });
  for (const row of open) {
    const b = bucket(row.month);
    const cat = ['commit', 'best_case'].includes(row.forecast_category) ? row.forecast_category : 'pipeline';
    b[cat] += num(row.amount);
    b.weighted += num(row.weighted);
  }
  for (const row of won) bucket(row.month).closed_won += num(row.amount);
  const list = Object.values(months).sort((a, b) => a.month.localeCompare(b.month)).map((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === 'number' ? v.toFixed(2) : v])));
  return { range: r, months: list };
}

async function conversion(f = {}) {
  const ls = scoped('lead');
  const os = scoped('opportunity');
  const r = range({ preset: 'last_30_days', ...f });
  const out = {};
  if (ls) {
    const [created, converted] = await Promise.all([
      Lead.count({ where: { [Op.and]: [ls.where, dateWhere('created_at', r), ownerFilter(f)] } }),
      Lead.count({ where: { [Op.and]: [ls.where, dateWhere('converted_at', r), ownerFilter(f)] } }),
    ]);
    Object.assign(out, { leads_created: created, leads_converted: converted, lead_conversion_rate: created ? +(converted / created).toFixed(4) : 0 });
  }
  if (os) {
    const rows = await Opportunity.findAll({ where: { [Op.and]: [os.where, { status: ['won', 'lost'] }, dateWhere('closed_at', r), ownerFilter(f)] }, attributes: ['status', [fn('COUNT', col('id')), 'n'], [fn('SUM', col('amount')), 'amount']], group: ['status'], raw: true });
    const won = rows.find((x) => x.status === 'won');
    const lost = rows.find((x) => x.status === 'lost');
    const closed = num(won?.n) + num(lost?.n);
    Object.assign(out, { deals_won: num(won?.n), deals_lost: num(lost?.n), win_rate: closed ? +(num(won?.n) / closed).toFixed(4) : 0, won_revenue: num(won?.amount).toFixed(2), average_deal_size: num(won?.n) ? (num(won?.amount) / num(won?.n)).toFixed(2) : '0.00' });
  }
  return { range: r, ...out };
}

async function activityReport(f = {}) {
  const s = scoped('activity');
  if (!s) throw E.forbidden('Missing permission: activities:read', 'PERMISSION_DENIED');
  const r = range({ preset: 'last_30_days', ...f });
  const rows = await Activity.findAll({ where: { [Op.and]: [s.where, dateWhere('created_at', r), ownerFilter(f)] }, attributes: ['type', 'status', [fn('COUNT', col('id')), 'n']], group: ['type', 'status'], raw: true });
  const overdue = await Activity.count({ where: { [Op.and]: [s.where, { status: 'open', due_at: { [Op.lt]: new Date() } }, ownerFilter(f)] } });
  return { range: r, by_type: rows.map((x) => ({ type: x.type, status: x.status, count: num(x.n) })), overdue };
}

async function salesPerformance(f = {}) {
  const s = scoped('opportunity');
  if (!s) throw E.forbidden('Missing permission: opportunities:read', 'PERMISSION_DENIED');
  const r = range({ preset: 'this_quarter', ...f });
  const rows = await Opportunity.findAll({
    where: { [Op.and]: [s.where, { status: ['won', 'lost'] }, dateWhere('closed_at', r), ownerFilter(f)] },
    attributes: ['owner_id', 'status', [fn('COUNT', col('id')), 'n'], [fn('SUM', col('amount')), 'amount']], group: ['owner_id', 'status'], raw: true,
  });
  const byOwner = {};
  for (const x of rows) {
    const o = (byOwner[x.owner_id] = byOwner[x.owner_id] || { owner_id: x.owner_id, won: 0, lost: 0, won_amount: 0 });
    if (x.status === 'won') { o.won = num(x.n); o.won_amount = num(x.amount); } else o.lost = num(x.n);
  }
  const users = await User.findAll({ where: { id: Object.keys(byOwner) }, attributes: ['id', 'first_name', 'last_name'] });
  const names = new Map(users.map((u) => [u.id, `${u.first_name} ${u.last_name}`.trim()]));
  return { range: r, rows: Object.values(byOwner).map((o) => ({ ...o, name: names.get(o.owner_id) || 'Unassigned', win_rate: o.won + o.lost ? +(o.won / (o.won + o.lost)).toFixed(4) : 0, won_amount: o.won_amount.toFixed(2) })).sort((a, b) => Number(b.won_amount) - Number(a.won_amount)) };
}

// ---------- configurable reports ----------

const DATE_BUCKETS = { day: '%Y-%m-%d', week: '%x-W%v', month: '%Y-%m', quarter: null, year: '%Y' };

/**
 * Runs a report definition: { entity_type, report_type, filters, group_by, metric, date_field, date_range, columns }.
 * group_by: a filterable field, or `<date field>:<day|week|month|quarter|year>`.
 * metric:   { fn: count|sum|avg|min|max, field? } — field must be numeric & visible.
 */
async function runReport(spec) {
  const ctx = getContext();
  const def = registry.get(spec.entity_type);
  if (!def) throw E.validation([{ path: 'entity_type', message: 'Unknown entity' }]);
  const scope = scopeFor(ctx, `${def.module}:read`);
  if (!scope) throw E.forbidden(`Missing permission: ${def.module}:read`, 'PERMISSION_DENIED');
  const { hidden } = fieldRules(def, ctx);
  const and = [scopeWhere(def, ctx, scope), ...buildFilterWhere(def, spec.filters?.filter || {}, ctx), ...(await cf.buildFilters(def.type, def.model.name, spec.filters?.cf || {}))];
  if (spec.date_field) {
    if (def.filterable[spec.date_field] !== 'date') throw E.validation([{ path: 'date_field', message: 'Not a date field' }]);
    and.push(dateWhere(spec.date_field, range(spec.date_range || {})));
  }
  const where = { [Op.and]: and };

  if (spec.report_type === 'table') {
    const columns = (spec.columns?.length ? spec.columns : def.exportColumns).filter((c) => def.model.rawAttributes[c] && !hidden.has(c));
    const rows = await def.model.findAll({ where, attributes: ['id', ...columns.filter((c) => c !== 'id')], order: [['created_at', 'DESC']], limit: 1000 });
    return { columns, rows: rows.map((r) => r.get({ plain: true })) };
  }

  const metric = spec.metric || { fn: 'count' };
  if (!['count', 'sum', 'avg', 'min', 'max'].includes(metric.fn)) throw E.validation([{ path: 'metric.fn', message: 'Unsupported metric' }]);
  let valueExpr = fn('COUNT', col(`${def.model.name}.id`));
  if (metric.fn !== 'count') {
    if (def.filterable[metric.field] !== 'number' || hidden.has(metric.field)) throw E.validation([{ path: 'metric.field', message: 'Metric field must be a visible numeric field' }]);
    valueExpr = fn(metric.fn.toUpperCase(), col(metric.field));
  }
  let groupExpr = null;
  let groupLabel = spec.group_by;
  if (spec.group_by) {
    const [field, bucket] = spec.group_by.split(':');
    if (!def.filterable[field] || hidden.has(field)) throw E.validation([{ path: 'group_by', message: 'Cannot group by this field' }]);
    if (bucket) {
      if (def.filterable[field] !== 'date' || !(bucket in DATE_BUCKETS)) throw E.validation([{ path: 'group_by', message: 'Invalid date bucket' }]);
      groupExpr = bucket === 'quarter' ? fn('CONCAT', fn('YEAR', col(field)), '-Q', fn('QUARTER', col(field))) : fn('DATE_FORMAT', col(field), DATE_BUCKETS[bucket]);
    } else groupExpr = col(field);
    groupLabel = field;
  }
  const rows = await def.model.findAll({
    where,
    attributes: [...(groupExpr ? [[groupExpr, 'group']] : []), [valueExpr, 'value']],
    group: groupExpr ? [groupExpr] : undefined,
    order: groupExpr ? [[literal('`group`'), 'ASC']] : undefined,
    limit: 500,
    raw: true,
  });
  let out = rows.map((r) => ({ group: r.group ?? (groupExpr ? null : 'Total'), value: metric.fn === 'count' ? num(r.value) : Number(num(r.value).toFixed(2)) }));
  if (groupLabel === 'owner_id' || groupLabel?.endsWith('_id')) {
    if (groupLabel === 'owner_id') {
      const users = await User.findAll({ where: { id: out.map((o) => o.group).filter(Boolean) }, attributes: ['id', 'first_name', 'last_name'] });
      const names = new Map(users.map((u) => [u.id, `${u.first_name} ${u.last_name}`.trim()]));
      out = out.map((o) => ({ ...o, label: o.group ? names.get(o.group) || o.group : 'Unassigned' }));
    }
  }
  return { group_by: spec.group_by || null, metric, rows: out };
}

async function dashboard(f = {}) {
  const ctx = getContext();
  const r = range({ preset: f.preset || 'this_month', from: f.from, to: f.to });
  const filters = { ...f };
  if (f.team_id) {
    const { TeamMember } = require('../../models');
    filters.team_user_ids = (await TeamMember.findAll({ where: { team_id: f.team_id }, attributes: ['user_id'] })).map((m) => m.user_id);
  }
  const out = { range: r, widgets: [] };
  const lead = scoped('lead');
  const opp = scoped('opportunity');
  const act = scoped('activity');
  const tick = scoped('ticket');
  const kpis = {};
  if (lead) {
    const [newLeads, openLeads] = await Promise.all([
      Lead.count({ where: { [Op.and]: [lead.where, dateWhere('created_at', r), ownerFilter(filters)] } }),
      Lead.count({ where: { [Op.and]: [lead.where, { status: { [Op.in]: ['new', 'contacted', 'nurturing', 'qualified'] } }, ownerFilter(filters)] } }),
    ]);
    Object.assign(kpis, { new_leads: newLeads, open_leads: openLeads });
    out.funnel = await funnel({ ...filters, from: r[0], to: r[1] });
    out.widgets.push('funnel');
  }
  if (opp) {
    const [pipe, conv, perf, bySource] = await Promise.all([
      pipeline(filters), conversion({ ...filters, from: r[0], to: r[1] }), salesPerformance({ ...filters, from: r[0], to: r[1] }),
      lead ? Lead.findAll({ where: { [Op.and]: [lead.where, dateWhere('created_at', r), ownerFilter(filters)] }, attributes: ['source', [fn('COUNT', col('id')), 'n']], group: ['source'], raw: true }) : [],
    ]);
    const pipelineValue = pipe.stages.reduce((a, s) => a + Number(s.amount), 0);
    const weighted = pipe.stages.reduce((a, s) => a + Number(s.weighted), 0);
    Object.assign(kpis, { pipeline_value: pipelineValue.toFixed(2), weighted_pipeline: weighted.toFixed(2), won_revenue: conv.won_revenue, win_rate: conv.win_rate, deals_won: conv.deals_won, average_deal_size: conv.average_deal_size, lead_conversion_rate: conv.lead_conversion_rate ?? null });
    out.pipeline = pipe;
    out.leaderboard = perf.rows.slice(0, 10);
    out.leads_by_source = bySource.map((x) => ({ source: x.source || 'unknown', count: num(x.n) }));
    out.revenue_by_month = (await forecast({ preset: 'this_year', ...filters })).months;
    out.widgets.push('pipeline', 'leaderboard', 'revenue', 'sources');
    const stalledDays = Number(ctx.settings?.preferences?.stalled_deal_days) || 14;
    kpis.stalled_deals = await Opportunity.count({ where: { [Op.and]: [opp.where, { status: 'open', stage_entered_at: { [Op.lt]: new Date(Date.now() - stalledDays * 86400_000) } }, ownerFilter(filters)] } });
  }
  if (act) {
    const mine = { [Op.or]: [{ owner_id: ctx.userId }, { created_by_user_id: ctx.userId }] };
    const [upcoming, overdue, overdueCount] = await Promise.all([
      Activity.findAll({ where: { [Op.and]: [act.where, mine, { status: 'open', [Op.or]: [{ due_at: { [Op.gte]: new Date() } }, { start_at: { [Op.gte]: new Date() } }] }] }, order: [['due_at', 'ASC'], ['start_at', 'ASC']], limit: 8 }),
      Activity.findAll({ where: { [Op.and]: [act.where, mine, { status: 'open', due_at: { [Op.lt]: new Date() } }] }, order: [['due_at', 'ASC']], limit: 8 }),
      Activity.count({ where: { [Op.and]: [act.where, { status: 'open', due_at: { [Op.lt]: new Date() } }, ownerFilter(filters)] } }),
    ]);
    kpis.overdue_activities = overdueCount;
    out.upcoming_activities = upcoming;
    out.overdue_activities = overdue;
    out.widgets.push('activities');
  }
  if (tick) {
    const [open, breached] = await Promise.all([
      Ticket.count({ where: { [Op.and]: [tick.where, { status: ['new', 'open', 'pending', 'on_hold'] }] } }),
      Ticket.count({ where: { [Op.and]: [tick.where, { status: ['new', 'open', 'pending', 'on_hold'], resolution_due_at: { [Op.lt]: new Date() } }] } }),
    ]);
    Object.assign(kpis, { open_tickets: open, sla_breached_tickets: breached });
    out.widgets.push('support');
  }
  const { TimelineEvent } = require('../../models');
  const readableAll = ['lead', 'contact', 'account', 'opportunity', 'activity', 'ticket', 'quote', 'campaign'].filter((t) => ctx.permissions.get(`${registry.get(t).module}:read`) === 'all');
  out.recent_activity = await TimelineEvent.findAll({ order: [['created_at', 'DESC']], limit: 15, where: { [Op.or]: [{ entity_type: readableAll }, { actor_user_id: ctx.userId }] }, include: [{ model: User, as: 'actor', attributes: ['id', 'first_name', 'last_name'] }] });
  out.kpis = kpis;
  return out;
}

module.exports = { funnel, pipeline, forecast, conversion, activityReport, salesPerformance, runReport, dashboard, range };
