'use strict';

const { Op } = require('sequelize');
const { Activity, Lead, Contact, Account, Opportunity, Ticket } = require('../../models');
const { z, customFields, ref, int, dateTime, optionalText, toUpdate } = require('../../core/entity/schemaHelpers');
const { requiredText } = require('../../utils/schemas');
const { ownerInclude } = require('../../core/entity/service');
const E = require('../../errors/AppError');

const recurrence = z.strictObject({
  freq: z.enum(['daily', 'weekly', 'monthly']),
  interval: z.coerce.number().int().min(1).max(30).default(1),
  count: z.coerce.number().int().min(1).max(365).optional(),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).nullish();

const shape = {
  type: z.enum(['task', 'call', 'meeting', 'note', 'email']),
  subject: requiredText(255),
  description: optionalText(20000),
  status: z.enum(['open', 'completed', 'canceled']).optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  due_at: dateTime(),
  start_at: dateTime(),
  end_at: dateTime(),
  all_day: z.boolean().optional(),
  location: optionalText(255),
  call_direction: z.enum(['inbound', 'outbound']).nullish(),
  call_outcome: optionalText(80),
  duration_minutes: int(0, 100000),
  reminder_at: dateTime(),
  recurrence,
  owner_id: ref(),
  lead_id: ref(),
  contact_id: ref(),
  account_id: ref(),
  opportunity_id: ref(),
  ticket_id: ref(),
  custom_fields: customFields(),
};

const RELATED = [['lead_id', Lead], ['contact_id', Contact], ['account_id', Account], ['opportunity_id', Opportunity], ['ticket_id', Ticket]];

async function touchRelated(record, transaction) {
  const now = new Date();
  for (const [field, Model] of RELATED) {
    if (record[field]) await Model.update({ last_activity_at: now }, { where: { id: record[field] }, transaction, silent: true, hooks: true });
  }
}

function checkTimes(data, current = {}) {
  const start = data.start_at ?? current.start_at;
  const end = data.end_at ?? current.end_at;
  if (start && end && new Date(end) < new Date(start)) throw E.validation([{ path: 'end_at', message: 'End must be after start' }]);
  if ((data.type ?? current.type) === 'meeting' && !start && !(data.due_at ?? current.due_at)) throw E.validation([{ path: 'start_at', message: 'Meetings need a start time' }]);
}

module.exports = {
  type: 'activity',
  module: 'activities',
  moduleKey: 'activities',
  route: 'activities',
  label: 'Activity',
  plural: 'Activities',
  model: Activity,
  ownerField: 'owner_id',
  title: (r) => r.subject,
  searchFields: ['subject', 'location'],
  sortable: ['due_at', 'start_at', 'created_at', 'updated_at', 'priority', 'status', 'completed_at'],
  filterable: {
    type: 'enum', status: 'enum', priority: 'enum', owner_id: 'uuid', lead_id: 'uuid', contact_id: 'uuid', account_id: 'uuid',
    opportunity_id: 'uuid', ticket_id: 'uuid', due_at: 'date', start_at: 'date', created_at: 'date', completed_at: 'date',
  },
  defaultSort: 'due_at',
  exportColumns: ['id', 'type', 'subject', 'status', 'priority', 'due_at', 'start_at', 'end_at', 'owner_id', 'lead_id', 'contact_id', 'account_id', 'opportunity_id', 'completed_at', 'created_at'],
  bulkUpdatable: ['status', 'priority', 'due_at'],
  createSchema: z.strictObject(shape),
  updateSchema: toUpdate(shape),
  // "own" scope covers activities assigned to OR created by the caller.
  scopeWhere(ctx, scope) {
    const owners = scope === 'team' ? ctx.teamUserIds || [ctx.userId] : [ctx.userId];
    return { [Op.or]: [{ owner_id: { [Op.in]: owners } }, { created_by_user_id: { [Op.in]: owners } }] };
  },
  listInclude: () => [
    ownerInclude(),
    { model: Contact, as: 'contact', attributes: ['id', 'first_name', 'last_name'] },
    { model: Account, as: 'account', attributes: ['id', 'name'] },
    { model: Opportunity, as: 'opportunity', attributes: ['id', 'name'] },
    { model: Lead, as: 'lead', attributes: ['id', 'first_name', 'last_name', 'company'] },
  ],
  decorate(plain) {
    plain.is_overdue = plain.status === 'open' && !!plain.due_at && new Date(plain.due_at) < new Date();
  },
  hooks: {
    async beforeCreate(data, { ctx, transaction }) {
      data.created_by_user_id = ctx.userId || null;
      if (data.type === 'note') data.status = 'completed';
      checkTimes(data);
      if (data.contact_id && !data.account_id) {
        const contact = await Contact.findByPk(data.contact_id, { attributes: ['account_id'], transaction });
        if (!contact) throw E.validation([{ path: 'contact_id', message: 'Contact not found' }]);
        data.account_id = contact.account_id;
      }
      if (data.opportunity_id && !data.account_id) {
        const opp = await Opportunity.findByPk(data.opportunity_id, { attributes: ['account_id'], transaction });
        if (!opp) throw E.validation([{ path: 'opportunity_id', message: 'Opportunity not found' }]);
        data.account_id = opp.account_id;
      }
      if (data.status === 'completed') data.completed_at = new Date();
    },
    async afterCreate(record, { transaction }) {
      await touchRelated(record, transaction);
    },
    async beforeUpdate(record, data, { ctx }) {
      checkTimes(data, record);
      if (data.status === 'completed' && record.status !== 'completed') {
        data.completed_at = new Date();
        data.completed_by_user_id = ctx.userId || null;
      }
      if (data.status && data.status !== 'completed') data.completed_at = null;
    },
    async afterUpdate(record, changes, { transaction }) {
      await touchRelated(record, transaction);
      if (changes.status?.to === 'completed' && record.recurrence) {
        const { scheduleNext } = require('./recurrence');
        await scheduleNext(record, transaction);
      }
    },
  },
};
