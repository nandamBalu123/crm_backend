'use strict';

const { signUp, inviteUser } = require('../helpers/app');
const { sequelize } = require('../../src/models');

afterAll(() => sequelize.close());

let owner;
beforeAll(async () => {
  owner = await signUp();
});

describe('leads', () => {
  test('create, list with filters/search/sort, update with optimistic lock, score', async () => {
    const c = owner.client;
    const a = await c.post('/api/v1/leads', { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.test', phone: '+1 555 0100', company: 'Analytical Engines', title: 'VP Engineering', rating: 'hot', source: 'referral' });
    expect(a.status).toBe(201);
    expect(a.body.data.score).toBe(10 + 10 + 25 + 15 + 15);
    expect(a.body.data.owner.id).toBe(owner.user.id);
    expect(a.body.data.tenant_id).toBeUndefined();
    await c.post('/api/v1/leads', { last_name: 'Babbage', company: 'Difference Inc', status: 'contacted' });

    const list = await c.get('/api/v1/leads?filter[status]=contacted&sort=-created_at&page_size=10');
    expect(list.status).toBe(200);
    expect(list.body.data.every((l) => l.status === 'contacted')).toBe(true);
    expect(list.body.meta).toMatchObject({ page: 1, page_size: 10 });
    const search = await c.get('/api/v1/leads?q=Analytical');
    expect(search.body.data).toHaveLength(1);
    const gte = await c.get('/api/v1/leads?filter[score][gte]=50');
    expect(gte.body.data.map((l) => l.id)).toContain(a.body.data.id);

    const bad = await c.get('/api/v1/leads?filter[password_hash]=x');
    expect(bad.status).toBe(422);
    const badSort = await c.get('/api/v1/leads?sort=tenant_id');
    expect(badSort.status).toBe(422);

    const id = a.body.data.id;
    const upd = await c.patch(`/api/v1/leads/${id}`, { status: 'qualified', version: a.body.data.version });
    expect(upd.status).toBe(200);
    const stale = await c.patch(`/api/v1/leads/${id}`, { status: 'nurturing', version: a.body.data.version });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    const tl = await c.get(`/api/v1/leads/${id}/timeline`);
    expect(tl.body.data.items.map((i) => i.event_type)).toEqual(expect.arrayContaining(['created', 'updated']));
    const direct = await c.patch(`/api/v1/leads/${id}`, { status: 'converted' });
    expect(direct.status).toBe(422);
    const tamper = await c.patch(`/api/v1/leads/${id}`, { tenant_id: owner.tenant.id });
    expect(tamper.status).toBe(422);
  });

  test('duplicate detection and conversion to contact, account and opportunity', async () => {
    const c = owner.client;
    const lead = (await c.post('/api/v1/leads', { first_name: 'Grace', last_name: 'Hopper', email: 'grace@navy.test', company: 'Navy Labs', status: 'qualified' })).body.data;
    const dup = await c.get('/api/v1/leads/duplicates?email=grace@navy.test');
    expect(dup.body.data.leads.map((l) => l.id)).toContain(lead.id);
    await c.post('/api/v1/activities', { type: 'call', subject: 'Intro call', lead_id: lead.id });
    const conv = await c.post(`/api/v1/leads/${lead.id}/convert`, { create_opportunity: true, opportunity: { amount: '12500.50', expected_close_date: '2026-12-31' } });
    expect(conv.status).toBe(200);
    const { contact_id: contactId, account_id: accountId, opportunity_id: oppId } = conv.body.data;
    expect(contactId && accountId && oppId).toBeTruthy();
    const contact = (await c.get(`/api/v1/contacts/${contactId}`)).body.data;
    expect(contact.account.id).toBe(accountId);
    const opp = (await c.get(`/api/v1/opportunities/${oppId}`)).body.data;
    expect(opp.amount).toBe('12500.50');
    expect(opp.stage.name).toBe('Qualification');
    const again = await c.post(`/api/v1/leads/${lead.id}/convert`, {});
    expect(again.status).toBe(409);
    const contactTimeline = (await c.get(`/api/v1/contacts/${contactId}/timeline`)).body.data.items;
    expect(contactTimeline.some((i) => i.kind === 'activity' && i.subject === 'Intro call')).toBe(true);
  });
});

describe('opportunities pipeline', () => {
  test('stage transitions update probability/status, record history, require loss reason', async () => {
    const c = owner.client;
    const pipeline = (await c.get('/api/v1/pipelines')).body.data[0];
    const stages = Object.fromEntries(pipeline.stages.map((s) => [s.name, s]));
    const opp = (await c.post('/api/v1/opportunities', { name: 'Big deal', amount: '1000' })).body.data;
    expect(opp.probability).toBe(10);
    const moved = await c.post(`/api/v1/opportunities/${opp.id}/move`, { stage_id: stages.Proposal.id });
    expect(moved.body.data.probability).toBe(50);
    expect(moved.body.data.weighted_amount).toBe('500.00');
    const lost = await c.post(`/api/v1/opportunities/${opp.id}/move`, { stage_id: stages['Closed lost'].id });
    expect(lost.status).toBe(422);
    const won = await c.post(`/api/v1/opportunities/${opp.id}/move`, { stage_id: stages['Closed won'].id });
    expect(won.body.data.status).toBe('won');
    expect(won.body.data.closed_at).toBeTruthy();
    const history = (await c.get(`/api/v1/opportunities/${opp.id}/stage-history`)).body.data;
    expect(history.map((h) => h.toStage.name)).toEqual(['Qualification', 'Proposal', 'Closed won']);
    const board = (await c.get(`/api/v1/opportunities/board?pipeline_id=${pipeline.id}`)).body.data;
    expect(board.columns).toHaveLength(6);
    const other = (await signUp()).client;
    const foreignStage = (await other.get('/api/v1/pipelines')).body.data[0].stages[0];
    const cross = await c.post(`/api/v1/opportunities/${opp.id}/move`, { stage_id: foreignStage.id });
    expect(cross.status).toBe(422);
  });
});

describe('accounts, contacts, activities', () => {
  test('account hierarchy cycle prevention, merge contacts, recurring task completion', async () => {
    const c = owner.client;
    const parent = (await c.post('/api/v1/accounts', { name: 'Parent Corp', website: 'https://www.parent.test' })).body.data;
    expect(parent.domain).toBe('parent.test');
    const child = (await c.post('/api/v1/accounts', { name: 'Child Ltd', parent_account_id: parent.id })).body.data;
    const cycle = await c.patch(`/api/v1/accounts/${parent.id}`, { parent_account_id: child.id });
    expect(cycle.status).toBe(422);

    const p = (await c.post('/api/v1/contacts', { first_name: 'Pat', last_name: 'Primary', email: 'pat@x.test' })).body.data;
    const d = (await c.post('/api/v1/contacts', { first_name: 'Pat', last_name: 'Dup', email: 'pat@x.test', phone: '+1 555 0199', account_id: child.id })).body.data;
    await c.post('/api/v1/activities', { type: 'note', subject: 'Note on dup', contact_id: d.id });
    const dups = await c.get(`/api/v1/contacts/duplicates?email=pat@x.test&exclude_id=${p.id}`);
    expect(dups.body.data.contacts.map((x) => x.id)).toEqual([d.id]);
    const merged = await c.post('/api/v1/contacts/merge', { primary_id: p.id, duplicate_ids: [d.id] });
    expect(merged.status).toBe(200);
    expect(merged.body.data.phone).toBe('+1 555 0199');
    expect(merged.body.data.account.id).toBe(child.id);
    expect((await c.get(`/api/v1/contacts/${d.id}`)).status).toBe(404);

    const task = (await c.post('/api/v1/activities', { type: 'task', subject: 'Weekly check-in', due_at: '2026-11-02T09:00:00Z', contact_id: p.id, recurrence: { freq: 'weekly', interval: 1, count: 3 } })).body.data;
    expect(task.account_id).toBe(child.id);
    const done = await c.post(`/api/v1/activities/${task.id}/complete`, {});
    expect(done.body.data.status).toBe('completed');
    const open = (await c.get(`/api/v1/activities?filter[contact_id]=${p.id}&filter[status]=open`)).body.data;
    expect(open.some((x) => x.subject === 'Weekly check-in' && x.due_at.startsWith('2026-11-09'))).toBe(true);
  });

  test('CSV export is permission-aware and neutralises formula injection', async () => {
    const c = owner.client;
    await c.post('/api/v1/leads', { last_name: '=HYPERLINK("http://evil")', company: 'Csv Co' });
    const res = await c.get('/api/v1/leads/export?q=Csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain(`'=HYPERLINK`);
  });

  test('bulk assign within team and idempotent create', async () => {
    const c = owner.client;
    const rep = await inviteUser(owner, { roleKeys: ['sales_rep'] });
    const l1 = (await c.post('/api/v1/leads', { last_name: 'Bulk1' })).body.data;
    const l2 = (await c.post('/api/v1/leads', { last_name: 'Bulk2' })).body.data;
    const bulk = await c.post('/api/v1/leads/bulk', { ids: [l1.id, l2.id], action: 'assign', data: { owner_id: rep.user.id } });
    expect(bulk.body.data.succeeded).toHaveLength(2);
    const repList = (await rep.client.get('/api/v1/leads')).body.data.map((l) => l.id);
    expect(repList).toEqual(expect.arrayContaining([l1.id, l2.id]));
    const assigned = (await c.get(`/api/v1/leads/${l1.id}/assignments`)).body.data;
    expect(assigned[0].to_owner_id).toBe(rep.user.id);
    const notes = (await rep.client.get('/api/v1/me/notifications')).status;
    expect([200, 404]).toContain(notes);

    const key = `idem-${Date.now()}`;
    const r1 = await c.post('/api/v1/leads', { last_name: 'Idem' }, { 'Idempotency-Key': key });
    const r2 = await c.post('/api/v1/leads', { last_name: 'Idem' }, { 'Idempotency-Key': key });
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(r2.body.data.id).toBe(r1.body.data.id);
    const r3 = await c.post('/api/v1/leads', { last_name: 'Different' }, { 'Idempotency-Key': key });
    expect(r3.status).toBe(422);
  });
});
