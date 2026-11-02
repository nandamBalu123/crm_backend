'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { bootstrap } = require('../../src/bootstrap');
const queue = require('../../src/jobs/queue');
const { captured } = require('../../src/integrations/mail/mailer');
const { User } = require('../../src/models');

let app;
let booted = false;

async function getApp() {
  if (!booted) {
    await bootstrap();
    booted = true;
  }
  if (!app) app = createApp();
  return app;
}

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/**
 * A cookie-carrying API client that behaves like the SPA: stores cookies,
 * echoes the CSRF cookie in X-CSRF-Token and sends an allowed Origin.
 */
class Client {
  constructor(appInstance) {
    this.agent = request.agent(appInstance);
    this.csrf = null;
  }
  updateCsrf(res) {
    for (const c of [].concat(res.headers['set-cookie'] || [])) {
      const m = /^crm_csrf=([^;]*)/.exec(c);
      if (m) this.csrf = decodeURIComponent(m[1]);
    }
    return res;
  }
  req(method, url, body, headers = {}) {
    let r = this.agent[method](url).set('Origin', 'http://localhost:5173');
    if (this.csrf) r = r.set('X-CSRF-Token', this.csrf);
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    if (body !== undefined) r = r.send(body);
    return r.then((res) => this.updateCsrf(res));
  }
  get(url, headers) { return this.req('get', url, undefined, headers); }
  post(url, body, headers) { return this.req('post', url, body ?? {}, headers); }
  patch(url, body, headers) { return this.req('patch', url, body, headers); }
  put(url, body, headers) { return this.req('put', url, body, headers); }
  delete(url, headers) { return this.req('delete', url, undefined, headers); }
}

async function client() {
  return new Client(await getApp());
}

function lastEmailTo(email) {
  return [...captured].reverse().find((m) => m.to === email);
}

function tokenFrom(message, param = 'token') {
  const m = new RegExp(`${param}=([A-Za-z0-9_-]+)`).exec(message.text);
  return m && m[1];
}

/** Registers a new tenant + owner, verifies the email, returns a signed-in client. */
async function signUp({ company = `Acme ${uniq()}`, email = `owner-${uniq()}@example.test`, password = 'Sup3r-Secret-Pass!', first = 'Olivia', last = 'Owner' } = {}) {
  const c = await client();
  const res = await c.post('/api/v1/auth/register', { company_name: company, first_name: first, last_name: last, email, password });
  if (res.status !== 201) throw new Error(`register failed ${res.status} ${JSON.stringify(res.body)}`);
  await queue.drain();
  const token = tokenFrom(lastEmailTo(email));
  const v = await c.post('/api/v1/auth/verify-email', { token });
  if (v.status !== 200) throw new Error(`verify failed ${v.status} ${JSON.stringify(v.body)}`);
  const me = await c.get('/api/v1/auth/me');
  return { client: c, email, password, tenant: res.body.data.tenant, user: res.body.data.user, me: me.body.data };
}

/** Invites a user with the given role keys and returns a signed-in client for them. */
async function inviteUser(owner, { roleKeys = ['sales_rep'], email = `user-${uniq()}@example.test`, password = 'An0ther-Secret-Pass!', first = 'Uma', teamIds } = {}) {
  const roles = (await owner.client.get('/api/v1/roles')).body.data;
  const roleIds = roleKeys.map((k) => {
    const role = roles.find((r) => r.key === k || r.name === k);
    if (!role) throw new Error(`role ${k} not found`);
    return role.id;
  });
  const inv = await owner.client.post('/api/v1/invitations', { email, role_ids: roleIds, ...(teamIds ? { team_ids: teamIds } : {}) });
  if (inv.status !== 201) throw new Error(`invite failed ${inv.status} ${JSON.stringify(inv.body)}`);
  await queue.drain();
  const token = tokenFrom(lastEmailTo(email));
  const c = await client();
  const acc = await c.post('/api/v1/auth/invitations/accept', { token, first_name: first, last_name: 'User', password });
  if (acc.status !== 200) throw new Error(`accept failed ${acc.status} ${JSON.stringify(acc.body)}`);
  const me = await c.get('/api/v1/auth/me');
  return { client: c, email, password, user: acc.body.data.user, me: me.body.data };
}

async function makePlatformAdmin(email) {
  await User.update({ is_platform_admin: true }, { where: { email } });
  require('../../src/middleware/authenticate').invalidateUserSessions();
}

module.exports = { getApp, client, signUp, inviteUser, lastEmailTo, tokenFrom, uniq, drain: () => queue.drain(), makePlatformAdmin };
