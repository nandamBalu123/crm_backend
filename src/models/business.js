'use strict';

const { defineModel, T, ref, str, text, int, dec, bool, date, dateOnly, json, enm } = require('./define');

const ts = { tenantScoped: true };

module.exports = (sequelize) => {
  const ProductCategory = defineModel(sequelize, 'ProductCategory', 'product_categories', { name: str(120, false), description: str(500), parent_id: ref() }, ts);
  const Product = defineModel(sequelize, 'Product', 'products', {
    sku: str(64, false), name: str(200, false), description: text(), category_id: ref(), unit_price: dec(18, 4, { allowNull: false, defaultValue: '0' }),
    currency: str(3, false, { defaultValue: 'USD' }), tax_rate: dec(7, 4, { allowNull: false, defaultValue: '0' }), unit: str(30),
    max_discount_percent: dec(7, 4), is_active: bool(true),
  }, { ...ts, soft: true, version: true });
  const DiscountRule = defineModel(sequelize, 'DiscountRule', 'discount_rules', {
    name: str(120, false), product_id: ref(), category_id: ref(), min_quantity: dec(18, 4, { allowNull: false, defaultValue: '1' }),
    discount_percent: dec(7, 4, { allowNull: false }), starts_on: dateOnly(), ends_on: dateOnly(), is_active: bool(true),
  }, ts);
  const OpportunityProduct = defineModel(sequelize, 'OpportunityProduct', 'opportunity_products', {
    opportunity_id: ref(false), product_id: ref(false), quantity: dec(18, 4, { allowNull: false }), unit_price: dec(18, 4, { allowNull: false }),
    discount_percent: dec(7, 4, { allowNull: false, defaultValue: '0' }), total: dec(18, 2, { allowNull: false }),
  }, ts);
  const QuoteTemplate = defineModel(sequelize, 'QuoteTemplate', 'quote_templates', {
    name: str(120, false), header_text: text(), footer_text: text(), terms: text(), accent_color: str(9), is_default: bool(false),
  }, ts);
  const Quote = defineModel(sequelize, 'Quote', 'quotes', {
    number: int({ allowNull: false }), revision: int({ allowNull: false, defaultValue: 1 }), quote_group_id: ref(false), title: str(200, false),
    status: enm(['draft', 'pending_approval', 'approved', 'rejected', 'sent', 'accepted', 'declined', 'expired', 'superseded'], 'draft'),
    opportunity_id: ref(), account_id: ref(), contact_id: ref(), template_id: ref(), currency: str(3, false, { defaultValue: 'USD' }),
    subtotal: dec(18, 2, { allowNull: false, defaultValue: '0' }), discount_total: dec(18, 2, { allowNull: false, defaultValue: '0' }),
    tax_total: dec(18, 2, { allowNull: false, defaultValue: '0' }), total: dec(18, 2, { allowNull: false, defaultValue: '0' }),
    max_line_discount_percent: dec(7, 4, { allowNull: false, defaultValue: '0' }), valid_until: dateOnly(), terms: text(), notes: text(),
    owner_id: ref(), submitted_at: date(), approved_by_user_id: ref(), approved_at: date(), rejection_reason: str(500), sent_at: date(), accepted_at: date(),
  }, { ...ts, soft: true, version: true });
  const QuoteLineItem = defineModel(sequelize, 'QuoteLineItem', 'quote_line_items', {
    quote_id: ref(false), product_id: ref(), position: int({ allowNull: false, defaultValue: 0 }), name: str(200, false), description: text(),
    quantity: dec(18, 4, { allowNull: false }), unit_price: dec(18, 4, { allowNull: false }), discount_percent: dec(7, 4, { allowNull: false, defaultValue: '0' }),
    tax_rate: dec(7, 4, { allowNull: false, defaultValue: '0' }), line_subtotal: dec(18, 2, { allowNull: false }), line_discount: dec(18, 2, { allowNull: false }),
    line_tax: dec(18, 2, { allowNull: false }), line_total: dec(18, 2, { allowNull: false }),
  }, ts);
  const Approval = defineModel(sequelize, 'Approval', 'approvals', {
    entity_type: str(40, false), entity_id: ref(false), status: enm(['pending', 'approved', 'rejected', 'canceled'], 'pending'), reason: str(500),
    requested_by_user_id: ref(), decided_by_user_id: ref(), decided_at: date(), comment: str(1000),
  }, ts);

  const CampaignMember = defineModel(sequelize, 'CampaignMember', 'campaign_members', {
    campaign_id: ref(false), lead_id: ref(), contact_id: ref(), status: enm(['added', 'sent', 'responded', 'converted', 'unsubscribed'], 'added'), responded_at: date(),
  }, ts);
  const Segment = defineModel(sequelize, 'Segment', 'segments', {
    name: str(120, false), entity_type: enm(['lead', 'contact']), filters: json({}), description: str(500), created_by_user_id: ref(),
  }, ts);
  const LeadForm = defineModel(sequelize, 'LeadForm', 'lead_forms', {
    name: str(120, false), public_key: str(40, false), fields: json([]), campaign_id: ref(), default_owner_id: ref(),
    lead_source: str(60, false, { defaultValue: 'web_form' }), success_message: str(500), redirect_url: str(500), consent_text: str(1000),
    require_consent: bool(false), allowed_origins: json([]), is_active: bool(true), submission_count: int({ allowNull: false, defaultValue: 0 }),
  }, { ...ts, soft: true });
  const FormSubmission = defineModel(sequelize, 'FormSubmission', 'form_submissions', {
    form_id: ref(false), lead_id: ref(), payload: json({}), ip: str(64), user_agent: str(400), referrer: str(500),
    status: enm(['accepted', 'rejected', 'spam'], 'accepted'), error: str(500),
  }, { ...ts, noUpdatedAt: true });
  const Consent = defineModel(sequelize, 'Consent', 'consents', {
    subject_type: enm(['lead', 'contact']), subject_id: ref(false), email: str(254), channel: enm(['email', 'sms', 'whatsapp', 'phone']),
    purpose: str(60, false, { defaultValue: 'marketing' }), status: enm(['granted', 'revoked']), source: str(60, false), consent_text: str(1000),
    ip: str(64), recorded_by_user_id: ref(),
  }, { ...ts, noUpdatedAt: true });

  const TicketCategory = defineModel(sequelize, 'TicketCategory', 'ticket_categories', {
    name: str(120, false), description: str(500), default_team_id: ref(), is_active: bool(true),
  }, ts);
  const SlaPolicy = defineModel(sequelize, 'SlaPolicy', 'sla_policies', {
    name: str(120, false), priority: enm(['low', 'normal', 'high', 'urgent']), first_response_minutes: int({ allowNull: false }),
    resolution_minutes: int({ allowNull: false }), escalate_to_user_id: ref(), is_active: bool(true),
  }, ts);
  const TicketComment = defineModel(sequelize, 'TicketComment', 'ticket_comments', {
    ticket_id: ref(false), author_user_id: ref(), body: { type: T.TEXT, allowNull: false }, is_internal: bool(false),
  }, ts);

  const Workflow = defineModel(sequelize, 'Workflow', 'workflows', {
    name: str(160, false), description: str(500), entity_type: str(40, false), trigger: json({}), conditions: json(null), actions: json([]),
    is_active: bool(true), next_run_at: date(), last_run_at: date(), run_count: int({ allowNull: false, defaultValue: 0 }),
    failure_count: int({ allowNull: false, defaultValue: 0 }), created_by_user_id: ref(),
  }, { ...ts, version: true });
  const WorkflowRun = defineModel(sequelize, 'WorkflowRun', 'workflow_runs', {
    workflow_id: ref(false), entity_type: str(40), entity_id: ref(), trigger_event: str(60, false), status: enm(['running', 'succeeded', 'failed', 'skipped']),
    attempt: int({ allowNull: false, defaultValue: 1 }), steps: json([]), error: str(1000), started_at: date(), finished_at: date(),
  }, ts);
  const Notification = defineModel(sequelize, 'Notification', 'notifications', {
    user_id: ref(false), type: str(60, false), title: str(200, false), body: str(1000), link: str(500), entity_type: str(40), entity_id: ref(), read_at: date(),
  }, ts);
  const NotificationPreference = defineModel(sequelize, 'NotificationPreference', 'notification_preferences', {
    user_id: ref(false), type: str(60, false), in_app: bool(true), email: bool(false),
  }, ts);
  const EmailTemplate = defineModel(sequelize, 'EmailTemplate', 'email_templates', {
    key: str(80, false), name: str(160, false), subject: str(300, false), body_html: { type: T.TEXT, allowNull: false }, body_text: text(),
    category: enm(['sales', 'marketing', 'support', 'system'], 'sales'), is_active: bool(true),
  }, { ...ts, version: true });
  const Communication = defineModel(sequelize, 'Communication', 'communications', {
    channel: enm(['email', 'sms', 'whatsapp']), direction: enm(['outbound', 'inbound'], 'outbound'), to_address: str(254, false), from_address: str(254),
    subject: str(300), body: text(), template_id: ref(), status: enm(['queued', 'sent', 'delivered', 'failed', 'blocked'], 'queued'),
    status_reason: str(500), provider: str(40), provider_message_id: str(200), attempts: int({ allowNull: false, defaultValue: 0 }),
    lead_id: ref(), contact_id: ref(), account_id: ref(), opportunity_id: ref(), ticket_id: ref(), sent_by_user_id: ref(), sent_at: date(),
  }, ts);
  const Report = defineModel(sequelize, 'Report', 'reports', {
    name: str(160, false), description: str(500), entity_type: str(40, false), report_type: enm(['table', 'summary'], 'summary'), columns: json([]),
    filters: json({}), group_by: str(80), date_field: str(80), date_range: json(null), metric: json(null),
    chart_type: enm(['bar', 'line', 'pie', 'table', 'funnel'], 'bar'), is_shared: bool(false), schedule: json(null), next_run_at: date(), owner_id: ref(false),
  }, { ...ts, version: true });
  const Import = defineModel(sequelize, 'Import', 'imports', {
    entity_type: str(40, false), status: enm(['uploaded', 'queued', 'processing', 'completed', 'failed', 'canceled'], 'uploaded'), filename: str(255, false),
    storage_key: str(500, false), headers: json([]), mapping: json({}), duplicate_strategy: enm(['skip', 'update', 'create'], 'skip'),
    total_rows: int({ allowNull: false, defaultValue: 0 }), processed_rows: int({ allowNull: false, defaultValue: 0 }),
    created_rows: int({ allowNull: false, defaultValue: 0 }), updated_rows: int({ allowNull: false, defaultValue: 0 }),
    skipped_rows: int({ allowNull: false, defaultValue: 0 }), error_rows: int({ allowNull: false, defaultValue: 0 }), errors: json([]),
    created_by_user_id: ref(false), started_at: date(), completed_at: date(),
  }, { ...ts, hidden: ['storage_key'] });
  const Attachment = defineModel(sequelize, 'Attachment', 'attachments', {
    entity_type: str(40, false), entity_id: ref(false), filename: str(255, false), mime_type: str(120, false), size_bytes: { type: T.BIGINT, allowNull: false },
    sha256: str(64, false), storage_driver: str(20, false), storage_key: str(500, false), uploaded_by_user_id: ref(),
  }, { ...ts, soft: true, hidden: ['storage_key', 'storage_driver'] });
  const IntegrationConnection = defineModel(sequelize, 'IntegrationConnection', 'integration_connections', {
    provider: str(40, false), name: str(120, false), status: enm(['not_configured', 'configured', 'connected', 'error', 'disabled'], 'not_configured'),
    config: json({}), credentials_encrypted: text(), inbound_key: str(40), last_tested_at: date(), last_error: str(1000), created_by_user_id: ref(),
  }, { ...ts, version: true, hidden: ['credentials_encrypted'] });
  const WebhookEndpoint = defineModel(sequelize, 'WebhookEndpoint', 'webhook_endpoints', {
    url: str(1000, false), description: str(255), events: json([]), secret_encrypted: str(512, false), is_active: bool(true),
    consecutive_failures: int({ allowNull: false, defaultValue: 0 }), disabled_reason: str(255), last_delivery_at: date(), created_by_user_id: ref(),
  }, { ...ts, hidden: ['secret_encrypted'] });
  const WebhookDelivery = defineModel(sequelize, 'WebhookDelivery', 'webhook_deliveries', {
    endpoint_id: ref(false), event_id: ref(false), event_type: str(80, false), payload: json({}), status: enm(['pending', 'succeeded', 'failed', 'dead'], 'pending'),
    attempts: int({ allowNull: false, defaultValue: 0 }), next_attempt_at: date(), response_status: int(), response_body: str(2000), error: str(1000), duration_ms: int(),
  }, ts);
  const IncomingWebhookEvent = defineModel(sequelize, 'IncomingWebhookEvent', 'incoming_webhook_events', {
    connection_id: ref(), provider: str(40, false), external_event_id: str(200, false), event_type: str(120),
    status: enm(['received', 'processed', 'failed', 'ignored'], 'received'), payload: json(), error: str(1000), processed_at: date(),
  }, ts);

  return {
    ProductCategory, Product, DiscountRule, OpportunityProduct, QuoteTemplate, Quote, QuoteLineItem, Approval, CampaignMember, Segment,
    LeadForm, FormSubmission, Consent, TicketCategory, SlaPolicy, TicketComment, Workflow, WorkflowRun, Notification, NotificationPreference,
    EmailTemplate, Communication, Report, Import, Attachment, IntegrationConnection, WebhookEndpoint, WebhookDelivery, IncomingWebhookEvent,
  };
};
