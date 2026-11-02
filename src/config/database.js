'use strict';

// Used by both the application and sequelize-cli (see .sequelizerc).
const env = require('./env');

const base = {
  dialect: 'mysql',
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  username: env.DB_USER,
  password: env.DB_PASSWORD,
  timezone: '+00:00',
  dialectOptions: { dateStrings: false, decimalNumbers: false, charset: 'utf8mb4' },
  define: { charset: 'utf8mb4', collate: 'utf8mb4_0900_ai_ci', underscored: true },
  migrationStorageTableName: 'sequelize_meta',
  seederStorage: 'sequelize',
  seederStorageTableName: 'sequelize_data',
  pool: { max: env.DB_POOL_MAX, min: 0, acquire: 30_000, idle: 10_000 },
};

module.exports = { development: base, test: base, production: base };
