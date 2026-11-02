'use strict';

const { sequelize } = require('../database');

const models = {
  ...require('./identity')(sequelize),
  ...require('./crm')(sequelize),
  ...require('./business')(sequelize),
};

// Associations are join helpers only (constraints: false). Referential
// integrity, including tenant-aware composite keys, lives in the migrations.
const c = { constraints: false };
const m = models;

m.Tenant.hasOne(m.TenantSettings, { ...c, foreignKey: 'tenant_id', as: 'settings' });
m.Tenant.belongsTo(m.Plan, { ...c, foreignKey: 'plan_id', as: 'plan' });
m.Tenant.hasMany(m.Membership, { ...c, foreignKey: 'tenant_id', as: 'memberships' });
m.Membership.belongsTo(m.User, { ...c, foreignKey: 'user_id', as: 'user' });
m.Membership.belongsTo(m.Tenant, { ...c, foreignKey: 'tenant_id', as: 'tenant' });
m.User.hasMany(m.Membership, { ...c, foreignKey: 'user_id', as: 'memberships' });
m.Membership.belongsToMany(m.Role, { ...c, through: m.MembershipRole, foreignKey: 'membership_id', otherKey: 'role_id', as: 'roles' });
m.Role.belongsToMany(m.Membership, { ...c, through: m.MembershipRole, foreignKey: 'role_id', otherKey: 'membership_id', as: 'memberships' });
m.Role.hasMany(m.RolePermission, { ...c, foreignKey: 'role_id', as: 'rolePermissions' });
m.RolePermission.belongsTo(m.Permission, { ...c, foreignKey: 'permission_id', as: 'permission' });
m.Role.hasMany(m.FieldPermission, { ...c, foreignKey: 'role_id', as: 'fieldPermissions' });
m.Team.hasMany(m.TeamMember, { ...c, foreignKey: 'team_id', as: 'members' });
m.TeamMember.belongsTo(m.User, { ...c, foreignKey: 'user_id', as: 'user' });
m.Team.belongsTo(m.User, { ...c, foreignKey: 'manager_user_id', as: 'manager' });
m.TenantSubscription.belongsTo(m.Plan, { ...c, foreignKey: 'plan_id', as: 'plan' });

const owned = ['Account', 'Contact', 'Lead', 'Opportunity', 'Activity', 'Ticket', 'Campaign', 'Quote'];
for (const name of owned) m[name].belongsTo(m.User, { ...c, foreignKey: 'owner_id', as: 'owner' });

m.Account.belongsTo(m.Account, { ...c, foreignKey: 'parent_account_id', as: 'parent' });
m.Account.hasMany(m.Account, { ...c, foreignKey: 'parent_account_id', as: 'children' });
m.Account.hasMany(m.Contact, { ...c, foreignKey: 'account_id', as: 'contacts' });
m.Contact.belongsTo(m.Account, { ...c, foreignKey: 'account_id', as: 'account' });
m.Lead.belongsTo(m.Campaign, { ...c, foreignKey: 'campaign_id', as: 'campaign' });
m.Pipeline.hasMany(m.PipelineStage, { ...c, foreignKey: 'pipeline_id', as: 'stages' });
m.PipelineStage.belongsTo(m.Pipeline, { ...c, foreignKey: 'pipeline_id', as: 'pipeline' });
m.Opportunity.belongsTo(m.Account, { ...c, foreignKey: 'account_id', as: 'account' });
m.Opportunity.belongsTo(m.Contact, { ...c, foreignKey: 'contact_id', as: 'contact' });
m.Opportunity.belongsTo(m.Pipeline, { ...c, foreignKey: 'pipeline_id', as: 'pipeline' });
m.Opportunity.belongsTo(m.PipelineStage, { ...c, foreignKey: 'stage_id', as: 'stage' });
m.Opportunity.belongsTo(m.Campaign, { ...c, foreignKey: 'campaign_id', as: 'campaign' });
m.Opportunity.hasMany(m.OpportunityProduct, { ...c, foreignKey: 'opportunity_id', as: 'products' });
m.OpportunityProduct.belongsTo(m.Product, { ...c, foreignKey: 'product_id', as: 'product' });
m.OpportunityStageHistory.belongsTo(m.PipelineStage, { ...c, foreignKey: 'to_stage_id', as: 'toStage' });
m.OpportunityStageHistory.belongsTo(m.PipelineStage, { ...c, foreignKey: 'from_stage_id', as: 'fromStage' });
for (const rel of ['Lead', 'Contact', 'Account', 'Opportunity', 'Ticket']) {
  m.Activity.belongsTo(m[rel], { ...c, foreignKey: `${rel.toLowerCase()}_id`, as: rel.toLowerCase() });
}
m.Ticket.belongsTo(m.Contact, { ...c, foreignKey: 'contact_id', as: 'contact' });
m.Ticket.belongsTo(m.Account, { ...c, foreignKey: 'account_id', as: 'account' });
m.Ticket.belongsTo(m.TicketCategory, { ...c, foreignKey: 'category_id', as: 'category' });
m.Ticket.belongsTo(m.SlaPolicy, { ...c, foreignKey: 'sla_policy_id', as: 'slaPolicy' });
m.Ticket.hasMany(m.TicketComment, { ...c, foreignKey: 'ticket_id', as: 'comments' });
m.TicketComment.belongsTo(m.User, { ...c, foreignKey: 'author_user_id', as: 'author' });
m.Product.belongsTo(m.ProductCategory, { ...c, foreignKey: 'category_id', as: 'category' });
m.Quote.hasMany(m.QuoteLineItem, { ...c, foreignKey: 'quote_id', as: 'lineItems' });
m.Quote.belongsTo(m.Opportunity, { ...c, foreignKey: 'opportunity_id', as: 'opportunity' });
m.Quote.belongsTo(m.Account, { ...c, foreignKey: 'account_id', as: 'account' });
m.Quote.belongsTo(m.Contact, { ...c, foreignKey: 'contact_id', as: 'contact' });
m.Quote.belongsTo(m.QuoteTemplate, { ...c, foreignKey: 'template_id', as: 'template' });
m.CampaignMember.belongsTo(m.Lead, { ...c, foreignKey: 'lead_id', as: 'lead' });
m.CampaignMember.belongsTo(m.Contact, { ...c, foreignKey: 'contact_id', as: 'contact' });
m.Workflow.hasMany(m.WorkflowRun, { ...c, foreignKey: 'workflow_id', as: 'runs' });
m.WebhookEndpoint.hasMany(m.WebhookDelivery, { ...c, foreignKey: 'endpoint_id', as: 'deliveries' });
m.TimelineEvent.belongsTo(m.User, { ...c, foreignKey: 'actor_user_id', as: 'actor' });
m.AuditLog.belongsTo(m.User, { ...c, foreignKey: 'actor_user_id', as: 'actor' });
m.Attachment.belongsTo(m.User, { ...c, foreignKey: 'uploaded_by_user_id', as: 'uploader' });
m.RecordAssignment.belongsTo(m.User, { ...c, foreignKey: 'to_owner_id', as: 'toOwner' });
m.RecordAssignment.belongsTo(m.User, { ...c, foreignKey: 'from_owner_id', as: 'fromOwner' });
m.Communication.belongsTo(m.User, { ...c, foreignKey: 'sent_by_user_id', as: 'sender' });

module.exports = { sequelize, ...models };
