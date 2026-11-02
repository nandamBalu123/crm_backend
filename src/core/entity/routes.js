'use strict';

const { createRouter } = require('../../utils/router');
const { z, idParams, uuid } = require('../../utils/schemas');
const { entityController } = require('./controller');
const { requireModule } = require('../../modules/billing/entitlements.service');

const listQuery = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    sort: z.string().max(200).optional(),
    q: z.string().max(100).optional(),
    view: uuid().optional(),
    filter: z.record(z.string(), z.any()).optional(),
    cf: z.record(z.string(), z.any()).optional(),
  })
  .passthrough();

const bulkBody = z.strictObject({
  ids: z.array(uuid()).min(1).max(200),
  action: z.enum(['update', 'delete', 'assign']),
  data: z.record(z.string(), z.any()).optional(),
});

/**
 * Builds the standard REST surface for a CRM entity:
 *   GET / · GET /export · GET /:id · POST / · PATCH /:id · DELETE /:id
 *   POST /bulk · GET /:id/timeline · GET /:id/assignments
 * `extend(r, controller)` adds module-specific routes before the generic /:id routes.
 */
function entityRouter(def, { extend } = {}) {
  const r = createRouter({ prefix: `/api/v1/${def.route}`, tag: def.plural });
  const c = entityController(def);
  const p = (action) => `${def.module}:${action}`;
  if (def.moduleKey) r.router.use(requireModule(def.moduleKey));

  r.get('/', { summary: `List ${def.plural.toLowerCase()} (filter, search, sort, paginate)`, permission: p('read'), query: listQuery }, c.list);
  r.get('/export', { summary: `Export ${def.plural.toLowerCase()} as CSV`, permission: p('export'), query: listQuery, produces: 'text/csv' }, c.exportCsv);
  r.post('/bulk', { summary: `Bulk update/delete/assign ${def.plural.toLowerCase()}`, body: bulkBody }, c.bulk);
  if (extend) extend(r, c);
  r.post('/', { summary: `Create a ${def.label.toLowerCase()}`, permission: p('create'), body: def.createSchema, idempotent: true }, c.create);
  r.get('/:id', { summary: `Get a ${def.label.toLowerCase()}`, permission: p('read'), params: idParams }, c.get);
  r.patch('/:id', { summary: `Update a ${def.label.toLowerCase()}`, permission: p('update'), params: idParams, body: def.updateSchema }, c.update);
  r.delete('/:id', { summary: `Delete a ${def.label.toLowerCase()}`, permission: p('delete'), params: idParams }, c.remove);
  r.get('/:id/timeline', { summary: `Activity timeline of a ${def.label.toLowerCase()}`, permission: p('read'), params: idParams }, c.timeline);
  r.get('/:id/assignments', { summary: 'Ownership history', permission: p('read'), params: idParams }, c.assignments);
  return r;
}

module.exports = { entityRouter, listQuery };
