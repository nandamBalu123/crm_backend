'use strict';

const { entityRouter } = require('../../core/entity/routes');
const { ProductCategory, DiscountRule } = require('../../models');
const { z, idParams, uuid, requiredText, trimmed, decimalString } = require('../../utils/schemas');
const audit = require('../audit/audit.service');
const { ok, created, noContent } = require('../../utils/http');
const E = require('../../errors/AppError');
const def = require('./products.entity');

const ruleBody = z.strictObject({
  name: requiredText(120), product_id: uuid().nullish(), category_id: uuid().nullish(), min_quantity: decimalString({ min: 0 }).optional(),
  discount_percent: decimalString({ min: 0, max: 100 }), starts_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), ends_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), is_active: z.boolean().optional(),
});

module.exports = entityRouter(def, {
  extend(r) {
    r.get('/categories', { summary: 'Product categories', permission: 'products:read' }, async (_req, res) => ok(res, await ProductCategory.findAll({ order: [['name', 'ASC']] })));
    r.post('/categories', { summary: 'Create a product category', permission: 'products:create', body: z.strictObject({ name: requiredText(120), description: trimmed(500).nullish(), parent_id: uuid().nullish() }) }, async (req, res) => {
      const cat = await ProductCategory.create(req.valid.body);
      await audit.record({ action: 'product_category.created', entityType: 'product_category', entityId: cat.id, summary: `Category ${cat.name} created` });
      return created(res, cat);
    });
    r.delete('/categories/:id', { summary: 'Delete a product category', permission: 'products:delete', params: idParams }, async (req, res) => {
      const cat = await ProductCategory.findByPk(req.valid.params.id);
      if (!cat) throw E.notFound('Category');
      await cat.destroy();
      return noContent(res);
    });
    r.get('/discount-rules', { summary: 'Volume / product discount rules', permission: 'products:read' }, async (_req, res) => ok(res, await DiscountRule.findAll({ order: [['created_at', 'DESC']] })));
    r.post('/discount-rules', { summary: 'Create a discount rule', permission: 'products:update', body: ruleBody }, async (req, res) => {
      const rule = await DiscountRule.create(req.valid.body);
      await audit.record({ action: 'discount_rule.created', entityType: 'discount_rule', entityId: rule.id, summary: `Discount rule ${rule.name} created` });
      return created(res, rule);
    });
    r.delete('/discount-rules/:id', { summary: 'Delete a discount rule', permission: 'products:update', params: idParams }, async (req, res) => {
      const n = await DiscountRule.destroy({ where: { id: req.valid.params.id } });
      if (!n) throw E.notFound('Discount rule');
      return noContent(res);
    });
  },
});
