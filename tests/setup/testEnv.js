'use strict';

// Deterministic, non-secret values used only by the automated test suite.
module.exports = {
  NODE_ENV: 'test',
  DOTENV_PATH: '/dev/null',
  JWT_ACCESS_SECRET: 'test-access-secret-test-access-secret-0123456789',
  SIGNING_SECRET: 'test-signing-secret-test-signing-secret-01234567',
  ENCRYPTION_KEY: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
  CORS_ORIGINS: 'http://localhost:5173',
  MAIL_TRANSPORT: 'log',
  JOBS_WORKER: 'off',
  RATE_LIMIT_MAX: '100000',
  AUTH_RATE_LIMIT_MAX: '100000',
  STORAGE_LOCAL_PATH: require('node:path').resolve(__dirname, '../../.test-storage'),
  OUTBOUND_ALLOW_HTTP: 'true',
  OUTBOUND_ALLOW_PRIVATE_NETWORKS: 'true',
  LOG_LEVEL: 'silent',
};
