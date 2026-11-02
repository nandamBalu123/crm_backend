'use strict';

const { ALL_MODULES } = require('../../config/plans');

function defaultSettings(overrides = {}) {
  return {
    branding: { primary_color: '#4f46e5', accent_color: '#0ea5e9', logo_url: null, display_name: null },
    locale: 'en-US',
    timezone: 'UTC',
    currency: 'USD',
    date_format: 'yyyy-MM-dd',
    fiscal_year_start_month: 1,
    security: {
      require_mfa: false,
      password_min_length: 10,
      session_max_hours: 24 * 14,
      invite_expiry_days: 7,
      allowed_email_domains: [],
    },
    modules: Object.fromEntries(ALL_MODULES.map((m) => [m, true])),
    preferences: {
      lead_sources: ['web_form', 'referral', 'cold_call', 'event', 'advertising', 'partner', 'social', 'import', 'other'],
      industries: ['Technology', 'Finance', 'Healthcare', 'Manufacturing', 'Retail', 'Education', 'Government', 'Other'],
      loss_reasons: ['Price', 'Competitor', 'No budget', 'No decision', 'Timing', 'Product fit', 'Other'],
      quote_approval_discount_threshold: 15,
      quote_validity_days: 30,
      stalled_deal_days: 14,
      audit_record_access: false,
      retention: { audit_days: 365, deleted_records_days: 30, workflow_runs_days: 90 },
      lead_scoring: {
        rules: [
          { field: 'email', op: 'is_not_empty', points: 10 },
          { field: 'phone', op: 'is_not_empty', points: 10 },
          { field: 'rating', op: 'eq', value: 'hot', points: 25 },
          { field: 'rating', op: 'eq', value: 'warm', points: 10 },
          { field: 'source', op: 'eq', value: 'referral', points: 15 },
          { field: 'employees', op: 'gte', value: 100, points: 10 },
          { field: 'title', op: 'contains_any', value: ['director', 'vp', 'head', 'chief', 'founder', 'owner'], points: 15 },
        ],
      },
    },
    ...overrides,
  };
}

module.exports = { defaultSettings };
