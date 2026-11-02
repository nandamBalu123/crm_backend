'use strict';

const multer = require('multer');
const express = require('express');
const { createRouter } = require('../../utils/router');
const { z, idParams, uuid } = require('../../utils/schemas');
const service = require('./attachments.service');
const { Attachment } = require('../../models');
const { runInTenant } = require('../../context/requestContext');
const { verifyPayload } = require('../../utils/crypto');
const env = require('../../config/env');
const { ok, created, noContent } = require('../../utils/http');
const E = require('../../errors/AppError');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.UPLOAD_MAX_BYTES, files: 1, fields: 5 } });

const r = createRouter({ prefix: '/api/v1/attachments', tag: 'Files' });
r.get('/', { summary: 'Files attached to a record', permission: 'files:read', query: z.object({ entity_type: z.enum(service.ATTACHABLE), entity_id: uuid() }) }, async (req, res) =>
  ok(res, await service.list(req.valid.query.entity_type, req.valid.query.entity_id)));
r.post('/', { summary: 'Upload a file (multipart: file, entity_type, entity_id)', permission: 'files:create' }, upload.single('file'), async (req, res) => {
  const parsed = z.object({ entity_type: z.enum(service.ATTACHABLE), entity_id: uuid() }).safeParse(req.body || {});
  if (!parsed.success) throw E.validation(parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return created(res, await service.upload({ entityType: parsed.data.entity_type, entityId: parsed.data.entity_id, file: req.file }));
});
r.get('/:id/download', { summary: 'Download a file (authorization checked on the parent record)', permission: 'files:read', params: idParams, produces: 'application/octet-stream' }, async (req, res) =>
  service.stream(await service.getAuthorized(req.valid.params.id), res));
r.post('/:id/link', { summary: 'Create a 5-minute signed download link', permission: 'files:read', params: idParams }, async (req, res) =>
  ok(res, { url: service.signedLink(await service.getAuthorized(req.valid.params.id)), expires_in: 300 }));
r.delete('/:id', { summary: 'Delete a file', permission: 'files:delete', params: idParams }, async (req, res) => {
  await service.remove(req.valid.params.id);
  return noContent(res);
});

const publicRouter = express.Router();
publicRouter.get('/api/v1/public/files/:token', async (req, res) => {
  const p = verifyPayload(req.params.token);
  if (!p || !p.t || !p.a) throw E.notFound('File');
  const att = await runInTenant(p.t, () => Attachment.findByPk(p.a));
  if (!att) throw E.notFound('File');
  await runInTenant(p.t, () => service.stream(att, res), { userId: p.u, actorLabel: 'signed-link' });
});

module.exports = r;
module.exports.publicRouter = publicRouter;
