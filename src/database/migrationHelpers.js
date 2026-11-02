'use strict';

/**
 * Shared helpers for migrations.
 *
 * Every tenant-owned table gets:
 *  - UUIDv7 primary key stored as CHAR(36) ascii (compact, binary collation)
 *  - non-null tenant_id → tenants.id
 *  - a unique (tenant_id, id) index so children can reference it with a
 *    composite, tenant-aware foreign key: (tenant_id, x_id) → parent(tenant_id, id)
 */
const ID = 'CHAR(36) CHARACTER SET ascii COLLATE ascii_bin';

const pk = () => ({ type: ID, primaryKey: true, allowNull: false });
const ref = (allowNull = true) => ({ type: ID, allowNull });

function timestamps(S) {
  return {
    created_at: { type: S.DATE(3), allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP(3)') },
    updated_at: { type: S.DATE(3), allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP(3)') },
  };
}

function shortName(prefix, table, cols) {
  const name = `${prefix}_${table}_${cols.join('_')}`;
  if (name.length <= 64) return name;
  const crypto = require('node:crypto');
  return `${name.slice(0, 50)}_${crypto.createHash('md5').update(name).digest('hex').slice(0, 10)}`;
}

/**
 * @param {object} opts
 *  - indexes: [{ fields: [...], unique?, name? }]  (tenant_id is NOT auto-prefixed; be explicit)
 *  - fks: [[column, parentTable, parentColumn = 'id']] composite tenant-aware FKs
 *  - soft: add deleted_at
 *  - version: add optimistic-lock version column
 */
async function createTenantTable(qi, S, table, columns, opts = {}) {
  const def = {
    id: pk(),
    tenant_id: { type: ID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT' },
    ...columns,
    ...(opts.version ? { version: { type: S.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 } } : {}),
    ...(opts.noTimestamps ? {} : timestamps(S)),
    ...(opts.soft ? { deleted_at: { type: S.DATE(3), allowNull: true } } : {}),
  };
  if (opts.noUpdatedAt) delete def.updated_at;
  await qi.createTable(table, def, { charset: 'utf8mb4', collate: 'utf8mb4_0900_ai_ci', engine: 'InnoDB' });
  await qi.addIndex(table, ['tenant_id', 'id'], { unique: true, name: shortName('uq', table, ['tenant', 'id']) });
  for (const idx of opts.indexes || []) {
    await qi.addIndex(table, idx.fields, {
      unique: !!idx.unique,
      name: idx.name || shortName(idx.unique ? 'uq' : 'ix', table, idx.fields.map((f) => (typeof f === 'string' ? f : f.name))),
    });
  }
  for (const [column, parent, parentColumn = 'id'] of opts.fks || []) {
    await addTenantFk(qi, table, column, parent, parentColumn);
  }
}

async function addTenantFk(qi, table, column, parent, parentColumn = 'id') {
  const name = shortName('fk', table, [column]);
  await qi.sequelize.query(
    `ALTER TABLE \`${table}\` ADD CONSTRAINT \`${name}\` FOREIGN KEY (\`tenant_id\`, \`${column}\`) ` +
      `REFERENCES \`${parent}\` (\`tenant_id\`, \`${parentColumn}\`) ON DELETE RESTRICT ON UPDATE RESTRICT`
  );
}

const address = (S) => ({
  address_line1: { type: S.STRING(200) },
  address_line2: { type: S.STRING(200) },
  city: { type: S.STRING(120) },
  state: { type: S.STRING(120) },
  postal_code: { type: S.STRING(30) },
  country: { type: S.STRING(80) },
});

module.exports = { ID, pk, ref, timestamps, createTenantTable, addTenantFk, address, shortName };
