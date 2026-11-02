'use strict';

const { sequelize, Communication, Contact, Lead, EmailTemplate, Activity } = require('../../models');
const integrations = require('../integrations/integrations.service');
const queue = require('../../jobs/queue');
const timeline = require('../timeline/timeline.service');
const audit = require('../audit/audit.service');
const usage = require('../billing/usage.service');
const { render, sanitizeHtml, htmlToText } = require('./templating');
const { unsubscribeUrl } = require('./unsubscribe');
const { getContext } = require('../../context/requestContext');
const E = require('../../errors/AppError');

const CAPABILITY = { email: 'email.send', sms: 'sms.send', whatsapp: 'whatsapp.send' };

async function resolveRecipient({ contact_id: contactId, lead_id: leadId }, channel, transaction) {
  const Model = contactId ? Contact : Lead;
  const id = contactId || leadId;
  if (!id) throw E.validation([{ path: 'contact_id', message: 'A contact or lead is required' }]);
  const r = await Model.findByPk(id, { transaction });
  if (!r) throw E.validation([{ path: contactId ? 'contact_id' : 'lead_id', message: 'Recipient not found' }]);
  const address = channel === 'email' ? r.email : r.mobile || r.phone;
  return { record: r, type: contactId ? 'contact' : 'lead', address };
}

/**
 * Queues an outbound message after enforcing consent. Opted-out recipients
 * produce a `blocked` communication (auditable), never a send.
 */
async function send({ channel = 'email', contact_id, lead_id, opportunity_id, ticket_id, subject, body, template_id: templateId, variables = {}, marketing = false }) {
  const ctx = getContext();
  return sequelize.transaction(async (transaction) => {
    const { record, type, address } = await resolveRecipient({ contact_id, lead_id }, channel, transaction);
    if (!address) throw E.validation([{ path: 'to', message: `Recipient has no ${channel === 'email' ? 'email address' : 'phone number'}` }]);
    let subj = subject;
    let html = body;
    if (templateId) {
      const t = await EmailTemplate.findOne({ where: { id: templateId, is_active: true }, transaction });
      if (!t) throw E.validation([{ path: 'template_id', message: 'Template not found' }]);
      subj = subject || t.subject;
      html = body || t.body_html;
    }
    const vars = { first_name: record.first_name, last_name: record.last_name, company: record.company, email: record.email, sender_name: ctx.user ? `${ctx.user.first_name} ${ctx.user.last_name}`.trim() : '', ...variables };
    // Opt-out flags are a hard stop for that channel (marketing and one-to-one alike).
    let blocked = null;
    if (channel === 'email' && record.email_opt_out) blocked = 'Recipient has opted out of email';
    if (channel !== 'email' && (record.sms_opt_out || record.do_not_call)) blocked = 'Recipient has opted out of text messages';
    const renderedHtml = channel === 'email' ? sanitizeHtml(render(html, vars, { html: true })) : null;
    const text = channel === 'email' ? htmlToText(renderedHtml) : render(body, vars);
    const comm = await Communication.create({
      channel, direction: 'outbound', to_address: address, subject: channel === 'email' ? render(subj, vars).slice(0, 300) : null,
      body: channel === 'email' ? renderedHtml : text, template_id: templateId || null, status: blocked ? 'blocked' : 'queued', status_reason: blocked,
      [`${type}_id`]: record.id, account_id: record.account_id || null, opportunity_id: opportunity_id || null, ticket_id: ticket_id || null, sent_by_user_id: ctx.userId || null,
    }, { transaction });
    if (!blocked) await queue.enqueue('communications.deliver', { communication_id: comm.id, marketing, subject_type: type }, { transaction, maxAttempts: 5 });
    await timeline.add(type, record.id, blocked ? 'communication_blocked' : 'communication_queued', blocked ? `${channel} not sent: ${blocked}` : `${channel === 'email' ? 'Email' : channel.toUpperCase()} queued${comm.subject ? `: ${comm.subject}` : ''}`, { communication_id: comm.id }, { transaction });
    await audit.record({ action: blocked ? 'communication.blocked' : 'communication.queued', entityType: 'communication', entityId: comm.id, metadata: { channel, reason: blocked } }, { transaction });
    return comm;
  });
}

async function deliver({ communication_id: id, marketing, subject_type: subjectType }) {
  const comm = await Communication.findByPk(id);
  if (!comm || !['queued', 'failed'].includes(comm.status)) return { skipped: true };
  const target = await integrations.connectionFor(CAPABILITY[comm.channel]);
  comm.attempts += 1;
  if (!target) {
    await comm.update({ status: 'failed', attempts: comm.attempts, status_reason: `No ${comm.channel} provider is connected. Configure one in Settings → Integrations.` });
    const err = new Error('No provider configured');
    err.permanent = true;
    throw err;
  }
  try {
    const headers = {};
    let html = comm.body;
    if (comm.channel === 'email' && marketing) {
      const url = unsubscribeUrl({ tenantId: comm.tenant_id, subjectType, subjectId: comm.contact_id || comm.lead_id });
      headers['List-Unsubscribe'] = `<${url}>`;
      html = `${html}<p style="font-size:12px;color:#888"><a href="${url}">Unsubscribe</a></p>`;
    }
    const method = { email: 'sendEmail', sms: 'sendSms', whatsapp: 'sendWhatsApp' }[comm.channel];
    const result = await target.provider[method]({ config: target.config, secrets: target.secrets }, { to: comm.to_address, subject: comm.subject, html, text: htmlToText(html) || comm.body, headers });
    await comm.update({ status: 'sent', sent_at: new Date(), provider: target.provider.key, provider_message_id: result.provider_message_id || null, attempts: comm.attempts, status_reason: null });
    if (comm.channel === 'email') {
      await Activity.create({ type: 'email', subject: comm.subject || 'Email', status: 'completed', completed_at: new Date(), owner_id: comm.sent_by_user_id, created_by_user_id: comm.sent_by_user_id, contact_id: comm.contact_id, lead_id: comm.lead_id, account_id: comm.account_id, opportunity_id: comm.opportunity_id, ticket_id: comm.ticket_id });
    }
    usage.increment(`${comm.channel}_sent`);
    return { status: 'sent' };
  } catch (err) {
    await comm.update({ status: 'failed', attempts: comm.attempts, status_reason: String(err.message).slice(0, 500), provider: target.provider.key });
    throw err;
  }
}

queue.register('communications.deliver', deliver, { maxAttempts: 5 });

module.exports = { send, deliver };
