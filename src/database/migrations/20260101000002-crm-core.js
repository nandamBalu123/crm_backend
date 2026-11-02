'use strict';

const { ID, ref, createTenantTable, addTenantFk, address, shortName } = require('../migrationHelpers');

const OWNER = ['owner_id', 'tenant_memberships', 'user_id'];

module.exports = {
  async up(qi, S) {
    const FIELD_TYPES = [
      'text', 'textarea', 'integer', 'decimal', 'currency', 'percent', 'boolean', 'date', 'datetime',
      'select', 'multiselect', 'email', 'phone', 'url', 'user', 'file',
    ];

    await createTenantTable(qi, S, 'custom_field_definitions', {
      entity_type: { type: S.STRING(40), allowNull: false },
      key: { type: S.STRING(64), allowNull: false },
      label: { type: S.STRING(120), allowNull: false },
      field_type: { type: S.ENUM(...FIELD_TYPES), allowNull: false },
      description: { type: S.STRING(500) },
      placeholder: { type: S.STRING(200) },
      section: { type: S.STRING(80) },
      is_required: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      default_value: { type: S.JSON },
      validation: { type: S.JSON },
      options: { type: S.JSON },
      display_order: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      is_active: { type: S.BOOLEAN, allowNull: false, defaultValue: true },
      is_searchable: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      is_filterable: { type: S.BOOLEAN, allowNull: false, defaultValue: true },
      show_in_list: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      archived_at: { type: S.DATE(3) },
      created_by_user_id: ref(),
    }, {
      version: true,
      indexes: [{ fields: ['tenant_id', 'entity_type', 'key'], unique: true }, { fields: ['tenant_id', 'entity_type', 'is_active', 'display_order'] }],
    });

    await createTenantTable(qi, S, 'custom_field_values', {
      entity_type: { type: S.STRING(40), allowNull: false },
      entity_id: { type: ID, allowNull: false },
      field_id: ref(false),
      ordinal: { type: S.SMALLINT, allowNull: false, defaultValue: 0 },
      value_string: { type: S.STRING(255) },
      value_text: { type: S.TEXT },
      value_number: { type: S.DECIMAL(20, 6) },
      value_date: { type: S.DATE(3) },
      value_bool: { type: S.BOOLEAN },
    }, {
      indexes: [
        { fields: ['tenant_id', 'entity_id', 'field_id', 'ordinal'], unique: true, name: 'uq_cfv_entity_field' },
        { fields: ['tenant_id', 'field_id', 'value_string'], name: 'ix_cfv_string' },
        { fields: ['tenant_id', 'field_id', 'value_number'], name: 'ix_cfv_number' },
        { fields: ['tenant_id', 'field_id', 'value_date'], name: 'ix_cfv_date' },
        { fields: ['tenant_id', 'field_id', 'value_bool'], name: 'ix_cfv_bool' },
      ],
      fks: [['field_id', 'custom_field_definitions']],
    });

    await createTenantTable(qi, S, 'accounts', {
      name: { type: S.STRING(200), allowNull: false },
      domain: { type: S.STRING(253) },
      website: { type: S.STRING(500) },
      industry: { type: S.STRING(80) },
      type: { type: S.ENUM('prospect', 'customer', 'partner', 'vendor', 'other'), allowNull: false, defaultValue: 'prospect' },
      employees: { type: S.INTEGER },
      annual_revenue: { type: S.DECIMAL(18, 2) },
      phone: { type: S.STRING(40) },
      email: { type: S.STRING(254) },
      ...address(S),
      description: { type: S.TEXT },
      parent_account_id: ref(),
      owner_id: ref(),
      team_id: ref(),
      last_activity_at: { type: S.DATE(3) },
    }, {
      soft: true,
      version: true,
      indexes: [
        { fields: ['tenant_id', 'deleted_at', 'name'] },
        { fields: ['tenant_id', 'owner_id'] },
        { fields: ['tenant_id', 'domain'] },
        { fields: ['tenant_id', 'parent_account_id'] },
        { fields: ['tenant_id', 'created_at'] },
      ],
      fks: [['parent_account_id', 'accounts'], OWNER, ['team_id', 'teams']],
    });

    await createTenantTable(qi, S, 'contacts', {
      account_id: ref(),
      first_name: { type: S.STRING(80), allowNull: false },
      last_name: { type: S.STRING(80), allowNull: false, defaultValue: '' },
      email: { type: S.STRING(254) },
      phone: { type: S.STRING(40) },
      mobile: { type: S.STRING(40) },
      title: { type: S.STRING(120) },
      department: { type: S.STRING(120) },
      lead_source: { type: S.STRING(60) },
      ...address(S),
      linkedin_url: { type: S.STRING(500) },
      description: { type: S.TEXT },
      email_opt_out: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      sms_opt_out: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      do_not_call: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      owner_id: ref(),
      team_id: ref(),
      converted_from_lead_id: ref(),
      last_activity_at: { type: S.DATE(3) },
    }, {
      soft: true,
      version: true,
      indexes: [
        { fields: ['tenant_id', 'email'] },
        { fields: ['tenant_id', 'account_id'] },
        { fields: ['tenant_id', 'deleted_at', 'last_name', 'first_name'] },
        { fields: ['tenant_id', 'owner_id'] },
        { fields: ['tenant_id', 'created_at'] },
      ],
      fks: [['account_id', 'accounts'], OWNER, ['team_id', 'teams']],
    });

    await createTenantTable(qi, S, 'pipelines', {
      name: { type: S.STRING(120), allowNull: false },
      is_default: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      is_active: { type: S.BOOLEAN, allowNull: false, defaultValue: true },
      display_order: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
    }, { indexes: [{ fields: ['tenant_id', 'name'], unique: true }] });

    await createTenantTable(qi, S, 'pipeline_stages', {
      pipeline_id: ref(false),
      name: { type: S.STRING(120), allowNull: false },
      probability: { type: S.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
      category: { type: S.ENUM('open', 'won', 'lost'), allowNull: false, defaultValue: 'open' },
      display_order: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      rotting_days: { type: S.INTEGER },
      is_active: { type: S.BOOLEAN, allowNull: false, defaultValue: true },
    }, { indexes: [{ fields: ['tenant_id', 'pipeline_id', 'display_order'] }], fks: [['pipeline_id', 'pipelines']] });

    await createTenantTable(qi, S, 'campaigns', {
      name: { type: S.STRING(200), allowNull: false },
      type: { type: S.ENUM('email', 'event', 'webinar', 'advertising', 'social', 'referral', 'other'), allowNull: false, defaultValue: 'other' },
      status: { type: S.ENUM('planned', 'active', 'completed', 'aborted'), allowNull: false, defaultValue: 'planned' },
      source: { type: S.STRING(80) },
      start_date: { type: S.DATEONLY },
      end_date: { type: S.DATEONLY },
      budget: { type: S.DECIMAL(18, 2) },
      actual_cost: { type: S.DECIMAL(18, 2) },
      expected_revenue: { type: S.DECIMAL(18, 2) },
      currency: { type: S.CHAR(3) },
      description: { type: S.TEXT },
      owner_id: ref(),
    }, {
      soft: true,
      version: true,
      indexes: [{ fields: ['tenant_id', 'status'] }, { fields: ['tenant_id', 'created_at'] }],
      fks: [OWNER],
    });

    await createTenantTable(qi, S, 'leads', {
      first_name: { type: S.STRING(80) },
      last_name: { type: S.STRING(80), allowNull: false },
      email: { type: S.STRING(254) },
      phone: { type: S.STRING(40) },
      company: { type: S.STRING(200) },
      title: { type: S.STRING(120) },
      website: { type: S.STRING(500) },
      industry: { type: S.STRING(80) },
      employees: { type: S.INTEGER },
      annual_revenue: { type: S.DECIMAL(18, 2) },
      source: { type: S.STRING(60) },
      status: { type: S.ENUM('new', 'contacted', 'nurturing', 'qualified', 'unqualified', 'converted'), allowNull: false, defaultValue: 'new' },
      rating: { type: S.ENUM('hot', 'warm', 'cold') },
      score: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      ...address(S),
      description: { type: S.TEXT },
      email_opt_out: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      owner_id: ref(),
      team_id: ref(),
      campaign_id: ref(),
      next_follow_up_at: { type: S.DATE(3) },
      last_activity_at: { type: S.DATE(3) },
      converted_at: { type: S.DATE(3) },
      converted_by_user_id: ref(),
      converted_contact_id: ref(),
      converted_account_id: ref(),
      converted_opportunity_id: ref(),
    }, {
      soft: true,
      version: true,
      indexes: [
        { fields: ['tenant_id', 'status', 'created_at'] },
        { fields: ['tenant_id', 'owner_id', 'status'] },
        { fields: ['tenant_id', 'email'] },
        { fields: ['tenant_id', 'company'] },
        { fields: ['tenant_id', 'last_name', 'first_name'] },
        { fields: ['tenant_id', 'source'] },
        { fields: ['tenant_id', 'campaign_id'] },
        { fields: ['tenant_id', 'next_follow_up_at'] },
      ],
      fks: [OWNER, ['team_id', 'teams'], ['campaign_id', 'campaigns'], ['converted_contact_id', 'contacts'], ['converted_account_id', 'accounts']],
    });

    await createTenantTable(qi, S, 'opportunities', {
      name: { type: S.STRING(200), allowNull: false },
      account_id: ref(),
      contact_id: ref(),
      pipeline_id: ref(false),
      stage_id: ref(false),
      amount: { type: S.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
      currency: { type: S.CHAR(3), allowNull: false, defaultValue: 'USD' },
      probability: { type: S.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
      expected_close_date: { type: S.DATEONLY },
      status: { type: S.ENUM('open', 'won', 'lost'), allowNull: false, defaultValue: 'open' },
      forecast_category: { type: S.ENUM('pipeline', 'best_case', 'commit', 'closed', 'omitted'), allowNull: false, defaultValue: 'pipeline' },
      closed_at: { type: S.DATE(3) },
      win_reason: { type: S.STRING(255) },
      loss_reason: { type: S.STRING(255) },
      next_step: { type: S.STRING(255) },
      description: { type: S.TEXT },
      owner_id: ref(),
      team_id: ref(),
      campaign_id: ref(),
      lead_id: ref(),
      stage_entered_at: { type: S.DATE(3) },
      last_activity_at: { type: S.DATE(3) },
    }, {
      soft: true,
      version: true,
      indexes: [
        { fields: ['tenant_id', 'pipeline_id', 'stage_id'] },
        { fields: ['tenant_id', 'owner_id', 'status'] },
        { fields: ['tenant_id', 'status', 'expected_close_date'] },
        { fields: ['tenant_id', 'status', 'closed_at'] },
        { fields: ['tenant_id', 'account_id'] },
        { fields: ['tenant_id', 'contact_id'] },
        { fields: ['tenant_id', 'campaign_id'] },
      ],
      fks: [
        ['account_id', 'accounts'], ['contact_id', 'contacts'], ['pipeline_id', 'pipelines'], ['stage_id', 'pipeline_stages'],
        OWNER, ['team_id', 'teams'], ['campaign_id', 'campaigns'], ['lead_id', 'leads'],
      ],
    });
    await addTenantFk(qi, 'leads', 'converted_opportunity_id', 'opportunities');

    await createTenantTable(qi, S, 'opportunity_stage_history', {
      opportunity_id: ref(false),
      from_stage_id: ref(),
      to_stage_id: ref(false),
      amount: { type: S.DECIMAL(18, 2) },
      probability: { type: S.TINYINT.UNSIGNED },
      time_in_previous_stage_seconds: { type: S.INTEGER },
      changed_by_user_id: ref(),
    }, {
      noUpdatedAt: true,
      indexes: [{ fields: ['tenant_id', 'opportunity_id', 'created_at'] }, { fields: ['tenant_id', 'to_stage_id', 'created_at'] }],
      fks: [['opportunity_id', 'opportunities'], ['to_stage_id', 'pipeline_stages']],
    });

    await createTenantTable(qi, S, 'tickets', {
      number: { type: S.INTEGER, allowNull: false },
      subject: { type: S.STRING(255), allowNull: false },
      description: { type: S.TEXT },
      status: { type: S.ENUM('new', 'open', 'pending', 'on_hold', 'resolved', 'closed'), allowNull: false, defaultValue: 'new' },
      priority: { type: S.ENUM('low', 'normal', 'high', 'urgent'), allowNull: false, defaultValue: 'normal' },
      channel: { type: S.ENUM('email', 'phone', 'web', 'chat', 'other'), allowNull: false, defaultValue: 'web' },
      category_id: ref(),
      contact_id: ref(),
      account_id: ref(),
      owner_id: ref(),
      team_id: ref(),
      sla_policy_id: ref(),
      first_response_due_at: { type: S.DATE(3) },
      resolution_due_at: { type: S.DATE(3) },
      first_responded_at: { type: S.DATE(3) },
      resolved_at: { type: S.DATE(3) },
      closed_at: { type: S.DATE(3) },
      escalation_level: { type: S.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
      escalated_at: { type: S.DATE(3) },
      sla_breached: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      last_activity_at: { type: S.DATE(3) },
    }, {
      soft: true,
      version: true,
      indexes: [
        { fields: ['tenant_id', 'number'], unique: true },
        { fields: ['tenant_id', 'status', 'priority'] },
        { fields: ['tenant_id', 'owner_id', 'status'] },
        { fields: ['tenant_id', 'contact_id'] },
        { fields: ['tenant_id', 'account_id'] },
        { fields: ['status', 'resolution_due_at'], name: 'ix_tickets_sla_scan' },
      ],
      fks: [['contact_id', 'contacts'], ['account_id', 'accounts'], OWNER, ['team_id', 'teams']],
    });

    await createTenantTable(qi, S, 'activities', {
      type: { type: S.ENUM('task', 'call', 'meeting', 'note', 'email'), allowNull: false },
      subject: { type: S.STRING(255), allowNull: false },
      description: { type: S.TEXT },
      status: { type: S.ENUM('open', 'completed', 'canceled'), allowNull: false, defaultValue: 'open' },
      priority: { type: S.ENUM('low', 'normal', 'high'), allowNull: false, defaultValue: 'normal' },
      due_at: { type: S.DATE(3) },
      start_at: { type: S.DATE(3) },
      end_at: { type: S.DATE(3) },
      all_day: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      location: { type: S.STRING(255) },
      call_direction: { type: S.ENUM('inbound', 'outbound') },
      call_outcome: { type: S.STRING(80) },
      duration_minutes: { type: S.INTEGER },
      reminder_at: { type: S.DATE(3) },
      reminder_sent_at: { type: S.DATE(3) },
      recurrence: { type: S.JSON },
      recurrence_parent_id: ref(),
      completed_at: { type: S.DATE(3) },
      completed_by_user_id: ref(),
      owner_id: ref(),
      created_by_user_id: ref(),
      lead_id: ref(),
      contact_id: ref(),
      account_id: ref(),
      opportunity_id: ref(),
      ticket_id: ref(),
      external_calendar_event_id: { type: S.STRING(255) },
    }, {
      soft: true,
      version: true,
      indexes: [
        { fields: ['tenant_id', 'owner_id', 'status', 'due_at'] },
        { fields: ['tenant_id', 'status', 'due_at'] },
        { fields: ['tenant_id', 'lead_id'] },
        { fields: ['tenant_id', 'contact_id'] },
        { fields: ['tenant_id', 'account_id'] },
        { fields: ['tenant_id', 'opportunity_id'] },
        { fields: ['tenant_id', 'ticket_id'] },
        { fields: ['reminder_at', 'reminder_sent_at'], name: 'ix_activities_reminders' },
      ],
      fks: [
        OWNER, ['lead_id', 'leads'], ['contact_id', 'contacts'], ['account_id', 'accounts'],
        ['opportunity_id', 'opportunities'], ['ticket_id', 'tickets'], ['recurrence_parent_id', 'activities'],
      ],
    });

    await createTenantTable(qi, S, 'timeline_events', {
      entity_type: { type: S.STRING(40), allowNull: false },
      entity_id: { type: ID, allowNull: false },
      event_type: { type: S.STRING(60), allowNull: false },
      summary: { type: S.STRING(500), allowNull: false },
      data: { type: S.JSON },
      actor_user_id: ref(),
    }, { noUpdatedAt: true, indexes: [{ fields: ['tenant_id', 'entity_type', 'entity_id', 'created_at'] }, { fields: ['tenant_id', 'created_at'] }] });

    await createTenantTable(qi, S, 'record_assignments', {
      entity_type: { type: S.STRING(40), allowNull: false },
      entity_id: { type: ID, allowNull: false },
      from_owner_id: ref(),
      to_owner_id: ref(),
      assigned_by_user_id: ref(),
      reason: { type: S.STRING(255) },
    }, { noUpdatedAt: true, indexes: [{ fields: ['tenant_id', 'entity_type', 'entity_id', 'created_at'] }] });

    await createTenantTable(qi, S, 'saved_views', {
      user_id: ref(false),
      entity_type: { type: S.STRING(40), allowNull: false },
      name: { type: S.STRING(120), allowNull: false },
      filters: { type: S.JSON },
      sort: { type: S.STRING(80) },
      columns: { type: S.JSON },
      is_shared: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      is_default: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
    }, { indexes: [{ fields: ['tenant_id', 'entity_type', 'user_id'] }], fks: [['user_id', 'tenant_memberships', 'user_id']] });
  },

  async down(qi) {
    await qi.removeConstraint('leads', shortName('fk', 'leads', ['converted_opportunity_id']));
    for (const t of [
      'saved_views', 'record_assignments', 'timeline_events', 'activities', 'tickets', 'opportunity_stage_history',
      'opportunities', 'leads', 'campaigns', 'pipeline_stages', 'pipelines', 'contacts', 'accounts',
      'custom_field_values', 'custom_field_definitions',
    ]) {
      await qi.dropTable(t);
    }
  },
};
