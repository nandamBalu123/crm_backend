'use strict';

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

const errors = {
  badRequest: (message = 'Bad request', details) => new AppError(400, 'BAD_REQUEST', message, details),
  validation: (details, message = 'Validation failed') => new AppError(422, 'VALIDATION_ERROR', message, details),
  unauthorized: (message = 'Authentication required', code = 'UNAUTHENTICATED') => new AppError(401, code, message),
  forbidden: (message = 'You do not have permission to perform this action', code = 'FORBIDDEN') =>
    new AppError(403, code, message),
  notFound: (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`),
  conflict: (message = 'Conflict', code = 'CONFLICT', details) => new AppError(409, code, message, details),
  tooMany: (message = 'Too many requests') => new AppError(429, 'RATE_LIMITED', message),
  limit: (message) => new AppError(402, 'PLAN_LIMIT_REACHED', message),
  unavailable: (message = 'Service unavailable', code = 'UNAVAILABLE') => new AppError(503, code, message),
};

/** Thrown when tenant-owned data is accessed without a tenant context. Never exposed to clients. */
class TenantContextError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TenantContextError';
  }
}

module.exports = { AppError, TenantContextError, ...errors };
