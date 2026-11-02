'use strict';

/**
 * Boots a real, ephemeral MySQL 8.4 server (mysql-memory-server) unless
 * TEST_DB_HOST is provided (e.g. a CI service container), then creates one
 * database per Jest worker and applies all migrations with sequelize-cli,
 * exactly as production does. Per-worker databases keep the shared job
 * queue (and captured emails) isolated between parallel test files.
 */
const { execSync } = require('node:child_process');
const path = require('node:path');
const testEnv = require('./testEnv');

const WORKERS = Number(process.env.TEST_WORKERS || 4);

module.exports = async function globalSetup() {
  Object.assign(process.env, testEnv);
  if (process.env.TEST_DB_HOST) {
    Object.assign(process.env, {
      DB_HOST: process.env.TEST_DB_HOST,
      DB_PORT: process.env.TEST_DB_PORT || '3306',
      DB_USER: process.env.TEST_DB_USER || 'root',
      DB_PASSWORD: process.env.TEST_DB_PASSWORD || '',
    });
  } else {
    const { createDB } = require('mysql-memory-server');
    const db = await createDB({ version: '8.4.x', dbName: 'crm_test_1', logLevel: 'ERROR' });
    globalThis.__MYSQL__ = db;
    Object.assign(process.env, { DB_HOST: '127.0.0.1', DB_PORT: String(db.port), DB_USER: db.username, DB_PASSWORD: '' });
  }
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD || undefined });
  await Promise.all(Array.from({ length: WORKERS }, async (_, i) => {
    const name = `crm_test_${i + 1}`;
    await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await conn.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    execSync('npx sequelize-cli db:migrate', { cwd: path.resolve(__dirname, '../..'), env: { ...process.env, DB_NAME: name }, stdio: 'pipe' });
  }));
  await conn.end();
  process.env.TEST_WORKERS = String(WORKERS);
};
