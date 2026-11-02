'use strict';

const { signUp } = require('../helpers/app');
const { sequelize, Lead, Contact, AuditLog } = require('../../src/models');
const { runInTenant } = require('../../src/context/requestContext');

afterAll(() => sequelize.close());

let a;
let b;
const recordsA = {};

beforeAll(async () => {
  a = await signUp({ company: 'Tenant A' });
  b = await signUp({ company: 'Tenant B' });
  const c = a.client;
  recordsA.accounts = (await c.post('/api/v1/accounts', { name: 'A-Account' })).body.data;
  recordsA.contacts = (await c.post('/api/v1/contacts', { first_name: 'A', last_name: 'Contact', account_id: recordsA.accounts.id })).body.data;
  recordsA.leads = (await c.post('/api/v1/leads', { last_name: 'A-Lead', email: 'a-lead@a.test' })).body.data;
  recordsA.opportunities = (await c.post('/api/v1/opportunities', { name: 'A-Deal', amount: '999' })).body.data;
  recordsA.activities = (await c.post('/api/v1/activities', { type: 'task', subject: 'A-Task' })).body.data;
});

const ENTITIES = ['accounts', 'contacts', 'leads', 'opportunities', 'activities'];

describe('cross-tenant access by id is denied for every CRM module', () => {
  test.each(ENTITIES)('%s: get / update / delete / timeline / assignments → 404', async (route) => {
    const id = recordsA[route].id;
    const c = b.client;
    expect((await c.get(`/api/v1/${route}/${id}`)).status).toBe(404);
    expect((await c.patch(`/api/v1/${route}/${id}`, { description: 'hacked' })).status).toBe(404);
    expect((await c.delete(`/api/v1/${route}/${id}`)).status).toBe(404);
    expect((await c.get(`/api/v1/${route}/${id}/timeline`)).status).toBe(404);
    expect((await c.get(`/api/v1/${route}/${id}/assignments`)).status).toBe(404);
    const bulk = await c.post(`/api/v1/${route}/bulk`, { ids: [id], action: 'delete' });
    expect(bulk.body.data.succeeded).toHaveLength(0);
    // record still intact for its owner
    expect((await a.client.get(`/api/v1/${route}/${id}`)).status).toBe(200);
  });

  test.each(ENTITIES)('%s: lists, search, filters and exports never include other tenants', async (route) => {
    const c = b.client;
    const list = await c.get(`/api/v1/${route}?page_size=100`);
    expect(list.body.data.find((r) => r.id === recordsA[route].id)).toBeUndefined();
    const byOwner = await c.get(`/api/v1/${route}?filter[owner_id]=${a.user.id}`);
    expect(byOwner.body.data).toHaveLength(0);
    const csv = await c.get(`/api/v1/${route}/export`);
    expect(csv.text).not.toContain(recordsA[route].id);
  });

  test('cannot reference another tenant\'s records in foreign keys', async () => {
    const c = b.client;
    const contact = await c.post('/api/v1/contacts', { first_name: 'B', account_id: recordsA.accounts.id });
    expect(contact.status).toBe(422);
    const opp = await c.post('/api/v1/opportunities', { name: 'B deal', account_id: recordsA.accounts.id });
    expect(opp.status).toBe(422);
    const act = await c.post('/api/v1/activities', { type: 'task', subject: 'B', lead_id: recordsA.leads.id });
    expect(act.status).toBe(422);
    const owner = await c.post('/api/v1/leads', { last_name: 'B', owner_id: a.user.id });
    expect([403, 422]).toContain(owner.status);
    const conv = await c.post(`/api/v1/leads/${recordsA.leads.id}/convert`, {});
    expect(conv.status).toBe(404);
    const merge = await c.post('/api/v1/contacts/merge', { primary_id: recordsA.contacts.id, duplicate_ids: [recordsA.contacts.id] });
    expect([404, 422]).toContain(merge.status);
  });

  test('cannot select a foreign pipeline, role, team or invitation', async () => {
    const c = b.client;
    const pipeA = (await a.client.get('/api/v1/pipelines')).body.data[0];
    expect((await c.get(`/api/v1/pipelines/${pipeA.id}`)).status).toBe(404);
    const roleA = (await a.client.get('/api/v1/roles')).body.data.find((r) => r.key === 'admin');
    expect((await c.get(`/api/v1/roles/${roleA.id}`)).status).toBe(404);
    expect((await c.patch(`/api/v1/roles/${roleA.id}`, { name: 'pwned' })).status).toBe(404);
    const inv = await c.post('/api/v1/invitations', { email: 'x@b.test', role_ids: [roleA.id] });
    expect(inv.status).toBe(422);
    const membersA = (await a.client.get('/api/v1/users')).body.data;
    expect((await c.patch(`/api/v1/users/${membersA[0].id}`, { status: 'disabled' })).status).toBe(404);
  });

  test('custom field definitions and values are tenant-private', async () => {
    const def = (await a.client.post('/api/v1/custom-fields', { entity_type: 'lead', label: 'Secret tier', field_type: 'text' })).body.data;
    expect((await b.client.get('/api/v1/custom-fields?entity_type=lead')).body.data.find((d) => d.id === def.id)).toBeUndefined();
    expect((await b.client.patch(`/api/v1/custom-fields/${def.id}`, { label: 'x' })).status).toBe(404);
    const write = await b.client.post('/api/v1/leads', { last_name: 'B', custom_fields: { secret_tier: 'x' } });
    expect(write.status).toBe(422);
  });

  test('audit logs are tenant-private', async () => {
    const rows = await runInTenant(b.tenant.id, () => AuditLog.findAll({ where: { entity_id: recordsA.leads.id } }));
    expect(rows).toHaveLength(0);
  });
});

describe('data-layer guarantees', () => {
  test('tenant-scoped queries without a tenant context throw', async () => {
    await expect(Lead.findAll()).rejects.toThrow(/Tenant context missing/);
    await expect(Contact.count()).rejects.toThrow(/Tenant context missing/);
    await expect(Lead.update({ status: 'new' }, { where: {} })).rejects.toThrow(/Tenant context missing/);
    await expect(Lead.create({ last_name: 'x' })).rejects.toThrow(/Tenant context missing/);
  });

  test('queries are scoped automatically and cross-tenant writes are blocked', async () => {
    const seen = await runInTenant(b.tenant.id, () => Lead.findByPk(recordsA.leads.id));
    expect(seen).toBeNull();
    const n = await runInTenant(b.tenant.id, () => Lead.update({ last_name: 'pwn' }, { where: { id: recordsA.leads.id } }));
    expect(n[0]).toBe(0);
    await expect(runInTenant(b.tenant.id, () => Lead.create({ last_name: 'x', tenant_id: a.tenant.id }))).rejects.toThrow(/another tenant/);
    const leadA = await runInTenant(a.tenant.id, () => Lead.findByPk(recordsA.leads.id));
    await expect(runInTenant(b.tenant.id, () => leadA.update({ last_name: 'pwn' }))).rejects.toThrow(/Cross-tenant/);
    await expect(runInTenant(a.tenant.id, () => leadA.update({ tenant_id: b.tenant.id }))).rejects.toThrow();
  });

  test('client-supplied tenant identifiers are ignored', async () => {
    const res = await b.client.get('/api/v1/leads', { 'X-Tenant-ID': a.tenant.id });
    expect(res.body.data.find((r) => r.id === recordsA.leads.id)).toBeUndefined();
    const q = await b.client.get(`/api/v1/leads?tenant_id=${a.tenant.id}`);
    expect(q.body.data.find((r) => r.id === recordsA.leads.id)).toBeUndefined();
    const body = await b.client.post('/api/v1/leads', { last_name: 'x', tenant_id: a.tenant.id });
    expect(body.status).toBe(422);
  });
});
