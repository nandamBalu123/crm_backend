'use strict';

const { Contact, Account, Consent } = require('../../models');
const { z, customFields, ref, address, optionalText, optionalEmail, optionalUrl, toUpdate } = require('../../core/entity/schemaHelpers');
const { requiredText } = require('../../utils/schemas');
const { ownerInclude } = require('../../core/entity/service');

const shape = {
  first_name: requiredText(80),
  last_name: optionalText(80).transform((v) => v ?? ''),
  email: optionalEmail(),
  phone: optionalText(40),
  mobile: optionalText(40),
  title: optionalText(120),
  department: optionalText(120),
  lead_source: optionalText(60),
  account_id: ref(),
  ...address(),
  linkedin_url: optionalUrl(),
  description: optionalText(20000),
  email_opt_out: z.boolean().optional(),
  sms_opt_out: z.boolean().optional(),
  do_not_call: z.boolean().optional(),
  owner_id: ref(),
  team_id: ref(),
  custom_fields: customFields(),
};

const accountInclude = () => ({ model: Account, as: 'account', attributes: ['id', 'name', 'domain', 'type'] });

async function recordOptOutConsent(record, before, { transaction }) {
  for (const [field, channel] of [['email_opt_out', 'email'], ['sms_opt_out', 'sms']]) {
    if (before && before[field] === record[field]) continue;
    if (!before && !record[field]) continue;
    await Consent.create({
      subject_type: 'contact', subject_id: record.id, email: record.email, channel, status: record[field] ? 'revoked' : 'granted',
      source: 'manual', recorded_by_user_id: require('../../context/requestContext').getContext()?.userId || null,
    }, { transaction });
  }
}

module.exports = {
  type: 'contact',
  module: 'contacts',
  moduleKey: 'contacts',
  route: 'contacts',
  label: 'Contact',
  plural: 'Contacts',
  model: Contact,
  ownerField: 'owner_id',
  timelineRelation: 'contact_id',
  title: (r) => [r.first_name, r.last_name].filter(Boolean).join(' '),
  searchFields: ['first_name', 'last_name', 'email', 'phone', 'mobile', 'title'],
  sortable: ['last_name', 'first_name', 'email', 'created_at', 'updated_at', 'last_activity_at', 'title'],
  filterable: {
    first_name: 'string', last_name: 'string', email: 'string', title: 'string', department: 'string', lead_source: 'string', account_id: 'uuid',
    owner_id: 'uuid', team_id: 'uuid', city: 'string', country: 'string', email_opt_out: 'bool', created_at: 'date', updated_at: 'date', last_activity_at: 'date',
  },
  exportColumns: ['id', 'first_name', 'last_name', 'email', 'phone', 'mobile', 'title', 'department', 'account_id', 'lead_source', 'city', 'country', 'email_opt_out', 'owner_id', 'created_at'],
  bulkUpdatable: ['lead_source', 'team_id', 'email_opt_out', 'account_id'],
  sensitiveFields: ['email', 'phone', 'mobile', 'description'],
  createSchema: z.strictObject(shape),
  updateSchema: toUpdate(shape),
  listInclude: () => [ownerInclude(), accountInclude()],
  detailInclude: () => [ownerInclude(), accountInclude()],
  hooks: {
    async afterCreate(record, opts) {
      if (record.email_opt_out || record.sms_opt_out) await recordOptOutConsent(record, null, opts);
    },
    async afterUpdate(record, changes, opts) {
      if (changes.email_opt_out || changes.sms_opt_out) await recordOptOutConsent(record, opts.before, opts);
    },
  },
};
