'use strict';

const env = require('../../config/env');
const { TenantSubscription, Tenant } = require('../../models');
const audit = require('../audit/audit.service');
const { getContext } = require('../../context/requestContext');
const { safeFetch } = require('../../utils/safeFetch');
const E = require('../../errors/AppError');

/**
 * Billing provider adapters. Without provider credentials the platform runs
 * in "manual billing" mode: free-plan changes apply immediately, paid plan
 * changes must be performed by a platform administrator. We never pretend
 * a payment succeeded.
 */
const providers = {
  stripe: {
    configured: () => !!env.STRIPE_SECRET_KEY,
    async createCheckout({ plan, tenant, customerEmail }) {
      const body = new URLSearchParams({
        mode: 'subscription',
        'line_items[0][price_data][currency]': plan.currency.toLowerCase(),
        'line_items[0][price_data][unit_amount]': String(Math.round(Number(plan.price_monthly) * 100)),
        'line_items[0][price_data][recurring][interval]': 'month',
        'line_items[0][price_data][product_data][name]': `CRM ${plan.name}`,
        'line_items[0][quantity]': '1',
        success_url: `${env.APP_URL}/settings/billing?checkout=success`,
        cancel_url: `${env.APP_URL}/settings/billing?checkout=cancel`,
        client_reference_id: tenant.id,
        customer_email: customerEmail,
        'metadata[tenant_id]': tenant.id,
        'metadata[plan_code]': plan.code,
      });
      const res = await safeFetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const json = await res.json();
      if (!res.ok) throw E.unavailable(`Stripe error: ${json.error?.message || res.status}`, 'BILLING_PROVIDER_ERROR');
      return { checkout_url: json.url, provider: 'stripe' };
    },
  },
  razorpay: {
    configured: () => !!(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET),
    async createCheckout() {
      throw E.unavailable('Razorpay subscriptions require a plan_id configured in the Razorpay dashboard; see docs/INTEGRATIONS.md', 'BILLING_PROVIDER_SETUP_REQUIRED');
    },
  },
};

function activeProvider() {
  return Object.entries(providers).find(([, p]) => p.configured())?.[0] || null;
}

async function changePlan(plan) {
  const ctx = getContext();
  const sub = await TenantSubscription.findOne({ where: {}, order: [['created_at', 'DESC']] });
  if (Number(plan.price_monthly) === 0) {
    await sub.update({ plan_id: plan.id, status: 'active', provider: 'manual', seats: plan.limits?.seats || sub.seats });
    await Tenant.update({ plan_id: plan.id }, { where: { id: ctx.tenantId } });
    await audit.record({ action: 'billing.plan_changed', entityType: 'tenant', entityId: ctx.tenantId, summary: `Plan changed to ${plan.name}` });
    return { status: 'changed', plan: plan.code };
  }
  const provider = activeProvider();
  if (!provider) {
    throw E.conflict('Online billing is not configured for this platform. Ask your platform administrator to change the plan.', 'BILLING_NOT_CONFIGURED');
  }
  const tenant = await Tenant.findByPk(ctx.tenantId);
  const checkout = await providers[provider].createCheckout({ plan, tenant, customerEmail: ctx.user.email });
  await audit.record({ action: 'billing.checkout_started', entityType: 'tenant', entityId: ctx.tenantId, summary: `Checkout started for ${plan.name}`, metadata: { provider } });
  return { status: 'checkout_required', ...checkout };
}

module.exports = { changePlan, activeProvider, providers };
