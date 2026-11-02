'use strict';

const { AppError } = require('../errors/AppError');
const { logger } = require('../logging/logger');

function mapError(err) {
  if (err instanceof AppError) return { status: err.status, code: err.code, message: err.message, details: err.details };
  switch (err.name) {
    case 'SequelizeOptimisticLockError':
      return { status: 409, code: 'VERSION_CONFLICT', message: 'This record was changed by someone else. Reload and try again.' };
    case 'SequelizeUniqueConstraintError': {
      // Index names follow uq_<table>_tenant_id_<column…>; report the user-facing column, not the index.
      const fields = [...new Set((err.errors || []).map((e) => String(e.path || '').split('tenant_id_').pop().replace(/^uq_/, '')).filter(Boolean))];
      const label = fields.map((f) => f.replace(/_/g, ' ')).join(', ');
      return {
        status: 409, code: 'DUPLICATE',
        message: label ? `Another record already uses this ${label}` : 'A record with the same unique value already exists',
        details: fields.map((f) => ({ path: f, message: 'Already in use' })),
      };
    }
    case 'SequelizeForeignKeyConstraintError':
      return { status: 422, code: 'INVALID_REFERENCE', message: 'A referenced record does not exist in this workspace or is still in use' };
    case 'SequelizeValidationError':
      return { status: 422, code: 'VALIDATION_ERROR', message: 'Validation failed', details: (err.errors || []).map((e) => ({ path: e.path, message: e.message })) };
    case 'PayloadTooLargeError':
      return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' };
    case 'MulterError':
      return { status: err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, code: 'UPLOAD_ERROR', message: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : 'Invalid upload' };
    default:
      break;
  }
  if (err.type === 'entity.parse.failed') return { status: 400, code: 'INVALID_JSON', message: 'Malformed JSON body' };
  if (err.type === 'entity.too.large') return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' };
  return { status: 500, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' };
}

/** Central error handler: never leaks stack traces, SQL or internals to clients. */
function errorHandler(err, req, res, _next) {
  const mapped = mapError(err);
  const log = { err, requestId: req.id, method: req.method, path: req.originalUrl, tenantId: req.ctx?.tenantId, userId: req.ctx?.userId };
  if (mapped.status >= 500) logger.error(log, 'request failed');
  else if (err.name === 'TenantContextError') logger.error(log, 'tenant isolation violation blocked');
  else logger.debug({ code: mapped.code, path: req.originalUrl }, 'request rejected');
  if (res.headersSent) return res.end();
  return res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message, ...(mapped.details ? { details: mapped.details } : {}), request_id: req.id } });
}

function notFound(req, res) {
  res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found', request_id: req.id } });
}

module.exports = { errorHandler, notFound, mapError };
