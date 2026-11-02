'use strict';

const { signUp, inviteUser } = require('../helpers/app');
const { sequelize } = require('../../src/models');

afterAll(() => sequelize.close());

let owner;
let rep;
let rep2;
let manager;
let readOnly;
let team;

beforeAll(async () => {
  owner = await signUp();
  team = (await owner.client.post('/api/v1/teams', { name: 'East' })).body.data;
  rep = await inviteUser(owner, { roleKeys: ['sales_rep'], teamIds: [team.id] });
  rep2 = await inviteUser(owner, { roleKeys: ['sales_rep'] });
  manager = await inviteUser(owner, { roleKeys: ['sales_manager'], teamIds: [team.id] });
  readOnly = await inviteUser(owner, { roleKeys: ['read_only'] });
});

describe('record-level scopes', () => {
  test('sales reps see only their own records; managers see their team', async () => {
    const mine = (await rep.client.post('/api/v1/leads', { last_name: 'RepLead' })).body.data;
    const other = (await rep2.client.post('/api/v1/leads', { last_name: 'Rep2Lead' })).body.data;
    const repList = (await rep.client.get('/api/v1/leads')).body.data.map((l) => l.id);
    expect(repList).toContain(mine.id);
    expect(repList).not.toContain(other.id);
    expect((await rep.client.get(`/api/v1/leads/${other.id}`)).status).toBe(404);
    expect((await rep.client.patch(`/api/v1/leads/${other.id}`, { status: 'contacted' })).status).toBe(404);

    const mgrList = (await manager.client.get('/api/v1/leads')).body.data.map((l) => l.id);
    expect(mgrList).toContain(mine.id);
    expect(mgrList).not.toContain(other.id);
    expect((await owner.client.get(`/api/v1/leads/${other.id}`)).status).toBe(200);
  });

  test('reps cannot assign records to others; managers only within their team', async () => {
    const lead = (await rep.client.post('/api/v1/leads', { last_name: 'Assign me' })).body.data;
    const r1 = await rep.client.patch(`/api/v1/leads/${lead.id}`, { owner_id: rep2.user.id });
    expect(r1.status).toBe(403);
    const r2 = await rep.client.post('/api/v1/leads', { last_name: 'X', owner_id: rep2.user.id });
    expect(r2.status).toBe(403);
    const m1 = await manager.client.patch(`/api/v1/leads/${lead.id}`, { owner_id: rep2.user.id });
    expect(m1.status).toBe(403);
    expect(m1.body.error.code).toBe('ASSIGN_SCOPE');
    const m2 = await manager.client.patch(`/api/v1/leads/${lead.id}`, { owner_id: manager.user.id });
    expect(m2.status).toBe(200);
  });
});

describe('missing permissions', () => {
  test('read-only users cannot create, update, delete or export', async () => {
    const lead = (await owner.client.post('/api/v1/leads', { last_name: 'RO' })).body.data;
    expect((await readOnly.client.get(`/api/v1/leads/${lead.id}`)).status).toBe(200);
    expect((await readOnly.client.post('/api/v1/leads', { last_name: 'nope' })).status).toBe(403);
    expect((await readOnly.client.patch(`/api/v1/leads/${lead.id}`, { status: 'contacted' })).status).toBe(403);
    expect((await readOnly.client.delete(`/api/v1/leads/${lead.id}`)).status).toBe(403);
    expect((await readOnly.client.get('/api/v1/leads/export')).status).toBe(403);
    expect((await readOnly.client.post('/api/v1/custom-fields', { entity_type: 'lead', label: 'X', field_type: 'text' })).status).toBe(403);
    expect((await readOnly.client.patch('/api/v1/settings', { currency: 'EUR' })).status).toBe(403);
  });

  test('reps cannot manage users, roles or settings', async () => {
    expect((await rep.client.get('/api/v1/roles')).status).toBe(403);
    expect((await rep.client.post('/api/v1/invitations', { email: 'x@y.test', role_ids: [] })).status).toBe(403);
    expect((await rep.client.patch('/api/v1/settings', { currency: 'EUR' })).status).toBe(403);
    expect((await rep.client.get('/api/v1/platform/tenants')).status).toBe(403);
  });
});

describe('role escalation prevention', () => {
  test('an admin cannot grant the owner role or permissions they lack', async () => {
    const admin = await inviteUser(owner, { roleKeys: ['admin'] });
    const roles = (await admin.client.get('/api/v1/roles')).body.data;
    const ownerRole = roles.find((r) => r.key === 'owner');
    const ownerEdit = await admin.client.patch(`/api/v1/roles/${ownerRole.id}`, { name: 'Mine' });
    expect(ownerEdit.status).toBe(403);
    const grantOwner = await admin.client.patch(`/api/v1/users/${admin.me.membership.id}`, { role_ids: [ownerRole.id] });
    expect(grantOwner.status).toBe(409); // self-modification blocked first
    const repMember = (await admin.client.get('/api/v1/users')).body.data.find((m) => m.user_id === rep.user.id);
    expect((await admin.client.patch(`/api/v1/users/${repMember.id}`, { role_ids: [ownerRole.id] })).status).toBe(403);
    const esc = await admin.client.post('/api/v1/roles', { name: 'Billing boss', permissions: { 'billing:manage': 'all' } });
    expect(esc.status).toBe(403);
    expect(esc.body.error.code).toBe('PRIVILEGE_ESCALATION');
    const unknown = await admin.client.post('/api/v1/roles', { name: 'Weird', permissions: { 'root:everything': 'all' } });
    expect(unknown.status).toBe(422);
  });

  test('custom role: create, assign, permissions take effect immediately, disable', async () => {
    const created = await owner.client.post('/api/v1/roles', { name: 'Lead qualifier', permissions: { 'leads:read': 'all', 'leads:update': 'all', 'dashboard:read': 'all' } });
    expect(created.status).toBe(201);
    const user = await inviteUser(owner, { roleKeys: ['Lead qualifier'] });
    const lead = (await owner.client.post('/api/v1/leads', { last_name: 'Q' })).body.data;
    expect((await user.client.get(`/api/v1/leads/${lead.id}`)).status).toBe(200);
    expect((await user.client.patch(`/api/v1/leads/${lead.id}`, { status: 'qualified' })).status).toBe(200);
    expect((await user.client.post('/api/v1/leads', { last_name: 'nope' })).status).toBe(403);
    expect((await user.client.get('/api/v1/contacts')).status).toBe(403);
    const clone = await owner.client.post(`/api/v1/roles/${created.body.data.id}/clone`, { name: 'Qualifier copy' });
    expect(clone.body.data.permissions).toEqual(created.body.data.permissions);
    await owner.client.patch(`/api/v1/roles/${created.body.data.id}`, { is_active: false });
    expect((await user.client.get(`/api/v1/leads/${lead.id}`)).status).toBe(403);
    expect((await owner.client.delete(`/api/v1/roles/${created.body.data.id}`)).status).toBe(409);
  });
});

describe('field-level restrictions', () => {
  test('hidden fields are stripped and read-only fields cannot be written', async () => {
    const created = await owner.client.post('/api/v1/roles', {
      name: 'Restricted rep',
      permissions: { 'opportunities:read': 'all', 'opportunities:update': 'all', 'opportunities:create': 'all', 'opportunities:export': 'all' },
    });
    const cfDef = (await owner.client.post('/api/v1/custom-fields', { entity_type: 'opportunity', label: 'Margin', field_type: 'percent' })).body.data;
    await owner.client.patch(`/api/v1/roles/${created.body.data.id}`, {
      field_permissions: [
        { entity_type: 'opportunity', field_key: 'amount', access: 'hidden' },
        { entity_type: 'opportunity', field_key: 'probability', access: 'read' },
        { entity_type: 'opportunity', field_key: `cf.${cfDef.key}`, access: 'hidden' },
      ],
    });
    const user = await inviteUser(owner, { roleKeys: ['Restricted rep'] });
    const opp = (await owner.client.post('/api/v1/opportunities', { name: 'Secret deal', amount: '50000', custom_fields: { [cfDef.key]: '35' } })).body.data;
    const seen = (await user.client.get(`/api/v1/opportunities/${opp.id}`)).body.data;
    expect(seen.amount).toBeUndefined();
    expect(seen.custom_fields[cfDef.key]).toBeUndefined();
    expect(seen.probability).toBe(10);
    expect((await user.client.patch(`/api/v1/opportunities/${opp.id}`, { probability: 90 })).status).toBe(403);
    expect((await user.client.patch(`/api/v1/opportunities/${opp.id}`, { amount: '1' })).status).toBe(403);
    expect((await user.client.patch(`/api/v1/opportunities/${opp.id}`, { custom_fields: { [cfDef.key]: '1' } })).status).toBe(422);
    expect((await user.client.patch(`/api/v1/opportunities/${opp.id}`, { next_step: 'Call' })).status).toBe(200);
    expect((await user.client.get('/api/v1/opportunities?filter[amount][gte]=1')).status).toBe(403);
    const csv = await user.client.get('/api/v1/opportunities/export');
    expect(csv.text.split('\n')[0]).not.toContain('amount');
    expect(csv.text).not.toContain('50000');
  });
});

