'use strict';

const { CATALOG } = require('./permissions');

const all = (filter) => Object.fromEntries(CATALOG.filter(filter).map((p) => [p.key, 'all']));
const pick = (entries) => entries;

const CRM_READ_WRITE = (scope) => ({
  'dashboard:read': 'all',
  ...Object.fromEntries(
    ['leads', 'contacts', 'accounts', 'opportunities', 'activities'].flatMap((mod) => [
      [`${mod}:read`, scope],
      [`${mod}:create`, 'all'],
      [`${mod}:update`, scope],
      [`${mod}:export`, scope],
    ])
  ),
  'leads:convert': 'all',
  'products:read': 'all',
  'quotes:read': 'all',
  'quotes:create': 'all',
  'quotes:update': 'all',
  'communications:read': 'all',
  'communications:create': 'all',
  'files:read': 'all',
  'files:create': 'all',
  'reports:read': 'all',
  'reports:create': 'all',
  'campaigns:read': 'all',
});

/** System role templates seeded into every new tenant. Tenants may clone and customise them. */
const SYSTEM_ROLES = [
  {
    key: 'owner',
    name: 'Tenant owner',
    description: 'Full control of the tenant, including billing and ownership transfer. Cannot be edited.',
    protected: true,
    permissions: all(() => true),
  },
  {
    key: 'admin',
    name: 'Administrator',
    description: 'Manages users, roles, settings and all CRM data.',
    permissions: all((p) => p.module !== 'billing' || p.action === 'read'),
  },
  {
    key: 'sales_manager',
    name: 'Sales manager',
    description: 'Manages the sales team, sees team records, approves quotes.',
    permissions: pick({
      ...CRM_READ_WRITE('team'),
      'leads:assign': 'team', 'leads:import': 'all', 'leads:delete': 'team', 'contacts:assign': 'team', 'contacts:import': 'all',
      'accounts:assign': 'team', 'opportunities:assign': 'team', 'opportunities:delete': 'team', 'activities:assign': 'team',
      'quotes:approve': 'all', 'quotes:export': 'all', 'reports:export': 'all', 'reports:update': 'all', 'users:read': 'all', 'workflows:read': 'all',
      'contacts:merge': 'all', 'accounts:merge': 'all',
    }),
  },
  {
    key: 'sales_rep',
    name: 'Sales representative',
    description: 'Works own leads, contacts, accounts and deals.',
    permissions: pick({ ...CRM_READ_WRITE('own'), 'users:read': 'all' }),
  },
  {
    key: 'marketing',
    name: 'Marketing user',
    description: 'Runs campaigns, forms and segments; imports leads.',
    permissions: pick({
      'dashboard:read': 'all', 'leads:read': 'all', 'leads:create': 'all', 'leads:update': 'all', 'leads:import': 'all', 'leads:export': 'all',
      'contacts:read': 'all', 'contacts:export': 'all', 'accounts:read': 'all', 'campaigns:read': 'all', 'campaigns:create': 'all',
      'campaigns:update': 'all', 'campaigns:delete': 'all', 'campaigns:export': 'all', 'forms:read': 'all', 'forms:create': 'all',
      'forms:update': 'all', 'forms:delete': 'all', 'reports:read': 'all', 'reports:create': 'all', 'communications:read': 'all',
      'communications:create': 'all', 'files:read': 'all', 'files:create': 'all', 'activities:read': 'own', 'activities:create': 'all', 'activities:update': 'own',
    }),
  },
  {
    key: 'support_agent',
    name: 'Customer support agent',
    description: 'Handles support tickets and customer communication.',
    permissions: pick({
      'dashboard:read': 'all', 'tickets:read': 'all', 'tickets:create': 'all', 'tickets:update': 'all', 'tickets:assign': 'team',
      'contacts:read': 'all', 'contacts:update': 'own', 'accounts:read': 'all', 'activities:read': 'own', 'activities:create': 'all',
      'activities:update': 'own', 'communications:read': 'all', 'communications:create': 'all', 'files:read': 'all', 'files:create': 'all',
      'reports:read': 'all', 'users:read': 'all',
    }),
  },
  {
    key: 'read_only',
    name: 'Read-only user',
    description: 'Can view CRM data but not change it.',
    permissions: all((p) => p.action === 'read' && !['audit', 'billing', 'roles', 'integrations'].includes(p.module)),
  },
];

module.exports = { SYSTEM_ROLES };
