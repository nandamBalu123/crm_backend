'use strict';

const { sequelize, Lead, Contact, Account, Pipeline, PipelineStage, Campaign, CampaignMember, Activity, Communication, Attachment } = require('../../models');
const service = require('../../core/entity/service');
const registry = require('../../core/entity/registry');
const timeline = require('../timeline/timeline.service');
const audit = require('../audit/audit.service');
const events = require('../../events/domainEvents');
const cf = require('../customFields/customFields.service');
const { assertCan } = require('../../middleware/authorize');
const { getContext } = require('../../context/requestContext');
const E = require('../../errors/AppError');

/**
 * Converts a qualified lead into a contact, (optionally) an account and
 * (optionally) an opportunity in one transaction. Existing contacts/accounts
 * may be selected instead of creating new ones (de-duplication). Lead
 * activities, communications and files are re-linked to the new contact.
 * Custom-field values whose keys exist on the target entity are carried over.
 */
async function convert(leadId, input, scope) {
  const ctx = getContext();
  const leadDef = registry.lead;
  const result = await sequelize.transaction(async (transaction) => {
    const lead = await service.findScoped(leadDef, leadId, scope, { transaction, lock: true });
    if (lead.status === 'converted') throw E.conflict('This lead has already been converted', 'LEAD_CONVERTED');
    if (lead.status === 'unqualified') throw E.conflict('Unqualified leads cannot be converted. Change the status first.', 'LEAD_UNQUALIFIED');
    const ownerId = input.owner_id || lead.owner_id || ctx.userId;
    const leadCf = (await cf.loadValues('lead', [lead.id])).get(lead.id) || {};
    const carry = async (entityType) => {
      const keys = new Set((await cf.getDefinitions(entityType)).map((d) => d.key));
      return Object.fromEntries(Object.entries(leadCf).filter(([k]) => keys.has(k)));
    };

    // Account
    let account = null;
    if (input.account_id) {
      account = await Account.findByPk(input.account_id, { transaction });
      if (!account) throw E.validation([{ path: 'account_id', message: 'Account not found' }]);
    } else if (input.create_account !== false && (input.account_name || lead.company)) {
      assertCan(ctx, 'accounts:create');
      account = await service.createRecord(registry.account, {
        name: input.account_name || lead.company, website: lead.website, industry: lead.industry, employees: lead.employees,
        annual_revenue: lead.annual_revenue, phone: lead.phone, address_line1: lead.address_line1, address_line2: lead.address_line2,
        city: lead.city, state: lead.state, postal_code: lead.postal_code, country: lead.country, owner_id: ownerId,
        custom_fields: await carry('account'),
      }, { transaction, skipOwnerCheck: true });
    }

    // Contact
    let contact;
    if (input.contact_id) {
      contact = await Contact.findByPk(input.contact_id, { transaction });
      if (!contact) throw E.validation([{ path: 'contact_id', message: 'Contact not found' }]);
      if (account && !contact.account_id) await contact.update({ account_id: account.id }, { transaction });
    } else {
      assertCan(ctx, 'contacts:create');
      contact = await service.createRecord(registry.contact, {
        first_name: lead.first_name || lead.last_name, last_name: lead.first_name ? lead.last_name : '', email: lead.email, phone: lead.phone,
        title: lead.title, lead_source: lead.source, account_id: account?.id || null, email_opt_out: lead.email_opt_out,
        address_line1: lead.address_line1, address_line2: lead.address_line2, city: lead.city, state: lead.state, postal_code: lead.postal_code,
        country: lead.country, description: lead.description, owner_id: ownerId, custom_fields: await carry('contact'),
      }, { transaction, skipOwnerCheck: true });
      await contact.update({ converted_from_lead_id: lead.id }, { transaction });
    }

    // Opportunity
    let opportunity = null;
    if (input.create_opportunity) {
      assertCan(ctx, 'opportunities:create');
      const opp = input.opportunity || {};
      const pipeline = opp.pipeline_id ? await Pipeline.findByPk(opp.pipeline_id, { transaction }) : await Pipeline.findOne({ where: { is_default: true }, transaction });
      if (!pipeline) throw E.validation([{ path: 'opportunity.pipeline_id', message: 'Pipeline not found' }]);
      const stage = opp.stage_id
        ? await PipelineStage.findOne({ where: { id: opp.stage_id, pipeline_id: pipeline.id }, transaction })
        : await PipelineStage.findOne({ where: { pipeline_id: pipeline.id, category: 'open', is_active: true }, order: [['display_order', 'ASC']], transaction });
      if (!stage) throw E.validation([{ path: 'opportunity.stage_id', message: 'Stage not found in pipeline' }]);
      opportunity = await service.createRecord(registry.opportunity, {
        name: opp.name || `${lead.company || [lead.first_name, lead.last_name].filter(Boolean).join(' ')} deal`,
        amount: opp.amount ?? '0', currency: opp.currency || ctx.settings?.currency || 'USD', expected_close_date: opp.expected_close_date || null,
        pipeline_id: pipeline.id, stage_id: stage.id, account_id: account?.id || null, contact_id: contact.id, owner_id: ownerId,
        campaign_id: lead.campaign_id || null, custom_fields: await carry('opportunity'),
      }, { transaction, skipOwnerCheck: true });
      await opportunity.update({ lead_id: lead.id }, { transaction });
    }

    // Re-link lead history to the contact so the 360° view is complete.
    await Activity.update({ contact_id: contact.id, account_id: account?.id || null }, { where: { lead_id: lead.id, contact_id: null }, transaction });
    await Communication.update({ contact_id: contact.id }, { where: { lead_id: lead.id, contact_id: null }, transaction });
    await Attachment.update({ entity_type: 'contact', entity_id: contact.id }, { where: { entity_type: 'lead', entity_id: lead.id }, transaction });
    if (lead.campaign_id) {
      const member = await CampaignMember.findOne({ where: { campaign_id: lead.campaign_id, lead_id: lead.id }, transaction });
      if (member) await member.update({ status: 'converted' }, { transaction });
      await Campaign.findByPk(lead.campaign_id, { transaction }); // ensure campaign still in tenant
    }

    await lead.update({
      status: 'converted', converted_at: new Date(), converted_by_user_id: ctx.userId || null, converted_contact_id: contact.id,
      converted_account_id: account?.id || null, converted_opportunity_id: opportunity?.id || null,
    }, { transaction });

    const summary = `Converted to contact${account ? ', account' : ''}${opportunity ? ' and opportunity' : ''}`;
    await timeline.add('lead', lead.id, 'converted', summary, { contact_id: contact.id, account_id: account?.id, opportunity_id: opportunity?.id }, { transaction });
    await timeline.add('contact', contact.id, 'converted_from_lead', 'Created from lead conversion', { lead_id: lead.id }, { transaction });
    if (account) await timeline.add('account', account.id, 'converted_from_lead', 'Created from lead conversion', { lead_id: lead.id }, { transaction });
    if (opportunity) await timeline.add('opportunity', opportunity.id, 'converted_from_lead', 'Created from lead conversion', { lead_id: lead.id }, { transaction });
    await audit.record({ action: 'lead.converted', entityType: 'lead', entityId: lead.id, summary: `Lead "${leadDef.title(lead)}" ${summary.toLowerCase()}`, metadata: { contact_id: contact.id, account_id: account?.id || null, opportunity_id: opportunity?.id || null } }, { transaction });
    await events.publish('lead.converted', { entityType: 'lead', entityId: lead.id, data: { lead_id: lead.id, contact_id: contact.id, account_id: account?.id || null, opportunity_id: opportunity?.id || null } }, { transaction });
    return { lead_id: lead.id, contact_id: contact.id, account_id: account?.id || null, opportunity_id: opportunity?.id || null };
  });
  return result;
}

/** Duplicate detection for leads against open leads and existing contacts. */
async function duplicates({ email, phone, company, excludeId }) {
  const { Op } = require('sequelize');
  const or = [];
  if (email) or.push({ email });
  if (phone) or.push({ phone });
  if (company) or.push({ company: { [Op.like]: `${String(company).replace(/[%_\\]/g, '\\$&')}%` } });
  if (!or.length) return { leads: [], contacts: [] };
  const [leads, contacts] = await Promise.all([
    Lead.findAll({ where: { [Op.or]: or, ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}) }, limit: 20, attributes: ['id', 'first_name', 'last_name', 'email', 'phone', 'company', 'status', 'owner_id', 'created_at'] }),
    email || phone ? Contact.findAll({ where: { [Op.or]: or.filter((c) => !c.company) }, limit: 20, attributes: ['id', 'first_name', 'last_name', 'email', 'phone', 'account_id'] }) : [],
  ]);
  return { leads, contacts };
}

module.exports = { convert, duplicates };
