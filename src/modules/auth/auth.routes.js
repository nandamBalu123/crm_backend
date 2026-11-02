'use strict';

const { createRouter } = require('../../utils/router');
const { z } = require('../../utils/schemas');
const v = require('./auth.validators');
const c = require('./auth.controller');
const { authenticate } = require('../../middleware/authenticate');
const { csrfProtection, originCheck } = require('../../middleware/csrf');
const { authLimiter } = require('../../middleware/rateLimits');
const { idParams } = require('../../utils/schemas');

// Public (unauthenticated) authentication endpoints.
const pub = createRouter({ prefix: '/api/v1/auth', tag: 'Authentication', auth: 'public' });
pub.router.use(originCheck);
pub.get('/csrf', { summary: 'Issue a CSRF token cookie' }, c.csrf);
pub.post('/register', { summary: 'Sign up: create a user and a new workspace (tenant)', body: v.register }, authLimiter, c.register);
pub.post('/login', { summary: 'Sign in with email and password', body: v.login }, authLimiter, c.login);
pub.post('/mfa/verify', { summary: 'Complete sign-in with a TOTP or recovery code', body: v.mfaVerify }, authLimiter, c.mfaVerify);
pub.post('/refresh', { summary: 'Rotate the refresh token and issue a new access token' }, c.refresh);
pub.post('/forgot-password', { summary: 'Request a password reset email', body: v.forgot }, authLimiter, c.forgotPassword);
pub.post('/reset-password', { summary: 'Reset password with a single-use token', body: v.reset }, authLimiter, c.resetPassword);
pub.post('/verify-email', { summary: 'Verify email address with a token', body: v.token }, authLimiter, c.verifyEmail);
pub.get('/invitations/:token', { summary: 'Preview an invitation', params: z.object({ token: z.string().min(10).max(200) }) }, c.previewInvitation);
pub.post('/invitations/accept', { summary: 'Accept an invitation (creates the account if needed)', body: v.acceptInvitation }, authLimiter, authenticate({ optional: true }), c.acceptInvitation);

// Authenticated, user-level endpoints (no active tenant required).
const user = createRouter({ prefix: '/api/v1/auth', tag: 'Authentication', auth: 'user' });
user.router.use(authenticate(), csrfProtection);
user.get('/me', { summary: 'Current user, workspaces, permissions and entitlements' }, c.me);
user.patch('/me', { summary: 'Update own profile', body: v.profile }, c.updateProfile);
user.post('/logout', { summary: 'Sign out of the current session' }, c.logout);
user.post('/logout-all', { summary: 'Sign out of all sessions' }, c.logoutAll);
user.post('/switch-tenant', { summary: 'Switch the active workspace', body: v.switchTenant }, c.switchTenant);
user.get('/sessions', { summary: 'List active sessions/devices' }, c.listSessions);
user.delete('/sessions/:id', { summary: 'Revoke a session', params: idParams }, c.revokeSession);
user.post('/change-password', { summary: 'Change password', body: v.changePassword }, c.changePassword);
user.post('/resend-verification', { summary: 'Resend the email verification link' }, c.resendVerification);
user.post('/mfa/setup', { summary: 'Begin TOTP enrolment' }, c.mfaSetup);
user.post('/mfa/enable', { summary: 'Confirm TOTP enrolment', body: v.mfaCode }, c.mfaEnable);
user.post('/mfa/disable', { summary: 'Disable TOTP', body: v.mfaDisable }, c.mfaDisable);
user.post('/workspaces', { summary: 'Create an additional workspace owned by the current user', body: v.createWorkspace }, c.createWorkspace);

module.exports = { publicRouter: pub.router, userRouter: user.router };
