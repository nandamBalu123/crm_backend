'use strict';

const { Op } = require('sequelize');
const { stringify } = require('csv-stringify');
const { sequelize, Membership, User, RecordAssignment, SavedView } = require('../../models');
const { getContext } = require('../../context/requestContext');
const { parseListQuery, buildFilterWhere } = require('./query');
const { scopeWhere, assertWritableFields, fieldRules } = require('./policy');
const { serialize, serializeMany } = require('./serializer');
const { assertCan, scopeFor } = require('../../middleware/authorize');
const cf = require('../../modules/customFields/customFields.service');
const timeline = require('../../modules/timeline/timeline.service');
const audit = require('../../modules/audit/audit.service');
const events = require('../../events/domainEvents');
const usage = require('../../modules/billing/usage.service');
const E = require('../../errors/AppError');

const ownerInclude = () => ({ model: User, as: 'owner', attributes: ['id', 'first_name', 'last_name', 'email', 'avatar_url'] });

async function assertMember(userId, transaction) {
  const m = await Membership.findOne({ where: { user_id: userId, status: 'active' }, attributes: ['id'], transaction });
  if (!m) throw E.validation([{ path: 'owner_id', message: 'Owner must be an active member of this workspace' }]);
}

async function applySavedView(def, query, ctx) {
  if (!query.view) return query;
  const view = await SavedView.findOne({
    where: { id: String(query.view), entity_type: def.type, [Op.or]: [{ user_id: ctx.userId }, { is_shared: true }] },
  });
  if (!view) throw E.notFound('Saved view');
  return { ...query, filter: { ...(view.filters?.filter || {}), ...(query.filter || {}) }, cf: { ...(view.filters?.cf || {}), ...(query.cf || {}) }, q: query.q ?? view.filters?.q, sort: query.sort || view.sort };
}

async function list(def, rawQuery, scope) {
  const ctx = getContext();
  const query = await applySavedView(def, rawQuery, ctx);
  const q = await parseListQuery(def, query, ctx);
  const where = { [Op.and]: [q.where, scopeWhere(def, ctx, scope), ...(def.baseWhere ? [def.baseWhere(query)] : [])] };
  const { rows, count } = await def.model.findAndCountAll({
    where,
    order: q.order,
    limit: q.limit,
    offset: q.offset,
    include: def.listInclude ? def.listInclude() : def.ownerField ? [ownerInclude()] : [],
    distinct: true,
  });
  return {
    data: await serializeMany(def, rows, ctx),
    meta: { page: q.page, page_size: q.pageSize, total: count, total_pages: Math.ceil(count / q.pageSize) },
  };
}

async function findScoped(def, id, scope, { transaction, lock, include } = {}) {
  const ctx = getContext();
  const record = await def.model.findOne({
    where: { [Op.and]: [{ id }, scopeWhere(def, ctx, scope)] },
    include,
    transaction,
    lock: lock && transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!record) throw E.notFound(def.label);
  return record;
}

async function get(def, id, scope) {
  const ctx = getContext();
  const record = await findScoped(def, id, scope, { include: def.detailInclude ? def.detailInclude() : def.ownerField ? [ownerInclude()] : [] });
  if (ctx.settings?.preferences?.audit_record_access) {
    await audit.record({ action: `${def.type}.viewed`, entityType: def.type, entityId: id });
  }
  const values = def.customFields !== false ? (await cf.loadValues(def.type, [id])).get(id) : null;
  return serialize(def, record, ctx, values);
}

function snapshot(record, customValues) {
  const plain = { ...record.get({ plain: true }) };
  delete plain.tenant_id;
  return { ...plain, custom_fields: customValues || {} };
}

/** Creates a record inside the given transaction. Returns the model instance. */
async function createRecord(def, input, { transaction, skipOwnerCheck = false } = {}) {
  const ctx = getContext();
  const { custom_fields: customInput, ...data } = input;
  assertWritableFields(def, ctx, data);
  const customValues = def.customFields !== false ? await cf.validateValues(def.type, customInput, { mode: 'create', fieldAccess: ctx.fieldAccess?.[def.type] }) : {};
  if (def.ownerField) {
    if (!data[def.ownerField]) data[def.ownerField] = ctx.userId || null;
    if (data[def.ownerField]) {
      if (!skipOwnerCheck && data[def.ownerField] !== ctx.userId && ctx.permissions) assertCan(ctx, `${def.module}:assign`);
      await assertMember(data[def.ownerField], transaction);
    }
  }
  if (def.hooks?.beforeCreate) await def.hooks.beforeCreate(data, { transaction, ctx, customValues });
  const record = await def.model.create(data, { transaction });
  await cf.saveValues(def.type, record.id, customValues, { transaction });
  await timeline.add(def.type, record.id, 'created', `${def.label} created`, null, { transaction });
  await audit.record({ action: `${def.type}.created`, entityType: def.type, entityId: record.id, summary: `${def.label} "${def.title(record)}" created` }, { transaction });
  if (def.hooks?.afterCreate) await def.hooks.afterCreate(record, { transaction, ctx, customValues });
  await events.publish(`${def.type}.created`, { entityType: def.type, entityId: record.id, data: snapshot(record, customValues) }, { transaction });
  return record;
}

async function create(def, input) {
  const record = await sequelize.transaction((transaction) => createRecord(def, input, { transaction }));
  usage.increment('records_created');
  return get(def, record.id, 'all');
}

async function recordAssignment(def, record, fromOwner, toOwner, reason, transaction) {
  const ctx = getContext();
  await RecordAssignment.create({ entity_type: def.type, entity_id: record.id, from_owner_id: fromOwner, to_owner_id: toOwner, assigned_by_user_id: ctx.userId || null, reason }, { transaction });
  await timeline.add(def.type, record.id, 'owner_changed', `Owner changed`, { from: fromOwner, to: toOwner }, { transaction });
  if (toOwner && toOwner !== ctx.userId) {
    const notifications = require('../../modules/notifications/notifications.service');
    await notifications.notify(toOwner, {
      type: 'record.assigned', title: `${def.label} assigned to you`, body: def.title(record), link: `/${def.route}/${record.id}`, entity_type: def.type, entity_id: record.id,
    }, { transaction });
  }
}

/** Updates a record inside a transaction; returns { record, changes }. */
async function updateRecord(def, id, input, scope, { transaction, expectedVersion, reason } = {}) {
  const ctx = getContext();
  const { custom_fields: customInput, version: bodyVersion, ...data } = input;
  const expected = expectedVersion ?? bodyVersion;
  assertWritableFields(def, ctx, data);
  const record = await findScoped(def, id, scope, { transaction, lock: true });
  if (expected !== undefined && expected !== null && Number(expected) !== record.version) {
    throw E.conflict('This record was changed by someone else. Reload and try again.', 'VERSION_CONFLICT', { current_version: record.version });
  }
  const before = { ...record.get({ plain: true }) };
  const customValues = def.customFields !== false && customInput ? await cf.validateValues(def.type, customInput, { mode: 'update', fieldAccess: ctx.fieldAccess?.[def.type] }) : {};

  if (def.ownerField && data[def.ownerField] !== undefined && data[def.ownerField] !== record[def.ownerField]) {
    if (ctx.permissions) {
      const assignScope = assertCan(ctx, `${def.module}:assign`);
      if (assignScope !== 'all' && data[def.ownerField] && !(ctx.teamUserIds || []).includes(data[def.ownerField])) {
        throw E.forbidden('You can only assign records within your team', 'ASSIGN_SCOPE');
      }
    }
    if (data[def.ownerField]) await assertMember(data[def.ownerField], transaction);
  }
  if (def.hooks?.beforeUpdate) await def.hooks.beforeUpdate(record, data, { transaction, ctx, before });
  record.set(data);
  const changedKeys = record.changed() || [];
  if (changedKeys.length) await record.save({ transaction });

  let cfChanges = {};
  if (Object.keys(customValues).length) {
    const old = (await cf.loadValues(def.type, [id])).get(id) || {};
    await cf.saveValues(def.type, id, customValues, { transaction });
    cfChanges = Object.fromEntries(Object.entries(audit.diff(old, { ...old, ...customValues }, Object.keys(customValues))).map(([k, v]) => [`cf.${k}`, v]));
  }
  const changes = { ...audit.diff(before, record.get({ plain: true }), changedKeys), ...cfChanges };
  if (!Object.keys(changes).length) return { record, changes };

  if (def.ownerField && changes[def.ownerField]) await recordAssignment(def, record, before[def.ownerField], record[def.ownerField], reason || null, transaction);
  const visibleFields = Object.keys(changes).filter((k) => k !== def.ownerField);
  if (visibleFields.length) {
    await timeline.add(def.type, id, 'updated', `Updated ${visibleFields.map((f) => f.replace(/^cf\./, '').replace(/_/g, ' ')).join(', ')}`, { fields: visibleFields }, { transaction });
  }
  await audit.record({ action: `${def.type}.updated`, entityType: def.type, entityId: id, summary: `${def.label} "${def.title(record)}" updated`, changes }, { transaction });
  if (def.hooks?.afterUpdate) await def.hooks.afterUpdate(record, changes, { transaction, ctx, before });
  const after = (await cf.loadValues(def.type, [id])).get(id);
  await events.publish(`${def.type}.updated`, { entityType: def.type, entityId: id, data: snapshot(record, after), changes }, { transaction });
  return { record, changes };
}

async function update(def, id, input, scope, opts = {}) {
  await sequelize.transaction((transaction) => updateRecord(def, id, input, scope, { ...opts, transaction }));
  return get(def, id, 'all');
}

async function remove(def, id, scope) {
  await sequelize.transaction(async (transaction) => {
    const record = await findScoped(def, id, scope, { transaction, lock: true });
    if (def.hooks?.beforeDestroy) await def.hooks.beforeDestroy(record, { transaction });
    await record.destroy({ transaction });
    await audit.record({ action: `${def.type}.deleted`, entityType: def.type, entityId: id, summary: `${def.label} "${def.title(record)}" deleted` }, { transaction });
    await events.publish(`${def.type}.deleted`, { entityType: def.type, entityId: id, data: { id } }, { transaction });
  });
}

/** Bulk operations are processed record-by-record so every policy and audit rule applies. */
async function bulk(def, { ids, action, data }) {
  const ctx = getContext();
  const permission = { update: 'update', delete: 'delete', assign: 'assign' }[action];
  const scope = assertCan(ctx, `${def.module}:${permission}`);
  const readScope = scopeFor(ctx, `${def.module}:update`) || scope;
  const results = { succeeded: [], failed: [] };
  for (const id of ids) {
    try {
      if (action === 'delete') await remove(def, id, scope);
      else if (action === 'assign') await sequelize.transaction((t) => updateRecord(def, id, { [def.ownerField]: data.owner_id }, readScope, { transaction: t, reason: 'bulk_assign' }));
      else await sequelize.transaction((t) => updateRecord(def, id, def.bulkUpdatable ? pick(data, def.bulkUpdatable) : {}, scope, { transaction: t }));
      results.succeeded.push(id);
    } catch (err) {
      results.failed.push({ id, code: err.code || 'ERROR', message: err.expose ? err.message : 'Failed' });
    }
  }
  await audit.record({ action: `${def.type}.bulk_${action}`, entityType: def.type, summary: `Bulk ${action} on ${ids.length} ${def.plural.toLowerCase()}`, metadata: { succeeded: results.succeeded.length, failed: results.failed.length } });
  return results;
}

function pick(obj, keys) {
  return Object.fromEntries(Object.entries(obj || {}).filter(([k]) => keys.includes(k)));
}

/** Neutralises spreadsheet formula injection (OWASP CSV injection). */
function csvSafe(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.join('; ');
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

const EXPORT_LIMIT = 50_000;

/** Streams a permission-aware, field-filtered CSV export. */
async function exportCsv(def, rawQuery, scope, res) {
  const ctx = getContext();
  const query = await applySavedView(def, rawQuery, ctx);
  const q = await parseListQuery(def, { ...query, page: 1, page_size: 1 }, ctx);
  const { hidden } = fieldRules(def, ctx);
  const columns = def.exportColumns.filter((c) => !hidden.has(c));
  const customDefs = def.customFields !== false ? (await cf.getDefinitions(def.type)).filter((d) => !hidden.has(`cf.${d.key}`)) : [];
  const header = [...columns, ...customDefs.map((d) => `cf.${d.key}`)];
  const filename = `${def.route}-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  const csv = stringify({ header: true, columns: header });
  csv.pipe(res);
  let lastId = null;
  let total = 0;
  const baseWhere = [q.where, scopeWhere(def, ctx, scope), ...(def.baseWhere ? [def.baseWhere(query)] : [])];
  while (total < EXPORT_LIMIT) {
    const rows = await def.model.findAll({
      where: { [Op.and]: [...baseWhere, ...(lastId ? [{ id: { [Op.gt]: lastId } }] : [])] },
      order: [['id', 'ASC']],
      limit: 500,
      attributes: ['id', ...columns.filter((c) => c !== 'id' && def.model.rawAttributes[c])],
    });
    if (!rows.length) break;
    const values = customDefs.length ? await cf.loadValues(def.type, rows.map((r) => r.id)) : new Map();
    for (const r of rows) {
      const cfv = values.get(r.id) || {};
      csv.write([...columns.map((c) => csvSafe(r.get(c))), ...customDefs.map((d) => csvSafe(cfv[d.key]))]);
    }
    total += rows.length;
    lastId = rows[rows.length - 1].id;
  }
  csv.end();
  await audit.record({ action: `${def.type}.exported`, entityType: def.type, summary: `Exported ${total} ${def.plural.toLowerCase()}`, metadata: { rows: total, filters: rawQuery.filter || null } });
}

async function assignments(def, id, scope) {
  await findScoped(def, id, scope);
  return RecordAssignment.findAll({
    where: { entity_type: def.type, entity_id: id },
    order: [['created_at', 'DESC']],
    limit: 100,
    include: [{ model: User, as: 'toOwner', attributes: ['id', 'first_name', 'last_name'] }, { model: User, as: 'fromOwner', attributes: ['id', 'first_name', 'last_name'] }],
  });
}

module.exports = { list, get, findScoped, create, createRecord, update, updateRecord, remove, bulk, exportCsv, assignments, assertMember, ownerInclude, buildFilterWhere, csvSafe };
