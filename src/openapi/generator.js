'use strict';

const { z } = require('zod');
const { registry } = require('../utils/router');
const pkg = require('../../package.json');

function toJsonSchema(schema) {
  try {
    return z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' });
  } catch {
    return { type: 'object' };
  }
}

const errorSchema = {
  type: 'object',
  properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: { type: 'array', items: { type: 'object' } }, request_id: { type: 'string' } }, required: ['code', 'message'] } },
};

/** OpenAPI 3.1 document generated from the live route registry and zod schemas. */
function buildOpenApi() {
  const paths = {};
  for (const route of registry) {
    const path = route.path.replace(/:([A-Za-z_]+)/g, '{$1}');
    paths[path] = paths[path] || {};
    const params = [...route.path.matchAll(/:([A-Za-z_]+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    if (route.query) {
      const qs = toJsonSchema(route.query);
      for (const [name, schema] of Object.entries(qs.properties || {})) {
        params.push({ name, in: 'query', required: (qs.required || []).includes(name), schema, ...(schema.type === 'object' ? { style: 'deepObject', explode: true } : {}) });
      }
    }
    const security = route.auth === 'public' ? [] : route.auth === 'user' || route.auth === 'platform' ? [{ cookieAuth: [] }] : [{ cookieAuth: [] }, { apiKey: [] }];
    paths[path][route.method] = {
      tags: [route.tag],
      summary: route.summary,
      operationId: `${route.method}_${route.path.replace(/^\/api\/v1\//, '').replace(/[/:{}-]+/g, '_')}`,
      ...(route.permission ? { description: `Required permission: \`${[].concat(route.permission).join('` or `')}\`` } : {}),
      parameters: [...params, ...(route.idempotent ? [{ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } }] : [])],
      ...(route.body ? { requestBody: { required: true, content: { 'application/json': { schema: toJsonSchema(route.body) } } } } : {}),
      security,
      responses: {
        200: { description: 'Success', content: { [route.produces || 'application/json']: { schema: { type: 'object' } } } },
        401: { description: 'Unauthenticated', content: { 'application/json': { schema: errorSchema } } },
        403: { description: 'Forbidden', content: { 'application/json': { schema: errorSchema } } },
        404: { description: 'Not found', content: { 'application/json': { schema: errorSchema } } },
        422: { description: 'Validation error', content: { 'application/json': { schema: errorSchema } } },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'CRM SaaS API', version: pkg.version, description: 'Multi-tenant CRM REST API. All tenant data is scoped to the authenticated workspace.' },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'crm_at', description: 'Browser session (HttpOnly). Unsafe methods also require X-CSRF-Token.' },
        apiKey: { type: 'http', scheme: 'bearer', description: 'API key: `Authorization: Bearer crm_<prefix>_<secret>`' },
      },
    },
    paths,
  };
}

module.exports = { buildOpenApi };
