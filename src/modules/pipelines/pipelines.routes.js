'use strict';

const { createRouter } = require('../../utils/router');
const { z, idParams, uuid, requiredText } = require('../../utils/schemas');
const { sequelize, Pipeline, PipelineStage, Opportunity } = require('../../models');
const audit = require('../audit/audit.service');
const { ok, created, noContent } = require('../../utils/http');
const E = require('../../errors/AppError');

const r = createRouter({ prefix: '/api/v1/pipelines', tag: 'Pipelines' });

const stageSchema = z.strictObject({
  id: uuid().optional(),
  name: requiredText(120),
  probability: z.coerce.number().int().min(0).max(100),
  category: z.enum(['open', 'won', 'lost']).default('open'),
  rotting_days: z.coerce.number().int().min(1).max(365).nullish(),
});
const pipelineBody = z.strictObject({
  name: requiredText(120),
  is_default: z.boolean().optional(),
  is_active: z.boolean().optional(),
  stages: z.array(stageSchema).min(2).max(30).optional(),
});

function validateStages(stages) {
  if (!stages) return;
  if (!stages.some((s) => s.category === 'open')) throw E.validation([{ path: 'stages', message: 'At least one open stage is required' }]);
  if (!stages.some((s) => s.category === 'won')) throw E.validation([{ path: 'stages', message: 'A won stage is required' }]);
  if (!stages.some((s) => s.category === 'lost')) throw E.validation([{ path: 'stages', message: 'A lost stage is required' }]);
}

async function saveStages(pipeline, stages, moveTo, transaction) {
  const existing = await PipelineStage.findAll({ where: { pipeline_id: pipeline.id }, transaction });
  const keep = new Set(stages.filter((s) => s.id).map((s) => s.id));
  for (const s of existing) {
    if (keep.has(s.id)) continue;
    const used = await Opportunity.count({ where: { stage_id: s.id }, paranoid: false, transaction });
    if (used) {
      const target = moveTo?.[s.id];
      if (!target) throw E.conflict(`Stage "${s.name}" has ${used} opportunities. Provide move_to for it.`, 'STAGE_IN_USE', { stage_id: s.id, count: used });
      await Opportunity.update({ stage_id: target }, { where: { stage_id: s.id }, transaction, paranoid: false });
    }
    await s.destroy({ transaction });
  }
  for (const [i, s] of stages.entries()) {
    const values = { name: s.name, probability: s.probability, category: s.category, rotting_days: s.rotting_days ?? null, display_order: i, pipeline_id: pipeline.id };
    if (s.id) {
      const row = existing.find((e) => e.id === s.id);
      if (!row) throw E.validation([{ path: 'stages.id', message: 'Stage not found in this pipeline' }]);
      await row.update(values, { transaction });
    } else await PipelineStage.create(values, { transaction });
  }
}

const withStages = { include: [{ model: PipelineStage, as: 'stages', separate: true, order: [['display_order', 'ASC']] }], order: [['display_order', 'ASC'], ['created_at', 'ASC']] };

r.get('/', { summary: 'List pipelines with stages', permission: ['opportunities:read', 'settings:manage'] }, async (_req, res) => ok(res, await Pipeline.findAll(withStages)));
r.get('/:id', { summary: 'Get a pipeline', permission: ['opportunities:read', 'settings:manage'], params: idParams }, async (req, res) => {
  const p = await Pipeline.findOne({ where: { id: req.valid.params.id }, ...withStages });
  if (!p) throw E.notFound('Pipeline');
  return ok(res, p);
});
r.post('/', { summary: 'Create a pipeline', permission: 'settings:manage', body: pipelineBody.required({ stages: true }) }, async (req, res) => {
  const body = req.valid.body;
  validateStages(body.stages);
  const pipeline = await sequelize.transaction(async (transaction) => {
    if (body.is_default) await Pipeline.update({ is_default: false }, { where: {}, transaction });
    const count = await Pipeline.count({ transaction });
    const p = await Pipeline.create({ name: body.name, is_default: body.is_default || count === 0, display_order: count }, { transaction });
    await saveStages(p, body.stages, null, transaction);
    await audit.record({ action: 'pipeline.created', entityType: 'pipeline', entityId: p.id, summary: `Pipeline ${p.name} created` }, { transaction });
    return p;
  });
  return created(res, await Pipeline.findOne({ where: { id: pipeline.id }, ...withStages }));
});
r.put('/:id', {
  summary: 'Update a pipeline and its stages (reorder, rename, add, remove)', permission: 'settings:manage', params: idParams,
  body: pipelineBody.extend({ move_to: z.record(uuid(), uuid()).optional() }),
}, async (req, res) => {
  const body = req.valid.body;
  validateStages(body.stages);
  await sequelize.transaction(async (transaction) => {
    const p = await Pipeline.findByPk(req.valid.params.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!p) throw E.notFound('Pipeline');
    if (body.is_default) await Pipeline.update({ is_default: false }, { where: {}, transaction });
    if (body.is_default === false && p.is_default) throw E.validation([{ path: 'is_default', message: 'Choose another default pipeline first' }]);
    await p.update({ name: body.name, ...(body.is_default !== undefined ? { is_default: body.is_default } : {}), ...(body.is_active !== undefined ? { is_active: body.is_active } : {}) }, { transaction });
    if (body.stages) await saveStages(p, body.stages, body.move_to, transaction);
    await audit.record({ action: 'pipeline.updated', entityType: 'pipeline', entityId: p.id, summary: `Pipeline ${p.name} updated` }, { transaction });
  });
  return ok(res, await Pipeline.findOne({ where: { id: req.valid.params.id }, ...withStages }));
});
r.delete('/:id', { summary: 'Delete an unused pipeline', permission: 'settings:manage', params: idParams }, async (req, res) => {
  await sequelize.transaction(async (transaction) => {
    const p = await Pipeline.findByPk(req.valid.params.id, { transaction });
    if (!p) throw E.notFound('Pipeline');
    if (p.is_default) throw E.conflict('The default pipeline cannot be deleted', 'DEFAULT_PIPELINE');
    if (await Opportunity.count({ where: { pipeline_id: p.id }, paranoid: false, transaction })) throw E.conflict('This pipeline still has opportunities', 'PIPELINE_IN_USE');
    await PipelineStage.destroy({ where: { pipeline_id: p.id }, transaction });
    await p.destroy({ transaction });
    await audit.record({ action: 'pipeline.deleted', entityType: 'pipeline', entityId: p.id, summary: `Pipeline ${p.name} deleted` }, { transaction });
  });
  return noContent(res);
});

module.exports = r;
