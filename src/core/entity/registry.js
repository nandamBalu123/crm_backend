'use strict';

/**
 * Lazy registry of CRM entity definitions keyed by entity type. Lazy getters
 * avoid circular requires between modules that reference each other.
 */
const loaders = {
  lead: () => require('../../modules/leads/leads.entity'),
  contact: () => require('../../modules/contacts/contacts.entity'),
  account: () => require('../../modules/accounts/accounts.entity'),
  opportunity: () => require('../../modules/opportunities/opportunities.entity'),
  activity: () => require('../../modules/activities/activities.entity'),
  ticket: () => require('../../modules/tickets/tickets.entity'),
  quote: () => require('../../modules/quotes/quotes.entity'),
  product: () => require('../../modules/products/products.entity'),
  campaign: () => require('../../modules/campaigns/campaigns.entity'),
};

const registry = {};
for (const [type, load] of Object.entries(loaders)) {
  Object.defineProperty(registry, type, { enumerable: true, get: load });
}

/** Entity types that support custom fields. */
registry.CUSTOM_FIELD_ENTITIES = ['lead', 'contact', 'account', 'opportunity', 'activity', 'ticket', 'product', 'quote', 'campaign'];
registry.get = (type) => {
  if (!loaders[type]) return null;
  return loaders[type]();
};

module.exports = registry;
