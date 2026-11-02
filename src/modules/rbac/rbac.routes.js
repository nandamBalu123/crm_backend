'use strict';

const { createRouter } = require('../../utils/router');
const { z, idParams, uuid, requiredText, trimmed } = require('../../utils/schemas');
const service = require('./roles.service');
const registry = require('../../core/entity/registry');
const cf = require('../customFields/customFields.service');
const { ok, created, noContent } = require('../../utils/http');

const r = createRouter({ prefix: '/api/v1/roles', tag: 'Roles & permissions' });

const permissionsSchema = z.record(z.string().max(80), z.enum(['own', 'team', 'all']));
const fieldPermissionsSchema = z.array(z.strictObject({
  entity_type: z.enum(registry.CUSTOM_FIELD_ENTITIES),
  field_key: z.string().regex(/^(cf\.)?[a-z][a-z0-9_]{0,62}$/),
  access: z.enum(['hidden', 'read']),
})).max(500);

r.get('/permissions', { summary: 'Permission catalog grouped by module', permission: 'roles:read' }, (_req, res) => ok(res, service.catalog()));
r.get('/fields', { summary: 'Fields that support field-level permissions, per entity', permission: 'roles:read' }, async (_req, res) => {
  const out = {};
  for (const type of ['lead', 'contact', 'account', 'opportunity', 'ticket', 'quote']) {
    const def = registry.get(type);
    const custom = await cf.getDefinitions(type);
    out[type] = [
      ...(def.sensitiveFields || []).map((f) => ({ key: f, label: f.replace(/_/g, ' '), custom: false })),
      ...custom.map((d) => ({ key: `cf.${d.key}`, label: d.label, custom: true })),
    ];
  }
  return ok(res, out);
});
r.get('/', { summary: 'List roles', permission: 'roles:read' }, async (_req, res) => ok(res, await service.list()));
r.get('/:id', { summary: 'Get a role with permissions', permission: 'roles:read', params: idParams }, async (req, res) => ok(res, await service.get(req.valid.params.id)));
r.post('/', {
  summary: 'Create a custom role (optionally cloned)', permission: 'roles:manage',
  body: z.strictObject({ name: requiredText(80), description: trimmed(255).optional(), permissions: permissionsSchema.optional(), clone_from_id: uuid().optional() }),
}, async (req, res) => created(res, await service.create(req.valid.body)));
r.post('/:id/clone', { summary: 'Clone a role', permission: 'roles:manage', params: idParams, body: z.strictObject({ name: requiredText(80) }) }, async (req, res) =>
  created(res, await service.create({ name: req.valid.body.name, clone_from_id: req.valid.params.id })));
r.patch('/:id', {
  summary: 'Rename, describe, enable/disable a role or replace its permissions', permission: 'roles:manage', params: idParams,
  body: z.strictObject({ name: requiredText(80).optional(), description: trimmed(255).nullish(), is_active: z.boolean().optional(), permissions: permissionsSchema.optional(), field_permissions: fieldPermissionsSchema.optional() }),
}, async (req, res) => ok(res, await service.update(req.valid.params.id, req.valid.body)));
r.delete('/:id', { summary: 'Delete an unused custom role', permission: 'roles:manage', params: idParams }, async (req, res) => {
  await service.remove(req.valid.params.id);
  return noContent(res);
});

module.exports = r;
