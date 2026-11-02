'use strict';

const { z, email, password, requiredText, trimmed, uuid } = require('../../utils/schemas');

const register = z.strictObject({
  company_name: requiredText(160),
  first_name: requiredText(80),
  last_name: trimmed(80).default(''),
  email: email(),
  password: password(),
});
const login = z.strictObject({ email: email(), password: z.string().min(1).max(128), tenant_slug: trimmed(63).optional() });
const mfaVerify = z.strictObject({
  mfa_token: z.string().min(10).max(2000),
  code: z.string().regex(/^\d{6}$/).optional(),
  recovery_code: z.string().min(6).max(20).optional(),
  tenant_slug: trimmed(63).optional(),
}).refine((v) => v.code || v.recovery_code, { message: 'code or recovery_code is required', path: ['code'] });
const token = z.strictObject({ token: z.string().min(10).max(200) });
const forgot = z.strictObject({ email: email() });
const reset = z.strictObject({ token: z.string().min(10).max(200), password: password() });
const changePassword = z.strictObject({ current_password: z.string().min(1).max(128), new_password: password() });
const mfaCode = z.strictObject({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') });
const mfaDisable = z.strictObject({ password: z.string().min(1).max(128), code: z.string().regex(/^\d{6}$/) });
const switchTenant = z.strictObject({ tenant_id: uuid() });
const acceptInvitation = z.strictObject({
  token: z.string().min(10).max(200),
  first_name: trimmed(80).optional(),
  last_name: trimmed(80).optional(),
  password: password().optional(),
});
const profile = z.strictObject({
  first_name: requiredText(80).optional(),
  last_name: trimmed(80).optional(),
  phone: trimmed(40).nullish(),
  locale: trimmed(16).nullish(),
  timezone: trimmed(64).nullish(),
});
const createWorkspace = z.strictObject({ company_name: requiredText(160) });

module.exports = { register, login, mfaVerify, token, forgot, reset, changePassword, mfaCode, mfaDisable, switchTenant, acceptInvitation, profile, createWorkspace };
