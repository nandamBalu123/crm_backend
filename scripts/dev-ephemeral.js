'use strict';

/**
 * Development without a local MySQL install: downloads and starts a
 * throwaway MySQL 8.4 (mysql-memory-server), migrates, seeds demo data, then
 * starts the API with the inline worker. Data is lost when the process exits.
 */
const { spawn, execSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');

(async () => {
  const { createDB } = require('mysql-memory-server');
  const db = await createDB({ version: '8.4.x', dbName: 'crm_dev', logLevel: 'ERROR' });
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    DB_HOST: '127.0.0.1', DB_PORT: String(db.port), DB_USER: db.username, DB_PASSWORD: '', DB_NAME: db.dbName,
    JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET || crypto.randomBytes(32).toString('hex'),
    SIGNING_SECRET: process.env.SIGNING_SECRET || crypto.randomBytes(32).toString('hex'),
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex'),
    SEED_DEMO_DATA: process.env.SEED_DEMO_DATA || 'true',
    SEED_ADMIN_EMAIL: process.env.SEED_ADMIN_EMAIL || 'admin@example.test',
    SEED_ADMIN_PASSWORD: process.env.SEED_ADMIN_PASSWORD || `Dev-${crypto.randomBytes(6).toString('base64url')}-1`,
    DOTENV_PATH: process.env.DOTENV_PATH || path.resolve(__dirname, '../.env'),
  };
  const cwd = path.resolve(__dirname, '..');
  execSync('npx sequelize-cli db:migrate', { cwd, env, stdio: 'inherit' });
  execSync('npx sequelize-cli db:seed:all', { cwd, env, stdio: 'inherit' });
  console.log(`\nEphemeral MySQL on port ${db.port}.\nDevelopment login: ${env.SEED_ADMIN_EMAIL} / ${env.SEED_ADMIN_PASSWORD}\n(development only — data is discarded on exit)\n`);
  const child = spawn(process.execPath, ['src/server.js'], { cwd, env, stdio: 'inherit' });
  const stop = async () => {
    child.kill('SIGTERM');
    await db.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', async (code) => {
    await db.stop();
    process.exit(code ?? 0);
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
