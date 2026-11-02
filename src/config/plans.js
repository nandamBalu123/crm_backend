'use strict';

// Default plan catalogue (seeded). Prices are illustrative and editable by platform admins.
const ALL_MODULES = ['leads', 'contacts', 'accounts', 'opportunities', 'activities', 'products', 'quotes', 'campaigns', 'forms', 'tickets', 'workflows', 'reports', 'integrations', 'api'];

module.exports = [
  {
    code: 'free', name: 'Free', price_monthly: '0.00', sort_order: 1,
    description: 'For individuals evaluating the CRM.',
    limits: { seats: 3, records: 2000, storage_mb: 500, api_calls_per_day: 1000, workflows: 3, custom_fields_per_entity: 10 },
    features: ['leads', 'contacts', 'accounts', 'opportunities', 'activities', 'reports'],
  },
  {
    code: 'growth', name: 'Growth', price_monthly: '29.00', sort_order: 2,
    description: 'For growing sales teams.',
    limits: { seats: 25, records: 100000, storage_mb: 20000, api_calls_per_day: 50000, workflows: 50, custom_fields_per_entity: 100 },
    features: ALL_MODULES.filter((mod) => mod !== 'api'),
  },
  {
    code: 'enterprise', name: 'Enterprise', price_monthly: '79.00', sort_order: 3,
    description: 'Advanced security, API access and higher limits.',
    limits: { seats: 1000, records: 5000000, storage_mb: 500000, api_calls_per_day: 1000000, workflows: 500, custom_fields_per_entity: 500 },
    features: ALL_MODULES,
  },
];
module.exports.ALL_MODULES = ALL_MODULES;
