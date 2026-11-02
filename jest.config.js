'use strict';

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  globalSetup: '<rootDir>/tests/setup/globalSetup.js',
  globalTeardown: '<rootDir>/tests/setup/globalTeardown.js',
  setupFiles: ['<rootDir>/tests/setup/setupEnv.js'],
  testTimeout: 30000,
  maxWorkers: Number(process.env.TEST_WORKERS || 4),
  collectCoverageFrom: ['src/**/*.js', '!src/database/migrations/**', '!src/database/seeders/**'],
};
