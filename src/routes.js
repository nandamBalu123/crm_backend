'use strict';

/**
 * Tenant API route table. Every router listed here is mounted behind
 * authenticate → CSRF → tenantContext → verified-email → tenant rate limit.
 */
module.exports = () => {
  const users = require('./modules/users/users.routes');
  const comms = require('./modules/communications/communications.routes');
  return [
    require('./modules/me/me.routes'),
    require('./modules/leads/leads.routes'),
    require('./modules/contacts/contacts.routes'),
    require('./modules/accounts/accounts.routes'),
    require('./modules/opportunities/opportunities.routes'),
    require('./modules/pipelines/pipelines.routes'),
    require('./modules/activities/activities.routes'),
    require('./modules/products/products.routes'),
    require('./modules/quotes/quotes.routes'),
    require('./modules/campaigns/campaigns.routes'),
    require('./modules/forms/forms.routes'),
    require('./modules/tickets/tickets.routes'),
    comms.comms,
    comms.templates,
    require('./modules/workflows/workflows.routes'),
    require('./modules/reports/reports.routes'),
    require('./modules/search/search.routes'),
    require('./modules/imports/imports.routes'),
    require('./modules/attachments/attachments.routes'),
    require('./modules/customFields/customFields.routes'),
    require('./modules/rbac/rbac.routes'),
    users.users,
    users.invitations,
    users.teams,
    require('./modules/tenants/settings.routes'),
    require('./modules/integrations/integrations.routes'),
    require('./modules/apiKeys/apiKeys.routes'),
    require('./modules/webhooks/webhooks.routes'),
    require('./modules/audit/audit.routes'),
  ];
};
