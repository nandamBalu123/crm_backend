'use strict';

const { ID, ref, createTenantTable } = require('../migrationHelpers');

module.exports = {
  async up(qi, S) {
    await createTenantTable(qi, S, 'workflows', {
      name: { type: S.STRING(160), allowNull: false },
      description: { type: S.STRING(500) },
      entity_type: { type: S.STRING(40), allowNull: false },
      trigger: { type: S.JSON, allowNull: false },
      conditions: { type: S.JSON },
      actions: { type: S.JSON, allowNull: false },
      is_active: { type: S.BOOLEAN, allowNull: false, defaultValue: true },
      next_run_at: { type: S.DATE(3) },
      last_run_at: { type: S.DATE(3) },
      run_count: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      failure_count: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      created_by_user_id: ref(),
    }, { version: true, indexes: [{ fields: ['tenant_id', 'entity_type', 'is_active'] }, { fields: ['is_active', 'next_run_at'], name: 'ix_workflows_schedule' }] });

    await createTenantTable(qi, S, 'workflow_runs', {
      workflow_id: ref(false),
      entity_type: { type: S.STRING(40) },
      entity_id: ref(),
      trigger_event: { type: S.STRING(60), allowNull: false },
      status: { type: S.ENUM('running', 'succeeded', 'failed', 'skipped'), allowNull: false },
      attempt: { type: S.INTEGER, allowNull: false, defaultValue: 1 },
      steps: { type: S.JSON },
      error: { type: S.STRING(1000) },
      started_at: { type: S.DATE(3) },
      finished_at: { type: S.DATE(3) },
    }, { indexes: [{ fields: ['tenant_id', 'workflow_id', 'created_at'] }, { fields: ['tenant_id', 'status', 'created_at'] }], fks: [['workflow_id', 'workflows']] });

    await createTenantTable(qi, S, 'notifications', {
      user_id: ref(false),
      type: { type: S.STRING(60), allowNull: false },
      title: { type: S.STRING(200), allowNull: false },
      body: { type: S.STRING(1000) },
      link: { type: S.STRING(500) },
      entity_type: { type: S.STRING(40) },
      entity_id: ref(),
      read_at: { type: S.DATE(3) },
    }, { indexes: [{ fields: ['tenant_id', 'user_id', 'read_at', 'created_at'] }], fks: [['user_id', 'tenant_memberships', 'user_id']] });

    await createTenantTable(qi, S, 'notification_preferences', {
      user_id: ref(false),
      type: { type: S.STRING(60), allowNull: false },
      in_app: { type: S.BOOLEAN, allowNull: false, defaultValue: true },
      email: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
    }, { indexes: [{ fields: ['tenant_id', 'user_id', 'type'], unique: true }], fks: [['user_id', 'tenant_memberships', 'user_id']] });

    await createTenantTable(qi, S, 'email_templates', {
      key: { type: S.STRING(80), allowNull: false },
      name: { type: S.STRING(160), allowNull: false },
      subject: { type: S.STRING(300), allowNull: false },
      body_html: { type: S.TEXT, allowNull: false },
      body_text: { type: S.TEXT },
      category: { type: S.ENUM('sales', 'marketing', 'support', 'system'), allowNull: false, defaultValue: 'sales' },
      is_active: { type: S.BOOLEAN, allowNull: false, defaultValue: true },
    }, { version: true, indexes: [{ fields: ['tenant_id', 'key'], unique: true }] });

    await createTenantTable(qi, S, 'communications', {
      channel: { type: S.ENUM('email', 'sms', 'whatsapp'), allowNull: false },
      direction: { type: S.ENUM('outbound', 'inbound'), allowNull: false, defaultValue: 'outbound' },
      to_address: { type: S.STRING(254), allowNull: false },
      from_address: { type: S.STRING(254) },
      subject: { type: S.STRING(300) },
      body: { type: S.TEXT },
      template_id: ref(),
      status: { type: S.ENUM('queued', 'sent', 'delivered', 'failed', 'blocked'), allowNull: false, defaultValue: 'queued' },
      status_reason: { type: S.STRING(500) },
      provider: { type: S.STRING(40) },
      provider_message_id: { type: S.STRING(200) },
      attempts: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      lead_id: ref(),
      contact_id: ref(),
      account_id: ref(),
      opportunity_id: ref(),
      ticket_id: ref(),
      sent_by_user_id: ref(),
      sent_at: { type: S.DATE(3) },
    }, {
      indexes: [
        { fields: ['tenant_id', 'contact_id', 'created_at'] },
        { fields: ['tenant_id', 'lead_id', 'created_at'] },
        { fields: ['tenant_id', 'account_id', 'created_at'] },
        { fields: ['tenant_id', 'status'] },
      ],
      fks: [['lead_id', 'leads'], ['contact_id', 'contacts'], ['account_id', 'accounts'], ['opportunity_id', 'opportunities'], ['ticket_id', 'tickets']],
    });

    await createTenantTable(qi, S, 'reports', {
      name: { type: S.STRING(160), allowNull: false },
      description: { type: S.STRING(500) },
      entity_type: { type: S.STRING(40), allowNull: false },
      report_type: { type: S.ENUM('table', 'summary'), allowNull: false, defaultValue: 'summary' },
      columns: { type: S.JSON },
      filters: { type: S.JSON },
      group_by: { type: S.STRING(80) },
      date_field: { type: S.STRING(80) },
      date_range: { type: S.JSON },
      metric: { type: S.JSON },
      chart_type: { type: S.ENUM('bar', 'line', 'pie', 'table', 'funnel'), allowNull: false, defaultValue: 'bar' },
      is_shared: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      schedule: { type: S.JSON },
      next_run_at: { type: S.DATE(3) },
      owner_id: ref(false),
    }, { version: true, indexes: [{ fields: ['tenant_id', 'owner_id'] }, { fields: ['next_run_at'], name: 'ix_reports_schedule' }], fks: [['owner_id', 'tenant_memberships', 'user_id']] });

    await createTenantTable(qi, S, 'imports', {
      entity_type: { type: S.STRING(40), allowNull: false },
      status: { type: S.ENUM('uploaded', 'queued', 'processing', 'completed', 'failed', 'canceled'), allowNull: false, defaultValue: 'uploaded' },
      filename: { type: S.STRING(255), allowNull: false },
      storage_key: { type: S.STRING(500), allowNull: false },
      headers: { type: S.JSON },
      mapping: { type: S.JSON },
      duplicate_strategy: { type: S.ENUM('skip', 'update', 'create'), allowNull: false, defaultValue: 'skip' },
      total_rows: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      processed_rows: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      created_rows: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      updated_rows: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      skipped_rows: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      error_rows: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      errors: { type: S.JSON },
      created_by_user_id: ref(false),
      started_at: { type: S.DATE(3) },
      completed_at: { type: S.DATE(3) },
    }, { indexes: [{ fields: ['tenant_id', 'created_at'] }] });

    await createTenantTable(qi, S, 'attachments', {
      entity_type: { type: S.STRING(40), allowNull: false },
      entity_id: { type: ID, allowNull: false },
      filename: { type: S.STRING(255), allowNull: false },
      mime_type: { type: S.STRING(120), allowNull: false },
      size_bytes: { type: S.BIGINT, allowNull: false },
      sha256: { type: S.CHAR(64), allowNull: false },
      storage_driver: { type: S.STRING(20), allowNull: false },
      storage_key: { type: S.STRING(500), allowNull: false },
      uploaded_by_user_id: ref(),
    }, { soft: true, indexes: [{ fields: ['tenant_id', 'entity_type', 'entity_id'] }, { fields: ['deleted_at'] }] });

    await createTenantTable(qi, S, 'integration_connections', {
      provider: { type: S.STRING(40), allowNull: false },
      name: { type: S.STRING(120), allowNull: false },
      status: { type: S.ENUM('not_configured', 'configured', 'connected', 'error', 'disabled'), allowNull: false, defaultValue: 'not_configured' },
      config: { type: S.JSON },
      credentials_encrypted: { type: S.TEXT },
      inbound_key: { type: S.STRING(40), unique: true },
      last_tested_at: { type: S.DATE(3) },
      last_error: { type: S.STRING(1000) },
      created_by_user_id: ref(),
    }, { version: true, indexes: [{ fields: ['tenant_id', 'provider'] }] });

    await createTenantTable(qi, S, 'webhook_endpoints', {
      url: { type: S.STRING(1000), allowNull: false },
      description: { type: S.STRING(255) },
      events: { type: S.JSON, allowNull: false },
      secret_encrypted: { type: S.STRING(512), allowNull: false },
      is_active: { type: S.BOOLEAN, allowNull: false, defaultValue: true },
      consecutive_failures: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      disabled_reason: { type: S.STRING(255) },
      last_delivery_at: { type: S.DATE(3) },
      created_by_user_id: ref(),
    }, { indexes: [{ fields: ['tenant_id', 'is_active'] }] });

    await createTenantTable(qi, S, 'webhook_deliveries', {
      endpoint_id: ref(false),
      event_id: { type: ID, allowNull: false },
      event_type: { type: S.STRING(80), allowNull: false },
      payload: { type: S.JSON, allowNull: false },
      status: { type: S.ENUM('pending', 'succeeded', 'failed', 'dead'), allowNull: false, defaultValue: 'pending' },
      attempts: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      next_attempt_at: { type: S.DATE(3) },
      response_status: { type: S.INTEGER },
      response_body: { type: S.STRING(2000) },
      error: { type: S.STRING(1000) },
      duration_ms: { type: S.INTEGER },
    }, {
      indexes: [{ fields: ['tenant_id', 'endpoint_id', 'created_at'] }, { fields: ['endpoint_id', 'event_id'], unique: true, name: 'uq_webhook_deliveries_event' }],
      fks: [['endpoint_id', 'webhook_endpoints']],
    });

    await createTenantTable(qi, S, 'incoming_webhook_events', {
      connection_id: ref(),
      provider: { type: S.STRING(40), allowNull: false },
      external_event_id: { type: S.STRING(200), allowNull: false },
      event_type: { type: S.STRING(120) },
      status: { type: S.ENUM('received', 'processed', 'failed', 'ignored'), allowNull: false, defaultValue: 'received' },
      payload: { type: S.JSON },
      error: { type: S.STRING(1000) },
      processed_at: { type: S.DATE(3) },
    }, {
      indexes: [{ fields: ['tenant_id', 'provider', 'external_event_id'], unique: true, name: 'uq_incoming_webhook_event' }],
      fks: [['connection_id', 'integration_connections']],
    });
  },

  async down(qi) {
    for (const t of [
      'incoming_webhook_events', 'webhook_deliveries', 'webhook_endpoints', 'integration_connections', 'attachments', 'imports',
      'reports', 'communications', 'email_templates', 'notification_preferences', 'notifications', 'workflow_runs', 'workflows',
    ]) {
      await qi.dropTable(t);
    }
  },
};
