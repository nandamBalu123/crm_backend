'use strict';

const { Quote, QuoteLineItem, Account, Contact, Opportunity } = require('../../models');
const { z, customFields, ref, date, optionalText } = require('../../core/entity/schemaHelpers');
const { requiredText, decimalString, uuid } = require('../../utils/schemas');
const { ownerInclude } = require('../../core/entity/service');

const lineItem = z.strictObject({
  product_id: uuid().nullish(),
  name: z.string().trim().max(200).optional(),
  description: optionalText(5000),
  quantity: decimalString({ min: 0.0001 }),
  unit_price: decimalString({ min: 0 }).optional(),
  discount_percent: decimalString({ min: 0, max: 100 }).nullish(),
  tax_rate: decimalString({ min: 0, max: 100 }).optional(),
});

const shape = {
  title: requiredText(200),
  opportunity_id: ref(),
  account_id: ref(),
  contact_id: ref(),
  template_id: ref(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  valid_until: date(),
  terms: optionalText(20000),
  notes: optionalText(20000),
  owner_id: ref(),
  line_items: z.array(lineItem).max(500).optional(),
  custom_fields: customFields(),
};

module.exports = {
  type: 'quote',
  module: 'quotes',
  moduleKey: 'quotes',
  route: 'quotes',
  label: 'Quote',
  plural: 'Quotes',
  model: Quote,
  ownerField: 'owner_id',
  timelineRelation: null,
  title: (r) => `Q-${r.number}${r.revision > 1 ? ` rev ${r.revision}` : ''} ${r.title}`,
  searchFields: ['title'],
  sortable: ['number', 'created_at', 'updated_at', 'total', 'valid_until', 'status'],
  filterable: { status: 'enum', opportunity_id: 'uuid', account_id: 'uuid', contact_id: 'uuid', owner_id: 'uuid', total: 'number', valid_until: 'date', created_at: 'date', number: 'number' },
  exportColumns: ['id', 'number', 'revision', 'title', 'status', 'account_id', 'opportunity_id', 'currency', 'subtotal', 'discount_total', 'tax_total', 'total', 'valid_until', 'owner_id', 'created_at'],
  sensitiveFields: ['total', 'discount_total'],
  createSchema: z.strictObject(shape),
  updateSchema: z.strictObject({ ...Object.fromEntries(Object.entries(shape).map(([k, s]) => [k, s.optional()])), version: z.number().int().optional() }),
  listInclude: () => [ownerInclude(), { model: Account, as: 'account', attributes: ['id', 'name'] }],
  detailInclude: () => [
    ownerInclude(),
    { model: Account, as: 'account', attributes: ['id', 'name'] },
    { model: Contact, as: 'contact', attributes: ['id', 'first_name', 'last_name', 'email'] },
    { model: Opportunity, as: 'opportunity', attributes: ['id', 'name'] },
    { model: QuoteLineItem, as: 'lineItems', separate: true, order: [['position', 'ASC']] },
  ],
};
// Overrides are attached by quotes.service to avoid a require cycle.
require('./quotes.service').attach(module.exports);
