'use strict';

const express = require('express');
const { sequelize, Contact, Lead, Consent, CampaignMember } = require('../../models');
const { runInTenant } = require('../../context/requestContext');
const { signPayload, verifyPayload } = require('../../utils/crypto');
const audit = require('../audit/audit.service');
const timeline = require('../timeline/timeline.service');
const env = require('../../config/env');
const E = require('../../errors/AppError');

const router = express.Router();
const TTL = 365 * 86400;

/** Signed, tenant-bound unsubscribe link for marketing email footers. */
function unsubscribeUrl({ tenantId, subjectType, subjectId }) {
  return `${env.APP_URL}/unsubscribe?token=${signPayload({ t: tenantId, s: subjectType, i: subjectId, c: 'email' }, TTL)}`;
}

function parse(token) {
  const p = verifyPayload(token);
  if (!p || !['lead', 'contact'].includes(p.s)) throw E.badRequest('This unsubscribe link is invalid or expired');
  return p;
}

const mask = (email) => (email ? email.replace(/^(.).*(@.*)$/, '$1***$2') : null);

router.get('/api/v1/public/unsubscribe/:token', async (req, res) => {
  const p = parse(req.params.token);
  const subject = await runInTenant(p.t, () => (p.s === 'lead' ? Lead : Contact).findByPk(p.i, { attributes: ['email', 'email_opt_out'] }));
  if (!subject) throw E.badRequest('This unsubscribe link is invalid or expired');
  res.json({ data: { email: mask(subject.email), already_unsubscribed: subject.email_opt_out } });
});

router.post('/api/v1/public/unsubscribe/:token', async (req, res) => {
  const p = parse(req.params.token);
  await runInTenant(p.t, () => sequelize.transaction(async (transaction) => {
    const Model = p.s === 'lead' ? Lead : Contact;
    const subject = await Model.findByPk(p.i, { transaction });
    if (!subject) throw E.badRequest('This unsubscribe link is invalid or expired');
    await subject.update({ email_opt_out: true }, { transaction, hooks: true });
    await Consent.create({ subject_type: p.s, subject_id: subject.id, email: subject.email, channel: 'email', status: 'revoked', source: 'unsubscribe_link', ip: req.ip }, { transaction });
    await CampaignMember.update({ status: 'unsubscribed' }, { where: { [`${p.s}_id`]: subject.id }, transaction });
    await timeline.add(p.s, subject.id, 'unsubscribed', 'Unsubscribed from marketing email', null, { transaction });
    await audit.record({ action: 'consent.unsubscribed', entityType: p.s, entityId: subject.id }, { transaction });
  }), { actorType: 'public', actorLabel: 'unsubscribe-link' });
  res.json({ data: { unsubscribed: true } });
});

module.exports = { router, unsubscribeUrl };
