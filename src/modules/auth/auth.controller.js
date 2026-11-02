'use strict';

const service = require('./auth.service');
const sessions = require('./session.service');
const { buildMe, publicUser } = require('./me.service');
const { COOKIE, clearAuthCookies, issueCsrf } = require('./tokens');
const { UserSession, User } = require('../../models');
const { securityEvent } = require('./securityEvents');
const { ok, created, accepted, noContent } = require('../../utils/http');
const { invalidateUserSessions } = require('../../middleware/authenticate');
const E = require('../../errors/AppError');

module.exports = {
  csrf(_req, res) {
    return ok(res, { csrf_token: issueCsrf(res) });
  },

  async register(req, res) {
    const { user, tenant } = await service.register(req.valid.body, req, res);
    return created(res, { user: publicUser(user), tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug } });
  },

  async login(req, res) {
    const result = await service.login(req.valid.body, req, res);
    if (result.mfa_required) return ok(res, { mfa_required: true, mfa_token: result.mfa_token });
    return ok(res, { user: publicUser(result.user), tenant_id: result.tenantId });
  },

  async mfaVerify(req, res) {
    const result = await service.verifyMfaLogin(req.valid.body, req, res);
    return ok(res, { user: publicUser(result.user), tenant_id: result.tenantId });
  },

  async refresh(req, res) {
    const result = await sessions.rotate(res, req.cookies?.[COOKIE.refresh]);
    if (result.error) {
      if (result.error === 'reuse') await securityEvent('refresh_token.reuse_detected', { userId: result.session.user_id });
      clearAuthCookies(res);
      throw E.unauthorized('Session expired, please sign in again', 'SESSION_EXPIRED');
    }
    return ok(res, { refreshed: true });
  },

  async logout(req, res) {
    if (req.ctx.sessionId) await sessions.revoke(req.ctx.sessionId, 'logout');
    clearAuthCookies(res);
    await securityEvent('logout', { userId: req.ctx.userId });
    return noContent(res);
  },

  async logoutAll(req, res) {
    await sessions.revokeAllForUser(req.ctx.userId, 'logout_all');
    clearAuthCookies(res);
    await securityEvent('logout.all_sessions', { userId: req.ctx.userId });
    return noContent(res);
  },

  async me(req, res) {
    return ok(res, await buildMe(req.ctx));
  },

  async updateProfile(req, res) {
    const user = await User.findByPk(req.ctx.userId);
    await user.update(req.valid.body);
    invalidateUserSessions();
    return ok(res, publicUser(user));
  },

  async switchTenant(req, res) {
    if (!req.ctx.sessionId) throw E.forbidden('Workspace switching requires an interactive session');
    const memberships = await sessions.activeMemberships(req.ctx.userId);
    const target = memberships.find((m) => m.tenant_id === req.valid.body.tenant_id);
    if (!target) throw E.forbidden('You are not a member of this workspace', 'NOT_A_MEMBER');
    await sessions.switchTenant(res, { id: req.ctx.sessionId, user_id: req.ctx.userId }, target.tenant_id);
    await securityEvent('tenant.switched', { userId: req.ctx.userId, metadata: { tenant_id: target.tenant_id } });
    return ok(res, { tenant_id: target.tenant_id });
  },

  async listSessions(req, res) {
    const rows = await UserSession.findAll({
      where: { user_id: req.ctx.userId, revoked_at: null },
      order: [['last_used_at', 'DESC']],
      attributes: ['id', 'user_agent', 'ip', 'created_at', 'last_used_at', 'expires_at', 'mfa_verified'],
    });
    return ok(res, rows.filter((s) => s.expires_at > new Date()).map((s) => ({ ...s.toJSON(), current: s.id === req.ctx.sessionId })));
  },

  async revokeSession(req, res) {
    const session = await UserSession.findOne({ where: { id: req.valid.params.id, user_id: req.ctx.userId } });
    if (!session) throw E.notFound('Session');
    await sessions.revoke(session.id, 'revoked_by_user');
    await securityEvent('session.revoked', { userId: req.ctx.userId, metadata: { session_id: session.id } });
    return noContent(res);
  },

  async verifyEmail(req, res) {
    await service.verifyEmail(req.valid.body.token);
    return ok(res, { verified: true });
  },

  async resendVerification(req, res) {
    await service.resendVerification(req.ctx.user);
    return accepted(res, { sent: true });
  },

  async forgotPassword(req, res) {
    await service.forgotPassword(req.valid.body.email);
    return accepted(res, { message: 'If an account exists for this email, a reset link has been sent.' });
  },

  async resetPassword(req, res) {
    await service.resetPassword(req.valid.body);
    clearAuthCookies(res);
    return ok(res, { reset: true });
  },

  async changePassword(req, res) {
    await service.changePassword(req.ctx.user, req.valid.body, req.ctx.sessionId);
    return ok(res, { changed: true });
  },

  async mfaSetup(req, res) {
    return ok(res, await service.mfaSetup(req.ctx.user));
  },
  async mfaEnable(req, res) {
    return ok(res, await service.mfaEnable(req.ctx.user, req.valid.body.code));
  },
  async mfaDisable(req, res) {
    await service.mfaDisable(req.ctx.user, req.valid.body);
    return ok(res, { disabled: true });
  },

  async previewInvitation(req, res) {
    return ok(res, await service.previewInvitation(req.valid.params.token));
  },
  async acceptInvitation(req, res) {
    const { user, tenant } = await service.acceptInvitation(req.valid.body, req, res);
    return ok(res, { user: publicUser(user), tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug } });
  },

  async createWorkspace(req, res) {
    const tenant = await service.createAdditionalWorkspace(req.ctx.user, req.valid.body);
    await sessions.switchTenant(res, { id: req.ctx.sessionId, user_id: req.ctx.userId }, tenant.id);
    return created(res, { id: tenant.id, name: tenant.name, slug: tenant.slug });
  },
};
