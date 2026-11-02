'use strict';

// Runs in every test worker before modules load: pick this worker's database.
const worker = ((Number(process.env.JEST_WORKER_ID || 1) - 1) % Number(process.env.TEST_WORKERS || 4)) + 1;
Object.assign(process.env, require('./testEnv'), {
  DB_HOST: process.env.DB_HOST,
  DB_PORT: process.env.DB_PORT,
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD,
  DB_NAME: `crm_test_${worker}`,
});
