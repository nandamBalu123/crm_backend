'use strict';

const { Account, Contact, Opportunity, Ticket, Quote } = require('../../models');
const { z, customFields, ref, address, money, int, optionalText, optionalEmail, optionalUrl, toUpdate } = require('../../core/entity/schemaHelpers');
const { requiredText } = require('../../utils/schemas');
const E = require('../../errors/AppError');

const shape = {
  name: requiredText(200),
  domain: optionalText(253),
  website: optionalUrl(),
  industry: optionalText(80),
  type: z.enum(['prospect', 'customer', 'partner', 'vendor', 'other']).optional(),
  employees: int(),
  annual_revenue: money(),
  phone: optionalText(40),
  email: optionalEmail(),
  ...address(),
  description: optionalText(20000),
  parent_account_id: ref(),
  owner_id: ref(),
  team_id: ref(),
  custom_fields: customFields(),
};

async function assertNoCycle(accountId, parentId, transaction) {
  let current = parentId;
  for (let depth = 0; current && depth < 20; depth += 1) {
    if (current === accountId) throw E.validation([{ path: 'parent_account_id', message: 'An account cannot be its own ancestor' }]);
    const parent = await Account.findByPk(current, { attributes: ['id', 'parent_account_id'], transaction });
    if (!parent) throw E.validation([{ path: 'parent_account_id', message: 'Parent account not found' }]);
    current = parent.parent_account_id;
  }
}

function normaliseDomain(data) {
  if (data.website && !data.domain) {
    try {
      data.domain = new URL(data.website).hostname.replace(/^www\./, '');
    } catch {
      /* website already validated as URL; ignore */
    }
  }
  if (data.domain) data.domain = data.domain.toLowerCase();
}

module.exports = {
  type: 'account',
  module: 'accounts',
  moduleKey: 'accounts',
  route: 'accounts',
  label: 'Account',
  plural: 'Accounts',
  model: Account,
  ownerField: 'owner_id',
  timelineRelation: 'account_id',
  title: (r) => r.name,
  searchFields: ['name', 'domain', 'email', 'phone'],
  sortable: ['name', 'created_at', 'updated_at', 'annual_revenue', 'employees', 'last_activity_at', 'type', 'industry'],
  filterable: {
    name: 'string', type: 'enum', industry: 'string', owner_id: 'uuid', team_id: 'uuid', parent_account_id: 'uuid', city: 'string',
    country: 'string', annual_revenue: 'number', employees: 'number', created_at: 'date', updated_at: 'date', last_activity_at: 'date',
  },
  exportColumns: ['id', 'name', 'domain', 'website', 'industry', 'type', 'employees', 'annual_revenue', 'phone', 'email', 'address_line1', 'city', 'state', 'postal_code', 'country', 'owner_id', 'created_at'],
  bulkUpdatable: ['type', 'industry', 'team_id'],
  sensitiveFields: ['annual_revenue', 'phone', 'email'],
  createSchema: z.strictObject(shape),
  updateSchema: toUpdate(shape),
  hooks: {
    async beforeCreate(data, { transaction }) {
      normaliseDomain(data);
      if (data.parent_account_id) await assertNoCycle(null, data.parent_account_id, transaction);
    },
    async beforeUpdate(record, data, { transaction }) {
      normaliseDomain(data);
      if (data.parent_account_id) await assertNoCycle(record.id, data.parent_account_id, transaction);
    },
    async beforeDestroy(record, { transaction }) {
      const [contacts, opps] = await Promise.all([
        Contact.count({ where: { account_id: record.id }, transaction }),
        Opportunity.count({ where: { account_id: record.id, status: 'open' }, transaction }),
      ]);
      if (contacts || opps) throw E.conflict(`This account still has ${contacts} contact(s) and ${opps} open deal(s). Reassign or delete them first.`, 'HAS_DEPENDENTS');
    },
  },
  related: { Contact, Opportunity, Ticket, Quote },
};
