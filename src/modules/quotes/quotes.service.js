'use strict';

const { Op } = require('sequelize');
const { sequelize, Quote, QuoteLineItem, Approval, Opportunity, Membership, RolePermission, Permission, MembershipRole } = require('../../models');
const service = require('../../core/entity/service');
const { calculate } = require('./calc');
const { nextSequence } = require('../../utils/sequence');
const { uuidv7 } = require('../../utils/ids');
const timeline = require('../timeline/timeline.service');
const audit = require('../audit/audit.service');
const events = require('../../events/domainEvents');
const notifications = require('../notifications/notifications.service');
const money = require('../../utils/money');
const { getContext } = require('../../context/requestContext');
const E = require('../../errors/AppError');

const EDITABLE = ['draft', 'rejected'];
let def;

async function writeLines(quote, lineInput, transaction) {
  const { lines, totals, exceedsProductMax } = await calculate(lineInput, { transaction });
  await QuoteLineItem.destroy({ where: { quote_id: quote.id }, transaction });
  if (lines.length) await QuoteLineItem.bulkCreate(lines.map((l) => ({ ...l, quote_id: quote.id })), { transaction });
  await quote.update({ ...totals }, { transaction });
  return { exceedsProductMax };
}

async function create(input) {
  const ctx = getContext();
  const { line_items: lineItems = [], ...data } = input;
  const id = await sequelize.transaction(async (transaction) => {
    if (data.opportunity_id && !data.account_id) {
      const opp = await Opportunity.findByPk(data.opportunity_id, { attributes: ['account_id', 'contact_id', 'currency'], transaction });
      if (!opp) throw E.validation([{ path: 'opportunity_id', message: 'Opportunity not found' }]);
      data.account_id = opp.account_id;
      data.contact_id = data.contact_id || opp.contact_id;
      data.currency = data.currency || opp.currency;
    }
    const validity = Number(ctx.settings?.preferences?.quote_validity_days) || 30;
    const record = await service.createRecord(def, {
      ...data,
      number: await nextSequence('quote', { transaction }),
      revision: 1,
      quote_group_id: uuidv7(),
      currency: data.currency || ctx.settings?.currency || 'USD',
      valid_until: data.valid_until || new Date(Date.now() + validity * 86400_000).toISOString().slice(0, 10),
    }, { transaction });
    await writeLines(record, lineItems, transaction);
    return record.id;
  });
  return service.get(def, id, 'all');
}

async function update(id, input, scope) {
  const { line_items: lineItems, ...data } = input;
  await sequelize.transaction(async (transaction) => {
    const quote = await service.findScoped(def, id, scope, { transaction, lock: true });
    if (!EDITABLE.includes(quote.status)) throw E.conflict(`A ${quote.status.replace('_', ' ')} quote cannot be edited. Create a revision instead.`, 'QUOTE_LOCKED');
    const changes = quote.status === 'rejected' ? { ...data, status: 'draft' } : data;
    if (Object.keys(changes).length) await service.updateRecord(def, id, changes, scope, { transaction });
    if (lineItems) {
      await writeLines(quote, lineItems, transaction);
      await timeline.add('quote', id, 'line_items_updated', `Line items updated (${lineItems.length})`, null, { transaction });
    }
  });
  return service.get(def, id, 'all');
}

async function approvers(transaction) {
  const perm = await Permission.findOne({ where: { key: 'quotes:approve' }, transaction });
  const rps = await RolePermission.findAll({ where: { permission_id: perm.id }, attributes: ['role_id'], transaction });
  const mrs = await MembershipRole.findAll({ where: { role_id: rps.map((r) => r.role_id) }, attributes: ['membership_id'], transaction });
  const members = await Membership.findAll({ where: { id: mrs.map((m) => m.membership_id), status: 'active' }, attributes: ['user_id'], transaction });
  return [...new Set(members.map((m) => m.user_id))];
}

async function transition(id, scope, fn) {
  await sequelize.transaction(async (transaction) => {
    const quote = await service.findScoped(def, id, scope, { transaction, lock: true });
    await fn(quote, transaction);
  });
  return service.get(def, id, 'all');
}

function needsApproval(quote, ctx) {
  const threshold = money.toFixedBig(ctx.settings?.preferences?.quote_approval_discount_threshold ?? 15);
  return money.cmp(money.toFixedBig(quote.max_line_discount_percent), threshold) > 0;
}

const submit = (id, scope) => transition(id, scope, async (quote, transaction) => {
  const ctx = getContext();
  if (!EDITABLE.includes(quote.status)) throw E.conflict('Only draft quotes can be submitted', 'INVALID_TRANSITION');
  const count = await QuoteLineItem.count({ where: { quote_id: quote.id }, transaction });
  if (!count) throw E.validation([{ path: 'line_items', message: 'Add at least one line item' }]);
  const lines = await QuoteLineItem.findAll({ where: { quote_id: quote.id }, transaction });
  const { exceedsProductMax } = await calculate(lines.map((l) => ({ ...l.get({ plain: true }) })), { transaction });
  if (needsApproval(quote, ctx) || exceedsProductMax) {
    await quote.update({ status: 'pending_approval', submitted_at: new Date() }, { transaction });
    const approval = await Approval.create({ entity_type: 'quote', entity_id: quote.id, requested_by_user_id: ctx.userId, reason: `Discount ${quote.max_line_discount_percent}% exceeds policy` }, { transaction });
    for (const userId of await approvers(transaction)) {
      if (userId === ctx.userId) continue;
      await notifications.notify(userId, { type: 'quote.approval_requested', title: 'Quote approval requested', body: def.title(quote), link: `/quotes/${quote.id}`, entity_type: 'quote', entity_id: quote.id }, { transaction });
    }
    await timeline.add('quote', quote.id, 'approval_requested', 'Submitted for approval', { approval_id: approval.id }, { transaction });
  } else {
    await quote.update({ status: 'approved', submitted_at: new Date(), approved_at: new Date(), approved_by_user_id: null }, { transaction });
    await timeline.add('quote', quote.id, 'auto_approved', 'Approved automatically (within discount policy)', null, { transaction });
  }
  await audit.record({ action: 'quote.submitted', entityType: 'quote', entityId: quote.id, summary: `${def.title(quote)} submitted (${quote.status})` }, { transaction });
});

const decide = (id, scope, decision, comment) => transition(id, scope, async (quote, transaction) => {
  const ctx = getContext();
  if (quote.status !== 'pending_approval') throw E.conflict('Quote is not awaiting approval', 'INVALID_TRANSITION');
  const approval = await Approval.findOne({ where: { entity_type: 'quote', entity_id: quote.id, status: 'pending' }, transaction });
  if (approval && approval.requested_by_user_id === ctx.userId && !ctx.isOwner) throw E.forbidden('You cannot approve your own request', 'SELF_APPROVAL');
  if (approval) await approval.update({ status: decision, decided_by_user_id: ctx.userId, decided_at: new Date(), comment }, { transaction });
  if (decision === 'approved') await quote.update({ status: 'approved', approved_by_user_id: ctx.userId, approved_at: new Date(), rejection_reason: null }, { transaction });
  else await quote.update({ status: 'rejected', rejection_reason: comment || 'Rejected' }, { transaction });
  await timeline.add('quote', quote.id, `approval_${decision}`, `Quote ${decision}${comment ? `: ${comment}` : ''}`, null, { transaction });
  await audit.record({ action: `quote.${decision}`, entityType: 'quote', entityId: quote.id, summary: `${def.title(quote)} ${decision}`, metadata: { comment } }, { transaction });
  if (quote.owner_id && quote.owner_id !== ctx.userId) {
    await notifications.notify(quote.owner_id, { type: 'quote.approval_decided', title: `Quote ${decision}`, body: def.title(quote), link: `/quotes/${quote.id}`, entity_type: 'quote', entity_id: quote.id }, { transaction });
  }
  await events.publish(`quote.${decision}`, { entityType: 'quote', entityId: quote.id, data: { id: quote.id, total: quote.total } }, { transaction });
});

const STATUS_FLOW = {
  send: { from: ['approved'], to: 'sent', stamp: 'sent_at' },
  accept: { from: ['sent'], to: 'accepted', stamp: 'accepted_at' },
  decline: { from: ['sent'], to: 'declined' },
};

const move = (id, scope, action) => transition(id, scope, async (quote, transaction) => {
  const flow = STATUS_FLOW[action];
  if (!flow.from.includes(quote.status)) throw E.conflict(`Cannot ${action} a quote that is ${quote.status}`, 'INVALID_TRANSITION');
  if (quote.valid_until && quote.valid_until < new Date().toISOString().slice(0, 10) && action !== 'decline') throw E.conflict('Quote has expired; create a revision', 'QUOTE_EXPIRED');
  await quote.update({ status: flow.to, ...(flow.stamp ? { [flow.stamp]: new Date() } : {}) }, { transaction });
  await timeline.add('quote', quote.id, `quote_${flow.to}`, `Quote marked ${flow.to}`, null, { transaction });
  await audit.record({ action: `quote.${flow.to}`, entityType: 'quote', entityId: quote.id, summary: `${def.title(quote)} ${flow.to}` }, { transaction });
  await events.publish(`quote.${flow.to}`, { entityType: 'quote', entityId: quote.id, data: { id: quote.id, total: quote.total, opportunity_id: quote.opportunity_id } }, { transaction });
});

async function revise(id, scope) {
  const ctx = getContext();
  const newId = await sequelize.transaction(async (transaction) => {
    const quote = await service.findScoped(def, id, scope, { transaction, lock: true });
    if (quote.status === 'accepted') throw E.conflict('Accepted quotes cannot be revised', 'INVALID_TRANSITION');
    const latest = (await Quote.findOne({ where: { quote_group_id: quote.quote_group_id }, order: [['revision', 'DESC']], attributes: ['revision'], paranoid: false, transaction })).revision;
    const lines = await QuoteLineItem.findAll({ where: { quote_id: quote.id }, transaction });
    const copy = { ...quote.get({ plain: true }) };
    for (const k of ['id', 'tenant_id', 'status', 'version', 'created_at', 'updated_at', 'deleted_at', 'submitted_at', 'approved_at', 'approved_by_user_id', 'sent_at', 'accepted_at', 'rejection_reason']) delete copy[k];
    const validity = Number(ctx.settings?.preferences?.quote_validity_days) || 30;
    const rev = await service.createRecord(def, { ...copy, revision: latest + 1, status: 'draft', valid_until: new Date(Date.now() + validity * 86400_000).toISOString().slice(0, 10) }, { transaction, skipOwnerCheck: true });
    if (lines.length) await QuoteLineItem.bulkCreate(lines.map((l) => { const p = { ...l.get({ plain: true }) }; delete p.id; delete p.tenant_id; delete p.created_at; delete p.updated_at; return { ...p, quote_id: rev.id }; }), { transaction });
    if (!['superseded', 'declined', 'expired'].includes(quote.status)) await quote.update({ status: 'superseded' }, { transaction });
    await timeline.add('quote', quote.id, 'revised', `Superseded by revision ${latest + 1}`, { new_quote_id: rev.id }, { transaction });
    return rev.id;
  });
  return service.get(def, newId, 'all');
}

async function revisions(id, scope) {
  const quote = await service.findScoped(def, id, scope);
  return Quote.findAll({ where: { quote_group_id: quote.quote_group_id }, order: [['revision', 'ASC']], attributes: ['id', 'number', 'revision', 'status', 'total', 'created_at'] });
}

/** Scheduled: expire approved/sent quotes past valid_until (all tenants, each in its own context). */
async function expireAll() {
  const { runAsSystem, runInTenant } = require('../../context/requestContext');
  const today = new Date().toISOString().slice(0, 10);
  const due = await runAsSystem('quotes:expire-scan', () => Quote.findAll({ where: { status: ['approved', 'sent'], valid_until: { [Op.lt]: today } }, attributes: ['id', 'tenant_id'], limit: 5000 }));
  for (const q of due) {
    await runInTenant(q.tenant_id, async () => {
      await Quote.update({ status: 'expired' }, { where: { id: q.id, status: ['approved', 'sent'] } });
      await timeline.add('quote', q.id, 'expired', 'Quote expired');
    });
  }
  return { expired: due.length };
}

function attach(d) {
  def = d;
  d.createOverride = create;
  d.updateOverride = update;
}

module.exports = { attach, create, update, submit, decide, move, revise, revisions, expireAll };
