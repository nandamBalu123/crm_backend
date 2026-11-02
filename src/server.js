'use strict';

const env = require('./config/env');
const { logger } = require('./logging/logger');
const { bootstrap } = require('./bootstrap');
const { createApp } = require('./app');
const { sequelize } = require('./models');

async function main() {
  await bootstrap();
  const app = createApp();
  const server = app.listen(env.PORT, () => logger.info({ port: env.PORT, env: env.NODE_ENV }, 'CRM API listening'));
  server.keepAliveTimeout = 65_000;
  const worker = env.JOBS_WORKER === 'inline' ? require('./jobs/worker').startWorker() : null;

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 15_000).unref();
    server.close(async () => {
      try {
        if (worker) await worker.stop();
        await sequelize.close();
        clearTimeout(force);
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'error during shutdown');
        process.exit(1);
      }
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
