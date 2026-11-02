'use strict';

/**
 * Migration round trip on a dedicated schema: up → down (all) → up.
 * Verifies every migration is reversible and re-applicable.
 */
const { execSync } = require('node:child_process');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { sequelize } = require('../../src/models');

afterAll(() => sequelize.close());

test('all migrations can be undone and re-applied', async () => {
  const name = `crm_migr_${process.env.JEST_WORKER_ID || 1}`;
  const conn = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD || undefined });
  await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await conn.query(`CREATE DATABASE \`${name}\``);
  const run = (cmd) => execSync(`npx sequelize-cli ${cmd}`, { cwd: path.resolve(__dirname, '../..'), env: { ...process.env, DB_NAME: name }, stdio: 'pipe' }).toString();
  run('db:migrate');
  const [[{ n: up }]] = await conn.query('SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = ?', [name]);
  run('db:migrate:undo:all');
  const [[{ n: down }]] = await conn.query('SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = ?', [name]);
  run('db:migrate');
  const [[{ n: again }]] = await conn.query('SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = ?', [name]);
  const [fks] = await conn.query("SELECT COUNT(*) n FROM information_schema.referential_constraints WHERE constraint_schema = ? AND constraint_name LIKE 'fk\\_%'", [name]);
  await conn.query(`DROP DATABASE \`${name}\``);
  await conn.end();
  expect(up).toBeGreaterThan(60);
  expect(down).toBe(1); // only sequelize_meta remains
  expect(again).toBe(up);
  expect(fks[0].n).toBeGreaterThan(80); // composite tenant-aware foreign keys
}, 120_000);
