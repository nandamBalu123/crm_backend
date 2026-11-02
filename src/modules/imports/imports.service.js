'use strict';

const { parse } = require('csv-parse/sync');
const { sequelize, Import } = require('../../models');
const registry = require('../../core/entity/registry');
const service = require('../../core/entity/service');
const cf = require('../customFields/customFields.service');
const queue = require('../../jobs/queue');
const notifications = require('../notifications/notifications.service');
const audit = require('../audit/audit.service');
const { driver } = require('../../storage');
const { uuidv7 } = require('../../utils/ids');
const { assertCan } = require('../../middleware/authorize');
const { getContext } = require('../../context/requestContext');
const { loadSnapshot } = require('../rbac/permission.service');
const { loadTenant } = require('../../middleware/tenantContext');
const E = require('../../errors/AppError');

const IMPORTABLE = {
  lead: { fields: ['first_name', 'last_name', 'email', 'phone', 'company', 'title', 'website', 'industry', 'source', 'status', 'rating', 'city', 'state', 'country', 'description', 'owner_email'], dedupe: 'email' },
  contact: { fields: ['first_name', 'last_name', 'email', 'phone', 'mobile', 'title', 'department', 'lead_source', 'city', 'state', 'country', 'description', 'account_name', 'owner_email'], dedupe: 'email' },
  account: { fields: ['name', 'domain', 'website', 'industry', 'type', 'employees', 'annual_revenue', 'phone', 'email', 'city', 'state', 'country', 'description', 'owner_email'], dedupe: 'domain' },
  product: { fields: ['sku', 'name', 'description', 'unit_price', 'currency', 'tax_rate', 'unit'], dedupe: 'sku' },
};
const MAX_ROWS = 50_000;
const MAX_ERRORS = 500;

function parseCsv(buffer, { toLine } = {}) {
  return parse(buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true, to_line: toLine, max_record_size: 100_000 });
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

async function targetFields(entityType) {
  const defs = await cf.getDefinitions(entityType);
  return [...IMPORTABLE[entityType].fields, ...defs.map((d) => `cf.${d.key}`)];
}

function suggestMapping(headers, targets) {
  const byNorm = new Map(targets.map((t) => [norm(t.replace(/^cf\./, '')), t]));
  const aliases = { emailaddress: 'email', mail: 'email', firstname: 'first_name', lastname: 'last_name', surname: 'last_name', company: 'company', organisation: 'company', organization: 'company', phonenumber: 'phone', mobilephone: 'mobile', jobtitle: 'title', accountname: 'account_name', owner: 'owner_email' };
  return Object.fromEntries(headers.map((h) => [h, byNorm.get(norm(h)) || (targets.includes(aliases[norm(h)]) ? aliases[norm(h)] : null)]));
}

async function create({ entityType, file }) {
  const ctx = getContext();
  if (!IMPORTABLE[entityType]) throw E.validation([{ path: 'entity_type', message: 'Import is not supported for this type' }]);
  assertCan(ctx, `${registry.get(entityType).module}:import`);
  if (!file) throw E.validation([{ path: 'file', message: 'A CSV file is required' }]);
  let preview;
  try {
    preview = parseCsv(file.buffer, { toLine: 21 });
  } catch (err) {
    throw E.validation([{ path: 'file', message: `Could not parse CSV: ${err.message}` }]);
  }
  if (!preview.length) throw E.validation([{ path: 'file', message: 'The file has no data rows' }]);
  const headers = Object.keys(preview[0]);
  const total = parseCsv(file.buffer).length;
  if (total > MAX_ROWS) throw E.validation([{ path: 'file', message: `At most ${MAX_ROWS} rows per import` }]);
  const id = uuidv7();
  const key = `tenants/${ctx.tenantId}/imports/${id}.csv`;
  await driver().put(key, file.buffer);
  const targets = await targetFields(entityType);
  const imp = await Import.create({ id, entity_type: entityType, filename: String(file.originalname).slice(0, 255), storage_key: key, headers, mapping: suggestMapping(headers, targets), total_rows: total, created_by_user_id: ctx.userId });
  return { import: imp, preview: preview.slice(0, 10), target_fields: targets };
}

async function rowToInput(entityType, row, mapping, ownerByEmail, accountByName) {
  const data = {};
  const custom = {};
  for (const [header, target] of Object.entries(mapping)) {
    if (!target) continue;
    const raw = row[header];
    if (raw === undefined || raw === '') continue;
    if (target.startsWith('cf.')) {
      const defs = await cf.getDefinitions(entityType);
      const def = defs.find((d) => d.key === target.slice(3));
      custom[target.slice(3)] = def?.field_type === 'multiselect' ? raw.split(/[;|]/).map((s) => s.trim()).filter(Boolean) : def?.field_type === 'boolean' ? ['true', 'yes', '1'].includes(raw.toLowerCase()) : raw;
    } else if (target === 'owner_email') {
      const ownerId = ownerByEmail.get(raw.toLowerCase());
      if (!ownerId) throw new E.AppError(422, 'VALIDATION_ERROR', `Unknown owner ${raw}`, [{ path: 'owner_email', message: 'No active member with this email' }]);
      data.owner_id = ownerId;
    } else if (target === 'account_name') {
      data.account_id = accountByName.get(raw.toLowerCase()) || null;
    } else data[target] = raw;
  }
  if (Object.keys(custom).length) data.custom_fields = custom;
  return data;
}

async function lookups() {
  const { Membership, User, Account } = require('../../models');
  const members = await Membership.findAll({ where: { status: 'active' }, include: [{ model: User, as: 'user', attributes: ['email'] }], attributes: ['user_id'] });
  const accounts = await Account.findAll({ attributes: ['id', 'name'], limit: 50_000 });
  return { ownerByEmail: new Map(members.map((m) => [m.user.email.toLowerCase(), m.user_id])), accountByName: new Map(accounts.map((a) => [a.name.toLowerCase(), a.id])) };
}

/** Validates rows without writing (dry run) and returns per-row errors. */
async function validate(id, { mapping, limit = 200 }) {
  const imp = await Import.findByPk(id);
  if (!imp) throw E.notFound('Import');
  assertCan(getContext(), `${registry.get(imp.entity_type).module}:import`);
  if (mapping) {
    const targets = await targetFields(imp.entity_type);
    for (const [h, t] of Object.entries(mapping)) {
      if (!imp.headers.includes(h)) throw E.validation([{ path: `mapping.${h}`, message: 'Unknown column' }]);
      if (t && !targets.includes(t)) throw E.validation([{ path: `mapping.${h}`, message: `Unknown target field ${t}` }]);
    }
    await imp.update({ mapping });
  }
  const def = registry.get(imp.entity_type);
  const rows = parseCsv(await driver().getBuffer(imp.storage_key), { toLine: limit + 1 });
  const { ownerByEmail, accountByName } = await lookups();
  const errors = [];
  for (const [i, row] of rows.entries()) {
    try {
      const input = await rowToInput(imp.entity_type, row, imp.mapping, ownerByEmail, accountByName);
      const parsed = def.createSchema.safeParse(input);
      if (!parsed.success) throw E.validation(parsed.error.issues.map((x) => ({ path: x.path.join('.'), message: x.message })));
      if (parsed.data.custom_fields) await cf.validateValues(imp.entity_type, parsed.data.custom_fields, { mode: 'create' });
    } catch (err) {
      errors.push({ row: i + 2, errors: err.details || [{ message: err.message }] });
    }
  }
  return { checked: rows.length, valid: rows.length - errors.length, errors: errors.slice(0, MAX_ERRORS) };
}

async function start(id, { duplicate_strategy: strategy }) {
  const imp = await Import.findByPk(id);
  if (!imp) throw E.notFound('Import');
  assertCan(getContext(), `${registry.get(imp.entity_type).module}:import`);
  if (imp.status !== 'uploaded') throw E.conflict('This import has already been started', 'IMPORT_STARTED');
  await sequelize.transaction(async (transaction) => {
    await imp.update({ status: 'queued', duplicate_strategy: strategy || imp.duplicate_strategy }, { transaction });
    await queue.enqueue('imports.process', { import_id: imp.id }, { transaction, maxAttempts: 1 });
    await audit.record({ action: 'import.started', entityType: imp.entity_type, summary: `Import of ${imp.total_rows} rows started (${imp.filename})`, metadata: { import_id: imp.id } }, { transaction });
  });
  return imp;
}

/** Background processing in batches; every row goes through the normal entity service (validation, RBAC, audit). */
async function processImport({ import_id: id }) {
  const ctx = getContext();
  const imp = await Import.findByPk(id);
  if (!imp || imp.status !== 'queued') return { skipped: true };
  // Run with the importing user's identity and permissions.
  const snapshot = await loadSnapshot(ctx.tenantId, imp.created_by_user_id);
  const loaded = await loadTenant(ctx.tenantId);
  Object.assign(ctx, { userId: imp.created_by_user_id, permissions: snapshot.permissions, teamUserIds: snapshot.teamUserIds, fieldAccess: snapshot.fieldAccess, settings: loaded.settings });
  await imp.update({ status: 'processing', started_at: new Date() });
  const def = registry.get(imp.entity_type);
  const dedupeField = IMPORTABLE[imp.entity_type].dedupe;
  const rows = parseCsv(await driver().getBuffer(imp.storage_key));
  const { ownerByEmail, accountByName } = await lookups();
  const counters = { processed_rows: 0, created_rows: 0, updated_rows: 0, skipped_rows: 0, error_rows: 0 };
  const errors = [];
  for (const [i, row] of rows.entries()) {
    try {
      const input = await rowToInput(imp.entity_type, row, imp.mapping, ownerByEmail, accountByName);
      const parsed = def.createSchema.safeParse(input);
      if (!parsed.success) throw E.validation(parsed.error.issues.map((x) => ({ path: x.path.join('.'), message: x.message })));
      const dupValue = parsed.data[dedupeField];
      const existing = dupValue && imp.duplicate_strategy !== 'create' ? await def.model.findOne({ where: { [dedupeField]: dupValue } }) : null;
      if (existing && imp.duplicate_strategy === 'skip') counters.skipped_rows += 1;
      else if (existing) {
        await sequelize.transaction((t) => service.updateRecord(def, existing.id, parsed.data, 'all', { transaction: t }));
        counters.updated_rows += 1;
      } else {
        await sequelize.transaction((t) => service.createRecord(def, { ...parsed.data, ...(imp.entity_type === 'lead' && !parsed.data.source ? { source: 'import' } : {}) }, { transaction: t }));
        counters.created_rows += 1;
      }
    } catch (err) {
      counters.error_rows += 1;
      if (errors.length < MAX_ERRORS) errors.push({ row: i + 2, errors: err.details || [{ message: err.expose ? err.message : 'Failed' }] });
    }
    counters.processed_rows += 1;
    if (counters.processed_rows % 200 === 0) await imp.update({ ...counters });
  }
  await imp.update({ ...counters, errors, status: 'completed', completed_at: new Date() });
  await notifications.notify(imp.created_by_user_id, { type: 'import.completed', title: 'Import finished', body: `${imp.filename}: ${counters.created_rows} created, ${counters.updated_rows} updated, ${counters.skipped_rows} skipped, ${counters.error_rows} errors`, link: `/imports/${imp.id}` });
  await audit.record({ action: 'import.completed', entityType: imp.entity_type, summary: `Import ${imp.filename} completed`, metadata: { import_id: imp.id, ...counters } });
  return counters;
}

queue.register('imports.process', processImport, { maxAttempts: 1 });

module.exports = { create, validate, start, processImport, IMPORTABLE };
