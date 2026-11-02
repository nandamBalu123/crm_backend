'use strict';

const { signUp, inviteUser, drain } = require('../helpers/app');
const { sequelize, Ticket } = require('../../src/models');
const { runInTenant } = require('../../src/context/requestContext');
const { checkSla } = require('../../src/modules/tickets/sla.job');

afterAll(() => sequelize.close());

let owner;
beforeAll(async () => {
  owner = await signUp();
});

describe('products and quotes', () => {
  test('server-side decimal totals, discount rules, approval workflow, revisions, PDF', async () => {
    const c = owner.client;
    const p1 = (await c.post('/api/v1/products', { sku: 'SKU-1', name: 'Seat licence', unit_price: '19.99', tax_rate: '8.25' })).body.data;
    const p2 = (await c.post('/api/v1/products', { sku: 'SKU-2', name: 'Onboarding', unit_price: '1000', max_discount_percent: '10' })).body.data;
    await c.post('/api/v1/products/discount-rules', { name: 'Volume', product_id: p1.id, min_quantity: '10', discount_percent: '5' });
    const dupSku = await c.post('/api/v1/products', { sku: 'SKU-1', name: 'Dup', unit_price: '1' });
    expect(dupSku.status).toBe(409);

    const q = await c.post('/api/v1/quotes', { title: 'Annual plan', line_items: [{ product_id: p1.id, quantity: '12' }, { product_id: p2.id, quantity: '1', discount_percent: '20' }] });
    expect(q.status).toBe(201);
    const quote = q.body.data;
    // 12 × 19.99 = 239.88; rule 5% → 11.99 (11.994 rounds half-up to 11.99); taxable 227.89 × 8.25% = 18.80 (18.800925)
    const l1 = quote.lineItems[0];
    expect([l1.line_subtotal, l1.line_discount, l1.line_tax, l1.line_total]).toEqual(['239.88', '11.99', '18.80', '246.69']);
    expect(quote.lineItems[1].line_total).toBe('800.00');
    expect(quote.total).toBe('1046.69');
    expect(quote.number).toBeGreaterThan(0);

    const submitted = (await c.post(`/api/v1/quotes/${quote.id}/submit`)).body.data;
    expect(submitted.status).toBe('pending_approval'); // 20% > 15% threshold and > product max
    expect((await c.patch(`/api/v1/quotes/${quote.id}`, { title: 'x' })).status).toBe(409);
    const rep = await inviteUser(owner, { roleKeys: ['sales_rep'] });
    expect((await rep.client.post(`/api/v1/quotes/${quote.id}/approve`, {})).status).toBe(403);
    const approved = await c.post(`/api/v1/quotes/${quote.id}/approve`, { comment: 'OK for strategic account' });
    expect(approved.body.data.status).toBe('approved');
    expect((await c.post(`/api/v1/quotes/${quote.id}/send`)).body.data.status).toBe('sent');
    const rev = await c.post(`/api/v1/quotes/${quote.id}/revise`);
    expect(rev.status).toBe(201);
    expect(rev.body.data.revision).toBe(2);
    expect(rev.body.data.number).toBe(quote.number);
    expect((await c.get(`/api/v1/quotes/${quote.id}`)).body.data.status).toBe('superseded');
    const revisions = (await c.get(`/api/v1/quotes/${rev.body.data.id}/revisions`)).body.data;
    expect(revisions).toHaveLength(2);
    const pdf = await c.get(`/api/v1/quotes/${quote.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.slice(0, 5).toString()).toBe('%PDF-');

    const small = (await c.post('/api/v1/quotes', { title: 'Small', line_items: [{ name: 'Custom work', quantity: '2.5', unit_price: '100.10' }] })).body.data;
    expect(small.total).toBe('250.25');
    expect((await c.post(`/api/v1/quotes/${small.id}/submit`)).body.data.status).toBe('approved');
  });
});

describe('support tickets and SLA', () => {
  test('ticket numbering, SLA due dates, first response, escalation, resolution', async () => {
    const c = owner.client;
    const contact = (await c.post('/api/v1/contacts', { first_name: 'Sam', last_name: 'Support', email: 'sam@cust.test' })).body.data;
    const t1 = (await c.post('/api/v1/tickets', { subject: 'Cannot log in', priority: 'urgent', contact_id: contact.id })).body.data;
    const t2 = (await c.post('/api/v1/tickets', { subject: 'Question' })).body.data;
    expect(t2.number).toBe(t1.number + 1);
    expect(new Date(t1.first_response_due_at) - new Date(t1.created_at)).toBeGreaterThanOrEqual(59 * 60_000);
    expect(t1.sla_status).toBe('on_track');

    await c.post(`/api/v1/tickets/${t1.id}/comments`, { body: 'Investigating internally', is_internal: true });
    expect((await c.get(`/api/v1/tickets/${t1.id}`)).body.data.first_responded_at).toBeNull();
    await c.post(`/api/v1/tickets/${t1.id}/comments`, { body: 'We are on it!' });
    const after = (await c.get(`/api/v1/tickets/${t1.id}`)).body.data;
    expect(after.first_responded_at).toBeTruthy();
    expect(after.status).toBe('open');

    // Simulate a breached resolution deadline and run the SLA monitor.
    await runInTenant(owner.tenant.id, () => Ticket.update({ resolution_due_at: new Date(Date.now() - 60_000) }, { where: { id: t1.id } }));
    const res = await checkSla();
    expect(res.escalated).toBeGreaterThanOrEqual(1);
    const esc = (await c.get(`/api/v1/tickets/${t1.id}`)).body.data;
    expect(esc.escalation_level).toBe(2);
    expect(esc.sla_breached).toBe(true);
    const notes = (await c.get('/api/v1/me/notifications')).body.data.items;
    expect(notes.some((n) => n.type === 'ticket.escalated')).toBe(true);
    const resolved = (await c.patch(`/api/v1/tickets/${t1.id}`, { status: 'resolved' })).body.data;
    expect(resolved.resolved_at).toBeTruthy();
    expect(resolved.sla_status).toBe('breached');
    const conv = (await c.get(`/api/v1/tickets/${t1.id}/comments`)).body.data;
    expect(conv).toHaveLength(2);
    expect((await c.get(`/api/v1/contacts/${contact.id}/related`)).body.data.tickets.total).toBe(1);
  });
});

describe('marketing: campaigns, segments, public forms, consent', () => {
  test('public form submission creates attributed lead with consent; honeypot and validation', async () => {
    const c = owner.client;
    const campaign = (await c.post('/api/v1/campaigns', { name: 'Spring webinar', type: 'webinar', status: 'active', budget: '500' })).body.data;
    const form = (await c.post('/api/v1/forms', {
      name: 'Webinar signup', campaign_id: campaign.id, require_consent: true, consent_text: 'I agree to receive emails',
      fields: [{ key: 'first_name', label: 'First name', type: 'text' }, { key: 'last_name', label: 'Last name', type: 'text', required: true }, { key: 'email', label: 'Email', type: 'email', required: true }, { key: 'company', label: 'Company', type: 'text' }],
    })).body.data;
    const anon = (await require('../helpers/app').client());
    const def = await anon.get(`/api/v1/public/forms/${form.public_key}`);
    expect(def.status).toBe(200);
    expect(def.body.data.fields).toHaveLength(4);
    expect(JSON.stringify(def.body.data)).not.toContain(owner.tenant.id);

    const invalid = await anon.post(`/api/v1/public/forms/${form.public_key}/submit`, { data: { last_name: 'X', email: 'not-an-email' }, consent: true });
    expect(invalid.status).toBe(422);
    const noConsent = await anon.post(`/api/v1/public/forms/${form.public_key}/submit`, { data: { last_name: 'X', email: 'x@lead.test' } });
    expect(noConsent.status).toBe(422);
    const spam = await anon.post(`/api/v1/public/forms/${form.public_key}/submit`, { data: { last_name: 'Bot', email: 'bot@spam.test' }, consent: true, _hp: 'gotcha' });
    expect(spam.status).toBe(201);
    const okRes = await anon.post(`/api/v1/public/forms/${form.public_key}/submit`, { data: { first_name: 'Wendy', last_name: 'Web', email: 'Wendy@Lead.test', company: 'Webco', tenant_id: 'ignored' }, consent: true });
    expect(okRes.status).toBe(201);
    const leads = (await c.get('/api/v1/leads?q=Webco')).body.data;
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ email: 'wendy@lead.test', source: 'web_form', campaign_id: campaign.id });
    expect((await c.get('/api/v1/leads?q=Bot')).body.data).toHaveLength(0);
    // resubmission attaches to the same lead
    await anon.post(`/api/v1/public/forms/${form.public_key}/submit`, { data: { last_name: 'Web', email: 'wendy@lead.test' }, consent: true });
    expect((await c.get('/api/v1/leads?filter[email]=wendy@lead.test')).body.data).toHaveLength(1);
    const perf = (await c.get(`/api/v1/campaigns/${campaign.id}/performance`)).body.data;
    expect(perf.leads).toBe(1);
    expect(perf.members.responded).toBe(1);
    expect((await anon.get('/api/v1/public/forms/doesnotexist123456789')).status).toBe(404);
  });

  test('segments resolve with filters and add members; opted-out contacts excluded', async () => {
    const c = owner.client;
    await c.post('/api/v1/contacts', { first_name: 'Seg', last_name: 'One', email: 'seg1@x.test', lead_source: 'event' });
    await c.post('/api/v1/contacts', { first_name: 'Seg', last_name: 'Two', email: 'seg2@x.test', lead_source: 'event', email_opt_out: true });
    const seg = (await c.post('/api/v1/campaigns/segments', { name: 'Event contacts', entity_type: 'contact', filters: { filter: { lead_source: 'event' } } })).body.data;
    expect((await c.get(`/api/v1/campaigns/segments/${seg.id}/preview`)).body.data.count).toBe(1);
    const camp = (await c.post('/api/v1/campaigns', { name: 'Event follow-up' })).body.data;
    const added = await c.post(`/api/v1/campaigns/${camp.id}/members`, { segment_id: seg.id });
    expect(added.body.data.added).toBe(1);
    const again = await c.post(`/api/v1/campaigns/${camp.id}/members`, { segment_id: seg.id });
    expect(again.body.data.added).toBe(0);
    const badSeg = await c.post('/api/v1/campaigns/segments', { name: 'Bad', entity_type: 'contact', filters: { filter: { password: 'x' } } });
    expect(badSeg.status).toBe(422);
  });

  test('communications respect opt-out and never fake delivery without a provider', async () => {
    const c = owner.client;
    const optedOut = (await c.post('/api/v1/contacts', { first_name: 'No', last_name: 'Mail', email: 'nomail@x.test', email_opt_out: true })).body.data;
    const blocked = await c.post('/api/v1/communications', { contact_id: optedOut.id, subject: 'Hi', body: '<p>Hello</p>' });
    expect(blocked.body.data.status).toBe('blocked');
    const consents = (await c.get(`/api/v1/contacts/${optedOut.id}/consents`)).body.data;
    expect(consents[0]).toMatchObject({ channel: 'email', status: 'revoked' });
    const ok = (await c.post('/api/v1/contacts', { first_name: 'Yes', last_name: 'Mail', email: 'yesmail@x.test' })).body.data;
    const queued = await c.post('/api/v1/communications', { contact_id: ok.id, subject: 'Hi {{first_name}}', body: '<p>Hello {{first_name}}<script>alert(1)</script></p>' });
    expect(queued.body.data.status).toBe('queued');
    expect(queued.body.data.subject).toBe('Hi Yes');
    expect(queued.body.data.body).not.toContain('<script');
    await drain();
    const after = (await c.get(`/api/v1/communications/${queued.body.data.id}`)).body.data;
    expect(after.status).toBe('failed');
    expect(after.status_reason).toMatch(/No email provider is connected/);
  });
});

describe('custom fields end to end', () => {
  test('define, validate, store typed values, filter, sort, archive', async () => {
    const c = owner.client;
    const tier = (await c.post('/api/v1/custom-fields', { entity_type: 'account', label: 'Tier', field_type: 'select', is_required: true, options: [{ value: 'gold', label: 'Gold' }, { value: 'silver', label: 'Silver' }], show_in_list: true })).body.data;
    const seats = (await c.post('/api/v1/custom-fields', { entity_type: 'account', label: 'Seats', field_type: 'integer', validation: { min: 1, max: 1000 } })).body.data;
    const tags = (await c.post('/api/v1/custom-fields', { entity_type: 'account', label: 'Tags', field_type: 'multiselect', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] })).body.data;
    const renewal = (await c.post('/api/v1/custom-fields', { entity_type: 'account', label: 'Renewal', field_type: 'date' })).body.data;
    expect(tier.key).toBe('tier');
    expect((await c.post('/api/v1/custom-fields', { entity_type: 'account', key: 'name', label: 'Name', field_type: 'text' })).status).toBe(422);
    expect((await c.post('/api/v1/custom-fields', { entity_type: 'account', label: 'Bad', field_type: 'select', options: [] })).status).toBe(422);
    expect((await c.post('/api/v1/custom-fields', { entity_type: 'account', label: 'Bad2', field_type: 'integer', validation: { min: 10, max: 1 } })).status).toBe(422);

    const missing = await c.post('/api/v1/accounts', { name: 'No tier' });
    expect(missing.status).toBe(422);
    const bad = await c.post('/api/v1/accounts', { name: 'Bad', custom_fields: { tier: 'platinum', seats: '5000', tags: ['z'], renewal: '2026-02-30' } });
    expect(bad.body.error.details.map((d) => d.path).sort()).toEqual(['custom_fields.renewal', 'custom_fields.seats', 'custom_fields.tags', 'custom_fields.tier']);
    const a1 = (await c.post('/api/v1/accounts', { name: 'CF One', custom_fields: { tier: 'gold', seats: '50', tags: ['a', 'b'], renewal: '2027-01-15' } })).body.data;
    await c.post('/api/v1/accounts', { name: 'CF Two', custom_fields: { tier: 'silver', seats: '5' } });
    expect(a1.custom_fields).toEqual({ tier: 'gold', seats: '50', tags: ['a', 'b'], renewal: '2027-01-15' });

    expect((await c.get('/api/v1/accounts?cf[tier]=gold')).body.data.map((a) => a.name)).toEqual(['CF One']);
    expect((await c.get('/api/v1/accounts?cf[seats][gte]=10')).body.data.map((a) => a.name)).toEqual(['CF One']);
    expect((await c.get('/api/v1/accounts?cf[tags][contains]=b')).body.data.map((a) => a.name)).toEqual(['CF One']);
    const sorted = (await c.get('/api/v1/accounts?cf[tier][in]=gold,silver&sort=cf.seats')).body.data.map((a) => a.name);
    expect(sorted).toEqual(['CF Two', 'CF One']);
    expect((await c.get("/api/v1/accounts?cf[seats][gte]=1' OR 1=1")).status).toBe(422);

    const upd = await c.patch(`/api/v1/accounts/${a1.id}`, { custom_fields: { seats: '60' } });
    expect(upd.body.data.custom_fields.seats).toBe('60');
    const audit = (await c.get(`/api/v1/audit-logs?entity_id=${a1.id}`)).body.data;
    expect(audit.find((x) => x.action === 'account.updated').changes['cf.seats']).toEqual({ from: '50', to: '60' });

    // removing an option in use keeps it inactive rather than orphaning data
    await c.patch(`/api/v1/custom-fields/${tier.id}`, { options: [{ value: 'gold', label: 'Gold' }] });
    const tierNow = (await c.get('/api/v1/custom-fields?entity_type=account')).body.data.find((d) => d.id === tier.id);
    expect(tierNow.options.find((o) => o.value === 'silver').is_active).toBe(false);
    expect((await c.post('/api/v1/accounts', { name: 'Silver new', custom_fields: { tier: 'silver' } })).status).toBe(422);

    expect((await c.delete(`/api/v1/custom-fields/${renewal.id}`)).status).toBe(204);
    const acc = (await c.get(`/api/v1/accounts/${a1.id}`)).body.data;
    expect(acc.custom_fields.renewal).toBeUndefined();
    const csv = await c.get('/api/v1/accounts/export');
    expect(csv.text.split('\n')[0]).toContain('cf.tier');
    expect(seats && tags).toBeTruthy();
  });
});

describe('files', () => {
  test('upload validates content, enforces parent access, signed links expire to tenant', async () => {
    const c = owner.client;
    const lead = (await c.post('/api/v1/leads', { last_name: 'Files' })).body.data;
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    const up = await c.agent.post('/api/v1/attachments').set('Origin', 'http://localhost:5173').set('X-CSRF-Token', c.csrf)
      .field('entity_type', 'lead').field('entity_id', lead.id).attach('file', pdf, { filename: 'proposal.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(201);
    expect(up.body.data.storage_key).toBeUndefined();
    const fake = await c.agent.post('/api/v1/attachments').set('Origin', 'http://localhost:5173').set('X-CSRF-Token', c.csrf)
      .field('entity_type', 'lead').field('entity_id', lead.id).attach('file', Buffer.from('<html><script>alert(1)</script></html>'), { filename: 'evil.pdf', contentType: 'application/pdf' });
    expect(fake.status).toBe(422);
    const svg = await c.agent.post('/api/v1/attachments').set('Origin', 'http://localhost:5173').set('X-CSRF-Token', c.csrf)
      .field('entity_type', 'lead').field('entity_id', lead.id).attach('file', Buffer.from('<svg onload="x"/>'), { filename: 'x.svg' });
    expect(svg.status).toBe(422);
    const dl = await c.get(`/api/v1/attachments/${up.body.data.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['content-disposition']).toMatch(/attachment/);
    const link = (await c.post(`/api/v1/attachments/${up.body.data.id}/link`)).body.data.url;
    const anon = await require('../helpers/app').client();
    expect((await anon.get(new URL(link).pathname)).status).toBe(200);
    expect((await anon.get(`${new URL(link).pathname}x`)).status).toBe(404);

    const other = await signUp();
    expect((await other.client.get(`/api/v1/attachments/${up.body.data.id}/download`)).status).toBe(404);
    expect((await other.client.get(`/api/v1/attachments?entity_type=lead&entity_id=${lead.id}`)).status).toBe(404);
    const rep = await inviteUser(owner, { roleKeys: ['sales_rep'] });
    expect((await rep.client.get(`/api/v1/attachments/${up.body.data.id}/download`)).status).toBe(404);
  });
});
