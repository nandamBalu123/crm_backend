'use strict';

const { Campaign } = require('../../models');
const { z, customFields, ref, money, date, optionalText, toUpdate } = require('../../core/entity/schemaHelpers');
const { requiredText } = require('../../utils/schemas');
const { ownerInclude } = require('../../core/entity/service');

const shape = {
  name: requiredText(200),
  type: z.enum(['email', 'event', 'webinar', 'advertising', 'social', 'referral', 'other']).optional(),
  status: z.enum(['planned', 'active', 'completed', 'aborted']).optional(),
  source: optionalText(80),
  start_date: date(),
  end_date: date(),
  budget: money(),
  actual_cost: money(),
  expected_revenue: money(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  description: optionalText(20000),
  owner_id: ref(),
  custom_fields: customFields(),
};

module.exports = {
  type: 'campaign',
  module: 'campaigns',
  moduleKey: 'campaigns',
  route: 'campaigns',
  label: 'Campaign',
  plural: 'Campaigns',
  model: Campaign,
  ownerField: 'owner_id',
  title: (r) => r.name,
  searchFields: ['name', 'source'],
  sortable: ['name', 'start_date', 'end_date', 'created_at', 'budget', 'status'],
  filterable: { status: 'enum', type: 'enum', owner_id: 'uuid', start_date: 'date', end_date: 'date', created_at: 'date' },
  exportColumns: ['id', 'name', 'type', 'status', 'source', 'start_date', 'end_date', 'budget', 'actual_cost', 'expected_revenue', 'currency', 'owner_id', 'created_at'],
  bulkUpdatable: ['status'],
  createSchema: z.strictObject(shape).refine((v) => !v.start_date || !v.end_date || v.end_date >= v.start_date, { message: 'End date must be after start date', path: ['end_date'] }),
  updateSchema: toUpdate(shape),
  listInclude: () => [ownerInclude()],
  hooks: {
    async beforeCreate(data, { ctx }) {
      if (!data.currency) data.currency = ctx.settings?.currency || 'USD';
    },
  },
};
