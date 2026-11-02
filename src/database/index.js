'use strict';

const { Sequelize } = require('sequelize');
const env = require('../config/env');
const dbConfig = require('../config/database')[env.NODE_ENV];
const { logger } = require('../logging/logger');

const sequelize = new Sequelize(dbConfig.database, dbConfig.username, dbConfig.password, {
  ...dbConfig,
  benchmark: true,
  logging: (sql, ms) => {
    if (ms >= env.DB_SLOW_QUERY_MS) logger.warn({ ms, sql: sql.slice(0, 2000) }, 'slow query');
    else if (env.DB_LOG_QUERIES) logger.debug({ ms, sql: sql.slice(0, 2000) }, 'query');
  },
});

module.exports = { sequelize, Sequelize };
