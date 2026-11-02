'use strict';

const { validation } = require('../errors/AppError');

function formatIssues(issues, location) {
  return issues.map((i) => ({ location, path: i.path.join('.'), message: i.message, code: i.code }));
}

/**
 * Validates req.params / req.query / req.body with zod schemas and stores the
 * parsed (coerced, stripped) result on req.valid. Handlers must read from
 * req.valid only, never from raw req.body, which prevents mass assignment.
 */
function validate({ params, query, body }) {
  return (req, _res, next) => {
    const out = {};
    const problems = [];
    for (const [loc, schema] of [['params', params], ['query', query], ['body', body]]) {
      if (!schema) continue;
      const result = schema.safeParse(req[loc] ?? {});
      if (result.success) out[loc] = result.data;
      else problems.push(...formatIssues(result.error.issues, loc));
    }
    if (problems.length) return next(validation(problems));
    req.valid = { ...(req.valid || {}), ...out };
    return next();
  };
}

module.exports = { validate, formatIssues };
