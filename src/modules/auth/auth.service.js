'use strict';

const { Op } = require('sequelize');
const env = require('../../config/env');
const { sequelize, User, UserToken, Invitation, Membership, MembershipRole, TeamMember, Tenant, Role } = require('../../models');
const { hashPassword, verifyPassword, needsRehash } = require('./password');
const totp = require('./totp');
const sessions = require('./session.service');
const { signMfaChallenge, verifyMfaChallenge } = require('./tokens');
const { securityEvent } = require('./securityEvents');
const { provisionTenant } = require('../tenants/provisioning.service');
const { queueEmail, layout } = require('../../integrations/mail/mailer');
const { sha256, encrypt, decrypt, safeEqual } = require('../../utils/crypto');
const { randomToken } = require('../../utils/ids');
const { runAsSystem, runInTenant } = require('../../context/requestContext');
const audit = require('../audit/audit.service');
const { invalidate: invalidateRbac } = require('../rbac/permission.service');
const { invalidateUserSessions } = require('../../middleware/authenticate');
const entitlements = require('../billing/entitlements.service');
const E = require('../../errors/AppError');

const VERIFY_TTL_H = 48;
const RESET_TTL_MIN = 60;

async function issueUserToken(userId, type, ttlMs, transaction) {
  const raw = randomToken(32);
  await UserToken.update({ used_at: new Date() }, { where: { user_id: userId, type, used_at: null }, transaction });
  await UserToken.create({ user_id: userId, type, token_hash: sha256(raw), expires_at: new Date(Date.now() + ttlMs) }, { transaction });
  return raw;
}

async function consumeUserToken(raw, type, transaction) {
  const token = await UserToken.findOne({ where: { token_hash: sha256(String(raw || '')), type }, transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!token || token.used_at || token.expires_at < new Date()) return null;
  await token.update({ used_at: new Date() }, { transaction });
  return token;
}

async function sendVerification(user, transaction) {
  const raw = await issueUserToken(user.id, 'email_verification', VERIFY_TTL_H * 3600_000, transaction);
  const { html, text } = layout({
    heading: 'Confirm your email address',
    intro: `Hi ${user.first_name}, confirm your email address to activate your CRM account. This link expires in ${VERIFY_TTL_H} hours.`,
    actionUrl: `${env.APP_URL}/verify-email?token=${raw}`,
    actionLabel: 'Verify email',
  });
  await queueEmail({ to: user.email, subject: 'Verify your email address', html, text, templateKey: 'email_verification' }, { transaction, tenantId: null });
}

async function register({ company_name, first_name, last_name, email, password }, req, res) {
  const existing = await User.findOne({ where: { email } });
  if (existing) throw E.conflict('An account with this email already exists. Sign in to create another workspace.', 'EMAIL_TAKEN');
  const { user, tenant } = await sequelize.transaction(async (transaction) => {
    const u = await User.create({ email, first_name, last_name, password_hash: await hashPassword(password), password_changed_at: new Date() }, { transaction });
    const t = await provisionTenant({ name: company_name, owner: u }, { transaction });
    await runInTenant(t.id, () => audit.record({ action: 'tenant.created', entityType: 'tenant', entityId: t.id, summary: `Workspace ${t.name} created` }, { transaction }), { userId: u.id, userEmail: u.email });
    await sendVerification(u, transaction);
    return { user: u, tenant: t };
  });
  await securityEvent('user.registered', { userId: user.id, email });
  await sessions.createSession(res, user, req, { tenantId: tenant.id });
  return { user, tenant };
}

async function login({ email, password, tenant_slug }, req, res) {
  const user = await User.findOne({ where: { email } });
  if (user && user.locked_until && user.locked_until > new Date()) {
    await securityEvent('login.locked', { userId: user.id, email });
    throw new E.AppError(423, 'ACCOUNT_LOCKED', 'Too many failed sign-in attempts. Try again later or reset your password.');
  }
  const valid = await verifyPassword(user?.password_hash, password);
  if (!user || !valid || user.status !== 'active') {
    if (user) {
      const count = user.failed_login_count + 1;
      const lock = count >= env.LOGIN_MAX_ATTEMPTS;
      await user.update({ failed_login_count: lock ? 0 : count, locked_until: lock ? new Date(Date.now() + env.LOGIN_LOCKOUT_MINUTES * 60_000) : null });
      if (lock) await securityEvent('account.locked', { userId: user.id, email });
    }
    await securityEvent('login.failed', { userId: user?.id || null, email });
    throw E.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  }
  const updates = { failed_login_count: 0, locked_until: null };
  if (needsRehash(user.password_hash)) updates.password_hash = await hashPassword(password);
  await user.update(updates);

  let preferredTenantId = null;
  if (tenant_slug) {
    const t = await Tenant.findOne({ where: { slug: tenant_slug }, attributes: ['id'] });
    preferredTenantId = t?.id || null;
  }
  if (user.mfa_enabled) {
    await securityEvent('login.mfa_challenge', { userId: user.id, email });
    return { mfa_required: true, mfa_token: signMfaChallenge(user.id), preferredTenantId };
  }
  return completeLogin(user, req, res, { preferredTenantId, mfaVerified: false });
}

async function completeLogin(user, req, res, { preferredTenantId, mfaVerified }) {
  const { tenantId } = await sessions.pickTenant(user.id, preferredTenantId);
  await user.update({ last_login_at: new Date() });
  await sessions.createSession(res, user, req, { tenantId, mfaVerified });
  if (tenantId) {
    await runInTenant(tenantId, async () => {
      await Membership.update({ last_active_at: new Date() }, { where: { user_id: user.id } });
      await audit.record({ action: 'auth.login', entityType: 'user', entityId: user.id, summary: `${user.email} signed in`, metadata: { mfa: mfaVerified } });
    }, { userId: user.id, userEmail: user.email });
  }
  await securityEvent('login.succeeded', { userId: user.id, email: user.email, metadata: { mfa: mfaVerified } });
  return { user, tenantId };
}

async function verifyMfaLogin({ mfa_token, code, recovery_code, tenant_slug }, req, res) {
  let userId;
  try {
    userId = verifyMfaChallenge(mfa_token);
  } catch {
    throw E.unauthorized('MFA challenge expired, sign in again', 'MFA_CHALLENGE_INVALID');
  }
  const user = await User.findByPk(userId);
  if (!user || !user.mfa_enabled || user.status !== 'active') throw E.unauthorized('MFA challenge invalid', 'MFA_CHALLENGE_INVALID');
  let ok = false;
  if (code) {
    const step = totp.verify(decrypt(user.mfa_secret_encrypted), code, { lastUsedStep: user.mfa_last_used_step });
    if (step !== null) {
      await user.update({ mfa_last_used_step: step });
      ok = true;
    }
  } else if (recovery_code) {
    const hashes = user.mfa_recovery_codes || [];
    const h = sha256(String(recovery_code).replace(/[\s-]/g, '').toLowerCase());
    const idx = hashes.findIndex((x) => safeEqual(x, h));
    if (idx >= 0) {
      await user.update({ mfa_recovery_codes: hashes.filter((_, i) => i !== idx) });
      await securityEvent('mfa.recovery_code_used', { userId: user.id });
      ok = true;
    }
  }
  if (!ok) {
    await securityEvent('mfa.failed', { userId: user.id });
    throw E.unauthorized('Invalid verification code', 'MFA_CODE_INVALID');
  }
  let preferredTenantId = null;
  if (tenant_slug) preferredTenantId = (await Tenant.findOne({ where: { slug: tenant_slug }, attributes: ['id'] }))?.id || null;
  return completeLogin(user, req, res, { preferredTenantId, mfaVerified: true });
}

async function verifyEmail(token) {
  return sequelize.transaction(async (transaction) => {
    const t = await consumeUserToken(token, 'email_verification', transaction);
    if (!t) throw E.badRequest('This verification link is invalid or has expired');
    await User.update({ email_verified_at: new Date() }, { where: { id: t.user_id }, transaction });
    invalidateUserSessions();
    return true;
  });
}

async function resendVerification(user) {
  if (user.email_verified_at) return;
  await sequelize.transaction((transaction) => sendVerification(user, transaction));
}

async function forgotPassword(email) {
  const user = await User.findOne({ where: { email, status: 'active' } });
  if (!user) {
    await securityEvent('password_reset.unknown_email', { email });
    return; // identical response for unknown accounts
  }
  await sequelize.transaction(async (transaction) => {
    const raw = await issueUserToken(user.id, 'password_reset', RESET_TTL_MIN * 60_000, transaction);
    const { html, text } = layout({
      heading: 'Reset your password',
      intro: `Someone requested a password reset for your account. The link is valid for ${RESET_TTL_MIN} minutes and can be used once.`,
      actionUrl: `${env.APP_URL}/reset-password?token=${raw}`,
      actionLabel: 'Choose a new password',
    });
    await queueEmail({ to: user.email, subject: 'Reset your password', html, text, templateKey: 'password_reset' }, { transaction, tenantId: null });
  });
  await securityEvent('password_reset.requested', { userId: user.id, email });
}

async function resetPassword({ token, password }) {
  const user = await sequelize.transaction(async (transaction) => {
    const t = await consumeUserToken(token, 'password_reset', transaction);
    if (!t) throw E.badRequest('This reset link is invalid or has expired');
    const u = await User.findByPk(t.user_id, { transaction });
    await u.update({ password_hash: await hashPassword(password), password_changed_at: new Date(), failed_login_count: 0, locked_until: null, email_verified_at: u.email_verified_at || new Date() }, { transaction });
    return u;
  });
  await sessions.revokeAllForUser(user.id, 'password_reset');
  await securityEvent('password_reset.completed', { userId: user.id });
}

async function changePassword(user, { current_password, new_password }, sessionId) {
  const fresh = await User.findByPk(user.id);
  if (!(await verifyPassword(fresh.password_hash, current_password))) throw E.badRequest('Current password is incorrect', [{ path: 'current_password', message: 'Incorrect password' }]);
  await fresh.update({ password_hash: await hashPassword(new_password), password_changed_at: new Date() });
  await sessions.revokeAllForUser(user.id, 'password_changed', { exceptSessionId: sessionId });
  await securityEvent('password.changed', { userId: user.id });
}

// ---- MFA ----
async function mfaSetup(user) {
  const secret = totp.generateSecret();
  await User.update({ mfa_pending_secret_encrypted: encrypt(secret) }, { where: { id: user.id } });
  return { secret, otpauth_url: totp.otpauthUrl({ secret, account: user.email, issuer: 'CRM SaaS' }) };
}

async function mfaEnable(user, code) {
  const fresh = await User.findByPk(user.id);
  if (!fresh.mfa_pending_secret_encrypted) throw E.badRequest('Start MFA setup first');
  const secret = decrypt(fresh.mfa_pending_secret_encrypted);
  const step = totp.verify(secret, code);
  if (step === null) throw E.badRequest('Invalid verification code', [{ path: 'code', message: 'Invalid code' }]);
  const recovery = Array.from({ length: 10 }, () => randomToken(6).replace(/[^a-zA-Z0-9]/g, 'x').slice(0, 8).toLowerCase());
  await fresh.update({
    mfa_enabled: true, mfa_secret_encrypted: encrypt(secret), mfa_pending_secret_encrypted: null, mfa_last_used_step: step,
    mfa_recovery_codes: recovery.map((r) => sha256(r)),
  });
  invalidateUserSessions();
  await securityEvent('mfa.enabled', { userId: user.id });
  return { recovery_codes: recovery };
}

async function mfaDisable(user, { password, code }) {
  const fresh = await User.findByPk(user.id);
  if (!fresh.mfa_enabled) return;
  if (!(await verifyPassword(fresh.password_hash, password))) throw E.badRequest('Password is incorrect');
  if (totp.verify(decrypt(fresh.mfa_secret_encrypted), code) === null) throw E.badRequest('Invalid verification code');
  await fresh.update({ mfa_enabled: false, mfa_secret_encrypted: null, mfa_recovery_codes: null, mfa_last_used_step: null });
  invalidateUserSessions();
  await securityEvent('mfa.disabled', { userId: user.id });
}

// ---- Invitations ----
async function findInvitation(rawToken) {
  const inv = await runAsSystem('invitation:lookup', () =>
    Invitation.findOne({ where: { token_hash: sha256(String(rawToken || '')), status: 'pending', expires_at: { [Op.gt]: new Date() } } })
  );
  if (!inv) throw E.badRequest('This invitation is invalid or has expired', [{ path: 'token', message: 'Invalid invitation' }]);
  const tenant = await Tenant.findByPk(inv.tenant_id, { attributes: ['id', 'name', 'slug', 'status'] });
  if (!tenant || tenant.status !== 'active') throw E.badRequest('This workspace is not available');
  return { inv, tenant };
}

async function previewInvitation(token) {
  const { inv, tenant } = await findInvitation(token);
  const existing = await User.findOne({ where: { email: inv.email }, attributes: ['id'] });
  return { email: inv.email, tenant: { name: tenant.name, slug: tenant.slug }, account_exists: !!existing };
}

async function acceptInvitation({ token, first_name, last_name, password }, req, res) {
  const { inv, tenant } = await findInvitation(token);
  let user = await User.findOne({ where: { email: inv.email } });
  const signedInUser = req.ctx.user;
  if (user) {
    if (!signedInUser || signedInUser.id !== user.id) throw E.conflict('Sign in with the invited email address to accept this invitation', 'SIGN_IN_REQUIRED');
  } else {
    if (signedInUser) throw E.conflict('This invitation was sent to a different email address', 'EMAIL_MISMATCH');
    if (!first_name || !password) throw E.validation([{ path: 'password', message: 'Name and password are required to create your account' }]);
  }
  await runInTenant(tenant.id, () =>
    sequelize.transaction(async (transaction) => {
      await entitlements.assertSeatAvailable({ transaction });
      if (!user) {
        user = await User.create({ email: inv.email, first_name, last_name: last_name || '', password_hash: await hashPassword(password), email_verified_at: new Date(), password_changed_at: new Date() }, { transaction });
      }
      const existingMembership = await Membership.findOne({ where: { user_id: user.id }, transaction });
      if (existingMembership && existingMembership.status === 'active') throw E.conflict('You are already a member of this workspace', 'ALREADY_MEMBER');
      const membership = existingMembership
        ? await existingMembership.update({ status: 'active', joined_at: new Date() }, { transaction })
        : await Membership.create({ user_id: user.id, status: 'active', joined_at: new Date(), last_active_at: new Date() }, { transaction });
      const roles = await Role.findAll({ where: { id: inv.role_ids || [], is_active: true, key: { [Op.ne]: 'owner' } }, transaction });
      await MembershipRole.destroy({ where: { membership_id: membership.id }, transaction });
      if (roles.length) await MembershipRole.bulkCreate(roles.map((r) => ({ membership_id: membership.id, role_id: r.id })), { transaction });
      for (const teamId of inv.team_ids || []) {
        await TeamMember.findOrCreate({ where: { team_id: teamId, user_id: user.id }, defaults: { team_id: teamId, user_id: user.id }, transaction });
      }
      await inv.update({ status: 'accepted', accepted_at: new Date(), accepted_user_id: user.id }, { transaction });
      await audit.record({ action: 'invitation.accepted', entityType: 'user', entityId: user.id, summary: `${user.email} joined the workspace`, metadata: { roles: roles.map((r) => r.key) } }, { transaction });
    }), { userId: undefined }
  );
  invalidateRbac(tenant.id);
  if (signedInUser && req.ctx.sessionId) {
    await sessions.switchTenant(res, { id: req.ctx.sessionId, user_id: user.id }, tenant.id);
  } else {
    await sessions.createSession(res, user, req, { tenantId: tenant.id });
  }
  await securityEvent('invitation.accepted', { userId: user.id, email: user.email, metadata: { tenant_id: tenant.id } });
  return { user, tenant };
}

async function createAdditionalWorkspace(user, { company_name }) {
  if (!user.email_verified_at && env.REQUIRE_EMAIL_VERIFICATION) throw E.forbidden('Verify your email before creating another workspace', 'EMAIL_NOT_VERIFIED');
  const tenant = await provisionTenant({ name: company_name, owner: user, planCode: 'free' });
  await runInTenant(tenant.id, () => audit.record({ action: 'tenant.created', entityType: 'tenant', entityId: tenant.id, summary: `Workspace ${tenant.name} created` }), { userId: user.id, userEmail: user.email });
  return tenant;
}

module.exports = {
  register, login, verifyMfaLogin, verifyEmail, resendVerification, forgotPassword, resetPassword, changePassword,
  mfaSetup, mfaEnable, mfaDisable, previewInvitation, acceptInvitation, createAdditionalWorkspace, completeLogin,
};
