'use strict';

const { Permission, Plan } = require('../../models');
const { CATALOG } = require('../../config/permissions');
const PLANS = require('../../config/plans');
const { runAsSystem } = require('../../context/requestContext');

/** Insert that tolerates a concurrent insert of the same unique key (several instances booting at once). */
async function createIfAbsent(Model, values) {
  try {
    await Model.create(values);
  } catch (err) {
    if (err.name !== 'SequelizeUniqueConstraintError') throw err;
  }
}

/** Idempotently synchronises the permission catalog and default plans (startup + seeders). */
async function syncCatalog() {
  return runAsSystem('catalog:sync', async () => {
    const existing = await Permission.findAll();
    const byKey = new Map(existing.map((p) => [p.key, p]));
    for (const p of CATALOG) {
      const row = byKey.get(p.key);
      if (!row) await createIfAbsent(Permission, p);
      else if (row.description !== p.description || row.sort_order !== p.sort_order || row.supports_scope !== p.supports_scope) await row.update(p);
    }
    for (const plan of PLANS) {
      const row = await Plan.findOne({ where: { code: plan.code } });
      if (!row) await createIfAbsent(Plan, { ...plan, currency: 'USD' });
    }
  });
}

module.exports = { syncCatalog };
