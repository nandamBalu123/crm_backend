'use strict';

// Creates the configured database if it does not exist (development convenience).
const mysql = require('mysql2/promise');
const env = require('../src/config/env');

(async () => {
  const conn = await mysql.createConnection({ host: env.DB_HOST, port: env.DB_PORT, user: env.DB_USER, password: env.DB_PASSWORD });
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${env.DB_NAME.replace(/`/g, '')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  await conn.end();
  console.log(`Database ${env.DB_NAME} is ready`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
