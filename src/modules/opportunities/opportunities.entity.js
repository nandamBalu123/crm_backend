'use strict';

const { Opportunity, Pipeline, PipelineStage, OpportunityStageHistory, Account, Contact } = require('../../models');
const { z, customFields, ref, money, int, date, optionalText, toUpdate } = require('../../core/entity/schemaHelpers');
const { requiredText } = require('../../utils/schemas');
const { ownerInclude } = require('../../core/entity/service');
const timeline = require('../timeline/timeline.service');
const events = require('../../events/domainEvents');
const E = require('../../errors/AppError');

const shape = {
  name: requiredText(200),
  account_id: ref(),
  contact_id: ref(),
  pipeline_id: ref(),
  stage_id: ref(),
  amount: money(),
  currency: z.string().length(3).toUpperCase().optional(),
  probability: int(0, 100),
  expected_close_date: date(),
  forecast_category: z.enum(['pipeline', 'best_case', 'commit', 'closed', 'omitted']).optional(),
  win_reason: optionalText(255),
  loss_reason: optionalText(255),
  next_step: optionalText(255),
  description: optionalText(20000),
  owner_id: ref(),
  team_id: ref(),
  campaign_id: ref(),
  custom_fields: customFields(),
};

async function resolveStage(data, current, transaction) {
  const pipelineId = data.pipeline_id || current?.pipeline_id;
  const pipeline = pipelineId ? await Pipeline.findByPk(pipelineId, { transaction }) : await Pipeline.findOne({ where: { is_default: true, is_active: true }, transaction });
  if (!pipeline) throw E.validation([{ path: 'pipeline_id', message: 'Pipeline not found' }]);
  data.pipeline_id = pipeline.id;
  const stageId = data.stage_id || (data.pipeline_id !== current?.pipeline_id ? null : current?.stage_id);
  const stage = stageId
    ? await PipelineStage.findOne({ where: { id: stageId, pipeline_id: pipeline.id }, transaction })
    : await PipelineStage.findOne({ where: { pipeline_id: pipeline.id, category: 'open', is_active: true }, order: [['display_order', 'ASC']], transaction });
  if (!stage) throw E.validation([{ path: 'stage_id', message: 'Stage does not belong to the pipeline' }]);
  data.stage_id = stage.id;
  return stage;
}

function applyStage(data, stage, { explicitProbability, current }) {
  if (!explicitProbability) data.probability = stage.probability;
  data.status = stage.category;
  if (stage.category === 'open') {
    data.closed_at = null;
    if (current?.status !== 'open' && data.forecast_category === undefined) data.forecast_category = 'pipeline';
  } else {
    data.closed_at = current?.closed_at && current.status === stage.category ? current.closed_at : new Date();
    data.forecast_category = stage.category === 'won' ? 'closed' : 'omitted';
    if (stage.category === 'lost' && !(data.loss_reason || current?.loss_reason)) {
      throw E.validation([{ path: 'loss_reason', message: 'A loss reason is required when closing a deal as lost' }]);
    }
  }
}

module.exports = {
  type: 'opportunity',
  module: 'opportunities',
  moduleKey: 'opportunities',
  route: 'opportunities',
  label: 'Opportunity',
  plural: 'Opportunities',
  model: Opportunity,
  ownerField: 'owner_id',
  timelineRelation: 'opportunity_id',
  title: (r) => r.name,
  searchFields: ['name', 'next_step'],
  sortable: ['name', 'amount', 'expected_close_date', 'probability', 'created_at', 'updated_at', 'closed_at', 'stage_entered_at', 'last_activity_at'],
  filterable: {
    status: 'enum', pipeline_id: 'uuid', stage_id: 'uuid', owner_id: 'uuid', team_id: 'uuid', account_id: 'uuid', contact_id: 'uuid',
    campaign_id: 'uuid', amount: 'number', probability: 'number', forecast_category: 'enum', expected_close_date: 'date', closed_at: 'date',
    created_at: 'date', currency: 'string',
  },
  exportColumns: ['id', 'name', 'account_id', 'contact_id', 'pipeline_id', 'stage_id', 'amount', 'currency', 'probability', 'status', 'forecast_category', 'expected_close_date', 'closed_at', 'loss_reason', 'owner_id', 'created_at'],
  bulkUpdatable: ['forecast_category', 'expected_close_date', 'team_id'],
  sensitiveFields: ['amount', 'probability', 'description'],
  createSchema: z.strictObject(shape),
  updateSchema: toUpdate(shape),
  listInclude: () => [
    ownerInclude(),
    { model: Account, as: 'account', attributes: ['id', 'name'] },
    { model: PipelineStage, as: 'stage', attributes: ['id', 'name', 'category', 'probability', 'display_order'] },
  ],
  detailInclude: () => [
    ownerInclude(),
    { model: Account, as: 'account', attributes: ['id', 'name', 'domain'] },
    { model: Contact, as: 'contact', attributes: ['id', 'first_name', 'last_name', 'email'] },
    { model: PipelineStage, as: 'stage', attributes: ['id', 'name', 'category', 'probability', 'display_order', 'rotting_days'] },
    { model: Pipeline, as: 'pipeline', attributes: ['id', 'name'] },
  ],
  decorate(plain) {
    if (plain.amount !== undefined && plain.probability !== undefined) {
      plain.weighted_amount = ((Number(plain.amount) * Number(plain.probability)) / 100).toFixed(2);
    }
  },
  hooks: {
    async beforeCreate(data, { transaction, ctx }) {
      if (!data.currency) data.currency = ctx.settings?.currency || 'USD';
      const stage = await resolveStage(data, null, transaction);
      applyStage(data, stage, { explicitProbability: data.probability !== undefined && data.probability !== null });
      data.stage_entered_at = new Date();
    },
    async afterCreate(record, { transaction }) {
      await OpportunityStageHistory.create({ opportunity_id: record.id, from_stage_id: null, to_stage_id: record.stage_id, amount: record.amount, probability: record.probability, changed_by_user_id: require('../../context/requestContext').getContext()?.userId || null }, { transaction });
    },
    async beforeUpdate(record, data, { transaction }) {
      const stageChanging = (data.stage_id && data.stage_id !== record.stage_id) || (data.pipeline_id && data.pipeline_id !== record.pipeline_id);
      if (!stageChanging) {
        if (data.loss_reason === null && record.status === 'lost') throw E.validation([{ path: 'loss_reason', message: 'Lost deals require a loss reason' }]);
        return;
      }
      const stage = await resolveStage(data, record, transaction);
      applyStage(data, stage, { explicitProbability: data.probability !== undefined && data.probability !== null, current: record });
      data.stage_entered_at = new Date();
    },
    async afterUpdate(record, changes, { transaction, ctx, before }) {
      if (!changes.stage_id) return;
      const [from, to] = await Promise.all([
        PipelineStage.findByPk(before.stage_id, { attributes: ['name'], transaction }),
        PipelineStage.findByPk(record.stage_id, { attributes: ['name', 'category'], transaction }),
      ]);
      const seconds = before.stage_entered_at ? Math.round((Date.now() - new Date(before.stage_entered_at).getTime()) / 1000) : null;
      await OpportunityStageHistory.create({
        opportunity_id: record.id, from_stage_id: before.stage_id, to_stage_id: record.stage_id, amount: record.amount,
        probability: record.probability, time_in_previous_stage_seconds: seconds, changed_by_user_id: ctx.userId || null,
      }, { transaction });
      await timeline.add('opportunity', record.id, 'stage_changed', `Stage changed from ${from?.name || '—'} to ${to?.name}`, { from_stage_id: before.stage_id, to_stage_id: record.stage_id }, { transaction });
      await events.publish('opportunity.stage_changed', { entityType: 'opportunity', entityId: record.id, data: { ...record.get({ plain: true }), from_stage_id: before.stage_id, stage_name: to?.name, tenant_id: undefined } }, { transaction });
      if (to?.category === 'won' || to?.category === 'lost') {
        await events.publish(`opportunity.${to.category}`, { entityType: 'opportunity', entityId: record.id, data: { id: record.id, amount: record.amount, currency: record.currency } }, { transaction });
      }
    },
  },
};
