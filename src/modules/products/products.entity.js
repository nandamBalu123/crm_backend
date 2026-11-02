'use strict';

const { Product, ProductCategory } = require('../../models');
const { z, customFields, ref, optionalText, toUpdate } = require('../../core/entity/schemaHelpers');
const { requiredText, decimalString } = require('../../utils/schemas');

const shape = {
  sku: requiredText(64),
  name: requiredText(200),
  description: optionalText(20000),
  category_id: ref(),
  unit_price: decimalString({ min: 0 }),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  tax_rate: decimalString({ min: 0, max: 100 }).optional(),
  unit: optionalText(30),
  max_discount_percent: decimalString({ min: 0, max: 100 }).nullish(),
  is_active: z.boolean().optional(),
  custom_fields: customFields(),
};

module.exports = {
  type: 'product',
  module: 'products',
  moduleKey: 'products',
  route: 'products',
  label: 'Product',
  plural: 'Products',
  model: Product,
  ownerField: null,
  title: (r) => `${r.name} (${r.sku})`,
  searchFields: ['name', 'sku', 'description'],
  sortable: ['name', 'sku', 'unit_price', 'created_at', 'updated_at'],
  filterable: { is_active: 'bool', category_id: 'uuid', currency: 'string', unit_price: 'number', created_at: 'date' },
  defaultSort: 'name',
  exportColumns: ['id', 'sku', 'name', 'category_id', 'unit_price', 'currency', 'tax_rate', 'unit', 'is_active', 'created_at'],
  bulkUpdatable: ['is_active', 'category_id', 'tax_rate'],
  createSchema: z.strictObject(shape),
  updateSchema: toUpdate(shape),
  listInclude: () => [{ model: ProductCategory, as: 'category', attributes: ['id', 'name'] }],
  detailInclude: () => [{ model: ProductCategory, as: 'category', attributes: ['id', 'name'] }],
  hooks: {
    async beforeCreate(data, { ctx }) {
      if (!data.currency) data.currency = ctx.settings?.currency || 'USD';
    },
  },
};
