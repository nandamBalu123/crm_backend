'use strict';

const { sequelize } = require('./models');
const { syncCatalog } = require('./modules/rbac/catalog.service');

/** Loads job handlers and event targets, verifies DB connectivity and syncs catalogs. */
async function bootstrap() {
  require('./jobs/handlers');
  await sequelize.authenticate();
  await syncCatalog();
}

module.exports = { bootstrap };
