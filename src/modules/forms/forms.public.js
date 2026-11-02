'use strict';

const express = require('express');
const { Op } = require('sequelize');
const { sequelize, LeadForm, FormSubmission, Lead, Tenant, Consent, CampaignMember } = require('../../models');
const { runAsSystem, runInTenant, getContext } = require('../../context/requestContext');
const { loadTenant } = require('../../middleware/tenantContext');
const { validate } = require('../../middleware/validate');
const service = require('../../core/entity/service');
const registry = require('../../core/entity/registry');
const timeline = require('../timeline/timeline.service');
const audit = require('../audit/audit.service');
const { z } = require('../../utils/schemas');
const E = require('../../errors/AppError');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function loadForm(publicKey) {
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(publicKey)) throw E.notFound('Form');
  const form = await runAsSystem('public-form:lookup', () => LeadForm.findOne({ where: { public_key: publicKey, is_active: true } }));
  if (!form) throw E.notFound('Form');
  const tenant = await runAsSystem('public-form:tenant', () => Tenant.findByPk(form.tenant_id, { attributes: ['id', 'name', 'status', 'owner_user_id'] }));
  if (!tenant || tenant.status !== 'active') throw E.notFound('Form');
  return { form, tenant };
}

function checkOrigin(req, form) {
  const origins = form.allowed_origins || [];
  if (!origins.length) return;
  const origin = req.get('origin');
  if (!origin || !origins.map((o) => new URL(o).origin).includes(origin)) throw E.forbidden('This form cannot be submitted from this site', 'ORIGIN_NOT_ALLOWED');
}

function coerceField(field, raw, errors) {
  const v = typeof raw === 'string' ? raw.trim() : raw;
  if (v === undefined || v === null || v === '' || v === false) {
    if (field.required) errors.push({ path: field.key, message: `${field.label} is required` });
    return undefined;
  }
  const s = String(v).slice(0, field.type === 'textarea' ? 5000 : 255);
  if (field.type === 'email' && !EMAIL_RE.test(s)) errors.push({ path: field.key, message: 'Enter a valid email' });
  if (field.type === 'select' && field.options?.length && !field.options.includes(s)) errors.push({ path: field.key, message: 'Invalid option' });
  if (field.type === 'number' && Number.isNaN(Number(s))) errors.push({ path: field.key, message: 'Enter a number' });
  if (field.type === 'url' && !/^https?:\/\//i.test(s)) errors.push({ path: field.key, message: 'Enter a URL' });
  if (field.type === 'checkbox') return v === true || v === 'true' || v === 'on';
  return field.key === 'email' ? s.toLowerCase() : s;
}

router.get('/api/v1/public/forms/:key', async (req, res) => {
  const { form, tenant } = await loadForm(req.params.key);
  const loaded = await loadTenant(tenant.id);
  res.json({ data: {
    name: form.name, fields: form.fields, consent_text: form.consent_text, require_consent: form.require_consent,
    success_message: form.success_message, company: loaded.settings?.branding?.display_name || tenant.name, primary_color: loaded.settings?.branding?.primary_color,
  } });
});

router.post('/api/v1/public/forms/:key/submit', validate({ body: z.object({ data: z.record(z.string(), z.any()), consent: z.boolean().optional(), _hp: z.string().optional() }) }), async (req, res) => {
  const { form, tenant } = await loadForm(req.params.key);
  checkOrigin(req, form);
  const { data, consent, _hp: honeypot } = req.valid.body;
  const meta = { ip: req.ip, user_agent: (req.get('user-agent') || '').slice(0, 400), referrer: (req.get('referer') || '').slice(0, 500) };

  await runInTenant(tenant.id, async () => {
    const ctx = getContext();
    Object.assign(ctx, { actorType: 'public', actorLabel: `form:${form.name}`, settings: (await loadTenant(tenant.id)).settings });
    if (honeypot) {
      await FormSubmission.create({ form_id: form.id, payload: {}, status: 'spam', ...meta });
      return;
    }
    const errors = [];
    const values = {};
    const custom = {};
    for (const field of form.fields) {
      const v = coerceField(field, data[field.key], errors);
      if (v === undefined) continue;
      if (field.key.startsWith('cf.')) custom[field.key.slice(3)] = v;
      else values[field.key] = v;
    }
    if (form.require_consent && !consent) errors.push({ path: 'consent', message: 'Consent is required' });
    if (!values.last_name) values.last_name = values.email ? values.email.split('@')[0] : 'Unknown';
    if (errors.length) {
      await FormSubmission.create({ form_id: form.id, payload: { fields: Object.keys(data) }, status: 'rejected', error: errors.map((e) => e.message).join('; ').slice(0, 500), ...meta });
      throw E.validation(errors);
    }
    await sequelize.transaction(async (transaction) => {
      const existing = values.email ? await Lead.findOne({ where: { email: values.email, status: { [Op.ne]: 'converted' } }, transaction }) : null;
      let lead = existing;
      if (!lead) {
        lead = await service.createRecord(registry.lead, {
          ...values, source: form.lead_source || 'web_form', campaign_id: form.campaign_id || null,
          owner_id: form.default_owner_id || tenant.owner_user_id, custom_fields: custom,
        }, { transaction, skipOwnerCheck: true });
      } else {
        await timeline.add('lead', lead.id, 'form_resubmitted', `Submitted form "${form.name}" again`, { fields: Object.keys(values) }, { transaction });
      }
      if (consent !== undefined && values.email) {
        await Consent.create({ subject_type: 'lead', subject_id: lead.id, email: values.email, channel: 'email', status: consent ? 'granted' : 'revoked', source: `form:${form.id}`, consent_text: form.consent_text, ip: req.ip }, { transaction });
      }
      if (form.campaign_id) {
        const member = await CampaignMember.findOne({ where: { campaign_id: form.campaign_id, lead_id: lead.id }, transaction });
        if (member) await member.update({ status: 'responded', responded_at: new Date() }, { transaction });
        else await CampaignMember.create({ campaign_id: form.campaign_id, lead_id: lead.id, status: 'responded', responded_at: new Date() }, { transaction });
      }
      await FormSubmission.create({ form_id: form.id, lead_id: lead.id, payload: { ...values, custom_fields: custom }, status: 'accepted', ...meta }, { transaction });
      await LeadForm.update({ submission_count: sequelize.literal('submission_count + 1') }, { where: { id: form.id }, transaction });
      await audit.record({ action: 'form.submitted', entityType: 'lead', entityId: lead.id, summary: `Web form "${form.name}" submitted`, metadata: { duplicate: !!existing } }, { transaction });
    });
  });
  res.status(201).json({ data: { message: form.success_message || 'Thank you! We will be in touch shortly.', redirect_url: form.redirect_url || null } });
});

module.exports = router;
