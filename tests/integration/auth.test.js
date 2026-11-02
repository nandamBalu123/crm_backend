'use strict';

const { signUp, client, lastEmailTo, tokenFrom, drain, uniq } = require('../helpers/app');
const totp = require('../../src/modules/auth/totp');
const { sequelize } = require('../../src/models');

afterAll(() => sequelize.close());

describe('registration and onboarding', () => {
  test('sign-up creates tenant, owner membership, roles and default pipeline', async () => {
    const owner = await signUp();
    expect(owner.me.tenant.name).toMatch(/Acme/);
    expect(owner.me.membership.is_owner).toBe(true);
    expect(owner.me.permissions['leads:read']).toBe('all');
    expect(owner.me.permissions['billing:manage']).toBe('all');
    const pipelines = await owner.client.get('/api/v1/pipelines');
    expect(pipelines.status).toBe(200);
    expect(pipelines.body.data[0].stages).toHaveLength(6);
    const roles = await owner.client.get('/api/v1/roles');
    expect(roles.body.data.map((r) => r.key).sort()).toEqual(['admin', 'marketing', 'owner', 'read_only', 'sales_manager', 'sales_rep', 'support_agent']);
  });

  test('rejects weak passwords and duplicate emails; never echoes password hashes', async () => {
    const c = await client();
    const weak = await c.post('/api/v1/auth/register', { company_name: 'X', first_name: 'A', email: `w-${uniq()}@example.test`, password: 'short' });
    expect(weak.status).toBe(422);
    const owner = await signUp();
    const dup = await c.post('/api/v1/auth/register', { company_name: 'Y', first_name: 'A', email: owner.email, password: 'Long-enough-pass-1' });
    expect(dup.status).toBe(409);
    expect(JSON.stringify(owner.me)).not.toMatch(/password_hash|argon2/);
  });

  test('mass assignment of unknown fields is rejected', async () => {
    const c = await client();
    const res = await c.post('/api/v1/auth/register', { company_name: 'Z', first_name: 'A', email: `m-${uniq()}@example.test`, password: 'Long-enough-pass-1', is_platform_admin: true });
    expect(res.status).toBe(422);
  });
});

describe('login, lockout, refresh rotation, logout', () => {
  test('login sets HttpOnly cookies and /me works; wrong password is generic', async () => {
    const owner = await signUp();
    const c = await client();
    const bad = await c.post('/api/v1/auth/login', { email: owner.email, password: 'wrong-password-123' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
    const unknown = await c.post('/api/v1/auth/login', { email: `nobody-${uniq()}@example.test`, password: 'wrong-password-123' });
    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS');
    const ok = await c.post('/api/v1/auth/login', { email: owner.email, password: owner.password });
    expect(ok.status).toBe(200);
    const cookies = ok.headers['set-cookie'].join(';');
    expect(cookies).toMatch(/crm_at=.*HttpOnly/);
    expect(cookies).toMatch(/crm_rt=.*HttpOnly/);
    expect((await c.get('/api/v1/auth/me')).status).toBe(200);
  });

  test('account locks after repeated failures', async () => {
    const owner = await signUp();
    const c = await client();
    for (let i = 0; i < 5; i += 1) await c.post('/api/v1/auth/login', { email: owner.email, password: 'wrong-password-123' });
    const locked = await c.post('/api/v1/auth/login', { email: owner.email, password: owner.password });
    expect(locked.status).toBe(423);
  });

  test('refresh rotates the token and detects reuse of an old token', async () => {
    const owner = await signUp();
    const c = await client();
    const login = await c.post('/api/v1/auth/login', { email: owner.email, password: owner.password });
    const firstRt = /crm_rt=([^;]+)/.exec(login.headers['set-cookie'].join(';'))[1];
    const r1 = await c.post('/api/v1/auth/refresh');
    expect(r1.status).toBe(200);
    // Replaying the first token after the grace window must revoke the session.
    const { UserSession } = require('../../src/models');
    await UserSession.update({ rotated_at: new Date(Date.now() - 60_000) }, { where: { user_id: owner.user.id } });
    const attacker = await client();
    const replay = await attacker.agent.post('/api/v1/auth/refresh').set('Origin', 'http://localhost:5173').set('Cookie', `crm_rt=${firstRt}`);
    expect(replay.status).toBe(401);
    const after = await c.post('/api/v1/auth/refresh');
    expect(after.status).toBe(401);
  });

  test('logout revokes the session', async () => {
    const owner = await signUp();
    expect((await owner.client.post('/api/v1/auth/logout')).status).toBe(204);
    expect((await owner.client.get('/api/v1/auth/me')).status).toBe(401);
  });

  test('CSRF token is required for cookie-authenticated unsafe requests', async () => {
    const owner = await signUp();
    const res = await owner.client.agent.post('/api/v1/leads').set('Origin', 'http://localhost:5173').send({ last_name: 'NoCsrf' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
    const evil = await owner.client.post('/api/v1/leads', { last_name: 'Evil' }, { Origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
  });
});

describe('password reset and email verification', () => {
  test('reset link is single-use and revokes sessions', async () => {
    const owner = await signUp();
    const c = await client();
    expect((await c.post('/api/v1/auth/forgot-password', { email: owner.email })).status).toBe(202);
    expect((await c.post('/api/v1/auth/forgot-password', { email: `ghost-${uniq()}@example.test` })).status).toBe(202);
    await drain();
    const token = tokenFrom(lastEmailTo(owner.email));
    const reset = await c.post('/api/v1/auth/reset-password', { token, password: 'Brand-New-Pass-42' });
    expect(reset.status).toBe(200);
    const again = await c.post('/api/v1/auth/reset-password', { token, password: 'Another-New-Pass-42' });
    expect(again.status).toBe(400);
    expect((await owner.client.get('/api/v1/auth/me')).status).toBe(401);
    expect((await c.post('/api/v1/auth/login', { email: owner.email, password: 'Brand-New-Pass-42' })).status).toBe(200);
  });

  test('unverified users are blocked from tenant APIs', async () => {
    const c = await client();
    const email = `unverified-${uniq()}@example.test`;
    await c.post('/api/v1/auth/register', { company_name: 'Unverified Co', first_name: 'U', email, password: 'Long-enough-pass-1' });
    const res = await c.get('/api/v1/leads');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });
});

describe('MFA (TOTP)', () => {
  test('enrol, sign in with code, reject replay, use recovery code', async () => {
    const owner = await signUp();
    const setup = await owner.client.post('/api/v1/auth/mfa/setup');
    const { secret } = setup.body.data;
    const enable = await owner.client.post('/api/v1/auth/mfa/enable', { code: totp.generate(secret) });
    expect(enable.status).toBe(200);
    const recovery = enable.body.data.recovery_codes;
    expect(recovery).toHaveLength(10);

    const c = await client();
    const step1 = await c.post('/api/v1/auth/login', { email: owner.email, password: owner.password });
    expect(step1.body.data.mfa_required).toBe(true);
    const wrong = await c.post('/api/v1/auth/mfa/verify', { mfa_token: step1.body.data.mfa_token, code: '000000' });
    expect(wrong.status).toBe(401);
    const next = totp.generate(secret, Date.now() + 30_000);
    const ok = await c.post('/api/v1/auth/mfa/verify', { mfa_token: step1.body.data.mfa_token, code: next });
    expect(ok.status).toBe(200);
    const replay = await (await client()).post('/api/v1/auth/mfa/verify', { mfa_token: step1.body.data.mfa_token, code: next });
    expect(replay.status).toBe(401);
    const rc = await (await client()).post('/api/v1/auth/mfa/verify', { mfa_token: step1.body.data.mfa_token, recovery_code: recovery[0] });
    expect(rc.status).toBe(200);
  });
});

describe('sessions and workspaces', () => {
  test('list and revoke sessions; create and switch workspaces', async () => {
    const owner = await signUp();
    const sessions = await owner.client.get('/api/v1/auth/sessions');
    expect(sessions.body.data.some((s) => s.current)).toBe(true);
    const ws = await owner.client.post('/api/v1/auth/workspaces', { company_name: 'Second Co' });
    expect(ws.status).toBe(201);
    let me = (await owner.client.get('/api/v1/auth/me')).body.data;
    expect(me.tenant.id).toBe(ws.body.data.id);
    expect(me.workspaces).toHaveLength(2);
    await owner.client.post('/api/v1/auth/switch-tenant', { tenant_id: owner.tenant.id });
    me = (await owner.client.get('/api/v1/auth/me')).body.data;
    expect(me.tenant.id).toBe(owner.tenant.id);
    const other = await signUp();
    const hijack = await owner.client.post('/api/v1/auth/switch-tenant', { tenant_id: other.tenant.id });
    expect(hijack.status).toBe(403);
  });
});
