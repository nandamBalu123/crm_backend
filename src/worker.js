'use strict';

// Standalone job worker process: `npm run worker`.
const { logger } = require('./logging/logger');
const { bootstrap } = require('./bootstrap');
const { startWorker } = require('./jobs/worker');
const { sequelize } = require('./models');

bootstrap()
  .then(() => {
    const worker = startWorker();
    const stop = async () => {
      await worker.stop();
      await sequelize.close();
      process.exit(0);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  })
  .catch((err) => {
    logger.fatal({ err }, 'worker failed to start');
    process.exit(1);
  });
