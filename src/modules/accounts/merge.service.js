'use strict';

const { Op } = require('sequelize');
const models = require('../../models');
const { sequelize } = models;
const audit = require('../audit/audit.service');
const timeline = require('../timeline/timeline.service');
const cf = require('../customFields/customFields.service');
const E = require('../../errors/AppError');

/**
 * Controlled merge of duplicate contacts or accounts into a primary record.
 * Child references are re-pointed, empty primary fields are filled from the
 * duplicates, custom-field values missing on the primary are copied, and the
 * duplicates are soft-deleted. Everything is one transaction and audited.
 */
const CONFIG = {
  contact: {
    model: () => models.Contact,
    refs: [['Activity', 'contact_id'], ['Opportunity', 'contact_id'], ['Ticket', 'contact_id'], ['Quote', 'contact_id'], ['Communication', 'contact_id']],
    fillable: ['email', 'phone', 'mobile', 'title', 'department', 'account_id', 'lead_source', 'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'country', 'linkedin_url', 'description'],
    member: 'contact_id',
  },
  account: {
    model: () => models.Account,
    refs: [['Contact', 'account_id'], ['Activity', 'account_id'], ['Opportunity', 'account_id'], ['Ticket', 'account_id'], ['Quote', 'account_id'], ['Communication', 'account_id'], ['Account', 'parent_account_id']],
    fillable: ['domain', 'website', 'industry', 'employees', 'annual_revenue', 'phone', 'email', 'address_line1', 'address_line2', 'city', 'state', 'postal_code', 'country', 'description', 'parent_account_id'],
  },
};

async function merge(entityType, { primary_id: primaryId, duplicate_ids: duplicateIds }, findScoped, def) {
  const cfg = CONFIG[entityType];
  if (duplicateIds.includes(primaryId)) throw E.validation([{ path: 'duplicate_ids', message: 'Primary record cannot also be a duplicate' }]);
  return sequelize.transaction(async (transaction) => {
    const primary = await findScoped(def, primaryId, 'all', { transaction, lock: true });
    const dups = [];
    for (const id of duplicateIds) dups.push(await findScoped(def, id, 'all', { transaction, lock: true }));

    const fills = {};
    for (const field of cfg.fillable) {
      if (primary[field] !== null && primary[field] !== '' && primary[field] !== undefined) continue;
      const source = dups.find((d) => d[field] !== null && d[field] !== '' && d[field] !== undefined && d[field] !== primary.id);
      if (source) fills[field] = source[field];
    }
    if (Object.keys(fills).length) await primary.update(fills, { transaction });

    const ids = dups.map((d) => d.id);
    for (const [modelName, column] of cfg.refs) {
      await models[modelName].update({ [column]: primaryId }, { where: { [column]: ids }, transaction });
    }
    await models.Attachment.update({ entity_id: primaryId }, { where: { entity_type: entityType, entity_id: ids }, transaction });
    if (cfg.member) {
      const primaryCampaigns = new Set((await models.CampaignMember.findAll({ where: { contact_id: primaryId }, attributes: ['campaign_id'], transaction })).map((m) => m.campaign_id));
      const dupMembers = await models.CampaignMember.findAll({ where: { contact_id: ids }, transaction });
      for (const m of dupMembers) {
        if (primaryCampaigns.has(m.campaign_id)) await m.destroy({ transaction });
        else {
          await m.update({ contact_id: primaryId }, { transaction });
          primaryCampaigns.add(m.campaign_id);
        }
      }
    }
    const primaryValues = (await cf.loadValues(entityType, [primaryId])).get(primaryId) || {};
    const dupValues = await cf.loadValues(entityType, ids);
    const copy = {};
    for (const id of ids) for (const [k, v] of Object.entries(dupValues.get(id) || {})) if (primaryValues[k] === undefined && copy[k] === undefined) copy[k] = v;
    if (Object.keys(copy).length) await cf.saveValues(entityType, primaryId, copy, { transaction });

    for (const d of dups) {
      await cf.deleteValuesFor(d.id, { transaction });
      await d.destroy({ transaction });
      await timeline.add(entityType, primaryId, 'merged', `Merged duplicate "${def.title(d)}"`, { duplicate_id: d.id }, { transaction });
    }
    await audit.record({ action: `${entityType}.merged`, entityType, entityId: primaryId, summary: `Merged ${dups.length} duplicate(s) into "${def.title(primary)}"`, metadata: { duplicate_ids: ids, filled_fields: Object.keys(fills) } }, { transaction });
    return primary;
  });
}

/** Candidate duplicates by exact email/phone/domain or similar name. */
async function findDuplicates(entityType, { email, phone, name, domain, excludeId }) {
  const or = [];
  if (email) or.push({ email: String(email).toLowerCase() });
  if (phone) or.push({ phone });
  if (domain) or.push({ domain: String(domain).toLowerCase() });
  if (name) {
    if (entityType === 'account') or.push({ name: { [Op.like]: `${String(name).replace(/[%_\\]/g, '\\$&')}%` } });
  }
  if (!or.length) return [];
  const where = { [Op.or]: or, ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}) };
  return CONFIG[entityType].model().findAll({ where, limit: 20, order: [['created_at', 'ASC']] });
}

module.exports = { merge, findDuplicates };
