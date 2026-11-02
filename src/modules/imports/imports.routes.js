'use strict';

const multer = require('multer');
const { createRouter } = require('../../utils/router');
const { z, idParams } = require('../../utils/schemas');
const service = require('./imports.service');
const { Import } = require('../../models');
const { ok, created } = require('../../utils/http');
const E = require('../../errors/AppError');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
const r = createRouter({ prefix: '/api/v1/imports', tag: 'Import & export' });
const ANY_IMPORT = ['leads:import', 'contacts:import', 'accounts:import', 'products:import'];

r.get('/', { summary: 'Import history', permission: ANY_IMPORT }, async (_req, res) => ok(res, await Import.findAll({ order: [['created_at', 'DESC']], limit: 100, attributes: { exclude: ['errors'] } })));
r.get('/:id', { summary: 'Import status and row errors', permission: ANY_IMPORT, params: idParams }, async (req, res) => {
  const imp = await Import.findByPk(req.valid.params.id);
  if (!imp) throw E.notFound('Import');
  return ok(res, imp);
});
r.post('/', { summary: 'Upload a CSV (multipart: file, entity_type) → preview + suggested mapping', permission: ANY_IMPORT }, upload.single('file'), async (req, res) => {
  const entityType = String(req.body?.entity_type || '');
  if (!file(req)) throw E.validation([{ path: 'file', message: 'A CSV file is required' }]);
  if (!/\.csv$/i.test(req.file.originalname)) throw E.validation([{ path: 'file', message: 'Only .csv files are supported' }]);
  return created(res, await service.create({ entityType, file: req.file }));
});
r.post('/:id/validate', {
  summary: 'Save the column mapping and validate rows (dry run)', permission: ANY_IMPORT, params: idParams,
  body: z.strictObject({ mapping: z.record(z.string().max(200), z.string().max(80).nullable()).optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }),
}, async (req, res) => ok(res, await service.validate(req.valid.params.id, req.valid.body)));
r.post('/:id/start', { summary: 'Start the import in the background', permission: ANY_IMPORT, params: idParams, body: z.strictObject({ duplicate_strategy: z.enum(['skip', 'update', 'create']).optional() }) }, async (req, res) =>
  ok(res, await service.start(req.valid.params.id, req.valid.body)));

function file(req) {
  return req.file && req.file.buffer && req.file.size > 0;
}

module.exports = r;
