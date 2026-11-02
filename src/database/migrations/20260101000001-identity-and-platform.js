'use strict';

const { ID, pk, ref, timestamps, createTenantTable } = require('../migrationHelpers');

module.exports = {
  async up(qi, S) {
    const opts = { charset: 'utf8mb4', collate: 'utf8mb4_0900_ai_ci', engine: 'InnoDB' };

    await qi.createTable('plans', {
      id: pk(),
      code: { type: S.STRING(40), allowNull: false, unique: true },
      name: { type: S.STRING(80), allowNull: false },
      description: { type: S.STRING(500) },
      price_monthly: { type: S.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      currency: { type: S.CHAR(3), allowNull: false, defaultValue: 'USD' },
      limits: { type: S.JSON, allowNull: false },
      features: { type: S.JSON, allowNull: false },
      is_active: { type: S.BOOLEAN, allowNull: false, defaultValue: true },
      sort_order: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      ...timestamps(S),
    }, opts);

    await qi.createTable('tenants', {
      id: pk(),
      name: { type: S.STRING(160), allowNull: false },
      slug: { type: S.STRING(63), allowNull: false, unique: true },
      status: { type: S.ENUM('active', 'suspended', 'pending_deletion'), allowNull: false, defaultValue: 'active' },
      plan_id: { type: ID, references: { model: 'plans', key: 'id' }, onDelete: 'RESTRICT' },
      owner_user_id: ref(),
      suspended_at: { type: S.DATE(3) },
      suspended_reason: { type: S.STRING(500) },
      data_region: { type: S.STRING(40), allowNull: false, defaultValue: 'default' },
      ...timestamps(S),
    }, opts);
    await qi.addIndex('tenants', ['status'], { name: 'ix_tenants_status' });

    await qi.createTable('users', {
      id: pk(),
      email: { type: S.STRING(254), allowNull: false, unique: true },
      password_hash: { type: S.STRING(255), allowNull: false },
      first_name: { type: S.STRING(80), allowNull: false },
      last_name: { type: S.STRING(80), allowNull: false, defaultValue: '' },
      avatar_url: { type: S.STRING(500) },
      phone: { type: S.STRING(40) },
      email_verified_at: { type: S.DATE(3) },
      is_platform_admin: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      status: { type: S.ENUM('active', 'disabled'), allowNull: false, defaultValue: 'active' },
      failed_login_count: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      locked_until: { type: S.DATE(3) },
      last_login_at: { type: S.DATE(3) },
      password_changed_at: { type: S.DATE(3) },
      mfa_enabled: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      mfa_secret_encrypted: { type: S.STRING(512) },
      mfa_pending_secret_encrypted: { type: S.STRING(512) },
      mfa_recovery_codes: { type: S.JSON },
      mfa_last_used_step: { type: S.BIGINT },
      locale: { type: S.STRING(16) },
      timezone: { type: S.STRING(64) },
      ...timestamps(S),
    }, opts);

    await qi.createTable('tenant_domains', {
      id: pk(),
      tenant_id: { type: ID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'RESTRICT' },
      domain: { type: S.STRING(253), allowNull: false, unique: true },
      is_primary: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      verification_token: { type: S.STRING(80) },
      verified_at: { type: S.DATE(3) },
      ...timestamps(S),
    }, opts);
    await qi.addIndex('tenant_domains', ['tenant_id'], { name: 'ix_tenant_domains_tenant' });

    await createTenantTable(qi, S, 'tenant_memberships', {
      user_id: { type: ID, allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' },
      status: { type: S.ENUM('active', 'disabled'), allowNull: false, defaultValue: 'active' },
      is_owner: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      title: { type: S.STRING(120) },
      joined_at: { type: S.DATE(3) },
      last_active_at: { type: S.DATE(3) },
    }, { indexes: [{ fields: ['tenant_id', 'user_id'], unique: true }, { fields: ['user_id'] }] });

    await qi.createTable('permissions', {
      id: pk(),
      key: { type: S.STRING(80), allowNull: false, unique: true },
      module: { type: S.STRING(40), allowNull: false },
      action: { type: S.STRING(40), allowNull: false },
      description: { type: S.STRING(255) },
      supports_scope: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      sort_order: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      ...timestamps(S),
    }, opts);

    await createTenantTable(qi, S, 'roles', {
      key: { type: S.STRING(60), allowNull: false },
      name: { type: S.STRING(80), allowNull: false },
      description: { type: S.STRING(255) },
      is_system: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      is_protected: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      is_active: { type: S.BOOLEAN, allowNull: false, defaultValue: true },
      cloned_from_id: ref(),
    }, { indexes: [{ fields: ['tenant_id', 'key'], unique: true }] });

    await createTenantTable(qi, S, 'role_permissions', {
      role_id: ref(false),
      permission_id: { type: ID, allowNull: false, references: { model: 'permissions', key: 'id' }, onDelete: 'RESTRICT' },
      scope: { type: S.ENUM('own', 'team', 'all'), allowNull: false, defaultValue: 'all' },
    }, { indexes: [{ fields: ['role_id', 'permission_id'], unique: true }], fks: [['role_id', 'roles']] });

    await createTenantTable(qi, S, 'membership_roles', {
      membership_id: ref(false),
      role_id: ref(false),
    }, {
      indexes: [{ fields: ['membership_id', 'role_id'], unique: true }, { fields: ['tenant_id', 'role_id'] }],
      fks: [['membership_id', 'tenant_memberships'], ['role_id', 'roles']],
    });

    await createTenantTable(qi, S, 'field_permissions', {
      role_id: ref(false),
      entity_type: { type: S.STRING(40), allowNull: false },
      field_key: { type: S.STRING(80), allowNull: false },
      access: { type: S.ENUM('hidden', 'read'), allowNull: false },
    }, { indexes: [{ fields: ['role_id', 'entity_type', 'field_key'], unique: true }], fks: [['role_id', 'roles']] });

    await createTenantTable(qi, S, 'teams', {
      name: { type: S.STRING(120), allowNull: false },
      description: { type: S.STRING(255) },
      manager_user_id: ref(),
    }, { indexes: [{ fields: ['tenant_id', 'name'], unique: true }], fks: [['manager_user_id', 'tenant_memberships', 'user_id']] });

    await createTenantTable(qi, S, 'team_members', {
      team_id: ref(false),
      user_id: ref(false),
    }, {
      indexes: [{ fields: ['team_id', 'user_id'], unique: true }, { fields: ['tenant_id', 'user_id'] }],
      fks: [['team_id', 'teams'], ['user_id', 'tenant_memberships', 'user_id']],
    });

    await qi.createTable('user_sessions', {
      id: pk(),
      user_id: { type: ID, allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'CASCADE' },
      active_tenant_id: { type: ID, references: { model: 'tenants', key: 'id' }, onDelete: 'SET NULL' },
      refresh_token_hash: { type: S.CHAR(64), allowNull: false, unique: true },
      previous_token_hash: { type: S.CHAR(64) },
      user_agent: { type: S.STRING(400) },
      ip: { type: S.STRING(64) },
      mfa_verified: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      last_used_at: { type: S.DATE(3) },
      rotated_at: { type: S.DATE(3) },
      expires_at: { type: S.DATE(3), allowNull: false },
      revoked_at: { type: S.DATE(3) },
      revoked_reason: { type: S.STRING(80) },
      ...timestamps(S),
    }, opts);
    await qi.addIndex('user_sessions', ['user_id', 'revoked_at'], { name: 'ix_user_sessions_user' });
    await qi.addIndex('user_sessions', ['previous_token_hash'], { name: 'ix_user_sessions_prev' });

    await qi.createTable('user_tokens', {
      id: pk(),
      user_id: { type: ID, allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'CASCADE' },
      type: { type: S.ENUM('email_verification', 'password_reset'), allowNull: false },
      token_hash: { type: S.CHAR(64), allowNull: false, unique: true },
      expires_at: { type: S.DATE(3), allowNull: false },
      used_at: { type: S.DATE(3) },
      ...timestamps(S),
    }, opts);
    await qi.addIndex('user_tokens', ['user_id', 'type'], { name: 'ix_user_tokens_user_type' });

    await createTenantTable(qi, S, 'invitations', {
      email: { type: S.STRING(254), allowNull: false },
      role_ids: { type: S.JSON, allowNull: false },
      team_ids: { type: S.JSON },
      token_hash: { type: S.CHAR(64), allowNull: false, unique: true },
      status: { type: S.ENUM('pending', 'accepted', 'revoked'), allowNull: false, defaultValue: 'pending' },
      invited_by_user_id: ref(),
      expires_at: { type: S.DATE(3), allowNull: false },
      accepted_at: { type: S.DATE(3) },
      accepted_user_id: ref(),
    }, { indexes: [{ fields: ['tenant_id', 'email'] }, { fields: ['tenant_id', 'status'] }] });

    await createTenantTable(qi, S, 'tenant_settings', {
      branding: { type: S.JSON },
      locale: { type: S.STRING(16), allowNull: false, defaultValue: 'en-US' },
      timezone: { type: S.STRING(64), allowNull: false, defaultValue: 'UTC' },
      currency: { type: S.CHAR(3), allowNull: false, defaultValue: 'USD' },
      date_format: { type: S.STRING(20), allowNull: false, defaultValue: 'yyyy-MM-dd' },
      fiscal_year_start_month: { type: S.TINYINT, allowNull: false, defaultValue: 1 },
      security: { type: S.JSON },
      modules: { type: S.JSON },
      preferences: { type: S.JSON },
    }, { indexes: [{ fields: ['tenant_id'], unique: true, name: 'uq_tenant_settings_tenant' }] });

    await createTenantTable(qi, S, 'tenant_subscriptions', {
      plan_id: { type: ID, allowNull: false, references: { model: 'plans', key: 'id' }, onDelete: 'RESTRICT' },
      status: { type: S.ENUM('trialing', 'active', 'past_due', 'canceled', 'suspended'), allowNull: false, defaultValue: 'trialing' },
      provider: { type: S.ENUM('manual', 'stripe', 'razorpay'), allowNull: false, defaultValue: 'manual' },
      provider_customer_id: { type: S.STRING(120) },
      provider_subscription_id: { type: S.STRING(120) },
      seats: { type: S.INTEGER, allowNull: false, defaultValue: 5 },
      trial_ends_at: { type: S.DATE(3) },
      current_period_start: { type: S.DATE(3) },
      current_period_end: { type: S.DATE(3) },
      canceled_at: { type: S.DATE(3) },
    }, { indexes: [{ fields: ['tenant_id', 'status'] }] });

    await createTenantTable(qi, S, 'tenant_usage', {
      metric: { type: S.STRING(60), allowNull: false },
      period: { type: S.STRING(10), allowNull: false },
      value: { type: S.BIGINT, allowNull: false, defaultValue: 0 },
    }, { indexes: [{ fields: ['tenant_id', 'metric', 'period'], unique: true }] });

    await qi.createTable('feature_flags', {
      id: pk(),
      key: { type: S.STRING(80), allowNull: false },
      tenant_id: { type: ID, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      enabled: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      description: { type: S.STRING(255) },
      ...timestamps(S),
    }, opts);
    await qi.addIndex('feature_flags', ['key', 'tenant_id'], { unique: true, name: 'uq_feature_flags_key_tenant' });

    await createTenantTable(qi, S, 'audit_logs', {
      actor_user_id: ref(),
      actor_type: { type: S.ENUM('user', 'api_key', 'system', 'platform_admin', 'public'), allowNull: false },
      actor_label: { type: S.STRING(200) },
      action: { type: S.STRING(80), allowNull: false },
      entity_type: { type: S.STRING(40) },
      entity_id: ref(),
      summary: { type: S.STRING(500) },
      changes: { type: S.JSON },
      metadata: { type: S.JSON },
      ip: { type: S.STRING(64) },
      user_agent: { type: S.STRING(400) },
      request_id: { type: S.STRING(64) },
    }, {
      noUpdatedAt: true,
      indexes: [
        { fields: ['tenant_id', 'created_at'] },
        { fields: ['tenant_id', 'entity_type', 'entity_id'] },
        { fields: ['tenant_id', 'action', 'created_at'] },
        { fields: ['tenant_id', 'actor_user_id', 'created_at'] },
      ],
    });

    await qi.createTable('platform_audit_logs', {
      id: pk(),
      actor_user_id: ref(),
      action: { type: S.STRING(80), allowNull: false },
      target_tenant_id: ref(),
      summary: { type: S.STRING(500) },
      metadata: { type: S.JSON },
      ip: { type: S.STRING(64) },
      user_agent: { type: S.STRING(400) },
      request_id: { type: S.STRING(64) },
      created_at: { type: S.DATE(3), allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP(3)') },
    }, opts);
    await qi.addIndex('platform_audit_logs', ['created_at'], { name: 'ix_platform_audit_created' });

    await qi.createTable('security_events', {
      id: pk(),
      user_id: { type: ID, references: { model: 'users', key: 'id' }, onDelete: 'SET NULL' },
      email: { type: S.STRING(254) },
      event: { type: S.STRING(60), allowNull: false },
      ip: { type: S.STRING(64) },
      user_agent: { type: S.STRING(400) },
      metadata: { type: S.JSON },
      created_at: { type: S.DATE(3), allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP(3)') },
    }, opts);
    await qi.addIndex('security_events', ['user_id', 'created_at'], { name: 'ix_security_events_user' });
    await qi.addIndex('security_events', ['created_at'], { name: 'ix_security_events_created' });

    await qi.createTable('email_outbox', {
      id: pk(),
      tenant_id: { type: ID, references: { model: 'tenants', key: 'id' }, onDelete: 'SET NULL' },
      to_email: { type: S.STRING(254), allowNull: false },
      subject: { type: S.STRING(300), allowNull: false },
      template_key: { type: S.STRING(80) },
      status: { type: S.ENUM('queued', 'sent', 'failed', 'skipped'), allowNull: false, defaultValue: 'queued' },
      attempts: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      provider: { type: S.STRING(40) },
      provider_message_id: { type: S.STRING(200) },
      last_error: { type: S.STRING(1000) },
      sent_at: { type: S.DATE(3) },
      ...timestamps(S),
    }, opts);
    await qi.addIndex('email_outbox', ['tenant_id', 'created_at'], { name: 'ix_email_outbox_tenant' });

    await createTenantTable(qi, S, 'api_keys', {
      name: { type: S.STRING(120), allowNull: false },
      prefix: { type: S.STRING(16), allowNull: false, unique: true },
      key_hash: { type: S.CHAR(64), allowNull: false, unique: true },
      scopes: { type: S.JSON, allowNull: false },
      created_by_user_id: ref(false),
      rate_limit_per_minute: { type: S.INTEGER, allowNull: false, defaultValue: 120 },
      expires_at: { type: S.DATE(3) },
      revoked_at: { type: S.DATE(3) },
      last_used_at: { type: S.DATE(3) },
      last_used_ip: { type: S.STRING(64) },
    }, { indexes: [{ fields: ['tenant_id', 'revoked_at'] }], fks: [['created_by_user_id', 'tenant_memberships', 'user_id']] });

    await createTenantTable(qi, S, 'idempotency_keys', {
      key: { type: S.STRING(120), allowNull: false },
      actor_id: { type: ID, allowNull: false },
      method: { type: S.STRING(10), allowNull: false },
      path: { type: S.STRING(300), allowNull: false },
      request_hash: { type: S.CHAR(64), allowNull: false },
      status_code: { type: S.INTEGER },
      response_body: { type: S.JSON },
      expires_at: { type: S.DATE(3), allowNull: false },
    }, { noUpdatedAt: false, indexes: [{ fields: ['tenant_id', 'actor_id', 'key'], unique: true }, { fields: ['expires_at'] }] });

    await qi.createTable('jobs', {
      id: pk(),
      tenant_id: { type: ID, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      type: { type: S.STRING(80), allowNull: false },
      payload: { type: S.JSON, allowNull: false },
      status: { type: S.ENUM('pending', 'running', 'completed', 'failed', 'dead'), allowNull: false, defaultValue: 'pending' },
      priority: { type: S.INTEGER, allowNull: false, defaultValue: 100 },
      attempts: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      max_attempts: { type: S.INTEGER, allowNull: false, defaultValue: 5 },
      run_at: { type: S.DATE(3), allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP(3)') },
      locked_at: { type: S.DATE(3) },
      locked_by: { type: S.STRING(80) },
      last_error: { type: S.TEXT },
      result: { type: S.JSON },
      unique_key: { type: S.STRING(160), unique: true },
      completed_at: { type: S.DATE(3) },
      ...timestamps(S),
    }, opts);
    await qi.addIndex('jobs', ['status', 'run_at', 'priority'], { name: 'ix_jobs_poll' });
    await qi.addIndex('jobs', ['tenant_id', 'type', 'created_at'], { name: 'ix_jobs_tenant_type' });

    await qi.createTable('tenant_sequences', {
      tenant_id: { type: ID, allowNull: false, primaryKey: true, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      name: { type: S.STRING(40), allowNull: false, primaryKey: true },
      value: { type: S.BIGINT, allowNull: false, defaultValue: 0 },
    }, opts);
  },

  async down(qi) {
    for (const t of [
      'tenant_sequences', 'jobs', 'idempotency_keys', 'api_keys', 'email_outbox', 'security_events', 'platform_audit_logs',
      'audit_logs', 'feature_flags', 'tenant_usage', 'tenant_subscriptions', 'tenant_settings', 'invitations', 'user_tokens',
      'user_sessions', 'team_members', 'teams', 'field_permissions', 'membership_roles', 'role_permissions', 'roles',
      'permissions', 'tenant_memberships', 'tenant_domains', 'users', 'tenants', 'plans',
    ]) {
      await qi.dropTable(t);
    }
  },
};
