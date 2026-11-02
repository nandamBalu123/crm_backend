'use strict';

const { ID, ref, createTenantTable, addTenantFk, shortName } = require('../migrationHelpers');

const OWNER = ['owner_id', 'tenant_memberships', 'user_id'];

module.exports = {
  async up(qi, S) {
    await createTenantTable(qi, S, 'product_categories', {
      name: { type: S.STRING(120), allowNull: false },
      description: { type: S.STRING(500) },
      parent_id: ref(),
    }, { indexes: [{ fields: ['tenant_id', 'name'], unique: true }], fks: [['parent_id', 'product_categories']] });

    await createTenantTable(qi, S, 'products', {
      sku: { type: S.STRING(64), allowNull: false },
      name: { type: S.STRING(200), allowNull: false },
      description: { type: S.TEXT },
      category_id: ref(),
      unit_price: { type: S.DECIMAL(18, 4), allowNull: false, defaultValue: 0 },
      currency: { type: S.CHAR(3), allowNull: false, defaultValue: 'USD' },
      tax_rate: { type: S.DECIMAL(7, 4), allowNull: false, defaultValue: 0 },
      unit: { type: S.STRING(30) },
      max_discount_percent: { type: S.DECIMAL(7, 4) },
      is_active: { type: S.BOOLEAN, allowNull: false, defaultValue: true },
    }, {
      soft: true,
      version: true,
      indexes: [{ fields: ['tenant_id', 'sku'], unique: true }, { fields: ['tenant_id', 'is_active', 'name'] }, { fields: ['tenant_id', 'category_id'] }],
      fks: [['category_id', 'product_categories']],
    });

    await createTenantTable(qi, S, 'discount_rules', {
      name: { type: S.STRING(120), allowNull: false },
      product_id: ref(),
      category_id: ref(),
      min_quantity: { type: S.DECIMAL(18, 4), allowNull: false, defaultValue: 1 },
      discount_percent: { type: S.DECIMAL(7, 4), allowNull: false },
      starts_on: { type: S.DATEONLY },
      ends_on: { type: S.DATEONLY },
      is_active: { type: S.BOOLEAN, allowNull: false, defaultValue: true },
    }, { indexes: [{ fields: ['tenant_id', 'is_active'] }], fks: [['product_id', 'products'], ['category_id', 'product_categories']] });

    await createTenantTable(qi, S, 'opportunity_products', {
      opportunity_id: ref(false),
      product_id: ref(false),
      quantity: { type: S.DECIMAL(18, 4), allowNull: false, defaultValue: 1 },
      unit_price: { type: S.DECIMAL(18, 4), allowNull: false },
      discount_percent: { type: S.DECIMAL(7, 4), allowNull: false, defaultValue: 0 },
      total: { type: S.DECIMAL(18, 2), allowNull: false },
    }, { indexes: [{ fields: ['tenant_id', 'opportunity_id'] }], fks: [['opportunity_id', 'opportunities'], ['product_id', 'products']] });

    await createTenantTable(qi, S, 'quote_templates', {
      name: { type: S.STRING(120), allowNull: false },
      header_text: { type: S.TEXT },
      footer_text: { type: S.TEXT },
      terms: { type: S.TEXT },
      accent_color: { type: S.STRING(9) },
      is_default: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
    }, { indexes: [{ fields: ['tenant_id', 'name'], unique: true }] });

    await createTenantTable(qi, S, 'quotes', {
      number: { type: S.INTEGER, allowNull: false },
      revision: { type: S.INTEGER, allowNull: false, defaultValue: 1 },
      quote_group_id: { type: ID, allowNull: false },
      title: { type: S.STRING(200), allowNull: false },
      status: {
        type: S.ENUM('draft', 'pending_approval', 'approved', 'rejected', 'sent', 'accepted', 'declined', 'expired', 'superseded'),
        allowNull: false,
        defaultValue: 'draft',
      },
      opportunity_id: ref(),
      account_id: ref(),
      contact_id: ref(),
      template_id: ref(),
      currency: { type: S.CHAR(3), allowNull: false, defaultValue: 'USD' },
      subtotal: { type: S.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
      discount_total: { type: S.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
      tax_total: { type: S.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
      total: { type: S.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
      max_line_discount_percent: { type: S.DECIMAL(7, 4), allowNull: false, defaultValue: 0 },
      valid_until: { type: S.DATEONLY },
      terms: { type: S.TEXT },
      notes: { type: S.TEXT },
      owner_id: ref(),
      submitted_at: { type: S.DATE(3) },
      approved_by_user_id: ref(),
      approved_at: { type: S.DATE(3) },
      rejection_reason: { type: S.STRING(500) },
      sent_at: { type: S.DATE(3) },
      accepted_at: { type: S.DATE(3) },
    }, {
      soft: true,
      version: true,
      indexes: [
        { fields: ['tenant_id', 'number', 'revision'], unique: true },
        { fields: ['tenant_id', 'quote_group_id'] },
        { fields: ['tenant_id', 'status'] },
        { fields: ['tenant_id', 'opportunity_id'] },
        { fields: ['tenant_id', 'account_id'] },
        { fields: ['status', 'valid_until'], name: 'ix_quotes_expiry_scan' },
      ],
      fks: [['opportunity_id', 'opportunities'], ['account_id', 'accounts'], ['contact_id', 'contacts'], ['template_id', 'quote_templates'], OWNER],
    });

    await createTenantTable(qi, S, 'quote_line_items', {
      quote_id: ref(false),
      product_id: ref(),
      position: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      name: { type: S.STRING(200), allowNull: false },
      description: { type: S.TEXT },
      quantity: { type: S.DECIMAL(18, 4), allowNull: false },
      unit_price: { type: S.DECIMAL(18, 4), allowNull: false },
      discount_percent: { type: S.DECIMAL(7, 4), allowNull: false, defaultValue: 0 },
      tax_rate: { type: S.DECIMAL(7, 4), allowNull: false, defaultValue: 0 },
      line_subtotal: { type: S.DECIMAL(18, 2), allowNull: false },
      line_discount: { type: S.DECIMAL(18, 2), allowNull: false },
      line_tax: { type: S.DECIMAL(18, 2), allowNull: false },
      line_total: { type: S.DECIMAL(18, 2), allowNull: false },
    }, { indexes: [{ fields: ['tenant_id', 'quote_id', 'position'] }], fks: [['quote_id', 'quotes'], ['product_id', 'products']] });

    await createTenantTable(qi, S, 'approvals', {
      entity_type: { type: S.STRING(40), allowNull: false },
      entity_id: { type: ID, allowNull: false },
      status: { type: S.ENUM('pending', 'approved', 'rejected', 'canceled'), allowNull: false, defaultValue: 'pending' },
      reason: { type: S.STRING(500) },
      requested_by_user_id: ref(),
      decided_by_user_id: ref(),
      decided_at: { type: S.DATE(3) },
      comment: { type: S.STRING(1000) },
    }, { indexes: [{ fields: ['tenant_id', 'status', 'created_at'] }, { fields: ['tenant_id', 'entity_type', 'entity_id'] }] });

    await createTenantTable(qi, S, 'campaign_members', {
      campaign_id: ref(false),
      lead_id: ref(),
      contact_id: ref(),
      status: { type: S.ENUM('added', 'sent', 'responded', 'converted', 'unsubscribed'), allowNull: false, defaultValue: 'added' },
      responded_at: { type: S.DATE(3) },
    }, {
      indexes: [
        { fields: ['tenant_id', 'campaign_id', 'status'] },
        { fields: ['campaign_id', 'lead_id'], unique: true, name: 'uq_campaign_members_lead' },
        { fields: ['campaign_id', 'contact_id'], unique: true, name: 'uq_campaign_members_contact' },
      ],
      fks: [['campaign_id', 'campaigns'], ['lead_id', 'leads'], ['contact_id', 'contacts']],
    });

    await createTenantTable(qi, S, 'segments', {
      name: { type: S.STRING(120), allowNull: false },
      entity_type: { type: S.ENUM('lead', 'contact'), allowNull: false },
      filters: { type: S.JSON, allowNull: false },
      description: { type: S.STRING(500) },
      created_by_user_id: ref(),
    }, { indexes: [{ fields: ['tenant_id', 'entity_type'] }] });

    await createTenantTable(qi, S, 'lead_forms', {
      name: { type: S.STRING(120), allowNull: false },
      public_key: { type: S.STRING(40), allowNull: false, unique: true },
      fields: { type: S.JSON, allowNull: false },
      campaign_id: ref(),
      default_owner_id: ref(),
      lead_source: { type: S.STRING(60), allowNull: false, defaultValue: 'web_form' },
      success_message: { type: S.STRING(500) },
      redirect_url: { type: S.STRING(500) },
      consent_text: { type: S.STRING(1000) },
      require_consent: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      allowed_origins: { type: S.JSON },
      is_active: { type: S.BOOLEAN, allowNull: false, defaultValue: true },
      submission_count: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
    }, { soft: true, indexes: [{ fields: ['tenant_id', 'is_active'] }], fks: [['campaign_id', 'campaigns'], ['default_owner_id', 'tenant_memberships', 'user_id']] });

    await createTenantTable(qi, S, 'form_submissions', {
      form_id: ref(false),
      lead_id: ref(),
      payload: { type: S.JSON, allowNull: false },
      ip: { type: S.STRING(64) },
      user_agent: { type: S.STRING(400) },
      referrer: { type: S.STRING(500) },
      status: { type: S.ENUM('accepted', 'rejected', 'spam'), allowNull: false, defaultValue: 'accepted' },
      error: { type: S.STRING(500) },
    }, { noUpdatedAt: true, indexes: [{ fields: ['tenant_id', 'form_id', 'created_at'] }], fks: [['form_id', 'lead_forms'], ['lead_id', 'leads']] });

    await createTenantTable(qi, S, 'consents', {
      subject_type: { type: S.ENUM('lead', 'contact'), allowNull: false },
      subject_id: { type: ID, allowNull: false },
      email: { type: S.STRING(254) },
      channel: { type: S.ENUM('email', 'sms', 'whatsapp', 'phone'), allowNull: false },
      purpose: { type: S.STRING(60), allowNull: false, defaultValue: 'marketing' },
      status: { type: S.ENUM('granted', 'revoked'), allowNull: false },
      source: { type: S.STRING(60), allowNull: false },
      consent_text: { type: S.STRING(1000) },
      ip: { type: S.STRING(64) },
      recorded_by_user_id: ref(),
    }, { noUpdatedAt: true, indexes: [{ fields: ['tenant_id', 'subject_type', 'subject_id', 'channel', 'created_at'] }, { fields: ['tenant_id', 'email'] }] });

    await createTenantTable(qi, S, 'ticket_categories', {
      name: { type: S.STRING(120), allowNull: false },
      description: { type: S.STRING(500) },
      default_team_id: ref(),
      is_active: { type: S.BOOLEAN, allowNull: false, defaultValue: true },
    }, { indexes: [{ fields: ['tenant_id', 'name'], unique: true }], fks: [['default_team_id', 'teams']] });

    await createTenantTable(qi, S, 'sla_policies', {
      name: { type: S.STRING(120), allowNull: false },
      priority: { type: S.ENUM('low', 'normal', 'high', 'urgent'), allowNull: false },
      first_response_minutes: { type: S.INTEGER, allowNull: false },
      resolution_minutes: { type: S.INTEGER, allowNull: false },
      escalate_to_user_id: ref(),
      is_active: { type: S.BOOLEAN, allowNull: false, defaultValue: true },
    }, { indexes: [{ fields: ['tenant_id', 'priority', 'is_active'] }], fks: [['escalate_to_user_id', 'tenant_memberships', 'user_id']] });

    await addTenantFk(qi, 'tickets', 'category_id', 'ticket_categories');
    await addTenantFk(qi, 'tickets', 'sla_policy_id', 'sla_policies');

    await createTenantTable(qi, S, 'ticket_comments', {
      ticket_id: ref(false),
      author_user_id: ref(),
      body: { type: S.TEXT, allowNull: false },
      is_internal: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
    }, { indexes: [{ fields: ['tenant_id', 'ticket_id', 'created_at'] }], fks: [['ticket_id', 'tickets']] });
  },

  async down(qi) {
    await qi.removeConstraint('tickets', shortName('fk', 'tickets', ['category_id']));
    await qi.removeConstraint('tickets', shortName('fk', 'tickets', ['sla_policy_id']));
    for (const t of [
      'ticket_comments', 'sla_policies', 'ticket_categories', 'consents', 'form_submissions', 'lead_forms', 'segments',
      'campaign_members', 'approvals', 'quote_line_items', 'quotes', 'quote_templates', 'opportunity_products',
      'discount_rules', 'products', 'product_categories',
    ]) {
      await qi.dropTable(t);
    }
  },
};
