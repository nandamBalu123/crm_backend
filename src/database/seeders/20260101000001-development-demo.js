'use strict';

/**
 * DEVELOPMENT-ONLY seed.
 *  - Always: syncs the permission catalog and plans (idempotent, safe anywhere).
 *  - If SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are set: creates a verified
 *    owner and a "Demo Company" workspace. There is no hard-coded password.
 *  - If SEED_DEMO_DATA=true: adds fictional demo CRM data (example.test domains).
 * Refuses to create users or demo data when NODE_ENV=production.
 */
module.exports = {
  async up() {
    const env = require('../../config/env');
    const { syncCatalog } = require('../../modules/rbac/catalog.service');
    await syncCatalog();
    if (env.isProd) {
      console.log('NODE_ENV=production: only the permission catalog and plans were synced.');
      return;
    }
    const email = (process.env.SEED_ADMIN_EMAIL || '').toLowerCase();
    const password = process.env.SEED_ADMIN_PASSWORD;
    if (!email || !password) {
      console.log('SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set — skipping demo workspace.');
      return;
    }
    if (password.length < 10) throw new Error('SEED_ADMIN_PASSWORD must be at least 10 characters');
    const models = require('../../models');
    const { hashPassword } = require('../../modules/auth/password');
    const { provisionTenant } = require('../../modules/tenants/provisioning.service');
    const { runInTenant } = require('../../context/requestContext');
    const { User, Tenant } = models;

    let user = await User.findOne({ where: { email } });
    if (!user) user = await User.create({ email, first_name: 'Demo', last_name: 'Admin', password_hash: await hashPassword(password), email_verified_at: new Date(), password_changed_at: new Date() });
    let tenant = await Tenant.findOne({ where: { owner_user_id: user.id } });
    if (tenant) {
      console.log(`Demo workspace already exists for ${email}`);
      return;
    }
    tenant = await provisionTenant({ name: 'Demo Company', slug: 'demo', owner: user, planCode: 'enterprise' });
    console.log(`Created workspace "${tenant.name}" (${tenant.slug}) for ${email}`);
    if (process.env.SEED_DEMO_DATA !== 'true') return;

    await runInTenant(tenant.id, async () => {
      const { Account, Contact, Lead, Opportunity, Pipeline, PipelineStage, Activity, Product, Ticket } = models;
      const pipeline = await Pipeline.findOne({ where: { is_default: true } });
      const stages = await PipelineStage.findAll({ where: { pipeline_id: pipeline.id }, order: [['display_order', 'ASC']] });
      const owner = { owner_id: user.id };
      const companies = ['Northwind Analytics', 'Contoso Logistics', 'Fabrikam Robotics', 'Tailspin Travel', 'Woodgrove Health', 'Litware Studios', 'Adatum Energy', 'Proseware Labs'];
      const industries = ['Technology', 'Manufacturing', 'Healthcare', 'Retail', 'Finance'];
      const people = [['Ava', 'Martin'], ['Noah', 'Kim'], ['Mia', 'Patel'], ['Liam', 'Garcia'], ['Zoe', 'Okafor'], ['Ethan', 'Novak'], ['Lena', 'Rossi'], ['Omar', 'Haddad']];
      const day = 86400_000;
      let n = 0;
      for (const [i, name] of companies.entries()) {
        const slug = name.split(' ')[0].toLowerCase();
        const account = await Account.create({ name, domain: `${slug}.example.test`, website: `https://${slug}.example.test`, industry: industries[i % industries.length], type: i % 3 === 0 ? 'customer' : 'prospect', employees: 50 + i * 120, annual_revenue: String(1_000_000 + i * 750_000), ...owner });
        const [first, last] = people[i];
        const contact = await Contact.create({ account_id: account.id, first_name: first, last_name: last, email: `${first.toLowerCase()}.${last.toLowerCase()}@${slug}.example.test`, title: ['CEO', 'VP Sales', 'Head of Ops', 'CTO'][i % 4], ...owner });
        const stage = stages[i % (stages.length - 1)];
        await Opportunity.create({
          name: `${name} — ${['Platform', 'Expansion', 'Pilot', 'Renewal'][i % 4]}`, account_id: account.id, contact_id: contact.id, pipeline_id: pipeline.id, stage_id: stage.id,
          amount: String(5000 + i * 4250), currency: 'USD', probability: stage.probability, status: stage.category, expected_close_date: new Date(Date.now() + (i - 2) * 12 * day).toISOString().slice(0, 10),
          stage_entered_at: new Date(Date.now() - i * 3 * day), closed_at: stage.category === 'open' ? null : new Date(Date.now() - i * day), ...owner,
        });
        await Activity.create({ type: i % 2 ? 'call' : 'task', subject: i % 2 ? `Discovery call with ${first}` : `Send proposal to ${name}`, status: i % 3 ? 'open' : 'completed', due_at: new Date(Date.now() + (i - 3) * day), contact_id: contact.id, account_id: account.id, created_by_user_id: user.id, ...owner });
        n += 4;
      }
      const leadNames = [['Iris', 'Chen', 'Blue Yonder Airlines'], ['Marco', 'Silva', 'Coho Winery'], ['Priya', 'Nair', 'Lucerne Publishing'], ['Jonas', 'Berg', 'Margie Travel'], ['Sara', 'Lopez', 'Alpine Ski House'], ['Tom', 'Becker', 'Wide World Importers']];
      for (const [i, [first, last, company]] of leadNames.entries()) {
        await Lead.create({ first_name: first, last_name: last, company, email: `${first.toLowerCase()}@${company.split(' ')[0].toLowerCase()}.example.test`, status: ['new', 'contacted', 'qualified', 'nurturing'][i % 4], rating: ['hot', 'warm', 'cold'][i % 3], source: ['web_form', 'referral', 'event'][i % 3], score: 20 + i * 10, ...owner });
        n += 1;
      }
      await Product.bulkCreate([
        { sku: 'CRM-PRO', name: 'CRM Pro seat (annual)', unit_price: '348.0000', tax_rate: '0', unit: 'seat' },
        { sku: 'ONBOARD', name: 'Onboarding package', unit_price: '1500.0000', tax_rate: '0', max_discount_percent: '10' },
        { sku: 'SUPPORT-P', name: 'Premium support (annual)', unit_price: '2400.0000', tax_rate: '0' },
      ]);
      const firstContact = await Contact.findOne();
      const { nextSequence } = require('../../utils/sequence');
      await Ticket.create({ number: await nextSequence('ticket'), subject: 'Cannot export report to CSV', priority: 'high', status: 'open', contact_id: firstContact.id, account_id: firstContact.account_id, ...owner });
      console.log(`Seeded ${n + 4} fictional demo records.`);
    }, { userId: user.id });
  },

  async down() {
    // Demo data is removed by dropping the development database.
  },
};
