'use strict';

/**
 * Permission catalog. Keys are `module:action`. `scoped` actions support a
 * record scope per role (own → records the user owns, team → records owned by
 * members of the user's teams, all → every record in the tenant).
 */
const RECORD_ACTIONS = ['read', 'create', 'update', 'delete', 'import', 'export', 'assign', 'share'];
const SCOPED = new Set(['read', 'update', 'delete', 'export', 'assign', 'share']);

const MODULES = [
  { key: 'dashboard', label: 'Dashboard', actions: ['read'] },
  { key: 'leads', label: 'Leads', actions: [...RECORD_ACTIONS, 'convert'] },
  { key: 'contacts', label: 'Contacts', actions: [...RECORD_ACTIONS, 'merge'] },
  { key: 'accounts', label: 'Accounts', actions: [...RECORD_ACTIONS, 'merge'] },
  { key: 'opportunities', label: 'Opportunities', actions: RECORD_ACTIONS },
  { key: 'activities', label: 'Activities', actions: RECORD_ACTIONS },
  { key: 'products', label: 'Products', actions: ['read', 'create', 'update', 'delete', 'import', 'export'] },
  { key: 'quotes', label: 'Quotes', actions: ['read', 'create', 'update', 'delete', 'export', 'approve'] },
  { key: 'campaigns', label: 'Campaigns', actions: ['read', 'create', 'update', 'delete', 'export'] },
  { key: 'forms', label: 'Lead capture forms', actions: ['read', 'create', 'update', 'delete'] },
  { key: 'tickets', label: 'Support tickets', actions: [...RECORD_ACTIONS] },
  { key: 'communications', label: 'Communications', actions: ['read', 'create'] },
  { key: 'workflows', label: 'Workflow automation', actions: ['read', 'create', 'update', 'delete'] },
  { key: 'reports', label: 'Reports & analytics', actions: ['read', 'create', 'update', 'delete', 'export'] },
  { key: 'files', label: 'Files', actions: ['read', 'create', 'delete'] },
  { key: 'custom_fields', label: 'Custom fields', actions: ['manage'] },
  { key: 'settings', label: 'Tenant settings', actions: ['read', 'manage'] },
  { key: 'users', label: 'Users & teams', actions: ['read', 'manage'] },
  { key: 'roles', label: 'Roles & permissions', actions: ['read', 'manage'] },
  { key: 'integrations', label: 'Integrations', actions: ['read', 'manage'] },
  { key: 'api_keys', label: 'API keys', actions: ['manage'] },
  { key: 'webhooks', label: 'Webhooks', actions: ['manage'] },
  { key: 'audit', label: 'Audit logs', actions: ['read'] },
  { key: 'billing', label: 'Billing & subscription', actions: ['read', 'manage'] },
];

const ACTION_LABELS = {
  read: 'View', create: 'Create', update: 'Edit', delete: 'Delete', import: 'Import', export: 'Export',
  assign: 'Assign', share: 'Share', approve: 'Approve', convert: 'Convert', merge: 'Merge', manage: 'Manage',
};

const CRM_MODULES = new Set(['leads', 'contacts', 'accounts', 'opportunities', 'activities', 'tickets']);

function buildCatalog() {
  const list = [];
  let order = 0;
  for (const mod of MODULES) {
    for (const action of mod.actions) {
      list.push({
        key: `${mod.key}:${action}`,
        module: mod.key,
        action,
        description: `${ACTION_LABELS[action]} ${mod.label.toLowerCase()}`,
        supports_scope: CRM_MODULES.has(mod.key) && SCOPED.has(action),
        sort_order: order++,
      });
    }
  }
  return list;
}

const CATALOG = buildCatalog();
const KEYS = new Set(CATALOG.map((p) => p.key));

module.exports = { MODULES, ACTION_LABELS, CATALOG, KEYS, CRM_MODULES };
