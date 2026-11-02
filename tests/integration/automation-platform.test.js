'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { signUp, inviteUser, drain, makePlatformAdmin, client } = require('../helpers/app');
const { sequelize, AuditLog } = require('../../src/models');
const { runInTenant } = require('../../src/context/requestContext');
const { runScheduled } = require('../../src/modules/workflows/engine');

let owner;
let receiver;
let received = [];
let receiverStatus = 200;

beforeAll(async () => {
  owner = await signUp();
  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(receiverStatus).end('ok');
    });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
});
afterAll(async () => {
  receiver.close();
  await sequelize.close();
});
const receiverUrl = () => `http://127.0.0.1:${receiver.address().port}/hook`;

describe('workflow automation', () => {
  test('lead.created workflow with conditions creates a task, assigns owner and notifies; history recorded', async () => {
    const c = owner.client;
    const rep = await inviteUser(owner, { roleKeys: ['sales_rep'] });
    const wf = await c.post('/api/v1/workflows', {
      name: 'Hot lead follow-up', entity_type: 'lead', trigger: { type: 'record.created' },
      conditions: { all: [{ field: 'rating', op: 'eq', value: 'hot' }] },
      actions: [
        { type: 'assign_owner', params: { strategy: 'round_robin', user_ids: [rep.user.id] } },
        { type: 'create_task', params: { subject: 'Call hot lead within 1 day', due_in_days: 1, assign_to: 'record_owner' } },
        { type: 'notify', params: { recipients: ['trigger_user'], title: 'Hot lead routed' } },
      ],
    });
    expect(wf.status).toBe(201);
    const bad = await c.post('/api/v1/workflows', { name: 'Evil', entity_type: 'lead', trigger: { type: 'record.created' }, actions: [{ type: 'run_code', params: { js: 'process.exit()' } }] });
    expect(bad.status).toBe(422);
    const cold = (await c.post('/api/v1/leads', { last_name: 'Cold', rating: 'cold' })).body.data;
    const hot = (await c.post('/api/v1/leads', { last_name: 'Hot', rating: 'hot' })).body.data;
    await drain();
    const hotNow = (await c.get(`/api/v1/leads/${hot.id}`)).body.data;
    expect(hotNow.owner.id).toBe(rep.user.id);
    const tasks = (await c.get(`/api/v1/activities?filter[lead_id]=${hot.id}`)).body.data;
    expect(tasks.map((t) => t.subject)).toContain('Call hot lead within 1 day');
    expect(tasks[0].owner.id).toBe(rep.user.id);
    expect((await c.get(`/api/v1/activities?filter[lead_id]=${cold.id}`)).body.data).toHaveLength(0);
    const runs = (await c.get(`/api/v1/workflows/${wf.body.data.id}/runs`)).body.data;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('succeeded');
    expect(runs[0].steps.map((s) => s.type)).toEqual(['assign_owner', 'create_task', 'notify']);
    // Re-dispatching the same event must not run the workflow twice.
    await drain();
    expect((await c.get(`/api/v1/workflows/${wf.body.data.id}/runs`)).body.data).toHaveLength(1);
  });

  test('field.changed and update_field actions; failures are recorded and retryable', async () => {
    const c = owner.client;
    await c.post('/api/v1/workflows', {
      name: 'Qualified → rating hot', entity_type: 'lead', trigger: { type: 'field.changed', field: 'status', to_value: 'qualified' },
      actions: [{ type: 'update_field', params: { field: 'rating', value: 'hot' } }],
    });
    const failing = (await c.post('/api/v1/workflows', {
      name: 'Bad field', entity_type: 'lead', trigger: { type: 'field.changed', field: 'status', to_value: 'qualified' },
      actions: [{ type: 'update_field', params: { field: 'tenant_id', value: 'x' } }],
    })).body.data;
    const lead = (await c.post('/api/v1/leads', { last_name: 'Changer' })).body.data;
    await drain();
    await c.patch(`/api/v1/leads/${lead.id}`, { status: 'qualified' });
    await drain();
    expect((await c.get(`/api/v1/leads/${lead.id}`)).body.data.rating).toBe('hot');
    const runs = (await c.get(`/api/v1/workflows/${failing.id}/runs`)).body.data;
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error).toMatch(/cannot be updated/);
    const retry = await c.post(`/api/v1/workflows/runs/${runs[0].id}/retry`);
    expect(retry.body.data.status).toBe('failed');
    expect((await c.get('/api/v1/me/notifications')).body.data.items.some((n) => n.title.startsWith('Workflow failed'))).toBe(true);
  });

  test('scheduled workflow runs once per matching record', async () => {
    const c = owner.client;
    const wf = (await c.post('/api/v1/workflows', {
      name: 'Nudge stale opps', entity_type: 'opportunity', trigger: { type: 'scheduled', interval_minutes: 60 },
      conditions: { all: [{ field: 'status', op: 'eq', value: 'open' }, { field: 'amount', op: 'gte', value: 1000 }] },
      actions: [{ type: 'create_task', params: { subject: 'Review big open deal' } }],
    })).body.data;
    await c.post('/api/v1/opportunities', { name: 'Big one', amount: '5000' });
    await c.post('/api/v1/opportunities', { name: 'Small one', amount: '10' });
    await runScheduled();
    await runInTenant(owner.tenant.id, () => require('../../src/models').Workflow.update({ next_run_at: new Date(0) }, { where: { id: wf.id } }));
    await runScheduled();
    const runs = (await c.get(`/api/v1/workflows/${wf.id}/runs`)).body.data;
    expect(runs.filter((r) => r.status === 'succeeded')).toHaveLength(1);
  });
});

describe('outgoing webhooks', () => {
  test('signed deliveries with retries, history and tenant isolation', async () => {
    const c = owner.client;
    received = [];
    const ep = (await c.post('/api/v1/webhooks', { url: receiverUrl(), events: ['lead.created'] })).body.data;
    expect(ep.secret).toMatch(/^whsec_/);
    expect((await c.get('/api/v1/webhooks')).body.data[0].secret_encrypted).toBeUndefined();
    const lead = (await c.post('/api/v1/leads', { last_name: 'Hooked', email: 'hook@x.test' })).body.data;
    await drain();
    const hit = received.find((r) => JSON.parse(r.body).data?.id === lead.id);
    expect(hit).toBeTruthy();
    const [, t, v1] = /t=(\d+),v1=([a-f0-9]+)/.exec(hit.headers['x-crm-signature']);
    expect(crypto.createHmac('sha256', ep.secret).update(`${t}.${hit.body}`).digest('hex')).toBe(v1);
    expect(JSON.parse(hit.body).data.tenant_id).toBeUndefined();

    receiverStatus = 500;
    received = [];
    await c.post('/api/v1/leads', { last_name: 'Fails' });
    await drain({ maxRounds: 3 });
    const deliveries = (await c.get(`/api/v1/webhooks/${ep.id}/deliveries`)).body.data;
    const failed = deliveries.find((d) => d.status === 'failed');
    expect(failed.response_status).toBe(500);
    receiverStatus = 200;
    const re = await c.post(`/api/v1/webhooks/deliveries/${failed.id}/redeliver`);
    expect(re.status).toBe(200);

    const other = await signUp();
    expect((await other.client.get(`/api/v1/webhooks/${ep.id}/deliveries`)).body.data).toHaveLength(0);
    received = [];
    await other.client.post('/api/v1/leads', { last_name: 'OtherTenant' });
    await drain();
    expect(received.some((r) => r.body.includes('OtherTenant'))).toBe(false);
  });

  test('SSRF protection rejects internal targets when private networks are disallowed', async () => {
    const env = require('../../src/config/env');
    const { assertSafeUrl } = require('../../src/utils/safeFetch');
    expect(env.OUTBOUND_ALLOW_PRIVATE_NETWORKS).toBe(true); // test env only
    const { isPrivateIp } = require('../../src/utils/safeFetch');
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.5.5', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', '100.64.0.1']) expect(isPrivateIp(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isPrivateIp(ip)).toBe(false);
    await expect(assertSafeUrl('ftp://example.com')).rejects.toThrow();
    await expect(assertSafeUrl('http://user:pass@example.com')).rejects.toThrow();
  });
});

describe('API keys', () => {
  test('scoped, tenant-bound, cannot exceed creator, revocable', async () => {
    const enterprise = await signUp();
    const admin = await signUp();
    await makePlatformAdmin(admin.email);
    await admin.client.post(`/api/v1/platform/tenants/${enterprise.tenant.id}/plan`, { plan_code: 'enterprise' });
    const c = enterprise.client;
    const key = await c.post('/api/v1/api-keys', { name: 'Zapier', scopes: { 'leads:read': 'all', 'leads:create': 'all' } });
    expect(key.status).toBe(201);
    const raw = key.body.data.key;
    expect((await c.get('/api/v1/api-keys')).body.data[0].key_hash).toBeUndefined();
    const anon = await client();
    const auth = { Authorization: `Bearer ${raw}` };
    const created = await anon.agent.post('/api/v1/leads').set(auth).send({ last_name: 'Via API' });
    expect(created.status).toBe(201);
    expect((await anon.agent.get('/api/v1/leads').set(auth)).body.data.some((l) => l.id === created.body.data.id)).toBe(true);
    expect((await anon.agent.get('/api/v1/contacts').set(auth)).status).toBe(403);
    expect((await anon.agent.delete(`/api/v1/leads/${created.body.data.id}`).set(auth)).status).toBe(403);
    expect((await anon.agent.post('/api/v1/api-keys').set(auth).send({ name: 'x', scopes: { 'leads:read': 'all' } })).status).toBe(403);
    const foreignLead = (await owner.client.post('/api/v1/leads', { last_name: 'Foreign' })).body.data;
    expect((await anon.agent.get(`/api/v1/leads/${foreignLead.id}`).set(auth)).status).toBe(404);
    expect((await anon.agent.get('/api/v1/leads').set({ Authorization: `Bearer ${raw}x` })).status).toBe(401);

    const rep = await inviteUser(enterprise, { roleKeys: ['admin'] });
    const esc = await rep.client.post('/api/v1/api-keys', { name: 'Esc', scopes: { 'billing:manage': 'all' } });
    expect(esc.status).toBe(403);
    await c.delete(`/api/v1/api-keys/${key.body.data.id}`);
    expect((await anon.agent.get('/api/v1/leads').set(auth)).status).toBe(401);
    const growth = await owner.client.post('/api/v1/api-keys', { name: 'NoPlan', scopes: { 'leads:read': 'all' } });
    expect(growth.status).toBe(403);
    expect(growth.body.error.code).toBe('MODULE_DISABLED');
  });
});

describe('imports', () => {
  test('CSV upload → mapping → dry-run row errors → background import with duplicate skip', async () => {
    const c = owner.client;
    await c.post('/api/v1/leads', { last_name: 'Existing', email: 'dup@import.test' });
    const csv = 'First Name,Last Name,Email Address,Company,Owner\nIvy,Import,ivy@import.test,Ivy Co,\n,NoEmail,,Nobody Inc,\nDup,Lead,dup@import.test,Dup Co,\nBad,Row,not-an-email,Bad Co,\nZed,Owner,zed@import.test,Zed Co,ghost@nowhere.test\n';
    const up = await c.agent.post('/api/v1/imports').set('Origin', 'http://localhost:5173').set('X-CSRF-Token', c.csrf).field('entity_type', 'lead').attach('file', Buffer.from(csv), { filename: 'leads.csv' });
    expect(up.status).toBe(201);
    const imp = up.body.data.import;
    expect(imp.mapping).toMatchObject({ 'First Name': 'first_name', 'Last Name': 'last_name', 'Email Address': 'email', Company: 'company', Owner: 'owner_email' });
    expect(up.body.data.preview).toHaveLength(5);
    const dry = (await c.post(`/api/v1/imports/${imp.id}/validate`, {})).body.data;
    expect(dry.checked).toBe(5);
    expect(dry.errors.map((e) => e.row).sort()).toEqual([5, 6]);
    expect((await c.post(`/api/v1/imports/${imp.id}/validate`, { mapping: { Company: 'password_hash' } })).status).toBe(422);
    await c.post(`/api/v1/imports/${imp.id}/start`, { duplicate_strategy: 'skip' });
    await drain();
    const done = (await c.get(`/api/v1/imports/${imp.id}`)).body.data;
    expect(done).toMatchObject({ status: 'completed', created_rows: 2, skipped_rows: 1, error_rows: 2 });
    expect((await c.get('/api/v1/leads?q=Ivy Co')).body.data[0].source).toBe('import');
    const rep = await inviteUser(owner, { roleKeys: ['sales_rep'] });
    expect((await rep.client.get(`/api/v1/imports/${imp.id}`)).status).toBe(403);
  });
});

describe('reports, dashboard, search', () => {
  test('saved summary report, analytics and dashboard are permission-aware', async () => {
    const c = owner.client;
    const pipeline = (await c.get('/api/v1/pipelines')).body.data[0];
    const won = pipeline.stages.find((s) => s.category === 'won');
    const o1 = (await c.post('/api/v1/opportunities', { name: 'Rpt A', amount: '300' })).body.data;
    await c.post(`/api/v1/opportunities/${o1.id}/move`, { stage_id: won.id });
    await c.post('/api/v1/opportunities', { name: 'Rpt B', amount: '700' });
    const rep = await c.post('/api/v1/reports', { name: 'Pipeline by status', entity_type: 'opportunity', group_by: 'status', metric: { fn: 'sum', field: 'amount' } });
    expect(rep.status).toBe(201);
    const run = (await c.get(`/api/v1/reports/${rep.body.data.id}/run`)).body.data.result.rows;
    expect(run.find((r) => r.group === 'won').value).toBeGreaterThanOrEqual(300);
    const monthly = (await c.post('/api/v1/reports/run', { entity_type: 'lead', group_by: 'created_at:month' })).body.data;
    expect(monthly.rows.length).toBeGreaterThan(0);
    expect((await c.post('/api/v1/reports/run', { entity_type: 'lead', group_by: 'password_hash' })).status).toBe(422);
    const csv = await c.get(`/api/v1/reports/${rep.body.data.id}/export`);
    expect(csv.text).toMatch(/^group,label,value/);
    const dash = (await c.get('/api/v1/reports/dashboard?preset=this_year')).body.data;
    expect(dash.kpis).toHaveProperty('pipeline_value');
    expect(dash.kpis).toHaveProperty('open_tickets');
    expect(dash.widgets).toEqual(expect.arrayContaining(['funnel', 'pipeline', 'activities', 'support']));
    for (const p of ['funnel', 'pipeline', 'forecast', 'conversion', 'activities', 'sales-performance']) expect((await c.get(`/api/v1/reports/analytics/${p}?preset=this_year`)).status).toBe(200);

    const sales = await inviteUser(owner, { roleKeys: ['sales_rep'] });
    await sales.client.post('/api/v1/opportunities', { name: 'Rep deal', amount: '50' });
    const repDash = (await sales.client.get('/api/v1/reports/dashboard?preset=this_year')).body.data;
    expect(Number(repDash.kpis.pipeline_value)).toBe(50);
    expect(repDash.kpis.open_tickets).toBeUndefined();
    const support = await inviteUser(owner, { roleKeys: ['support_agent'] });
    const supDash = (await support.client.get('/api/v1/reports/dashboard')).body.data;
    expect(supDash.widgets).toEqual(expect.arrayContaining(['support']));
    expect(supDash.widgets).not.toContain('pipeline');

    const s = (await c.get('/api/v1/search?q=Rpt')).body.data;
    expect(s.find((g) => g.type === 'opportunity').items.length).toBe(2);
    const repSearch = (await sales.client.get('/api/v1/search?q=Rpt')).body.data;
    expect(repSearch.find((g) => g.type === 'opportunity')).toBeUndefined();
  });
});

describe('integrations', () => {
  test('connections never fake success; secrets are never returned', async () => {
    const c = owner.client;
    const catalog = (await c.get('/api/v1/integrations/providers')).body.data;
    expect(catalog.map((p) => p.key)).toEqual(expect.arrayContaining(['smtp', 'sendgrid', 'twilio', 'slack', 'google_workspace', 's3', 'stripe']));
    expect(catalog.find((p) => p.key === 'google_workspace').platform_ready).toBe(false);
    const google = await c.post('/api/v1/integrations', { provider: 'google_workspace' });
    expect(google.status).toBe(409);
    expect(google.body.error.code).toBe('PLATFORM_CONFIG_REQUIRED');
    const badKey = await c.post('/api/v1/integrations', { provider: 'sendgrid', config: { from_email: 'a@b.test' }, secrets: { api_key: 'nope' } });
    expect(badKey.status).toBe(422);

    const realFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({ errors: [{ message: 'The provided authorization grant is invalid' }] }), { status: 401 });
    try {
      const conn = (await c.post('/api/v1/integrations', { provider: 'sendgrid', config: { from_email: 'sales@acme.test' }, secrets: { api_key: 'SG.abc.def' } })).body.data;
      expect(conn.status).toBe('configured');
      expect(JSON.stringify(conn)).not.toContain('SG.abc.def');
      expect(conn.secrets_set).toEqual(['api_key']);
      const test = (await c.post(`/api/v1/integrations/${conn.id}/test`)).body.data;
      expect(test.ok).toBe(false);
      expect(test.connection.status).toBe('error');
      expect(test.message).toMatch(/401/);
      global.fetch = async () => new Response(JSON.stringify({ scopes: ['mail.send'] }), { status: 200 });
      const good = (await c.post(`/api/v1/integrations/${conn.id}/test`)).body.data;
      expect(good.ok).toBe(true);
      expect(good.connection.status).toBe('connected');
      let sent;
      global.fetch = async (url, init) => { sent = { url: String(url), init }; return new Response('', { status: 202, headers: { 'x-message-id': 'msg-1' } }); };
      const contact = (await c.post('/api/v1/contacts', { first_name: 'Ema', last_name: 'Il', email: 'ema@x.test' })).body.data;
      const comm = (await c.post('/api/v1/communications', { contact_id: contact.id, subject: 'Hello', body: '<p>Hi</p>' })).body.data;
      await drain();
      expect(sent.url).toBe('https://api.sendgrid.com/v3/mail/send');
      expect((await c.get(`/api/v1/communications/${comm.id}`)).body.data).toMatchObject({ status: 'sent', provider: 'sendgrid', provider_message_id: 'msg-1' });
    } finally {
      global.fetch = realFetch;
    }
  });

  test('inbound lead webhook verifies signature and suppresses duplicates', async () => {
    const c = owner.client;
    const conn = (await c.post('/api/v1/integrations', { provider: 'inbound_leads', config: { field_map: { fullname: 'last_name', mail: 'email' } } })).body.data;
    const path = new URL(conn.inbound_url).pathname;
    const body = JSON.stringify({ fullname: 'Inbound Ian', mail: 'IAN@inbound.test' });
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', conn.signing_secret).update(`${t}.${body}`).digest('hex');
    const anon = await client();
    const send = (s, id = 'evt-1') => anon.agent.post(path).set('Content-Type', 'application/json').set('X-CRM-Timestamp', String(t)).set('X-CRM-Signature', `v1=${s}`).set('X-CRM-Event-Id', id).send(body);
    expect((await send('deadbeef')).status).toBe(401);
    const ok = await send(sig);
    expect(ok.status).toBe(201);
    const dup = await send(sig);
    expect(dup.status).toBe(200);
    expect(dup.body.data.duplicate).toBe(true);
    const leads = (await c.get('/api/v1/leads?filter[email]=ian@inbound.test')).body.data;
    expect(leads).toHaveLength(1);
    expect(leads[0].source).toBe('inbound_webhook');
  });
});

describe('platform administration and audit', () => {
  test('only platform admins; suspension blocks tenant access; actions audited', async () => {
    const tenant = await signUp();
    expect((await tenant.client.get('/api/v1/platform/tenants')).status).toBe(403);
    const admin = await signUp();
    await makePlatformAdmin(admin.email);
    const list = await admin.client.get(`/api/v1/platform/tenants?q=${encodeURIComponent(tenant.tenant.name)}`);
    expect(list.body.data[0].id).toBe(tenant.tenant.id);
    expect((await admin.client.get('/api/v1/platform/health')).body.data.database).toBe('ok');
    // Platform admins get no CRM data access through the platform API.
    expect(Object.keys((await admin.client.get(`/api/v1/platform/tenants/${tenant.tenant.id}`)).body.data).sort()).toEqual(['active_users', 'owner', 'subscription', 'tenant', 'usage']);
    await admin.client.post(`/api/v1/platform/tenants/${tenant.tenant.id}/suspend`, { reason: 'Payment overdue' });
    const blocked = await tenant.client.get('/api/v1/leads');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('TENANT_SUSPENDED');
    await admin.client.post(`/api/v1/platform/tenants/${tenant.tenant.id}/reactivate`);
    expect((await tenant.client.get('/api/v1/leads')).status).toBe(200);
    const logs = (await tenant.client.get('/api/v1/audit-logs?action=tenant.*')).body.data.map((l) => l.action);
    expect(logs).toEqual(expect.arrayContaining(['tenant.suspended', 'tenant.reactivated', 'tenant.created']));
    const platformLog = (await admin.client.get('/api/v1/platform/audit')).body.data;
    expect(platformLog.some((l) => l.action === 'tenant.suspended')).toBe(true);
  });

  test('audit logs are immutable and access controlled', async () => {
    const t = await signUp();
    const lead = (await t.client.post('/api/v1/leads', { last_name: 'Audited' })).body.data;
    const entry = await runInTenant(t.tenant.id, () => AuditLog.findOne({ where: { entity_id: lead.id } }));
    await expect(runInTenant(t.tenant.id, () => entry.update({ summary: 'tampered' }))).rejects.toThrow(/immutable/);
    await expect(runInTenant(t.tenant.id, () => AuditLog.destroy({ where: { id: entry.id } }))).rejects.toThrow();
    const rep = await inviteUser(t, { roleKeys: ['sales_rep'] });
    expect((await rep.client.get('/api/v1/audit-logs')).status).toBe(403);
    expect((await t.client.post('/api/v1/audit-logs', {})).status).toBe(404);
    const exp = await t.client.get('/api/v1/audit-logs/export');
    expect(exp.text).toContain('lead.created');
  });
});
