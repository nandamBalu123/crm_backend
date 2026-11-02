'use strict';

const pino = require('pino');
const env = require('../config/env');

// Keys that must never reach log sinks. Pino redaction is path based; the
// wildcard paths cover request bodies, headers and nested objects.
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.password_hash',
  '*.new_password',
  '*.current_password',
  '*.token',
  '*.refresh_token',
  '*.access_token',
  '*.secret',
  '*.api_key',
  '*.credentials',
  '*.mfa_secret',
  '*.code',
  'err.config.headers',
];

const transport =
  env.NODE_ENV === 'development' && process.stdout.isTTY
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
    : undefined;

const logger = pino({
  level: env.isTest ? process.env.TEST_LOG_LEVEL || 'silent' : env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  base: { service: 'crm-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport,
});

module.exports = { logger, REDACT_PATHS };
