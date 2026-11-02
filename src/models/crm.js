'use strict';

const { defineModel, T, ref, str, text, int, dec, bool, date, dateOnly, json, enm } = require('./define');

const address = () => ({
  address_line1: str(200), address_line2: str(200), city: str(120), state: str(120), postal_code: str(30), country: str(80),
});
const crm = { tenantScoped: true, soft: true, version: true };

module.exports = (sequelize) => {
  const CustomFieldDefinition = defineModel(sequelize, 'CustomFieldDefinition', 'custom_field_definitions', {
    entity_type: str(40, false), key: str(64, false), label: str(120, false),
    field_type: enm(['text', 'textarea', 'integer', 'decimal', 'currency', 'percent', 'boolean', 'date', 'datetime', 'select', 'multiselect', 'email', 'phone', 'url', 'user', 'file']),
    description: str(500), placeholder: str(200), section: str(80), is_required: bool(false), default_value: json(), validation: json({}), options: json([]),
    display_order: int({ allowNull: false, defaultValue: 0 }), is_active: bool(true), is_searchable: bool(false), is_filterable: bool(true),
    show_in_list: bool(false), archived_at: date(), created_by_user_id: ref(),
  }, { tenantScoped: true, version: true });

  const CustomFieldValue = defineModel(sequelize, 'CustomFieldValue', 'custom_field_values', {
    entity_type: str(40, false), entity_id: ref(false), field_id: ref(false), ordinal: int({ allowNull: false, defaultValue: 0 }),
    value_string: str(255), value_text: text(), value_number: dec(20, 6), value_date: date(), value_bool: { type: T.BOOLEAN },
  }, { tenantScoped: true });

  const Account = defineModel(sequelize, 'Account', 'accounts', {
    name: str(200, false), domain: str(253), website: str(500), industry: str(80),
    type: enm(['prospect', 'customer', 'partner', 'vendor', 'other'], 'prospect'), employees: int(), annual_revenue: dec(18, 2),
    phone: str(40), email: str(254), ...address(), description: text(), parent_account_id: ref(), owner_id: ref(), team_id: ref(), last_activity_at: date(),
  }, crm);

  const Contact = defineModel(sequelize, 'Contact', 'contacts', {
    account_id: ref(), first_name: str(80, false), last_name: str(80, false, { defaultValue: '' }), email: str(254), phone: str(40), mobile: str(40),
    title: str(120), department: str(120), lead_source: str(60), ...address(), linkedin_url: str(500), description: text(),
    email_opt_out: bool(false), sms_opt_out: bool(false), do_not_call: bool(false), owner_id: ref(), team_id: ref(),
    converted_from_lead_id: ref(), last_activity_at: date(),
  }, crm);

  const Pipeline = defineModel(sequelize, 'Pipeline', 'pipelines', {
    name: str(120, false), is_default: bool(false), is_active: bool(true), display_order: int({ allowNull: false, defaultValue: 0 }),
  }, { tenantScoped: true });

  const PipelineStage = defineModel(sequelize, 'PipelineStage', 'pipeline_stages', {
    pipeline_id: ref(false), name: str(120, false), probability: int({ allowNull: false, defaultValue: 0 }), category: enm(['open', 'won', 'lost'], 'open'),
    display_order: int({ allowNull: false, defaultValue: 0 }), rotting_days: int(), is_active: bool(true),
  }, { tenantScoped: true });

  const Campaign = defineModel(sequelize, 'Campaign', 'campaigns', {
    name: str(200, false), type: enm(['email', 'event', 'webinar', 'advertising', 'social', 'referral', 'other'], 'other'),
    status: enm(['planned', 'active', 'completed', 'aborted'], 'planned'), source: str(80), start_date: dateOnly(), end_date: dateOnly(),
    budget: dec(), actual_cost: dec(), expected_revenue: dec(), currency: str(3), description: text(), owner_id: ref(),
  }, crm);

  const Lead = defineModel(sequelize, 'Lead', 'leads', {
    first_name: str(80), last_name: str(80, false), email: str(254), phone: str(40), company: str(200), title: str(120), website: str(500),
    industry: str(80), employees: int(), annual_revenue: dec(), source: str(60),
    status: enm(['new', 'contacted', 'nurturing', 'qualified', 'unqualified', 'converted'], 'new'), rating: enm(['hot', 'warm', 'cold']),
    score: int({ allowNull: false, defaultValue: 0 }), ...address(), description: text(), email_opt_out: bool(false),
    owner_id: ref(), team_id: ref(), campaign_id: ref(), next_follow_up_at: date(), last_activity_at: date(), converted_at: date(),
    converted_by_user_id: ref(), converted_contact_id: ref(), converted_account_id: ref(), converted_opportunity_id: ref(),
  }, crm);

  const Opportunity = defineModel(sequelize, 'Opportunity', 'opportunities', {
    name: str(200, false), account_id: ref(), contact_id: ref(), pipeline_id: ref(false), stage_id: ref(false),
    amount: dec(18, 2, { allowNull: false, defaultValue: '0.00' }), currency: str(3, false, { defaultValue: 'USD' }),
    probability: int({ allowNull: false, defaultValue: 0 }), expected_close_date: dateOnly(), status: enm(['open', 'won', 'lost'], 'open'),
    forecast_category: enm(['pipeline', 'best_case', 'commit', 'closed', 'omitted'], 'pipeline'), closed_at: date(), win_reason: str(255),
    loss_reason: str(255), next_step: str(255), description: text(), owner_id: ref(), team_id: ref(), campaign_id: ref(), lead_id: ref(),
    stage_entered_at: date(), last_activity_at: date(),
  }, crm);

  const OpportunityStageHistory = defineModel(sequelize, 'OpportunityStageHistory', 'opportunity_stage_history', {
    opportunity_id: ref(false), from_stage_id: ref(), to_stage_id: ref(false), amount: dec(), probability: int(),
    time_in_previous_stage_seconds: int(), changed_by_user_id: ref(),
  }, { tenantScoped: true, noUpdatedAt: true });

  const Ticket = defineModel(sequelize, 'Ticket', 'tickets', {
    number: int({ allowNull: false }), subject: str(255, false), description: text(),
    status: enm(['new', 'open', 'pending', 'on_hold', 'resolved', 'closed'], 'new'), priority: enm(['low', 'normal', 'high', 'urgent'], 'normal'),
    channel: enm(['email', 'phone', 'web', 'chat', 'other'], 'web'), category_id: ref(), contact_id: ref(), account_id: ref(), owner_id: ref(),
    team_id: ref(), sla_policy_id: ref(), first_response_due_at: date(), resolution_due_at: date(), first_responded_at: date(),
    resolved_at: date(), closed_at: date(), escalation_level: int({ allowNull: false, defaultValue: 0 }), escalated_at: date(),
    sla_breached: bool(false), last_activity_at: date(),
  }, crm);

  const Activity = defineModel(sequelize, 'Activity', 'activities', {
    type: enm(['task', 'call', 'meeting', 'note', 'email']), subject: str(255, false), description: text(),
    status: enm(['open', 'completed', 'canceled'], 'open'), priority: enm(['low', 'normal', 'high'], 'normal'),
    due_at: date(), start_at: date(), end_at: date(), all_day: bool(false), location: str(255), call_direction: enm(['inbound', 'outbound']),
    call_outcome: str(80), duration_minutes: int(), reminder_at: date(), reminder_sent_at: date(), recurrence: json(), recurrence_parent_id: ref(),
    completed_at: date(), completed_by_user_id: ref(), owner_id: ref(), created_by_user_id: ref(), lead_id: ref(), contact_id: ref(),
    account_id: ref(), opportunity_id: ref(), ticket_id: ref(), external_calendar_event_id: str(255),
  }, crm);

  const TimelineEvent = defineModel(sequelize, 'TimelineEvent', 'timeline_events', {
    entity_type: str(40, false), entity_id: ref(false), event_type: str(60, false), summary: str(500, false), data: json(), actor_user_id: ref(),
  }, { tenantScoped: true, noUpdatedAt: true });

  const RecordAssignment = defineModel(sequelize, 'RecordAssignment', 'record_assignments', {
    entity_type: str(40, false), entity_id: ref(false), from_owner_id: ref(), to_owner_id: ref(), assigned_by_user_id: ref(), reason: str(255),
  }, { tenantScoped: true, noUpdatedAt: true });

  const SavedView = defineModel(sequelize, 'SavedView', 'saved_views', {
    user_id: ref(false), entity_type: str(40, false), name: str(120, false), filters: json({}), sort: str(80), columns: json([]),
    is_shared: bool(false), is_default: bool(false),
  }, { tenantScoped: true });

  return {
    CustomFieldDefinition, CustomFieldValue, Account, Contact, Pipeline, PipelineStage, Campaign, Lead, Opportunity,
    OpportunityStageHistory, Ticket, Activity, TimelineEvent, RecordAssignment, SavedView,
  };
};
