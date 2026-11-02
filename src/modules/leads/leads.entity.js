'use strict';

const { Lead, Campaign } = require('../../models');
const { z, customFields, ref, address, money, int, dateTime, optionalText, optionalEmail, optionalUrl, toUpdate } = require('../../core/entity/schemaHelpers');
const { requiredText } = require('../../utils/schemas');
const { ownerInclude } = require('../../core/entity/service');
const { scoreLead } = require('./scoring');
const E = require('../../errors/AppError');

const EDITABLE_STATUSES = ['new', 'contacted', 'nurturing', 'qualified', 'unqualified'];

const shape = {
  first_name: optionalText(80),
  last_name: requiredText(80),
  email: optionalEmail(),
  phone: optionalText(40),
  company: optionalText(200),
  title: optionalText(120),
  website: optionalUrl(),
  industry: optionalText(80),
  employees: int(),
  annual_revenue: money(),
  source: optionalText(60),
  status: z.enum(EDITABLE_STATUSES).optional(),
  rating: z.enum(['hot', 'warm', 'cold']).nullish(),
  ...address(),
  description: optionalText(20000),
  email_opt_out: z.boolean().optional(),
  owner_id: ref(),
  team_id: ref(),
  campaign_id: ref(),
  next_follow_up_at: dateTime(),
  custom_fields: customFields(),
};

function applyScore(target, settings) {
  target.score = scoreLead(target, settings?.preferences?.lead_scoring?.rules || []);
}

module.exports = {
  type: 'lead',
  module: 'leads',
  moduleKey: 'leads',
  route: 'leads',
  label: 'Lead',
  plural: 'Leads',
  model: Lead,
  ownerField: 'owner_id',
  timelineRelation: 'lead_id',
  title: (r) => [r.first_name, r.last_name].filter(Boolean).join(' ') + (r.company ? ` (${r.company})` : ''),
  searchFields: ['first_name', 'last_name', 'email', 'company', 'phone'],
  sortable: ['created_at', 'updated_at', 'last_name', 'company', 'score', 'status', 'next_follow_up_at', 'last_activity_at'],
  filterable: {
    status: 'enum', rating: 'enum', source: 'string', owner_id: 'uuid', team_id: 'uuid', campaign_id: 'uuid', company: 'string', email: 'string',
    industry: 'string', score: 'number', country: 'string', created_at: 'date', updated_at: 'date', next_follow_up_at: 'date', converted_at: 'date',
  },
  exportColumns: ['id', 'first_name', 'last_name', 'email', 'phone', 'company', 'title', 'industry', 'source', 'status', 'rating', 'score', 'owner_id', 'campaign_id', 'city', 'country', 'created_at', 'converted_at'],
  bulkUpdatable: ['status', 'rating', 'source', 'team_id', 'campaign_id'],
  sensitiveFields: ['email', 'phone', 'annual_revenue'],
  createSchema: z.strictObject(shape),
  updateSchema: toUpdate(shape),
  listInclude: () => [ownerInclude()],
  detailInclude: () => [ownerInclude(), { model: Campaign, as: 'campaign', attributes: ['id', 'name'] }],
  hooks: {
    async beforeCreate(data, { ctx }) {
      applyScore(data, ctx.settings);
    },
    async beforeUpdate(record, data, { ctx }) {
      if (record.status === 'converted') throw E.conflict('Converted leads cannot be edited', 'LEAD_CONVERTED');
      data.score = scoreLead({ ...record.get({ plain: true }), ...data }, ctx.settings?.preferences?.lead_scoring?.rules || []);
    },
  },
};
