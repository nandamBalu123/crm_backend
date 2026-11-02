'use strict';

const { Ticket, SlaPolicy, Contact, Account, TicketCategory } = require('../../models');
const { z, customFields, ref, optionalText, toUpdate } = require('../../core/entity/schemaHelpers');
const { requiredText } = require('../../utils/schemas');
const { ownerInclude } = require('../../core/entity/service');
const { nextSequence } = require('../../utils/sequence');
const timeline = require('../timeline/timeline.service');
const E = require('../../errors/AppError');

const shape = {
  subject: requiredText(255),
  description: optionalText(50000),
  status: z.enum(['new', 'open', 'pending', 'on_hold', 'resolved', 'closed']).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  channel: z.enum(['email', 'phone', 'web', 'chat', 'other']).optional(),
  category_id: ref(),
  contact_id: ref(),
  account_id: ref(),
  owner_id: ref(),
  team_id: ref(),
  custom_fields: customFields(),
};

async function applySla(data, transaction, from = new Date()) {
  const policy = await SlaPolicy.findOne({ where: { priority: data.priority || 'normal', is_active: true }, transaction });
  data.sla_policy_id = policy?.id || null;
  data.first_response_due_at = policy ? new Date(from.getTime() + policy.first_response_minutes * 60_000) : null;
  data.resolution_due_at = policy ? new Date(from.getTime() + policy.resolution_minutes * 60_000) : null;
}

module.exports = {
  type: 'ticket',
  module: 'tickets',
  moduleKey: 'tickets',
  route: 'tickets',
  label: 'Ticket',
  plural: 'Tickets',
  model: Ticket,
  ownerField: 'owner_id',
  timelineRelation: 'ticket_id',
  title: (r) => `#${r.number} ${r.subject}`,
  searchFields: ['subject'],
  sortable: ['number', 'created_at', 'updated_at', 'priority', 'status', 'resolution_due_at', 'first_response_due_at'],
  filterable: {
    status: 'enum', priority: 'enum', channel: 'enum', category_id: 'uuid', contact_id: 'uuid', account_id: 'uuid', owner_id: 'uuid', team_id: 'uuid',
    sla_breached: 'bool', created_at: 'date', resolution_due_at: 'date', number: 'number',
  },
  exportColumns: ['id', 'number', 'subject', 'status', 'priority', 'channel', 'category_id', 'contact_id', 'account_id', 'owner_id', 'first_response_due_at', 'first_responded_at', 'resolution_due_at', 'resolved_at', 'sla_breached', 'created_at'],
  bulkUpdatable: ['status', 'priority', 'category_id', 'team_id'],
  createSchema: z.strictObject(shape),
  updateSchema: toUpdate(shape),
  listInclude: () => [ownerInclude(), { model: Contact, as: 'contact', attributes: ['id', 'first_name', 'last_name', 'email'] }, { model: TicketCategory, as: 'category', attributes: ['id', 'name'] }],
  detailInclude: () => [
    ownerInclude(),
    { model: Contact, as: 'contact', attributes: ['id', 'first_name', 'last_name', 'email', 'phone'] },
    { model: Account, as: 'account', attributes: ['id', 'name'] },
    { model: TicketCategory, as: 'category', attributes: ['id', 'name'] },
    { model: SlaPolicy, as: 'slaPolicy', attributes: ['id', 'name', 'first_response_minutes', 'resolution_minutes'] },
  ],
  decorate(plain) {
    const now = Date.now();
    plain.sla_status = plain.resolved_at || plain.closed_at ? (plain.sla_breached ? 'breached' : 'met')
      : plain.resolution_due_at && new Date(plain.resolution_due_at).getTime() < now ? 'breached'
        : plain.resolution_due_at && new Date(plain.resolution_due_at).getTime() - now < 3600_000 ? 'at_risk' : 'on_track';
  },
  hooks: {
    async beforeCreate(data, { transaction }) {
      data.number = await nextSequence('ticket', { transaction });
      if (data.contact_id && !data.account_id) {
        const c = await Contact.findByPk(data.contact_id, { attributes: ['account_id'], transaction });
        if (!c) throw E.validation([{ path: 'contact_id', message: 'Contact not found' }]);
        data.account_id = c.account_id;
      }
      if (data.category_id && !data.team_id) {
        const cat = await TicketCategory.findByPk(data.category_id, { attributes: ['default_team_id'], transaction });
        if (!cat) throw E.validation([{ path: 'category_id', message: 'Category not found' }]);
        data.team_id = cat.default_team_id;
      }
      await applySla(data, transaction);
    },
    async beforeUpdate(record, data, { transaction }) {
      if (data.priority && data.priority !== record.priority && !record.resolved_at) {
        const tmp = { priority: data.priority };
        await applySla(tmp, transaction, new Date(record.created_at));
        Object.assign(data, tmp);
      }
      if (data.status === 'resolved' && !record.resolved_at) data.resolved_at = new Date();
      if (data.status === 'closed' && !record.closed_at) {
        data.closed_at = new Date();
        if (!record.resolved_at) data.resolved_at = new Date();
      }
      if (data.status && ['new', 'open', 'pending', 'on_hold'].includes(data.status) && record.resolved_at) {
        data.resolved_at = null;
        data.closed_at = null;
      }
      const resolvedAt = data.resolved_at ?? record.resolved_at;
      if (resolvedAt && record.resolution_due_at && new Date(resolvedAt) > new Date(record.resolution_due_at)) data.sla_breached = true;
    },
    async afterUpdate(record, changes, { transaction }) {
      if (changes.status) await timeline.add('ticket', record.id, 'status_changed', `Status changed to ${record.status.replace('_', ' ')}`, changes.status, { transaction });
    },
  },
};
