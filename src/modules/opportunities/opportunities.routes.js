'use strict';

const { Op, fn, col } = require('sequelize');
const { entityRouter } = require('../../core/entity/routes');
const service = require('../../core/entity/service');
const { scopeWhere } = require('../../core/entity/policy');
const { serializeMany } = require('../../core/entity/serializer');
const { sequelize, Pipeline, PipelineStage, OpportunityStageHistory, OpportunityProduct, Product, Opportunity } = require('../../models');
const { z, idParams, uuid, decimalString } = require('../../utils/schemas');
const money = require('../../utils/money');
const audit = require('../audit/audit.service');
const { ok } = require('../../utils/http');
const { getContext } = require('../../context/requestContext');
const E = require('../../errors/AppError');
const def = require('./opportunities.entity');

const moveBody = z.strictObject({ stage_id: uuid(), loss_reason: z.string().trim().max(255).optional(), win_reason: z.string().trim().max(255).optional(), version: z.number().int().optional() });
const productsBody = z.strictObject({
  items: z.array(z.strictObject({ product_id: uuid(), quantity: decimalString({ min: 0.0001 }), unit_price: decimalString({ min: 0 }).optional(), discount_percent: decimalString({ min: 0, max: 100 }).optional() })).max(200),
  update_amount: z.boolean().optional(),
});

module.exports = entityRouter(def, {
  extend(r) {
    r.get('/board', {
      summary: 'Kanban board: stages with their opportunities and totals', permission: 'opportunities:read',
      query: z.object({ pipeline_id: uuid().optional(), owner_id: z.string().optional(), q: z.string().max(100).optional(), per_stage: z.coerce.number().int().min(1).max(200).optional() }),
    }, async (req, res) => {
      const ctx = getContext();
      const { pipeline_id: pipelineId, owner_id: ownerId, q, per_stage: perStage = 50 } = req.valid.query;
      const pipeline = pipelineId ? await Pipeline.findByPk(pipelineId) : await Pipeline.findOne({ where: { is_default: true } });
      if (!pipeline) throw E.notFound('Pipeline');
      const stages = await PipelineStage.findAll({ where: { pipeline_id: pipeline.id, is_active: true }, order: [['display_order', 'ASC']] });
      const base = [scopeWhere(def, ctx, req.scope), { pipeline_id: pipeline.id }];
      if (ownerId) base.push({ owner_id: ownerId === 'me' ? ctx.userId : ownerId });
      if (q) base.push({ name: { [Op.like]: `%${q.replace(/[%_\\]/g, '\\$&')}%` } });
      const totals = await Opportunity.findAll({
        where: { [Op.and]: base }, attributes: ['stage_id', [fn('COUNT', col('id')), 'count'], [fn('SUM', col('amount')), 'amount']], group: ['stage_id'], raw: true,
      });
      const byStage = new Map(totals.map((t) => [t.stage_id, t]));
      const columns = await Promise.all(stages.map(async (s) => {
        const rows = await Opportunity.findAll({ where: { [Op.and]: [...base, { stage_id: s.id }] }, order: [['updated_at', 'DESC']], limit: perStage, include: def.listInclude() });
        const t = byStage.get(s.id);
        return { stage: s, count: Number(t?.count || 0), total_amount: money.toString(money.toFixedBig(t?.amount || 0)), opportunities: await serializeMany(def, rows, ctx) };
      }));
      return ok(res, { pipeline, columns });
    });
    r.post('/:id/move', { summary: 'Move an opportunity to another stage (Kanban)', permission: 'opportunities:update', params: idParams, body: moveBody }, async (req, res) => {
      return ok(res, await service.update(def, req.valid.params.id, req.valid.body, req.scope));
    });
    r.get('/:id/stage-history', { summary: 'Stage transition history', permission: 'opportunities:read', params: idParams }, async (req, res) => {
      await service.findScoped(def, req.valid.params.id, req.scope);
      return ok(res, await OpportunityStageHistory.findAll({
        where: { opportunity_id: req.valid.params.id }, order: [['created_at', 'ASC']],
        include: [{ model: PipelineStage, as: 'toStage', attributes: ['id', 'name', 'category'] }, { model: PipelineStage, as: 'fromStage', attributes: ['id', 'name'] }],
      }));
    });
    r.get('/:id/products', { summary: 'Products / line items on the opportunity', permission: 'opportunities:read', params: idParams }, async (req, res) => {
      await service.findScoped(def, req.valid.params.id, req.scope);
      return ok(res, await OpportunityProduct.findAll({ where: { opportunity_id: req.valid.params.id }, include: [{ model: Product, as: 'product', attributes: ['id', 'sku', 'name', 'currency'] }] }));
    });
    r.put('/:id/products', { summary: 'Replace product line items (server-side totals)', permission: 'opportunities:update', params: idParams, body: productsBody }, async (req, res) => {
      const id = req.valid.params.id;
      const { items, update_amount: updateAmount = true } = req.valid.body;
      await sequelize.transaction(async (transaction) => {
        const opp = await service.findScoped(def, id, req.scope, { transaction, lock: true });
        const products = await Product.findAll({ where: { id: items.map((i) => i.product_id) }, transaction });
        const byId = new Map(products.map((p) => [p.id, p]));
        await OpportunityProduct.destroy({ where: { opportunity_id: id }, transaction });
        let sum = 0n;
        const rows = items.map((i) => {
          const p = byId.get(i.product_id);
          if (!p) throw E.validation([{ path: 'items.product_id', message: 'Product not found' }]);
          const qty = money.toFixedBig(i.quantity);
          const price = money.toFixedBig(i.unit_price ?? p.unit_price);
          const gross = money.mul(qty, price);
          const total = money.sub(gross, money.pct(gross, money.toFixedBig(i.discount_percent || 0)));
          sum += money.round(total, 2);
          return { opportunity_id: id, product_id: p.id, quantity: money.toString(qty, 4), unit_price: money.toString(price, 4), discount_percent: money.toString(money.toFixedBig(i.discount_percent || 0), 4), total: money.toString(total, 2) };
        });
        if (rows.length) await OpportunityProduct.bulkCreate(rows, { transaction });
        if (updateAmount) await service.updateRecord(def, opp.id, { amount: money.toString(sum, 2) }, req.scope, { transaction });
        await audit.record({ action: 'opportunity.products_updated', entityType: 'opportunity', entityId: id, metadata: { items: rows.length } }, { transaction });
      });
      return ok(res, await OpportunityProduct.findAll({ where: { opportunity_id: id } }));
    });
  },
});
