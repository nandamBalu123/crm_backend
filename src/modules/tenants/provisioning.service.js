'use strict';

const {
  sequelize, Tenant, TenantSettings, TenantSubscription, Plan, Role, RolePermission, Permission, Membership, MembershipRole,
  Pipeline, PipelineStage, SlaPolicy, TicketCategory, EmailTemplate, QuoteTemplate,
} = require('../../models');
const { runInTenant } = require('../../context/requestContext');
const { SYSTEM_ROLES } = require('../../config/roles');
const { defaultSettings } = require('./settings.defaults');
const { uuidv7 } = require('../../utils/ids');
const { conflict } = require('../../errors/AppError');

function slugify(name) {
  return String(name).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 50) || 'workspace';
}

async function uniqueSlug(base, transaction) {
  let slug = slugify(base);
  for (let i = 0; i < 20; i += 1) {
    const exists = await Tenant.findOne({ where: { slug }, transaction, attributes: ['id'] });
    if (!exists) return slug;
    slug = `${slugify(base).slice(0, 44)}-${Math.random().toString(36).slice(2, 7)}`;
  }
  throw conflict('Could not allocate a workspace URL, please choose another name');
}

const DEFAULT_STAGES = [
  { name: 'Qualification', probability: 10 },
  { name: 'Needs analysis', probability: 25 },
  { name: 'Proposal', probability: 50 },
  { name: 'Negotiation', probability: 75 },
  { name: 'Closed won', probability: 100, category: 'won' },
  { name: 'Closed lost', probability: 0, category: 'lost' },
];

const DEFAULT_SLAS = [
  { name: 'Urgent', priority: 'urgent', first_response_minutes: 60, resolution_minutes: 8 * 60 },
  { name: 'High', priority: 'high', first_response_minutes: 4 * 60, resolution_minutes: 24 * 60 },
  { name: 'Normal', priority: 'normal', first_response_minutes: 8 * 60, resolution_minutes: 3 * 24 * 60 },
  { name: 'Low', priority: 'low', first_response_minutes: 24 * 60, resolution_minutes: 7 * 24 * 60 },
];

const DEFAULT_TEMPLATES = [
  {
    key: 'follow_up', name: 'Follow-up after call', category: 'sales', subject: 'Great speaking with you, {{first_name}}',
    body_html: '<p>Hi {{first_name}},</p><p>Thanks for your time today. As discussed, I will follow up with the next steps.</p><p>Best regards,<br>{{sender_name}}</p>',
  },
  {
    key: 'ticket_reply', name: 'Support reply', category: 'support', subject: 'Re: {{ticket_subject}} [#{{ticket_number}}]',
    body_html: '<p>Hi {{first_name}},</p><p>{{message}}</p><p>— {{sender_name}}, Support</p>',
  },
];

/** Seeds the system roles for a tenant and returns them keyed by role key. */
async function seedRoles(transaction) {
  const perms = await Permission.findAll({ transaction, attributes: ['id', 'key'] });
  const byKey = new Map(perms.map((p) => [p.key, p.id]));
  const roles = {};
  for (const tpl of SYSTEM_ROLES) {
    const role = await Role.create({ key: tpl.key, name: tpl.name, description: tpl.description, is_system: true, is_protected: !!tpl.protected }, { transaction });
    const rows = Object.entries(tpl.permissions)
      .filter(([k]) => byKey.has(k))
      .map(([k, scope]) => ({ role_id: role.id, permission_id: byKey.get(k), scope }));
    if (rows.length) await RolePermission.bulkCreate(rows, { transaction });
    roles[tpl.key] = role;
  }
  return roles;
}

/**
 * Creates a fully provisioned tenant with the given user as owner.
 * Runs in a single transaction: either everything exists or nothing does.
 */
async function provisionTenant({ name, slug, owner, planCode = 'growth', trialDays = 14 }, { transaction: outer } = {}) {
  const work = async (transaction) => {
    const plan = (await Plan.findOne({ where: { code: planCode }, transaction })) || (await Plan.findOne({ order: [['sort_order', 'ASC']], transaction }));
    const tenantId = uuidv7();
    const tenant = await Tenant.create(
      { id: tenantId, name, slug: await uniqueSlug(slug || name, transaction), plan_id: plan?.id || null, owner_user_id: owner.id },
      { transaction }
    );
    await runInTenant(tenantId, async () => {
      await TenantSettings.create(defaultSettings(), { transaction });
      if (plan) {
        await TenantSubscription.create({
          plan_id: plan.id, status: 'trialing', provider: 'manual', seats: plan.limits?.seats || 5,
          trial_ends_at: new Date(Date.now() + trialDays * 86400_000), current_period_start: new Date(),
        }, { transaction });
      }
      const roles = await seedRoles(transaction);
      const membership = await Membership.create({ user_id: owner.id, is_owner: true, status: 'active', joined_at: new Date(), last_active_at: new Date() }, { transaction });
      await MembershipRole.create({ membership_id: membership.id, role_id: roles.owner.id }, { transaction });

      const pipeline = await Pipeline.create({ name: 'Sales pipeline', is_default: true, display_order: 0 }, { transaction });
      await PipelineStage.bulkCreate(
        DEFAULT_STAGES.map((s, i) => ({ pipeline_id: pipeline.id, name: s.name, probability: s.probability, category: s.category || 'open', display_order: i, rotting_days: s.category ? null : 14 })),
        { transaction }
      );
      await SlaPolicy.bulkCreate(DEFAULT_SLAS, { transaction });
      await TicketCategory.bulkCreate([{ name: 'General' }, { name: 'Billing' }, { name: 'Technical' }], { transaction });
      await EmailTemplate.bulkCreate(DEFAULT_TEMPLATES, { transaction });
      await QuoteTemplate.create({ name: 'Standard', is_default: true, terms: 'Payment due within 30 days of invoice.', accent_color: '#4f46e5' }, { transaction });
    });
    return tenant;
  };
  return outer ? work(outer) : sequelize.transaction(work);
}

module.exports = { provisionTenant, seedRoles, slugify, DEFAULT_STAGES };
