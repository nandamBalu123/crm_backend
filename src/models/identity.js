'use strict';

const { defineModel, T, ref, str, int, dec, bool, date, json, enm } = require('./define');

module.exports = (sequelize) => {
  const Plan = defineModel(sequelize, 'Plan', 'plans', {
    code: str(40, false), name: str(80, false), description: str(500),
    price_monthly: dec(12, 2, { allowNull: false, defaultValue: '0.00' }), currency: str(3, false, { defaultValue: 'USD' }),
    limits: json({}), features: json([]), is_active: bool(true), sort_order: int({ defaultValue: 0 }),
  });

  const Tenant = defineModel(sequelize, 'Tenant', 'tenants', {
    name: str(160, false), slug: str(63, false), status: enm(['active', 'suspended', 'pending_deletion'], 'active'),
    plan_id: ref(), owner_user_id: ref(), suspended_at: date(), suspended_reason: str(500), data_region: str(40, false, { defaultValue: 'default' }),
  });

  const TenantDomain = defineModel(sequelize, 'TenantDomain', 'tenant_domains', {
    tenant_id: ref(false), domain: str(253, false), is_primary: bool(false), verification_token: str(80), verified_at: date(),
  }, { hidden: ['verification_token'] });

  const User = defineModel(sequelize, 'User', 'users', {
    email: str(254, false), password_hash: str(255, false), first_name: str(80, false), last_name: str(80, false, { defaultValue: '' }),
    avatar_url: str(500), phone: str(40), email_verified_at: date(), is_platform_admin: bool(false),
    status: enm(['active', 'disabled'], 'active'), failed_login_count: int({ allowNull: false, defaultValue: 0 }), locked_until: date(),
    last_login_at: date(), password_changed_at: date(), mfa_enabled: bool(false), mfa_secret_encrypted: str(512),
    mfa_pending_secret_encrypted: str(512), mfa_recovery_codes: json(), mfa_last_used_step: { type: T.BIGINT }, locale: str(16), timezone: str(64),
  }, {
    hidden: ['password_hash', 'mfa_secret_encrypted', 'mfa_pending_secret_encrypted', 'mfa_recovery_codes', 'mfa_last_used_step', 'failed_login_count', 'locked_until'],
    getterMethods: {
      full_name() {
        return [this.getDataValue('first_name'), this.getDataValue('last_name')].filter(Boolean).join(' ');
      },
    },
  });

  const Membership = defineModel(sequelize, 'Membership', 'tenant_memberships', {
    user_id: ref(false), status: enm(['active', 'disabled'], 'active'), is_owner: bool(false), title: str(120), joined_at: date(), last_active_at: date(),
  }, { tenantScoped: true });

  const Permission = defineModel(sequelize, 'Permission', 'permissions', {
    key: str(80, false), module: str(40, false), action: str(40, false), description: str(255), supports_scope: bool(false), sort_order: int({ defaultValue: 0 }),
  });

  const Role = defineModel(sequelize, 'Role', 'roles', {
    key: str(60, false), name: str(80, false), description: str(255), is_system: bool(false), is_protected: bool(false), is_active: bool(true), cloned_from_id: ref(),
  }, { tenantScoped: true });

  const RolePermission = defineModel(sequelize, 'RolePermission', 'role_permissions', {
    role_id: ref(false), permission_id: ref(false), scope: enm(['own', 'team', 'all'], 'all'),
  }, { tenantScoped: true });

  const MembershipRole = defineModel(sequelize, 'MembershipRole', 'membership_roles', {
    membership_id: ref(false), role_id: ref(false),
  }, { tenantScoped: true });

  const FieldPermission = defineModel(sequelize, 'FieldPermission', 'field_permissions', {
    role_id: ref(false), entity_type: str(40, false), field_key: str(80, false), access: enm(['hidden', 'read']),
  }, { tenantScoped: true });

  const Team = defineModel(sequelize, 'Team', 'teams', { name: str(120, false), description: str(255), manager_user_id: ref() }, { tenantScoped: true });
  const TeamMember = defineModel(sequelize, 'TeamMember', 'team_members', { team_id: ref(false), user_id: ref(false) }, { tenantScoped: true });

  const UserSession = defineModel(sequelize, 'UserSession', 'user_sessions', {
    user_id: ref(false), active_tenant_id: ref(), refresh_token_hash: str(64, false), previous_token_hash: str(64), user_agent: str(400), ip: str(64),
    mfa_verified: bool(false), last_used_at: date(), rotated_at: date(), expires_at: { type: T.DATE(3), allowNull: false }, revoked_at: date(), revoked_reason: str(80),
  }, { hidden: ['refresh_token_hash', 'previous_token_hash'] });

  const UserToken = defineModel(sequelize, 'UserToken', 'user_tokens', {
    user_id: ref(false), type: enm(['email_verification', 'password_reset']), token_hash: str(64, false), expires_at: { type: T.DATE(3), allowNull: false }, used_at: date(),
  }, { hidden: ['token_hash'] });

  const Invitation = defineModel(sequelize, 'Invitation', 'invitations', {
    email: str(254, false), role_ids: json([]), team_ids: json([]), token_hash: str(64, false), status: enm(['pending', 'accepted', 'revoked'], 'pending'),
    invited_by_user_id: ref(), expires_at: { type: T.DATE(3), allowNull: false }, accepted_at: date(), accepted_user_id: ref(),
  }, { tenantScoped: true, hidden: ['token_hash'] });

  const TenantSettings = defineModel(sequelize, 'TenantSettings', 'tenant_settings', {
    branding: json({}), locale: str(16, false, { defaultValue: 'en-US' }), timezone: str(64, false, { defaultValue: 'UTC' }),
    currency: str(3, false, { defaultValue: 'USD' }), date_format: str(20, false, { defaultValue: 'yyyy-MM-dd' }),
    fiscal_year_start_month: int({ allowNull: false, defaultValue: 1 }), security: json({}), modules: json({}), preferences: json({}),
  }, { tenantScoped: true });

  const TenantSubscription = defineModel(sequelize, 'TenantSubscription', 'tenant_subscriptions', {
    plan_id: ref(false), status: enm(['trialing', 'active', 'past_due', 'canceled', 'suspended'], 'trialing'),
    provider: enm(['manual', 'stripe', 'razorpay'], 'manual'), provider_customer_id: str(120), provider_subscription_id: str(120),
    seats: int({ allowNull: false, defaultValue: 5 }), trial_ends_at: date(), current_period_start: date(), current_period_end: date(), canceled_at: date(),
  }, { tenantScoped: true });

  const TenantUsage = defineModel(sequelize, 'TenantUsage', 'tenant_usage', {
    metric: str(60, false), period: str(10, false), value: { type: T.BIGINT, allowNull: false, defaultValue: 0 },
  }, { tenantScoped: true });

  const FeatureFlag = defineModel(sequelize, 'FeatureFlag', 'feature_flags', {
    key: str(80, false), tenant_id: ref(), enabled: bool(false), description: str(255),
  });

  const AuditLog = defineModel(sequelize, 'AuditLog', 'audit_logs', {
    actor_user_id: ref(), actor_type: enm(['user', 'api_key', 'system', 'platform_admin', 'public']), actor_label: str(200),
    action: str(80, false), entity_type: str(40), entity_id: ref(), summary: str(500), changes: json(), metadata: json(),
    ip: str(64), user_agent: str(400), request_id: str(64),
  }, { tenantScoped: true, noUpdatedAt: true });
  // Audit logs are append-only through the application.
  AuditLog.addHook('beforeUpdate', () => { throw new Error('Audit logs are immutable'); });
  AuditLog.addHook('beforeBulkUpdate', () => { throw new Error('Audit logs are immutable'); });
  AuditLog.addHook('beforeDestroy', () => { throw new Error('Audit logs are immutable'); });
  AuditLog.addHook('beforeBulkDestroy', (options) => {
    if (!options.retentionPurge) throw new Error('Audit logs can only be removed by the retention job');
  });

  const PlatformAuditLog = defineModel(sequelize, 'PlatformAuditLog', 'platform_audit_logs', {
    actor_user_id: ref(), action: str(80, false), target_tenant_id: ref(), summary: str(500), metadata: json(), ip: str(64), user_agent: str(400), request_id: str(64),
  }, { noUpdatedAt: true });

  const SecurityEvent = defineModel(sequelize, 'SecurityEvent', 'security_events', {
    user_id: ref(), email: str(254), event: str(60, false), ip: str(64), user_agent: str(400), metadata: json(),
  }, { noUpdatedAt: true });

  const EmailOutbox = defineModel(sequelize, 'EmailOutbox', 'email_outbox', {
    tenant_id: ref(), to_email: str(254, false), subject: str(300, false), template_key: str(80),
    status: enm(['queued', 'sent', 'failed', 'skipped'], 'queued'), attempts: int({ allowNull: false, defaultValue: 0 }),
    provider: str(40), provider_message_id: str(200), last_error: str(1000), sent_at: date(),
  });

  const ApiKey = defineModel(sequelize, 'ApiKey', 'api_keys', {
    name: str(120, false), prefix: str(16, false), key_hash: str(64, false), scopes: json({}), created_by_user_id: ref(false),
    rate_limit_per_minute: int({ allowNull: false, defaultValue: 120 }), expires_at: date(), revoked_at: date(), last_used_at: date(), last_used_ip: str(64),
  }, { tenantScoped: true, hidden: ['key_hash'] });

  const IdempotencyKey = defineModel(sequelize, 'IdempotencyKey', 'idempotency_keys', {
    key: str(120, false), actor_id: ref(false), method: str(10, false), path: str(300, false), request_hash: str(64, false),
    status_code: int(), response_body: json(), expires_at: { type: T.DATE(3), allowNull: false },
  }, { tenantScoped: true });

  const Job = defineModel(sequelize, 'Job', 'jobs', {
    tenant_id: ref(), type: str(80, false), payload: json({}), status: enm(['pending', 'running', 'completed', 'failed', 'dead'], 'pending'),
    priority: int({ allowNull: false, defaultValue: 100 }), attempts: int({ allowNull: false, defaultValue: 0 }), max_attempts: int({ allowNull: false, defaultValue: 5 }),
    run_at: { type: T.DATE(3), allowNull: false, defaultValue: () => new Date() }, locked_at: date(), locked_by: str(80), last_error: { type: T.TEXT },
    result: json(), unique_key: str(160), completed_at: date(),
  });

  return {
    Plan, Tenant, TenantDomain, User, Membership, Permission, Role, RolePermission, MembershipRole, FieldPermission, Team, TeamMember,
    UserSession, UserToken, Invitation, TenantSettings, TenantSubscription, TenantUsage, FeatureFlag, AuditLog, PlatformAuditLog,
    SecurityEvent, EmailOutbox, ApiKey, IdempotencyKey, Job,
  };
};
